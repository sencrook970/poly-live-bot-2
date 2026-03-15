import axios from "axios";
import { config } from "../config";
import { log } from "../utils/logger";

// ---------------------------------------------------------------------------
// Market Scanner — fetches all active markets from Polymarket's Gamma API
// and organizes them for the strategies to analyze.
// ---------------------------------------------------------------------------

// What a market looks like (simplified from the full API response)
export interface Market {
  id: string;
  question: string;
  slug: string;
  outcomes: string[];
  outcomePrices: number[];
  clobTokenIds: string[];
  volume: number;
  volume24hr: number;
  liquidity: number;
  bestBid: number;
  bestAsk: number;
  spread: number;
  active: boolean;
  closed: boolean;
  negRisk: boolean;
  negRiskMarketID: string;
  tickSize: number;
  endDate: string;
  description: string;
  tags: string[];
  eventId: string;
  eventTitle: string;
}

// What an event looks like (groups multiple markets together)
export interface Event {
  id: string;
  title: string;
  slug: string;
  markets: Market[];
  negRisk: boolean;
  volume: number;
  liquidity: number;
  tags: string[];
}

// Parse a raw API market into our clean Market type
function parseMarket(raw: Record<string, unknown>): Market {
  const outcomes = JSON.parse((raw.outcomes as string) || '["Yes","No"]');
  const prices = JSON.parse((raw.outcomePrices as string) || "[0,0]").map(Number);
  const tokenIds = JSON.parse((raw.clobTokenIds as string) || '["",""]');

  return {
    id: raw.id as string,
    question: raw.question as string,
    slug: raw.slug as string,
    outcomes,
    outcomePrices: prices,
    clobTokenIds: tokenIds,
    volume: parseFloat((raw.volume as string) || "0"),
    volume24hr: (raw.volume24hr as number) || 0,
    liquidity: parseFloat((raw.liquidity as string) || "0"),
    bestBid: (raw.bestBid as number) || 0,
    bestAsk: (raw.bestAsk as number) || 0,
    spread: (raw.spread as number) || 0,
    active: (raw.active as boolean) || false,
    closed: (raw.closed as boolean) || false,
    negRisk: (raw.negRisk as boolean) || false,
    negRiskMarketID: (raw.negRiskMarketID as string) || "",
    tickSize: (raw.orderPriceMinTickSize as number) || 0.01,
    endDate: (raw.endDate as string) || "",
    description: (raw.description as string) || "",
    tags: [],
    eventId: "",
    eventTitle: "",
  };
}

// Fetch active markets sorted by 24h volume (most active first)
export async function fetchActiveMarkets(limit = 100): Promise<Market[]> {
  try {
    const url = `${config.gammaUrl}/markets`;
    const resp = await axios.get(url, {
      params: {
        active: true,
        closed: false,
        limit,
        order: "volume24hr",
        ascending: false,
      },
    });

    const markets = (resp.data as Record<string, unknown>[]).map(parseMarket);
    log.info(`Fetched ${markets.length} active markets`);
    return markets;
  } catch (err) {
    log.error("Failed to fetch markets:", err);
    return [];
  }
}

// Fetch active events (each event contains multiple related markets)
export async function fetchActiveEvents(limit = 50): Promise<Event[]> {
  try {
    const url = `${config.gammaUrl}/events`;
    const resp = await axios.get(url, {
      params: {
        active: true,
        closed: false,
        limit,
        order: "volume24hr",
        ascending: false,
      },
    });

    const events: Event[] = (resp.data as Record<string, unknown>[]).map(
      (raw: Record<string, unknown>) => {
        const rawMarkets = (raw.markets as Record<string, unknown>[]) || [];
        const markets = rawMarkets.map((m) => {
          const market = parseMarket(m);
          market.eventId = raw.id as string;
          market.eventTitle = raw.title as string;
          return market;
        });

        const tags = ((raw.tags as { label: string }[]) || []).map(
          (t) => t.label
        );

        return {
          id: raw.id as string,
          title: raw.title as string,
          slug: raw.slug as string,
          markets,
          negRisk: (raw.negRisk as boolean) || false,
          volume: (raw.volume as number) || 0,
          liquidity: (raw.liquidity as number) || 0,
          tags,
        };
      }
    );

    log.info(`Fetched ${events.length} active events`);
    return events;
  } catch (err) {
    log.error("Failed to fetch events:", err);
    return [];
  }
}

// Get markets filtered by minimum liquidity and volume
export async function getTradeableMarkets(
  minLiquidity = 1000,
  minVolume24hr = 500
): Promise<Market[]> {
  const markets = await fetchActiveMarkets(200);

  const filtered = markets.filter(
    (m) =>
      m.active &&
      !m.closed &&
      m.liquidity >= minLiquidity &&
      m.volume24hr >= minVolume24hr &&
      m.bestBid > 0 &&
      m.bestAsk > 0
  );

  log.info(
    `${filtered.length} tradeable markets (liquidity >= $${minLiquidity}, 24h vol >= $${minVolume24hr})`
  );
  return filtered;
}
