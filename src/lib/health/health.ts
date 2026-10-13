/**
 * Deployment readiness — the health report behind `GET /api/health`.
 *
 * Why this exists: the hosted demo is the judges' primary path, and a
 * hosted instance can be *up* while being unable to do any PayPal work
 * (e.g. `PAYPAL_MODE=sandbox` deployed without credentials — runtime
 * construction then throws `PayPalNotConfiguredError`, which the API
 * routes translate into a structured 503; see `src/lib/api/errors.ts`).
 * This
 * report lets the operator (and the hosting platform's health check)
 * distinguish "app alive, mock mode, zero setup" from "app alive but
 * misconfigured" without opening the console and guessing.
 *
 * Rules:
 *  - Built from the environment ONLY. It never constructs the agent
 *    runtime or a PayPal client, so it works precisely when the rest of
 *    the app cannot — a misconfigured sandbox reports itself instead of
 *    500-ing the health endpoint too.
 *  - Secret-safe by construction: the report carries booleans and the
 *    NAMES of missing variables, never a credential value (tests pin
 *    this with sentinel secrets).
 *  - Deterministic: pure function of (env, injected clock), same
 *    discipline as the parser / read models / view-models elsewhere.
 */

export type HealthStatus = "ok" | "degraded" | "misconfigured";

export type HealthCheckStatus = "pass" | "warn" | "fail";

export interface HealthCheck {
  name: string;
  status: HealthCheckStatus;
  detail: string;
}

export interface HealthConfig {
  /** Effective PayPal mode after the factory's fallback rule. */
  paypalMode: "mock" | "sandbox";
  /** The raw PAYPAL_MODE value as supplied ("" when unset). */
  paypalModeRaw: string;
  sandboxCredentialsConfigured: boolean;
  sandboxWebhookConfigured: boolean;
  ledgerPersistence: boolean;
  /** Mock mode only; in sandbox mode resources live at PayPal. */
  mockPersistence: boolean;
  llmEnabled: boolean;
}

export interface HealthReport {
  service: "ledgerpilot";
  status: HealthStatus;
  /** ISO timestamp from the injected clock. */
  timestamp: string;
  config: HealthConfig;
  checks: HealthCheck[];
}

const SANDBOX_REQUIRED = ["PAYPAL_CLIENT_ID", "PAYPAL_CLIENT_SECRET"] as const;

function nonBlank(env: Record<string, string | undefined>, name: string): boolean {
  return typeof env[name] === "string" && env[name]!.trim().length > 0;
}

export function buildHealthReport(
  env: Record<string, string | undefined> = process.env,
  now: () => Date = () => new Date(),
): HealthReport {
  const paypalModeRaw = (env.PAYPAL_MODE ?? "").trim();
  const modeLower = paypalModeRaw.toLowerCase();
  // The client factory's rule: only "sandbox" selects the sandbox
  // adapter; anything else (including unset) is mock. Mirror it here.
  const paypalMode: "mock" | "sandbox" = modeLower === "sandbox" ? "sandbox" : "mock";

  const sandboxCredentialsConfigured = SANDBOX_REQUIRED.every((name) => nonBlank(env, name));
  const sandboxWebhookConfigured = nonBlank(env, "PAYPAL_WEBHOOK_ID");
  const missingCredentials = SANDBOX_REQUIRED.filter((name) => !nonBlank(env, name));

  const config: HealthConfig = {
    paypalMode,
    paypalModeRaw,
    sandboxCredentialsConfigured,
    sandboxWebhookConfigured,
    ledgerPersistence: nonBlank(env, "LEDGERPILOT_STORE_FILE"),
    mockPersistence: nonBlank(env, "PAYPAL_MOCK_STORE_FILE"),
    llmEnabled: nonBlank(env, "LLM_API_KEY"),
  };

  const checks: HealthCheck[] = [];

  if (paypalModeRaw === "" || modeLower === "mock") {
    checks.push({
      name: "paypal_mode",
      status: "pass",
      detail:
        paypalModeRaw === ""
          ? "PAYPAL_MODE unset — mock mode (the default, zero credentials)."
          : "PAYPAL_MODE=mock — full loop against the mock adapter, zero credentials.",
    });
  } else if (paypalMode === "sandbox") {
    checks.push({
      name: "paypal_mode",
      status: "pass",
      detail: "PAYPAL_MODE=sandbox — live sandbox REST via the caller's own app.",
    });
  } else {
    checks.push({
      name: "paypal_mode",
      status: "warn",
      detail: `PAYPAL_MODE="${paypalModeRaw}" is not a known mode — the client factory falls back to mock.`,
    });
  }

  if (paypalMode === "sandbox") {
    checks.push(
      sandboxCredentialsConfigured
        ? {
            name: "sandbox_credentials",
            status: "pass",
            detail: "PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET are set (values never reported).",
          }
        : {
            name: "sandbox_credentials",
            status: "fail",
            detail: `Missing ${missingCredentials.join(", ")} — runtime-backed PayPal routes answer 503 until they are set.`,
          },
    );
    checks.push(
      sandboxWebhookConfigured
        ? {
            name: "sandbox_webhook",
            status: "pass",
            detail: "PAYPAL_WEBHOOK_ID is set — webhook signatures can be verified.",
          }
        : {
            name: "sandbox_webhook",
            status: "warn",
            detail:
              "PAYPAL_WEBHOOK_ID unset — webhook deliveries cannot be verified and are rejected; the sync reconciler (GET /api/paypal/sync) remains the fallback.",
          },
    );
  } else {
    checks.push({
      name: "sandbox_credentials",
      status: "pass",
      detail: "Not required in mock mode.",
    });
    checks.push({
      name: "sandbox_webhook",
      status: "pass",
      detail: "Not required in mock mode — the mock adapter verifies its deterministic signature scheme.",
    });
  }

  checks.push({
    name: "ledger_persistence",
    status: "pass",
    detail: config.ledgerPersistence
      ? "LEDGERPILOT_STORE_FILE set — plans, audit log, and webhook idempotency survive restarts."
      : "LEDGERPILOT_STORE_FILE unset — ledger is in-memory (plans/audit reset on restart). Fine for a judge run; set it on a long-lived host.",
  });

  checks.push({
    name: "mock_persistence",
    status: "pass",
    detail:
      paypalMode === "sandbox"
        ? "Not applicable in sandbox mode — resources live at PayPal and are re-fetched."
        : config.mockPersistence
          ? "PAYPAL_MOCK_STORE_FILE set — mock resources survive restarts."
          : "PAYPAL_MOCK_STORE_FILE unset — mock resources are in-memory. Fine for a judge run; set it (with LEDGERPILOT_STORE_FILE) on a long-lived host.",
  });

  checks.push({
    name: "llm_adapter",
    status: "pass",
    detail: config.llmEnabled
      ? "LLM_API_KEY set — the optional LLM fallback is enabled (deterministic parser still runs first)."
      : "LLM_API_KEY unset — deterministic agent only; the app is fully functional, Judge Mode included.",
  });

  const status: HealthStatus = checks.some((c) => c.status === "fail")
    ? "misconfigured"
    : checks.some((c) => c.status === "warn")
      ? "degraded"
      : "ok";

  return { service: "ledgerpilot", status, timestamp: now().toISOString(), config, checks };
}

/**
 * HTTP mapping for the route: a misconfigured instance fails the
 * platform health check (503) so the operator notices; a degraded one
 * (warnings only — the app still works via its fallbacks) stays up.
 */
export function healthHttpStatus(report: HealthReport): 200 | 503 {
  return report.status === "misconfigured" ? 503 : 200;
}
