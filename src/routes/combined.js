// ============================================================
// journal.js
// ============================================================
const express = require('express');
const db = require('../config/database');
const { authenticate } = require('../middleware/auth');

const journalRouter = express.Router();

journalRouter.get('/', authenticate, async (req, res) => {
  const { trade_id, type, page = 1, limit = 20 } = req.query;
  const offset = (page - 1) * limit;
  const conditions = ['user_id = $1'];
  const params = [req.user.id];
  let i = 2;
  if (trade_id) { conditions.push(`trade_id = $${i++}`); params.push(trade_id); }
  if (type) { conditions.push(`entry_type = $${i++}`); params.push(type); }

  const result = await db.query(
    `SELECT * FROM journal_entries WHERE ${conditions.join(' AND ')}
     ORDER BY created_at DESC LIMIT $${i} OFFSET $${i+1}`,
    [...params, limit, offset]
  );
  res.json({ entries: result.rows });
});

journalRouter.post('/', authenticate, async (req, res) => {
  const { trade_id, entry_type = 'general', title, content, emotion, confidence_level } = req.body;
  if (!content) return res.status(400).json({ error: 'Content required' });

  const result = await db.query(
    `INSERT INTO journal_entries (user_id, trade_id, entry_type, title, content, emotion, confidence_level)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [req.user.id, trade_id || null, entry_type, title, content, emotion, confidence_level]
  );
  res.status(201).json({ entry: result.rows[0] });
});

journalRouter.put('/:id', authenticate, async (req, res) => {
  const { title, content, emotion, confidence_level } = req.body;
  const result = await db.query(
    `UPDATE journal_entries SET title=$1, content=$2, emotion=$3, confidence_level=$4
     WHERE id=$5 AND user_id=$6 RETURNING *`,
    [title, content, emotion, confidence_level, req.params.id, req.user.id]
  );
  if (!result.rows.length) return res.status(404).json({ error: 'Entry not found' });
  res.json({ entry: result.rows[0] });
});

journalRouter.delete('/:id', authenticate, async (req, res) => {
  await db.query(`DELETE FROM journal_entries WHERE id=$1 AND user_id=$2`, [req.params.id, req.user.id]);
  res.json({ message: 'Deleted' });
});

// ============================================================
// smc.js
// ============================================================
const smcRouter = express.Router();

smcRouter.get('/', authenticate, async (req, res) => {
  const { pair, timeframe, concept, status } = req.query;
  const conditions = ['user_id = $1'];
  const params = [req.user.id];
  let i = 2;
  if (pair) { conditions.push(`pair ILIKE $${i++}`); params.push(`%${pair}%`); }
  if (timeframe) { conditions.push(`timeframe = $${i++}`); params.push(timeframe); }
  if (concept) { conditions.push(`concept = $${i++}`); params.push(concept); }
  if (status) { conditions.push(`status = $${i++}`); params.push(status); }

  const result = await db.query(
    `SELECT * FROM smc_levels WHERE ${conditions.join(' AND ')} ORDER BY created_at DESC`,
    params
  );
  res.json({ levels: result.rows });
});

smcRouter.post('/', authenticate, async (req, res) => {
  const { pair, timeframe, concept, price_level, price_high, price_low, direction, notes, trade_id } = req.body;
  if (!pair || !concept || !price_level) return res.status(400).json({ error: 'pair, concept, price_level required' });

  const result = await db.query(
    `INSERT INTO smc_levels (user_id, trade_id, pair, timeframe, concept, price_level, price_high, price_low, direction, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [req.user.id, trade_id || null, pair, timeframe || '1H', concept, price_level, price_high, price_low, direction, notes]
  );
  res.status(201).json({ level: result.rows[0] });
});

smcRouter.patch('/:id/status', authenticate, async (req, res) => {
  const { status } = req.body;
  if (!['active', 'mitigated', 'invalidated'].includes(status)) return res.status(400).json({ error: 'Invalid status' });
  const result = await db.query(
    `UPDATE smc_levels SET status=$1 WHERE id=$2 AND user_id=$3 RETURNING *`,
    [status, req.params.id, req.user.id]
  );
  if (!result.rows.length) return res.status(404).json({ error: 'Not found' });
  res.json({ level: result.rows[0] });
});

smcRouter.delete('/:id', authenticate, async (req, res) => {
  await db.query(`DELETE FROM smc_levels WHERE id=$1 AND user_id=$2`, [req.params.id, req.user.id]);
  res.json({ message: 'Deleted' });
});

// ============================================================
// admin.js
// ============================================================
const { requireAdmin } = require('../middleware/auth');
const adminRouter = express.Router();

adminRouter.use(authenticate, requireAdmin);

adminRouter.get('/stats', async (req, res) => {
  const [users, subs, trades, tickets] = await Promise.all([
    db.query(`SELECT COUNT(*) as total, COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '30 days') as new_this_month FROM users`),
    db.query(`SELECT COUNT(*) FILTER (WHERE plan='pro' AND status='active') as pro, COUNT(*) FILTER (WHERE plan='free') as free FROM subscriptions`),
    db.query(`SELECT COUNT(*) as total, COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '7 days') as this_week FROM trades`),
    db.query(`SELECT COUNT(*) FILTER (WHERE status='open') as open FROM support_tickets`),
  ]);

  res.json({
    users: users.rows[0],
    subscriptions: subs.rows[0],
    trades: trades.rows[0],
    support: tickets.rows[0],
    mrr_usdt: parseInt(subs.rows[0].pro) * 10,
  });
});

adminRouter.get('/users', async (req, res) => {
  const { page = 1, limit = 50, search } = req.query;
  const offset = (page - 1) * limit;
  const params = [limit, offset];
  let where = '';
  if (search) { where = `WHERE u.email ILIKE $3 OR u.name ILIKE $3`; params.push(`%${search}%`); }

  const result = await db.query(
    `SELECT u.id, u.name, u.email, u.role, u.created_at, u.email_verified,
            s.plan, s.expires_at,
            (SELECT COUNT(*) FROM trades WHERE user_id = u.id) as trade_count
     FROM users u LEFT JOIN subscriptions s ON s.user_id = u.id
     ${where}
     ORDER BY u.created_at DESC LIMIT $1 OFFSET $2`,
    params
  );
  const total = await db.query(`SELECT COUNT(*) FROM users u ${where}`, search ? [`%${search}%`] : []);
  res.json({ users: result.rows, total: parseInt(total.rows[0].count) });
});

adminRouter.patch('/users/:id/role', async (req, res) => {
  const { role } = req.body;
  if (!['user', 'admin'].includes(role)) return res.status(400).json({ error: 'Invalid role' });
  await db.query(`UPDATE users SET role=$1 WHERE id=$2`, [role, req.params.id]);
  res.json({ message: 'Role updated' });
});

adminRouter.patch('/users/:id/plan', async (req, res) => {
  const { plan, days = 30 } = req.body;
  if (!['free', 'pro'].includes(plan)) return res.status(400).json({ error: 'Invalid plan' });
  const expiresAt = plan === 'pro' ? new Date(Date.now() + days * 24 * 60 * 60 * 1000) : null;
  await db.query(
    `UPDATE subscriptions SET plan=$1, status=$2, expires_at=$3 WHERE user_id=$4`,
    [plan, 'active', expiresAt, req.params.id]
  );
  res.json({ message: 'Plan updated' });
});

adminRouter.get('/tickets', async (req, res) => {
  const result = await db.query(
    `SELECT st.*, u.email, u.name FROM support_tickets st
     JOIN users u ON u.id = st.user_id
     ORDER BY st.created_at DESC LIMIT 100`
  );
  res.json({ tickets: result.rows });
});

adminRouter.patch('/tickets/:id', async (req, res) => {
  const { status, admin_reply } = req.body;
  const result = await db.query(
    `UPDATE support_tickets SET status=$1, admin_reply=$2, resolved_at=CASE WHEN $1='resolved' THEN NOW() ELSE resolved_at END
     WHERE id=$3 RETURNING *`,
    [status, admin_reply, req.params.id]
  );
  res.json({ ticket: result.rows[0] });
});

adminRouter.get('/audit-logs', async (req, res) => {
  const result = await db.query(
    `SELECT al.*, u.email FROM audit_logs al
     LEFT JOIN users u ON u.id = al.user_id
     ORDER BY al.created_at DESC LIMIT 200`
  );
  res.json({ logs: result.rows });
});

module.exports = { journalRouter, smcRouter, adminRouter };
