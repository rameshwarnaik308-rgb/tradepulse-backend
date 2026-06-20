const express = require('express');
const db = require('../config/database');
const { authenticate, requirePro } = require('../middleware/auth');

const router = express.Router();

// ── GET /api/analytics/dashboard ──────────────────────────
router.get('/dashboard', authenticate, async (req, res) => {
  const { period = '30' } = req.query;
  const days = parseInt(period);
  const userId = req.user.id;

  const [stats, equity, sessions, instruments, grades] = await Promise.all([
    // Core stats
    db.query(
      `SELECT
         COUNT(*) FILTER (WHERE status = 'closed') as total_closed,
         COUNT(*) FILTER (WHERE status = 'closed' AND pnl > 0) as wins,
         COUNT(*) FILTER (WHERE status = 'closed' AND pnl < 0) as losses,
         COUNT(*) FILTER (WHERE status = 'open') as open_trades,
         COALESCE(SUM(pnl) FILTER (WHERE status = 'closed'), 0) as net_pnl,
         COALESCE(AVG(pnl) FILTER (WHERE status = 'closed' AND pnl > 0), 0) as avg_win,
         COALESCE(AVG(ABS(pnl)) FILTER (WHERE status = 'closed' AND pnl < 0), 0) as avg_loss,
         COALESCE(AVG(r_multiple) FILTER (WHERE status = 'closed' AND r_multiple IS NOT NULL), 0) as avg_r,
         COALESCE(AVG(risk_reward_ratio) FILTER (WHERE risk_reward_ratio IS NOT NULL), 0) as avg_rr,
         COALESCE(MAX(pnl), 0) as best_trade,
         COALESCE(MIN(pnl), 0) as worst_trade
       FROM trades
       WHERE user_id = $1 AND entry_time >= NOW() - INTERVAL '${days} days'`,
      [userId]
    ),

    // Equity curve (daily cumulative P&L)
    db.query(
      `SELECT
         DATE(entry_time) as date,
         SUM(pnl) OVER (ORDER BY DATE(entry_time)) as cumulative_pnl,
         SUM(pnl) as daily_pnl,
         COUNT(*) as trade_count
       FROM trades
       WHERE user_id = $1 AND status = 'closed'
         AND entry_time >= NOW() - INTERVAL '${days} days'
         AND pnl IS NOT NULL
       GROUP BY DATE(entry_time)
       ORDER BY date ASC`,
      [userId]
    ),

    // Session performance
    db.query(
      `SELECT
         COALESCE(session, 'unknown') as session,
         COUNT(*) as total,
         COUNT(*) FILTER (WHERE pnl > 0) as wins,
         COALESCE(SUM(pnl), 0) as pnl,
         COALESCE(AVG(r_multiple), 0) as avg_r
       FROM trades
       WHERE user_id = $1 AND status = 'closed'
         AND entry_time >= NOW() - INTERVAL '${days} days'
       GROUP BY session`,
      [userId]
    ),

    // Instrument breakdown
    db.query(
      `SELECT
         pair,
         COUNT(*) as total,
         COUNT(*) FILTER (WHERE pnl > 0) as wins,
         COALESCE(SUM(pnl), 0) as pnl,
         COALESCE(AVG(r_multiple), 0) as avg_r
       FROM trades
       WHERE user_id = $1 AND status = 'closed'
         AND entry_time >= NOW() - INTERVAL '${days} days'
       GROUP BY pair
       ORDER BY total DESC LIMIT 10`,
      [userId]
    ),

    // Grade distribution
    db.query(
      `SELECT ai_grade, COUNT(*) as count
       FROM trades
       WHERE user_id = $1 AND ai_grade IS NOT NULL
         AND entry_time >= NOW() - INTERVAL '${days} days'
       GROUP BY ai_grade`,
      [userId]
    ),
  ]);

  const s = stats.rows[0];
  const totalClosed = parseInt(s.total_closed) || 0;
  const wins = parseInt(s.wins) || 0;
  const winRate = totalClosed > 0 ? ((wins / totalClosed) * 100).toFixed(2) : 0;
  const avgWin = parseFloat(s.avg_win) || 0;
  const avgLoss = parseFloat(s.avg_loss) || 0;
  const profitFactor = avgLoss > 0 ? (avgWin / avgLoss).toFixed(2) : 0;
  const expectancy = totalClosed > 0
    ? (((wins / totalClosed) * avgWin) - (((totalClosed - wins) / totalClosed) * avgLoss)).toFixed(2)
    : 0;

  // Max drawdown calculation from equity curve
  let maxDrawdown = 0;
  let peak = 0;
  for (const row of equity.rows) {
    const val = parseFloat(row.cumulative_pnl);
    if (val > peak) peak = val;
    const dd = peak > 0 ? ((peak - val) / peak) * 100 : 0;
    if (dd > maxDrawdown) maxDrawdown = dd;
  }

  res.json({
    summary: {
      totalTrades: totalClosed,
      openTrades: parseInt(s.open_trades) || 0,
      wins,
      losses: parseInt(s.losses) || 0,
      winRate: parseFloat(winRate),
      netPnl: parseFloat(s.net_pnl) || 0,
      avgWin,
      avgLoss,
      profitFactor: parseFloat(profitFactor),
      expectancy: parseFloat(expectancy),
      avgR: parseFloat(s.avg_r) || 0,
      avgRR: parseFloat(s.avg_rr) || 0,
      bestTrade: parseFloat(s.best_trade) || 0,
      worstTrade: parseFloat(s.worst_trade) || 0,
      maxDrawdown: parseFloat(maxDrawdown.toFixed(2)),
    },
    equityCurve: equity.rows,
    sessions: sessions.rows,
    instruments: instruments.rows,
    grades: grades.rows,
  });
});

// ── GET /api/analytics/drawdown ────────────────────────────
router.get('/drawdown', authenticate, requirePro, async (req, res) => {
  const equity = await db.query(
    `SELECT DATE(entry_time) as date, SUM(pnl) as daily_pnl
     FROM trades
     WHERE user_id = $1 AND status = 'closed' AND pnl IS NOT NULL
     GROUP BY DATE(entry_time)
     ORDER BY date ASC`,
    [req.user.id]
  );

  let cumPnl = 0;
  let peak = 0;
  const drawdownData = equity.rows.map(row => {
    cumPnl += parseFloat(row.daily_pnl);
    if (cumPnl > peak) peak = cumPnl;
    const drawdown = peak > 0 ? ((peak - cumPnl) / peak) * 100 : 0;
    return { date: row.date, cumPnl, drawdown: parseFloat(drawdown.toFixed(2)) };
  });

  res.json({ drawdownData });
});

// ── GET /api/analytics/monthly ─────────────────────────────
router.get('/monthly', authenticate, requirePro, async (req, res) => {
  const result = await db.query(
    `SELECT
       TO_CHAR(DATE_TRUNC('month', entry_time), 'YYYY-MM') as month,
       COUNT(*) as total,
       COUNT(*) FILTER (WHERE pnl > 0) as wins,
       COALESCE(SUM(pnl), 0) as net_pnl,
       COALESCE(AVG(r_multiple), 0) as avg_r
     FROM trades
     WHERE user_id = $1 AND status = 'closed' AND entry_time IS NOT NULL
     GROUP BY DATE_TRUNC('month', entry_time)
     ORDER BY month DESC LIMIT 12`,
    [req.user.id]
  );
  res.json({ monthly: result.rows });
});

// ── GET /api/analytics/psychology ─────────────────────────
router.get('/psychology', authenticate, requirePro, async (req, res) => {
  const [dayPerf, hourPerf] = await Promise.all([
    db.query(
      `SELECT
         TO_CHAR(entry_time, 'Dy') as day,
         EXTRACT(DOW FROM entry_time) as dow,
         COUNT(*) as total,
         COUNT(*) FILTER (WHERE pnl > 0) as wins,
         COALESCE(SUM(pnl), 0) as pnl
       FROM trades
       WHERE user_id = $1 AND status = 'closed' AND entry_time IS NOT NULL
       GROUP BY TO_CHAR(entry_time, 'Dy'), EXTRACT(DOW FROM entry_time)
       ORDER BY dow`,
      [req.user.id]
    ),
    db.query(
      `SELECT
         EXTRACT(HOUR FROM entry_time) as hour,
         COUNT(*) as total,
         COUNT(*) FILTER (WHERE pnl > 0) as wins,
         COALESCE(SUM(pnl), 0) as pnl
       FROM trades
       WHERE user_id = $1 AND status = 'closed' AND entry_time IS NOT NULL
       GROUP BY EXTRACT(HOUR FROM entry_time)
       ORDER BY hour`,
      [req.user.id]
    ),
  ]);

  res.json({
    dayOfWeek: dayPerf.rows,
    hourOfDay: hourPerf.rows,
  });
});

module.exports = router;
