# Polymarket Bot — Current Status

Last updated: 2026-03-15 (News Sniper strategy built)

## Quick Start (for new Claude session)

> "I have a Polymarket trading bot in `/polymarket-bot/`. Read `STATUS.md`, `PRD.md`, and `ARCHITECTURE.md` to understand the full context. The bot runs the News Sniper strategy — event-driven concentrated bets on markets where outcomes are already known from news. Run with `npx tsx src/index.ts`."

## Current State: NEWS SNIPER STRATEGY LIVE

Fresh start with new strategy. No active positions.

| Metric | Value |
|--------|-------|
| USDC.e cash | ~$60 |
| Positions | 0 |
| Total deposited | ~$60 |
| Active strategy | **News Sniper** (event-driven, evidence-based) |
| Old AI Predictor | Disabled (replaced by News Sniper) |
| Crypto Momentum | Still enabled (price target markets) |

## What Changed (News Sniper)

### Old strategy (AI Predictor) — WHY IT LOST MONEY
- Spread $1-2 across 10+ random markets per session
- AI guessed probabilities from question text + search
- No distinction between "confirmed fact" and "speculation"
- Sports bets, wrong-direction crypto, too many tiny bets

### New strategy (News Sniper) — HOW IT MAKES MONEY
- **Evidence classification**: every market analyzed as CONFIRMED / STRONG / WEAK / UNKNOWN
- **Only trades on facts**: CONFIRMED = event already happened, STRONG = multiple sources agree
- **Concentrated bets**: 2-3 trades at $5-15 each instead of 10 trades at $1-2 each
- **Smart prioritization**: geopolitics, economics, policy markets scored highest
- **Skip cache**: markets classified as WEAK/UNKNOWN are skipped for 4 hours (saves Tavily credits)
- **Sanity checks**: LLM can't claim CONFIRMED without citing a specific fact

### Example trades the News Sniper would make:
- "Will X tariff be imposed?" → Search finds official announcement → CONFIRMED → bet $12
- "Will candidate X win primary?" → 3 polls show 65%+ → STRONG → bet $5
- "Will stock Y hit $Z?" → No specific data → WEAK → SKIP (cached 4h)

## What We Built (total, 3 days of work)

### News Sniper Strategy (`src/strategies/news-sniper.ts`) — NEW
- Evidence classification (CONFIRMED/STRONG/WEAK/UNKNOWN)
- Smart market prioritization by category
- Concentrated Kelly sizing with confidence boosts
- 4-hour skip cache for WEAK/UNKNOWN markets
- Extended sports filter (more patterns)
- All analyses logged to Supabase

### General Bot Infrastructure (unchanged, still works)
- Supabase database (12 tables, full trade history)
- On-chain sync via Polymarket Data API
- Auto-sell (take profit 20% / stop loss 50%)
- Position conflict detection (don't bet both sides)
- Correlation limits (max 3 per topic group)
- Search result caching (saves Tavily credits)
- Balance auto-detection
- Kelly Criterion position sizing (quarter-Kelly)

### Crypto Momentum (still enabled)
- BTC/ETH/SOL price target markets only
- Uses CoinGecko for real prices vs market targets

### Scripts
- `npm run portfolio` — check total value anytime
- `npm run sell-all` — emergency close everything
- `npm run scan` — read-only market scan

## Settings (current .env)

| Setting | Value | Why |
|---------|-------|-----|
| MAX_TRADE_SIZE | $15 | 25% of $60 bankroll for concentrated bets |
| MIN_EDGE_PERCENT | 10% | Floor for all strategies |
| SCAN_INTERVAL | 90s | Balance between speed and Tavily credit usage |
| TAKE_PROFIT | 20% | Auto-sell when up 20% |
| STOP_LOSS | 50% | Auto-sell when down 50% |
| PAPER_TRADE | false | Live trading |

## Wallet Setup (DON'T CHANGE)

| Item | Value |
|------|-------|
| EOA | `0xBBF2DFc8ACC5021292dD039abC80E8429C9A3B5F` |
| Signature type | `0` (EOA) |
| Funder address | EMPTY |
| USDC type | USDC.e on Polygon |
| Token approvals | Done |

## Lessons from Previous Session (applied to News Sniper)

1. **Only trade on HARD EVIDENCE** → News Sniper classifies evidence before trading
2. **Skip all sports/esports** → Extended filter with more patterns
3. **Don't bet both sides** → Conflict detection still active
4. **Concentrate capital** → $5-15 per trade instead of $1-2
5. **Don't bet crypto up/down** → Filtered out, only price targets remain
6. **Need cited facts, not speculation** → LLM must cite specific facts or gets downgraded to WEAK

## Deposit Recommendation

**DO NOT deposit $500 yet.** Run News Sniper with $60 for 3-5 days first. Criteria to deposit more:
- [ ] 5+ trades completed
- [ ] Positive P&L (any amount)
- [ ] Win rate > 50%
- [ ] No catastrophic single-trade losses
- [ ] CONFIRMED trades actually resolve correctly

## APIs & Keys in .env

| Key | Purpose |
|-----|---------|
| PRIVATE_KEY | MetaMask wallet (EOA) |
| CLOB_API_KEY/SECRET/PASSPHRASE | Polymarket trading API |
| OPENAI_API_KEY + BASE_URL | OpenRouter for AI (Gemini 2.5 Flash) |
| TAVILY_API_KEY | Web search (1000 free credits/month) |
| SUPABASE_URL + SERVICE_KEY | Database |

## Files That Matter

| File | Purpose |
|------|---------|
| `PRD.md` | Full improvement plan with checkboxes |
| `ARCHITECTURE.md` | How every file works |
| `STATUS.md` | This file — current state |
| `state.json` | Persistent bot state |
| `.env` | All secrets + settings |
| `src/index.ts` | Main loop |
| `src/strategies/news-sniper.ts` | **News Sniper strategy (PRIMARY)** |
| `src/strategies/crypto-momentum.ts` | Crypto price target strategy |
| `src/db.ts` | Supabase database layer |
| `src/search.ts` | Tavily web search with caching |
| `src/sync.ts` | On-chain position sync |
