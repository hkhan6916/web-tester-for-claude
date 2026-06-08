import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  chromium,
  type Browser,
  type BrowserContext
} from "playwright";
import { readUiAttributes } from "./browser/attrs";
import { DEFAULT_DEVICE, type Device, deviceContextOptions } from "./browser/devices";
import { configureContext } from "./browser/session";
import { attachCapture } from "./inspector/capture";
import {
  computeVerdict,
  evaluateExpectations,
  type Expectation,
  type ExpectationResult,
  type FailOnKind
} from "./inspector/verdict";
import { log } from "./util/log";
import { newRunId, RUNS_DIR, SESSION_STATE_PATH } from "./util/paths";

/** One URL in a sweep, plus the specific expectations to evaluate on it. */
export type SweepUrl = {
  /** Path or absolute URL — resolved against `baseUrl` if relative. */
  path: string;
  /** Per-URL expectations (already merged with any global packs). */
  expectations: Expectation[];
  /** Pack names this URL inherits from (for the aggregate report). */
  packs: string[];
};

export type SweepOptions = {
  baseUrl: string;
  urls: SweepUrl[];
  concurrency: number;
  failOn: FailOnKind[];
  /** Form factor to emulate for every URL. Defaults to desktop. */
  device?: Device;
  gotoTimeoutMs: number;
  /**
   * Load `~/.web-tester/session.json` into each worker context when the
   * file exists. Defaults to true; pass `false` (CLI `--no-session`) to
   * force an anonymous sweep — useful when verifying a logged-out flow
   * regression.
   */
  loadStorageState?: boolean;
};

export type SweepEntry = {
  url: string;
  finalUrl: string;
  status: number | null;
  title: string;
  durationMs: number;
  ok: boolean;
  triggers: string[];
  expectations: ExpectationResult[];
  pageErrors: number;
  consoleErrors: number;
  http4xx: number;
  http5xx: number;
  screenshot: string;
  /** Relative path under the sweep dir to a per-URL minimal JSON. */
  detailJson: string;
};

export type SweepReport = {
  sweepId: string;
  startedAt: string;
  durationMs: number;
  baseUrl: string;
  concurrency: number;
  total: number;
  passed: number;
  failed: number;
  failOn: FailOnKind[];
  /** Distinct pack names referenced anywhere in the input URL set. */
  packs: string[];
  entries: SweepEntry[];
};

function safeSlug(url: string, index: number): string {
  const cleaned = url
    .replace(/^https?:\/\//, "")
    .replace(/[^a-z0-9]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase()
    .slice(0, 60);
  return `${String(index).padStart(3, "0")}-${cleaned || "url"}`;
}

async function inspectOne(
  context: BrowserContext,
  baseUrl: string,
  sweepUrl: SweepUrl,
  sweepDir: string,
  slug: string,
  opts: {
    failOn: FailOnKind[];
    gotoTimeoutMs: number;
  }
): Promise<SweepEntry> {
  const started = Date.now();
  const page = await context.newPage();
  const buffers = attachCapture(context, page, {
    allNetwork: false,
    allConsole: false
  });

  const requestedUrl = sweepUrl.path.startsWith("http")
    ? sweepUrl.path
    : new URL(sweepUrl.path, baseUrl).toString();

  let status: number | null = null;
  let title = "";
  let finalUrl = requestedUrl;
  let expectations: ExpectationResult[] = [];

  // Navigation + expectation evaluation. Errors here are swallowed so
  // sweep stays best-effort — partial data per URL is more useful than
  // a thrown sweep, and the assertions we DID evaluate end up in the
  // verdict either way.
  try {
    const response = await page
      .goto(requestedUrl, {
        waitUntil: "domcontentloaded",
        timeout: opts.gotoTimeoutMs
      })
      .catch(() => null);
    status = response?.status() ?? null;
    finalUrl = page.url();
    // Wait for `load` so the page renders and throws any hydration errors.
    // Sweep is intentionally shallow — load-health, not full interactivity —
    // so we don't run a deeper settle here.
    await page.waitForLoadState("load", { timeout: 5_000 }).catch(() => {});
    if (sweepUrl.expectations.length > 0) {
      expectations = await evaluateExpectations(page, sweepUrl.expectations);
    }
    title = await page.title().catch(() => "");
  } catch {
    // best-effort sweep — keep partial data
  }

  // Cleanup + post-run probes (screenshot + attrs need the page open).
  const screenshotRel = `${slug}.png`;
  await page
    .screenshot({ path: resolve(sweepDir, screenshotRel), fullPage: false })
    .catch(() => {});
  const attrs = await readUiAttributes(page).catch(() => []);
  await page.close().catch(() => {});

  const consoleErrors = buffers.consoleEntries.filter(
    (e) => e.type === "error"
  ).length;
  const http4xx = buffers.networkEntries.filter(
    (e) => e.status !== null && e.status >= 400 && e.status < 500
  ).length;
  const http5xx = buffers.networkEntries.filter(
    (e) => e.status !== null && e.status >= 500
  ).length;

  const verdict = computeVerdict({
    failedSteps: 0,
    pageErrors: buffers.pageErrors,
    consoleEntries: buffers.consoleEntries,
    networkEntries: buffers.networkEntries,
    expectations,
    failOn: opts.failOn
  });

  const detailRel = `${slug}.json`;
  writeFileSync(
    resolve(sweepDir, detailRel),
    JSON.stringify(
      {
        url: sweepUrl.path,
        packs: sweepUrl.packs,
        requestedUrl,
        finalUrl,
        status,
        title,
        durationMs: Date.now() - started,
        ok: verdict.ok,
        triggers: verdict.triggers,
        expectations,
        console: { entries: buffers.consoleEntries },
        network: { entries: buffers.networkEntries },
        pageErrors: buffers.pageErrors,
        attrs
      },
      null,
      2
    )
  );

  return {
    url: sweepUrl.path,
    finalUrl,
    status,
    title,
    durationMs: Date.now() - started,
    ok: verdict.ok,
    triggers: verdict.triggers,
    expectations,
    pageErrors: buffers.pageErrors.length,
    consoleErrors,
    http4xx,
    http5xx,
    screenshot: screenshotRel,
    detailJson: detailRel
  };
}

export async function runSweep(opts: SweepOptions): Promise<SweepReport> {
  const sweepId = `sweep-${newRunId()}`;
  const sweepDir = resolve(RUNS_DIR, sweepId);
  mkdirSync(sweepDir, { recursive: true });
  log.dim(`sweep dir: ${sweepDir}`);

  const startedAt = new Date();
  const started = Date.now();

  const browser: Browser = await chromium.launch({ headless: true });
  const entries: SweepEntry[] = [];
  const useStorageState =
    opts.loadStorageState !== false && existsSync(SESSION_STATE_PATH);
  if (useStorageState)
    log.dim("  · loaded session from ~/.web-tester/session.json");

  try {
    // Worker pool: keep one browser, hand each worker its own context. Each
    // worker pulls from the shared queue until empty. A fresh context per URL
    // would be cleaner state-wise but costs ~200ms; per-worker context
    // amortises that across the queue while still isolating sweep state from
    // any per-URL navigation residue (cookies, storage stay scoped to the
    // worker, not bleed across the whole sweep).
    const queue = [...opts.urls.map((u, i) => ({ sweepUrl: u, index: i }))];
    let nextLog = 0;

    const device = opts.device ?? DEFAULT_DEVICE;
    const worker = async (): Promise<void> => {
      const context = await browser.newContext({
        ...deviceContextOptions(device),
        // Each worker gets its own context but shares the on-disk session,
        // so a sweep can include auth-gated routes without each worker
        // logging in. No-op when the file doesn't exist.
        ...(useStorageState ? { storageState: SESSION_STATE_PATH } : {})
      });
      await configureContext(context, opts.baseUrl);
      try {
        while (queue.length > 0) {
          const job = queue.shift();
          if (!job) break;
          const slug = safeSlug(job.sweepUrl.path, job.index + 1);
          const entry = await inspectOne(
            context,
            opts.baseUrl,
            job.sweepUrl,
            sweepDir,
            slug,
            {
              failOn: opts.failOn,
              gotoTimeoutMs: opts.gotoTimeoutMs
            }
          );
          entries.push(entry);
          const idx = ++nextLog;
          const tag = entry.ok ? "✓" : "✗";
          const colour = entry.ok ? log.dim : log.fail;
          const packTag = job.sweepUrl.packs.length
            ? ` [${job.sweepUrl.packs.join(",")}]`
            : "";
          colour(
            `  ${tag} [${idx}/${opts.urls.length}] ${entry.url}${packTag} → ${entry.status ?? "?"} (${entry.durationMs}ms)${
              entry.triggers.length ? ` — ${entry.triggers.join("; ")}` : ""
            }`
          );
        }
      } finally {
        await context.close().catch(() => {});
      }
    };

    const workers = Array.from(
      { length: Math.min(opts.concurrency, opts.urls.length) },
      () => worker()
    );
    await Promise.all(workers);
  } finally {
    await browser.close().catch(() => {});
  }

  // Sort entries back into the original URL order so the report is
  // deterministic; workers complete in arbitrary order.
  const order = new Map(opts.urls.map((u, i) => [u.path, i]));
  entries.sort(
    (a, b) => (order.get(a.url) ?? 0) - (order.get(b.url) ?? 0)
  );

  const passed = entries.filter((e) => e.ok).length;
  const failed = entries.length - passed;
  const distinctPacks = Array.from(
    new Set(opts.urls.flatMap((u) => u.packs))
  );
  const report: SweepReport = {
    sweepId,
    startedAt: startedAt.toISOString(),
    durationMs: Date.now() - started,
    baseUrl: opts.baseUrl,
    concurrency: opts.concurrency,
    total: entries.length,
    passed,
    failed,
    failOn: opts.failOn,
    packs: distinctPacks,
    entries
  };

  writeFileSync(resolve(sweepDir, "sweep.json"), JSON.stringify(report, null, 2));
  writeFileSync(resolve(sweepDir, "sweep.html"), renderSweepHtml(report));

  log.info("");
  log.header(failed === 0 ? "sweep: all ok" : `sweep: ${failed}/${entries.length} failed`);
  log.info(`  duration:   ${report.durationMs}ms`);
  log.info(`  concurrency: ${opts.concurrency}`);
  log.info(`  passed:     ${passed}`);
  log.info(`  failed:     ${failed}`);

  // Detect prod throttling: if a meaningful share of URLs came back as 403
  // we're almost certainly hitting WAF / VPN rate limits, not real bugs.
  // Most developers don't recognise this pattern on first encounter, so
  // print an explicit hint with the mitigation.
  const httpForbidden = entries.filter((e) => e.status === 403).length;
  const isLocal =
    opts.baseUrl.includes("localhost") || opts.baseUrl.includes("127.0.0.1");
  if (
    !isLocal &&
    httpForbidden >= 3 &&
    httpForbidden / Math.max(1, entries.length) >= 0.15
  ) {
    log.info("");
    log.warn(
      `  ⚠ ${httpForbidden}/${entries.length} URLs returned HTTP 403 from ${opts.baseUrl}.`
    );
    log.warn(
      "    This is almost certainly NOT a regression in your code — the remote"
    );
    log.warn(
      "    target is responding 403. Common causes: WAF / VPN rate-limiting,"
    );
    log.warn(
      "    prod-side partial outage, or a recent deploy gating those paths."
    );
    log.warn(
      "    Mitigations (in order):"
    );
    log.warn(
      "      · curl one of the failing URLs directly to confirm it really is 403"
    );
    log.warn(
      `      · drop --concurrency to 1 (current: ${opts.concurrency}) and retry`
    );
    log.warn(
      "      · wait 5-10 minutes and retry (rate-limit windows usually clear)"
    );
    log.warn(
      "      · sweep localhost instead (no env var → defaults to http://localhost:3000)"
    );
  }

  log.ok(`  HTML report: ${sweepDir}/sweep.html`);
  log.info(`  sweep.json:  ${sweepDir}/sweep.json`);

  return report;
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function renderSweepHtml(report: SweepReport): string {
  const rows = report.entries
    .map((e, i) => {
      const verdict = e.ok
        ? `<span class="ok">ok</span>`
        : `<span class="fail">fail</span>`;
      const triggers = e.triggers.length
        ? `<ul class="triggers">${e.triggers.map((t) => `<li>${esc(t)}</li>`).join("")}</ul>`
        : "";
      const statusClass =
        e.status === null
          ? "stat-fail"
          : e.status >= 500
            ? "stat-fail"
            : e.status >= 400
              ? "stat-warn"
              : "stat-ok";
      return `<tr class="${e.ok ? "row-ok" : "row-fail"}">
        <td class="num">${i + 1}</td>
        <td class="verdict">${verdict}</td>
        <td><a href="${esc(e.detailJson)}">${esc(e.url)}</a><div class="dim">${esc(e.title || "")}</div></td>
        <td class="status ${statusClass}">${e.status ?? "—"}</td>
        <td class="num">${e.durationMs}ms</td>
        <td class="num">${e.pageErrors}</td>
        <td class="num">${e.consoleErrors}</td>
        <td class="num">${e.http4xx}/${e.http5xx}</td>
        <td><a href="${esc(e.screenshot)}" target="_blank"><img src="${esc(e.screenshot)}" loading="lazy"></a></td>
        <td>${triggers}</td>
      </tr>`;
    })
    .join("");

  const packsBadge = report.packs.length
    ? `<span class="badge">packs: ${report.packs.join(", ")}</span>`
    : "";
  const failOnBadge = report.failOn.length
    ? `<span class="badge">fail-on: ${report.failOn.join(", ")}</span>`
    : "";

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>web-tester sweep · ${report.total} URLs</title>
<style>
  :root { --bg:#fafaf9; --surface:#fff; --border:#e7e5e4; --muted:#57534e; --subtle:#a8a29e; --ok:#15803d; --warn:#a16207; --err:#b91c1c; --text:#18181b; }
  * { box-sizing: border-box; }
  body { font: 13px/1.5 -apple-system, BlinkMacSystemFont, "Inter", system-ui, sans-serif; margin: 0; padding: 24px; background: var(--bg); color: var(--text); }
  h1 { font-size: 18px; margin: 0 0 4px; font-weight: 600; letter-spacing: -0.01em; }
  .meta { color: var(--muted); font-size: 12px; margin-bottom: 12px; }
  .totals { display: flex; gap: 16px; margin-bottom: 16px; font-size: 13px; }
  .totals .stat { color: var(--muted); }
  .totals .stat strong { color: var(--text); font-weight: 600; font-variant-numeric: tabular-nums; }
  .totals .ok strong { color: var(--ok); }
  .totals .fail strong { color: var(--err); }
  .badges { margin: 0 0 12px; display: flex; gap: 6px; flex-wrap: wrap; }
  .badge { font-size: 11px; padding: 2px 8px; border: 1px solid var(--border); border-radius: 99px; color: var(--muted); background: var(--surface); }
  table { width: 100%; border-collapse: collapse; background: var(--surface); border: 1px solid var(--border); border-radius: 6px; overflow: hidden; }
  th, td { padding: 8px 10px; text-align: left; border-bottom: 1px solid var(--border); vertical-align: top; }
  th { font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--muted); font-weight: 600; background: var(--bg); }
  td.num { font-variant-numeric: tabular-nums; color: var(--muted); }
  tr.row-fail { background: #fef2f2; }
  td .ok { color: var(--ok); font-weight: 600; font-size: 11px; text-transform: uppercase; }
  td .fail { color: var(--err); font-weight: 600; font-size: 11px; text-transform: uppercase; }
  td.stat-ok { color: var(--ok); }
  td.stat-warn { color: var(--warn); font-weight: 600; }
  td.stat-fail { color: var(--err); font-weight: 600; }
  td .dim { color: var(--subtle); font-size: 11px; }
  td img { width: 120px; height: auto; border: 1px solid var(--border); border-radius: 3px; cursor: zoom-in; display: block; }
  ul.triggers { margin: 0; padding-left: 16px; color: var(--err); font-size: 11px; }
  a { color: var(--text); text-decoration: underline; text-decoration-color: var(--subtle); }
</style>
</head><body>
<h1>sweep · ${report.total} URLs</h1>
<div class="meta">${esc(report.sweepId)} · ${esc(report.baseUrl)} · ${esc(report.startedAt)} · ${report.durationMs}ms · concurrency ${report.concurrency}</div>
<div class="badges">${packsBadge}${failOnBadge}</div>
<div class="totals">
  <div class="stat ok"><strong>${report.passed}</strong> passed</div>
  <div class="stat fail"><strong>${report.failed}</strong> failed</div>
  <div class="stat"><strong>${report.total}</strong> total</div>
</div>
<table>
  <thead><tr>
    <th>#</th><th>verdict</th><th>URL · title</th><th>status</th><th>ms</th>
    <th>page err</th><th>con err</th><th>4xx/5xx</th><th>preview</th><th>triggers</th>
  </tr></thead>
  <tbody>${rows}</tbody>
</table>
</body></html>`;
}
