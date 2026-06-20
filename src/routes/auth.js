const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { body, validationResult } = require('express-validator');
const { OAuth2Client } = require('googleapis').Auth;
const speakeasy = require('speakeasy');
const QRCode = require('qrcode');
const { v4: uuidv4 } = require('uuid');

const db = require('../config/database');
const { authenticate } = require('../middleware/auth');
const { sendEmail } = require('../services/emailService');
const logger = require('../utils/logger');

const router = express.Router();
const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

const generateTokens = (userId) => {
  const accessToken = jwt.sign({ userId }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '7d',
  });
  const refreshToken = jwt.sign({ userId }, process.env.JWT_REFRESH_SECRET, {
    expiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '30d',
  });
  return { accessToken, refreshToken };
};

// ── POST /api/auth/register ────────────────────────────────
router.post('/register', [
  body('name').trim().isLength({ min: 2, max: 100 }),
  body('email').isEmail().normalizeEmail(),
  body('password').isLength({ min: 8 }).matches(/^(?=.*[A-Z])(?=.*[0-9])/),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ error: 'Validation failed', details: errors.array() });
  }

  const { name, email, password } = req.body;

  try {
    const existing = await db.query('SELECT id FROM users WHERE email = $1', [email]);
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: 'Email already registered' });
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const verifyToken = uuidv4();

    const client = await db.getClient();
    try {
      await client.query('BEGIN');

      const userResult = await client.query(
        `INSERT INTO users (name, email, password_hash, email_verify_token)
         VALUES ($1, $2, $3, $4) RETURNING id, name, email, role`,
        [name, email, passwordHash, verifyToken]
      );
      const user = userResult.rows[0];

      await client.query(
        `INSERT INTO subscriptions (user_id, plan, status) VALUES ($1, 'free', 'active')`,
        [user.id]
      );

      await client.query('COMMIT');

      // Send verification email (non-blocking)
      sendEmail({
        to: email,
        subject: 'Welcome to TradePulse — Verify Your Email',
        template: 'verify',
        data: { name, verifyUrl: `${process.env.FRONTEND_URL}/verify?token=${verifyToken}` },
      }).catch(logger.error);

      const { accessToken, refreshToken } = generateTokens(user.id);
      res.status(201).json({
        message: 'Account created. Check your email to verify.',
        user: { id: user.id, name: user.name, email: user.email, plan: 'free' },
        accessToken,
        refreshToken,
      });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    logger.error('Register error:', err);
    res.status(500).json({ error: 'Registration failed' });
  }
});

// ── POST /api/auth/login ───────────────────────────────────
router.post('/login', [
  body('email').isEmail().normalizeEmail(),
  body('password').notEmpty(),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ error: 'Invalid credentials format' });
  }

  const { email, password, twoFaToken } = req.body;

  try {
    const result = await db.query(
      `SELECT u.*, s.plan, s.status as sub_status, s.expires_at
       FROM users u
       LEFT JOIN subscriptions s ON s.user_id = u.id
       WHERE u.email = $1`,
      [email]
    );

    const user = result.rows[0];
    if (!user || !user.password_hash) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    // 2FA check
    if (user.two_fa_enabled) {
      if (!twoFaToken) {
        return res.status(200).json({ requires2FA: true });
      }
      const verified = speakeasy.totp.verify({
        secret: user.two_fa_secret,
        encoding: 'base32',
        token: twoFaToken,
        window: 1,
      });
      if (!verified) {
        return res.status(401).json({ error: 'Invalid 2FA code' });
      }
    }

    const { accessToken, refreshToken } = generateTokens(user.id);

    res.json({
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        plan: user.plan || 'free',
        avatar_url: user.avatar_url,
        two_fa_enabled: user.two_fa_enabled,
      },
      accessToken,
      refreshToken,
    });
  } catch (err) {
    logger.error('Login error:', err);
    res.status(500).json({ error: 'Login failed' });
  }
});

// ── POST /api/auth/google ──────────────────────────────────
router.post('/google', async (req, res) => {
  const { idToken } = req.body;

  try {
    const ticket = await googleClient.verifyIdToken({
      idToken,
      audience: process.env.GOOGLE_CLIENT_ID,
    });
    const payload = ticket.getPayload();
    const { sub: googleId, email, name, picture } = payload;

    let result = await db.query(
      `SELECT u.*, s.plan FROM users u
       LEFT JOIN subscriptions s ON s.user_id = u.id
       WHERE u.google_id = $1 OR u.email = $2`,
      [googleId, email]
    );

    let user = result.rows[0];

    if (!user) {
      const client = await db.getClient();
      try {
        await client.query('BEGIN');
        const newUser = await client.query(
          `INSERT INTO users (name, email, google_id, avatar_url, email_verified)
           VALUES ($1, $2, $3, $4, true) RETURNING *`,
          [name, email, googleId, picture]
        );
        user = newUser.rows[0];
        await client.query(
          `INSERT INTO subscriptions (user_id, plan, status) VALUES ($1, 'free', 'active')`,
          [user.id]
        );
        await client.query('COMMIT');
        user.plan = 'free';
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    } else if (!user.google_id) {
      await db.query(
        `UPDATE users SET google_id = $1, avatar_url = $2 WHERE id = $3`,
        [googleId, picture, user.id]
      );
    }

    const { accessToken, refreshToken } = generateTokens(user.id);
    res.json({
      user: { id: user.id, name: user.name, email: user.email, plan: user.plan || 'free', avatar_url: user.avatar_url },
      accessToken,
      refreshToken,
    });
  } catch (err) {
    logger.error('Google auth error:', err);
    res.status(401).json({ error: 'Google authentication failed' });
  }
});

// ── POST /api/auth/refresh ─────────────────────────────────
router.post('/refresh', async (req, res) => {
  const { refreshToken } = req.body;
  if (!refreshToken) return res.status(401).json({ error: 'No refresh token' });

  try {
    const decoded = jwt.verify(refreshToken, process.env.JWT_REFRESH_SECRET);
    const tokens = generateTokens(decoded.userId);
    res.json(tokens);
  } catch {
    res.status(401).json({ error: 'Invalid refresh token' });
  }
});

// ── POST /api/auth/2fa/setup ───────────────────────────────
router.post('/2fa/setup', authenticate, async (req, res) => {
  const secret = speakeasy.generateSecret({
    name: `${process.env.TWO_FA_APP_NAME} (${req.user.email})`,
  });

  await db.query(`UPDATE users SET two_fa_secret = $1 WHERE id = $2`, [secret.base32, req.user.id]);

  const qrCode = await QRCode.toDataURL(secret.otpauth_url);
  res.json({ secret: secret.base32, qrCode });
});

// ── POST /api/auth/2fa/enable ──────────────────────────────
router.post('/2fa/enable', authenticate, async (req, res) => {
  const { token } = req.body;
  const user = await db.query(`SELECT two_fa_secret FROM users WHERE id = $1`, [req.user.id]);
  const secret = user.rows[0]?.two_fa_secret;

  const verified = speakeasy.totp.verify({ secret, encoding: 'base32', token, window: 1 });
  if (!verified) return res.status(400).json({ error: 'Invalid 2FA code' });

  await db.query(`UPDATE users SET two_fa_enabled = true WHERE id = $1`, [req.user.id]);
  res.json({ message: '2FA enabled successfully' });
});

// ── GET /api/auth/me ───────────────────────────────────────
router.get('/me', authenticate, async (req, res) => {
  const result = await db.query(
    `SELECT u.id, u.name, u.email, u.avatar_url, u.role, u.two_fa_enabled, u.email_verified,
            s.plan, s.status as sub_status, s.expires_at, s.trade_count_this_month
     FROM users u
     LEFT JOIN subscriptions s ON s.user_id = u.id
     WHERE u.id = $1`,
    [req.user.id]
  );
  res.json({ user: result.rows[0] });
});

// ── POST /api/auth/verify-email ────────────────────────────
router.post('/verify-email', async (req, res) => {
  const { token } = req.body;
  const result = await db.query(
    `UPDATE users SET email_verified = true, email_verify_token = NULL
     WHERE email_verify_token = $1 RETURNING id`,
    [token]
  );
  if (!result.rows.length) return res.status(400).json({ error: 'Invalid or expired token' });
  res.json({ message: 'Email verified successfully' });
});

module.exports = router;
