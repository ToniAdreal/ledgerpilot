import type { PayPalClient } from "./client";
import { MOCK_PAYPAL_STORE_FILE_ENV, MockPayPalClient } from "./mock";
import { normalizePayPalMode } from "./mode";
import { SandboxPayPalClient } from "./sandbox";

export * from "./client";
export * from "./mock";
export * from "./mode";
export * from "./sandbox";

/**
 * Factory: PAYPAL_MODE=mock (default) | sandbox.
 * Mock-first remains the default — sandbox requires the caller's own
 * PayPal Developer app credentials and implements the live REST surface
 * behind the same contract (live-verified against the sandbox on
 * 2026-10-16; see sandbox.ts). The mode value is normalised by
 * `normalizePayPalMode` (trimmed + lower-cased; see mode.ts), the same
 * normaliser the health report uses, so the two surfaces cannot
 * disagree about which adapter is live.
 */
export function getPayPalClient(env: Record<string, string | undefined> = process.env): PayPalClient {
  const mode = normalizePayPalMode(env.PAYPAL_MODE);
  if (mode === "sandbox") {
    return new SandboxPayPalClient({
      clientId: env.PAYPAL_CLIENT_ID,
      clientSecret: env.PAYPAL_CLIENT_SECRET,
      webhookId: env.PAYPAL_WEBHOOK_ID,
    });
  }
  // Mock mode: in-memory by default; PAYPAL_MOCK_STORE_FILE (non-blank)
  // turns on the mock adapter's opt-in snapshot persistence.
  const mockFilePath = env[MOCK_PAYPAL_STORE_FILE_ENV]?.trim();
  return new MockPayPalClient(mockFilePath ? { filePath: mockFilePath } : {});
}
