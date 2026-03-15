import OpenAI from "openai";
import { Strategy } from "./types";
import { Opportunity } from "../markets/analyzer";
import { getTradeableMarkets, Market } from "../markets/scanner";
import { config } from "../config";
import { log } from "../utils/logger";
import { searchForContext, shouldSearch, SearchContext } from "../search";
import { recordAnalysis } from "../db";

// ---------------------------------------------------------------------------
// AI PREDICTION STRATEGY v2
//
// Improvements over v1:
// 1. Web search BEFORE prediction — AI gets real news context
// 2. Skips sports markets entirely (no live data = gambling)
// 3. Logs every analysis to database (even skipped ones)
// 4. Better prompt that requires reasoning
// ---------------------------------------------------------------------------

function getAnalysisPrompt(): string {
  return `You are a sharp prediction market trader. Estimate the TRUE probability of the YES outcome.

Today is ${new Date().toISOString().split("T")[0]}.

You will be given a market question with context, AND recent news/search results about the topic. Use the search results to inform your estimate.

RULES:
1. READ the search results carefully. They are your primary source of truth.
2. ONLY disagree with the market when search results provide CONCRETE evidence (a fact, a confirmed event, a direct quote, official data).
3. If search results are vague, speculative, or don't directly address the question, set confidence to 0.2.
4. DO NOT speculate or guess. If you can't cite a specific fact from search results, agree with the market.
5. NEVER trade sports, esports, or gaming matches.
6. For "already happened" events (oil already hit $X, person already won award): set probability to 0.95+ ONLY if a search result explicitly confirms the event occurred.
7. For future events: be CONSERVATIVE. Markets are usually efficient. Only disagree with strong evidence.
8. Common trap: search results about Polymarket itself (showing odds) are NOT evidence of the event. Ignore those.

CRITICAL: We lose money when you are wrong. Only trade when you are CERTAIN based on facts. It is better to skip 10 trades than to make 1 bad trade.

Respond ONLY with JSON:
{"probability": 0.XX, "confidence": 0.XX, "reasoning": "1-2 sentences citing specific evidence from search results"}`;
}

export class AIPredictorStrategy implements Strategy {
  name = "AI Prediction";
  description = "Uses LLM + web search to estimate probabilities";

  private openai: OpenAI;
  private maxMarketsPerScan = 8; // Randomized + cached, so more markets is fine
  private walletId: string = "";

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
      log.warn("[AI] No API key set. Skipping AI strategy.");
      return [];
    }

    log.info("[AI] Scanning markets for AI edge...");

    const markets = await getTradeableMarkets(2000, 500);

    // Filter: decent liquidity, not too extreme, NOT SPORTS
    const targetMarkets = markets
      .filter((m) => {
        const yesPrice = m.outcomePrices[0];
        const q = m.question.toLowerCase();

        // SKIP SPORTS — we learned this the hard way
        if (this.isSportsMarket(q)) return false;

        // SKIP esports and all competitive gaming
        if (/counter-strike|dota|lol:|valorant|league of legends|overwatch|rainbow six|csgo|cs2/i.test(q)) return false;

        // SKIP markets ending within 6 hours (too late, prices efficient)
        if (m.endDate) {
          const hoursLeft = (new Date(m.endDate).getTime() - Date.now()) / (1000 * 60 * 60);
          if (hoursLeft > 0 && hoursLeft < 6) return false;
          // SKIP markets ending after 120 days (capital locked too long)
          if (hoursLeft > 120 * 24) return false;
        }

        // Minimum liquidity $5K for better order fills
        return (
          m.liquidity >= 5000 &&
          yesPrice > 0.05 &&
          yesPrice < 0.95
        );
      })
      // Shuffle markets so we don't analyze the same ones every scan
      .sort(() => Math.random() - 0.5)
      .slice(0, this.maxMarketsPerScan);

    log.info(`[AI] Analyzing ${targetMarkets.length} markets with LLM + search...`);

    const opportunities: Opportunity[] = [];
    let analyzed = 0;
    let searched = 0;
    let skippedLowEdge = 0;
    let skippedLowConf = 0;

    for (const market of targetMarkets) {
      try {
        // Step 1: Web search (if applicable and we have credits)
        let searchContext: SearchContext | null = null;
        if (shouldSearch(market.question)) {
          searchContext = await searchForContext(
            market.question,
            market.description
          );
          if (searchContext) searched++;
        }

        // Step 2: AI analysis with search context
        const result = await this.analyzeMarket(market, searchContext);
        analyzed++;

        // Step 3: Log to database
        if (this.walletId) {
          await recordAnalysis({
            marketId: market.id,
            walletId: this.walletId,
            model: config.aiModel,
            aiProbability: result.aiProb || 0,
            marketProbability: result.marketProb || 0,
            edgePercent: result.edge || 0,
            confidence: result.confidence || 0,
            reasoning: result.reasoning || "",
            searchQuery: searchContext?.query,
            searchResults: searchContext?.summary?.substring(0, 1000),
            searchSource: searchContext?.source,
            decision: result.status,
            marketQuestion: market.question,
          }).catch((err) => log.warn(`[DB] Analysis save error: ${err}`));
        }

        if (result.status === "trade" && result.opportunity) {
          opportunities.push(result.opportunity);
          log.opportunity(
            `[AI] EDGE: "${market.question.substring(0, 50)}..." — ${result.opportunity.description} (edge: ${result.opportunity.edgePercent.toFixed(1)}%)${searchContext ? " [searched]" : ""}`
          );
        } else if (result.status === "skip_low_edge") {
          skippedLowEdge++;
          log.info(
            `[AI]   SKIP (edge ${result.edge?.toFixed(1)}%): "${market.question.substring(0, 50)}..."`
          );
        } else if (result.status === "skip_low_confidence") {
          skippedLowConf++;
          log.info(
            `[AI]   SKIP (conf ${result.confidence?.toFixed(2)}): "${market.question.substring(0, 50)}..."`
          );
        }
      } catch (err) {
        log.warn(`[AI] Error on "${market.question.substring(0, 40)}...": ${err}`);
      }
    }

    log.info(
      `[AI] Results: ${opportunities.length} opportunities, ${skippedLowEdge} low-edge, ${skippedLowConf} low-conf (${analyzed} analyzed, ${searched} searched)`
    );

    return opportunities;
  }

  private isSportsMarket(q: string): boolean {
    // Skip all live sports game outcomes — AI can't predict these
    const sportsPatterns = [
      /vs\./i,
      /win on \d{4}-\d{2}-\d{2}/i,
      /o\/u \d/i,
      /spread:/i,
      /\bNBA\b/i,
      /\bNHL\b/i,
      /\bNFL\b/i,
      /\bMLB\b/i,
      /counter-strike/i,
      /\bdota\b/i,
      /\blol:/i,
      /\bfc\b.*win/i,
      /\bunited\b.*win/i,
      /\bcity\b.*win/i,
      /hornets|spurs|bucks|hawks|nuggets|lakers|magic|heat|wizards|celtics|blackhawks|golden knights/i,
      /bournemouth|brighton|bayern|leverkusen|madrid|juventus|atletico|hoffenheim|eintracht/i,
      /formula 1|f1|grand prix|nascar|moto ?gp/i,
      /paper rex|nongshim|gen\.?g|jd gaming|fnatic|cloud9|t1|team liquid/i,
    ];

    return sportsPatterns.some((p) => p.test(q));
  }

  private async analyzeMarket(
    market: Market,
    searchContext: SearchContext | null
  ): Promise<AnalysisResult> {
    const yesPrice = market.outcomePrices[0];
    if (!yesPrice || yesPrice <= 0.05 || yesPrice >= 0.95) {
      return { status: "skip_filtered" };
    }

    // Build prompt with search context
    let userMessage = `Market: "${market.question}"
Outcomes: ${market.outcomes.join(" vs ")}
YES price: $${yesPrice.toFixed(3)} (${(yesPrice * 100).toFixed(1)}%)
NO price: $${market.outcomePrices[1]?.toFixed(3) || "N/A"}
Ends: ${market.endDate || "Unknown"}
Volume 24h: $${market.volume24hr.toFixed(0)}
Liquidity: $${market.liquidity.toFixed(0)}`;

    if (market.description) {
      userMessage += `\nDescription: ${market.description.substring(0, 500)}`;
    }

    if (searchContext) {
      userMessage += `\n\n--- RECENT NEWS/CONTEXT ---\n${searchContext.summary.substring(0, 1500)}`;
    } else {
      userMessage += `\n\n(No search results available — base your estimate on general knowledge only. Set confidence LOW if unsure.)`;
    }

    const response = await this.openai.chat.completions.create({
      model: config.aiModel,
      messages: [
        { role: "system", content: getAnalysisPrompt() },
        { role: "user", content: userMessage },
      ],
      temperature: 0.3,
      max_tokens: 250,
    });

    const content = response.choices[0]?.message?.content;
    if (!content) return { status: "skip_filtered" };

    let analysis: { probability: number; confidence: number; reasoning: string };
    try {
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return { status: "skip_filtered" };
      analysis = JSON.parse(jsonMatch[0]);
    } catch {
      return { status: "skip_filtered" };
    }

    const aiProb = analysis.probability;
    const edge = aiProb - yesPrice;
    const edgePercent = Math.abs(edge) * 100;

    if (analysis.confidence < 0.7) {
      return {
        status: "skip_low_confidence",
        confidence: analysis.confidence,
        reasoning: analysis.reasoning,
        aiProb: aiProb * 100,
        marketProb: yesPrice * 100,
        edge: edgePercent,
      };
    }

    if (edgePercent < config.minEdgePercent) {
      return {
        status: "skip_low_edge",
        edge: edgePercent,
        aiProb: aiProb * 100,
        marketProb: yesPrice * 100,
        confidence: analysis.confidence,
        reasoning: analysis.reasoning,
      };
    }

    const shouldBuyYes = edge > 0;

    return {
      status: "trade",
      aiProb: aiProb * 100,
      marketProb: yesPrice * 100,
      edge: edgePercent,
      confidence: analysis.confidence,
      reasoning: analysis.reasoning,
      opportunity: {
        type: "AI_EDGE",
        market,
        edgePercent,
        expectedProfit: Math.abs(edge),
        confidence: analysis.confidence,
        description: `AI: ${(aiProb * 100).toFixed(0)}% vs market: ${(yesPrice * 100).toFixed(0)}% (conf: ${analysis.confidence.toFixed(2)}). ${analysis.reasoning}`,
        action: {
          side: "BUY",
          tokenId: shouldBuyYes
            ? market.clobTokenIds[0]
            : market.clobTokenIds[1],
          price: shouldBuyYes ? yesPrice : market.outcomePrices[1],
          outcome: shouldBuyYes ? "Yes" : "No",
        },
      },
    };
  }
}

interface AnalysisResult {
  status: "trade" | "skip_low_edge" | "skip_low_confidence" | "skip_filtered" | "skip_sports";
  opportunity?: Opportunity;
  aiProb?: number;
  marketProb?: number;
  edge?: number;
  confidence?: number;
  reasoning?: string;
}
