const Papa = require('papaparse');
const db = require('../config/database');
const logger = require('../utils/logger');

// ── Detect session from UTC hour ───────────────────────────
const detectSession = (date) => {
  if (!date) return null;
  const h = new Date(date).getUTCHours();
  if (h >= 0 && h < 8) return 'asia';
  if (h >= 8 && h < 12) return 'london';
  if (h >= 12 && h < 16) return 'overlap';
  if (h >= 16 && h < 21) return 'new_york';
  return 'asia';
};

// ── Calculate R multiple ───────────────────────────────────
const calcR = (entry, exit, stop, direction) => {
  if (!stop || !exit) return null;
  const risk = Math.abs(entry - stop);
  if (risk === 0) return null;
  const reward = direction === 'long' ? exit - entry : entry - exit;
  return parseFloat((reward / risk).toFixed(2));
};

// ── MT4 CSV Parser ─────────────────────────────────────────
// MT4 history export format: Ticket, Open Time, Type, Lots, Symbol, Price, S/L, T/P, Close Time, Close Price, Commission, Swap, Profit
const parseMT4 = (csvContent) => {
  const result = Papa.parse(csvContent.trim(), {
    header: true,
    skipEmptyLines: true,
    dynamicTyping: true,
  });

  return result.data
    .filter(row => row.Type === 'buy' || row.Type === 'sell')
    .map(row => {
      const entryPrice = parseFloat(row['Price'] || row['Open Price'] || 0);
      const exitPrice = parseFloat(row['Close Price'] || 0);
      const stopLoss = parseFloat(row['S/L'] || 0) || null;
      const direction = row.Type === 'buy' ? 'long' : 'short';
      const entryTime = row['Open Time'] ? new Date(row['Open Time']) : null;

      return {
        pair: (row['Symbol'] || row['Pair'] || '').toUpperCase(),
        direction,
        entry_price: entryPrice,
        exit_price: exitPrice || null,
        stop_loss: stopLoss,
        take_profit: parseFloat(row['T/P'] || 0) || null,
        position_size: parseFloat(row['Lots'] || 0),
        pnl: parseFloat(row['Profit'] || 0),
        r_multiple: calcR(entryPrice, exitPrice, stopLoss, direction),
        status: exitPrice ? 'closed' : 'open',
        entry_time: entryTime,
        exit_time: row['Close Time'] ? new Date(row['Close Time']) : null,
        session: detectSession(entryTime),
        source: 'mt4',
        broker_trade_id: String(row['Ticket'] || ''),
        asset_class: 'forex',
      };
    })
    .filter(t => t.pair && t.entry_price > 0);
};

// ── MT5 CSV Parser ─────────────────────────────────────────
// MT5 export: Position, Symbol, Type, Volume, Price, S / L, T / P, Time, State, Comment
const parseMT5 = (csvContent) => {
  const result = Papa.parse(csvContent.trim(), {
    header: true,
    skipEmptyLines: true,
    dynamicTyping: true,
    delimiter: '\t',
  });

  return result.data.map(row => {
    const type = (row['Type'] || '').toLowerCase();
    const direction = type.includes('buy') ? 'long' : 'short';
    const entryPrice = parseFloat(row['Price'] || 0);
    const exitPrice = parseFloat(row['Close Price'] || row['Price '] || 0);
    const stopLoss = parseFloat(row['S / L'] || row['S/L'] || 0) || null;
    const entryTime = row['Time'] ? new Date(row['Time']) : null;

    return {
      pair: (row['Symbol'] || '').replace('/', '').toUpperCase(),
      direction,
      entry_price: entryPrice,
      exit_price: exitPrice || null,
      stop_loss: stopLoss,
      take_profit: parseFloat(row['T / P'] || row['T/P'] || 0) || null,
      position_size: parseFloat(row['Volume'] || 0),
      pnl: parseFloat(row['Profit'] || 0),
      r_multiple: calcR(entryPrice, exitPrice, stopLoss, direction),
      status: 'closed',
      entry_time: entryTime,
      exit_time: null,
      session: detectSession(entryTime),
      source: 'mt5',
      broker_trade_id: String(row['Position'] || ''),
      asset_class: 'forex',
    };
  }).filter(t => t.pair && t.entry_price > 0);
};

// ── Binance Spot/Futures CSV Parser ────────────────────────
// Binance export: Date(UTC), Pair, Side, Price, Executed, Amount, Fee, Total
const parseBinance = (csvContent) => {
  const result = Papa.parse(csvContent.trim(), {
    header: true,
    skipEmptyLines: true,
    dynamicTyping: true,
  });

  // Group by pair to match buy/sell
  const grouped = {};
  for (const row of result.data) {
    const pair = (row['Pair'] || row['Symbol'] || '').toUpperCase();
    if (!grouped[pair]) grouped[pair] = [];
    grouped[pair].push(row);
  }

  const trades = [];
  for (const [pair, rows] of Object.entries(grouped)) {
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const side = (row['Side'] || row['Type'] || '').toLowerCase();
      const price = parseFloat(row['Price'] || row['Average Price'] || 0);
      const time = row['Date(UTC)'] || row['Date'] || row['Time'];

      trades.push({
        pair,
        direction: side.includes('buy') ? 'long' : 'short',
        entry_price: price,
        exit_price: null,
        position_size: parseFloat(row['Executed'] || row['Amount'] || 0),
        pnl: parseFloat(row['Realized Profit'] || row['Profit'] || 0),
        status: 'closed',
        entry_time: time ? new Date(time) : null,
        session: detectSession(time ? new Date(time) : null),
        source: 'binance',
        broker_trade_id: String(row['Order ID'] || i),
        asset_class: 'crypto',
      });
    }
  }

  return trades.filter(t => t.pair && t.entry_price > 0);
};

// ── Bybit CSV Parser ───────────────────────────────────────
const parseBybit = (csvContent) => {
  const result = Papa.parse(csvContent.trim(), {
    header: true,
    skipEmptyLines: true,
    dynamicTyping: true,
  });

  return result.data.map(row => {
    const side = (row['Side'] || '').toLowerCase();
    const entryPrice = parseFloat(row['Avg Entry Price'] || row['Entry Price'] || 0);
    const exitPrice = parseFloat(row['Avg Exit Price'] || row['Exit Price'] || 0);
    const pnl = parseFloat(row['Closed P&L'] || row['Realized P&L'] || 0);
    const time = row['Create Time'] || row['Open Time'];

    return {
      pair: (row['Symbol'] || '').toUpperCase(),
      direction: side === 'buy' ? 'long' : 'short',
      entry_price: entryPrice,
      exit_price: exitPrice || null,
      position_size: parseFloat(row['Qty'] || row['Size'] || 0),
      pnl,
      r_multiple: null,
      status: 'closed',
      entry_time: time ? new Date(time) : null,
      exit_time: row['Close Time'] ? new Date(row['Close Time']) : null,
      session: detectSession(time ? new Date(time) : null),
      source: 'bybit',
      broker_trade_id: String(row['Order ID'] || ''),
      asset_class: 'crypto',
    };
  }).filter(t => t.pair && t.entry_price > 0);
};

// ── Hyperliquid JSON Parser ────────────────────────────────
const parseHyperliquid = (jsonContent) => {
  const data = typeof jsonContent === 'string' ? JSON.parse(jsonContent) : jsonContent;
  const fills = Array.isArray(data) ? data : data.fills || data.trades || [];

  return fills.map(fill => {
    const side = (fill.side || fill.dir || '').toLowerCase();
    const time = fill.time || fill.closedAt || fill.openedAt;

    return {
      pair: (fill.coin || fill.symbol || '').toUpperCase(),
      direction: side === 'b' || side === 'buy' || side === 'long' ? 'long' : 'short',
      entry_price: parseFloat(fill.px || fill.entryPx || fill.price || 0),
      exit_price: parseFloat(fill.closedPx || 0) || null,
      position_size: parseFloat(fill.sz || fill.size || 0),
      pnl: parseFloat(fill.closedPnl || fill.realizedPnl || 0),
      status: 'closed',
      entry_time: time ? new Date(time) : null,
      session: detectSession(time ? new Date(time) : null),
      source: 'hyperliquid',
      broker_trade_id: String(fill.oid || fill.cloid || ''),
      asset_class: 'crypto',
    };
  }).filter(t => t.pair && t.entry_price > 0);
};

// ── Generic CSV Parser ─────────────────────────────────────
const parseGenericCSV = (csvContent) => {
  const result = Papa.parse(csvContent.trim(), {
    header: true,
    skipEmptyLines: true,
    dynamicTyping: true,
  });

  return result.data.map((row, i) => {
    const keys = Object.keys(row).map(k => k.toLowerCase());
    const get = (...names) => {
      for (const name of names) {
        const key = Object.keys(row).find(k => k.toLowerCase().includes(name));
        if (key && row[key] !== undefined && row[key] !== '') return row[key];
      }
      return null;
    };

    const entry = parseFloat(get('entry', 'open', 'price') || 0);
    const exit = parseFloat(get('exit', 'close') || 0);
    const stop = parseFloat(get('stop', 'sl', 's/l') || 0);
    const dir = (get('direction', 'side', 'type') || '').toLowerCase();
    const direction = dir.includes('buy') || dir.includes('long') ? 'long' : 'short';
    const time = get('time', 'date', 'open time', 'entry time');

    return {
      pair: (get('pair', 'symbol', 'instrument') || '').toUpperCase(),
      direction,
      entry_price: entry,
      exit_price: exit || null,
      stop_loss: stop || null,
      take_profit: parseFloat(get('tp', 'take profit') || 0) || null,
      position_size: parseFloat(get('size', 'lots', 'volume', 'qty') || 0),
      pnl: parseFloat(get('pnl', 'profit', 'p&l', 'return') || 0),
      r_multiple: calcR(entry, exit, stop, direction),
      status: 'closed',
      entry_time: time ? new Date(time) : null,
      session: detectSession(time ? new Date(time) : null),
      source: 'csv',
      broker_trade_id: String(get('id', 'ticket', 'order') || i),
      asset_class: 'forex',
    };
  }).filter(t => t.pair && t.entry_price > 0);
};

// ── Main import function ───────────────────────────────────
const importTrades = async (userId, broker, content, contentType = 'csv') => {
  let parsedTrades = [];

  switch (broker.toLowerCase()) {
    case 'mt4': parsedTrades = parseMT4(content); break;
    case 'mt5': parsedTrades = parseMT5(content); break;
    case 'binance': parsedTrades = parseBinance(content); break;
    case 'bybit': parsedTrades = parseBybit(content); break;
    case 'hyperliquid': parsedTrades = parseHyperliquid(content); break;
    case 'bingx':
    case 'csv':
    default: parsedTrades = parseGenericCSV(content); break;
  }

  if (parsedTrades.length === 0) {
    throw new Error('No valid trades found in file. Check format and try again.');
  }

  let imported = 0;
  let skipped = 0;

  for (const trade of parsedTrades) {
    try {
      // Skip duplicates by broker_trade_id
      if (trade.broker_trade_id) {
        const exists = await db.query(
          `SELECT id FROM trades WHERE user_id = $1 AND broker_trade_id = $2 AND source = $3`,
          [userId, trade.broker_trade_id, trade.source]
        );
        if (exists.rows.length > 0) { skipped++; continue; }
      }

      await db.query(
        `INSERT INTO trades (
           user_id, pair, direction, asset_class, entry_price, exit_price,
           stop_loss, take_profit, position_size, pnl, r_multiple,
           status, entry_time, exit_time, session, source, broker_trade_id
         ) VALUES (
           $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17
         )`,
        [
          userId, trade.pair, trade.direction, trade.asset_class,
          trade.entry_price, trade.exit_price, trade.stop_loss,
          trade.take_profit, trade.position_size, trade.pnl,
          trade.r_multiple, trade.status, trade.entry_time,
          trade.exit_time, trade.session, trade.source, trade.broker_trade_id,
        ]
      );
      imported++;
    } catch (err) {
      logger.warn(`Skip trade import row: ${err.message}`);
      skipped++;
    }
  }

  logger.info(`Import complete: ${imported} imported, ${skipped} skipped (user ${userId})`);
  return { imported, skipped, total: parsedTrades.length };
};

module.exports = { importTrades };
