import OpenAI from "openai";
import { Strategy } from "./types";
import { Opportunity } from "../markets/analyzer";
import { getTradeableMarkets, Market } from "../markets/scanner";
import { config } from "../config";
import { log } from "../utils/logger";
import { searchForContext, shouldSearch, SearchContext } from "../search";
import { recordAnalysis } from "../db";

// ---------------------------------------------------------------------------
// NEWS SNIPER STRATEGY
//
// Core idea: Don't predict the future. Find markets where the outcome is
// ALREADY KNOWN from recent news but the price hasn't adjusted yet.
//
// How it works:
// 1. Scan markets, filter aggressively (no sports, good liquidity, 1-45 days)
// 2. Prioritize by "searchability" — geopolitics, economics, policy first
// 3. Search each candidate with Tavily for current news
// 4. Ask LLM to classify evidence as CONFIRMED/STRONG/WEAK/UNKNOWN
// 5. Only trade on CONFIRMED (near-certain) or STRONG (high confidence)
// 6. Concentrate bets — fewer, larger positions on high-conviction plays
//
// This replaces the generic AI Predictor which spread too thin with $1-2 bets.
// ---------------------------------------------------------------------------

type EvidenceLevel = "CONFIRMED" | "STRONG" | "WEAK" | "UNKNOWN";

interface EvidenceAnalysis {
  evidenceLevel: EvidenceLevel;
  probability: number;
  confidence: number;
  keyFact: string;
  reasoning: string;
}

// Skip re-analyzing markets recently classified as no-edge
const skipCache = new Map<string, number>();
const SKIP_CACHE_TTL = 4 * 60 * 60 * 1000; // 4 hours

function getEvidencePrompt(): string {
  return `You are a forensic analyst for prediction markets. Your ONLY job is to determine if the outcome of a market is ALREADY KNOWN or NEARLY CERTAIN based on the search results provided.

You are NOT predicting the future. You are checking if the answer is already available in current news and data.

Today is ${new Date().toISOString().split("T")[0]}.

EVIDENCE LEVELS:
- CONFIRMED: A search result explicitly states the outcome has occurred, been officially announced, or is recorded fact. Example: "WTO confirmed tariff reduction on March 10" for a market asking "Will WTO reduce tariffs by April?"
- STRONG: Multiple credible sources provide specific data strongly pointing to one outcome. Example: 3+ independent polls all showing candidate X at 60%+ with election in 3 days.
- WEAK: Only speculation, analyst predictions, or indirect evidence. No hard facts cited.
- UNKNOWN: Search results don't meaningfully address this question.

CRITICAL RULES:
1. CITE the specific fact or quote from search results. No citation = WEAK at best.
2. Polymarket prices/odds found in search results are NOT evidence. Ignore them completely.
3. "Experts predict" or "analysts expect" or "likely to" = WEAK, never STRONG or CONFIRMED.
4. Official data, confirmed results, verified outcomes, government announcements = CONFIRMED.
5. If the event is in the FUTURE and hasn't happened yet, max classification is STRONG (never CONFIRMED).
6. For CONFIRMED: set probability to 0.92-0.99 depending on source reliability.
7. For STRONG: set probability to 0.70-0.88 based on how many sources agree and how specific the data is.
8. For WEAK/UNKNOWN: set probability close to the current market price (you have no real edge).
9. Set confidence based on how sure you are about your CLASSIFICATION itself.
10. If search results discuss Polymarket betting odds or trader sentiment, that is NOT evidence about the real-world event.
11. Check the market end date — if the event deadline hasn't passed, be conservative.

Respond ONLY with JSON:
{"evidence_level": "CONFIRMED|STRONG|WEAK|UNKNOWN", "probability": 0.XX, "confidence": 0.XX, "key_fact": "The specific cited fact from search results that supports your classification", "reasoning": "1-2 sentences explaining your classification"}`;
}

export class NewsSniperStrategy implements Strategy {
  name = "News Sniper";
  description = "Finds markets where outcomes are already known but prices haven't adjusted";

  private openai: OpenAI;
  private walletId: string = "";
  private maxCandidates = 12;

  constructor() {
    this.openai = new OpenAI({
      apiKey: config.openaiApiKey,
      baseURL: config.openaiBaseUrl || undefined,
    });
  }

  setWalletId(id: string) {
    this.walletId = id;
  }

  async findOpportunities(): Promise<Opportunity[]> {
    if (!config.openaiApiKey) {
      log.warn("[Sniper] No API key. Skipping.");
      return [];
    }

    log.info("[Sniper] ══════════════════════════════════════");
    log.info("[Sniper] News Sniper scanning for mispriced markets...");

    // Step 1: Get tradeable markets
    const markets = await getTradeableMarkets(5000, 500);

    // Step 2: Filter aggressively
    const candidates = this.filterCandidates(markets);
    log.info(
      `[Sniper] ${candidates.length} candidates after filtering (from ${markets.length} markets)`
    );

    if (candidates.length === 0) {
      log.info("[Sniper] No candidates found this scan.");
      return [];
    }

    // Step 3: Prioritize by "searchability" and take top N
    const prioritized = this.prioritizeCandidates(candidates).slice(
      0,
      this.maxCandidates
    );

    log.info(
      `[Sniper] Analyzing top ${prioritized.length} candidates with search + evidence classification...`
    );

    // Step 4: Search and classify each candidate
    const opportunities: Opportunity[] = [];
    let searched = 0;
    let confirmed = 0;
    let strong = 0;
    let weak = 0;
    let skippedCache = 0;

    for (const market of prioritized) {
      // Check skip cache — don't re-analyze WEAK/UNKNOWN markets for 4 hours
      const cachedAt = skipCache.get(market.id);
      if (cachedAt && Date.now() - cachedAt < SKIP_CACHE_TTL) {
        skippedCache++;
        continue;
      }

      try {
        // Search for evidence
        let searchContext: SearchContext | null = null;
        if (shouldSearch(market.question)) {
          searchContext = await searchForContext(
            market.question,
            market.description
          );
          if (searchContext) searched++;
        }

        // Classify evidence with LLM
        const analysis = await this.classifyEvidence(market, searchContext);

        // Log to database
        if (this.walletId) {
          const yesPrice = market.outcomePrices[0];
          await recordAnalysis({
            marketId: market.id,
            walletId: this.walletId,
            model: config.aiModel,
            aiProbability: analysis.probability * 100,
            marketProbability: yesPrice * 100,
            edgePercent:
              Math.abs(analysis.probability - yesPrice) * 100,
            confidence: analysis.confidence,
            reasoning: `[${analysis.evidenceLevel}] ${analysis.keyFact} — ${analysis.reasoning}`,
            searchQuery: searchContext?.query,
            searchResults: searchContext?.summary?.substring(0, 1000),
            searchSource: searchContext?.source,
            decision:
              analysis.evidenceLevel === "CONFIRMED" ||
              analysis.evidenceLevel === "STRONG"
                ? "trade"
                : analysis.evidenceLevel === "WEAK"
                  ? "skip_low_confidence"
                  : "skip_filtered",
            marketQuestion: market.question,
          }).catch(() => {});
        }

        // Only trade on CONFIRMED or STRONG evidence
        if (analysis.evidenceLevel === "CONFIRMED") {
          confirmed++;
          const opp = this.createOpportunity(market, analysis);
          if (opp) {
            opportunities.push(opp);
            log.opportunity(
              `[Sniper] CONFIRMED: "${market.question.substring(0, 60)}..." — ${analysis.keyFact.substring(0, 100)}`
            );
          }
        } else if (analysis.evidenceLevel === "STRONG") {
          strong++;
          const opp = this.createOpportunity(market, analysis);
          if (opp) {
            opportunities.push(opp);
            log.opportunity(
              `[Sniper] STRONG: "${market.question.substring(0, 60)}..." — ${analysis.keyFact.substring(0, 100)}`
            );
          }
        } else {
          weak++;
          // Cache WEAK/UNKNOWN markets so we don't waste credits re-analyzing
          skipCache.set(market.id, Date.now());
          log.info(
            `[Sniper]   ${analysis.evidenceLevel}: "${market.question.substring(0, 55)}..." — cached 4h`
          );
        }
      } catch (err) {
        log.warn(
          `[Sniper] Error on "${market.question.substring(0, 40)}...": ${err}`
        );
      }
    }

    log.info(
      `[Sniper] Results: ${confirmed} confirmed, ${strong} strong, ${weak} weak/unknown, ${skippedCache} cached-skip (${searched} searches used)`
    );
    log.info("[Sniper] ══════════════════════════════════════");

    return opportunities;
  }

  // --- FILTERING ---
  // Aggressive filter: only keep markets where news-based edge is possible

  private filterCandidates(markets: Market[]): Market[] {
    return markets.filter((m) => {
      const q = m.question.toLowerCase();
      const yesPrice = m.outcomePrices[0];

      // Skip sports and esports — AI can't predict live games
      if (this.isSportsMarket(q)) return false;

      // Skip crypto up/down — no news edge, already efficiently priced
      if (q.includes("up or down") || q.includes("up/down")) return false;

      // Skip "Bitcoin above/below $X on [specific date]" daily markets
      if (
        q.includes("bitcoin") &&
        (q.includes("above") || q.includes("below")) &&
        /on \d{4}-\d{2}-\d{2}/.test(q)
      )
        return false;

      // Price must have room for edge
      // Bond Mode trades on markets at $0.85-0.97 (near-certain outcomes)
      // so we allow up to $0.97 instead of $0.95
      if (yesPrice <= 0.05 || yesPrice >= 0.97) return false;

      // Liquidity must be good for decent order fills
      if (m.liquidity < 5000) return false;

      // Time window: ending in 1-45 days (sweet spot for news-based edge)
      if (m.endDate) {
        const daysLeft =
          (new Date(m.endDate).getTime() - Date.now()) /
          (1000 * 60 * 60 * 24);
        if (daysLeft < 1) return false; // Too late — prices already efficient
        if (daysLeft > 45) return false; // Too far out — capital locked too long
      }

      return true;
    });
  }

  // --- PRIORITIZATION ---
  // Score markets by how likely they are to have a news-based edge.
  // Geopolitics, economics, and policy markets score highest because
  // these are where search results most often reveal known outcomes.

  private prioritizeCandidates(markets: Market[]): Market[] {
    const scored = markets.map((m) => {
      let score = 0;
      const q = m.question.toLowerCase();
      const yesPrice = m.outcomePrices[0];

      // Markets with skewed prices (away from 50%) may have stale pricing
      const distFrom50 = Math.abs(yesPrice - 0.5);
      if (distFrom50 > 0.3) score += 3;
      else if (distFrom50 > 0.15) score += 1;

      // Markets ending soon have more resolution info available
      if (m.endDate) {
        const daysLeft =
          (new Date(m.endDate).getTime() - Date.now()) /
          (1000 * 60 * 60 * 24);
        if (daysLeft <= 7) score += 4;
        else if (daysLeft <= 14) score += 2;
        else if (daysLeft <= 30) score += 1;
      }

      // Geopolitics — our historically best category
      if (
        /iran|israel|ukraine|russia|china|taiwan|nato|war|ceasefire|sanctions|houthi|hezbollah/.test(
          q
        )
      )
        score += 3;

      // Economics and policy
      if (
        /fed |interest rate|gdp|inflation|tariff|trade war|recession|treasury|debt ceiling/.test(
          q
        )
      )
        score += 3;

      // Elections and politics
      if (
        /election|vote|poll|president|governor|senate|congress|parliament|prime minister/.test(
          q
        )
      )
        score += 2;

      // Commodities
      if (/oil|crude|opec|energy|gas price|gold price/.test(q)) score += 2;

      // Awards and entertainment (often have leaked/confirmed results)
      if (
        /oscar|grammy|emmy|award|nomination|nobel|pulitzer/.test(q)
      )
        score += 2;

      // Corporate events (verifiable)
      if (
        /ceo|resign|fired|appointed|merger|acquisition|ipo|earnings|layoff/.test(
          q
        )
      )
        score += 2;

      // Science and tech milestones
      if (/spacex|nasa|launch|fda|approved|clinical trial/.test(q))
        score += 2;

      // Higher 24h volume = more active, better fills
      if (m.volume24hr > 50000) score += 2;
      else if (m.volume24hr > 10000) score += 1;

      return { market: m, score };
    });

    // Sort by score descending, shuffle within same score for variety
    scored.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return Math.random() - 0.5;
    });

    return scored.map((s) => s.market);
  }

  // --- EVIDENCE CLASSIFICATION ---
  // The core of News Sniper: classify search results as fact vs speculation

  private async classifyEvidence(
    market: Market,
    searchContext: SearchContext | null
  ): Promise<EvidenceAnalysis> {
    const yesPrice = market.outcomePrices[0];

    let userMessage = `Market: "${market.question}"
YES price: $${yesPrice.toFixed(3)} (${(yesPrice * 100).toFixed(1)}% implied probability)
NO price: $${market.outcomePrices[1]?.toFixed(3) || "N/A"}
Ends: ${market.endDate || "Unknown"}
Volume 24h: $${market.volume24hr?.toFixed(0) || "0"}
Liquidity: $${market.liquidity?.toFixed(0) || "0"}`;

    if (market.description) {
      userMessage += `\nResolution criteria: ${market.description.substring(0, 600)}`;
    }

    if (searchContext) {
      userMessage += `\n\n--- SEARCH RESULTS ---\n${searchContext.summary.substring(0, 2000)}`;
    } else {
      userMessage += `\n\n(No search results available. Classify as UNKNOWN.)`;
    }

    try {
      const response = await this.openai.chat.completions.create({
        model: config.aiModel,
        messages: [
          { role: "system", content: getEvidencePrompt() },
          { role: "user", content: userMessage },
        ],
        temperature: 0.2, // Low temp for consistent, factual analysis
        max_tokens: 300,
      });

      const content = response.choices[0]?.message?.content;
      if (!content) {
        return this.defaultAnalysis(yesPrice, "No LLM response");
      }

      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        return this.defaultAnalysis(yesPrice, "No JSON in LLM response");
      }

      const parsed = JSON.parse(jsonMatch[0]);

      const evidenceLevel = (
        parsed.evidence_level || "UNKNOWN"
      ).toUpperCase() as EvidenceLevel;

      // Sanity check: don't let LLM claim CONFIRMED without actual evidence
      if (
        evidenceLevel === "CONFIRMED" &&
        (!parsed.key_fact || parsed.key_fact.length < 10)
      ) {
        return {
          evidenceLevel: "WEAK",
          probability: yesPrice,
          confidence: 0.3,
          keyFact: "LLM claimed CONFIRMED but cited no specific fact",
          reasoning: parsed.reasoning || "",
        };
      }

      return {
        evidenceLevel,
        probability: Math.max(
          0.01,
          Math.min(0.99, parsed.probability || yesPrice)
        ),
        confidence: Math.max(0, Math.min(1, parsed.confidence || 0)),
        keyFact: parsed.key_fact || "",
        reasoning: parsed.reasoning || "",
      };
    } catch (err) {
      return this.defaultAnalysis(yesPrice, `LLM error: ${err}`);
    }
  }

  private defaultAnalysis(
    marketPrice: number,
    reason: string
  ): EvidenceAnalysis {
    return {
      evidenceLevel: "UNKNOWN",
      probability: marketPrice,
      confidence: 0,
      keyFact: reason,
      reasoning: "",
    };
  }

  // --- OPPORTUNITY CREATION ---
  // Two modes:
  // 1. SNIPER MODE: high edge (10-15%+), CONFIRMED or STRONG — bigger bets
  // 2. BOND MODE: low edge (3%+), CONFIRMED only, price > $0.85 — near-certain small profits
  //
  // Bond Mode catches the "high-probability bonds" that Sniper Mode skips.
  // Example: Oil already hit $100, market at $0.88, edge only 4% — Sniper skips,
  // but Bond Mode takes it because it's CONFIRMED and near-certain to pay $1.00.

  private createOpportunity(
    market: Market,
    analysis: EvidenceAnalysis
  ): Opportunity | null {
    const yesPrice = market.outcomePrices[0];
    const edge = analysis.probability - yesPrice;
    const edgePercent = Math.abs(edge) * 100;
    const shouldBuyYes = edge > 0;
    const buyPrice = shouldBuyYes ? yesPrice : market.outcomePrices[1];

    // --- BOND MODE ---
    // CONFIRMED events where the winning side is priced $0.85+
    // These are near-certain outcomes with small but reliable profit.
    // Lower edge threshold (3%), smaller position size (lower confidence = smaller Kelly)
    const isBondCandidate =
      analysis.evidenceLevel === "CONFIRMED" &&
      analysis.confidence >= 0.85 &&
      buyPrice >= 0.70 &&                 // winning side is already expensive
      analysis.probability >= 0.90 &&     // AI says 90%+ likely
      edgePercent >= 3;                   // at least 3% edge

    if (isBondCandidate && edgePercent < 10) {
      // This is a Bond Mode trade — small edge but near-certain
      // Use lower confidence multiplier so Kelly sizes smaller (5-8% of bankroll)
      log.opportunity(
        `[Sniper] BOND: "${market.question.substring(0, 55)}..." — ${edgePercent.toFixed(1)}% edge, CONFIRMED, price $${buyPrice.toFixed(3)}`
      );

      return {
        type: "AI_EDGE",
        market,
        edgePercent,
        expectedProfit: Math.abs(edge),
        confidence: 0.65, // lower confidence = smaller Kelly bet (~5% of bankroll)
        description: `[BOND] ${analysis.keyFact.substring(0, 120)} — AI: ${(analysis.probability * 100).toFixed(0)}% vs market: ${(buyPrice * 100).toFixed(0)}% (near-certain, ${edgePercent.toFixed(1)}% yield)`,
        action: {
          side: "BUY",
          tokenId: shouldBuyYes
            ? market.clobTokenIds[0]
            : market.clobTokenIds[1],
          price: buyPrice,
          outcome: shouldBuyYes ? "Yes" : "No",
        },
      };
    }

    // --- SNIPER MODE (original) ---
    // Higher edge thresholds for bigger bets
    const minEdge = analysis.evidenceLevel === "CONFIRMED" ? 10 : 15;
    if (edgePercent < minEdge) {
      log.info(
        `[Sniper]   Edge too small (${edgePercent.toFixed(1)}% < ${minEdge}%): "${market.question.substring(0, 50)}..."`
      );
      return null;
    }

    if (analysis.confidence < 0.65) {
      log.info(
        `[Sniper]   Confidence too low (${analysis.confidence.toFixed(2)}): "${market.question.substring(0, 50)}..."`
      );
      return null;
    }

    // Boost confidence for concentrated sizing
    const adjustedConfidence =
      analysis.evidenceLevel === "CONFIRMED"
        ? Math.max(analysis.confidence, 0.9)
        : Math.max(analysis.confidence, 0.75);

    return {
      type: "AI_EDGE",
      market,
      edgePercent,
      expectedProfit: Math.abs(edge),
      confidence: adjustedConfidence,
      description: `[${analysis.evidenceLevel}] ${analysis.keyFact.substring(0, 120)} — AI: ${(analysis.probability * 100).toFixed(0)}% vs market: ${(yesPrice * 100).toFixed(0)}% (${analysis.reasoning.substring(0, 100)})`,
      action: {
        side: "BUY",
        tokenId: shouldBuyYes
          ? market.clobTokenIds[0]
          : market.clobTokenIds[1],
        price: shouldBuyYes ? yesPrice : market.outcomePrices[1],
        outcome: shouldBuyYes ? "Yes" : "No",
      },
    };
  }

  // --- SPORTS FILTER ---
  // Extended from AI predictor with more patterns

  private isSportsMarket(q: string): boolean {
    const sportsPatterns = [
      /vs\./i,
      /win on \d{4}-\d{2}-\d{2}/i,
      /o\/u \d/i,
      /spread:/i,
      /\bNBA\b/i,
      /\bNHL\b/i,
      /\bNFL\b/i,
      /\bMLB\b/i,
      /\bMLS\b/i,
      /\bIPL\b/i,
      /counter-strike/i,
      /\bdota\b/i,
      /\blol:/i,
      /valorant|overwatch|rainbow six|csgo|cs2/i,
      /\bfc\b.*win/i,
      /\bunited\b.*win/i,
      /\bcity\b.*win/i,
      /hornets|spurs|bucks|hawks|nuggets|lakers|magic|heat|wizards|celtics|blackhawks|golden knights|cavaliers|pistons|grizzlies|pacers|pelicans|raptors|rockets|suns|thunder|timberwolves|trail blazers/i,
      /bournemouth|brighton|bayern|leverkusen|madrid|juventus|atletico|hoffenheim|eintracht|barcelona|dortmund|inter|napoli|arsenal|liverpool|chelsea|tottenham/i,
      /formula 1|f1|grand prix|nascar|moto ?gp/i,
      /paper rex|nongshim|gen\.?g|jd gaming|fnatic|cloud9|t1|team liquid/i,
      /cricket|innings|wicket/i,
      /\bUFC\b|boxing|fight night|bellator|mma/i,
      /\bPGA\b|golf|masters|open championship/i,
      /\bATP\b|\bWTA\b|tennis|wimbledon|roland garros|us open tennis/i,
      /\bMLR\b|rugby/i,
    ];
    return sportsPatterns.some((p) => p.test(q));
  }
}
