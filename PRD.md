# PRD — Polymarket Bot Improvement Plan

> **Goal:** Turn a losing bot (-$17 on $42 deposited) into a profitable, production-ready trading bot worthy of a $500 bankroll.

> **For new Claude sessions:** Read this file + `STATUS.md` + `ARCHITECTURE.md` to understand the full context. This PRD is the single source of truth for what to build next.

---

## Current State (2026-03-15, evening)

- **Bot location:** `/polymarket-bot/`
- **Tech:** TypeScript, @polymarket/clob-client SDK, Polygon mainnet
- **Deposited:** ~$60 USDC.e (topped up after selling all positions)
- **Current assets:** ~$60 cash, 0 positions
- **Previous P&L:** -$19 (-23% on first $82 deposited). All positions sold.
- **Active strategy:** News Sniper (event-driven, evidence-based)
- **Root cause of previous losses:** AI guessed sports outcomes, spread too thin with $1-2 bets, no distinction between facts and speculation.
- **What works:** Full infrastructure (orders, sync, auto-sell, DB, search, balance detection)
- **What's new:** News Sniper strategy with evidence classification (CONFIRMED/STRONG/WEAK/UNKNOWN)

## Target State

- **Bankroll:** $500 USDC.e
- **Monthly target:** 5-15% return ($25-75/month)
- **Win rate:** 60%+ on trades
- **Max drawdown:** -10% ($50)
- **Fully automated:** runs 24/7 on a server, alerts via Telegram
- **Dashboard:** web UI to see portfolio, P&L, trade history

---

## Phase 0: Critical Fixes (before depositing more money)
> Fix the bugs that caused losses. Must complete before any new deposits.

- [x] Fix duplicate trades (bot was buying same market every 30 seconds)
- [x] Fix "sell what you don't own" logic (removed fake sell opportunities)
- [x] Fix failed orders being recorded as positions
- [x] Fix dead positions spamming sell errors every scan
- [x] Add $1 minimum order check
- [x] Add persistent state (state.json survives restarts)
- [x] Add on-chain position sync on startup
- [x] Add auto-sell (take profit / stop loss)
- [x] Add balance auto-detection (no restart on deposit)
- [x] Fix "Total invested" showing inflated numbers — now calculated from DB filled orders only (2026-03-15)
- [ ] Add error counter — if 5+ orders fail in a row, pause trading for 5 minutes
- [x] Don't try to sell resolved markets — auto-removes positions at price 0 or 1 (2026-03-15)

---

## Phase 1: Smarter AI (highest impact on profitability)
> The AI currently guesses from question text alone. It needs real-world context.

### 1.1 Add Web Search Before Every Prediction
- [x] Integrate Tavily search API (free tier, 1000 credits/month) (2026-03-15)
- [x] Before asking the LLM, search for current news about the topic (2026-03-15)
- [x] Feed search results (top 3-5 snippets) into the LLM prompt (2026-03-15)
- [x] Smart search filtering — skip sports, always search geopolitics/economics (2026-03-15)

### 1.2 Use a Smarter Model
- [x] Upgraded from `google/gemini-2.0-flash-001` to `google/gemini-2.5-flash` (2026-03-15)
- [ ] Consider `anthropic/claude-sonnet-4` for highest-edge decisions (costs more)
- [ ] Two-step: fast model filters 200 markets → smart model analyzes top 5

### 1.6 News Sniper Strategy (IMPLEMENTED 2026-03-15)
- [x] Evidence classification system: CONFIRMED / STRONG / WEAK / UNKNOWN
- [x] Only trades on CONFIRMED (event already happened) or STRONG (multiple sources agree)
- [x] LLM must cite a specific fact to claim CONFIRMED — sanity check prevents hallucination
- [x] Smart market prioritization: geopolitics > economics > elections > commodities > awards
- [x] Concentrated bets: $5-15 per trade instead of $1-2 (MAX_TRADE_SIZE bumped to $15)
- [x] 4-hour skip cache for WEAK/UNKNOWN markets (saves Tavily credits)
- [x] Disabled old AI Predictor (replaced by News Sniper)
- [x] All analyses logged to Supabase with evidence level
- [x] Extended sports filter with more patterns
- [ ] Add second LLM pass for CONFIRMED trades (verify with different model)
- [ ] Track evidence level accuracy over time (did CONFIRMED trades actually resolve correctly?)
- [ ] Add "edge decay" — if same market shows CONFIRMED for 3+ scans, edge may be gone

### 1.3 Multi-Model Consensus
- [ ] Ask 2-3 models the same question
- [ ] Only trade when 2+ models agree on direction AND edge
- [ ] If models disagree, skip the trade
- [ ] This prevents single-model hallucination errors

### 1.4 Better Prompt Engineering
- [ ] Add "you must explain WHY you disagree with the market" requirement
- [ ] Add "what information would change your estimate?" reflection
- [ ] Add calibration examples ("a 10% event happens 1 in 10 times")
- [ ] Penalize overconfidence — if AI says >80% confidence, require stronger reasoning

### 1.5 Market Category Awareness
- [x] Tag markets by category (sports, politics, crypto, economics, culture) (2026-03-15)
- [x] For sports: SKIP entirely via regex patterns (2026-03-15)
- [x] For crypto: use real price data (already built)
- [x] For politics/geopolitics: web search required (2026-03-15)
- [x] For economics: web search + data feeds (2026-03-15)

---

## Phase 2: Better Market Selection (avoid bad trades)
> Pick the RIGHT markets to trade. Most of our losses came from bad market selection.

### 2.1 Market Filters
- [x] Skip sports moneyline bets — regex patterns for all major leagues (2026-03-15)
- [x] Skip esports (Counter-Strike, Dota, LoL) (2026-03-15)
- [x] Skip markets ending within 6 hours (2026-03-15)
- [x] Skip markets ending after 120 days (2026-03-15)
- [x] Minimum $5K liquidity (up from $2K) (2026-03-15)
- [ ] Only trade markets with 24h volume > $5K
- [ ] Prefer markets ending in 1-4 weeks

### 2.2 Category-Based Strategy
- [ ] Geopolitics (Iran, wars, diplomacy) — use web search + LLM. These are our best trades.
- [ ] Economics (Fed rates, oil prices) — use data feeds + LLM
- [ ] Elections (2028 nominees) — use polls data + LLM
- [ ] Crypto prices — use real price feeds (built). Focus on "will BTC be above $X?" markets.
- [ ] Culture/Entertainment (Oscars, TV shows) — use web search for predictions/odds

### 2.3 Edge Decay Detection
- [ ] Track how long an opportunity persists
- [ ] If the same "edge" appears 10+ scans in a row with no price change, it's probably not real
- [ ] Real edges get arbitraged away within minutes

---

## Phase 3: Better Risk Management (protect the bankroll)
> Even good trades lose sometimes. Risk management keeps you alive.

### 3.0 Position Conflict Detection (CRITICAL)
- [x] Detect when bot wants to buy opposite side of existing position (2026-03-15)
- [x] Block conflicting trades with warning log (2026-03-15)
- [ ] When AI changes direction on a market, consider selling existing position first
- [ ] Add a "conviction change" alert when AI flips from YES to NO or vice versa
- [x] Add 2-hour cooldown on add-to-existing positions (prevents buying same market every scan) (2026-03-15)
- [x] Fix crypto momentum: stop buying BTC Down when BTC is UP (wrong logic) (2026-03-15)
- [x] Disable BTC Up/Down markets entirely — no edge from momentum on daily markets (2026-03-15)
- [x] Crypto strategy now only trades price target markets (reach $X by date) (2026-03-15)

### 3.1 Position Sizing & Capital Management (IMPLEMENTED 2026-03-16)
- [ ] Scale Kelly fraction based on confidence: high conf → quarter Kelly, low conf → eighth Kelly
- [x] Max trade size configurable ($15 currently)
- [x] Maximum 75% of total assets deployed (keep 25% cash reserve) (2026-03-16)
- [x] Maximum 60% of total assets deployed per day (prevents overtrading) (2026-03-16)
- [x] Maximum 5 new markets per day (2026-03-16)
- [x] Low-cash mode: below $5, only manage existing positions (2026-03-16)

### 3.2 Correlation Awareness
- [x] Group related markets by topic (iran, oil, us_politics) (2026-03-15)
- [x] Max 3 positions per correlation group (2026-03-15)
- [x] Log when correlation limit blocks a trade (2026-03-15)

### 3.2.1 FUNDER_ADDRESS Investigation (TODO — HIGH PRIORITY)
- [ ] Regular (non-neg-risk) markets fail with "not enough balance / allowance" even with $22+ cash and UNLIMITED allowances
- [ ] Neg-risk markets (BTC multi-outcome) trade successfully
- [ ] Root cause theory: FUNDER_ADDRESS is set to the EOA address, but ARCHITECTURE.md says "FUNDER_ADDRESS empty required for MetaMask wallets"
- [ ] Test: set FUNDER_ADDRESS="" in .env and verify regular market trades work
- [ ] Risk: changing FUNDER_ADDRESS might affect existing positions — test carefully
- [ ] The CLOB SDK's `updateBalanceAllowance()` is also broken (returns "assetAddress invalid hex address") — may be related
- [ ] Alternative: try creating fresh API keys with `npm run setup-keys` after changing FUNDER_ADDRESS

### 3.3 Smarter Stop Loss & Auto-Sell v2 (IMPLEMENTED 2026-03-16)
- [x] Auto-sell verifies actual on-chain shares before selling (prevents "not enough balance" errors) (2026-03-16)
- [x] Retry tracking: max 3 attempts per position, 30-min cooldown (2026-03-16)
- [x] Marks positions as "manual required" after too many failures (2026-03-16)
- [ ] Time-based stops: down >20% after 24h AND edge disappeared → sell
- [ ] Near-expiry take profit: resolving in <2h and profitable → sell

### 3.4 Portfolio Optimizer (IMPLEMENTED 2026-03-16)
- [x] Runs on startup to clean up contradictory positions (2026-03-16)
- [x] Detects BTC contradictions using live CoinGecko price (2026-03-16)
- [x] Sells near-zero price positions (certain losers) (2026-03-16)
- [x] Sells deeply underwater positions with no recovery path (2026-03-16)

### 3.5 BTC Correlation Limits (IMPLEMENTED 2026-03-16)
- [x] Max 2 simultaneous BTC positions (2026-03-16)
- [x] Max 30% of total assets in BTC exposure (2026-03-16)
- [x] Risk manager blocks new BTC trades when limits hit (2026-03-16)

### 3.4 Performance Tracking
- [ ] Track win rate per strategy (AI, crypto, arbitrage)
- [ ] Track win rate per market category (sports, politics, crypto)
- [ ] Automatically disable strategies with <40% win rate after 20+ trades
- [ ] Weekly P&L report

---

## Phase 4: Production Infrastructure (run 24/7 reliably)
> Move from "run on laptop" to "run on server with monitoring."

### 4.1 Server Deployment
- [ ] Deploy to a VPS (DigitalOcean, Railway, or Render)
- [ ] Run as a background process with PM2 or systemd
- [ ] Auto-restart on crash
- [ ] Log rotation (don't fill disk)

### 4.2 Database (replace state.json)
- [x] Migrated to Supabase PostgreSQL (2026-03-15)
- [x] 12 tables: wallets, markets, orders, positions, wallet_activity, daily_snapshots, strategy_stats, ai_analyses, scans, platforms + 5 views
- [x] Schema supports multiple platforms, wallets, strategies
- [x] Seed script populates historical data
- [x] All new trades, analyses, and snapshots save to DB
- [ ] Fully replace state.json with DB reads (state.json still used for dedup)

### 4.3 Alerts & Notifications
- [ ] Telegram bot for trade notifications
- [ ] Alert on: new trade, take profit, stop loss, error, low balance
- [ ] Daily P&L summary at midnight
- [ ] Weekly performance report

### 4.4 Dashboard (frontend)
- [ ] Next.js dashboard showing:
  - Current positions with live P&L
  - Trade history with charts
  - Strategy performance comparison
  - Daily/weekly/monthly P&L chart
  - Balance and deposit history
- [ ] Connect to Supabase for real-time data

---

## Phase 5: Advanced Strategies (maximize returns)
> Once the foundation is solid, add more sophisticated strategies.

### 5.1 News-Reactive Trading
- [ ] Monitor news feeds (RSS, Twitter/X API) for breaking events
- [ ] When a relevant event happens, immediately check if any Polymarket market is mispriced
- [ ] Example: "Iran announces ceasefire" → buy YES on Iran ceasefire market before price adjusts
- [ ] Speed matters — first 5 minutes after news is where the edge is

### 5.2 BTC 5-Minute Directional Bot (SEPARATE BOT)
- [ ] Use Binance WebSocket for sub-second BTC price updates
- [ ] Track the price at the start of each 5-min Polymarket window
- [ ] In the last 10-15 seconds, if BTC is clearly above/below start price, trade
- [ ] Use MAKER orders (zero fees + rebates)
- [ ] Target 80%+ accuracy on clear signals, skip unclear rounds

### 5.3 Cross-Platform Arbitrage
- [ ] Monitor both Polymarket and Kalshi for the same events
- [ ] When prices diverge, buy cheap side on one platform and expensive side on the other
- [ ] Requires Kalshi API integration

### 5.4 Sentiment Analysis
- [ ] Scrape Twitter/X for sentiment on market topics
- [ ] Combine sentiment with LLM analysis for better probability estimates
- [ ] Track which sentiment signals actually predict market movements

### 5.5 Copy Trading
- [ ] Monitor top Polymarket traders' wallets on-chain
- [ ] When a top trader enters a position, evaluate whether to follow
- [ ] Only follow if our AI also agrees with the direction

---

## Phase 6: Scale & Optimize (grow the bankroll)
> Once profitable, scale up carefully.

### 6.1 Bankroll Growth Plan
- [ ] Start with $500
- [ ] At $750 (50% profit), increase MAX_TRADE_SIZE to $10
- [ ] At $1000 (100% profit), increase MAX_TRADE_SIZE to $20
- [ ] At $2000, consider enabling arbitrage strategy (needs big bankroll)
- [ ] Never risk more than 2% per trade as bankroll grows

### 6.2 Multi-Account Strategy
- [ ] Create a second wallet for different strategies
- [ ] Account 1: conservative (geopolitics, economics — low risk)
- [ ] Account 2: aggressive (crypto, short-term — higher risk)
- [ ] Track performance separately

### 6.3 Market Making (advanced)
- [ ] Post limit orders on both sides of thin markets
- [ ] Earn the spread (e.g., buy at $0.48, sell at $0.52)
- [ ] Requires significant capital and inventory management
- [ ] Only for markets with stable prices

---

## Priority Order

| Priority | Phase | Estimated Impact | Effort | Status |
|----------|-------|-----------------|--------|--------|
| **1** | **Phase 3.2.1: Fix FUNDER_ADDRESS** | **Unblocks ALL regular market trades** | **30 min** | **NEXT** |
| 2 | Phase 0: Critical Fixes | Stops bleeding money | 1-2 hours | DONE |
| 3 | Phase 1.1: Web Search | 2-3x better AI predictions | 3-4 hours | DONE |
| 4 | Phase 2.1: Market Filters | Avoids bad trades entirely | 1-2 hours | DONE |
| 5 | Phase 1.2: Smarter Model | Better reasoning quality | 1 hour | DONE |
| 6 | **Phase 1.6: News Sniper** | **Evidence-based concentrated bets** | **3 hours** | **DONE** |
| 7 | Phase 3.1: Capital Management v2 | Daily caps, BTC limits, low-cash mode | 3 hours | DONE |
| 8 | Phase 3.4: Portfolio Optimizer | Auto-sell contradictions on startup | 2 hours | DONE |
| 9 | Phase 3.5: BTC Correlation | Max 2 BTC positions, 30% cap | 1 hour | DONE |
| 10 | Phase 3.3: Auto-Sell v2 | On-chain verification, retries | 2 hours | DONE |
| 11 | Phase 1.3: Multi-Model | Eliminates hallucination trades | 2-3 hours | TODO |
| 12 | Phase 3.2: Correlation | Diversifies risk | 1-2 hours | DONE |
| 13 | Phase 4.1: Server Deploy | Runs 24/7 | 2-3 hours | TODO |
| 14 | ~~Phase 4.2: Database~~ | ~~Enables dashboard~~ | — | DONE |
| 15 | Phase 4.3: Alerts | Know what's happening | 2-3 hours | TODO |
| 16 | Phase 4.4: Dashboard | Visualize everything | 4-6 hours | TODO |
| 17 | Phase 5.1: News Trading | Fastest edge capture | 4-6 hours | Partially replaced by News Sniper |

---

## Known Issues (2026-03-16)

| Issue | Status | Impact | Fix |
|-------|--------|--------|-----|
| Regular market orders fail ("not enough balance") | OPEN | Can't trade Musk tweets, Paris mayor, etc. | Investigate FUNDER_ADDRESS (see 3.2.1) |
| CLOB SDK `updateBalanceAllowance` broken | OPEN | Can't sync CLOB internal balance | Polymarket SDK bug — no fix available |
| Neg-risk markets work fine | OK | BTC, geopolitics, oil trades go through | No action needed |
| state.json totalInvested/realizedPnL inflated | MINOR | Display-only, doesn't affect trading | Recalculate from on-chain on next sync |

## Current Positions to Watch (2026-03-16)

These CONFIRMED events should resolve YES by March 31 — potential big recovery:

| Position | Shares | Entry | Status | Expected |
|----------|--------|-------|--------|----------|
| Kharg Island YES | 103 | $0.130 | CONFIRMED struck | Resolve YES → $103 payout |
| US invade Iran YES | 64 | $0.158 | CONFIRMED at war | Resolve YES → $64 payout |
| Israel Lebanon YES | 10 | $0.830 | CONFIRMED offensive | Resolve YES → $10 payout |
| Oil $100 YES | 5 | $0.877 | CONFIRMED hit $100 | Resolve YES → $5 payout |
| Iran ceasefire NO | 14 | $0.860 | STRONG no ceasefire | Resolve NO → $14 payout |
| BTC $75k NO | 133 | $0.146 | ACTIVE position | Depends on BTC price |
| Oil $120 YES | 21 | $0.443 | UNCERTAIN | Depends on oil price |
| Oil $110 YES | 5 | $0.604 | UNCERTAIN | Depends on oil price |

If Kharg + Iran + Lebanon + Oil$100 all resolve correctly: ~$182 payout on ~$30 invested = significant profit.

## Milestone Checkpoints

| Milestone | Criteria | Bankroll Action |
|-----------|----------|----------------|
| **M0: Fix Balance Bug** | Regular market trades work. FUNDER_ADDRESS issue resolved. | None |
| **M1: Stop Losing** | March positions resolve. Net P&L improves to >-10%. | Hold at $122 |
| **M2: Consistent Profits** | 60%+ win rate over 20 trades. Positive monthly return. | Deposit to $250 |
| **M3: Production Ready** | Phase 4 complete. Bot runs 24/7 on server with alerts. | Deposit to $500 |
| **M4: Scaling** | 3 consecutive profitable months. Win rate > 65%. | Consider $1000+ |

---

## How to Use This PRD

1. **New session?** Tell Claude: "Read PRD.md, STATUS.md, and ARCHITECTURE.md in `/polymarket-bot/`. Pick the next unchecked task and implement it."
2. **After completing a task:** Update the checkbox from `[ ]` to `[x]` and add a date.
3. **If priorities change:** Reorder the task list but don't delete completed tasks.
4. **After depositing $500:** Update the "Current State" section at the top.
