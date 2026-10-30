import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The Render Blueprint is part of the publish-ready facade: CONCEPT.md
 * §3.1/§3.4 make the hosted demo the judges' primary path, so the
 * descriptor that creates it must stay honest — it builds/starts with
 * the package's own scripts, probes the real health route, defaults
 * to credential-free mock mode, and never carries a secret value
 * (every credential variable is `sync: false`). These tests pin that
 * shape the same way the CI workflow's shape is pinned.
 */

const appRoot = resolve(__dirname, "..");
const blueprintPath = resolve(appRoot, "render.yaml");
const blueprint = readFileSync(blueprintPath, "utf8");
const packageJson = JSON.parse(
  readFileSync(resolve(appRoot, "package.json"), "utf8"),
) as { scripts: Record<string, string> };
const envExample = readFileSync(resolve(appRoot, ".env.example"), "utf8");

/** Keys of the `- key: NAME` env entries in the blueprint. */
function blueprintEnvKeys(source: string): string[] {
  return [...source.matchAll(/^\s+- key: ([A-Z0-9_]+)\s*$/gm)].map((m) => m[1]);
}

/** The blueprint block for one env var (its key line plus what follows). */
function envBlock(source: string, key: string): string {
  const start = source.indexOf(`- key: ${key}`);
  if (start === -1) return "";
  const rest = source.slice(start);
  const next = rest.indexOf("\n      - key:", 1);
  return next === -1 ? rest : rest.slice(0, next);
}

describe("deployment descriptor (render.yaml)", () => {
  it("declares one free-tier Node web service named ledgerpilot", () => {
    expect(blueprint).toContain("services:");
    expect(blueprint).toContain("type: web");
    expect(blueprint).toContain("name: ledgerpilot");
    expect(blueprint).toContain("runtime: node");
    expect(blueprint).toContain("plan: free");
  });

  it("builds and starts with the package's own scripts", () => {
    expect(packageJson.scripts.build).toBe("next build");
    expect(packageJson.scripts.start).toBe("next start");
    // --include=dev is load-bearing, not incidental: NODE_ENV=production
    // makes a plain `npm ci` omit devDependencies (including TypeScript),
    // which broke the first Render deploy (commit 32e3477). Pin it here so
    // a future "simplification" back to plain `npm ci` fails loudly.
    expect(blueprint).toContain(
      "buildCommand: npm ci --include=dev && npm run build",
    );
    expect(blueprint).toContain("startCommand: npm start");
    expect(blueprint).toContain('value: "22"');
  });

  it("health-checks the real readiness route", () => {
    expect(blueprint).toContain("healthCheckPath: /api/health");
    expect(
      existsSync(resolve(appRoot, "src/app/api/health/route.ts")),
    ).toBe(true);
  });

  it("defaults to credential-free mock mode", () => {
    const mode = envBlock(blueprint, "PAYPAL_MODE");
    expect(mode).toContain("value: mock");
    expect(mode).not.toContain("sync: false");
  });

  it("never stores a credential value — every secret is sync: false", () => {
    for (const key of [
      "PAYPAL_CLIENT_ID",
      "PAYPAL_CLIENT_SECRET",
      "PAYPAL_WEBHOOK_ID",
      "LLM_API_KEY",
    ]) {
      const block = envBlock(blueprint, key);
      expect(block, key).toContain("sync: false");
      expect(block, key).not.toContain("value:");
    }
    // And no credential-shaped literal anywhere in the file.
    expect(blueprint).not.toMatch(/PAYPAL_CLIENT_SECRET:\s*\S+/);
    expect(blueprint).not.toMatch(/sk-[A-Za-z0-9]/);
  });

  it("lists only variables the app actually reads (plus platform pins)", () => {
    const platformKeys = new Set(["NODE_VERSION", "NODE_ENV"]);
    for (const key of blueprintEnvKeys(blueprint)) {
      if (platformKeys.has(key)) continue;
      // Every app variable in the blueprint is documented for local
      // runs in .env.example — no undocumented knobs on the host.
      expect(envExample, key).toContain(key);
    }
  });

  it("covers every .env.example variable so hosting loses no knob", () => {
    const documented = [...envExample.matchAll(/^#?\s*([A-Z][A-Z0-9_]+)=/gm)].map(
      (m) => m[1],
    );
    const keys = new Set(blueprintEnvKeys(blueprint));
    for (const key of documented) {
      expect(keys.has(key), key).toBe(true);
    }
  });
});
