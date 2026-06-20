const express = require('express');
const db = require('../config/database');
const { authenticate, requirePro } = require('../middleware/auth');
const { chatWithCoach, generateReport, detectBehaviourPatterns } = require('../services/aiService');
const logger = require('../utils/logger');

const router = express.Router();

// ── POST /api/ai/chat ──────────────────────────────────────
router.post('/chat', authenticate, requirePro, async (req, res) => {
  const { message, history = [] } = req.body;
  if (!message?.trim()) return res.status(400).json({ error: 'Message required' });

  try {
    const reply = await chatWithCoach(req.user.id, message, history);
    res.json({ reply });
  } catch (err) {
    logger.error('AI chat error:', err);
    res.status(500).json({ error: 'AI coach unavailable. Try again.' });
  }
});

// ── GET /api/ai/report/:type ───────────────────────────────
router.get('/report/:type', authenticate, requirePro, async (req, res) => {
  const { type } = req.params;
  if (!['weekly', 'monthly'].includes(type)) {
    return res.status(400).json({ error: 'Type must be weekly or monthly' });
  }

  // Check if recent report already exists (avoid regenerating)
  const existing = await db.query(
    `SELECT * FROM ai_reports
     WHERE user_id = $1 AND report_type = $2
       AND created_at >= NOW() - INTERVAL '${type === 'weekly' ? '12 hours' : '24 hours'}'
     ORDER BY created_at DESC LIMIT 1`,
    [req.user.id, type]
  );

  if (existing.rows.length > 0) {
    return res.json({ report: existing.rows[0], cached: true });
  }

  try {
    const report = await generateReport(req.user.id, type);
    res.json({ report, cached: false });
  } catch (err) {
    logger.error('Report generation error:', err);
    res.status(500).json({ error: 'Report generation failed' });
  }
});

// ── GET /api/ai/patterns ───────────────────────────────────
router.get('/patterns', authenticate, requirePro, async (req, res) => {
  try {
    const patterns = await detectBehaviourPatterns(req.user.id);
    res.json({ patterns });
  } catch (err) {
    res.status(500).json({ error: 'Pattern detection failed' });
  }
});

// ── GET /api/ai/reports/history ────────────────────────────
router.get('/reports/history', authenticate, requirePro, async (req, res) => {
  const result = await db.query(
    `SELECT id, report_type, overall_grade, period_start, period_end, metrics, created_at
     FROM ai_reports
     WHERE user_id = $1
     ORDER BY created_at DESC LIMIT 20`,
    [req.user.id]
  );
  res.json({ reports: result.rows });
});

module.exports = router;
