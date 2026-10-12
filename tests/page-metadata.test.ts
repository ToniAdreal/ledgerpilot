import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const appDir = join(process.cwd(), "src", "app");
const read = (...parts: string[]) => readFileSync(join(appDir, ...parts), "utf8");

// Every page that renders inside the root layout carries its own
// typed Metadata export. (global-error.tsx replaces the layout itself
// and error.tsx / loading.tsx are boundaries, not addressable pages —
// out of scope, as their own files document.)
const PAGES: Array<{ name: string; parts: string[]; title: string }> = [
  {
    name: "home / operations console",
    parts: ["page.tsx"],
    title: "LedgerPilot — Operations Console",
  },
  {
    name: "judge mode",
    parts: ["judge", "page.tsx"],
    title: "LedgerPilot — Judge Mode",
  },
  {
    name: "invoice detail",
    parts: ["invoices", "[id]", "page.tsx"],
    title: "LedgerPilot — Invoice detail",
  },
  {
    name: "activity audit",
    parts: ["activity", "page.tsx"],
    title: "LedgerPilot — Agent Activity & Webhook Audit",
  },
  {
    name: "invoices list",
    parts: ["invoices", "page.tsx"],
    title: "LedgerPilot — Invoices",
  },
  {
    name: "not-found",
    parts: ["not-found.tsx"],
    title: "LedgerPilot — Page not found",
  },
];

function metadataBlock(src: string): string {
  const start = src.indexOf("export const metadata");
  expect(start).toBeGreaterThan(-1);
  const end = src.indexOf("};", start);
  expect(end).toBeGreaterThan(start);
  return src.slice(start, end);
}

function field(block: string, name: string): string {
  const match = block.match(new RegExp(`${name}:\\s*"([^"]+)"`));
  expect(match, `metadata field ${name}`).not.toBeNull();
  return match![1];
}

describe("Page metadata (every addressable page, typed, no invented URL)", () => {
  it.each(PAGES)("$name declares a typed Metadata export", ({ parts }) => {
    const src = read(...parts);
    expect(src).toContain('import type { Metadata } from "next"');
    expect(src).toContain("export const metadata: Metadata = {");
  });

  it.each(PAGES)("$name carries its exact page title", ({ parts, title }) => {
    expect(field(metadataBlock(read(...parts)), "title")).toBe(title);
  });

  it("every page title is distinct and prefixed with the app name", () => {
    const titles = PAGES.map(({ parts }) => field(metadataBlock(read(...parts)), "title"));
    expect(new Set(titles).size).toBe(titles.length);
    for (const title of titles) expect(title.startsWith("LedgerPilot — ")).toBe(true);
  });

  it("every page description is present, distinct, and substantive", () => {
    const descriptions = PAGES.map(({ parts }) =>
      field(metadataBlock(read(...parts)), "description"),
    );
    expect(new Set(descriptions).size).toBe(descriptions.length);
    for (const description of descriptions) expect(description.length).toBeGreaterThan(30);
  });

  it("the console description names the surfaces and states sandbox / mock only", () => {
    const description = field(metadataBlock(read("page.tsx")), "description");
    expect(description).toContain("operations console");
    expect(description).toMatch(/invoices/);
    expect(description).toMatch(/payouts/);
    expect(description).toMatch(/audit trail/);
    expect(description).toMatch(/no real money/);
  });

  it("the console description differs from the root layout's generic description", () => {
    const layout = read("layout.tsx");
    const generic = field(layout.slice(layout.indexOf("export const metadata")), "description");
    const console_ = field(metadataBlock(read("page.tsx")), "description");
    expect(console_).not.toBe(generic);
  });

  it("no page metadata declares a URL, canonical, or metadataBase", () => {
    for (const { parts } of PAGES) {
      const block = metadataBlock(read(...parts));
      expect(block).not.toMatch(/https?:\/\//);
      expect(block).not.toContain("metadataBase");
      expect(block).not.toContain("canonical");
      expect(block).not.toContain("openGraph");
    }
  });

  it("no page metadata contains a credential-shaped value or an email address", () => {
    for (const { parts } of PAGES) {
      const block = metadataBlock(read(...parts));
      expect(block).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.]+/);
      expect(block).not.toMatch(/secret|api[_-]?key|password/i);
    }
  });
});
