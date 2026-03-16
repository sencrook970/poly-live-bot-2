# Architecture -- How the Bot Works

This document explains every part of the bot. Use it as a reference when building a frontend dashboard or database integration.

## Overview

The bot runs in a loop: load state, sync with blockchain, scan markets, find opportunities, execute trades, auto-sell, save state, repeat.

```
Startup:
  [Load state.json] -> [Sync with Polymarket Data API] -> [Check USDC.e balance]

Every 30 seconds:
  [Check balance] -> [Run strategies] -> [Filter duplicates] -> [Execute trades]
       |                                                             |
       v                                                             v
  [Auto-sell check] <-------------- [Update prices] <--------- [Record trade]
       |
       v
  [Save state.json] -> [Print portfolio] -> [Wait 30s] -> [Repeat]
```

## Startup Flow

1. **Load state.json** -- Reads previous trades, positions, and dedup list from disk.
2. **Sync with on-chain** -- Calls Polymarket Data API (no auth needed) to get real positions. On-chain is the source of truth. If on-chain says 100 shares but state.json says 50, we trust on-chain.
3. **Portfolio Optimizer** -- Scans all on-chain positions for contradictions, near-certain losers, and BTC conflicts. Auto-sells bad positions to free up capital. Uses live CoinGecko BTC price for smart decisions.
4. **Check USDC.e balance** -- Reads your wallet's USDC.e balance directly from the Polygon blockchain. No restart needed when you deposit more money.

## How Orders Work

1. The bot finds an opportunity from a strategy.
2. Risk Manager checks: daily loss limit, max trade size, kill switch.
3. Kelly Criterion calculates how much to bet (quarter-Kelly for safety).
4. The CLOB SDK signs the order using your private key (EOA signature, type 0).
5. The signed order is posted to Polymarket's CLOB (Central Limit Order Book) as a GTC limit order.
6. The bot is both signer and maker. There is NO funder address -- leaving FUNDER_ADDRESS empty is required for MetaMask wallets.
7. Orders use USDC.e on Polygon (not native USDC).

## On-Chain Sync (sync.ts)

On every startup, the bot fetches your real positions from Polymarket's Data API:

- **Endpoint:** `https://data-api.polymarket.com/positions?user=<wallet>`
- **No auth needed** -- public endpoint, returns enriched data (title, prices, P&L).
- **Retries:** 3 attempts with 3-second delay between failures.
- **Merge rules:**
  - On-chain positions update local state (shares, price, P&L).
  - New on-chain positions get added to state.
  - Positions missing from on-chain (resolved/sold) get removed from state.
  - Trade history also synced from on-chain (deduped by tx hash).

## Persistent State (state.json)

All bot data is saved to `state.json` after every trade and every scan. The bot loads this file on startup so nothing is lost on restart.

What state.json stores:
- **trades[]** -- Append-only log of every trade (buy/sell, shares, price, cost, timestamp, tx hash).
- **positions{}** -- Current open positions, keyed by token ID (shares, avg price, cost, current price, unrealized P&L).
- **tradedMarketIds[]** -- List of market IDs we've already traded (used for deduplication).
- **totalInvested** -- Running total of USDC spent.
- **totalReturned** -- Running total of USDC received from sells and resolutions.
- **realizedPnL** -- Closed position profit/loss.
- **dailyStats** -- Today's trade count, spent amount, and P&L (resets daily).

## Balance Auto-Detection (balance.ts)

Every scan, the bot reads your USDC.e balance directly from the Polygon blockchain using viem:
- Calls the USDC.e contract's `balanceOf()` function.
- USDC.e address: `0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174`.
- RPC: `https://polygon-bor-rpc.publicnode.com` (free, public).
- If balance < $1.00, the bot scans but skips trading.
- When you deposit more USDC.e, the bot picks it up on the next scan automatically.

## Auto-Sell (auto-sell.ts)

Runs after every scan. Checks each position against profit/loss thresholds:

- **Take Profit:** Sell when position is up >= 20% from entry (configurable via TAKE_PROFIT_PERCENT).
- **Stop Loss:** Sell when position is down >= 50% from entry (configurable via STOP_LOSS_PERCENT).
- **Resolved markets:** If price hits 0 or 1 (market resolved), remove from portfolio and log realized P&L.
- Sells are placed as GTC limit orders slightly below current price for quick fill.

## Six Strategies

### 1. News Sniper (news-sniper.ts) — PRIMARY, ACTIVE
- **The main strategy.** Event-driven trading based on evidence classification.
- Scans markets, searches each with Tavily, classifies evidence with LLM.
- Four evidence levels: CONFIRMED (event happened), STRONG (multiple sources agree), WEAK (speculation), UNKNOWN.
- Only trades on CONFIRMED or STRONG evidence — everything else is skipped.
- CONFIRMED trades: minimum 10% edge, confidence boosted to 0.90 for larger Kelly size.
- STRONG trades: minimum 15% edge, confidence boosted to 0.75.
- Market prioritization: geopolitics > economics > elections > commodities > awards > corporate.
- 4-hour skip cache for WEAK/UNKNOWN markets (saves Tavily credits).
- Sanity check: LLM must cite a specific fact to claim CONFIRMED.
- All analyses logged to Supabase `ai_analyses` table.
- Trades recorded with strategy name "news_sniper" in DB.

### 2. Arbitrage (arbitrage.ts)
- Looks at multi-outcome events (e.g., "Who wins the election?" with 5+ candidates).
- If the sum of all YES prices < $1.00, buying all of them is guaranteed profit.
- Edge is usually 1-4% but nearly risk-free.
- Only BUY -- never sell what we don't own.
- Disabled by default (needs big bankroll to be worthwhile).

### 3. Mispricing (mispricing.ts)
- Looks at binary markets (Yes/No).
- If YES + NO < $1.00, buy both sides.
- You spend less than $1.00, one side pays $1.00. Guaranteed profit.
- Disabled by default (needs big bankroll).

### 4. AI Prediction (ai-predictor.ts) — DISABLED, replaced by News Sniper
- Old strategy. Sent market question + context to LLM.
- Problem: didn't distinguish between facts and speculation.
- Problem: spread too thin with $1-2 bets.
- Kept in codebase as fallback but disabled in .env.

### 5. Crypto Momentum (crypto-momentum.ts) — ACTIVE
- Fetches real-time BTC/ETH/SOL prices from CoinGecko (free, no API key).
- Only trades price target markets (e.g., "Will Bitcoin reach $150K?").
- Skips Up/Down daily markets (no edge from momentum).
- Uses distance-from-target math to estimate probability.
- Directional bet -- uses real price data as the signal.

### 6. BTC 5-Min (btc-5min.ts) — DISABLED
- Streams real-time BTC price from Binance WebSocket (sub-second latency).
- Targets Polymarket's 5-minute BTC Up/Down markets.
- Disabled because these markets don't currently exist on Polymarket.

## Position Sizing

Kelly Criterion (divided by 4 for safety):

```
Edge = (Your probability estimate) - (Market price)
Full Kelly = Edge / (1 - Market price)
Quarter Kelly = Full Kelly / 4
Bet size = Quarter Kelly x Bankroll
```

For arbitrage (near-certain), sizing is more aggressive (up to 50% of bankroll, capped by MAX_TRADE_SIZE).

Minimum order: $1 (Polymarket enforces this).

## Safety Features

1. **Paper trade mode** -- default ON. No real money until you set PAPER_TRADE=false.
2. **Portfolio deduplication** -- won't re-buy markets you already hold (unless edge > 15%).
3. **Daily loss limit** -- stops trading if losses exceed your limit.
4. **Max trade size** -- caps any single trade.
5. **Min edge filter** -- only trades when edge > your threshold.
6. **Kill switch** -- emergency stop in RiskManager.
7. **Max 3 trades per scan** -- prevents overtrading.
8. **Low-cash mode** -- below $5 cash, stops new trades. Only manages existing positions.
9. **Daily capital cap** -- max 60% of total assets deployed per day. Resets at midnight.
10. **Max deployed %** -- keeps 25% cash reserve. Never deploys more than 75% of assets.
11. **BTC correlation limit** -- max 2 BTC positions, max 30% of assets in BTC.
12. **Max new markets/day** -- max 5 distinct new markets per day.
13. **Auto-sell verification** -- verifies on-chain shares before selling. Retry with cooldown.
14. **Portfolio optimizer** -- auto-sells contradictory and losing positions on startup.

## File Map

### Root

| File | What it does |
|------|-------------|
| `state.json` | Persistent bot state (trades, positions, dedup list). Auto-created. |
| `.env` | All secrets and config. Never commit this. |
| `package.json` | Dependencies and npm scripts. |
| `tsconfig.json` | TypeScript config. |
| `ARCHITECTURE.md` | This file. |
| `STATUS.md` | Current status, portfolio, lessons learned. |
| `README.md` | Quick start guide and commands. |

### src/ (Core)

| File | What it does |
|------|-------------|
| `src/index.ts` | Main loop v2. Startup, optimize, scan, trade, auto-sell, repeat. |
| `src/config.ts` | All settings including capital management, BTC limits, auto-sell config. |
| `src/client.ts` | Creates authenticated Polymarket CLOB client using viem wallet. |
| `src/state.ts` | Persistent state management (load/save state.json, record trades, track positions). |
| `src/sync.ts` | On-chain sync + verified share lookup for auto-sell. Source of truth. |
| `src/balance.ts` | Reads USDC.e balance from Polygon blockchain every scan. |
| `src/portfolio-optimizer.ts` | **NEW** Auto-sells bad positions on startup. BTC contradiction detection. |

### src/strategies/

| File | What it does |
|------|-------------|
| `src/strategies/types.ts` | Strategy interface (name + findOpportunities method). |
| `src/strategies/news-sniper.ts` | **PRIMARY** — Evidence-based trading with CONFIRMED/STRONG classification. |
| `src/strategies/arbitrage.ts` | Multi-outcome arbitrage (sum of YES prices < $1). Disabled. |
| `src/strategies/mispricing.ts` | Binary market mispricing (YES + NO < $1). Disabled. |
| `src/strategies/ai-predictor.ts` | Old LLM prediction. Disabled, replaced by News Sniper. |
| `src/strategies/crypto-momentum.ts` | BTC/ETH/SOL price targets from CoinGecko prices. Active. |
| `src/strategies/btc-5min.ts` | Real-time BTC price from Binance WebSocket. Disabled. |

### src/execution/

| File | What it does |
|------|-------------|
| `src/execution/order-manager.ts` | Turns opportunities into orders. Kelly sizing, risk checks, paper/live execution. |
| `src/execution/auto-sell.ts` | **v2** Take profit/stop loss with on-chain verification, retry tracking, cooldown. |
| `src/execution/position.ts` | In-memory position tracker (used alongside state.json). |

### src/markets/

| File | What it does |
|------|-------------|
| `src/markets/scanner.ts` | Fetches live markets from Polymarket's Gamma API. |
| `src/markets/analyzer.ts` | Detects opportunities (mispricing, arbitrage). Ranks them by edge. |

### src/risk/

| File | What it does |
|------|-------------|
| `src/risk/kelly.ts` | Kelly Criterion -- calculates how much to bet based on edge. |
| `src/risk/risk-manager.ts` | **v2** Daily caps, BTC limits, low-cash mode, deployed %, max markets/day. |

### src/utils/

| File | What it does |
|------|-------------|
| `src/utils/logger.ts` | Color-coded console logging (info, warn, error, trade, paper, etc.). |

### src/scripts/

| File | What it does |
|------|-------------|
| `src/scripts/setup-keys.ts` | Generate Polymarket API keys from your wallet. |
| `src/scripts/scan-markets.ts` | Read-only market scanner (no trading). |
| `src/scripts/check-positions.ts` | Check current positions via CLOB API. |
| `src/scripts/sell-all.ts` | Emergency sell all positions. |
| `src/scripts/set-allowance.ts` | Set token approvals for CTF Exchange (one-time). |
| `src/scripts/test-order.ts` | Test order signing (v1). |
| `src/scripts/test-order-v2.ts` | Test order signing (v2). |

## Wallet and Network

- **Network:** Polygon Mainnet (chain ID 137)
- **Wallet:** MetaMask EOA (NOT email/Magic wallet -- those don't work with the CLOB API)
- **EOA address:** `0xBBF2DFc8ACC5021292dD039abC80E8429C9A3B5F`
- **Signature type:** 0 (EOA)
- **Funder address:** EMPTY (required for MetaMask wallets)
- **Currency:** USDC.e on Polygon (`0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174`)
- **Wallet library:** viem (SDK requires it, not ethers.js)
- **Auth:** Your private key derives API credentials (key/secret/passphrase) deterministically.

## APIs Used

| API | What for | Auth needed? |
|-----|----------|-------------|
| Polymarket CLOB API | Place/cancel orders, get tick sizes | Yes (API key/secret/passphrase) |
| Polymarket Gamma API | Fetch active markets, prices, metadata | No |
| Polymarket Data API | Fetch on-chain positions, trade history | No |
| CoinGecko API | Real-time BTC/ETH/SOL prices | No |
| Binance WebSocket | Real-time BTC price stream | No |
| OpenRouter API | LLM predictions (AI strategy) | Yes (API key) |
| Polygon RPC | Read USDC.e balance on-chain | No |

## For Future Dashboard/Database Integration

Key data points available in state.json that a dashboard could display:
- All trade history with timestamps, prices, and tx hashes
- Current open positions with real-time P&L
- Realized vs unrealized profit/loss
- Daily trade counts and spending
- Which markets have been traded (dedup list)

To add database support, replace the `loadState()`/`saveState()` functions in `src/state.ts` with database read/write calls. The `BotState` interface defines the exact schema.
