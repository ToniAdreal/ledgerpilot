import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * API cache control is part of the hosted demo's honesty: every
 * `/api/*` response carries live money-shaped state — console read
 * models, plan state, KPIs — and a browser or shared cache serving
 * a stale copy after a webhook flips an invoice to PAID would
 * contradict the audit trail the product exists to keep. Until this
 * chunk no response carried any `Cache-Control` at all, so caching
 * was left to heuristics. The header lives in `next.config.mjs`
 * (Next.js config cannot import the TypeScript lib), so — in the
 * same discipline as the security-headers suite — these tests pin
 * the config's shape by invoking its real `headers()` function,
 * and the run's HTTP smoke test verifies the header actually
 * arrives on live API responses (and not on pages).
 */

const root = resolve(__dirname, "..");
const configSource = readFileSync(resolve(root, "next.config.mjs"), "utf8");
const security = readFileSync(resolve(root, "SECURITY.md"), "utf8");
const readme = readFileSync(resolve(root, "README.md"), "utf8");

type HeaderEntry = { key: string; value: string };
type HeaderRule = { source: string; headers: HeaderEntry[] };

async function loadHeaderRules(): Promise<HeaderRule[]> {
  const mod = (await import(
    pathToFileURL(resolve(root, "next.config.mjs")).href
  )) as { default: { headers: () => Promise<HeaderRule[]> } };
  return mod.default.headers();
}

describe("API cache control (next.config.mjs)", () => {
  it("applies Cache-Control: no-store to the API surface only", async () => {
    const rules = await loadHeaderRules();
    const apiRule = rules.find((r) => r.source === "/api/:path*");
    expect(apiRule).toBeDefined();
    expect(apiRule!.headers).toEqual([
      { key: "Cache-Control", value: "no-store" },
    ]);
  });

  it("keeps pages outside the no-store rule", async () => {
    const rules = await loadHeaderRules();
    const pageRule = rules.find((r) => r.source === "/:path*");
    expect(pageRule).toBeDefined();
    expect(
      pageRule!.headers.some((h) => h.key === "Cache-Control"),
    ).toBe(false);
    // Exactly one Cache-Control declaration exists in the config
    // (the config's header comment mentions the header in prose).
    expect(configSource.split('key: "Cache-Control"').length - 1).toBe(1);
  });

  it("uses the exact no-store value — never a cacheable directive", () => {
    expect(configSource).toContain('key: "Cache-Control"');
    expect(configSource).toContain('value: "no-store"');
    expect(configSource).not.toContain("public,");
    expect(configSource).not.toContain("s-maxage");
    expect(configSource).not.toContain("immutable");
  });

  it("scopes the rule to /api/:path* in the config source", () => {
    expect(configSource).toContain('source: "/api/:path*"');
  });

  it("is documented in SECURITY.md's security model and the README", () => {
    expect(security).toContain("API cache control");
    expect(security).toContain("Cache-Control: no-store");
    expect(readme).toContain("API cache control (no-store)");
    expect(readme).toContain("Cache-Control: no-store");
  });
});
