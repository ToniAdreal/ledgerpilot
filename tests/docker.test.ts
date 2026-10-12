import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The Dockerfile is the container deployment descriptor for the
 * hosted demo — the universal fallback next to the Render
 * Blueprint (render.yaml). CONCEPT.md §3.1/§3.4 make the hosted
 * demo the judges' primary path, so the descriptor must stay
 * honest: every stage pins the project's Node 22 runtime, it
 * builds and starts with the package's own scripts, it defaults
 * to credential-free mock mode, its health check probes the real
 * readiness route, and no secret value is ever baked in. These
 * tests pin that shape the same way render.yaml's shape is pinned.
 */

const appRoot = resolve(__dirname, "..");
const dockerfilePath = resolve(appRoot, "Dockerfile");
const dockerfile = existsSync(dockerfilePath)
  ? readFileSync(dockerfilePath, "utf8")
  : "";
const dockerignorePath = resolve(appRoot, ".dockerignore");
const dockerignore = existsSync(dockerignorePath)
  ? readFileSync(dockerignorePath, "utf8")
  : "";
const packageJson = JSON.parse(
  readFileSync(resolve(appRoot, "package.json"), "utf8"),
) as { scripts: Record<string, string> };
const readme = readFileSync(resolve(appRoot, "README.md"), "utf8");

const fromLines = dockerfile
  .split("\n")
  .map((line) => line.trim())
  .filter((line) => line.startsWith("FROM "));

describe("container descriptor (Dockerfile)", () => {
  it("exists at the repo root with build and run instructions", () => {
    expect(existsSync(dockerfilePath)).toBe(true);
    expect(dockerfile.length).toBeGreaterThan(800);
    expect(dockerfile).toContain("docker build -t ledgerpilot .");
    expect(dockerfile).toContain("docker run");
  });

  it("pins the project's Node major on every stage", () => {
    expect(fromLines.length).toBeGreaterThanOrEqual(2);
    for (const line of fromLines) {
      expect(line).toMatch(/^FROM node:22-/);
    }
  });

  it("installs and builds with the package's own scripts", () => {
    expect(packageJson.scripts.build).toBe("next build");
    expect(packageJson.scripts.start).toBe("next start");
    expect(dockerfile).toContain("RUN npm ci");
    expect(dockerfile).toContain("RUN npm run build");
    expect(dockerfile).toContain('CMD ["npm", "start"]');
  });

  it("defaults to credential-free mock mode", () => {
    expect(dockerfile).toContain("ENV PAYPAL_MODE=mock");
    expect(dockerfile).toContain("Judge Mode works");
  });

  it("bakes in no credential value — secrets are runtime-only", () => {
    expect(dockerfile).not.toMatch(/PAYPAL_CLIENT_SECRET\s*=\s*\S+/);
    expect(dockerfile).not.toMatch(/PAYPAL_CLIENT_ID\s*=\s*\S+/);
    expect(dockerfile).not.toMatch(/LLM_API_KEY\s*=\s*\S+/);
    expect(dockerfile).not.toMatch(/sk-[A-Za-z0-9]/);
    expect(dockerfile.toLowerCase()).toContain("no credential value is ever baked");
  });

  it("health-checks the real readiness route", () => {
    expect(dockerfile).toContain("HEALTHCHECK");
    expect(dockerfile).toContain("/api/health");
    expect(
      existsSync(resolve(appRoot, "src/app/api/health/route.ts")),
    ).toBe(true);
  });

  it("serves on port 3000 bound to all interfaces, in production mode", () => {
    expect(dockerfile).toContain("ENV NODE_ENV=production");
    expect(dockerfile).toContain("ENV PORT=3000");
    expect(dockerfile).toContain("ENV HOSTNAME=0.0.0.0");
    expect(dockerfile).toContain("EXPOSE 3000");
  });

  it("runs as the non-root node user, set before the start command", () => {
    const userAt = dockerfile.indexOf("USER node");
    const cmdAt = dockerfile.indexOf('CMD ["npm", "start"]');
    expect(userAt).toBeGreaterThan(-1);
    expect(cmdAt).toBeGreaterThan(userAt);
    expect(dockerfile).not.toContain("USER root");
  });

  it(".dockerignore keeps local state and secrets out of the context", () => {
    expect(existsSync(dockerignorePath)).toBe(true);
    const lines = dockerignore
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#"));
    for (const entry of [
      ".git",
      "node_modules",
      ".next",
      ".env",
      ".env.local",
      "*.ledger.json",
      "*.mock-paypal.json",
    ]) {
      expect(lines, entry).toContain(entry);
    }
    // The build must still see the sources and manifests.
    expect(lines).not.toContain("src");
    expect(lines).not.toContain("package.json");
    expect(lines).not.toContain("package-lock.json");
  });

  it("is referenced from the README", () => {
    expect(readme).toContain("Dockerfile");
    expect(readme).toContain("docker build");
  });
});
