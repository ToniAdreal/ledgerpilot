/**
 * Console mode view-model — the PayPal mode indicator.
 *
 * The console is the product's home screen and the demo video's main
 * set, and LedgerPilot's honesty rules label demo data wherever it
 * appears (the sample dispute is flagged, mock checkout links are
 * labeled "mock"). Yet the console itself never said which PayPal
 * mode the instance is actually running in: the page header said
 * "Sandbox / mock mode only" generically, while the one place that
 * knows the real mode — the deployment health report at
 * `GET /api/health` — was never rendered anywhere. A judge watching
 * a loop close could not tell from the screen whether it closed
 * against the in-memory mock adapter or the live PayPal sandbox,
 * and an operator running a misconfigured sandbox instance saw
 * failing grids with no on-screen explanation.
 *
 * This module is the pure, unit-tested half of the indicator: it
 * validates the health route's wire shape and resolves the exact
 * badge copy. The component half (console-client) only fetches and
 * renders.
 *
 * Secret-safety, by construction: the parser keeps only whitelisted
 * fields (the health status, the mode, and configuration booleans)
 * and drops everything else, and the badge copy is built from those
 * booleans — never from free text in the report — so no credential
 * value or other report text can reach the screen through this path.
 * (The health report itself is secret-safe too; this is the second
 * lock on the same door, matching the evidence-summary discipline.)
 */

/* ------------------------------------------------------------------ */
/* Wire shape (GET /api/health)                                        */
/* ------------------------------------------------------------------ */

export type ConsoleMode = "mock" | "sandbox";

export interface ConsoleModeInfo {
  /** The health report's overall status. */
  healthStatus: "ok" | "degraded" | "misconfigured";
  /** Effective PayPal mode (the client factory's fallback applied). */
  paypalMode: ConsoleMode;
  sandboxCredentialsConfigured: boolean;
  sandboxWebhookConfigured: boolean;
  llmEnabled: boolean;
}

export class HealthResultError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HealthResultError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boolField(record: Record<string, unknown>, field: string): boolean {
  const value = record[field];
  if (typeof value !== "boolean") {
    throw new HealthResultError(`Health response field 'health.config.${field}' must be a boolean`);
  }
  return value;
}

/**
 * Validate an unknown JSON payload as the health route's wire shape
 * (`{ health: { status, config } }`) and project it onto the fields
 * the mode indicator is allowed to see. A malformed payload throws
 * `HealthResultError`; the console then shows the mode as unknown
 * rather than guessing one.
 */
export function parseHealthWireResult(data: unknown): ConsoleModeInfo {
  if (!isRecord(data)) throw new HealthResultError("Health response must be a JSON object");
  if (!isRecord(data.health)) throw new HealthResultError("Health response field 'health' must be an object");
  const health = data.health;
  if (health.status !== "ok" && health.status !== "degraded" && health.status !== "misconfigured") {
    throw new HealthResultError("Health response field 'health.status' must be ok, degraded, or misconfigured");
  }
  if (!isRecord(health.config)) throw new HealthResultError("Health response field 'health.config' must be an object");
  const config = health.config;
  if (config.paypalMode !== "mock" && config.paypalMode !== "sandbox") {
    throw new HealthResultError("Health response field 'health.config.paypalMode' must be mock or sandbox");
  }
  return {
    healthStatus: health.status,
    paypalMode: config.paypalMode,
    sandboxCredentialsConfigured: boolField(config, "sandboxCredentialsConfigured"),
    sandboxWebhookConfigured: boolField(config, "sandboxWebhookConfigured"),
    llmEnabled: boolField(config, "llmEnabled"),
  };
}

/* ------------------------------------------------------------------ */
/* Badge resolution                                                    */
/* ------------------------------------------------------------------ */

export type ModeTone = "mock" | "sandbox" | "warning" | "error" | "unknown";

export interface ModeDisplay {
  tone: ModeTone;
  label: string;
  detail: string;
}

/**
 * The badge copy for one health state.
 *
 * Rules:
 *  - Before the first health read settles, the mode is "checking" —
 *    never a guessed mode.
 *  - If the health report cannot be read or fails validation, the
 *    mode is "unknown": the console data is unaffected, but no mode
 *    is claimed.
 *  - A misconfigured sandbox says so on screen, with the remedy
 *    (set both credential variables) — the grids failing underneath
 *    it are then explained, not mysterious.
 *  - Sandbox without a webhook id is live but degraded: the sync
 *    reconciler is named as the fallback that still closes loops.
 *  - Every resolved mode ends with the no-real-money line: mock and
 *    sandbox are both incapable of moving real money, and the badge
 *    is where a viewer should learn that.
 */
export function resolveModeDisplay(input: { info: ConsoleModeInfo | null; checked: boolean }): ModeDisplay {
  const { info, checked } = input;
  if (!info) {
    return checked
      ? {
          tone: "unknown",
          label: "PayPal mode: unknown",
          detail:
            "The deployment health report (GET /api/health) could not be read, so the mode is not guessed. The console data below is unaffected.",
        }
      : {
          tone: "unknown",
          label: "PayPal mode: checking…",
          detail: "Reading the deployment health report (GET /api/health).",
        };
  }

  if (info.paypalMode === "mock") {
    return {
      tone: "mock",
      label: "PayPal mode: Mock",
      detail:
        "The full loop runs against the in-memory mock adapter — no PayPal account, no credentials, and no real money moves.",
    };
  }

  if (!info.sandboxCredentialsConfigured) {
    return {
      tone: "error",
      label: "PayPal mode: Sandbox — misconfigured",
      detail:
        "PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET are not both set, so PayPal-backed actions will fail until they are configured on this instance. See GET /api/health. No real money moves.",
    };
  }

  if (!info.sandboxWebhookConfigured) {
    return {
      tone: "warning",
      label: "PayPal mode: Sandbox",
      detail:
        "Live PayPal sandbox REST via the configured app — sandbox only, no real money moves. PAYPAL_WEBHOOK_ID is not set, so webhook deliveries cannot be verified; the sync reconciler (Sync from PayPal) is the fallback.",
    };
  }

  return {
    tone: "sandbox",
    label: "PayPal mode: Sandbox",
    detail: "Live PayPal sandbox REST via the configured app — sandbox only, no real money moves.",
  };
}
