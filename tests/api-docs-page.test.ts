import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  API_OPERATIONS,
  API_TAGS,
  buildApiDocsSections,
  type ApiOperation,
} from "@/lib/api";

const appDir = join(process.cwd(), "src", "app");
const read = (...parts: string[]) => readFileSync(join(appDir, ...parts), "utf8");

describe("API documentation page (/api-docs, rendered from the OpenAPI registry)", () => {
  it("groups every registered operation exactly once, in tag order", () => {
    const sections = buildApiDocsSections();
    expect(sections.map((s) => s.tag)).toEqual(API_TAGS.map((t) => t.name));
    const rendered = sections.flatMap((s) => s.operations.map((op) => op.operationId));
    expect(rendered).toHaveLength(API_OPERATIONS.length);
    expect(new Set(rendered).size).toBe(API_OPERATIONS.length);
    expect([...rendered].sort()).toEqual(API_OPERATIONS.map((op) => op.operationId).sort());
  });

  it("carries each tag's registry description and only its own operations", () => {
    for (const section of buildApiDocsSections()) {
      const tag = API_TAGS.find((t) => t.name === section.tag);
      expect(section.description).toBe(tag?.description);
      expect(section.operations.length).toBeGreaterThan(0);
      for (const op of section.operations) expect(op.tag).toBe(section.tag);
    }
  });

  it("omits a tag with no operations instead of rendering an empty section", () => {
    const only: ApiOperation[] = API_OPERATIONS.filter((op) => op.tag === "Health");
    const sections = buildApiDocsSections(only);
    expect(sections.map((s) => s.tag)).toEqual(["Health"]);
    expect(sections[0].operations).toHaveLength(only.length);
  });

  it("the page renders from the registry helper, never a second operation list", () => {
    const src = read("api-docs", "page.tsx");
    expect(src).toContain('from "@/lib/api"');
    expect(src).toContain("buildApiDocsSections()");
    expect(src).toContain("section.operations.map");
    // No hardcoded API path in the page source: paths come from the registry.
    expect(src).not.toMatch(/"\/api\/(agent|console|paypal|judge)\//);
  });

  it("links the machine-readable document and states the no-auth + gate honesty notes", () => {
    const src = read("api-docs", "page.tsx");
    expect(src).toContain('href="/api/openapi"');
    expect(src).toContain("no authentication layer");
    expect(src).toContain("pending_approval");
    expect(src).toContain('href="/judge"');
    expect(src).toContain('href="/"');
  });

  it("declares no external URL, fetches nothing, and is a server component", () => {
    const src = read("api-docs", "page.tsx");
    expect(src).not.toContain("https://");
    expect(src).not.toContain("fetch(");
    expect(src).not.toContain('"use client"');
  });

  it("the home console links to the documentation page", () => {
    expect(read("page.tsx")).toContain('href="/api-docs"');
  });
});
