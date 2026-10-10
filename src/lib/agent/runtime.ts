/**
 * Process-wide agent runtime for the API routes: one PayPal client and
 * one ledger store per server process (globalThis so Next.js dev HMR
 * does not reset state between route invocations).
 */

import { getPayPalClient, type PayPalClient } from "../paypal";
import { LedgerStore } from "./store";

interface AgentRuntime {
  client: PayPalClient;
  store: LedgerStore;
}

const g = globalThis as unknown as { __ledgerpilotRuntime?: AgentRuntime };

export function getAgentRuntime(): AgentRuntime {
  if (!g.__ledgerpilotRuntime) {
    g.__ledgerpilotRuntime = { client: getPayPalClient(), store: new LedgerStore() };
  }
  return g.__ledgerpilotRuntime;
}
