const Anthropic = require('@anthropic-ai/sdk');
const db = require('../config/database');
const logger = require('../utils/logger');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── Grade a trade A+ to F ──────────────────────────────────
const gradeFromAnalysis = (text) => {
  const lower = text.toLowerCase();
  if (lower.includes('excellent') || lower.includes('perfect') || lower.includes('exceptional')) return 'A+';
  if (lower.includes('very good') || lower.includes('strong execution')) return 'A';
  if (lower.includes('good') || lower.includes('solid')) return 'B+';
  if (lower.includes('average') || lower.includes('acceptable')) return 'B';
  if (lower.includes('below average') || lower.includes('some mistakes')) return 'C';
  if (lower.includes('poor') || lower.includes('multiple mistakes')) return 'D';
  if (lower.includes('revenge') || lower.includes('emotional') || lower.includes('no setup') || lower.includes('failed')) return 'F';
  return 'C';
};

// ── Analyze a single trade ─────────────────────────────────
const analyzeTradeWithAI = async (tradeId, trade, user) => {
  try {
    const pnl = trade.pnl ? `${trade.pnl > 0 ? '+' : ''}$${trade.pnl}` : 'Open';
    const rr = trade.r_multiple ? `${trade.r_multiple}R` : 'N/A';

    const prompt = `You are APEX, an elite trading coach analyzing a trade for an SMC/ICT trader.

TRADE DATA:
- Pair: ${trade.pair}
- Direction: ${trade.direction?.toUpperCase()}
- Asset Class: ${trade.asset_class}
- Entry: ${trade.entry_price}
- Exit: ${trade.exit_price || 'Still open'}
- Stop Loss: ${trade.stop_loss || 'Not set'}
- Take Profit: ${trade.take_profit || 'Not set'}
- P&L: ${pnl}
- R Multiple: ${rr}
- Risk:Reward: ${trade.risk_reward_ratio || 'N/A'}
- Session: ${trade.session || 'Unknown'}
- Strategy: ${trade.strategy || 'Not specified'}
- Setup Type: ${trade.setup_type || 'Not specified'}
- Source: ${trade.source}

Analyze this trade across 4 sections. Be direct and specific. Use SMC/ICT terminology.

ANALYSIS: (2-3 sentences overall assessment)
MISTAKES: (bullet list of mistakes, or "None identified" if clean)
STRENGTHS: (bullet list of strengths)
IMPROVEMENT: (1-2 specific actionable improvements for next time)`;

    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 600,
      messages: [{ role: 'user', content: prompt }],
    });

    const fullText = response.content[0].text;

    // Parse sections
    const getSection = (label, next) => {
      const regex = next
        ? new RegExp(`${label}:([\\s\\S]*?)${next}:`, 'i')
        : new RegExp(`${label}:([\\s\\S]*)`, 'i');
      const match = fullText.match(regex);
      return match ? match[1].trim() : '';
    };

    const analysis = getSection('ANALYSIS', 'MISTAKES');
    const mistakes = getSection('MISTAKES', 'STRENGTHS');
    const strengths = getSection('STRENGTHS', 'IMPROVEMENT');
    const improvement = getSection('IMPROVEMENT', null);
    const grade = gradeFromAnalysis(analysis + mistakes);

    await db.query(
      `UPDATE trades
       SET ai_grade = $1, ai_analysis = $2, ai_mistakes = $3, ai_strengths = $4
       WHERE id = $5`,
      [grade, analysis, mistakes, strengths, tradeId]
    );

    logger.info(`AI analysis complete for trade ${tradeId} — Grade: ${grade}`);
    return { grade, analysis, mistakes, strengths, improvement };
  } catch (err) {
    logger.error('analyzeTradeWithAI error:', err.message);
    throw err;
  }
};

// ── AI Coach chat ──────────────────────────────────────────
const chatWithCoach = async (userId, message, history = []) => {
  // Get user's recent performance context
  const stats = await db.query(
    `SELECT
       COUNT(*) as total_trades,
       COUNT(*) FILTER (WHERE pnl > 0) as wins,
       COUNT(*) FILTER (WHERE pnl < 0) as losses,
       AVG(r_multiple) as avg_r,
       SUM(pnl) as total_pnl,
       AVG(pnl) FILTER (WHERE pnl > 0) as avg_win,
       AVG(pnl) FILTER (WHERE pnl < 0) as avg_loss
     FROM trades
     WHERE user_id = $1 AND status = 'closed' AND created_at >= NOW() - INTERVAL '30 days'`,
    [userId]
  );

  const s = stats.rows[0];
  const winRate = s.total_trades > 0 ? ((s.wins / s.total_trades) * 100).toFixed(1) : 0;

  const systemPrompt = `You are APEX, an elite AI trading coach inside TradePulse. You specialize in Smart Money Concepts (SMC), ICT methodology, and trading psychology.

TRADER'S LAST 30 DAYS:
- Total trades: ${s.total_trades}
- Win rate: ${winRate}%
- Avg R multiple: ${parseFloat(s.avg_r || 0).toFixed(2)}R
- Net P&L: $${parseFloat(s.total_pnl || 0).toFixed(2)}
- Avg win: $${parseFloat(s.avg_win || 0).toFixed(2)}
- Avg loss: $${parseFloat(s.avg_loss || 0).toFixed(2)}

Rules:
- Be direct, specific, and actionable
- Use SMC/ICT terminology (Order Blocks, FVGs, BOS, CHOCH, liquidity, etc.)
- Keep responses under 150 words
- If you detect emotional trading patterns, address them directly
- Grade recommendations A+ to F when evaluating setups`;

  const messages = [
    ...history.slice(-10).map(h => ({ role: h.role, content: h.content })),
    { role: 'user', content: message },
  ];

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 400,
    system: systemPrompt,
    messages,
  });

  return response.content[0].text;
};

// ── Generate weekly/monthly AI report ─────────────────────
const generateReport = async (userId, type = 'weekly') => {
  const days = type === 'weekly' ? 7 : 30;
  const periodLabel = type === 'weekly' ? 'last 7 days' : 'last 30 days';

  const [statsResult, tradesResult, patternsResult] = await Promise.all([
    db.query(
      `SELECT
         COUNT(*) as total,
         COUNT(*) FILTER (WHERE pnl > 0) as wins,
         COUNT(*) FILTER (WHERE pnl < 0) as losses,
         SUM(pnl) as net_pnl,
         AVG(r_multiple) FILTER (WHERE r_multiple IS NOT NULL) as avg_r,
         MAX(pnl) as best_trade,
         MIN(pnl) as worst_trade,
         AVG(pnl) as avg_pnl
       FROM trades
       WHERE user_id = $1 AND status = 'closed' AND entry_time >= NOW() - INTERVAL '${days} days'`,
      [userId]
    ),
    db.query(
      `SELECT pair, direction, pnl, r_multiple, ai_grade, strategy, session
       FROM trades
       WHERE user_id = $1 AND status = 'closed' AND entry_time >= NOW() - INTERVAL '${days} days'
       ORDER BY entry_time DESC`,
      [userId]
    ),
    db.query(
      `SELECT session, COUNT(*) as count, SUM(pnl) as pnl,
              COUNT(*) FILTER (WHERE pnl > 0) as wins
       FROM trades
       WHERE user_id = $1 AND status = 'closed' AND entry_time >= NOW() - INTERVAL '${days} days'
       GROUP BY session`,
      [userId]
    ),
  ]);

  const s = statsResult.rows[0];
  const trades = tradesResult.rows;
  const sessions = patternsResult.rows;
  const winRate = s.total > 0 ? ((s.wins / s.total) * 100).toFixed(1) : 0;

  const prompt = `You are APEX. Generate a ${type} trading report for the ${periodLabel}.

STATS:
- Total trades: ${s.total}
- Win rate: ${winRate}%
- Net P&L: $${parseFloat(s.net_pnl || 0).toFixed(2)}
- Avg R: ${parseFloat(s.avg_r || 0).toFixed(2)}R
- Best trade: $${parseFloat(s.best_trade || 0).toFixed(2)}
- Worst trade: $${parseFloat(s.worst_trade || 0).toFixed(2)}

RECENT TRADES (last 5):
${trades.slice(0, 5).map(t => `${t.pair} ${t.direction} ${t.pnl > 0 ? '+' : ''}$${t.pnl} (${t.ai_grade || '?'})`).join('\n')}

SESSION PERFORMANCE:
${sessions.map(s => `${s.session}: ${s.count} trades, P&L $${parseFloat(s.pnl || 0).toFixed(2)}, WR ${s.count > 0 ? ((s.wins / s.count) * 100).toFixed(0) : 0}%`).join('\n')}

Write a concise ${type} report with:
OVERALL_GRADE: (A+ to F)
SUMMARY: (2-3 sentences)
TOP_STRENGTHS: (2 bullet points)
KEY_ISSUES: (2 bullet points)
ACTION_PLAN: (3 numbered steps for next ${type === 'weekly' ? 'week' : 'month'})`;

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 700,
    messages: [{ role: 'user', content: prompt }],
  });

  const text = response.content[0].text;

  // Extract grade
  const gradeMatch = text.match(/OVERALL_GRADE:\s*([A-F][+-]?)/i);
  const grade = gradeMatch ? gradeMatch[1] : 'B';

  // Save report
  await db.query(
    `INSERT INTO ai_reports (user_id, report_type, period_start, period_end, overall_grade, content, metrics)
     VALUES ($1, $2, NOW() - INTERVAL '${days} days', NOW(), $3, $4, $5)`,
    [userId, type, grade, text, JSON.stringify({ winRate, netPnl: s.net_pnl, totalTrades: s.total })]
  );

  return { grade, content: text, stats: s };
};

// ── Detect emotional/revenge trading ──────────────────────
const detectBehaviourPatterns = async (userId) => {
  const trades = await db.query(
    `SELECT id, entry_time, pnl, direction, pair
     FROM trades
     WHERE user_id = $1 AND status = 'closed'
     ORDER BY entry_time DESC LIMIT 20`,
    [userId]
  );

  const patterns = [];
  const rows = trades.rows;

  for (let i = 0; i < rows.length - 1; i++) {
    const current = rows[i];
    const prev = rows[i + 1];

    if (!current.entry_time || !prev.entry_time) continue;

    const timeDiff = (new Date(current.entry_time) - new Date(prev.entry_time)) / 1000 / 60;
    const prevWasLoss = parseFloat(prev.pnl) < 0;
    const quickEntry = timeDiff < 15 && timeDiff > 0;

    if (prevWasLoss && quickEntry) {
      patterns.push({
        type: 'revenge_trade',
        tradeId: current.id,
        message: `Possible revenge trade on ${current.pair} — entered ${timeDiff.toFixed(0)} min after a loss`,
        severity: 'high',
      });
    }
  }

  // Check overtrading (>5 trades in one day)
  const dailyCounts = await db.query(
    `SELECT DATE(entry_time) as day, COUNT(*) as count
     FROM trades
     WHERE user_id = $1 AND entry_time >= NOW() - INTERVAL '30 days'
     GROUP BY DATE(entry_time)
     HAVING COUNT(*) > 5`,
    [userId]
  );

  for (const row of dailyCounts.rows) {
    patterns.push({
      type: 'overtrading',
      message: `${row.count} trades on ${row.day} — overtrading detected`,
      severity: 'medium',
    });
  }

  return patterns;
};

module.exports = {
  analyzeTradeWithAI,
  chatWithCoach,
  generateReport,
  detectBehaviourPatterns,
};
