import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync
} from "node:fs";
import { resolve } from "node:path";
import { fetchSitemapPaths } from "../sitemap";
import { log } from "../util/log";
import {
  newRunId,
  RUNS_DIR,
  userConfigDir,
  userJourneysDir
} from "../util/paths";
import type { Device } from "../browser/devices";
import { classifyAll, groupByTemplate, type RouteGroup } from "./classify";
import { crawlSite, type PageFacts } from "./crawl";
import {
  buildJourneys,
  buildPreset,
  buildRecipesSection,
  mergeRecipes
} from "./generate";
import { renderMapHtml } from "./report";

export type MapOptions = {
  baseUrl: string;
  limit: number;
  depth: number;
  concurrency: number;
  perTemplate: number;
  maxJourneys: number;
  useSitemap: boolean;
  sitemapUrl?: string;
  captureScreenshots: boolean;
  loadStorageState: boolean;
  /** Overwrite existing generated journeys (the preset is always rewritten). */
  force: boolean;
  /** Form factor to crawl as. Defaults to desktop. */
  device?: Device;
  gotoTimeoutMs: number;
  filter?: RegExp;
  exclude?: RegExp;
};

async function collectSeeds(opts: MapOptions): Promise<string[]> {
  const seeds = new Set<string>();
  const basePath = (() => {
    try {
      const u = new URL(opts.baseUrl);
      return (u.pathname.replace(/\/+$/, "") || "/") + u.search;
    } catch {
      return "/";
    }
  })();
  seeds.add(basePath);

  if (opts.useSitemap) {
    const sitemapUrl =
      opts.sitemapUrl ?? `${opts.baseUrl.replace(/\/$/, "")}/sitemap.xml`;
    try {
      log.dim(`fetching sitemap: ${sitemapUrl}`);
      const paths = await fetchSitemapPaths({ url: sitemapUrl });
      log.dim(`  + ${paths.length} URLs from sitemap`);
      for (const p of paths) seeds.add(p);
    } catch (err) {
      log.dim(
        `  sitemap not used (${err instanceof Error ? err.message : String(err)})`
      );
    }
  }

  return Array.from(seeds);
}

function writePreset(configDir: string, groups: RouteGroup[], baseUrl: string): string {
  mkdirSync(configDir, { recursive: true });
  const path = resolve(configDir, "urls-map.txt");
  writeFileSync(path, buildPreset(groups, baseUrl));
  return path;
}

function writeJourneys(
  pages: ReturnType<typeof classifyAll>,
  maxJourneys: number,
  force: boolean
): { written: string[]; skipped: string[] } {
  const drafts = buildJourneys(pages, maxJourneys);
  const written: string[] = [];
  const skipped: string[] = [];
  if (drafts.length === 0) return { written, skipped };
  const dir = userJourneysDir();
  mkdirSync(dir, { recursive: true });
  for (const draft of drafts) {
    const path = resolve(dir, `${draft.name}.json`);
    if (existsSync(path) && !force) {
      skipped.push(`${draft.name}.json`);
      continue;
    }
    writeFileSync(path, `${JSON.stringify(draft.journey, null, 2)}\n`);
    written.push(`${draft.name}.json`);
  }
  return { written, skipped };
}

function writeRecipes(configDir: string, groups: RouteGroup[]): string {
  const instructionsDir = resolve(configDir, "instructions");
  const topLevel = resolve(configDir, "recipes.md");
  const target =
    existsSync(topLevel) && !existsSync(resolve(instructionsDir, "recipes.md"))
      ? topLevel
      : resolve(instructionsDir, "recipes.md");
  mkdirSync(resolve(target, ".."), { recursive: true });
  const existing = existsSync(target) ? readFileSync(target, "utf-8") : null;
  writeFileSync(target, mergeRecipes(existing, buildRecipesSection(groups)));
  return target;
}

export async function runMap(opts: MapOptions): Promise<void> {
  const startedAt = new Date();
  const started = Date.now();
  const mapId = `map-${newRunId()}`;
  const mapDir = resolve(RUNS_DIR, mapId);
  mkdirSync(mapDir, { recursive: true });
  log.dim(`map dir: ${mapDir}`);

  const seeds = await collectSeeds(opts);
  log.header(
    `map ${opts.baseUrl}: up to ${opts.limit} pages, depth ${opts.depth}, ${opts.concurrency} workers`
  );
  if (opts.device && opts.device.name !== "desktop")
    log.dim(
      `device: ${opts.device.name} (${opts.device.viewport.width}x${opts.device.viewport.height})`
    );

  const pages: PageFacts[] = await crawlSite({
    baseUrl: opts.baseUrl,
    seeds,
    mapDir,
    limit: opts.limit,
    depth: opts.depth,
    concurrency: opts.concurrency,
    perTemplate: opts.perTemplate,
    captureScreenshots: opts.captureScreenshots,
    loadStorageState: opts.loadStorageState,
    ...(opts.device ? { device: opts.device } : {}),
    gotoTimeoutMs: opts.gotoTimeoutMs,
    ...(opts.filter ? { filter: opts.filter } : {}),
    ...(opts.exclude ? { exclude: opts.exclude } : {})
  });

  const classified = classifyAll(pages);
  const groups = groupByTemplate(classified);

  const durationMs = Date.now() - started;
  const mapJson = {
    mapId,
    baseUrl: opts.baseUrl,
    startedAt: startedAt.toISOString(),
    durationMs,
    pageCount: classified.length,
    routeCount: groups.length,
    groups: groups.map((g) => ({
      template: g.template,
      type: g.type,
      count: g.count,
      representative: g.representative.finalPath || g.representative.path,
      ok: g.representative.ok,
      paths: g.members.map((m) => m.finalPath || m.path)
    })),
    pages: classified
  };
  writeFileSync(resolve(mapDir, "map.json"), JSON.stringify(mapJson, null, 2));
  writeFileSync(
    resolve(mapDir, "map.html"),
    renderMapHtml({
      baseUrl: opts.baseUrl,
      startedAt: startedAt.toISOString(),
      durationMs,
      pageCount: classified.length,
      groups
    })
  );

  // Generate project config from the map.
  const configDir = userConfigDir();
  const presetPath = writePreset(configDir, groups, opts.baseUrl);
  const journeys = writeJourneys(classified, opts.maxJourneys, opts.force);
  const recipesPath = writeRecipes(configDir, groups);

  // Summary.
  const okCount = classified.filter((p) => p.ok).length;
  const errorGroups = groups.filter((g) => g.type === "error").length;
  const typeCounts = new Map<string, number>();
  for (const g of groups)
    typeCounts.set(g.type, (typeCounts.get(g.type) ?? 0) + 1);

  log.info("");
  log.header(`map: ${groups.length} routes across ${classified.length} pages`);
  log.info(`  duration:    ${durationMs}ms`);
  log.info(`  pages ok:    ${okCount}/${classified.length}`);
  if (errorGroups > 0)
    log.warn(`  error routes: ${errorGroups} (see map.html)`);
  log.info(
    `  route types: ${Array.from(typeCounts.entries())
      .map(([t, c]) => `${t}=${c}`)
      .join(", ")}`
  );
  log.info("");
  log.info("  generated:");
  log.ok(`    preset:   ${presetPath}  (web-tester sweep --preset map)`);
  log.ok(`    recipes:  ${recipesPath}`);
  if (journeys.written.length)
    log.ok(
      `    journeys: ${journeys.written.length} drafted (${journeys.written.join(", ")})`
    );
  if (journeys.skipped.length)
    log.dim(
      `    journeys: ${journeys.skipped.length} skipped (exist; use --force to overwrite): ${journeys.skipped.join(", ")}`
    );
  log.info("");
  log.ok(`  HTML map:  ${mapDir}/map.html`);
  log.info(`  map.json:  ${mapDir}/map.json`);
  log.dim("  Review the generated journeys before running them — values and");
  log.dim("  expectations are placeholders.");
}
