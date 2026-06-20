// ============================================================
// services/emailService.js
// ============================================================
const nodemailer = require('nodemailer');

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: parseInt(process.env.SMTP_PORT) || 587,
  secure: false,
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
});

const templates = {
  verify: ({ name, verifyUrl }) => ({
    subject: 'Verify your TradePulse email',
    html: `<div style="font-family:sans-serif;max-width:600px;margin:auto;background:#0D1420;color:#E8F0FE;padding:32px;border-radius:12px">
      <h2 style="color:#00C2FF">Welcome to TradePulse, ${name}! 🚀</h2>
      <p>Click below to verify your email and start journaling your trades.</p>
      <a href="${verifyUrl}" style="display:inline-block;background:linear-gradient(135deg,#00C2FF,#0080CC);color:#fff;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:700;margin:16px 0">Verify Email</a>
      <p style="color:#8FA3BF;font-size:12px">Link expires in 24 hours.</p>
    </div>`,
  }),

  proActivated: ({ name, txHash, amount, expiresAt, dashboardUrl }) => ({
    subject: '🎉 TradePulse Pro Activated!',
    html: `<div style="font-family:sans-serif;max-width:600px;margin:auto;background:#0D1420;color:#E8F0FE;padding:32px;border-radius:12px">
      <h2 style="color:#00E599">Pro Plan Activated, ${name}! ✅</h2>
      <p>Your payment of <strong>${amount} USDT</strong> was confirmed on the TRON blockchain.</p>
      <div style="background:#111927;border:1px solid #1E2D42;border-radius:8px;padding:16px;margin:16px 0">
        <div style="color:#8FA3BF;font-size:12px">Transaction Hash</div>
        <div style="font-family:monospace;font-size:12px;color:#00C2FF;word-break:break-all">${txHash}</div>
        <div style="color:#8FA3BF;font-size:12px;margin-top:8px">Subscription expires</div>
        <div style="color:#FFB800;font-weight:700">${expiresAt}</div>
      </div>
      <a href="${dashboardUrl}" style="display:inline-block;background:linear-gradient(135deg,#00C2FF,#0080CC);color:#fff;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:700">Go to Dashboard →</a>
    </div>`,
  }),

  renewalReminder: ({ name, expiresAt, upgradeUrl }) => ({
    subject: '⚠️ Your TradePulse Pro expires soon',
    html: `<div style="font-family:sans-serif;max-width:600px;margin:auto;background:#0D1420;color:#E8F0FE;padding:32px;border-radius:12px">
      <h2 style="color:#FFB800">Pro subscription expiring, ${name}</h2>
      <p>Your TradePulse Pro plan expires on <strong>${expiresAt}</strong>.</p>
      <p>Renew now to keep access to AI coaching, unlimited trades, and SMC tracking.</p>
      <a href="${upgradeUrl}" style="display:inline-block;background:linear-gradient(135deg,#FFB800,#CC8800);color:#000;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:700">Renew Pro — 10 USDT</a>
    </div>`,
  }),
};

const sendEmail = async ({ to, template, data, subject, html }) => {
  let content = { subject, html };
  if (template && templates[template]) {
    content = templates[template](data || {});
  }

  await transporter.sendMail({
    from: process.env.EMAIL_FROM,
    to,
    subject: content.subject,
    html: content.html,
  });
};

// ============================================================
// middleware/errorHandler.js
// ============================================================
const errorHandler = (err, req, res, next) => {
  console.error('Unhandled error:', err);
  const status = err.status || err.statusCode || 500;
  res.status(status).json({
    error: status === 500 ? 'Internal server error' : err.message,
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack }),
  });
};

// ============================================================
// middleware/auditLog.js
// ============================================================
const auditLog = async (req, res, next) => {
  res.on('finish', async () => {
    try {
      if (req.method === 'GET') return;
      const db = require('../config/database');
      await db.query(
        `INSERT INTO audit_logs (user_id, action, resource, ip_address, user_agent, metadata)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          req.user?.id || null,
          `${req.method} ${req.path}`,
          req.path.split('/')[2] || null,
          req.ip,
          req.headers['user-agent'],
          JSON.stringify({ status: res.statusCode, body: req.method !== 'GET' ? undefined : null }),
        ]
      );
    } catch (_) {}
  });
  next();
};

// ============================================================
// utils/logger.js
// ============================================================
const winston = require('winston');
const logger = winston.createLogger({
  level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.colorize(),
    winston.format.printf(({ timestamp, level, message, ...meta }) =>
      `${timestamp} [${level}]: ${message} ${Object.keys(meta).length ? JSON.stringify(meta) : ''}`
    )
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: 'logs/error.log', level: 'error' }),
    new winston.transports.File({ filename: 'logs/combined.log' }),
  ],
});

// ============================================================
// jobs/subscriptionExpiry.js
// ============================================================
const cronSub = require('node-cron');
const subscriptionExpiryJob = () => {
  cronSub.schedule('0 * * * *', async () => {
    try {
      const db = require('../config/database');
      // Downgrade expired subs
      const expired = await db.query(
        `UPDATE subscriptions SET plan='free', status='expired'
         WHERE plan='pro' AND expires_at <= NOW() AND status='active'
         RETURNING user_id`
      );
      if (expired.rows.length > 0) {
        logger.info(`Expired ${expired.rows.length} pro subscriptions`);
      }

      // Send renewal reminders 3 days before expiry
      const expiringSoon = await db.query(
        `SELECT u.email, u.name, s.expires_at FROM subscriptions s
         JOIN users u ON u.id = s.user_id
         WHERE s.plan='pro' AND s.status='active'
           AND s.expires_at BETWEEN NOW() AND NOW() + INTERVAL '3 days'`
      );

      for (const user of expiringSoon.rows) {
        sendEmail({
          to: user.email,
          template: 'renewalReminder',
          data: {
            name: user.name,
            expiresAt: new Date(user.expires_at).toLocaleDateString(),
            upgradeUrl: `${process.env.FRONTEND_URL}/pricing`,
          },
        }).catch(() => {});
      }
    } catch (err) {
      logger.error('Subscription expiry job error:', err);
    }
  });
  logger.info('✅ Subscription expiry job started (hourly)');
};

// ============================================================
// jobs/monthlyReset.js
// ============================================================
const cronMonthly = require('node-cron');
const monthlyResetJob = () => {
  cronMonthly.schedule('0 0 1 * *', async () => {
    try {
      const db = require('../config/database');
      await db.query(
        `UPDATE subscriptions
         SET trade_count_this_month = 0,
             trade_count_reset_at = DATE_TRUNC('month', NOW()) + INTERVAL '1 month'
         WHERE plan = 'free'`
      );
      logger.info('Monthly trade count reset complete');
    } catch (err) {
      logger.error('Monthly reset error:', err);
    }
  });
  logger.info('✅ Monthly reset job started (1st of each month)');
};

// ============================================================
// uploads.js route (S3/R2 signed upload)
// ============================================================
const express2 = require('express');
const crypto2 = require('crypto');
const uploadsRouter = express2.Router();
const { authenticate: auth2 } = require('../middleware/auth');

uploadsRouter.post('/sign', auth2, async (req, res) => {
  const { filename, contentType } = req.body;
  if (!filename || !contentType) return res.status(400).json({ error: 'filename and contentType required' });

  const ext = filename.split('.').pop();
  const key = `screenshots/${req.user.id}/${crypto2.randomUUID()}.${ext}`;

  // Return presigned URL info (client uploads directly to R2/S3)
  // In production use @aws-sdk/s3-request-presigner
  res.json({
    key,
    uploadUrl: `${process.env.S3_ENDPOINT}/${process.env.S3_BUCKET}/${key}`,
    publicUrl: `${process.env.CDN_URL}/${key}`,
    message: 'Configure AWS S3 presigner in production',
  });
});

module.exports = {
  sendEmail,
  errorHandler,
  auditLog,
  logger,
  startSubscriptionExpiry: subscriptionExpiryJob,
  startMonthlyReset: monthlyResetJob,
  uploadsRouter,
};
