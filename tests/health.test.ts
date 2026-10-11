import { describe, expect, it } from "vitest";
import { buildHealthReport, healthHttpStatus } from "../src/lib/health";

const NOW = () => new Date("2026-10-10T12:00:00.000Z");

function check(report: ReturnType<typeof buildHealthReport>, name: string) {
  const found = report.checks.find((c) => c.name === name);
  if (!found) throw new Error(`missing check ${name}`);
  return found;
}

describe("health report — mock mode (the zero-setup judge run)", () => {
  it("empty env is ok: mock default, nothing required, timestamp from the injected clock", () => {
    const report = buildHealthReport({}, NOW);
    expect(report.service).toBe("ledgerpilot");
    expect(report.status).toBe("ok");
    expect(report.timestamp).toBe("2026-10-10T12:00:00.000Z");
    expect(report.config.paypalMode).toBe("mock");
    expect(report.config.paypalModeRaw).toBe("");
    expect(report.config.sandboxCredentialsConfigured).toBe(false);
    expect(report.config.ledgerPersistence).toBe(false);
    expect(report.config.mockPersistence).toBe(false);
    expect(report.config.llmEnabled).toBe(false);
    expect(check(report, "paypal_mode").detail).toContain("unset");
    expect(check(report, "sandbox_credentials").status).toBe("pass");
    expect(healthHttpStatus(report)).toBe(200);
  });

  it("explicit mock with both persistence files + LLM key stays ok and reports the config", () => {
    const report = buildHealthReport(
      {
        PAYPAL_MODE: "mock",
        LEDGERPILOT_STORE_FILE: "./ledger.json",
        PAYPAL_MOCK_STORE_FILE: "./mock.json",
        LLM_API_KEY: "sk-sentinel-llm-key",
      },
      NOW,
    );
    expect(report.status).toBe("ok");
    expect(report.config.ledgerPersistence).toBe(true);
    expect(report.config.mockPersistence).toBe(true);
    expect(report.config.llmEnabled).toBe(true);
    expect(check(report, "ledger_persistence").detail).toContain("survive restarts");
    expect(check(report, "llm_adapter").detail).toContain("deterministic parser still runs first");
  });

  it("an unknown PAYPAL_MODE value warns (factory falls back to mock) but is not misconfigured", () => {
    const report = buildHealthReport({ PAYPAL_MODE: "staging" }, NOW);
    expect(report.config.paypalMode).toBe("mock");
    expect(report.config.paypalModeRaw).toBe("staging");
    expect(report.status).toBe("degraded");
    expect(check(report, "paypal_mode").status).toBe("warn");
    expect(check(report, "paypal_mode").detail).toContain("falls back to mock");
    expect(healthHttpStatus(report)).toBe(200);
  });

  it("blank / whitespace env values count as unset everywhere", () => {
    const report = buildHealthReport(
      { PAYPAL_MODE: "  ", LEDGERPILOT_STORE_FILE: " ", LLM_API_KEY: "\t" },
      NOW,
    );
    expect(report.status).toBe("ok");
    expect(report.config.paypalModeRaw).toBe("");
    expect(report.config.ledgerPersistence).toBe(false);
    expect(report.config.llmEnabled).toBe(false);
  });
});

describe("health report — sandbox mode", () => {
  it("fully configured sandbox is ok (mode match is case-insensitive)", () => {
    const report = buildHealthReport(
      {
        PAYPAL_MODE: "Sandbox",
        PAYPAL_CLIENT_ID: "sentinel-client-id",
        PAYPAL_CLIENT_SECRET: "sentinel-client-secret",
        PAYPAL_WEBHOOK_ID: "WH-sentinel",
      },
      NOW,
    );
    expect(report.status).toBe("ok");
    expect(report.config.paypalMode).toBe("sandbox");
    expect(report.config.sandboxCredentialsConfigured).toBe(true);
    expect(report.config.sandboxWebhookConfigured).toBe(true);
    expect(check(report, "mock_persistence").detail).toContain("Not applicable in sandbox mode");
    expect(healthHttpStatus(report)).toBe(200);
  });

  it("sandbox without credentials is misconfigured → 503, naming only the missing variables", () => {
    const report = buildHealthReport({ PAYPAL_MODE: "sandbox" }, NOW);
    expect(report.status).toBe("misconfigured");
    const creds = check(report, "sandbox_credentials");
    expect(creds.status).toBe("fail");
    expect(creds.detail).toContain("PAYPAL_CLIENT_ID");
    expect(creds.detail).toContain("PAYPAL_CLIENT_SECRET");
    expect(healthHttpStatus(report)).toBe(503);
  });

  it("sandbox with only one credential names exactly the other one", () => {
    const report = buildHealthReport(
      { PAYPAL_MODE: "sandbox", PAYPAL_CLIENT_ID: "sentinel-client-id", PAYPAL_WEBHOOK_ID: "WH-1" },
      NOW,
    );
    expect(report.status).toBe("misconfigured");
    const creds = check(report, "sandbox_credentials");
    expect(creds.detail).toContain("PAYPAL_CLIENT_SECRET");
    expect(creds.detail).not.toContain("PAYPAL_CLIENT_ID,");
    expect(report.config.sandboxCredentialsConfigured).toBe(false);
  });

  it("sandbox with credentials but no webhook id is degraded, not misconfigured (sync fallback)", () => {
    const report = buildHealthReport(
      {
        PAYPAL_MODE: "sandbox",
        PAYPAL_CLIENT_ID: "sentinel-client-id",
        PAYPAL_CLIENT_SECRET: "sentinel-client-secret",
      },
      NOW,
    );
    expect(report.status).toBe("degraded");
    const webhook = check(report, "sandbox_webhook");
    expect(webhook.status).toBe("warn");
    expect(webhook.detail).toContain("/api/paypal/sync");
    expect(healthHttpStatus(report)).toBe(200);
  });
});

describe("health report — secret safety", () => {
  it("no credential value from the env ever appears anywhere in the report", () => {
    const env = {
      PAYPAL_MODE: "sandbox",
      PAYPAL_CLIENT_ID: "SENTINEL_ID_9f8e7d",
      PAYPAL_CLIENT_SECRET: "SENTINEL_SECRET_1a2b3c",
      PAYPAL_WEBHOOK_ID: "SENTINEL_WEBHOOK_4d5e6f",
      LLM_API_KEY: "SENTINEL_LLM_7a8b9c",
      LEDGERPILOT_STORE_FILE: "./ledger.json",
    };
    const serialized = JSON.stringify(buildHealthReport(env, NOW));
    for (const value of Object.values(env)) {
      if (value === "sandbox" || value === "./ledger.json") continue;
      expect(serialized).not.toContain(value);
    }
  });

  it("every check is present exactly once, in a stable order", () => {
    const names = buildHealthReport({}, NOW).checks.map((c) => c.name);
    expect(names).toEqual([
      "paypal_mode",
      "sandbox_credentials",
      "sandbox_webhook",
      "ledger_persistence",
      "mock_persistence",
      "llm_adapter",
    ]);
  });
});
