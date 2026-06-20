require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const rateLimit = require('express-rate-limit');

const authRoutes = require('./routes/auth');
const tradesRoutes = require('./routes/trades');
const journalRoutes = require('./routes/journal');
const analyticsRoutes = require('./routes/analytics');
const paymentRoutes = require('./routes/payments');
const aiRoutes = require('./routes/ai');
const smcRoutes = require('./routes/smc');
const adminRoutes = require('./routes/admin');
const uploadRoutes = require('./routes/uploads');
const importRoutes = require('./routes/imports');

const { startPaymentMonitor } = require('./jobs/paymentMonitor');
const { startSubscriptionExpiry } = require('./jobs/subscriptionExpiry');
const { startMonthlyReset } = require('./jobs/monthlyReset');
const { errorHandler } = require('./middleware/errorHandler');
const { auditLog } = require('./middleware/auditLog');
const logger = require('./utils/logger');

const app = express();
const PORT = process.env.PORT || 4000;

// ── Security middleware ────────────────────────────────────
app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' },
}));

app.use(cors({
  origin: [
    process.env.FRONTEND_URL,
    'http://localhost:3000',
  ],
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-2FA-Token'],
}));

app.use(compression());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// ── Global rate limiter ────────────────────────────────────
const limiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000,
  max: parseInt(process.env.RATE_LIMIT_MAX) || 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please slow down.' },
});
app.use('/api/', limiter);

// Strict limiter for auth endpoints
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Too many auth attempts. Try again in 15 minutes.' },
});

// ── Audit logging ──────────────────────────────────────────
app.use(auditLog);

// ── Health check ───────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString(), version: '1.0.0' });
});

// ── API Routes ─────────────────────────────────────────────
app.use('/api/auth', authLimiter, authRoutes);
app.use('/api/trades', tradesRoutes);
app.use('/api/journal', journalRoutes);
app.use('/api/analytics', analyticsRoutes);
app.use('/api/payments', paymentRoutes);
app.use('/api/ai', aiRoutes);
app.use('/api/smc', smcRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/uploads', uploadRoutes);
app.use('/api/import', importRoutes);

// ── 404 handler ────────────────────────────────────────────
app.use('*', (req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

// ── Global error handler ───────────────────────────────────
app.use(errorHandler);

// ── Start background jobs ──────────────────────────────────
startPaymentMonitor();
startSubscriptionExpiry();
startMonthlyReset();

// ── Start server ───────────────────────────────────────────
app.listen(PORT, () => {
  logger.info(`TradePulse API running on port ${PORT} [${process.env.NODE_ENV}]`);
});

module.exports = app;
