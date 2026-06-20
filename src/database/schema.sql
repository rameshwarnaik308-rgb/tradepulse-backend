-- ============================================================
-- TradePulse - Complete PostgreSQL Schema
-- ============================================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ============================================================
-- USERS
-- ============================================================
CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash TEXT,
  google_id VARCHAR(255) UNIQUE,
  name VARCHAR(255) NOT NULL,
  avatar_url TEXT,
  role VARCHAR(20) DEFAULT 'user' CHECK (role IN ('user', 'admin')),
  two_fa_secret TEXT,
  two_fa_enabled BOOLEAN DEFAULT false,
  email_verified BOOLEAN DEFAULT false,
  email_verify_token TEXT,
  reset_password_token TEXT,
  reset_password_expires TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- SUBSCRIPTIONS
-- ============================================================
CREATE TABLE subscriptions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  plan VARCHAR(20) DEFAULT 'free' CHECK (plan IN ('free', 'pro')),
  status VARCHAR(20) DEFAULT 'active' CHECK (status IN ('active', 'expired', 'cancelled', 'pending')),
  started_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  trade_count_this_month INTEGER DEFAULT 0,
  trade_count_reset_at TIMESTAMPTZ DEFAULT DATE_TRUNC('month', NOW()) + INTERVAL '1 month',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id)
);

-- ============================================================
-- USDT PAYMENT REQUESTS
-- ============================================================
CREATE TABLE payment_requests (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  wallet_address VARCHAR(255) NOT NULL UNIQUE,
  private_key_encrypted TEXT NOT NULL,
  amount_usdt DECIMAL(18,6) DEFAULT 10.000000,
  status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'detecting', 'confirmed', 'expired', 'failed')),
  tx_hash VARCHAR(255),
  confirmations INTEGER DEFAULT 0,
  required_confirmations INTEGER DEFAULT 6,
  detected_at TIMESTAMPTZ,
  confirmed_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ DEFAULT NOW() + INTERVAL '30 minutes',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- PAYMENT HISTORY
-- ============================================================
CREATE TABLE payment_history (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  payment_request_id UUID REFERENCES payment_requests(id),
  amount_usdt DECIMAL(18,6) NOT NULL,
  tx_hash VARCHAR(255) NOT NULL,
  wallet_from VARCHAR(255),
  wallet_to VARCHAR(255),
  network VARCHAR(20) DEFAULT 'TRC20',
  plan VARCHAR(20) DEFAULT 'pro',
  period_days INTEGER DEFAULT 30,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- TRADES
-- ============================================================
CREATE TABLE trades (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  pair VARCHAR(50) NOT NULL,
  direction VARCHAR(10) NOT NULL CHECK (direction IN ('long', 'short')),
  asset_class VARCHAR(20) DEFAULT 'forex' CHECK (asset_class IN ('forex','crypto','futures','stocks','options')),
  entry_price DECIMAL(20,8) NOT NULL,
  exit_price DECIMAL(20,8),
  stop_loss DECIMAL(20,8),
  take_profit DECIMAL(20,8),
  position_size DECIMAL(20,8),
  risk_amount DECIMAL(20,8),
  pnl DECIMAL(20,8),
  pnl_percent DECIMAL(10,4),
  risk_reward_ratio DECIMAL(10,4),
  r_multiple DECIMAL(10,4),
  status VARCHAR(20) DEFAULT 'open' CHECK (status IN ('open','closed','cancelled')),
  entry_time TIMESTAMPTZ,
  exit_time TIMESTAMPTZ,
  session VARCHAR(20) CHECK (session IN ('asia','london','new_york','overlap')),
  strategy VARCHAR(100),
  setup_type VARCHAR(100),
  ai_grade VARCHAR(5),
  ai_analysis TEXT,
  ai_mistakes TEXT,
  ai_strengths TEXT,
  screenshot_url TEXT,
  broker_trade_id VARCHAR(255),
  source VARCHAR(20) DEFAULT 'manual' CHECK (source IN ('manual','mt4','mt5','binance','bybit','hyperliquid','bingx','csv')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- TRADE TAGS
-- ============================================================
CREATE TABLE trade_tags (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  trade_id UUID REFERENCES trades(id) ON DELETE CASCADE,
  tag VARCHAR(100) NOT NULL
);

-- ============================================================
-- JOURNAL ENTRIES
-- ============================================================
CREATE TABLE journal_entries (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  trade_id UUID REFERENCES trades(id) ON DELETE SET NULL,
  entry_type VARCHAR(20) DEFAULT 'general' CHECK (entry_type IN ('pre_trade','during_trade','post_trade','general','psychology')),
  title VARCHAR(255),
  content TEXT NOT NULL,
  emotion VARCHAR(50),
  confidence_level INTEGER CHECK (confidence_level BETWEEN 1 AND 10),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- SMC TRACKING
-- ============================================================
CREATE TABLE smc_levels (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  trade_id UUID REFERENCES trades(id) ON DELETE SET NULL,
  pair VARCHAR(50) NOT NULL,
  timeframe VARCHAR(10) NOT NULL,
  concept VARCHAR(50) NOT NULL CHECK (concept IN (
    'order_block','breaker_block','fair_value_gap','liquidity_sweep',
    'bos','choch','cisd','swing_high','swing_low','market_structure_shift'
  )),
  price_level DECIMAL(20,8) NOT NULL,
  price_high DECIMAL(20,8),
  price_low DECIMAL(20,8),
  direction VARCHAR(10) CHECK (direction IN ('bullish','bearish','neutral')),
  status VARCHAR(20) DEFAULT 'active' CHECK (status IN ('active','mitigated','invalidated')),
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- AI REPORTS
-- ============================================================
CREATE TABLE ai_reports (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  report_type VARCHAR(20) CHECK (report_type IN ('daily','weekly','monthly')),
  period_start TIMESTAMPTZ,
  period_end TIMESTAMPTZ,
  overall_grade VARCHAR(5),
  content TEXT NOT NULL,
  metrics JSONB,
  improvements JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- AUDIT LOGS
-- ============================================================
CREATE TABLE audit_logs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  action VARCHAR(100) NOT NULL,
  resource VARCHAR(100),
  resource_id VARCHAR(255),
  ip_address INET,
  user_agent TEXT,
  metadata JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- SUPPORT TICKETS
-- ============================================================
CREATE TABLE support_tickets (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  subject VARCHAR(255) NOT NULL,
  message TEXT NOT NULL,
  status VARCHAR(20) DEFAULT 'open' CHECK (status IN ('open','in_progress','resolved','closed')),
  priority VARCHAR(20) DEFAULT 'normal' CHECK (priority IN ('low','normal','high','urgent')),
  admin_reply TEXT,
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- COMMUNITY / PUBLIC JOURNALS
-- ============================================================
CREATE TABLE community_profiles (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE UNIQUE,
  username VARCHAR(100) UNIQUE NOT NULL,
  bio TEXT,
  is_public BOOLEAN DEFAULT false,
  is_verified BOOLEAN DEFAULT false,
  followers INTEGER DEFAULT 0,
  following INTEGER DEFAULT 0,
  total_trades_public INTEGER DEFAULT 0,
  public_win_rate DECIMAL(5,2),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- INDEXES
-- ============================================================
CREATE INDEX idx_trades_user_id ON trades(user_id);
CREATE INDEX idx_trades_created_at ON trades(created_at DESC);
CREATE INDEX idx_trades_pair ON trades(pair);
CREATE INDEX idx_trades_status ON trades(status);
CREATE INDEX idx_payment_requests_user_id ON payment_requests(user_id);
CREATE INDEX idx_payment_requests_status ON payment_requests(status);
CREATE INDEX idx_payment_requests_wallet ON payment_requests(wallet_address);
CREATE INDEX idx_audit_logs_user_id ON audit_logs(user_id);
CREATE INDEX idx_audit_logs_created_at ON audit_logs(created_at DESC);
CREATE INDEX idx_journal_user_id ON journal_entries(user_id);
CREATE INDEX idx_smc_user_pair ON smc_levels(user_id, pair);
CREATE INDEX idx_subscriptions_user ON subscriptions(user_id);
CREATE INDEX idx_subscriptions_expires ON subscriptions(expires_at);

-- ============================================================
-- AUTO-UPDATE updated_at trigger
-- ============================================================
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_users_updated BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_subscriptions_updated BEFORE UPDATE ON subscriptions FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_trades_updated BEFORE UPDATE ON trades FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_payment_requests_updated BEFORE UPDATE ON payment_requests FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_journal_updated BEFORE UPDATE ON journal_entries FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_tickets_updated BEFORE UPDATE ON support_tickets FOR EACH ROW EXECUTE FUNCTION update_updated_at();
