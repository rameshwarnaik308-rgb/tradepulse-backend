const jwt = require('jsonwebtoken');
const db = require('../config/database');

const authenticate = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'No token provided' });
    }

    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    const result = await db.query(
      `SELECT u.id, u.email, u.name, u.role, u.two_fa_enabled,
              s.plan, s.status as sub_status, s.expires_at
       FROM users u
       LEFT JOIN subscriptions s ON s.user_id = u.id
       WHERE u.id = $1`,
      [decoded.userId]
    );

    if (!result.rows[0]) {
      return res.status(401).json({ error: 'User not found' });
    }

    const user = result.rows[0];

    // Check if subscription expired
    if (user.plan === 'pro' && user.expires_at && new Date(user.expires_at) < new Date()) {
      await db.query(
        `UPDATE subscriptions SET plan = 'free', status = 'expired' WHERE user_id = $1`,
        [user.id]
      );
      user.plan = 'free';
    }

    req.user = user;
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Token expired', code: 'TOKEN_EXPIRED' });
    }
    return res.status(401).json({ error: 'Invalid token' });
  }
};

const requirePro = (req, res, next) => {
  if (req.user.plan !== 'pro') {
    return res.status(403).json({
      error: 'This feature requires a Pro subscription',
      code: 'PRO_REQUIRED',
      upgradeUrl: '/pricing',
    });
  }
  next();
};

const requireAdmin = (req, res, next) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
};

module.exports = { authenticate, requirePro, requireAdmin };
