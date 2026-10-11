import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import robots from "../src/app/robots";

const appDir = join(process.cwd(), "src", "app");
const read = (name: string) => readFileSync(join(appDir, name), "utf8");

describe("App Router special files (not-found / error / loading / icon / robots)", () => {
  it("not-found is branded, says 404, and routes back to the console and Judge Mode", () => {
    const src = read("not-found.tsx");
    expect(src).toContain("404 — Page not found");
    expect(src).toContain('href="/"');
    expect(src).toContain('href="/judge"');
    expect(src).toContain("does not exist");
    // A 404 page must never invent contact details or credentials.
    expect(src).not.toMatch(/[\w.]+@[\w.]+\.\w+/);
  });

  it("error boundary is a client component that retries via reset and never renders the stack", () => {
    const src = read("error.tsx");
    expect(src.startsWith('"use client";')).toBe(true);
    expect(src).toContain("reset: () => void");
    expect(src).toContain("onClick={() => reset()}");
    expect(src).toContain("Something went wrong");
    expect(src).toContain("error.digest");
    expect(src).not.toContain("error.stack");
    expect(src).not.toContain("error.message");
    expect(src).toContain('href="/"');
  });

  it("global-error carries its own html/body shell and the same no-stack rule", () => {
    const src = read("global-error.tsx");
    expect(src.startsWith('"use client";')).toBe(true);
    expect(src).toContain('<html lang="en">');
    expect(src).toContain("<body");
    expect(src).toContain("onClick={() => reset()}");
    expect(src).not.toContain("error.stack");
    expect(src).not.toContain("error.message");
  });

  it("loading is an accessible live region that points at the health check", () => {
    const src = read("loading.tsx");
    expect(src).toContain('role="status"');
    expect(src).toContain('aria-live="polite"');
    expect(src).toContain("Loading…");
    expect(src).toContain("/api/health");
  });

  it("icon.svg is a self-contained SVG with a title and no external references", () => {
    const src = read("icon.svg");
    expect(src).toContain('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">');
    expect(src).toContain("<title>LedgerPilot</title>");
    // The only URL allowed is the SVG xmlns namespace identifier itself.
    expect(src.replace("http://www.w3.org/2000/svg", "")).not.toContain("http");
    expect(src).not.toContain("href=");
    expect(src).not.toContain("<image");
  });

  it("robots allows the public pages and keeps the API surface out of indexes", () => {
    const result = robots();
    expect(result.rules).toEqual({
      userAgent: "*",
      allow: "/",
      disallow: "/api/",
    });
  });

  it("robots source carries no sitemap or host pointing at an invented URL", () => {
    const src = read("robots.ts");
    expect(src).not.toMatch(/https?:\/\//);
    expect(src.toLowerCase()).not.toContain("sitemap");
  });
});
