import type { PayPalClient } from "./client";
import { MockPayPalClient } from "./mock";
import { SandboxPayPalClient } from "./sandbox";

export * from "./client";
export * from "./mock";
export * from "./sandbox";

/**
 * Factory: PAYPAL_MODE=mock (default) | sandbox.
 * Mock-first remains the default — sandbox requires the caller's own
 * PayPal Developer app credentials and implements the live REST surface
 * behind the same contract (not yet exercised against a live sandbox
 * account; see sandbox.ts).
 */
export function getPayPalClient(env: Record<string, string | undefined> = process.env): PayPalClient {
  const mode = (env.PAYPAL_MODE ?? "mock").toLowerCase();
  if (mode === "sandbox") {
    return new SandboxPayPalClient({
      clientId: env.PAYPAL_CLIENT_ID,
      clientSecret: env.PAYPAL_CLIENT_SECRET,
      webhookId: env.PAYPAL_WEBHOOK_ID,
    });
  }
  return new MockPayPalClient();
}
