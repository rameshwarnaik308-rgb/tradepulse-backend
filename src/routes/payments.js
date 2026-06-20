const express = require('express');
const QRCode = require('qrcode');
const db = require('../config/database');
const { authenticate, requireAdmin } = require('../middleware/auth');
const { createPaymentRequest } = require('../services/tronService');
const logger = require('../utils/logger');

const router = express.Router();

// ── POST /api/payments/create ──────────────────────────────
// User clicks "Upgrade to Pro" — generate unique wallet
router.post('/create', authenticate, async (req, res) => {
  try {
    // Don't create if already pro
    if (req.user.plan === 'pro') {
      return res.status(400).json({ error: 'You already have an active Pro subscription' });
    }

    // Check for existing active request
    const existing = await db.query(
      `SELECT id, wallet_address, amount_usdt, expires_at, status
       FROM payment_requests
       WHERE user_id = $1 AND status IN ('pending', 'detecting') AND expires_at > NOW()
       ORDER BY created_at DESC LIMIT 1`,
      [req.user.id]
    );

    let paymentRequest;
    if (existing.rows.length > 0) {
      paymentRequest = existing.rows[0];
    } else {
      paymentRequest = await createPaymentRequest(req.user.id);
    }

    // Generate QR code
    const qrData = `tron:${paymentRequest.wallet_address}?token=${process.env.USDT_CONTRACT}&amount=${paymentRequest.amount_usdt}`;
    const qrCode = await QRCode.toDataURL(qrData);

    res.json({
      paymentRequestId: paymentRequest.id,
      walletAddress: paymentRequest.wallet_address,
      amount: paymentRequest.amount_usdt,
      network: 'TRC20',
      currency: 'USDT',
      expiresAt: paymentRequest.expires_at,
      qrCode,
      instructions: [
        'Open your USDT wallet (Trust Wallet, Binance, etc.)',
        'Select TRC20 network (TRON)',
        `Send exactly ${paymentRequest.amount_usdt} USDT`,
        'Your subscription activates automatically after 6 confirmations',
      ],
    });
  } catch (err) {
    logger.error('Create payment error:', err);
    res.status(500).json({ error: 'Failed to create payment request' });
  }
});

// ── GET /api/payments/status/:id ───────────────────────────
router.get('/status/:id', authenticate, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT id, status, tx_hash, confirmations, required_confirmations,
              expires_at, detected_at, confirmed_at, amount_usdt
       FROM payment_requests
       WHERE id = $1 AND user_id = $2`,
      [req.params.id, req.user.id]
    );

    if (!result.rows.length) {
      return res.status(404).json({ error: 'Payment request not found' });
    }

    const pr = result.rows[0];
    const confirmationPercent = pr.confirmations
      ? Math.min(100, Math.round((pr.confirmations / pr.required_confirmations) * 100))
      : 0;

    res.json({
      ...pr,
      confirmationPercent,
      statusLabel: {
        pending: 'Waiting for payment...',
        detecting: `Confirming transaction... (${pr.confirmations}/${pr.required_confirmations})`,
        confirmed: 'Payment confirmed! Pro activated.',
        expired: 'Payment window expired',
        failed: 'Payment failed',
      }[pr.status],
    });
  } catch (err) {
    logger.error('Payment status error:', err);
    res.status(500).json({ error: 'Failed to get payment status' });
  }
});

// ── GET /api/payments/history ──────────────────────────────
router.get('/history', authenticate, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT ph.*, pr.wallet_address
       FROM payment_history ph
       LEFT JOIN payment_requests pr ON pr.id = ph.payment_request_id
       WHERE ph.user_id = $1
       ORDER BY ph.created_at DESC`,
      [req.user.id]
    );
    res.json({ payments: result.rows });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch payment history' });
  }
});

// ── GET /api/payments/subscription ────────────────────────
router.get('/subscription', authenticate, async (req, res) => {
  const result = await db.query(
    `SELECT plan, status, started_at, expires_at, trade_count_this_month
     FROM subscriptions WHERE user_id = $1`,
    [req.user.id]
  );
  res.json({ subscription: result.rows[0] || null });
});

// ── ADMIN: GET /api/payments/admin/all ────────────────────
router.get('/admin/all', authenticate, requireAdmin, async (req, res) => {
  const { page = 1, limit = 50, status } = req.query;
  const offset = (page - 1) * limit;

  let whereClause = '';
  const params = [limit, offset];
  if (status) {
    whereClause = 'WHERE pr.status = $3';
    params.push(status);
  }

  const result = await db.query(
    `SELECT pr.*, u.email, u.name
     FROM payment_requests pr
     JOIN users u ON u.id = pr.user_id
     ${whereClause}
     ORDER BY pr.created_at DESC
     LIMIT $1 OFFSET $2`,
    params
  );

  const total = await db.query(
    `SELECT COUNT(*) FROM payment_requests ${whereClause}`,
    status ? [status] : []
  );

  res.json({
    payments: result.rows,
    total: parseInt(total.rows[0].count),
    page: parseInt(page),
  });
});

// ── ADMIN: Revenue stats ───────────────────────────────────
router.get('/admin/revenue', authenticate, requireAdmin, async (req, res) => {
  const stats = await db.query(`
    SELECT
      COUNT(*) FILTER (WHERE created_at >= DATE_TRUNC('month', NOW())) as this_month_payments,
      SUM(amount_usdt) FILTER (WHERE created_at >= DATE_TRUNC('month', NOW())) as this_month_usdt,
      COUNT(*) as total_payments,
      SUM(amount_usdt) as total_usdt,
      COUNT(DISTINCT user_id) as paying_users
    FROM payment_history
  `);

  const mrr = await db.query(`
    SELECT COUNT(*) as pro_users FROM subscriptions
    WHERE plan = 'pro' AND status = 'active' AND expires_at > NOW()
  `);

  res.json({
    ...stats.rows[0],
    active_pro_users: parseInt(mrr.rows[0].pro_users),
    mrr_usdt: parseInt(mrr.rows[0].pro_users) * 10,
  });
});

module.exports = router;
