import { config as loadEnv } from "dotenv";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { resolveDevice, type Device } from "./browser/devices";
import {
  getBuiltInPack,
  listBuiltInPackNames,
  parseUrlLine
} from "./inspector/packs";
import { runInspect, type InspectResult } from "./inspector/run";
import { parseStep, type Step } from "./inspector/steps";
import {
  defaultImpactRulesPath,
  getChangedFiles,
  loadImpactRules,
  matchRules,
  printPlan
} from "./impact";
import { listJourneys, loadJourney, saveJourney, type Journey } from "./journeys";
import {
  parseExpectation,
  parseFailOn,
  type Expectation,
  type FailOnKind
} from "./inspector/verdict";
import { listKnowledge, readKnowledge } from "./kb";
import { runInit, type AutoUse, type InitResult } from "./init";
import { runMap } from "./map/run";
import { fetchSitemapPaths } from "./sitemap";
import { runSweep, type SweepOptions } from "./sweep";
import { log } from "./util/log";
import { ask, choice, confirm, isInteractive } from "./util/prompt";
import { readProjectConfig, userConfigDir, userPresetsDir } from "./util/paths";

loadEnv();

const DEFAULT_BASE_URL = "http://localhost:3000";
// Base URL precedence: env var → .web-tester/config.json → built-in default.
const BASE_URL = (
  process.env.WEB_TESTER_BASE_URL ??
  readProjectConfig().baseUrl ??
  DEFAULT_BASE_URL
).replace(/\/$/, "");
const GOTO_TIMEOUT_MS = Number(process.env.GOTO_TIMEOUT_MS ?? 30_000);

/**
 * Resolve a `--device` value (one or more comma-separated names) plus an
 * optional `--viewport` override into devices. Falls back to the project
 * config's default device, then to desktop. Honours custom devices defined in
 * config.json. `inspect` runs each device; `sweep`/`map` use the first.
 */
function resolveDeviceList(
  deviceArg: string | undefined,
  viewport: string | undefined
): Device[] {
  const cfg = readProjectConfig();
  const names: (string | undefined)[] = deviceArg
    ? deviceArg.split(",").map((s) => s.trim()).filter(Boolean)
    : cfg.device
      ? [cfg.device]
      : [undefined];
  return names.map((name) => resolveDevice({ name, viewport, custom: cfg.devices }));
}

function resolveOneDevice(
  deviceArg: string | undefined,
  viewport: string | undefined
): Device {
  return resolveDeviceList(deviceArg, viewport)[0]!;
}

type InspectArgs = {
  url: string;
  /** Comma-separated device names, or undefined for the config/default device. */
  device?: string;
  /** `<width>x<height>` viewport override. */
  viewport?: string;
  steps: Step[];
  headed: boolean;
  captureHtml: boolean;
  captureStorage: boolean;
  captureAllNetwork: boolean;
  captureAllConsole: boolean;
  recordVideo: boolean;
  fullPageScreenshots: boolean;
  summary: boolean;
  expectations: Expectation[];
  persistMs: number;
  failOn: FailOnKind[];
  deep: boolean;
  jsonStdout: boolean;
  loadStorageState: boolean;
  /** Save the browser session after a clean run (`--save-session`). */
  saveSession: boolean;
  /** If set, persist this run's flow as `.web-tester/journeys/<name>.json`. */
  saveJourney?: string;
  /** Raw `--step` strings (for `--save-journey`). */
  rawSteps: string[];
  /** Raw `--expect` strings (for `--save-journey`). */
  rawExpectations: string[];
};

function printHelp(): void {
  log.raw(`web-tester — drive your dev site with Playwright, capture everything,
hand it to your AI agent (or you).

USAGE
  web-tester init    [opts]                       interactive first-run setup:
                                                  scaffold .web-tester/, write a
                                                  Claude Code skill + CLAUDE.md
                                                  section, save config & prefs
                                                    -y, --yes        non-interactive (defaults)
                                                    --base-url <url> dev server base URL
                                                    --device <name>  default form factor
                                                    --auto-use <v>   on|ask|off (Claude usage)
                                                    --no-skill       skip the .claude/ skill
                                                    --no-agent       skip CLAUDE.md/AGENTS.md
                                                    --agent-file <p> target a specific file
                                                    --install-browser fetch Chromium now
                                                    --force          overwrite existing files
  web-tester map     [base] [opts]                crawl the site, classify pages,
                                                  generate a preset + recipes +
                                                  draft journeys + an HTML map
  web-tester inspect <url> [--step <op>]…         drive one page, capture
                                                  console + network + DOM
                                                  + screenshots + video
  web-tester sweep   [opts]                       inspect many URLs concurrently
  web-tester journey <name>                       run a saved journey from
                                                  .web-tester/journeys/<name>.json
  web-tester journey                              list available journeys
  web-tester impact  [opts]                       diff-aware advisory run
                                                  (ALWAYS exits 0)
                                                    --base <ref>   diff vs ref
                                                                   (default origin/main)
                                                    --plan-only    print the
                                                                   matched rules
                                                                   and stop
                                                    --rules <path> override
                                                                   .web-tester/impact-rules.json
  web-tester kb                                   list .md files in .web-tester/
                                                  (or .web-tester/instructions/)
  web-tester kb <topic>                           print one .md file
  web-tester help                                 this screen

INSPECT — captures per run, under runs/<id>/
  result.json   structured report (console, network, attrs, storage, per-step
                state, verdict, expectations)
  initial.png   final.png            viewport screenshots
  steps/NN-*.png                     one screenshot per step
  report.html   self-contained HTML report (video + timeline + per-step slices)
  console.json  network.json         raw streams

URLs may be absolute (http://…) or paths; paths resolve against
WEB_TESTER_BASE_URL (default http://localhost:3000).

STEP GRAMMAR — --step can be repeated, executed in order
  goto:<url>                          navigate
  reload                              reload
  wait:<load|domcontentloaded|networkidle>
  wait:<ms>                           sleep N ms
  wait:<selector>                     wait for selector
  wait:text=<exact text>              wait for matching text
  wait:url-stable[=<ms>]              wait for URL to change at least once and
                                      then stay still for <ms> (default 250)
  wait:url-contains:<sub>[@<ms>]      wait until URL contains <sub>
                                      (default timeout 10000ms; use @ not = so
                                      the substring can contain '=')
  settle[:<ms>]                       wait for data-attr-selected-label to
                                      populate on any [data-attr-name] element.
                                      Fast-paths in ~3s if none are present.
                                      Apps that don't use the convention should
                                      prefer 'wait:networkidle' instead.
  click:<selector>                    click first match (Playwright locator —
                                      use CSS, optionally with :has-text())
  hover:<selector>
  fill:<selector>=<value>             native input
  react-fill:<selector>=<value>       React-controlled input (calls native
                                      value setter + dispatches synthetic
                                      input/change/blur events)
  press:<selector>=<key>              keyboard press
  select:<selector>=<value>           native <select>
  scroll:<top|bottom|<px>>
  screenshot[:<name>]                 viewport screenshot
  screenshot-full[:<name>]            full-page screenshot
  eval:<JS expression>                run in page context; result attached
                                      to the step

VERDICT & ASSERTIONS — the real "did it work" surface
  --fail-on <list>                    comma-sep: page-errors, console-errors,
                                      4xx, 5xx. run.ok flips false on any
                                      triggered signal.
  --expect <kind>=<value>             repeatable; evaluated on final page
                                        text=<text>                must be visible
                                        no-text=<text>             must NOT be visible
                                        selector=<sel>             must be visible
                                        no-selector=<sel>          must NOT be visible
                                        attr=<Name>:<value>        data-attr-name=Name
                                                                   must match value or label
  --persist <ms>                      re-run every --expect after waiting <ms>;
                                      both checks must pass. Catches transient
                                      states (e.g. a toast that flashes then
                                      disappears).

SPEED PRESETS
  --quick                             smoke mode: no video, no full-page
                                      screenshots, no HTML capture, no AI summary
  --summary                           opt in to a model-written TL;DR at the
                                      top of the report (off by default)

OTHER FLAGS
  --headed                            show the browser
  --device <name[,name...]>           emulate a form factor. Built-in:
                                      desktop (default), tablet, mobile. Also
                                      any Playwright device ("iPhone 13",
                                      "Pixel 7") or a name from config.json.
                                      A comma list runs the flow on each.
  --viewport <width>x<height>         override just the viewport size
  --no-video                          skip the screen recording
  --no-session                        force an anonymous context (ignore the
                                      saved ~/.web-tester/session.json)
  --save-session                      after a clean run, save cookies +
                                      localStorage to ~/.web-tester/session.json
                                      — run your login flow once to authenticate
                                      later runs (TEST credentials only)
  --html                              also save initial.html / final.html
  --storage                           snapshot localStorage / sessionStorage /
                                      cookies
  --all-network                       keep every request (default: XHR/fetch/
                                      document only, noise filtered)
  --all-console                       keep every console line (default: CSP /
                                      tracker noise filtered)
  --deep                              deeper capture: request/response bodies,
                                      plus a CDP debugger that dumps the local
                                      scope of any uncaught exception and
                                      records unhandled promise rejections
  --json                              print full result.json to stdout
  --steps-file <path>                 load steps from a JSON array of strings
  --save-journey <name>               save this flow as a reusable journey
                                      (.web-tester/journeys/<name>.json); rerun
                                      it later with 'web-tester journey <name>'

SWEEP — bulk URL health checks
  --urls-file <path>                  newline-separated URLs/paths
                                      ('#' comments + '#pack=' annotations ok)
  --url <path>                        repeatable; alternative to --urls-file
  --preset <name>                     load .web-tester/urls-<name>.txt
  --sitemap [<url>]                   fetch sitemap.xml + use every <loc>.
                                      No arg = <BASE_URL>/sitemap.xml
  --filter <regex>                    keep only matching paths
  --exclude <regex>                   drop matching paths
  --limit <n>                         cap total URLs (after filter/exclude)
  --concurrency <n>                   parallel contexts (max 32; auto when
                                      omitted — heavier on localhost, lighter
                                      on remote targets)
  --fail-on, --expect                 applied to every URL
  --pack <name>                       built-in expectation pack, applied to
                                      every URL (repeatable). Built-in packs:
                                        ${listBuiltInPackNames().join(", ")}
  --device <name>                     form factor for every URL (desktop,
                                      tablet, mobile, or a Playwright device)
  --viewport <width>x<height>         override just the viewport size
  --no-session                        anonymous contexts (ignore saved session)

MAP — crawl a site and bootstrap coverage
  web-tester map [base]               crawl from <base> (default BASE_URL; a
                                      path maps that subtree) and write:
                                        .web-tester/urls-map.txt  (preset 'map')
                                        .web-tester/journeys/*    (drafts)
                                        .web-tester/instructions/recipes.md
                                        runs/map-<id>/map.html + map.json
  --limit <n>                         max pages to fetch (default 50)
  --depth <n>                         max link hops from a seed (default 3)
  --per-template <n>                  max pages per dynamic route (default 3)
  --max-journeys <n>                  max draft journeys (default 12)
  --concurrency <n>                   parallel workers (auto when omitted)
  --sitemap [<url>]                   seed from sitemap.xml (default; on by
                                      default — BASE_URL/sitemap.xml)
  --no-sitemap                        crawl from <base> by following links only
  --no-screenshots                    skip per-page screenshots (faster)
  --device <name>                     form factor to crawl as (desktop,
                                      tablet, mobile, or a Playwright device)
  --viewport <width>x<height>         override just the viewport size
  --no-session                        crawl anonymously
  --filter <regex>  --exclude <regex> keep / drop matching paths
  --force                             overwrite existing draft journeys

ENV
  WEB_TESTER_BASE_URL                 default http://localhost:3000
  WEB_TESTER_RUNS_DIR                 where run artifacts go (default ./runs)
  GOTO_TIMEOUT_MS                     default 30000
  STEP_TIMEOUT_MS                     default 15000
  SETTLE_TIMEOUT_MS                   default 30000

PROJECT FILES (cwd-relative, all optional)
  .web-tester/impact-rules.json       rules consumed by 'impact'
  .web-tester/urls-<name>.txt         URL presets consumed by 'sweep --preset'
  .web-tester/journeys/<name>.json    saved journeys consumed by 'journey'
  .web-tester/instructions/*.md       knowledge base, browsed via 'kb'
  (or .web-tester/*.md for small projects)
`);
}

type CommonFlags = {
  expectations: Expectation[];
  failOn: FailOnKind[];
};

function applyExpectFlag(args: CommonFlags, value: string): void {
  args.expectations.push(parseExpectation(value));
}

function applyFailOnFlag(args: CommonFlags, value: string): void {
  for (const kind of parseFailOn(value)) {
    if (!args.failOn.includes(kind)) args.failOn.push(kind);
  }
}

function parseInspectArgs(rest: string[]): InspectArgs {
  let url = "";
  let device: string | undefined;
  let viewport: string | undefined;
  const steps: Step[] = [];
  let headed = false;
  let captureHtml = false;
  let captureStorage = false;
  let captureAllNetwork = false;
  let captureAllConsole = false;
  let recordVideo = true;
  let fullPageScreenshots = true;
  let summary = false;
  let quick = false;
  let jsonStdout = false;
  let persistMs = 0;
  let loadStorageState = true;
  let saveSession = false;
  let deep = false;
  let saveJourney: string | undefined;
  const expectations: Expectation[] = [];
  // Raw `--step` / `--expect` strings, kept so `--save-journey` can persist the
  // exact flow the user ran (not the parsed objects).
  const rawSteps: string[] = [];
  const rawExpectations: string[] = [];
  const failOn: FailOnKind[] = [];

  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i] ?? "";
    if (arg === "--step") {
      const next = rest[++i];
      if (next === undefined) throw new Error("--step needs a value");
      steps.push(parseStep(next));
      rawSteps.push(next);
      continue;
    }
    if (arg.startsWith("--step=")) {
      const raw = arg.slice("--step=".length);
      steps.push(parseStep(raw));
      rawSteps.push(raw);
      continue;
    }
    if (arg === "--expect") {
      const next = rest[++i];
      if (next === undefined) throw new Error("--expect needs a value");
      applyExpectFlag({ expectations, failOn }, next);
      rawExpectations.push(next);
      continue;
    }
    if (arg.startsWith("--expect=")) {
      const raw = arg.slice("--expect=".length);
      applyExpectFlag({ expectations, failOn }, raw);
      rawExpectations.push(raw);
      continue;
    }
    if (arg === "--fail-on") {
      const next = rest[++i];
      if (next === undefined) throw new Error("--fail-on needs a value");
      applyFailOnFlag({ expectations, failOn }, next);
      continue;
    }
    if (arg.startsWith("--fail-on=")) {
      applyFailOnFlag({ expectations, failOn }, arg.slice("--fail-on=".length));
      continue;
    }
    if (arg === "--headed") {
      headed = true;
      continue;
    }
    if (arg === "--html") {
      captureHtml = true;
      continue;
    }
    if (arg === "--storage") {
      captureStorage = true;
      continue;
    }
    if (arg === "--all-network") {
      captureAllNetwork = true;
      continue;
    }
    if (arg === "--all-console") {
      captureAllConsole = true;
      continue;
    }
    if (arg === "--no-summary") {
      summary = false;
      continue;
    }
    if (arg === "--summary") {
      summary = true;
      continue;
    }
    if (arg === "--no-video") {
      recordVideo = false;
      continue;
    }
    if (arg === "--no-session") {
      loadStorageState = false;
      continue;
    }
    if (arg === "--device") {
      const next = rest[++i];
      if (next === undefined) throw new Error("--device needs a name");
      device = next;
      continue;
    }
    if (arg.startsWith("--device=")) {
      device = arg.slice("--device=".length);
      continue;
    }
    if (arg === "--viewport") {
      const next = rest[++i];
      if (next === undefined) throw new Error("--viewport needs <width>x<height>");
      viewport = next;
      continue;
    }
    if (arg.startsWith("--viewport=")) {
      viewport = arg.slice("--viewport=".length);
      continue;
    }
    if (arg === "--save-session") {
      saveSession = true;
      continue;
    }
    if (arg === "--deep") {
      deep = true;
      continue;
    }
    if (arg === "--quick") {
      quick = true;
      continue;
    }
    if (arg === "--persist") {
      const next = rest[++i];
      if (next === undefined) throw new Error("--persist needs a value (ms)");
      persistMs = Number(next);
      if (!Number.isFinite(persistMs) || persistMs < 0)
        throw new Error("--persist must be a non-negative integer (ms)");
      continue;
    }
    if (arg.startsWith("--persist=")) {
      persistMs = Number(arg.slice("--persist=".length));
      if (!Number.isFinite(persistMs) || persistMs < 0)
        throw new Error("--persist must be a non-negative integer (ms)");
      continue;
    }
    if (arg === "--json") {
      jsonStdout = true;
      continue;
    }
    if (arg === "--save-journey") {
      const next = rest[++i];
      if (next === undefined) throw new Error("--save-journey needs a name");
      saveJourney = next;
      continue;
    }
    if (arg.startsWith("--save-journey=")) {
      saveJourney = arg.slice("--save-journey=".length);
      continue;
    }
    if (arg === "--steps-file") {
      const next = rest[++i];
      if (next === undefined) throw new Error("--steps-file needs a path");
      const raw = readFileSync(resolve(next), "utf-8");
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed))
        throw new Error("--steps-file JSON must be an array of strings");
      for (const s of parsed) {
        if (typeof s !== "string")
          throw new Error("--steps-file entries must be strings");
        steps.push(parseStep(s));
        rawSteps.push(s);
      }
      continue;
    }
    if (arg.startsWith("--")) {
      throw new Error(`unknown flag: ${arg}`);
    }
    if (!url) {
      url = arg;
    } else {
      throw new Error(`unexpected positional arg: ${arg}`);
    }
  }

  if (!url) throw new Error("inspect needs a URL");

  // --quick is a speed preset: it forces the heavy capture options off
  // regardless of where it appears among the flags.
  if (quick) {
    if (recordVideo) recordVideo = false;
    if (fullPageScreenshots) fullPageScreenshots = false;
    if (summary) summary = false;
    if (captureHtml) captureHtml = false;
  }

  return {
    url,
    ...(device !== undefined ? { device } : {}),
    ...(viewport !== undefined ? { viewport } : {}),
    steps,
    headed,
    captureHtml,
    captureStorage,
    captureAllNetwork,
    captureAllConsole,
    recordVideo,
    fullPageScreenshots,
    summary,
    expectations,
    persistMs,
    failOn,
    deep,
    jsonStdout,
    loadStorageState,
    saveSession,
    ...(saveJourney !== undefined ? { saveJourney } : {}),
    rawSteps,
    rawExpectations
  };
}

function summariseConsole(result: InspectResult): string {
  const { totals } = result.console;
  const parts = Object.entries(totals).map(([k, v]) => `${k}=${v}`);
  return parts.length ? parts.join(", ") : "0";
}

function topNetworkFailures(result: InspectResult, limit = 5): string[] {
  return result.network.entries
    .filter(
      (e) => (e.status !== null && e.status >= 400) || e.failureText !== null
    )
    .slice(0, limit)
    .map((e) =>
      e.failureText
        ? `${e.method} ${e.url} — ${e.failureText}`
        : `${e.status} ${e.method} ${e.url}`
    );
}

function printSummary(result: InspectResult): void {
  log.header(result.ok ? "result: ok" : "result: issues");
  log.info(`  URL:        ${result.requestedUrl}`);
  log.info(`  finalURL:   ${result.finalUrl}`);
  if (result.title) log.info(`  title:      ${result.title}`);
  log.info(`  duration:   ${result.durationMs}ms`);
  log.info(`  steps:      ${result.steps.length} (${result.failedSteps} failed)`);
  log.info(`  console:    ${summariseConsole(result)}`);
  log.info(
    `  network:    ${result.network.count} (${result.network.failedCount} failed/blocked)`
  );
  if (result.verdictTriggers.length > 0) {
    log.fail(`  verdict:    fail`);
    for (const t of result.verdictTriggers) log.fail(`    · ${t}`);
  } else if (result.expectations.length > 0 || result.failOn.length > 0) {
    log.ok(`  verdict:    pass`);
  }
  if (result.expectations.length > 0) {
    log.info(`  expectations:`);
    for (const r of result.expectations) {
      const tag = r.ok ? "✓" : "✗";
      const desc = describeExpectation(r.expectation);
      if (r.ok) log.dim(`    ${tag} ${desc}`);
      else log.fail(`    ${tag} ${desc} — ${r.detail ?? "failed"}`);
    }
  }
  if (result.pageErrors.length) {
    const grouped = new Map<string, number>();
    for (const e of result.pageErrors)
      grouped.set(e.message, (grouped.get(e.message) ?? 0) + 1);
    log.fail(`  pageErrors: ${result.pageErrors.length} (${grouped.size} unique)`);
    for (const [msg, count] of Array.from(grouped.entries()).slice(0, 5)) {
      const tag = count > 1 ? ` (×${count})` : "";
      log.fail(`    · ${msg.split("\n")[0]}${tag}`);
    }
  }
  const failures = topNetworkFailures(result);
  if (failures.length) {
    log.warn(`  failed requests:`);
    for (const f of failures) log.warn(`    · ${f}`);
  }
  if (result.deepErrors?.length) {
    log.fail(`  uncaught exceptions (with scope):`);
    for (const e of result.deepErrors.slice(0, 5)) {
      log.fail(`    · ${e.reason} — in ${e.functionName}${e.location ? ` (${e.location})` : ""}`);
      for (const scope of e.scopes) {
        const vars = Object.entries(scope.vars)
          .slice(0, 6)
          .map(([k, v]) => `${k}=${v}`)
          .join(", ");
        if (vars) log.dim(`        ${scope.type}: ${vars}`);
      }
    }
  }
  if (result.unhandledRejections?.length) {
    log.fail(`  unhandled rejections:`);
    for (const r of result.unhandledRejections.slice(0, 5))
      log.fail(`    · ${r}`);
  }
  const evals = result.steps.filter((s) => s.evalResult !== undefined);
  if (evals.length) {
    log.info(`  evals:`);
    for (const s of evals) {
      const json = JSON.stringify(s.evalResult);
      const compact = json.length > 200 ? `${json.slice(0, 200)}…` : json;
      log.info(`    step ${s.index}: ${compact}`);
    }
  }
  if (result.final.attrs.length) {
    log.dim(`  attrs:      ${result.final.attrs.length} marked on page`);
    for (const a of result.final.attrs.slice(0, 6))
      log.dim(`    · ${a.name}=${a.label || a.value}`);
    if (result.final.attrs.length > 6)
      log.dim(`    … ${result.final.attrs.length - 6} more in result.json`);
  }
  if (result.summary) {
    log.info("");
    log.info(`  summary:`);
    for (const line of result.summary.split("\n"))
      log.raw(`    ${line}`);
  }
  log.info("");
  log.ok(`  HTML report: ${result.runDir}/report.html`);
  log.info(`  result.json: ${result.runDir}/result.json`);
  if (result.video) log.info(`  video:       ${result.runDir}/${result.video}`);
  log.dim(`  (open the HTML report to see steps, video, console + network — the JSON is for programmatic reads)`);
}

function describeExpectation(e: Expectation): string {
  if (e.kind === "text") return `text="${e.text}"`;
  if (e.kind === "no-text") return `no-text="${e.text}"`;
  if (e.kind === "selector") return `selector="${e.selector}"`;
  if (e.kind === "no-selector") return `no-selector="${e.selector}"`;
  return `attr ${e.name}="${e.value}"`;
}

async function commandInspect(rest: string[]): Promise<void> {
  const args = parseInspectArgs(rest);
  const devices = resolveDeviceList(args.device, args.viewport);
  log.header(`inspect ${args.url}`);
  log.dim(`base: ${BASE_URL}`);
  if (devices.length > 1)
    log.dim(`devices: ${devices.map((d) => d.name).join(", ")}`);

  let anyFailed = false;
  for (let i = 0; i < devices.length; i++) {
    const device = devices[i]!;
    if (devices.length > 1)
      log.header(`${device.name} (${device.viewport.width}x${device.viewport.height})`);
    const result = await runInspect({
      baseUrl: BASE_URL,
      url: args.url,
      device,
      steps: args.steps,
      headed: args.headed,
      captureHtml: args.captureHtml,
      captureStorage: args.captureStorage,
      captureAllNetwork: args.captureAllNetwork,
      captureAllConsole: args.captureAllConsole,
      recordVideo: args.recordVideo,
      fullPageScreenshots: args.fullPageScreenshots,
      summary: args.summary,
      expectations: args.expectations,
      persistMs: args.persistMs,
      failOn: args.failOn,
      deep: args.deep,
      gotoTimeoutMs: GOTO_TIMEOUT_MS,
      loadStorageState: args.loadStorageState,
      // Saving cookies is form-factor independent; only the first run saves.
      saveSession: args.saveSession && i === 0
    });
    if (args.jsonStdout) log.raw(JSON.stringify(result, null, 2));
    else printSummary(result);
    if (!result.ok) anyFailed = true;
  }

  // Persist this run's flow as a reusable journey (plain text — url + steps +
  // assertions only, no run artifacts). Reruns replay it with `journey <name>`.
  if (args.saveJourney) {
    const journey: Journey = {
      description: `Saved from \`web-tester inspect ${args.url}\`.`,
      url: args.url,
      steps: args.rawSteps,
      ...(args.rawExpectations.length ? { expectations: args.rawExpectations } : {}),
      ...(args.failOn.length ? { failOn: args.failOn.join(",") } : {}),
      ...(args.persistMs > 0 ? { persistMs: args.persistMs } : {})
    };
    try {
      const path = saveJourney(args.saveJourney, journey);
      log.ok(`  saved journey: ${path}`);
      log.dim(`  rerun it anytime: web-tester journey ${args.saveJourney.replace(/\.json$/i, "")}`);
    } catch (err) {
      log.fail(`  could not save journey: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (anyFailed) process.exitCode = 1;
}

type SweepArgs = {
  /** Raw URL lines (may carry `#pack=<name>` annotations). */
  urls: string[];
  concurrency: number;
  failOn: FailOnKind[];
  /** Global expectations applied to every URL on top of any inline pack. */
  expectations: Expectation[];
  /** Default packs (names) applied to every URL on top of any inline pack. */
  defaultPacks: string[];
  /** Load the saved session into each worker context (false = anonymous). */
  loadStorageState: boolean;
  /** Device name to emulate for every URL. */
  device?: string;
  /** `<width>x<height>` viewport override. */
  viewport?: string;
};

function loadUrlsFromFile(path: string): string[] {
  const raw = readFileSync(path, "utf-8");
  const out: string[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    out.push(trimmed);
  }
  return out;
}

function resolvePreset(name: string): string {
  // Presets live as `urls-<name>.txt` inside the user's `.web-tester/` so
  // they sit alongside impact-rules.json and journeys/ for the project.
  const candidate = resolve(userPresetsDir(), `urls-${name}.txt`);
  if (!existsSync(candidate)) {
    const known = listPresets();
    const help =
      known.length > 0
        ? `Available presets: ${known.join(", ")}`
        : "No presets found. Create a file at .web-tester/urls-<name>.txt and re-run with --preset <name>.";
    throw new Error(
      `unknown --preset "${name}". Looked for ${candidate}. ${help}`
    );
  }
  return candidate;
}

function listPresets(): string[] {
  try {
    const dir = userPresetsDir();
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((f) => f.startsWith("urls-") && f.endsWith(".txt"))
      .map((f) => f.slice("urls-".length, -".txt".length));
  } catch {
    return [];
  }
}

async function parseSweepArgs(rest: string[]): Promise<SweepArgs> {
  const urls: string[] = [];
  // -1 = auto (computed in commandSweep from URL count + target).
  let concurrency = -1;
  const expectations: Expectation[] = [];
  const failOn: FailOnKind[] = [];
  const sitemapSources: string[] = [];
  const defaultPacks: string[] = [];
  let filter: RegExp | undefined;
  let exclude: RegExp | undefined;
  let limit = 0;
  let loadStorageState = true;
  let device: string | undefined;
  let viewport: string | undefined;

  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i] ?? "";
    if (arg === "--device") {
      const next = rest[++i];
      if (next === undefined) throw new Error("--device needs a name");
      device = next;
      continue;
    }
    if (arg === "--viewport") {
      const next = rest[++i];
      if (next === undefined) throw new Error("--viewport needs <width>x<height>");
      viewport = next;
      continue;
    }
    if (arg === "--url") {
      const next = rest[++i];
      if (next === undefined) throw new Error("--url needs a value");
      urls.push(next);
      continue;
    }
    if (arg === "--urls-file") {
      const next = rest[++i];
      if (next === undefined) throw new Error("--urls-file needs a path");
      for (const u of loadUrlsFromFile(resolve(next))) urls.push(u);
      continue;
    }
    if (arg === "--preset") {
      const next = rest[++i];
      if (next === undefined) throw new Error("--preset needs a name");
      for (const u of loadUrlsFromFile(resolvePreset(next))) urls.push(u);
      continue;
    }
    if (arg === "--sitemap") {
      // `--sitemap` alone → use <BASE_URL>/sitemap.xml.
      // `--sitemap <http(s):// ...>` → use that explicit URL.
      const next = rest[i + 1];
      if (next && next.startsWith("http")) {
        sitemapSources.push(next);
        i++;
      } else {
        sitemapSources.push(`${BASE_URL}/sitemap.xml`);
      }
      continue;
    }
    if (arg === "--filter") {
      const next = rest[++i];
      if (next === undefined) throw new Error("--filter needs a regex");
      filter = new RegExp(next);
      continue;
    }
    if (arg === "--exclude") {
      const next = rest[++i];
      if (next === undefined) throw new Error("--exclude needs a regex");
      exclude = new RegExp(next);
      continue;
    }
    if (arg === "--limit") {
      const next = rest[++i];
      if (next === undefined) throw new Error("--limit needs a number");
      limit = Number.parseInt(next, 10);
      if (!Number.isFinite(limit) || limit < 1)
        throw new Error(`--limit must be a positive integer: ${next}`);
      continue;
    }
    if (arg === "--concurrency") {
      const next = rest[++i];
      if (next === undefined) throw new Error("--concurrency needs a number");
      const parsed = Number.parseInt(next, 10);
      if (!Number.isFinite(parsed) || parsed < 1)
        throw new Error(`--concurrency must be a positive integer: ${next}`);
      // Cap at 32 — beyond that you tend to saturate one Chromium's memory
      // and the target server's per-IP connection limits, so wall time stops
      // improving meaningfully.
      concurrency = Math.min(32, parsed);
      if (parsed > 32) log.warn(`--concurrency ${parsed} clamped to 32`);
      continue;
    }
    if (arg === "--expect") {
      const next = rest[++i];
      if (next === undefined) throw new Error("--expect needs a value");
      applyExpectFlag({ expectations, failOn }, next);
      continue;
    }
    if (arg === "--fail-on") {
      const next = rest[++i];
      if (next === undefined) throw new Error("--fail-on needs a value");
      applyFailOnFlag({ expectations, failOn }, next);
      continue;
    }
    if (arg === "--pack") {
      const next = rest[++i];
      if (next === undefined) throw new Error("--pack needs a name");
      // Validate eagerly so a typo doesn't silently disable assertions.
      getBuiltInPack(next);
      defaultPacks.push(next);
      continue;
    }
    if (arg === "--no-session") {
      loadStorageState = false;
      continue;
    }
    if (arg.startsWith("--")) throw new Error(`unknown flag: ${arg}`);
    urls.push(arg);
  }

  // Fetch every requested sitemap and append its paths. Done after arg
  // parsing so --filter / --exclude (applied below) cover sitemap-sourced
  // URLs uniformly with explicit ones.
  for (const sm of sitemapSources) {
    log.dim(`fetching sitemap: ${sm}`);
    const paths = await fetchSitemapPaths({ url: sm });
    log.dim(`  + ${paths.length} URLs from sitemap`);
    for (const p of paths) urls.push(p);
  }

  // Parse `#pack=...` annotations off each line, then dedupe by path
  // (later occurrences override earlier — useful for "override the
  // bundled preset's pack on one URL"). filter/exclude/limit apply
  // uniformly across all sources.
  const parsedByPath = new Map<string, { path: string; packs: string[] }>();
  for (const line of urls) {
    const parsed = parseUrlLine(line);
    if (!parsed.path) continue;
    parsedByPath.set(parsed.path, parsed);
  }
  let parsedList = Array.from(parsedByPath.values());
  if (filter) parsedList = parsedList.filter((u) => filter!.test(u.path));
  if (exclude) parsedList = parsedList.filter((u) => !exclude!.test(u.path));
  if (limit > 0 && parsedList.length > limit)
    parsedList = parsedList.slice(0, limit);

  if (parsedList.length === 0)
    throw new Error(
      "sweep needs at least one URL via --url, --urls-file, --preset, or --sitemap (after --filter/--exclude)"
    );

  // Eagerly validate every pack name the URL list references so a typo
  // doesn't silently disable assertions for whole pages.
  for (const u of parsedList)
    for (const name of u.packs) getBuiltInPack(name);

  // Flatten back to raw lines for the SweepArgs.urls shape. commandSweep
  // re-parses to produce the final SweepUrl[] (so it can layer in
  // default packs + global expectations).
  const flatLines = parsedList.map((u) =>
    u.packs.length ? `${u.path} ${u.packs.map((p) => `#pack=${p}`).join(" ")}` : u.path
  );
  return {
    urls: flatLines,
    concurrency,
    failOn,
    expectations,
    defaultPacks,
    loadStorageState,
    ...(device !== undefined ? { device } : {}),
    ...(viewport !== undefined ? { viewport } : {})
  };
}

/**
 * Pick a sensible concurrency from URL count + target. Used when the user
 * didn't pass `--concurrency` explicitly. Reasoning:
 *
 * - **localhost**: CPU-bound. The dev server can typically handle 8 concurrent
 *   browser contexts comfortably.
 * - **anything else** (staging / preview / prod): network throughput and
 *   any upstream rate limits become the binding constraint. Scale gently
 *   with URL count.
 */
function autoConcurrency(baseUrl: string, urlCount: number): {
  value: number;
  reason: string;
} {
  if (baseUrl.includes("localhost") || baseUrl.includes("127.0.0.1")) {
    const value = Math.min(8, Math.max(2, urlCount));
    return { value, reason: `local dev (${urlCount} URLs)` };
  }
  if (urlCount >= 50) return { value: 2, reason: `remote target, ${urlCount} URLs` };
  if (urlCount >= 20) return { value: 3, reason: `remote target, ${urlCount} URLs` };
  return { value: 4, reason: `remote target, ${urlCount} URLs` };
}

async function commandSweep(rest: string[]): Promise<void> {
  const args = await parseSweepArgs(rest);

  // Resolve each URL line into a SweepUrl with its full expectation set:
  // global --expect + global --pack expectations + inline #pack=...
  // expectations. Dedupe inline packs against global packs so the same
  // pack isn't applied twice.
  const sweepUrls = args.urls.map((line) => {
    const parsed = parseUrlLine(line);
    const allPackNames = Array.from(
      new Set([...args.defaultPacks, ...parsed.packs])
    );
    const packExpectations = allPackNames.flatMap((name) =>
      getBuiltInPack(name)
    );
    return {
      path: parsed.path,
      packs: allPackNames,
      expectations: [...args.expectations, ...packExpectations]
    };
  });

  let concurrency = args.concurrency;
  if (concurrency === -1) {
    const auto = autoConcurrency(BASE_URL, sweepUrls.length);
    concurrency = auto.value;
    log.dim(`concurrency: ${concurrency} (auto — ${auto.reason})`);
  }

  const device = resolveOneDevice(args.device, args.viewport);
  log.header(`sweep ${sweepUrls.length} URLs, ${concurrency} workers`);
  if (device.name !== "desktop")
    log.dim(`device: ${device.name} (${device.viewport.width}x${device.viewport.height})`);
  const opts: SweepOptions = {
    baseUrl: BASE_URL,
    urls: sweepUrls,
    concurrency,
    failOn: args.failOn,
    device,
    gotoTimeoutMs: GOTO_TIMEOUT_MS,
    loadStorageState: args.loadStorageState
  };
  const report = await runSweep(opts);
  if (report.failed > 0) process.exitCode = 1;
}

async function commandJourney(rest: string[]): Promise<void> {
  const [name, ...flags] = rest;
  if (!name || name === "--help" || name === "-h") {
    log.header("journeys");
    const journeys = listJourneys();
    if (journeys.length === 0) {
      log.info("  (none — add JSON files to .web-tester/journeys/)");
      return;
    }
    for (const j of journeys) {
      log.info(`  ${j.name.padEnd(28)} ${j.description}`);
    }
    log.dim("");
    log.dim("  web-tester journey <name>            # run a journey");
    log.dim("  web-tester journey <name> --headed   # see the browser");
    return;
  }

  const journey = loadJourney(name);
  log.header(`journey: ${name}`);
  if (journey.description) log.dim(`  ${journey.description}`);

  // Forward only the flags the user passed (e.g. --headed, --no-quick).
  // Journey JSON is the source of truth for url/steps/expectations/failOn;
  // CLI flags after the journey name only tweak run-time options.
  const stepArgs = journey.steps.flatMap((s) => ["--step", s]);
  const expectArgs = (journey.expectations ?? []).flatMap((e) => [
    "--expect",
    e
  ]);
  const failOnArgs = journey.failOn ? ["--fail-on", journey.failOn] : [];
  const persistArgs =
    journey.persistMs && journey.persistMs > 0
      ? ["--persist", String(journey.persistMs)]
      : [];
  // Journeys default to --quick unless the caller already passed something
  // that overrides it.
  const quickArg = flags.includes("--no-quick") ? [] : ["--quick"];
  const userFlags = flags.filter((f) => f !== "--no-quick");

  const argv = [
    journey.url,
    ...stepArgs,
    ...expectArgs,
    ...failOnArgs,
    ...persistArgs,
    ...quickArg,
    ...userFlags
  ];
  await commandInspect(argv);
}

type ImpactArgs = {
  base: string;
  rulesPath: string;
  planOnly: boolean;
};

function parseImpactArgs(rest: string[]): ImpactArgs {
  let base = "origin/main";
  let rulesPath = defaultImpactRulesPath();
  let planOnly = false;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i] ?? "";
    if (arg === "--base") {
      const next = rest[++i];
      if (next === undefined) throw new Error("--base needs a git ref");
      base = next;
      continue;
    }
    if (arg === "--rules") {
      const next = rest[++i];
      if (next === undefined) throw new Error("--rules needs a path");
      rulesPath = resolve(next);
      continue;
    }
    if (arg === "--plan-only") {
      planOnly = true;
      continue;
    }
    throw new Error(`unknown flag: ${arg}`);
  }
  return { base, rulesPath, planOnly };
}

async function commandImpact(rest: string[]): Promise<void> {
  const args = parseImpactArgs(rest);

  if (!existsSync(args.rulesPath)) {
    log.header("impact");
    log.dim(`  no rules file at ${args.rulesPath}`);
    log.dim(
      "  create .web-tester/impact-rules.json to enable diff-aware runs."
    );
    log.dim(
      "  see README — 'impact-rules.json' section — for the schema and examples."
    );
    return;
  }

  const rules = loadImpactRules(args.rulesPath);
  const changed = getChangedFiles(args.base, process.cwd());
  const matched = matchRules(rules, changed);

  printPlan(matched, changed, args.base);

  if (args.planOnly) return;
  if (matched.length === 0) return;

  log.header("running impact suite");
  log.dim(
    "  advisory — output is informational; exit code stays 0 either way"
  );
  log.info("");

  const findings: string[] = [];
  let runIndex = 0;
  for (const m of matched) {
    runIndex++;
    log.info(
      `  [${runIndex}/${matched.length}] ${m.rule.name}`
    );
    try {
      if (m.rule.sweep) {
        const sweepArgs: string[] = [];
        if (m.rule.sweep.preset) sweepArgs.push("--preset", m.rule.sweep.preset);
        for (const u of m.rule.sweep.urls ?? []) sweepArgs.push("--url", u);
        for (const p of m.rule.sweep.packs ?? []) sweepArgs.push("--pack", p);
        sweepArgs.push("--fail-on", "http-5xx");
        const beforeExit = process.exitCode ?? 0;
        await commandSweep(sweepArgs);
        const afterExit = process.exitCode ?? 0;
        if (afterExit !== beforeExit) {
          findings.push(
            `${m.rule.name} (sweep) — one or more URLs failed; see the sweep report above`
          );
        }
        process.exitCode = beforeExit;
      } else if (m.rule.journey) {
        const beforeExit = process.exitCode ?? 0;
        await commandJourney([m.rule.journey]);
        const afterExit = process.exitCode ?? 0;
        if (afterExit !== beforeExit) {
          findings.push(
            `${m.rule.name} (journey ${m.rule.journey}) — journey reported a failed assertion or 5xx`
          );
        }
        process.exitCode = beforeExit;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      findings.push(`${m.rule.name} — runner threw: ${msg}`);
    }
    log.info("");
  }

  // Advisory summary. Always exits 0.
  log.header(
    findings.length === 0
      ? "impact: nothing flagged"
      : `impact: ${findings.length} advisory finding(s)`
  );
  if (findings.length === 0) {
    log.dim(
      "  nothing in the matched rules tripped. Reminder: impact only checks"
    );
    log.dim(
      "  the areas wired up in .web-tester/impact-rules.json — it's not exhaustive."
    );
  } else {
    log.dim("  these are advisory — your push will proceed regardless.");
    for (const f of findings) log.warn(`  ⚠ ${f}`);
    log.info("");
    log.dim(
      "  Open the HTML reports linked above to see screenshots/video/network."
    );
  }
  // Force exit 0 — advisory only.
  process.exitCode = 0;
}

type InitFlags = {
  force: boolean;
  agentFile: string | null | undefined;
  yes: boolean;
  baseUrl: string | undefined;
  device: string | undefined;
  autoUse: AutoUse | undefined;
  skill: boolean;
  installBrowser: boolean | undefined;
};

function parseInitArgs(rest: string[]): InitFlags {
  const flags: InitFlags = {
    force: false,
    agentFile: undefined,
    yes: false,
    baseUrl: undefined,
    device: undefined,
    autoUse: undefined,
    skill: true,
    installBrowser: undefined
  };
  const takeAutoUse = (v: string | undefined): AutoUse => {
    if (v !== "on" && v !== "ask" && v !== "off")
      throw new Error(`--auto-use must be on|ask|off (got "${v}")`);
    return v;
  };
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i] ?? "";
    if (arg === "--force") flags.force = true;
    else if (arg === "--yes" || arg === "-y") flags.yes = true;
    else if (arg === "--no-agent") flags.agentFile = null;
    else if (arg === "--no-skill") flags.skill = false;
    else if (arg === "--install-browser") flags.installBrowser = true;
    else if (arg === "--no-install-browser") flags.installBrowser = false;
    else if (arg === "--agent-file") {
      const next = rest[++i];
      if (next === undefined) throw new Error("--agent-file needs a path");
      flags.agentFile = next;
    } else if (arg.startsWith("--agent-file=")) {
      flags.agentFile = arg.slice("--agent-file=".length);
    } else if (arg === "--base-url") {
      const next = rest[++i];
      if (next === undefined) throw new Error("--base-url needs a value");
      flags.baseUrl = next;
    } else if (arg.startsWith("--base-url=")) {
      flags.baseUrl = arg.slice("--base-url=".length);
    } else if (arg === "--device") {
      const next = rest[++i];
      if (next === undefined) throw new Error("--device needs a value");
      flags.device = next;
    } else if (arg.startsWith("--device=")) {
      flags.device = arg.slice("--device=".length);
    } else if (arg === "--auto-use") {
      flags.autoUse = takeAutoUse(rest[++i]);
    } else if (arg.startsWith("--auto-use=")) {
      flags.autoUse = takeAutoUse(arg.slice("--auto-use=".length));
    } else throw new Error(`unknown flag: ${arg}`);
  }
  return flags;
}

function installChromium(): void {
  log.info("");
  log.header("installing chromium");
  const res = spawnSync("npx", ["playwright", "install", "chromium"], {
    stdio: "inherit"
  });
  if (res.status !== 0)
    log.warn(
      "  chromium install didn't complete — run `npx playwright install chromium` yourself."
    );
}

function reportInit(result: InitResult): void {
  if (result.written.length) {
    log.ok(`  wrote ${result.written.length} file(s):`);
    for (const f of result.written) log.info(`    + ${f}`);
  }
  if (result.skipped.length) {
    log.dim(
      `  skipped ${result.skipped.length} existing file(s) (--force to overwrite):`
    );
    for (const f of result.skipped) log.dim(`    · ${f}`);
  }
  if (result.agentFile)
    log.ok(
      `  ${result.agentAdded ? "added" : "updated"} web-tester section in ${result.agentFile}`
    );
  if (result.skillFile && result.written.includes(result.skillFile))
    log.ok(`  generated Claude Code skill: ${result.skillFile}`);
  if (result.autoUse)
    log.ok(`  set WEB_TESTER_AUTO_USE="${result.autoUse}" in .claude/settings.local.json`);
  for (const w of result.warnings) log.warn(`  ⚠ ${w}`);
}

async function commandInit(
  rest: string[],
  opts: { firstRun?: boolean } = {}
): Promise<void> {
  const flags = parseInitArgs(rest);
  const interactive = isInteractive() && !flags.yes;

  let baseUrl = flags.baseUrl ?? readProjectConfig().baseUrl ?? DEFAULT_BASE_URL;
  let device = flags.device ?? readProjectConfig().device ?? "desktop";
  let agentFile = flags.agentFile;
  let autoUse: AutoUse = flags.autoUse ?? "ask";
  let skill = flags.skill;
  let installBrowser = flags.installBrowser ?? false;

  if (interactive) {
    log.header(
      opts.firstRun
        ? "Welcome to web-tester — let's set up this project"
        : "web-tester setup"
    );
    log.dim("  Press Enter to accept the [DEFAULT]. Ctrl-C to cancel.");
    log.info("");
    baseUrl = await ask("Dev server base URL", baseUrl);
    device = await ask(
      "Default device (desktop, tablet, mobile, or a Playwright device)",
      device
    );
    if (agentFile === undefined) {
      const pick = await choice(
        "Write agent instructions to",
        ["claude", "agents", "none"] as const,
        "claude"
      );
      agentFile = pick === "none" ? null : pick === "agents" ? "AGENTS.md" : "CLAUDE.md";
    }
    if (flags.autoUse === undefined) {
      autoUse = await choice(
        "When should Claude use web-tester? (on=auto, ask=propose first, off=manual)",
        ["on", "ask", "off"] as const,
        "ask"
      );
    }
    skill = await confirm(
      "Generate a Claude Code skill so Claude can run it natively?",
      skill
    );
    if (flags.installBrowser === undefined) {
      installBrowser = await confirm(
        "Install the Playwright Chromium browser now (~150 MB)?",
        false
      );
    }
    log.info("");
  }

  // Validate the chosen device before persisting it, so a typo doesn't get
  // baked into config.json and break every later command.
  try {
    resolveDevice({ name: device, custom: readProjectConfig().devices });
  } catch (err) {
    log.warn(`  ${err instanceof Error ? err.message : String(err)}`);
    log.dim("  falling back to device: desktop");
    device = "desktop";
  }

  log.header("init");
  let result: InitResult;
  try {
    result = runInit({ cwd: process.cwd(), force: flags.force, agentFile, baseUrl, device, autoUse, skill });
  } catch (err) {
    log.fail(`  ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
    return;
  }
  reportInit(result);

  if (installBrowser) installChromium();

  log.info("");
  log.header("next steps");
  log.info(`  1. Start your dev server (serving ${baseUrl}).`);
  log.info("  2. Map the site — auto-generates a preset, recipes, and journeys:");
  log.dim("       npx web-tester-for-claude map");
  log.info("  3. Smoke-check a page:");
  log.dim('       npx web-tester-for-claude inspect / --quick --expect "selector=main" --fail-on http-5xx');
  if (result.skillFile)
    log.dim("  Claude Code picks up the new skill automatically in its next session.");
}

type MapArgs = {
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
  force: boolean;
  device?: string;
  viewport?: string;
  filter?: RegExp;
  exclude?: RegExp;
};

function parseMapArgs(rest: string[]): MapArgs {
  let baseArg = "";
  let limit = 50;
  let depth = 3;
  let concurrency = -1;
  let perTemplate = 3;
  let device: string | undefined;
  let viewport: string | undefined;
  let maxJourneys = 12;
  let useSitemap = true;
  let sitemapUrl: string | undefined;
  let captureScreenshots = true;
  let loadStorageState = true;
  let force = false;
  let filter: RegExp | undefined;
  let exclude: RegExp | undefined;

  const intFlag = (next: string | undefined, name: string): number => {
    if (next === undefined) throw new Error(`${name} needs a number`);
    const n = Number.parseInt(next, 10);
    if (!Number.isFinite(n) || n < 1)
      throw new Error(`${name} must be a positive integer: ${next}`);
    return n;
  };

  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i] ?? "";
    if (arg === "--device") {
      const next = rest[++i];
      if (next === undefined) throw new Error("--device needs a name");
      device = next;
      continue;
    }
    if (arg === "--viewport") {
      const next = rest[++i];
      if (next === undefined) throw new Error("--viewport needs <width>x<height>");
      viewport = next;
      continue;
    }
    if (arg === "--limit") {
      limit = intFlag(rest[++i], "--limit");
      continue;
    }
    if (arg === "--depth") {
      depth = intFlag(rest[++i], "--depth");
      continue;
    }
    if (arg === "--concurrency") {
      concurrency = Math.min(32, intFlag(rest[++i], "--concurrency"));
      continue;
    }
    if (arg === "--per-template") {
      perTemplate = intFlag(rest[++i], "--per-template");
      continue;
    }
    if (arg === "--max-journeys") {
      maxJourneys = intFlag(rest[++i], "--max-journeys");
      continue;
    }
    if (arg === "--no-sitemap") {
      useSitemap = false;
      continue;
    }
    if (arg === "--sitemap") {
      const next = rest[i + 1];
      if (next && next.startsWith("http")) {
        sitemapUrl = next;
        i++;
      }
      useSitemap = true;
      continue;
    }
    if (arg === "--no-screenshots") {
      captureScreenshots = false;
      continue;
    }
    if (arg === "--no-session") {
      loadStorageState = false;
      continue;
    }
    if (arg === "--force") {
      force = true;
      continue;
    }
    if (arg === "--filter") {
      const next = rest[++i];
      if (next === undefined) throw new Error("--filter needs a regex");
      filter = new RegExp(next);
      continue;
    }
    if (arg === "--exclude") {
      const next = rest[++i];
      if (next === undefined) throw new Error("--exclude needs a regex");
      exclude = new RegExp(next);
      continue;
    }
    if (arg.startsWith("--")) throw new Error(`unknown flag: ${arg}`);
    if (!baseArg) baseArg = arg;
    else throw new Error(`unexpected positional arg: ${arg}`);
  }

  // A positional arg can be a full URL or a path to map a subtree of BASE_URL.
  const baseUrl = baseArg
    ? baseArg.startsWith("http")
      ? baseArg
      : new URL(baseArg, BASE_URL).toString()
    : BASE_URL;

  return {
    baseUrl,
    limit,
    depth,
    concurrency,
    perTemplate,
    maxJourneys,
    useSitemap,
    ...(sitemapUrl ? { sitemapUrl } : {}),
    captureScreenshots,
    loadStorageState,
    force,
    ...(device !== undefined ? { device } : {}),
    ...(viewport !== undefined ? { viewport } : {}),
    ...(filter ? { filter } : {}),
    ...(exclude ? { exclude } : {})
  };
}

async function commandMap(rest: string[]): Promise<void> {
  const args = parseMapArgs(rest);
  let concurrency = args.concurrency;
  if (concurrency === -1) {
    const auto = autoConcurrency(args.baseUrl, args.limit);
    concurrency = auto.value;
    log.dim(`concurrency: ${concurrency} (auto — ${auto.reason})`);
  }
  await runMap({
    baseUrl: args.baseUrl,
    limit: args.limit,
    depth: args.depth,
    concurrency,
    perTemplate: args.perTemplate,
    maxJourneys: args.maxJourneys,
    useSitemap: args.useSitemap,
    ...(args.sitemapUrl ? { sitemapUrl: args.sitemapUrl } : {}),
    captureScreenshots: args.captureScreenshots,
    loadStorageState: args.loadStorageState,
    force: args.force,
    device: resolveOneDevice(args.device, args.viewport),
    gotoTimeoutMs: GOTO_TIMEOUT_MS,
    ...(args.filter ? { filter: args.filter } : {}),
    ...(args.exclude ? { exclude: args.exclude } : {})
  });
}

function commandKb(rest: string[]): void {
  const [topic] = rest;
  if (!topic) {
    const all = listKnowledge();
    log.header("knowledge files");
    if (all.length === 0) {
      log.info("  (none — add .md files to .web-tester/instructions/ or .web-tester/)");
      return;
    }
    for (const k of all) {
      log.info(`  ${k.topic.padEnd(28)} ${k.title}`);
    }
    log.dim("");
    log.dim(`  web-tester kb <topic>   # print full contents`);
    return;
  }
  const k = readKnowledge(topic);
  log.raw(k.contents);
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  switch (command) {
    case "init":
      await commandInit(rest);
      break;
    case "map":
      await commandMap(rest);
      break;
    case "inspect":
      await commandInspect(rest);
      break;
    case "sweep":
      await commandSweep(rest);
      break;
    case "journey":
      await commandJourney(rest);
      break;
    case "impact":
      await commandImpact(rest);
      break;
    case "kb":
      commandKb(rest);
      break;
    case undefined:
      // Bare `web-tester` in a fresh project (no .web-tester/) on a terminal
      // drops straight into first-run setup; otherwise it prints help.
      if (!existsSync(userConfigDir()) && isInteractive()) {
        await commandInit([], { firstRun: true });
      } else {
        printHelp();
      }
      break;
    case "help":
    case "--help":
    case "-h":
      printHelp();
      break;
    default:
      log.fail(`unknown command: ${command}`);
      log.info("");
      log.info(
        "Known commands: init, map, inspect, sweep, journey, impact, kb, help"
      );
      log.dim("  Run `web-tester help` for the full reference.");
      process.exit(1);
  }
}

main().catch((err) => {
  log.fail(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
