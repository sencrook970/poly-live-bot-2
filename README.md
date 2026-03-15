# Polymarket Trading Bot

A bot that finds and trades opportunities on [Polymarket](https://polymarket.com) -- a prediction market where you bet on real-world events.

## What This Bot Does

It scans hundreds of live markets every 30 seconds using 5 strategies:

1. **Arbitrage** -- Buy all outcomes in a multi-outcome event when their total price is under $1.00 (guaranteed profit).
2. **Mispricing** -- Buy both YES and NO in a binary market when they cost less than $1.00 combined.
3. **AI Prediction** -- Uses an LLM (via OpenRouter) to estimate the true probability. Trades when the market price is wrong by more than 3%.
4. **Crypto Momentum** -- Fetches real-time BTC/ETH/SOL prices from CoinGecko and trades crypto markets when momentum doesn't match market prices.
5. **BTC 5-Min** -- Streams live BTC price from Binance WebSocket to trade short-duration Up/Down markets.

The bot also auto-sells positions when they hit take-profit (+20%) or stop-loss (-50%) thresholds.

## Quick Start

### Step 1: Install

```bash
cd polymarket-bot
npm install
```

### Step 2: Set Up Your .env File

```bash
cp .env.example .env
```

Fill in these values at minimum:

| Variable | What it is | How to get it |
|----------|-----------|---------------|
| `PRIVATE_KEY` | Your MetaMask wallet's private key | MetaMask > Settings > Security > Export Private Key |
| `OPENAI_API_KEY` | OpenRouter API key | openrouter.ai/keys |

Leave `FUNDER_ADDRESS` empty. This is required for MetaMask wallets.

### Step 3: Generate API Keys

```bash
npm run setup-keys
```

Copy the three values (CLOB_API_KEY, CLOB_SECRET, CLOB_PASSPHRASE) into your `.env` file.

### Step 4: Set Token Approvals (one-time)

```bash
npx tsx src/scripts/set-allowance.ts
```

This approves the Polymarket exchange contracts to spend your USDC.e. Costs ~$0.10 in POL gas.

### Step 5: Scan Markets (read-only, no money needed)

```bash
npm run scan
```

### Step 6: Run in Paper Trade Mode

```bash
npm run paper
```

The bot scans and "trades" but doesn't spend real money. Use this to see how strategies perform.

### Step 7: Go Live

Set `PAPER_TRADE=false` in your `.env`, then:

```bash
npx tsx src/index.ts
```

## All Commands

| Command | What it does |
|---------|-------------|
| `npx tsx src/index.ts` | Run the bot (uses .env settings for live/paper mode) |
| `npm run paper` | Run in paper trade mode (no real money) |
| `npm run scan` | Scan markets and show opportunities (read-only) |
| `npm run sell-all` | Sell ALL positions immediately |
| `npm run positions` | Check current positions via CLOB API |
| `npm run setup-keys` | Generate Polymarket API keys |
| `npx tsx src/scripts/set-allowance.ts` | Set token approvals (one-time) |
| `npx tsx src/scripts/test-order.ts` | Test order signing |
| `npx tsx src/scripts/test-order-v2.ts` | Test order signing (v2) |
| `npm run build` | Compile TypeScript to JavaScript |
| `npm run start` | Run compiled JavaScript (after build) |
| `npm run dev` | Run with tsx (same as npx tsx src/index.ts) |

## Settings

All settings are in the `.env` file:

| Setting | Default | What it controls |
|---------|---------|-----------------|
| `PAPER_TRADE` | `true` | Safe mode -- no real money used |
| `DAILY_LOSS_LIMIT` | `50` | Stop trading if you lose this much in a day (USDC) |
| `MAX_TRADE_SIZE` | `20` | Maximum amount for a single trade (USDC) |
| `MIN_EDGE_PERCENT` | `5` | Only trade when the edge is at least this percentage |
| `SCAN_INTERVAL_SECONDS` | `30` | How often to scan for new opportunities |
| `STRATEGY_ARBITRAGE` | `true` | Enable/disable arbitrage strategy |
| `STRATEGY_MISPRICING` | `true` | Enable/disable mispricing strategy |
| `STRATEGY_AI_PREDICTION` | `true` | Enable/disable AI prediction strategy |
| `STRATEGY_CRYPTO_MOMENTUM` | `true` | Enable/disable crypto momentum strategy |
| `STRATEGY_BTC_5MIN` | `true` | Enable/disable BTC 5-minute strategy |
| `TAKE_PROFIT_PERCENT` | `20` | Sell when a position is up this much (%) |
| `STOP_LOSS_PERCENT` | `50` | Sell when a position is down this much (%) |

## What You Need to Trade

- **USDC.e on Polygon** -- not native USDC. Swap on Uniswap if needed.
- **A small amount of POL** -- for gas on token approval transactions (~$0.10).
- **MetaMask wallet** -- email/Google login wallets do NOT work with the trading API.

### How Much to Start With

- **Minimum:** $20 USDC.e (enough for a few small trades)
- **Recommended:** $200+ USDC.e (enough for proper diversification with Kelly sizing)
- Default max trade size is $5 (configurable)

## Important Warnings

- **Start with paper trading.** Always test before using real money.
- **No bot guarantees profit.** Markets are competitive.
- **AI predictions can be wrong.** The AI strategy makes directional bets that can lose money.
- **The AI has no sports data.** It guesses on sports markets. Don't rely on it for live games.
- **Never share your private key.** Keep your `.env` file secret.
- **Polymarket is blocked in the US** and some other countries.

## Project Structure

See [ARCHITECTURE.md](./ARCHITECTURE.md) for how every file works, how orders are signed, and how the main loop runs.

See [STATUS.md](./STATUS.md) for current portfolio, P&L, lessons learned, and known issues.
