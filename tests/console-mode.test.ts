import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  HealthResultError,
  parseHealthWireResult,
  resolveModeDisplay,
  type ConsoleModeInfo,
} from "../src/lib/console/mode";
import { buildHealthReport } from "../src/lib/health";

/**
 * The console mode indicator: the console must say, on screen, which
 * PayPal mode the instance runs in (mock vs sandbox) — resolved from
 * the health report, never guessed, and secret-safe by construction
 * (only whitelisted fields survive the parser, and the badge copy is
 * built from booleans, not from report free text).
 */

const SENTINEL = "SENTINEL-SECRET-DO-NOT-RENDER";

function wire(overrides: Partial<ConsoleModeInfo> = {}): { health: { status: string; config: Record<string, unknown> } } {
  const info: ConsoleModeInfo = {
    healthStatus: "ok",
    paypalMode: "mock",
    sandboxCredentialsConfigured: false,
    sandboxWebhookConfigured: false,
    llmEnabled: false,
    ...overrides,
  };
  return {
    health: {
      status: info.healthStatus,
      config: {
        paypalMode: info.paypalMode,
        paypalModeRaw: info.paypalMode,
        sandboxCredentialsConfigured: info.sandboxCredentialsConfigured,
        sandboxWebhookConfigured: info.sandboxWebhookConfigured,
        ledgerPersistence: false,
        mockPersistence: false,
        llmEnabled: info.llmEnabled,
      },
    },
  };
}

describe("health wire validation", () => {
  it("accepts the route's shape and projects only the whitelisted fields", () => {
    const parsed = parseHealthWireResult(wire({ paypalMode: "sandbox", sandboxCredentialsConfigured: true, sandboxWebhookConfigured: true }));
    expect(parsed).toEqual({
      healthStatus: "ok",
      paypalMode: "sandbox",
      sandboxCredentialsConfigured: true,
      sandboxWebhookConfigured: true,
      llmEnabled: false,
    });
    expect(Object.keys(parsed).sort()).toEqual([
      "healthStatus",
      "llmEnabled",
      "paypalMode",
      "sandboxCredentialsConfigured",
      "sandboxWebhookConfigured",
    ]);
  });

  it("rejects malformed payloads with the field named", () => {
    expect(() => parseHealthWireResult(null)).toThrow(HealthResultError);
    expect(() => parseHealthWireResult("health")).toThrow(/must be a JSON object/);
    expect(() => parseHealthWireResult({})).toThrow(/'health'/);
    expect(() => parseHealthWireResult({ health: { status: "fine", config: {} } })).toThrow(/health\.status/);
    expect(() => parseHealthWireResult({ health: { status: "ok" } })).toThrow(/health\.config/);
    const badMode = wire();
    badMode.health.config.paypalMode = "live";
    expect(() => parseHealthWireResult(badMode)).toThrow(/paypalMode/);
    const badBool = wire();
    badBool.health.config.sandboxCredentialsConfigured = "yes";
    expect(() => parseHealthWireResult(badBool)).toThrow(/sandboxCredentialsConfigured/);
  });

  it("drops non-whitelisted report content: a sentinel in the payload never survives parsing or rendering", () => {
    const payload = wire({ paypalMode: "sandbox" }) as unknown as Record<string, unknown>;
    (payload.health as Record<string, unknown>).checks = [
      { name: "sandbox_credentials", status: "fail", detail: `leaked ${SENTINEL}` },
    ];
    ((payload.health as Record<string, unknown>).config as Record<string, unknown>).clientSecret = SENTINEL;
    const parsed = parseHealthWireResult(payload);
    expect(JSON.stringify(parsed)).not.toContain(SENTINEL);
    const display = resolveModeDisplay({ info: parsed, checked: true });
    expect(display.label + display.detail).not.toContain(SENTINEL);
  });
});

describe("mode badge resolution", () => {
  it("mock mode: full loop, no credentials, no real money", () => {
    const display = resolveModeDisplay({ info: parseHealthWireResult(wire()), checked: true });
    expect(display.tone).toBe("mock");
    expect(display.label).toBe("PayPal mode: Mock");
    expect(display.detail).toContain("mock adapter");
    expect(display.detail).toContain("no real money");
  });

  it("sandbox, fully configured: live sandbox REST, no real money", () => {
    const display = resolveModeDisplay({
      info: parseHealthWireResult(wire({ paypalMode: "sandbox", sandboxCredentialsConfigured: true, sandboxWebhookConfigured: true })),
      checked: true,
    });
    expect(display.tone).toBe("sandbox");
    expect(display.label).toBe("PayPal mode: Sandbox");
    expect(display.detail).toContain("Live PayPal sandbox REST");
  });

  it("sandbox without a webhook id: degraded, with the reconciler named as fallback", () => {
    const display = resolveModeDisplay({
      info: parseHealthWireResult(
        wire({ healthStatus: "degraded", paypalMode: "sandbox", sandboxCredentialsConfigured: true, sandboxWebhookConfigured: false }),
      ),
      checked: true,
    });
    expect(display.tone).toBe("warning");
    expect(display.detail).toContain("PAYPAL_WEBHOOK_ID is not set");
    expect(display.detail).toContain("sync reconciler");
  });

  it("sandbox without credentials: misconfigured on screen, with the remedy named", () => {
    const display = resolveModeDisplay({
      info: parseHealthWireResult(wire({ healthStatus: "misconfigured", paypalMode: "sandbox" })),
      checked: true,
    });
    expect(display.tone).toBe("error");
    expect(display.label).toContain("misconfigured");
    expect(display.detail).toContain("PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET are not both set");
    expect(display.detail).toContain("GET /api/health");
  });

  it("before the first read settles the mode is checking, never a guess; after a failed read it is unknown", () => {
    const checking = resolveModeDisplay({ info: null, checked: false });
    expect(checking.label).toBe("PayPal mode: checking…");
    const unknown = resolveModeDisplay({ info: null, checked: true });
    expect(unknown.tone).toBe("unknown");
    expect(unknown.label).toBe("PayPal mode: unknown");
    expect(unknown.detail).toContain("not guessed");
  });
});

describe("end to end from the real health report", () => {
  it("a default (mock) environment resolves to the Mock badge", () => {
    const report = buildHealthReport({}, () => new Date("2026-10-10T00:00:00Z"));
    const display = resolveModeDisplay({ info: parseHealthWireResult({ health: report }), checked: true });
    expect(display.label).toBe("PayPal mode: Mock");
  });

  it("a sandbox environment without credentials resolves to misconfigured — and the configured secret value never reaches the badge", () => {
    const report = buildHealthReport(
      { PAYPAL_MODE: "sandbox", PAYPAL_CLIENT_SECRET: SENTINEL },
      () => new Date("2026-10-10T00:00:00Z"),
    );
    const display = resolveModeDisplay({ info: parseHealthWireResult({ health: report }), checked: true });
    expect(display.tone).toBe("error");
    expect(display.label + display.detail).not.toContain(SENTINEL);
  });

  it("a fully configured sandbox environment resolves to the Sandbox badge", () => {
    const report = buildHealthReport(
      { PAYPAL_MODE: "sandbox", PAYPAL_CLIENT_ID: "fake-id", PAYPAL_CLIENT_SECRET: SENTINEL, PAYPAL_WEBHOOK_ID: "WH-FAKE" },
      () => new Date("2026-10-10T00:00:00Z"),
    );
    const display = resolveModeDisplay({ info: parseHealthWireResult({ health: report }), checked: true });
    expect(display.tone).toBe("sandbox");
    expect(display.label + display.detail).not.toContain(SENTINEL);
  });
});

describe("console wiring (shape)", () => {
  const client = readFileSync(resolve(__dirname, "../src/app/console-client.tsx"), "utf8");
  const css = readFileSync(resolve(__dirname, "../src/app/globals.css"), "utf8");

  it("the console fetches the health report and renders the resolved badge", () => {
    expect(client).toContain('fetch("/api/health")');
    expect(client).toContain("parseHealthWireResult");
    expect(client).toContain("resolveModeDisplay");
    expect(client).toContain("mode-strip");
  });

  it("every badge tone has a style", () => {
    for (const tone of ["mock", "sandbox", "warning", "error", "unknown"]) {
      expect(css).toContain(`.mode-strip-${tone}`);
    }
  });
});
