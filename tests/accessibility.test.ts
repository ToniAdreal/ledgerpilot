import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const appDir = join(process.cwd(), "src", "app");
const read = (...parts: string[]) => readFileSync(join(appDir, ...parts), "utf8");

// Every page that renders inside the root layout: its <main> is the
// skip link's target. (global-error.tsx replaces the layout itself and
// cannot rely on globals.css, so it is out of scope here — as its own
// header already documents.)
const MAIN_PAGES: Array<[string, ...string[]]> = [
  ["home page", "page.tsx"],
  ["judge page", "judge", "page.tsx"],
  ["invoice detail page", "invoices", "[id]", "page.tsx"],
  ["activity page", "activity", "page.tsx"],
  ["invoices page", "invoices", "page.tsx"],
  ["checkout page", "checkout", "page.tsx"],
  ["payouts page", "payouts", "page.tsx"],
  ["command page", "command", "page.tsx"],
  ["not-found", "not-found.tsx"],
  ["error boundary", "error.tsx"],
  ["loading", "loading.tsx"],
];

describe("Accessibility shell (skip link / focus / reduced motion)", () => {
  it("the root layout renders the skip link before the page content", () => {
    const src = read("layout.tsx");
    const link = src.indexOf('className="skip-link"');
    expect(link).toBeGreaterThan(-1);
    expect(src).toContain('href="#main-content"');
    expect(src).toContain("Skip to main content");
    expect(link).toBeLessThan(src.indexOf("{children}"));
  });

  it.each(MAIN_PAGES)("%s carries the skip target: <main id + tabIndex -1>", (_name, ...parts) => {
    const src = read(...parts);
    expect(src).toContain('id="main-content"');
    expect(src).toContain("tabIndex={-1}");
    // Exactly one main landmark per page — a second one would make the
    // skip target ambiguous.
    expect(src.match(/<main[\s>]/g)).toHaveLength(1);
  });

  it("the skip link is hidden off-viewport until focused, then pinned visible", () => {
    const css = read("globals.css");
    const block = css.slice(css.indexOf(".skip-link {"), css.indexOf(".skip-link:focus"));
    expect(block).toContain("position: absolute");
    expect(block).toContain("top: -100px");
    expect(css).toContain(".skip-link:focus { top: 0; }");
  });

  it("keyboard focus is always visible and never removed without replacement", () => {
    const css = read("globals.css");
    expect(css).toContain(":focus-visible { outline: 3px solid #2563eb; outline-offset: 2px; }");
    expect(css).not.toContain("outline: none");
    expect(css).not.toContain("outline:none");
    expect(css).not.toContain("outline: 0");
  });

  it("reduced-motion preference collapses animations and transitions", () => {
    const css = read("globals.css");
    expect(css).toContain("@media (prefers-reduced-motion: reduce)");
    const media = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce)"));
    expect(media).toContain("animation-duration: 0.01ms !important");
    expect(media).toContain("transition-duration: 0.01ms !important");
    expect(media).toContain("scroll-behavior: auto !important");
  });
});
