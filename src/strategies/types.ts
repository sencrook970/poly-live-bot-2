import { Opportunity } from "../markets/analyzer";

// ---------------------------------------------------------------------------
// Every strategy implements this interface.
// The bot calls findOpportunities() on each enabled strategy, collects the
// results, ranks them, and executes the best ones.
// ---------------------------------------------------------------------------

export interface Strategy {
  name: string;
  description: string;
  findOpportunities(): Promise<Opportunity[]>;
}
