/**
 * Process-wide agent runtime for the API routes: one PayPal client and
 * one ledger store per server process (globalThis so Next.js dev HMR
 * does not reset state between route invocations).
 */

import { getPayPalClient, type PayPalClient } from "../paypal";
import { getDefaultLlmAdapter, type LlmBriefExtractor } from "./llm";
import { LedgerStore } from "./store";

interface AgentRuntime {
  client: PayPalClient;
  store: LedgerStore;
  /** Optional LLM fallback for brief parsing; null unless LLM_API_KEY is set. */
  llm: LlmBriefExtractor | null;
}

const g = globalThis as unknown as { __ledgerpilotRuntime?: AgentRuntime };

export function getAgentRuntime(): AgentRuntime {
  if (!g.__ledgerpilotRuntime) {
    g.__ledgerpilotRuntime = { client: getPayPalClient(), store: new LedgerStore(), llm: getDefaultLlmAdapter() };
  }
  return g.__ledgerpilotRuntime;
}
