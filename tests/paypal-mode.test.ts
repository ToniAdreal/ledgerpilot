import { describe, expect, it } from "vitest";
import { getPayPalClient, normalizePayPalMode, PayPalNotConfiguredError } from "../src/lib/paypal";
import { buildHealthReport } from "../src/lib/health";

const NOW = () => new Date("2026-10-22T00:00:00Z");
const CREDS = { PAYPAL_CLIENT_ID: "fake-client-id", PAYPAL_CLIENT_SECRET: "fake-client-secret" };

describe("PAYPAL_MODE normalisation — factory and health agree", () => {
  it("normalises padded / cased values in the shared normaliser", () => {
    expect(normalizePayPalMode("sandbox")).toBe("sandbox");
    expect(normalizePayPalMode(" sandbox ")).toBe("sandbox");
    expect(normalizePayPalMode("\tSandbox\n")).toBe("sandbox");
    expect(normalizePayPalMode("SANDBOX")).toBe("sandbox");
    expect(normalizePayPalMode(" mock ")).toBe("mock");
    expect(normalizePayPalMode("staging")).toBe("mock");
    expect(normalizePayPalMode("  ")).toBe("mock");
    expect(normalizePayPalMode(undefined)).toBe("mock");
    expect(normalizePayPalMode(null)).toBe("mock");
  });

  it("a padded sandbox value selects the sandbox adapter (fails loudly without credentials)", () => {
    expect(() => getPayPalClient({ PAYPAL_MODE: " sandbox " })).toThrow(PayPalNotConfiguredError);
    expect(() => getPayPalClient({ PAYPAL_MODE: "\tSandbox\n" })).toThrow(PayPalNotConfiguredError);
  });

  it("a padded sandbox value with credentials returns a sandbox client", () => {
    expect(getPayPalClient({ PAYPAL_MODE: " sandbox ", ...CREDS }).mode).toBe("sandbox");
  });

  it("padded mock / blank / unknown values stay mock", () => {
    expect(getPayPalClient({ PAYPAL_MODE: " mock " }).mode).toBe("mock");
    expect(getPayPalClient({ PAYPAL_MODE: "  " }).mode).toBe("mock");
    expect(getPayPalClient({ PAYPAL_MODE: " staging " }).mode).toBe("mock");
  });

  it("factory and health report the same effective mode for every spelling", () => {
    for (const raw of ["sandbox", " sandbox ", "Sandbox", "mock", " mock ", "staging", "  ", ""]) {
      const env = { PAYPAL_MODE: raw, ...CREDS };
      expect(buildHealthReport(env, NOW).config.paypalMode).toBe(getPayPalClient(env).mode);
    }
  });

  it("health reports the trimmed raw value for a padded sandbox value", () => {
    const report = buildHealthReport({ PAYPAL_MODE: "  Sandbox  ", PAYPAL_WEBHOOK_ID: "WH-FAKE", ...CREDS }, NOW);
    expect(report.config.paypalModeRaw).toBe("Sandbox");
    expect(report.config.paypalMode).toBe("sandbox");
    expect(report.status).toBe("ok");
  });

  it("a padded unknown value still warns in health (not silently sandbox, not silently clean mock)", () => {
    const report = buildHealthReport({ PAYPAL_MODE: " staging " }, NOW);
    expect(report.config.paypalMode).toBe("mock");
    expect(report.status).toBe("degraded");
  });
});
