import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { config } from "./config";
import { log } from "./utils/logger";

// ---------------------------------------------------------------------------
// Database Layer — all Supabase operations with full logging.
// Every DB write is logged so we can verify data is flowing correctly.
// ---------------------------------------------------------------------------

let supabase: SupabaseClient | null = null;

export function getDb(): SupabaseClient | null {
  if (supabase) return supabase;

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY;

  if (!url || !key) {
    log.warn("[DB] No Supabase credentials. Running without database.");
    return null;
  }

  supabase = createClient(url, key);
  log.success("[DB] Connected to Supabase");
  return supabase;
}

// ---- WALLET ----

export async function ensureWallet(address: string): Promise<string | null> {
  const db = getDb();
  if (!db) return null;

  const { data, error } = await db
    .from("wallets")
    .upsert(
      { platform_id: "polymarket", address, label: "main", signature_type: 0 },
      { onConflict: "platform_id,address" }
    )
    .select("id")
    .single();

  if (error) {
    log.error(`[DB] ensureWallet failed: ${error.message}`);
    return null;
  }
  return data.id;
}

// ---- ORDERS ----

export interface OrderRecord {
  walletId: string;
  marketId: string;
  question: string;
  description?: string;
  category?: string;
  outcomes?: string[];
  tokenIds?: string[];
  endDate?: string;
  side: "BUY" | "SELL";
  outcome: string;
  tokenId: string;
  shares: number;
  price: number;
  totalAmount: number;
  strategy: string;
  orderReason: string;
  edgePercent?: number;
  confidence?: number;
  reasoning?: string;
  searchContext?: string;
  status: string;
  exchangeOrderId?: string;
  txHash?: string;
  errorMessage?: string;
}

export async function recordOrder(order: OrderRecord): Promise<string | null> {
  const db = getDb();
  if (!db) return null;

  // Upsert market first
  const { error: marketErr } = await db.from("markets").upsert(
    {
      id: order.marketId,
      platform_id: "polymarket",
      question: order.question,
      description: order.description,
      category: order.category,
      outcomes: order.outcomes,
      token_ids: order.tokenIds,
      end_date: order.endDate,
      last_updated_at: new Date().toISOString(),
    },
    { onConflict: "id" }
  );
  if (marketErr) log.warn(`[DB] Market upsert warning: ${marketErr.message}`);

  // Insert order
  const { data, error } = await db
    .from("orders")
    .insert({
      wallet_id: order.walletId,
      market_id: order.marketId,
      platform_id: "polymarket",
      side: order.side,
      outcome: order.outcome,
      token_id: order.tokenId,
      shares: order.shares,
      price: order.price,
      total_amount: order.totalAmount,
      strategy: order.strategy,
      order_reason: order.orderReason,
      edge_percent: order.edgePercent,
      confidence: order.confidence,
      reasoning: order.reasoning,
      search_context: order.searchContext,
      status: order.status,
      exchange_order_id: order.exchangeOrderId,
      tx_hash: order.txHash,
      error_message: order.errorMessage,
      filled_at: ["filled", "matched"].includes(order.status)
        ? new Date().toISOString()
        : null,
    })
    .select("id")
    .single();

  if (error) {
    log.error(`[DB] recordOrder FAILED: ${error.message}`);
    return null;
  }

  log.success(`[DB] Order recorded: ${order.side} ${order.shares} ${order.outcome} @ $${order.price.toFixed(3)} [${order.status}]`);

  // If order filled, update position
  if (["filled", "matched", "delayed", "live"].includes(order.status)) {
    await upsertPosition(order);
  }

  return data.id;
}

// ---- POSITIONS ----

async function upsertPosition(order: OrderRecord): Promise<void> {
  const db = getDb();
  if (!db) return;

  if (order.side === "BUY") {
    const { data: existing } = await db
      .from("positions")
      .select("*")
      .eq("wallet_id", order.walletId)
      .eq("token_id", order.tokenId)
      .single();

    if (existing) {
      const newShares = existing.total_shares + order.shares;
      const newCost = existing.total_cost + order.totalAmount;
      const newAvg = newCost / newShares;

      const { error } = await db
        .from("positions")
        .update({
          total_shares: newShares,
          avg_price: newAvg,
          total_cost: newCost,
          current_price: order.price,
          current_value: newShares * order.price,
          unrealized_pnl: (order.price - newAvg) * newShares,
        })
        .eq("id", existing.id);

      if (error) log.error(`[DB] Position update FAILED: ${error.message}`);
      else log.info(`[DB] Position updated: ${order.outcome} "${order.question?.substring(0, 40)}..." → ${newShares} shares`);
    } else {
      const { error } = await db.from("positions").insert({
        wallet_id: order.walletId,
        market_id: order.marketId,
        platform_id: "polymarket",
        token_id: order.tokenId,
        outcome: order.outcome,
        total_shares: order.shares,
        avg_price: order.price,
        total_cost: order.totalAmount,
        current_price: order.price,
        current_value: order.shares * order.price,
        unrealized_pnl: 0,
      });

      if (error) log.error(`[DB] Position insert FAILED: ${error.message}`);
      else log.info(`[DB] Position created: ${order.outcome} "${order.question?.substring(0, 40)}..." — ${order.shares} shares`);
    }
  }

  if (order.side === "SELL") {
    const { data: existing } = await db
      .from("positions")
      .select("*")
      .eq("wallet_id", order.walletId)
      .eq("token_id", order.tokenId)
      .single();

    if (existing) {
      const newShares = existing.total_shares - order.shares;
      if (newShares <= 0) {
        const realized = order.totalAmount - existing.total_cost;
        const { error } = await db
          .from("positions")
          .update({
            total_shares: 0,
            status: "closed",
            closed_at: new Date().toISOString(),
            close_reason: order.orderReason,
            total_received: order.totalAmount,
            realized_pnl: realized,
          })
          .eq("id", existing.id);

        if (error) log.error(`[DB] Position close FAILED: ${error.message}`);
        else log.success(`[DB] Position CLOSED: "${order.question?.substring(0, 40)}..." P&L: $${realized.toFixed(2)}`);
      } else {
        const soldCost = (existing.total_cost / existing.total_shares) * order.shares;
        const { error } = await db
          .from("positions")
          .update({
            total_shares: newShares,
            total_cost: existing.total_cost - soldCost,
            total_received: (existing.total_received || 0) + order.totalAmount,
          })
          .eq("id", existing.id);

        if (error) log.error(`[DB] Partial sell FAILED: ${error.message}`);
        else log.info(`[DB] Partial sell: "${order.question?.substring(0, 40)}..." — ${newShares} shares remaining`);
      }
    }
  }
}

// ---- WALLET ACTIVITY ----

export async function recordDeposit(
  walletId: string,
  amount: number,
  txHash?: string
): Promise<void> {
  const db = getDb();
  if (!db) return;

  const { error } = await db.from("wallet_activity").insert({
    wallet_id: walletId,
    type: "deposit",
    amount,
    token: "USDC.e",
    tx_hash: txHash,
    notes: `Deposited $${amount.toFixed(2)} USDC.e`,
  });

  if (error) log.error(`[DB] Deposit record FAILED: ${error.message}`);
  else log.success(`[DB] Deposit recorded: $${amount.toFixed(2)}`);
}

// ---- SCANS ----

export async function recordScan(scan: {
  walletId: string;
  scanNumber: number;
  durationMs: number;
  marketsScanned: number;
  opportunitiesFound: number;
  opportunitiesNew: number;
  ordersPlaced: number;
  ordersFilled: number;
  ordersFailed: number;
  usdcBalance: number;
  portfolioValue: number;
  unrealizedPnl: number;
  positionsCount: number;
  strategiesRun: string[];
}): Promise<void> {
  const db = getDb();
  if (!db) return;

  const { error } = await db.from("scans").insert({
    wallet_id: scan.walletId,
    scan_number: scan.scanNumber,
    duration_ms: scan.durationMs,
    markets_scanned: scan.marketsScanned,
    opportunities_found: scan.opportunitiesFound,
    opportunities_new: scan.opportunitiesNew,
    orders_placed: scan.ordersPlaced,
    orders_filled: scan.ordersFilled,
    orders_failed: scan.ordersFailed,
    usdc_balance: scan.usdcBalance,
    portfolio_value: scan.portfolioValue,
    total_unrealized_pnl: scan.unrealizedPnl,
    positions_count: scan.positionsCount,
    strategies_run: scan.strategiesRun,
  });

  if (error) log.error(`[DB] Scan record FAILED: ${error.message}`);
}

// ---- AI ANALYSIS ----

export async function recordAnalysis(analysis: {
  marketId: string;
  walletId: string;
  model: string;
  aiProbability: number;
  marketProbability: number;
  edgePercent: number;
  confidence: number;
  reasoning: string;
  searchQuery?: string;
  searchResults?: string;
  searchSource?: string;
  decision: string;
  marketQuestion?: string;
}): Promise<void> {
  const db = getDb();
  if (!db) return;

  // Ensure market exists first (foreign key requirement)
  await db.from("markets").upsert(
    {
      id: analysis.marketId,
      platform_id: "polymarket",
      question: analysis.marketQuestion || "Unknown",
      last_updated_at: new Date().toISOString(),
    },
    { onConflict: "id" }
  );

  const { error } = await db.from("ai_analyses").insert({
    market_id: analysis.marketId,
    wallet_id: analysis.walletId,
    model: analysis.model,
    ai_probability: analysis.aiProbability,
    market_probability: analysis.marketProbability,
    edge_percent: analysis.edgePercent,
    confidence: analysis.confidence,
    reasoning: analysis.reasoning,
    search_query: analysis.searchQuery,
    search_results: analysis.searchResults,
    search_source: analysis.searchSource,
    decision: analysis.decision,
  });

  if (error) log.error(`[DB] AI analysis record FAILED: ${error.message}`);
  else log.info(`[DB] AI analysis: ${analysis.decision} — edge ${analysis.edgePercent.toFixed(1)}%`);
}

// ---- DAILY SNAPSHOT ----

export async function takeDailySnapshot(
  walletId: string,
  data: {
    usdcBalance: number;
    portfolioValue: number;
    totalDeposited: number;
    unrealizedPnl: number;
    realizedPnl: number;
    tradesCount: number;
  }
): Promise<void> {
  const db = getDb();
  if (!db) return;

  const today = new Date().toISOString().split("T")[0];

  const { error } = await db.from("daily_snapshots").upsert(
    {
      wallet_id: walletId,
      date: today,
      usdc_balance: data.usdcBalance,
      portfolio_value: data.portfolioValue,
      total_assets: data.usdcBalance + data.portfolioValue,
      total_deposited: data.totalDeposited,
      unrealized_pnl: data.unrealizedPnl,
      realized_pnl: data.realizedPnl,
      net_pnl: data.usdcBalance + data.portfolioValue - data.totalDeposited,
      trades_count: data.tradesCount,
    },
    { onConflict: "wallet_id,date" }
  );

  if (error) log.error(`[DB] Snapshot FAILED: ${error.message}`);
  else log.info(`[DB] Snapshot saved: assets=$${(data.usdcBalance + data.portfolioValue).toFixed(2)}`);
}
