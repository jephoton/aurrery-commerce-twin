import "server-only";
import { createProvider, emptyMetrics, type ClassificationProvider, type ProviderConfig } from "@/signals/providers";
import { CLASSIFICATION_INSTRUCTION, CLASSIFICATION_JSON_SCHEMA, modelInputJSON } from "@/signals/prompt";
import { RunLimitError, type createRunBudget } from "./limits";

type Budget = Pick<ReturnType<typeof createRunBudget>, "prepare">;

/**
 * A classifier whose every request is paced against a run budget before the provider's attempt timer starts,
 * mirroring only the frozen provider's request shape. By default a budget limit propagates (agent runs). With
 * `onLimit: "stop"`, a budget limit (deadline, tokens, cancellation) becomes a terminal provider result, so
 * `classifyFeedback` returns partial results instead of throwing.
 */
export function createBudgetedClassifier(config: ProviderConfig & { model: string }, budget: Budget, options: { onLimit?: "throw" | "stop" } = {}): ClassificationProvider {
  const classifier = createProvider(config);
  return { ...classifier, async classify(inputs) {
    try {
      await budget.prepare(config.provider === "gemini" ? {
        systemInstruction: { parts: [{ text: CLASSIFICATION_INSTRUCTION }] },
        contents: [{ role: "user", parts: [{ text: modelInputJSON(inputs) }] }],
        generationConfig: { maxOutputTokens: 4096, thinkingConfig: { thinkingLevel: "LOW" }, responseFormat: { text: { mimeType: "APPLICATION_JSON", schema: CLASSIFICATION_JSON_SCHEMA } } },
      } : { messages: [{ role: "system", content: CLASSIFICATION_INSTRUCTION }, { role: "user", content: modelInputJSON(inputs) }], stream: false, max_completion_tokens: 4096, reasoning_effort: "low", response_format: { type: "json_schema", json_schema: { name: "feedback", strict: true, schema: CLASSIFICATION_JSON_SCHEMA } }, model: config.model });
      return await classifier.classify(inputs);
    } catch (error) {
      if (options.onLimit !== "stop" || !(error instanceof RunLimitError)) throw error;
      return { metrics: emptyMetrics(), error: { provider: classifier.provider, model: classifier.model, category: "timeout", retryCount: 0, quota: {} }, terminal: true };
    }
  } };
}
