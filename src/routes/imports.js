// ============================================================
// imports.js
// ============================================================
const express = require('express');
const multer = require('multer');
const { authenticate } = require('../middleware/auth');
const { importTrades } = require('../services/importService');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

router.post('/:broker', authenticate, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  const { broker } = req.params;
  const validBrokers = ['mt4', 'mt5', 'binance', 'bybit', 'hyperliquid', 'bingx', 'csv'];
  if (!validBrokers.includes(broker.toLowerCase())) {
    return res.status(400).json({ error: 'Unsupported broker' });
  }

  try {
    const content = req.file.buffer.toString('utf-8');
    const result = await importTrades(req.user.id, broker, content);
    res.json({ message: `Import complete`, ...result });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;
