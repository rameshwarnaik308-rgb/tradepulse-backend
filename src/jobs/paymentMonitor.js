const cron = require('node-cron');
const db = require('../config/database');
const {
  checkUsdtTransactions,
  getConfirmations,
  activateSubscription,
  sweepFunds,
} = require('../services/tronService');
const logger = require('../utils/logger');

let isRunning = false;

const runPaymentCheck = async () => {
  if (isRunning) return;
  isRunning = true;

  try {
    // Get all pending/detecting payment requests that haven't expired
    const result = await db.query(
      `SELECT id, wallet_address, user_id, tx_hash, confirmations, required_confirmations
       FROM payment_requests
       WHERE status IN ('pending', 'detecting')
         AND expires_at > NOW()
       ORDER BY created_at ASC`
    );

    if (result.rows.length === 0) {
      isRunning = false;
      return;
    }

    logger.info(`Payment monitor: checking ${result.rows.length} active requests`);

    for (const pr of result.rows) {
      try {
        // Already have a TX hash — just check confirmations
        if (pr.tx_hash) {
          const confirmations = await getConfirmations(pr.tx_hash);
          await db.query(
            `UPDATE payment_requests SET confirmations = $1 WHERE id = $2`,
            [confirmations, pr.id]
          );

          if (confirmations >= pr.required_confirmations) {
            // Fully confirmed — activate subscription
            const txData = {
              txHash: pr.tx_hash,
              amount: parseFloat(process.env.PRO_PLAN_PRICE_USDT) || 10,
              from: 'unknown',
            };
            await activateSubscription(pr.id, txData);
            await sweepFunds(pr.id);
          }
          continue;
        }

        // No TX yet — scan for incoming transfers
        const tx = await checkUsdtTransactions(pr.wallet_address);
        if (!tx) continue;

        logger.info(`💰 Payment detected! TX: ${tx.txHash} for request ${pr.id}`);

        // Update to detecting state with TX hash
        await db.query(
          `UPDATE payment_requests
           SET status = 'detecting', tx_hash = $1, detected_at = NOW(), confirmations = $2
           WHERE id = $3`,
          [tx.txHash, 0, pr.id]
        );

        // If already confirmed on chain, activate immediately
        if (tx.confirmed) {
          const confirmations = await getConfirmations(tx.txHash);
          if (confirmations >= pr.required_confirmations) {
            await activateSubscription(pr.id, tx);
            await sweepFunds(pr.id);
          }
        }
      } catch (err) {
        logger.error(`Error processing payment request ${pr.id}:`, err.message);
      }

      // Small delay between each check to respect API rate limits
      await new Promise(r => setTimeout(r, 300));
    }
  } catch (err) {
    logger.error('Payment monitor run error:', err);
  } finally {
    isRunning = false;
  }
};

// Expire old payment requests
const expireOldRequests = async () => {
  const result = await db.query(
    `UPDATE payment_requests
     SET status = 'expired'
     WHERE status IN ('pending', 'detecting')
       AND expires_at <= NOW()
     RETURNING id, user_id`
  );
  if (result.rows.length > 0) {
    logger.info(`Expired ${result.rows.length} payment requests`);
  }
};

const startPaymentMonitor = () => {
  // Run every 30 seconds
  cron.schedule('*/30 * * * * *', async () => {
    await runPaymentCheck();
    await expireOldRequests();
  });

  logger.info('✅ Payment monitor started (every 30s)');
};

module.exports = { startPaymentMonitor };
