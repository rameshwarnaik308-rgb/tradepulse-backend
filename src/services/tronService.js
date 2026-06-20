const TronWeb = require('tronweb');
const crypto = require('crypto');
const db = require('../config/database');
const { sendEmail } = require('./emailService');
const logger = require('../utils/logger');

// ── TronWeb instance ───────────────────────────────────────
const tronWeb = new TronWeb({
  fullHost: process.env.TRON_FULL_NODE || 'https://api.trongrid.io',
  headers: { 'TRON-PRO-API-KEY': process.env.TRON_API_KEY },
  privateKey: process.env.TRON_MAIN_PRIVATE_KEY,
});

const USDT_CONTRACT = process.env.USDT_CONTRACT || 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
const PRO_PRICE = parseFloat(process.env.PRO_PLAN_PRICE_USDT) || 10;
const EXPIRY_MINS = parseInt(process.env.PAYMENT_EXPIRY_MINUTES) || 30;
const REQUIRED_CONFIRMATIONS = 6;

// ── Encrypt/decrypt private keys ───────────────────────────
const ENCRYPTION_KEY = Buffer.from(process.env.ENCRYPTION_KEY.padEnd(32).slice(0, 32));
const IV_LENGTH = 16;

const encrypt = (text) => {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv('aes-256-cbc', ENCRYPTION_KEY, iv);
  let encrypted = cipher.update(text);
  encrypted = Buffer.concat([encrypted, cipher.final()]);
  return iv.toString('hex') + ':' + encrypted.toString('hex');
};

const decrypt = (text) => {
  const [ivHex, encryptedHex] = text.split(':');
  const iv = Buffer.from(ivHex, 'hex');
  const encrypted = Buffer.from(encryptedHex, 'hex');
  const decipher = crypto.createDecipheriv('aes-256-cbc', ENCRYPTION_KEY, iv);
  let decrypted = decipher.update(encrypted);
  decrypted = Buffer.concat([decrypted, decipher.final()]);
  return decrypted.toString();
};

// ── Generate a unique TRC20 wallet for this payment ────────
const createPaymentRequest = async (userId) => {
  // Cancel any existing pending requests
  await db.query(
    `UPDATE payment_requests SET status = 'expired'
     WHERE user_id = $1 AND status IN ('pending', 'detecting')`,
    [userId]
  );

  // Generate fresh wallet
  const account = await tronWeb.createAccount();
  const address = account.address.base58;
  const privateKey = account.privateKey;

  const expiresAt = new Date(Date.now() + EXPIRY_MINS * 60 * 1000);

  const result = await db.query(
    `INSERT INTO payment_requests
       (user_id, wallet_address, private_key_encrypted, amount_usdt, expires_at)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, wallet_address, amount_usdt, expires_at`,
    [userId, address, encrypt(privateKey), PRO_PRICE, expiresAt]
  );

  logger.info(`Payment request created: ${address} for user ${userId}`);
  return result.rows[0];
};

// ── Check USDT balance on a TRC20 address ──────────────────
const getUsdtBalance = async (address) => {
  try {
    const contract = await tronWeb.contract().at(USDT_CONTRACT);
    const balance = await contract.balanceOf(address).call();
    // USDT has 6 decimals on TRON
    return parseFloat(tronWeb.fromSun(balance.toString())) / 1000;
  } catch (err) {
    logger.error(`Balance check failed for ${address}:`, err.message);
    return 0;
  }
};

// ── Check TRC20 transfer transactions ─────────────────────
const checkUsdtTransactions = async (address) => {
  try {
    const response = await fetch(
      `https://api.trongrid.io/v1/accounts/${address}/transactions/trc20?` +
      `contract_address=${USDT_CONTRACT}&limit=20&order_by=block_timestamp,desc`,
      { headers: { 'TRON-PRO-API-KEY': process.env.TRON_API_KEY } }
    );

    if (!response.ok) return null;
    const data = await response.json();

    if (!data.data || data.data.length === 0) return null;

    for (const tx of data.data) {
      const amount = parseFloat(tx.value) / 1_000_000; // 6 decimals
      const toAddr = tx.to;

      // Accept if exact amount (±0.01 tolerance for fees)
      if (
        toAddr.toLowerCase() === address.toLowerCase() &&
        Math.abs(amount - PRO_PRICE) <= 0.01
      ) {
        return {
          txHash: tx.transaction_id,
          amount,
          from: tx.from,
          blockNumber: tx.block_timestamp,
          confirmed: tx.confirmed,
        };
      }
    }
    return null;
  } catch (err) {
    logger.error(`TX check error for ${address}:`, err.message);
    return null;
  }
};

// ── Get TX confirmation count ──────────────────────────────
const getConfirmations = async (txHash) => {
  try {
    const response = await fetch(
      `https://api.trongrid.io/wallet/gettransactioninfobyid?value=${txHash}`,
      { headers: { 'TRON-PRO-API-KEY': process.env.TRON_API_KEY } }
    );
    const data = await response.json();

    // Get latest block
    const blockResp = await fetch('https://api.trongrid.io/wallet/getnowblock', {
      headers: { 'TRON-PRO-API-KEY': process.env.TRON_API_KEY },
    });
    const blockData = await blockResp.json();
    const latestBlock = blockData.block_header?.raw_data?.number || 0;
    const txBlock = data.blockNumber || 0;

    return txBlock > 0 ? Math.max(0, latestBlock - txBlock) : 0;
  } catch {
    return 0;
  }
};

// ── Main: process a confirmed payment ─────────────────────
const activateSubscription = async (paymentRequestId, txData) => {
  const client = await db.getClient();
  try {
    await client.query('BEGIN');

    // Get payment request
    const prResult = await client.query(
      `SELECT * FROM payment_requests WHERE id = $1 FOR UPDATE`,
      [paymentRequestId]
    );
    const pr = prResult.rows[0];
    if (!pr || pr.status === 'confirmed') {
      await client.query('ROLLBACK');
      return;
    }

    // Update payment request
    await client.query(
      `UPDATE payment_requests
       SET status = 'confirmed', tx_hash = $1, confirmed_at = NOW(), confirmations = $2
       WHERE id = $3`,
      [txData.txHash, REQUIRED_CONFIRMATIONS, paymentRequestId]
    );

    // Activate pro subscription (30 days)
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    await client.query(
      `INSERT INTO subscriptions (user_id, plan, status, started_at, expires_at)
       VALUES ($1, 'pro', 'active', NOW(), $2)
       ON CONFLICT (user_id) DO UPDATE
       SET plan = 'pro', status = 'active', started_at = NOW(), expires_at = $2`,
      [pr.user_id, expiresAt]
    );

    // Record payment history
    await client.query(
      `INSERT INTO payment_history
         (user_id, payment_request_id, amount_usdt, tx_hash, wallet_from, wallet_to, network, plan, period_days)
       VALUES ($1, $2, $3, $4, $5, $6, 'TRC20', 'pro', 30)`,
      [pr.user_id, pr.id, txData.amount, txData.txHash, txData.from, pr.wallet_address]
    );

    await client.query('COMMIT');

    // Get user info for email
    const userResult = await db.query(
      `SELECT name, email FROM users WHERE id = $1`,
      [pr.user_id]
    );
    const user = userResult.rows[0];

    if (user) {
      sendEmail({
        to: user.email,
        subject: '🎉 TradePulse Pro Activated!',
        template: 'proActivated',
        data: {
          name: user.name,
          txHash: txData.txHash,
          amount: txData.amount,
          expiresAt: expiresAt.toLocaleDateString(),
          dashboardUrl: `${process.env.FRONTEND_URL}/dashboard`,
        },
      }).catch(logger.error);
    }

    logger.info(`✅ Pro activated for user ${pr.user_id} — TX: ${txData.txHash}`);
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error('activateSubscription error:', err);
    throw err;
  } finally {
    client.release();
  }
};

// ── Sweep funds from temp wallet to main wallet ────────────
// (Optional: auto-consolidate incoming USDT to main wallet)
const sweepFunds = async (paymentRequestId) => {
  try {
    const pr = await db.query(
      `SELECT wallet_address, private_key_encrypted FROM payment_requests WHERE id = $1`,
      [paymentRequestId]
    );
    const { wallet_address, private_key_encrypted } = pr.rows[0];
    const privateKey = decrypt(private_key_encrypted);

    const tempTronWeb = new TronWeb({
      fullHost: process.env.TRON_FULL_NODE,
      headers: { 'TRON-PRO-API-KEY': process.env.TRON_API_KEY },
      privateKey,
    });

    const contract = await tempTronWeb.contract().at(USDT_CONTRACT);
    await contract.transfer(process.env.TRON_MAIN_WALLET, PRO_PRICE * 1_000_000).send();
    logger.info(`Swept ${PRO_PRICE} USDT from ${wallet_address} to main wallet`);
  } catch (err) {
    logger.warn('Sweep failed (non-critical):', err.message);
  }
};

module.exports = {
  createPaymentRequest,
  checkUsdtTransactions,
  getConfirmations,
  activateSubscription,
  sweepFunds,
  getUsdtBalance,
};
