import type { Expectation } from "./verdict";

/**
 * Named "expectation packs" — bundles of `--expect` assertions tailored to
 * a page type. A sweep URL can opt into one or more packs via inline
 * `#pack=<name>` annotations in a URL file, and the CLI can also apply a
 * default pack to all URLs via `--pack <name>`. Per-URL expectations are
 * the union of global `--expect`s, global `--pack`s, and the URL's own
 * inline packs.
 *
 * Built-ins below are deliberately generic — invariants that hold for almost
 * any page of that shape. For project-specific assertions, add `--expect`
 * flags per run or per URL, or register a new generally-useful pack here.
 */
export const BUILT_IN_PACKS: Record<string, Expectation[]> = {
  /**
   * Homepage / landing page — page chrome should render. We deliberately
   * don't assert a heading: many sites lead with a hero or marketing block
   * that uses an <h2> or no heading at all, and the universal signal is
   * header + footer being present.
   */
  homepage: [
    { kind: "selector", selector: "header" },
    { kind: "selector", selector: "footer" }
  ],
  /**
   * Generic content / informational page. Same shape as homepage — header
   * + footer is the universal "the page chrome rendered" signal.
   */
  static: [
    { kind: "selector", selector: "header" },
    { kind: "selector", selector: "footer" }
  ],
  /**
   * Category / index page — header + footer + at least one product/article
   * card link. The card selector matches any `<a>` inside `<main>` that
   * points to an internal route and contains an `<img>` — a near-universal
   * shape for catalog cards.
   */
  category: [
    { kind: "selector", selector: "header" },
    { kind: "selector", selector: "footer" },
    { kind: "selector", selector: "main a[href^='/']:has(img)" }
  ],
  /**
   * Any "main content area present" assertion — useful as a baseline when
   * you don't want to overspecify the page shape.
   */
  "has-main": [{ kind: "selector", selector: "main" }],
  /**
   * Any page with an `<h1>`. Common safety net for content pages where the
   * heading is the primary "we rendered the right thing" signal.
   */
  "has-h1": [{ kind: "selector", selector: "h1" }]
};

export function getBuiltInPack(name: string): Expectation[] {
  const pack = BUILT_IN_PACKS[name];
  if (!pack) {
    const known = Object.keys(BUILT_IN_PACKS).join(", ");
    throw new Error(
      `unknown pack "${name}". Built-in packs: ${known}. Add new packs in src/inspector/packs.ts.`
    );
  }
  return pack;
}

export function listBuiltInPackNames(): string[] {
  return Object.keys(BUILT_IN_PACKS);
}

/**
 * Parse a URL-file line of the form `<path> [#pack=<name>] [#pack=<name>]…`.
 * Returns `{ path, packs }`. Lines without an annotation get `packs: []`.
 * Inline pack syntax is tab- or space-separated from the URL.
 */
export function parseUrlLine(line: string): {
  path: string;
  packs: string[];
} {
  const trimmed = line.trim();
  // Split on whitespace into tokens. First token is the path. Each
  // subsequent token must match `#pack=<name>`; anything else is an error
  // (so typos don't get silently ignored).
  const parts = trimmed.split(/\s+/);
  const path = parts[0] ?? "";
  const packs: string[] = [];
  for (let i = 1; i < parts.length; i++) {
    const part = parts[i] ?? "";
    const match = part.match(/^#pack=(.+)$/);
    if (!match || !match[1])
      throw new Error(
        `invalid URL-file annotation "${part}" on line "${line}". Expected "#pack=<name>".`
      );
    packs.push(match[1]);
  }
  return { path, packs };
}
