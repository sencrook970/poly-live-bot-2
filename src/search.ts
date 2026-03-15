import axios from "axios";
import { log } from "./utils/logger";

// ---------------------------------------------------------------------------
// Web Search — fetches real-time news/context before AI makes predictions.
// Uses Tavily API (free tier: 1000 credits/month).
//
// This is the single biggest improvement to the bot:
// Instead of the AI guessing from question text alone, it now gets
// real news articles and data before estimating probabilities.
// ---------------------------------------------------------------------------

const TAVILY_API_KEY = process.env.TAVILY_API_KEY;

// Cache: don't search same topic more than once per hour
const searchCache = new Map<string, { result: SearchContext; timestamp: number }>();
const CACHE_TTL = 60 * 60 * 1000; // 1 hour

interface SearchResult {
  title: string;
  content: string;
  url: string;
}

export interface SearchContext {
  query: string;
  results: SearchResult[];
  summary: string; // concatenated for LLM prompt
  source: "tavily";
}

// Search for context about a market question
export async function searchForContext(
  question: string,
  description?: string
): Promise<SearchContext | null> {
  if (!TAVILY_API_KEY) {
    return null;
  }

  // Build a focused search query from the market question
  const query = buildSearchQuery(question, description);

  // Check cache first
  const cacheKey = query.substring(0, 50);
  const cached = searchCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    log.info(`[Search] Cache hit: "${query.substring(0, 50)}..."`);
    return cached.result;
  }

  try {
    const resp = await axios.post(
      "https://api.tavily.com/search",
      {
        api_key: TAVILY_API_KEY,
        query,
        search_depth: "basic", // 'basic' = 1 credit, 'advanced' = 2 credits
        max_results: 5,
        include_answer: true,
      },
      { timeout: 10000 }
    );

    const data = resp.data;
    const results: SearchResult[] = (data.results || []).map((r: any) => ({
      title: r.title || "",
      content: (r.content || "").substring(0, 300),
      url: r.url || "",
    }));

    // Build a concise summary for the LLM
    const snippets = results
      .slice(0, 3)
      .map((r, i) => `[${i + 1}] ${r.title}: ${r.content}`)
      .join("\n\n");

    const answer = data.answer || "";
    const summary = answer
      ? `Search answer: ${answer}\n\nSources:\n${snippets}`
      : `Search results:\n${snippets}`;

    log.info(`[Search] "${query.substring(0, 50)}..." → ${results.length} results (1 credit used, ${searchCache.size} cached)`);
    // Log search snippet previews for debugging
    for (const r of results.slice(0, 2)) {
      log.info(`[Search]   → ${r.title.substring(0, 60)}`);
    }
    if (data.answer) {
      log.info(`[Search]   Answer: ${data.answer.substring(0, 100)}...`);
    }

    const context: SearchContext = { query, results, summary, source: "tavily" };

    // Save to cache
    searchCache.set(cacheKey, { result: context, timestamp: Date.now() });

    return context;
  } catch (err: any) {
    log.warn(`[Search] Failed: ${err.message?.substring(0, 80)}`);
    return null;
  }
}

// Build a good search query from a market question
function buildSearchQuery(question: string, description?: string): string {
  // Remove Polymarket-specific phrasing
  let q = question
    .replace(/^Will /i, "")
    .replace(/\?$/, "")
    .replace(/by (March|April|May|June|July|August|September|October|November|December) \d+/i, "")
    .replace(/before \d{4}/i, "")
    .replace(/on \d{4}-\d{2}-\d{2}/i, "")
    .trim();

  // Add "latest news" to get recent results
  q = `${q} latest news ${new Date().toISOString().split("T")[0]}`;

  // Keep it under 100 chars for better search results
  if (q.length > 100) {
    q = q.substring(0, 100);
  }

  return q;
}

// Check if we should search for this market (save credits)
export function shouldSearch(question: string, category?: string): boolean {
  const q = question.toLowerCase();

  // ALWAYS search for these (high value, AI needs context)
  if (q.includes("iran") || q.includes("israel") || q.includes("trump")) return true;
  if (q.includes("fed") || q.includes("interest rate")) return true;
  if (q.includes("regime") || q.includes("ceasefire")) return true;
  if (q.includes("election") || q.includes("president")) return true;
  if (q.includes("oil") || q.includes("crude")) return true;
  if (q.includes("oscar") || q.includes("academy award")) return true;
  if (q.includes("greenland") || q.includes("acquire")) return true;

  // NEVER search for these (waste of credits)
  if (category === "sports") return false;
  if (q.includes("counter-strike") || q.includes("dota") || q.includes("lol:")) return false;
  if (q.includes("up or down")) return false; // crypto momentum handles this

  // Search for everything else with decent liquidity
  return true;
}
