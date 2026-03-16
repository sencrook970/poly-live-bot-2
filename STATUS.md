# Polymarket Bot — Current Status

Last updated: 2026-03-16

## Quick Start (for new Claude session)

> "I have a Polymarket trading bot in `/polymarket-bot/`. Read `STATUS.md`, `PRD.md`, and `ARCHITECTURE.md`. The bot runs News Sniper + Crypto Momentum with capital management v2 (daily caps, BTC limits, low-cash mode, portfolio optimizer). Run with `npx tsx src/index.ts`."

## Current State: v2 WITH CAPITAL MANAGEMENT

| Metric | Value |
|--------|-------|
| Total deposited | ~$122 |
| Total assets | ~$106 (cash + positions) |
| USDC.e cash | ~$1 |
| Open positions | ~$105 |
| Net P&L | ~-$16 (-13.1%) |
| Active strategies | **News Sniper + Bond Mode** (Crypto Momentum DISABLED — 3.15% fees) |

## What's New in v2 (2026-03-16)

### Problem: Bot overtraded and burned through all cash
- 43 trades / $209 spent in one day on $120 bankroll
- Cash dropped to $1.06 — can't open new trades or execute auto-sells
- Contradictory BTC positions (>$76k YES + >$70k NO)
- Auto-sell failed with "not enough balance" errors

### Fix: 6 major improvements

1. **Portfolio Optimizer** (`portfolio-optimizer.ts`) — NEW
   - Cancels all open/pending orders on startup (frees locked USDC.e)
   - Cleans resolved markets from state (doesn't try to sell via dead orderbook)
   - Auto-sells contradictory/losing positions
   - Detects BTC contradictions using live CoinGecko price
   - Frees up capital trapped in bad positions

2. **Daily Capital Cap** — NEW
   - Max 60% of total assets deployed per day (prevents burning all cash)
   - Max 5 new markets per day (prevents overtrading)
   - Resets at midnight

3. **Low-Cash Mode** — NEW
   - Below $5 cash: stops opening new positions
   - Only manages existing positions (auto-sell still works)
   - Prevents the bot from getting stuck with $0 cash

4. **BTC Correlation Limits** — NEW
   - Max 2 simultaneous BTC positions
   - Max 30% of assets in BTC exposure
   - Prevents contradictory BTC bets

5. **Auto-Sell with Verification** — IMPROVED
   - Verifies actual on-chain shares before selling (no more "not enough balance")
   - Retry tracking: max 3 attempts per position
   - 30-minute cooldown between retries
   - Marks as "manual required" after too many failures

6. **Max Deployed Capital** — NEW
   - Max 75% of total assets can be in positions
   - Always keeps 25% cash reserve
   - Prevents the $1.06 cash situation

## Settings (current .env + new defaults)

| Setting | Value | Source |
|---------|-------|--------|
| MAX_TRADE_SIZE | $15 | .env |
| MIN_EDGE_PERCENT | 10% | .env |
| SCAN_INTERVAL | 90s | .env |
| LOW_CASH_THRESHOLD | $5 | default |
| MAX_DEPLOYED_PERCENT | 75% | default |
| MAX_DAILY_DEPLOY_PERCENT | 60% | default |
| MAX_NEW_MARKETS_PER_DAY | 5 | default |
| MAX_BTC_POSITIONS | 2 | default |
| MAX_BTC_EXPOSURE_PERCENT | 30% | default |
| MAX_SELL_RETRIES | 3 | default |
| SELL_COOLDOWN_MINUTES | 30 | default |
| AUTO_CLEANUP | true | default |
| TAKE_PROFIT | 20% | .env |
| STOP_LOSS | 50% | .env |

## Wallet Setup (DON'T CHANGE)

| Item | Value |
|------|-------|
| EOA | `0xBBF2DFc8ACC5021292dD039abC80E8429C9A3B5F` |
| Signature type | `0` (EOA) |
| Funder address | `0xBBF2DFc8ACC5021292dD039abC80E8429C9A3B5F` |
| USDC type | USDC.e on Polygon |

## Deposit Recommendation

**DO NOT deposit more yet.** Wait for v2 to prove itself:
- [ ] Portfolio optimizer sells bad positions and frees cash
- [ ] Bot makes 5+ profitable trades with new capital limits
- [ ] Daily capital cap prevents overtrading
- [ ] Auto-sell successfully takes profits

## Files That Matter

| File | Purpose |
|------|---------|
| `STATUS.md` | This file |
| `PRD.md` | Full improvement plan |
| `ARCHITECTURE.md` | How every file works |
| `src/index.ts` | Main loop (v2 with capital management) |
| `src/strategies/news-sniper.ts` | Primary strategy |
| `src/portfolio-optimizer.ts` | Auto-sell bad positions on startup |
| `src/risk/risk-manager.ts` | v2 with daily caps, BTC limits |
| `src/execution/auto-sell.ts` | v2 with share verification, retries |
| `src/config.ts` | All settings including new capital management |
