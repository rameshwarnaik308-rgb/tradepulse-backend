const express = require('express');
const { body, query, validationResult } = require('express-validator');
const db = require('../config/database');
const { authenticate, requirePro } = require('../middleware/auth');
const { analyzeTradeWithAI } = require('../services/aiService');
const logger = require('../utils/logger');

const router = express.Router();
const FREE_TRADE_LIMIT = 30;

// ── Trade limit middleware ─────────────────────────────────
const checkTradeLimit = async (req, res, next) => {
  if (req.user.plan === 'pro') return next();

  const result = await db.query(
    `SELECT trade_count_this_month, trade_count_reset_at FROM subscriptions WHERE user_id = $1`,
    [req.user.id]
  );
  const sub = result.rows[0];

  if (sub && new Date(sub.trade_count_reset_at) < new Date()) {
    await db.query(
      `UPDATE subscriptions
       SET trade_count_this_month = 0,
           trade_count_reset_at = DATE_TRUNC('month', NOW()) + INTERVAL '1 month'
       WHERE user_id = $1`,
      [req.user.id]
    );
    sub.trade_count_this_month = 0;
  }

  if (sub && sub.trade_count_this_month >= FREE_TRADE_LIMIT) {
    return res.status(403).json({
      error: `Free plan limit reached (${FREE_TRADE_LIMIT} trades/month)`,
      code: 'TRADE_LIMIT_REACHED',
      used: sub.trade_count_this_month,
      limit: FREE_TRADE_LIMIT,
    });
  }

  req.tradeCount = sub?.trade_count_this_month || 0;
  next();
};

// ── GET /api/trades ────────────────────────────────────────
router.get('/', authenticate, async (req, res) => {
  const {
    page = 1, limit = 50, pair, direction,
    asset_class, status, from_date, to_date, session, search,
  } = req.query;
  const offset = (parseInt(page) - 1) * parseInt(limit);

  const conditions = ['t.user_id = $1'];
  const params = [req.user.id];
  let i = 2;

  if (pair) { conditions.push(`t.pair ILIKE $${i++}`); params.push(`%${pair}%`); }
  if (direction) { conditions.push(`t.direction = $${i++}`); params.push(direction); }
  if (asset_class) { conditions.push(`t.asset_class = $${i++}`); params.push(asset_class); }
  if (status) { conditions.push(`t.status = $${i++}`); params.push(status); }
  if (session) { conditions.push(`t.session = $${i++}`); params.push(session); }
  if (from_date) { conditions.push(`t.entry_time >= $${i++}`); params.push(from_date); }
  if (to_date) { conditions.push(`t.entry_time <= $${i++}`); params.push(to_date); }
  if (search) {
    conditions.push(`(t.pair ILIKE $${i} OR t.strategy ILIKE $${i} OR t.setup_type ILIKE $${i})`);
    params.push(`%${search}%`); i++;
  }

  const where = conditions.join(' AND ');

  const [tradesResult, countResult] = await Promise.all([
    db.query(
      `SELECT t.*,
              ARRAY_AGG(tt.tag) FILTER (WHERE tt.tag IS NOT NULL) as tags
       FROM trades t
       LEFT JOIN trade_tags tt ON tt.trade_id = t.id
       WHERE ${where}
       GROUP BY t.id
       ORDER BY t.entry_time DESC NULLS LAST, t.created_at DESC
       LIMIT $${i} OFFSET $${i + 1}`,
      [...params, parseInt(limit), offset]
    ),
    db.query(`SELECT COUNT(*) FROM trades t WHERE ${where}`, params),
  ]);

  res.json({
    trades: tradesResult.rows,
    total: parseInt(countResult.rows[0].count),
    page: parseInt(page),
    totalPages: Math.ceil(parseInt(countResult.rows[0].count) / parseInt(limit)),
  });
});

// ── POST /api/trades ───────────────────────────────────────
router.post('/', authenticate, checkTradeLimit, [
  body('pair').notEmpty().trim(),
  body('direction').isIn(['long', 'short']),
  body('entry_price').isFloat({ min: 0 }),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ error: 'Validation failed', details: errors.array() });
  }

  const {
    pair, direction, asset_class = 'forex', entry_price, exit_price,
    stop_loss, take_profit, position_size, risk_amount, pnl, pnl_percent,
    risk_reward_ratio, r_multiple, status = 'open', entry_time, exit_time,
    session, strategy, setup_type, screenshot_url, source = 'manual', tags = [],
  } = req.body;

  const client = await db.getClient();
  try {
    await client.query('BEGIN');

    const tradeResult = await client.query(
      `INSERT INTO trades (
         user_id, pair, direction, asset_class, entry_price, exit_price,
         stop_loss, take_profit, position_size, risk_amount, pnl, pnl_percent,
         risk_reward_ratio, r_multiple, status, entry_time, exit_time,
         session, strategy, setup_type, screenshot_url, source
       ) VALUES (
         $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22
       ) RETURNING *`,
      [
        req.user.id, pair, direction, asset_class, entry_price, exit_price,
        stop_loss, take_profit, position_size, risk_amount, pnl, pnl_percent,
        risk_reward_ratio, r_multiple, status, entry_time, exit_time,
        session, strategy, setup_type, screenshot_url, source,
      ]
    );
    const trade = tradeResult.rows[0];

    // Insert tags
    if (tags.length > 0) {
      const tagValues = tags.map((tag, idx) => `($1, $${idx + 2})`).join(', ');
      await client.query(
        `INSERT INTO trade_tags (trade_id, tag) VALUES ${tagValues}`,
        [trade.id, ...tags]
      );
    }

    // Increment monthly trade count for free users
    if (req.user.plan !== 'pro') {
      await client.query(
        `UPDATE subscriptions SET trade_count_this_month = trade_count_this_month + 1 WHERE user_id = $1`,
        [req.user.id]
      );
    }

    await client.query('COMMIT');

    // Async AI analysis for pro users
    if (req.user.plan === 'pro' && trade.status === 'closed') {
      analyzeTradeWithAI(trade.id, trade, req.user).catch(logger.error);
    }

    res.status(201).json({ trade: { ...trade, tags } });
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error('Create trade error:', err);
    res.status(500).json({ error: 'Failed to create trade' });
  } finally {
    client.release();
  }
});

// ── GET /api/trades/:id ────────────────────────────────────
router.get('/:id', authenticate, async (req, res) => {
  const result = await db.query(
    `SELECT t.*,
            ARRAY_AGG(tt.tag) FILTER (WHERE tt.tag IS NOT NULL) as tags,
            ARRAY_AGG(je.content ORDER BY je.created_at) FILTER (WHERE je.id IS NOT NULL) as journal_notes
     FROM trades t
     LEFT JOIN trade_tags tt ON tt.trade_id = t.id
     LEFT JOIN journal_entries je ON je.trade_id = t.id
     WHERE t.id = $1 AND t.user_id = $2
     GROUP BY t.id`,
    [req.params.id, req.user.id]
  );

  if (!result.rows.length) return res.status(404).json({ error: 'Trade not found' });
  res.json({ trade: result.rows[0] });
});

// ── PUT /api/trades/:id ────────────────────────────────────
router.put('/:id', authenticate, async (req, res) => {
  const fields = ['exit_price', 'stop_loss', 'take_profit', 'pnl', 'pnl_percent',
    'r_multiple', 'risk_reward_ratio', 'status', 'exit_time', 'session',
    'strategy', 'setup_type', 'screenshot_url', 'ai_grade', 'ai_analysis',
    'ai_mistakes', 'ai_strengths'];

  const updates = [];
  const params = [req.params.id, req.user.id];
  let i = 3;

  for (const field of fields) {
    if (req.body[field] !== undefined) {
      updates.push(`${field} = $${i++}`);
      params.push(req.body[field]);
    }
  }

  if (updates.length === 0) return res.status(400).json({ error: 'No fields to update' });

  const result = await db.query(
    `UPDATE trades SET ${updates.join(', ')} WHERE id = $1 AND user_id = $2 RETURNING *`,
    params
  );

  if (!result.rows.length) return res.status(404).json({ error: 'Trade not found' });

  const trade = result.rows[0];

  // Trigger AI analysis when trade is closed and user is pro
  if (req.body.status === 'closed' && req.user.plan === 'pro') {
    analyzeTradeWithAI(trade.id, trade, req.user).catch(logger.error);
  }

  res.json({ trade });
});

// ── DELETE /api/trades/:id ─────────────────────────────────
router.delete('/:id', authenticate, async (req, res) => {
  const result = await db.query(
    `DELETE FROM trades WHERE id = $1 AND user_id = $2 RETURNING id`,
    [req.params.id, req.user.id]
  );
  if (!result.rows.length) return res.status(404).json({ error: 'Trade not found' });
  res.json({ message: 'Trade deleted' });
});

// ── POST /api/trades/:id/analyze ──────────────────────────
router.post('/:id/analyze', authenticate, requirePro, async (req, res) => {
  const result = await db.query(
    `SELECT * FROM trades WHERE id = $1 AND user_id = $2`,
    [req.params.id, req.user.id]
  );
  if (!result.rows.length) return res.status(404).json({ error: 'Trade not found' });

  try {
    const analysis = await analyzeTradeWithAI(result.rows[0].id, result.rows[0], req.user);
    res.json({ analysis });
  } catch (err) {
    res.status(500).json({ error: 'AI analysis failed' });
  }
});

module.exports = router;
