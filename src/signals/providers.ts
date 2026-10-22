import "server-only";
import { z } from "zod";
import type { ModelInput } from "./contracts";
import { CLASSIFICATION_INSTRUCTION, CLASSIFICATION_JSON_SCHEMA, modelInputJSON } from "./prompt";
import { createTransport, type ProviderConfig, type ProviderName, type ProviderResult } from "./transport";

export { createTransport, emptyMetrics } from "./transport";
export type { ProviderConfig, ProviderName, SafeProviderError, QuotaViolation, Usage, AttemptMetric, ProviderMetrics, ProviderResult } from "./transport";

export interface ClassificationProvider {
  provider: ProviderName;
  model: string;
  classify(inputs: ModelInput[]): Promise<ProviderResult>;
}

const geminiEnvelope = z.object({ candidates: z.array(z.object({ content: z.object({ parts: z.array(z.object({ text: z.string().optional(), thought: z.boolean().optional() })) }) })).min(1) });
const groqEnvelope = z.object({ choices: z.array(z.object({ message: z.object({ content: z.string() }) })).min(1) });

/** Strict classification and tool calling intentionally use separate request bodies. */
export function createProvider(config: ProviderConfig): ClassificationProvider {
  const transport = createTransport(config);
  return {
    provider: transport.provider,
    model: transport.model,
    async classify(inputs) {
      const content = modelInputJSON(inputs);
      const body = config.provider === "gemini" ? {
        systemInstruction: { parts: [{ text: CLASSIFICATION_INSTRUCTION }] },
        contents: [{ role: "user", parts: [{ text: content }] }],
        generationConfig: {
          maxOutputTokens: 4096,
          thinkingConfig: { thinkingLevel: "LOW" },
          responseFormat: { text: { mimeType: "APPLICATION_JSON", schema: CLASSIFICATION_JSON_SCHEMA } },
        },
      } : {
        messages: [{ role: "system", content: CLASSIFICATION_INSTRUCTION }, { role: "user", content }],
        stream: false,
        max_completion_tokens: 4096,
        reasoning_effort: "low",
        response_format: { type: "json_schema", json_schema: { name: "feedback", strict: true, schema: CLASSIFICATION_JSON_SCHEMA } },
      };
      const result = await transport.send(body);
      if (result.error) return result;
      let text: string | undefined;
      if (config.provider === "gemini") {
        const parsed = geminiEnvelope.safeParse(result.payload);
        if (parsed.success) text = parsed.data.candidates[0].content.parts.filter((part) => !part.thought).map((part) => part.text ?? "").join("");
      } else {
        const parsed = groqEnvelope.safeParse(result.payload);
        if (parsed.success) text = parsed.data.choices[0].message.content;
      }
      let category: "envelope" | "malformed_json" = "envelope";
      if (text) {
        try { return { ...result, payload: JSON.parse(text) as unknown }; }
        catch { category = "malformed_json"; }
      }
      const last = result.metrics.attempts.at(-1)!;
      const error = { provider: transport.provider, model: transport.model, category, retryCount: result.metrics.retries, quota: last.quota, status: last.status };
      last.error = error;
      return { metrics: result.metrics, error, terminal: false };
    },
  };
}
