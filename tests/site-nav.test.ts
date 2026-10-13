import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { SITE_NAV_LINKS, isSiteNavLinkActive } from "../src/lib/nav/site-nav";

/**
 * Primary site navigation. Until now the surfaces were cross-linked
 * only by prose (a "likewise" paragraph on the console home, a
 * "← Operations Console" back-link on each standalone page), so moving
 * between two standalone surfaces always meant going home first. The
 * root layout now renders one nav from SITE_NAV_LINKS; these tests pin
 * the list against the pages actually on disk, so a new page that is
 * not added to the nav — or a nav link to a removed page — fails here.
 */

const appDir = resolve(__dirname, "../src/app");
const layout = readFileSync(resolve(appDir, "layout.tsx"), "utf8");
const navComponent = readFileSync(resolve(appDir, "site-nav.tsx"), "utf8");
const readme = readFileSync(resolve(__dirname, "../README.md"), "utf8");

function pageRoutesOnDisk(): string[] {
  const routes: string[] = [];
  if (existsSync(resolve(appDir, "page.tsx"))) routes.push("/");
  for (const entry of readdirSync(appDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name === "api" || entry.name.startsWith("[")) continue;
    if (existsSync(resolve(appDir, entry.name, "page.tsx"))) {
      routes.push(`/${entry.name}`);
    }
  }
  return routes.sort();
}

describe("site navigation", () => {
  it("covers exactly the static page routes on disk", () => {
    expect([...SITE_NAV_LINKS.map((l) => l.href)].sort()).toEqual(pageRoutesOnDisk());
  });

  it("has unique hrefs and labels, all same-origin paths", () => {
    const hrefs = SITE_NAV_LINKS.map((l) => l.href);
    const labels = SITE_NAV_LINKS.map((l) => l.label);
    expect(new Set(hrefs).size).toBe(hrefs.length);
    expect(new Set(labels).size).toBe(labels.length);
    for (const href of hrefs) {
      expect(href.startsWith("/")).toBe(true);
      expect(href).not.toContain("http");
      expect(href === "/" || !href.endsWith("/")).toBe(true);
    }
    for (const label of labels) expect(label.trim().length).toBeGreaterThan(0);
  });

  it("excludes dynamic detail routes from the primary nav", () => {
    expect(SITE_NAV_LINKS.map((l) => l.href)).not.toContain("/invoices/[id]");
    expect(SITE_NAV_LINKS.some((l) => l.href.includes("["))).toBe(false);
  });

  it("resolves the active link: root exact, sections by prefix", () => {
    expect(isSiteNavLinkActive("/", "/")).toBe(true);
    expect(isSiteNavLinkActive("/invoices", "/")).toBe(false);
    expect(isSiteNavLinkActive("/invoices", "/invoices")).toBe(true);
    expect(isSiteNavLinkActive("/invoices/INV2-000001", "/invoices")).toBe(true);
    expect(isSiteNavLinkActive("/invoices", "/payouts")).toBe(false);
    expect(isSiteNavLinkActive("/judge", "/judge")).toBe(true);
  });

  it("the component renders the shared list with aria-current on the active link", () => {
    expect(navComponent).toContain('"use client"');
    expect(navComponent).toContain("usePathname");
    expect(navComponent).toContain('aria-label="Primary"');
    expect(navComponent).toContain("SITE_NAV_LINKS");
    expect(navComponent).toContain("isSiteNavLinkActive");
    expect(navComponent).toContain('aria-current={active ? "page" : undefined}');
  });

  it("the root layout renders the nav after the skip link and before the page content", () => {
    const skip = layout.indexOf('href="#main-content"');
    const nav = layout.indexOf("<SiteNav />");
    const children = layout.indexOf("{children}");
    expect(skip).toBeGreaterThan(-1);
    expect(nav).toBeGreaterThan(skip);
    expect(children).toBeGreaterThan(nav);
  });

  it("is documented in the README", () => {
    expect(readme).toContain("Site navigation");
    expect(readme).toContain("src/lib/nav/");
  });
});
