import dotenv from "dotenv";
dotenv.config();

// ---------------------------------------------------------------------------
// All bot configuration lives here. Values come from .env file.
// ---------------------------------------------------------------------------

export const config = {
  // Wallet & Auth
  privateKey: process.env.PRIVATE_KEY || "",
  funderAddress: process.env.FUNDER_ADDRESS || "",
  signatureType: parseInt(process.env.SIGNATURE_TYPE || "0") as 0 | 1,

  // API credentials (generated via setup-keys script)
  clobApiKey: process.env.CLOB_API_KEY || "",
  clobSecret: process.env.CLOB_SECRET || "",
  clobPassphrase: process.env.CLOB_PASSPHRASE || "",

  // Endpoints
  clobUrl: "https://clob.polymarket.com",
  gammaUrl: "https://gamma-api.polymarket.com",
  chainId: 137, // Polygon mainnet

  // AI (works with OpenAI or OpenRouter)
  openaiApiKey: process.env.OPENAI_API_KEY || "",
  openaiBaseUrl: process.env.OPENAI_BASE_URL || "",
  aiModel: process.env.AI_MODEL || "gpt-4o-mini",

  // Web Search
  tavilyApiKey: process.env.TAVILY_API_KEY || "",

  // Database
  supabaseUrl: process.env.SUPABASE_URL || "",
  supabaseKey: process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY || "",

  // Trading
  paperTrade: process.env.PAPER_TRADE !== "false", // default: true (safe)
  dailyLossLimit: parseFloat(process.env.DAILY_LOSS_LIMIT || "50"),
  maxTradeSize: parseFloat(process.env.MAX_TRADE_SIZE || "20"),
  minEdgePercent: parseFloat(process.env.MIN_EDGE_PERCENT || "5"),
  scanIntervalSeconds: parseInt(process.env.SCAN_INTERVAL_SECONDS || "30"),

  // Strategy toggles
  strategies: {
    arbitrage: process.env.STRATEGY_ARBITRAGE !== "false",
    mispricing: process.env.STRATEGY_MISPRICING !== "false",
    aiPrediction: process.env.STRATEGY_AI_PREDICTION !== "false",
    cryptoMomentum: process.env.STRATEGY_CRYPTO_MOMENTUM !== "false",
    btc5min: process.env.STRATEGY_BTC_5MIN !== "false",
    newsSniper: process.env.STRATEGY_NEWS_SNIPER !== "false",
  },

  // --- Capital Management ---
  // Stop opening NEW positions when cash drops below this (only manage existing)
  lowCashThreshold: parseFloat(process.env.LOW_CASH_THRESHOLD || "5"),
  // Max % of total assets (cash + positions) that can be deployed in positions
  maxDeployedPercent: parseFloat(process.env.MAX_DEPLOYED_PERCENT || "75") / 100,
  // Max new capital deployed per day as % of total assets
  maxDailyDeployPercent: parseFloat(process.env.MAX_DAILY_DEPLOY_PERCENT || "60") / 100,
  // Max distinct NEW markets per day (prevents overtrading)
  maxNewMarketsPerDay: parseInt(process.env.MAX_NEW_MARKETS_PER_DAY || "5"),

  // --- Correlation Limits ---
  // Max simultaneous BTC-related positions
  maxBtcPositions: parseInt(process.env.MAX_BTC_POSITIONS || "2"),
  // Max % of total assets in BTC positions
  maxBtcExposurePercent: parseFloat(process.env.MAX_BTC_EXPOSURE_PERCENT || "30") / 100,

  // --- Auto-Sell Safety ---
  // Max sell retry attempts before marking as "manual required"
  maxSellRetries: parseInt(process.env.MAX_SELL_RETRIES || "3"),
  // Cooldown between sell attempts on same position (minutes)
  sellCooldownMinutes: parseInt(process.env.SELL_COOLDOWN_MINUTES || "30"),

  // --- Portfolio Optimizer ---
  // Auto-sell contradictory and clearly losing positions on startup
  autoCleanup: process.env.AUTO_CLEANUP !== "false",
};

// Quick check that essentials are set
export function validateConfig(): string[] {
  const missing: string[] = [];
  if (!config.privateKey) missing.push("PRIVATE_KEY");
  if (config.strategies.aiPrediction && !config.openaiApiKey) {
    missing.push("OPENAI_API_KEY (needed for AI strategy)");
  }
  return missing;
}
