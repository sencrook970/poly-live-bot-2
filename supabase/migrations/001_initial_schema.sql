-- ============================================================================
-- POLYMARKET BOT — Database Schema v2
-- ============================================================================
-- Scalable for:
--   - Multiple prediction platforms (Polymarket, Kalshi, Metaculus)
--   - Multiple wallets/accounts
--   - Multiple strategies
--   - Full order lifecycle (placed → filled/failed/cancelled)
--   - Accurate P&L (only counts FILLED orders, never fake numbers)
--   - Complete activity history (deposits, withdrawals, swaps, approvals)
--
-- Key rule: NEVER calculate totals from bot memory.
-- Always derive from actual filled orders in this database.
-- ============================================================================

-- ============================================================
-- PLATFORM & WALLET
-- ============================================================

CREATE TABLE IF NOT EXISTS platforms (
  id TEXT PRIMARY KEY,                    -- 'polymarket', 'kalshi'
  name TEXT NOT NULL,                     -- 'Polymarket'
  chain TEXT,                             -- 'polygon', 'ethereum'
  chain_id INTEGER,                       -- 137
  api_base_url TEXT,
  data_api_url TEXT,                      -- for reading positions
  created_at TIMESTAMPTZ DEFAULT NOW()
);

INSERT INTO platforms (id, name, chain, chain_id, api_base_url, data_api_url)
VALUES ('polymarket', 'Polymarket', 'polygon', 137,
        'https://clob.polymarket.com', 'https://data-api.polymarket.com')
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS wallets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  platform_id TEXT REFERENCES platforms(id),
  address TEXT NOT NULL,                  -- '0xBBF2...'
  label TEXT,                             -- 'main', 'test'
  signature_type INTEGER DEFAULT 0,
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(platform_id, address)
);

-- ============================================================
-- MARKETS
-- ============================================================

CREATE TABLE IF NOT EXISTS markets (
  id TEXT PRIMARY KEY,                    -- market ID from platform
  platform_id TEXT REFERENCES platforms(id),
  question TEXT NOT NULL,
  description TEXT,
  category TEXT,                          -- 'crypto', 'politics', 'sports', etc.
  outcomes JSONB,                         -- ["Yes", "No"]
  token_ids JSONB,                        -- ["123...", "456..."]
  end_date TIMESTAMPTZ,
  is_active BOOLEAN DEFAULT TRUE,
  volume_24h NUMERIC,
  liquidity NUMERIC,
  neg_risk BOOLEAN DEFAULT FALSE,
  slug TEXT,
  event_id TEXT,
  event_title TEXT,
  first_seen_at TIMESTAMPTZ DEFAULT NOW(),
  last_price_yes NUMERIC,                -- last known YES price
  last_price_no NUMERIC,                 -- last known NO price
  last_updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_markets_platform ON markets(platform_id);
CREATE INDEX IF NOT EXISTS idx_markets_category ON markets(category);
CREATE INDEX IF NOT EXISTS idx_markets_active ON markets(is_active);
CREATE INDEX IF NOT EXISTS idx_markets_end_date ON markets(end_date);

-- ============================================================
-- ORDERS (every order attempt — placed, filled, failed, cancelled)
-- This is the COMPLETE history of everything the bot tried to do.
-- ============================================================

CREATE TABLE IF NOT EXISTS orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_id UUID REFERENCES wallets(id),
  market_id TEXT REFERENCES markets(id),
  platform_id TEXT REFERENCES platforms(id),

  -- What we tried to do
  side TEXT NOT NULL CHECK (side IN ('BUY', 'SELL')),
  outcome TEXT NOT NULL,                  -- 'Yes', 'No', 'Bucks', etc.
  token_id TEXT NOT NULL,
  shares NUMERIC NOT NULL,
  price NUMERIC NOT NULL,                 -- price per share
  total_amount NUMERIC NOT NULL,          -- shares * price (what we spent or received)

  -- Why we did it
  strategy TEXT NOT NULL,                 -- 'ai_prediction', 'crypto_momentum', etc.
  order_reason TEXT,                      -- 'new_position', 'add_to_position', 'take_profit', 'stop_loss', 'sell_all'
  edge_percent NUMERIC,
  confidence NUMERIC,
  reasoning TEXT,                         -- AI reasoning
  search_context TEXT,                    -- web search results used

  -- What happened (THE KEY FIELD — only 'filled' orders count for P&L)
  status TEXT NOT NULL DEFAULT 'placed'
    CHECK (status IN ('placed', 'delayed', 'live', 'matched', 'filled', 'failed', 'cancelled')),

  -- Exchange response
  exchange_order_id TEXT,                 -- Polymarket order ID
  tx_hash TEXT,                           -- blockchain transaction hash
  error_message TEXT,                     -- if failed, why

  -- Timestamps
  placed_at TIMESTAMPTZ DEFAULT NOW(),
  filled_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_orders_wallet ON orders(wallet_id);
CREATE INDEX IF NOT EXISTS idx_orders_market ON orders(market_id);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_strategy ON orders(strategy);
CREATE INDEX IF NOT EXISTS idx_orders_placed ON orders(placed_at);
CREATE INDEX IF NOT EXISTS idx_orders_side ON orders(side);

-- ============================================================
-- POSITIONS (current state — derived from FILLED orders only)
-- Updated after each filled order. Never from bot memory.
-- ============================================================

CREATE TABLE IF NOT EXISTS positions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_id UUID REFERENCES wallets(id),
  market_id TEXT REFERENCES markets(id),
  platform_id TEXT REFERENCES platforms(id),

  token_id TEXT NOT NULL,
  outcome TEXT NOT NULL,

  -- Quantities (only from FILLED orders)
  total_shares NUMERIC NOT NULL DEFAULT 0,
  avg_price NUMERIC NOT NULL DEFAULT 0,
  total_cost NUMERIC NOT NULL DEFAULT 0,  -- actual USDC spent (sum of filled BUY costs)

  -- Current market state
  current_price NUMERIC DEFAULT 0,
  current_value NUMERIC DEFAULT 0,        -- total_shares * current_price
  unrealized_pnl NUMERIC DEFAULT 0,       -- current_value - total_cost

  -- Status
  status TEXT DEFAULT 'open' CHECK (status IN ('open', 'closed', 'resolved_won', 'resolved_lost')),
  opened_at TIMESTAMPTZ DEFAULT NOW(),
  closed_at TIMESTAMPTZ,
  close_reason TEXT,                      -- 'take_profit', 'stop_loss', 'resolved', 'manual', 'sell_all'

  -- Realized P&L (only when position is closed)
  total_received NUMERIC DEFAULT 0,       -- USDC received from selling or resolution
  realized_pnl NUMERIC DEFAULT 0,         -- total_received - total_cost

  UNIQUE(wallet_id, token_id)
);

CREATE INDEX IF NOT EXISTS idx_positions_wallet ON positions(wallet_id);
CREATE INDEX IF NOT EXISTS idx_positions_status ON positions(status);
CREATE INDEX IF NOT EXISTS idx_positions_market ON positions(market_id);

-- ============================================================
-- WALLET ACTIVITY (deposits, withdrawals, swaps, gas — everything)
-- This is how we track the REAL money in and out.
-- "Total deposited" = SUM of deposits. No guessing.
-- ============================================================

CREATE TABLE IF NOT EXISTS wallet_activity (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_id UUID REFERENCES wallets(id),

  type TEXT NOT NULL CHECK (type IN (
    'deposit',          -- USDC.e received into wallet
    'withdrawal',       -- USDC.e sent out of wallet
    'swap',             -- USDC → USDC.e swap on Uniswap
    'approval',         -- token approval transaction (gas cost)
    'gas',              -- POL spent on gas
    'trade_spend',      -- USDC.e spent on a trade (linked to order)
    'trade_receive',    -- USDC.e received from a sell/resolution
    'resolution_payout' -- payout from a resolved market
  )),

  amount NUMERIC NOT NULL,                -- positive = money in, negative = money out
  token TEXT DEFAULT 'USDC.e',            -- 'USDC.e', 'USDC', 'POL'
  tx_hash TEXT,
  order_id UUID REFERENCES orders(id),    -- linked to specific order (for trade_spend/receive)
  notes TEXT,                             -- human-readable description

  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_activity_wallet ON wallet_activity(wallet_id);
CREATE INDEX IF NOT EXISTS idx_activity_type ON wallet_activity(type);
CREATE INDEX IF NOT EXISTS idx_activity_created ON wallet_activity(created_at);

-- ============================================================
-- DAILY SNAPSHOTS (for P&L charts over time)
-- One row per wallet per day. Taken at midnight or on-demand.
-- ============================================================

CREATE TABLE IF NOT EXISTS daily_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_id UUID REFERENCES wallets(id),
  date DATE NOT NULL,

  -- Balances
  usdc_balance NUMERIC,                   -- cash in wallet
  portfolio_value NUMERIC,                -- sum of all position current_values
  total_assets NUMERIC,                   -- usdc_balance + portfolio_value

  -- P&L (cumulative)
  total_deposited NUMERIC,                -- sum of all deposits ever
  total_withdrawn NUMERIC,                -- sum of all withdrawals ever
  unrealized_pnl NUMERIC,
  realized_pnl NUMERIC,
  net_pnl NUMERIC,                        -- total_assets - total_deposited + total_withdrawn

  -- Activity today
  trades_count INTEGER DEFAULT 0,
  amount_traded NUMERIC DEFAULT 0,
  positions_opened INTEGER DEFAULT 0,
  positions_closed INTEGER DEFAULT 0,

  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(wallet_id, date)
);

CREATE INDEX IF NOT EXISTS idx_snapshots_wallet_date ON daily_snapshots(wallet_id, date);

-- ============================================================
-- STRATEGY STATS (auto-updated after each trade resolution)
-- Used to auto-disable bad strategies.
-- ============================================================

CREATE TABLE IF NOT EXISTS strategy_stats (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_id UUID REFERENCES wallets(id),
  strategy TEXT NOT NULL,
  category TEXT,                          -- 'sports', 'politics', etc. (per-category tracking)

  total_trades INTEGER DEFAULT 0,
  filled_trades INTEGER DEFAULT 0,        -- actually executed
  winning_trades INTEGER DEFAULT 0,
  losing_trades INTEGER DEFAULT 0,
  win_rate NUMERIC DEFAULT 0,             -- winning / (winning + losing)

  total_invested NUMERIC DEFAULT 0,
  total_returned NUMERIC DEFAULT 0,
  total_pnl NUMERIC DEFAULT 0,

  avg_edge_percent NUMERIC DEFAULT 0,
  avg_confidence NUMERIC DEFAULT 0,

  best_trade_pnl NUMERIC DEFAULT 0,
  worst_trade_pnl NUMERIC DEFAULT 0,

  is_enabled BOOLEAN DEFAULT TRUE,        -- auto-disable if win_rate < 0.4 after 20 trades
  last_trade_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ DEFAULT NOW(),

  UNIQUE(wallet_id, strategy, category)
);

-- ============================================================
-- AI ANALYSIS LOG (what AI thought about every market)
-- Even markets we didn't trade. Useful for improving the AI.
-- ============================================================

CREATE TABLE IF NOT EXISTS ai_analyses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  market_id TEXT REFERENCES markets(id),
  wallet_id UUID REFERENCES wallets(id),

  -- Model used
  model TEXT NOT NULL,                     -- 'google/gemini-2.0-flash-001'
  model_cost NUMERIC DEFAULT 0,           -- cost of this API call

  -- AI's assessment
  ai_probability NUMERIC,
  market_probability NUMERIC,
  edge_percent NUMERIC,
  confidence NUMERIC,
  reasoning TEXT,

  -- Web search context
  search_query TEXT,
  search_results TEXT,
  search_source TEXT,                      -- 'tavily', 'perplexity'

  -- Decision
  decision TEXT CHECK (decision IN ('trade', 'skip_low_edge', 'skip_low_confidence', 'skip_filtered', 'skip_sports')),

  -- Was the AI right? (filled in after market resolves)
  actual_outcome TEXT,                     -- 'yes', 'no'
  was_correct BOOLEAN,                    -- did AI predict correctly?

  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_analyses_market ON ai_analyses(market_id);
CREATE INDEX IF NOT EXISTS idx_analyses_decision ON ai_analyses(decision);
CREATE INDEX IF NOT EXISTS idx_analyses_created ON ai_analyses(created_at);
CREATE INDEX IF NOT EXISTS idx_analyses_correct ON ai_analyses(was_correct);

-- ============================================================
-- SCAN LOG (what happened each scan cycle)
-- ============================================================

CREATE TABLE IF NOT EXISTS scans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_id UUID REFERENCES wallets(id),

  scan_number INTEGER,
  duration_ms INTEGER,                    -- how long the scan took

  -- What was found
  markets_scanned INTEGER,
  opportunities_found INTEGER,
  opportunities_new INTEGER,              -- not already traded
  opportunities_skipped INTEGER,          -- already traded or too small

  -- What was done
  orders_placed INTEGER DEFAULT 0,
  orders_filled INTEGER DEFAULT 0,
  orders_failed INTEGER DEFAULT 0,

  -- State at time of scan
  usdc_balance NUMERIC,
  portfolio_value NUMERIC,
  total_unrealized_pnl NUMERIC,
  positions_count INTEGER,

  -- Strategies that ran
  strategies_run JSONB,

  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_scans_wallet ON scans(wallet_id);
CREATE INDEX IF NOT EXISTS idx_scans_created ON scans(created_at);

-- ============================================================
-- VIEWS — ready-made queries for the dashboard
-- ============================================================

-- Accurate P&L summary (ONLY from filled orders and actual deposits)
CREATE OR REPLACE VIEW pnl_summary AS
SELECT
  w.address,
  w.label,
  COALESCE(deposits.total, 0) as total_deposited,
  COALESCE(withdrawals.total, 0) as total_withdrawn,
  COALESCE(spent.total, 0) as total_spent_on_trades,
  COALESCE(received.total, 0) as total_received_from_trades,
  COALESCE(received.total, 0) - COALESCE(spent.total, 0) as realized_pnl,
  COALESCE(open_value.total, 0) as open_positions_value,
  COALESCE(open_cost.total, 0) as open_positions_cost,
  COALESCE(open_value.total, 0) - COALESCE(open_cost.total, 0) as unrealized_pnl
FROM wallets w
LEFT JOIN (
  SELECT wallet_id, SUM(amount) as total FROM wallet_activity
  WHERE type = 'deposit' GROUP BY wallet_id
) deposits ON w.id = deposits.wallet_id
LEFT JOIN (
  SELECT wallet_id, SUM(ABS(amount)) as total FROM wallet_activity
  WHERE type = 'withdrawal' GROUP BY wallet_id
) withdrawals ON w.id = withdrawals.wallet_id
LEFT JOIN (
  SELECT wallet_id, SUM(total_amount) as total FROM orders
  WHERE side = 'BUY' AND status IN ('filled', 'matched') GROUP BY wallet_id
) spent ON w.id = spent.wallet_id
LEFT JOIN (
  SELECT wallet_id, SUM(total_amount) as total FROM orders
  WHERE side = 'SELL' AND status IN ('filled', 'matched') GROUP BY wallet_id
) received ON w.id = received.wallet_id
LEFT JOIN (
  SELECT wallet_id, SUM(current_value) as total FROM positions
  WHERE status = 'open' GROUP BY wallet_id
) open_value ON w.id = open_value.wallet_id
LEFT JOIN (
  SELECT wallet_id, SUM(total_cost) as total FROM positions
  WHERE status = 'open' GROUP BY wallet_id
) open_cost ON w.id = open_cost.wallet_id
WHERE w.is_active = TRUE;

-- Current portfolio with market details
CREATE OR REPLACE VIEW portfolio_detail AS
SELECT
  w.address as wallet_address,
  w.label as wallet_label,
  p.outcome,
  m.question as market_question,
  m.category,
  m.end_date,
  p.total_shares,
  p.avg_price,
  p.total_cost,
  p.current_price,
  p.current_value,
  p.unrealized_pnl,
  p.status,
  p.opened_at
FROM positions p
JOIN wallets w ON p.wallet_id = w.id
JOIN markets m ON p.market_id = m.id
WHERE p.status = 'open'
ORDER BY p.unrealized_pnl DESC;

-- Full order history with context
CREATE OR REPLACE VIEW order_history AS
SELECT
  o.placed_at,
  o.side,
  o.outcome,
  o.shares,
  o.price,
  o.total_amount,
  o.strategy,
  o.order_reason,
  o.edge_percent,
  o.confidence,
  o.reasoning,
  o.status,
  o.error_message,
  o.exchange_order_id,
  o.tx_hash,
  m.question as market_question,
  m.category,
  w.label as wallet_label
FROM orders o
JOIN markets m ON o.market_id = m.id
JOIN wallets w ON o.wallet_id = w.id
ORDER BY o.placed_at DESC;

-- Strategy performance leaderboard
CREATE OR REPLACE VIEW strategy_leaderboard AS
SELECT
  strategy,
  category,
  total_trades,
  filled_trades,
  winning_trades,
  losing_trades,
  ROUND(win_rate * 100, 1) as win_rate_pct,
  total_pnl,
  best_trade_pnl,
  worst_trade_pnl,
  is_enabled
FROM strategy_stats
ORDER BY total_pnl DESC;

-- Daily P&L chart data
CREATE OR REPLACE VIEW daily_pnl_chart AS
SELECT
  date,
  total_assets,
  total_deposited,
  net_pnl,
  trades_count,
  positions_opened,
  positions_closed
FROM daily_snapshots
ORDER BY date ASC;
