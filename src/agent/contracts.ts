import { z } from "zod";
import type { Proposal } from "@/ledger/proposals";
import type { MerchantTwin } from "@/twin/types";
import type { ComparisonResult } from "@/twin/simulate";
import type { StressResult } from "@/twin/stress";
import type { EvidenceSummary } from "@/signals/evidence";

export const DecisionRulesSchema = z.strictObject({
  discountBudget: z.number().finite().min(0).max(100000),
  maxProbWorse: z.number().finite().min(0).max(1),
  horizonMonths: z.number().int().min(1).max(12),
});
export type DecisionRules = z.infer<typeof DecisionRulesSchema>;
export const DEFAULT_DECISION_RULES: DecisionRules = { discountBudget: 1000, maxProbWorse: .5, horizonMonths: 12 };
export interface ClassificationSummary {
  total: number; accepted: number; unclassified: number; cacheHits: number;
  segments: EvidenceSummary["segments"]; intents: EvidenceSummary["intents"];
  eligiblePilotCount: number; pilotCount: number; mappingIssueCount: number;
  source: "AI-classified synthetic feedback";
}
/** Public activity and evidence only; never provider reasoning or hidden labels. */
export type AgentEvent =
  | { type: "status"; message: string }
  | { type: "tool_started"; name: string }
  | { type: "tool_result"; name: string; result: ToolResult }
  | { type: "classification"; summary: ClassificationSummary; hitmap: EvidenceSummary["segments"]; provenance: MerchantTwin["provenance"] }
  | { type: "rules"; rules: DecisionRules }
  | { type: "comparison"; comparison: ComparisonResult }
  | { type: "stress"; strategyId: string; stress: StressResult }
  | { type: "draft"; strategyId: string; message: string; displayOnly: true }
  | { type: "proposal"; proposal: Proposal; rationale: string; tradeoffs: string }
  | { type: "summary"; message: string }
  | { type: "done"; proposalId?: string }
  | { type: "error"; code: string; message: string };
export type ToolResult = { ok: true; data: unknown } | { ok: false; code: string; message: string };
