import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Repository text hygiene (`.editorconfig` + `.gitattributes`).
 *
 * Before these files existed, the tree's text conventions — UTF-8,
 * LF endings, a final newline, no trailing whitespace, space
 * indentation — lived nowhere an editor or Git itself consults.
 * That was a real risk, not tidiness: a Windows clone with
 * core.autocrlf would check text files out with CRLF and hand
 * back whole-file diffs, and the committed `favicon.ico` (whose
 * own suite asserts exact bytes and rendered pixels) had no
 * explicit binary protection against a line-ending conversion
 * pass. These tests pin the two declarations in agreement with
 * each other and check the text files in the tree against them.
 */

const appRoot = resolve(__dirname, "..");
const read = (name: string) => readFileSync(resolve(appRoot, name), "utf8");

const editorconfigPath = resolve(appRoot, ".editorconfig");
const gitattributesPath = resolve(appRoot, ".gitattributes");
const editorconfig = existsSync(editorconfigPath) ? read(".editorconfig") : "";
const gitattributes = existsSync(gitattributesPath) ? read(".gitattributes") : "";

/** The body of one EditorConfig section (`[*]`, `[*.md]`, …). */
function editorSection(header: string): string {
  const start = editorconfig.indexOf(header);
  if (start === -1) return "";
  const rest = editorconfig.slice(start + header.length);
  const next = rest.indexOf("\n[");
  return next === -1 ? rest : rest.slice(0, next);
}

const SKIP_DIRS = new Set(["node_modules", ".next", ".git", "coverage", "out"]);
const SKIP_FILES = new Set([".env", ".env.local"]);
const SKIP_EXTS = new Set([".ico", ".tsbuildinfo"]);

function textFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      textFiles(full, out);
      continue;
    }
    if (SKIP_FILES.has(entry)) continue;
    if (entry.endsWith(".ledger.json") || entry.endsWith(".mock-paypal.json")) continue;
    if (SKIP_EXTS.has(extname(entry))) continue;
    out.push(full);
  }
  return out;
}

const rel = (files: string[]) => files.map((f) => relative(appRoot, f));

describe("repository text hygiene", () => {
  it(".editorconfig exists and is the root config", () => {
    expect(existsSync(editorconfigPath)).toBe(true);
    expect(editorconfig).toMatch(/^root = true$/m);
  });

  it("the global EditorConfig section declares the tree's conventions", () => {
    const global = editorSection("[*]");
    expect(global).toContain("charset = utf-8");
    expect(global).toContain("end_of_line = lf");
    expect(global).toContain("insert_final_newline = true");
    expect(global).toContain("trim_trailing_whitespace = true");
    expect(global).toContain("indent_style = space");
    expect(global).toContain("indent_size = 2");
  });

  it("Markdown keeps its hard-break whitespace and Python indents by 4", () => {
    expect(editorSection("[*.md]")).toContain("trim_trailing_whitespace = false");
    expect(editorSection("[*.py]")).toContain("indent_size = 4");
  });

  it(".gitattributes stores every text file with LF endings", () => {
    expect(existsSync(gitattributesPath)).toBe(true);
    expect(gitattributes).toMatch(/^\* text=auto eol=lf$/m);
  });

  it(".gitattributes marks the icon assets binary (the favicon's bytes are test-pinned)", () => {
    expect(gitattributes).toMatch(/^\*\.ico binary$/m);
    expect(gitattributes).toMatch(/^\*\.png binary$/m);
  });

  it("the two files agree on LF (a rule edited in one place only fails here)", () => {
    const editorLf = editorconfig.match(/end_of_line = (\w+)/)?.[1];
    const gitLf = gitattributes.match(/\* text=auto eol=(\w+)/)?.[1];
    expect(editorLf).toBe("lf");
    expect(gitLf).toBe(editorLf);
  });

  it("no text file in the tree carries CR or CRLF line endings", () => {
    const offenders = textFiles(appRoot).filter((f) => readFileSync(f, "utf8").includes("\r"));
    expect(rel(offenders)).toEqual([]);
  });

  it("every text file in the tree ends with a final newline", () => {
    const offenders = textFiles(appRoot).filter((f) => {
      const text = readFileSync(f, "utf8");
      return text.length > 0 && !text.endsWith("\n");
    });
    expect(rel(offenders)).toEqual([]);
  });

  it("no trailing whitespace (outside Markdown) and no tab indentation", () => {
    const trailing: string[] = [];
    const tabs: string[] = [];
    for (const file of textFiles(appRoot)) {
      const text = readFileSync(file, "utf8");
      if (!file.endsWith(".md") && /[ \t]+$/m.test(text)) trailing.push(file);
      if (/^\t/m.test(text)) tabs.push(file);
    }
    expect(rel(trailing)).toEqual([]);
    expect(rel(tabs)).toEqual([]);
  });

  it("README and CONTRIBUTING document the hygiene files", () => {
    const readme = read("README.md");
    const contributing = read("CONTRIBUTING.md");
    expect(readme).toContain(".editorconfig");
    expect(readme).toContain(".gitattributes");
    expect(contributing).toContain(".editorconfig");
    expect(contributing).toContain(".gitattributes");
  });
});
