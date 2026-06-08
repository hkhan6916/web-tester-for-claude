import { resolve } from "node:path";
import { chromium, type Browser, type BrowserContext } from "playwright";
import { readUiAttributes } from "../browser/attrs";
import { DEFAULT_DEVICE, type Device, deviceContextOptions } from "../browser/devices";
import { configureContext } from "../browser/session";
import { attachCapture } from "../inspector/capture";
import { log } from "../util/log";
import { SESSION_STATE_PATH } from "../util/paths";
import { existsSync } from "node:fs";
import { routeTemplate } from "./classify";

/** A form discovered on a page, with enough detail to draft a journey. */
export type PageForm = {
  action: string | null;
  method: string;
  fields: { name: string; type: string; tag: string; required: boolean }[];
  submitText: string | null;
};

/** Everything the crawler observes about one page. */
export type PageFacts = {
  /** Absolute URL requested. */
  url: string;
  /** Path requested (pathname + search). */
  path: string;
  /** Path after any redirects. */
  finalPath: string;
  status: number | null;
  title: string;
  ok: boolean;
  depth: number;
  hasHeader: boolean;
  hasFooter: boolean;
  hasMain: boolean;
  hasNav: boolean;
  h1: string | null;
  headingCount: number;
  forms: PageForm[];
  /** Same-origin paths linked from this page. */
  internalLinks: string[];
  imageCount: number;
  /** `main a[href^='/']:has(img)` — catalog-card shape. */
  cardLinkCount: number;
  passwordFields: number;
  searchInputs: number;
  consoleErrors: number;
  pageErrors: number;
  attrCount: number;
  /** Relative path to a viewport screenshot under the map dir, if captured. */
  screenshot?: string;
  error?: string;
};

export type CrawlOptions = {
  baseUrl: string;
  /** Seed paths to start from (the base path + any sitemap entries). */
  seeds: string[];
  mapDir: string;
  limit: number;
  depth: number;
  concurrency: number;
  perTemplate: number;
  captureScreenshots: boolean;
  loadStorageState: boolean;
  /** Form factor to crawl as. Defaults to desktop. */
  device?: Device;
  gotoTimeoutMs: number;
  filter?: RegExp;
  exclude?: RegExp;
};

type DomFacts = Omit<
  PageFacts,
  | "url"
  | "path"
  | "finalPath"
  | "status"
  | "depth"
  | "ok"
  | "consoleErrors"
  | "pageErrors"
  | "attrCount"
  | "screenshot"
  | "error"
>;

/**
 * Run inside the page to collect structural facts in one round-trip.
 *
 * Everything in here is serialised to the browser by page.evaluate, so it must
 * use inline callback arguments only — no `const fn = () => …` and no nested
 * `function` declarations. tsx's esbuild "keep names" transform wraps named
 * inner functions in a `__name(…)` helper that doesn't exist in the page; one
 * slips in and the whole evaluate throws `ReferenceError: __name is not
 * defined`, which the caller swallows — leaving every fact blank.
 */
function collectDomFacts(): DomFacts {
  const forms = Array.from(document.querySelectorAll("form")).map((form) => {
    const fields = Array.from(
      form.querySelectorAll("input, select, textarea")
    )
      .map((el) => {
        const tag = el.tagName.toLowerCase();
        const type =
          tag === "input"
            ? (el.getAttribute("type") ?? "text").toLowerCase()
            : tag;
        return {
          name:
            el.getAttribute("name") ?? el.getAttribute("id") ?? "",
          type,
          tag,
          required: el.hasAttribute("required")
        };
      })
      .filter((f) => f.type !== "hidden");
    const submit = form.querySelector(
      "button[type=submit], input[type=submit], button:not([type])"
    );
    return {
      action: form.getAttribute("action"),
      method: (form.getAttribute("method") ?? "get").toLowerCase(),
      fields,
      submitText: submit
        ? (submit.textContent ?? "").replace(/\s+/g, " ").trim() ||
          submit.getAttribute("value")
        : null
    };
  });

  // `.href` (not getAttribute) gives the browser-resolved absolute URL against
  // the live document base — so relative links resolve correctly even after a
  // redirect, where the requested URL and final URL differ.
  const anchors = Array.from(document.querySelectorAll("a[href]"))
    .map((a) => (a as HTMLAnchorElement).href)
    .filter(Boolean);

  return {
    title: document.title ?? "",
    hasHeader: !!document.querySelector("header"),
    hasFooter: !!document.querySelector("footer"),
    hasMain: !!document.querySelector("main"),
    hasNav: !!document.querySelector("nav"),
    h1:
      (document.querySelector("h1")?.textContent ?? "")
        .replace(/\s+/g, " ")
        .trim() || null,
    headingCount: document.querySelectorAll("h1, h2, h3").length,
    forms,
    internalLinks: anchors,
    imageCount: document.querySelectorAll("img").length,
    cardLinkCount: document.querySelectorAll("main a[href^='/']:has(img)")
      .length,
    passwordFields: document.querySelectorAll("input[type=password]").length,
    searchInputs: document.querySelectorAll(
      "input[type=search], input[name=q], input[name=query], input[name=s]"
    ).length
  };
}

/** Normalise an href to a same-origin path (pathname + search), or null. */
function toInternalPath(href: string, pageUrl: string, origin: string): string | null {
  const trimmed = href.trim();
  if (
    !trimmed ||
    trimmed.startsWith("#") ||
    /^(mailto:|tel:|javascript:|data:)/i.test(trimmed)
  )
    return null;
  let abs: URL;
  try {
    abs = new URL(trimmed, pageUrl);
  } catch {
    return null;
  }
  if (abs.origin !== origin) return null;
  if (!/^https?:$/.test(abs.protocol)) return null;
  // Drop the hash — fragment-only differences are the same document.
  return abs.pathname + abs.search;
}

function slug(path: string, index: number): string {
  const cleaned = path
    .replace(/[^a-z0-9]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase()
    .slice(0, 50);
  return `${String(index).padStart(3, "0")}-${cleaned || "root"}`;
}

/**
 * Breadth-first crawl from the seed paths, same-origin only. Stops at
 * `limit` fetched pages or `depth` link hops, and fetches at most
 * `perTemplate` pages per dynamic-route template so a catalog of thousands
 * of detail pages doesn't dominate the crawl.
 */
export async function crawlSite(opts: CrawlOptions): Promise<PageFacts[]> {
  const origin = new URL(opts.baseUrl).origin;
  const browser: Browser = await chromium.launch({ headless: true });
  const useStorageState =
    opts.loadStorageState && existsSync(SESSION_STATE_PATH);
  if (useStorageState) log.dim("  · loaded session from ~/.web-tester/session.json");

  const results: PageFacts[] = [];
  const queued = new Set<string>();
  const templateCounts = new Map<string, number>();
  type Job = { path: string; depth: number };
  const frontier: Job[] = [];

  const wanted = (path: string): boolean => {
    if (opts.filter && !opts.filter.test(path)) return false;
    if (opts.exclude && opts.exclude.test(path)) return false;
    return true;
  };

  for (const seed of opts.seeds) {
    if (!queued.has(seed) && wanted(seed)) {
      queued.add(seed);
      frontier.push({ path: seed, depth: 0 });
    }
  }

  let fetched = 0;
  let active = 0;

  const basePath = (() => {
    try {
      const u = new URL(opts.baseUrl);
      return (u.pathname.replace(/\/+$/, "") || "/") + u.search;
    } catch {
      return "/";
    }
  })();

  const claimTemplateSlot = (path: string): boolean => {
    // The base path always gets crawled. Everything else — including sitemap
    // seeds — is capped per route template so a large catalog can't crowd
    // out the rest of the site.
    if (path === basePath || path === "/") return true;
    const tpl = routeTemplate(path);
    const count = templateCounts.get(tpl) ?? 0;
    if (count >= opts.perTemplate) return false;
    templateCounts.set(tpl, count + 1);
    return true;
  };

  const fetchOne = async (
    context: BrowserContext,
    job: Job
  ): Promise<void> => {
    const index = ++fetched;
    const page = await context.newPage();
    const buffers = attachCapture(context, page, {
      allNetwork: false,
      allConsole: false
    });
    const url = job.path.startsWith("http")
      ? job.path
      : new URL(job.path, opts.baseUrl).toString();
    let facts: PageFacts = {
      url,
      path: job.path,
      finalPath: job.path,
      status: null,
      title: "",
      ok: false,
      depth: job.depth,
      hasHeader: false,
      hasFooter: false,
      hasMain: false,
      hasNav: false,
      h1: null,
      headingCount: 0,
      forms: [],
      internalLinks: [],
      imageCount: 0,
      cardLinkCount: 0,
      passwordFields: 0,
      searchInputs: 0,
      consoleErrors: 0,
      pageErrors: 0,
      attrCount: 0
    };
    try {
      const response = await page
        .goto(url, { waitUntil: "domcontentloaded", timeout: opts.gotoTimeoutMs })
        .catch((err) => {
          facts.error = err instanceof Error ? err.message : String(err);
          return null;
        });
      facts.status = response?.status() ?? null;
      facts.finalPath = (() => {
        try {
          const u = new URL(page.url());
          return u.pathname + u.search;
        } catch {
          return job.path;
        }
      })();
      await page.waitForLoadState("load", { timeout: 5_000 }).catch(() => {});
      const dom = await page.evaluate(collectDomFacts).catch(() => null);
      if (dom) facts = { ...facts, ...dom };
      const attrs = await readUiAttributes(page).catch(() => []);
      facts.attrCount = attrs.length;
      if (opts.captureScreenshots) {
        const rel = `${slug(facts.finalPath, index)}.png`;
        await page
          .screenshot({ path: resolve(opts.mapDir, rel), fullPage: false })
          .then(() => {
            facts.screenshot = rel;
          })
          .catch(() => {});
      }
    } finally {
      facts.consoleErrors = buffers.consoleEntries.filter(
        (e) => e.type === "error"
      ).length;
      facts.pageErrors = buffers.pageErrors.length;
      await page.close().catch(() => {});
    }

    facts.ok =
      facts.error === undefined &&
      facts.status !== null &&
      facts.status < 400;

    // Resolve and enqueue newly discovered links.
    const discovered = new Set<string>();
    for (const href of facts.internalLinks) {
      const path = toInternalPath(href, facts.url, origin);
      if (path) discovered.add(path);
    }
    facts.internalLinks = Array.from(discovered);
    if (job.depth < opts.depth) {
      for (const path of facts.internalLinks) {
        if (queued.has(path) || !wanted(path)) continue;
        queued.add(path);
        frontier.push({ path, depth: job.depth + 1 });
      }
    }

    results.push(facts);
    const tag = facts.ok ? "✓" : "✗";
    const colour = facts.ok ? log.dim : log.fail;
    colour(
      `  ${tag} [${results.length}] ${facts.path} → ${facts.status ?? "?"}${
        facts.error ? ` (${facts.error.split("\n")[0]})` : ""
      }`
    );
  };

  // Pull from the shared frontier with a fixed worker count. Each worker
  // keeps its own context. The frontier grows as pages reveal links, so the
  // loop continues until it drains or the fetch limit is hit.
  const device = opts.device ?? DEFAULT_DEVICE;
  const worker = async (): Promise<void> => {
    const context = await browser.newContext({
      ...deviceContextOptions(device),
      ...(useStorageState ? { storageState: SESSION_STATE_PATH } : {})
    });
    await configureContext(context, opts.baseUrl);
    try {
      for (;;) {
        const job = frontier.shift();
        if (!job) {
          if (active === 0) break;
          await new Promise((r) => setTimeout(r, 25));
          continue;
        }
        if (fetched >= opts.limit) break;
        if (!claimTemplateSlot(job.path)) continue;
        active++;
        try {
          await fetchOne(context, job);
        } finally {
          active--;
        }
      }
    } finally {
      await context.close().catch(() => {});
    }
  };

  try {
    await Promise.all(
      Array.from({ length: Math.max(1, opts.concurrency) }, () => worker())
    );
  } finally {
    await browser.close().catch(() => {});
  }

  return results;
}
