import { expect, it } from "vitest";
import { deploymentConfiguration } from "./deployment";

const env = { RENDER: "true", RENDER_EXTERNAL_URL: "https://example.onrender.com", LEDGER_BACKEND: "turso", TURSO_DATABASE_URL: "libsql://example.turso.io", TURSO_AUTH_TOKEN: "private", ADMIN_PASSWORD: "p".repeat(40), HOSTED_SECRET: "s".repeat(40), AI_PROVIDER: "gemini", GEMINI_MODEL: "gemini-3.5-flash-lite", GEMINI_API_KEY: "private", PAYPAL_CLIENT_ID: "private", PAYPAL_CLIENT_SECRET: "private" };
it("allows local manual mode and validates hosted Gemini/PayPal before any network, without requiring a webhook before bootstrap", () => {
  expect(() => deploymentConfiguration({})).not.toThrow();
  expect(() => deploymentConfiguration(env)).not.toThrow();
  expect(() => deploymentConfiguration({ ...env, AI_PROVIDER: "groq", GROQ_MODEL: "openai/gpt-oss-120b", GROQ_API_KEY: "private" })).not.toThrow();
  expect(() => deploymentConfiguration({ ...env, SIMULATION_RUNS: "300" })).not.toThrow();
  for (const patch of [{ ADMIN_PASSWORD: env.HOSTED_SECRET }, { ADMIN_PASSWORD: " ".repeat(40) }, { GEMINI_API_KEY: " " }, { GEMINI_MODEL: "bad model" }, { AI_PROVIDER: "groq" }, { PAYPAL_CLIENT_SECRET: " " }, { GEMINI_AGENT_RPM: "16" }, { LEDGER_PATH: "/tmp/ledger" }, { SIMULATION_RUNS: "99" }]) {
    expect(() => deploymentConfiguration({ ...env, ...patch })).toThrow("Invalid hosted configuration");
  }
});
