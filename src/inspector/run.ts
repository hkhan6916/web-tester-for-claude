import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Page } from "playwright";
import { readUiAttributes, type UiAttribute } from "../browser/attrs";
import { DEFAULT_DEVICE, type Device } from "../browser/devices";
import { openSession } from "../browser/session";
import { log } from "../util/log";
import { ensureRunPaths, newRunId, type RunPaths } from "../util/paths";
import {
  attachCapture,
  type CaptureBuffers,
  type ConsoleEntry,
  flushBodies,
  type NetworkEntry,
  type PageErrorEntry,
  sliceSince,
  snapshotCursor
} from "./capture";
import { attachDeepCapture, type DeepError } from "./deep";
import { writeReport } from "./report";
import { executeStep, type Step } from "./steps";
import { summariseRun } from "./summarise";
import {
  computeVerdict,
  evaluateExpectations,
  type Expectation,
  type ExpectationResult,
  type FailOnKind
} from "./verdict";

export type InspectOptions = {
  baseUrl: string;
  url: string;
  /** Form factor to emulate. Defaults to desktop. */
  device?: Device;
  steps: Step[];
  headed: boolean;
  captureHtml: boolean;
  captureStorage: boolean;
  captureAllNetwork: boolean;
  captureAllConsole: boolean;
  /** Record a webm of the session. Off in `--quick` mode. */
  recordVideo: boolean;
  /** Take a full-page screenshot in addition to viewport. Off in `--quick`. */
  fullPageScreenshots: boolean;
  /** Ask Sonnet for a short human summary. Opt-in (off by default). */
  summary: boolean;
  /** Final assertions evaluated after the last step. */
  expectations: Expectation[];
  /**
   * If > 0, re-evaluate every assertion in `expectations` after a wait of
   * `persistMs` and require BOTH the initial and the after-wait check to
   * pass. Catches transient states — e.g. an alert that flashes for ~1s
   * after load and then disappears would pass a single assertion but fails
   * the persistence check. Default 0 (single check, no persistence).
   */
  persistMs: number;
  /** Signals that flip the run verdict to fail when triggered. */
  failOn: FailOnKind[];
  /**
   * Deep capture (`--deep`): record request/response bodies, and attach a CDP
   * debugger that snapshots the local scope of any uncaught exception plus
   * unhandled promise rejections. Off by default — it adds protocol overhead.
   */
  deep: boolean;
  gotoTimeoutMs: number;
  /**
   * Load `~/.web-tester/session.json` into the context when it exists.
   * Defaults to true; pass false (CLI `--no-session`) to force an anonymous
   * context — e.g. to test the logged-out experience.
   */
  loadStorageState?: boolean;
  /**
   * Save the browser session (cookies + localStorage) to
   * `~/.web-tester/session.json` after a clean run (CLI `--save-session`).
   * Use to bootstrap auth: run the login flow once with this on.
   */
  saveSession?: boolean;
};

export type StepReport = {
  index: number;
  step: Step;
  label: string;
  ok: boolean;
  error?: string;
  durationMs: number;
  url: string;
  screenshot?: string;
  evalResult?: unknown;
  console: ConsoleEntry[];
  network: NetworkEntry[];
  pageErrors: PageErrorEntry[];
};

export type InspectResult = {
  runId: string;
  runDir: string;
  startedAt: string;
  durationMs: number;
  baseUrl: string;
  requestedUrl: string;
  finalUrl: string;
  title: string;
  /** Emulated form factor, e.g. "desktop", "mobile", "iPhone 13". */
  device: string;
  viewport: { width: number; height: number };
  /** Relative path to the screen recording, if recorded. */
  video?: string;
  /** Sonnet-generated TL;DR rendered at the top of the HTML report. */
  summary?: string;
  ok: boolean;
  failedSteps: number;
  /** Human-readable reasons the verdict failed, empty when ok. */
  verdictTriggers: string[];
  /** Signals that were configured to flip the verdict, for reporting. */
  failOn: FailOnKind[];
  /** Expectations evaluated against the final page state. */
  expectations: ExpectationResult[];
  initial: {
    screenshot: string;
    screenshotFull?: string;
    attrs: UiAttribute[];
    html?: string;
    storage?: StorageSnapshot;
  };
  final: {
    screenshot: string;
    screenshotFull?: string;
    attrs: UiAttribute[];
    html?: string;
    storage?: StorageSnapshot;
  };
  console: { totals: Record<string, number>; entries: ConsoleEntry[] };
  network: { count: number; failedCount: number; entries: NetworkEntry[] };
  pageErrors: PageErrorEntry[];
  /** Uncaught exceptions with local-scope dumps. Present only under `--deep`. */
  deepErrors?: DeepError[];
  /** Unhandled promise rejections (missed by `pageerror`). `--deep` only. */
  unhandledRejections?: string[];
  steps: StepReport[];
};

export type StorageSnapshot = {
  localStorage: Record<string, string>;
  sessionStorage: Record<string, string>;
  cookies: { name: string; value: string; domain: string; path: string }[];
};

async function readStorage(page: Page): Promise<StorageSnapshot> {
  const pageData = await page
    .evaluate(() => {
      const dump = (s: Storage): Record<string, string> => {
        const out: Record<string, string> = {};
        for (let i = 0; i < s.length; i++) {
          const k = s.key(i);
          if (k !== null) out[k] = s.getItem(k) ?? "";
        }
        return out;
      };
      return {
        localStorage: dump(window.localStorage),
        sessionStorage: dump(window.sessionStorage)
      };
    })
    .catch(() => ({ localStorage: {}, sessionStorage: {} }));
  const cookies = await page.context().cookies().catch(() => []);
  return {
    ...pageData,
    cookies: cookies.map((c) => ({
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path
    }))
  };
}

async function captureSnapshot(
  page: Page,
  paths: RunPaths,
  prefix: "initial" | "final",
  captureHtml: boolean,
  captureStorage: boolean,
  fullPageScreenshots: boolean
): Promise<{
  screenshot: string;
  screenshotFull?: string;
  attrs: UiAttribute[];
  html?: string;
  storage?: StorageSnapshot;
}> {
  const screenshot = `${prefix}.png`;
  await page
    .screenshot({ path: resolve(paths.runDir, screenshot), fullPage: false })
    .catch(() => {});
  let screenshotFull: string | undefined;
  if (fullPageScreenshots) {
    screenshotFull = `${prefix}-full.png`;
    await page
      .screenshot({
        path: resolve(paths.runDir, screenshotFull),
        fullPage: true
      })
      .catch(() => {});
  }
  const attrs = await readUiAttributes(page);
  let html: string | undefined;
  if (captureHtml) {
    const content = await page.content().catch(() => "");
    const htmlFile = `${prefix}.html`;
    writeFileSync(resolve(paths.runDir, htmlFile), content);
    html = htmlFile;
  }
  let storage: StorageSnapshot | undefined;
  if (captureStorage) {
    storage = await readStorage(page);
  }
  const result: {
    screenshot: string;
    screenshotFull?: string;
    attrs: UiAttribute[];
    html?: string;
    storage?: StorageSnapshot;
  } = { screenshot, attrs };
  if (screenshotFull !== undefined) result.screenshotFull = screenshotFull;
  if (html !== undefined) result.html = html;
  if (storage !== undefined) result.storage = storage;
  return result;
}

async function captureStepScreenshot(
  page: Page,
  paths: RunPaths,
  index: number,
  name: string | undefined,
  fullPage: boolean
): Promise<string> {
  const safe = (name ?? "step")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  const fileName = `${String(index).padStart(2, "0")}-${safe}.png`;
  const abs = resolve(paths.stepsDir, fileName);
  await page.screenshot({ path: abs, fullPage }).catch(() => {});
  return `steps/${fileName}`;
}

function tally(entries: ConsoleEntry[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const e of entries) out[e.type] = (out[e.type] ?? 0) + 1;
  return out;
}

export async function runInspect(opts: InspectOptions): Promise<InspectResult> {
  const startedAt = new Date();
  const paths = ensureRunPaths(newRunId());
  const device = opts.device ?? DEFAULT_DEVICE;
  log.dim(`run dir: ${paths.runDir}`);
  if (device.name !== DEFAULT_DEVICE.name)
    log.dim(`device:  ${device.name} (${device.viewport.width}x${device.viewport.height})`);

  const session = await openSession({
    baseUrl: opts.baseUrl,
    headed: opts.headed,
    device,
    videoDir: opts.recordVideo ? paths.videoDir : undefined,
    loadStorageState: opts.loadStorageState
  });
  const buffers: CaptureBuffers = attachCapture(session.context, session.page, {
    allNetwork: opts.captureAllNetwork,
    allConsole: opts.captureAllConsole,
    captureBodies: opts.deep
  });

  // Deep capture attaches a CDP debugger. Best-effort: if the protocol session
  // can't open, log and carry on with the normal capture pipeline.
  let deepCapture:
    | Awaited<ReturnType<typeof attachDeepCapture>>
    | undefined;
  if (opts.deep) {
    deepCapture = await attachDeepCapture(session.page).catch((err) => {
      log.dim(
        `  deep capture unavailable: ${err instanceof Error ? err.message : String(err)}`
      );
      return undefined;
    });
  }

  const requestedUrl = opts.url.startsWith("http")
    ? opts.url
    : new URL(opts.url, session.baseUrl).toString();

  let initial: InspectResult["initial"];
  let final: InspectResult["final"];
  let title = "";
  const steps: StepReport[] = [];
  let failedSteps = 0;
  let expectations: ExpectationResult[] = [];

  try {
    log.step(`→ ${requestedUrl}`);
    const response = await session.page.goto(requestedUrl, {
      waitUntil: "domcontentloaded",
      timeout: opts.gotoTimeoutMs
    });
    log.dim(`  status: ${response?.status() ?? "?"}`);

    initial = await captureSnapshot(
      session.page,
      paths,
      "initial",
      opts.captureHtml,
      opts.captureStorage,
      opts.fullPageScreenshots
    );

    let stepIndex = 0;
    for (const step of opts.steps) {
      stepIndex++;
      const before = snapshotCursor(buffers);
      const started = Date.now();
      let label = "";
      let ok = true;
      let error: string | undefined;
      let evalResult: unknown;
      try {
        const result = await executeStep(step, session.page);
        label = result.label;
        evalResult = result.evalResult;
      } catch (err) {
        ok = false;
        failedSteps++;
        error = err instanceof Error ? err.message : String(err);
        label = `${step.kind} (error)`;
      }
      const durationMs = Date.now() - started;

      let screenshot: string | undefined;
      // Trivial steps don't change visible state, so the screenshot would just
      // duplicate the previous step's frame. The HTML report can fall back to
      // the prior screenshot for these cases.
      const trivial =
        step.kind === "eval" ||
        (step.kind === "wait" && step.target.kind === "ms");
      if (step.kind === "screenshot") {
        screenshot = await captureStepScreenshot(
          session.page,
          paths,
          stepIndex,
          step.name,
          step.fullPage ?? false
        );
      } else if (!ok) {
        screenshot = await captureStepScreenshot(
          session.page,
          paths,
          stepIndex,
          `error-${step.kind}`,
          false
        );
      } else if (!trivial) {
        screenshot = await captureStepScreenshot(
          session.page,
          paths,
          stepIndex,
          step.kind,
          false
        );
      }

      const slice = sliceSince(buffers, before);
      const report: StepReport = {
        index: stepIndex,
        step,
        label,
        ok,
        durationMs,
        url: session.page.url(),
        console: slice.console,
        network: slice.network,
        pageErrors: slice.pageErrors
      };
      if (error !== undefined) report.error = error;
      if (evalResult !== undefined) report.evalResult = evalResult;
      if (screenshot !== undefined) report.screenshot = screenshot;
      steps.push(report);
      const tag = ok ? "✓" : "✗";
      log.dim(`  ${tag} step ${stepIndex}: ${label} (${durationMs}ms)`);
      if (!ok && error) log.fail(`    error: ${error}`);
    }

    if (opts.expectations.length > 0) {
      expectations = await evaluateExpectations(session.page, opts.expectations);
      for (const r of expectations) {
        const tag = r.ok ? "✓" : "✗";
        const desc = describeExpectation(r.expectation);
        log.dim(`  ${tag} expect ${desc}${r.detail ? ` — ${r.detail}` : ""}`);
      }

      // Persistence check: wait, then re-evaluate. Each expectation passes
      // only if BOTH the initial and after-wait check pass. Catches alerts /
      // toasts / transient banners that show for a beat then disappear.
      if (opts.persistMs > 0) {
        log.dim(`  · persisting check ${opts.persistMs}ms…`);
        await session.page.waitForTimeout(opts.persistMs);
        const after = await evaluateExpectations(
          session.page,
          opts.expectations
        );
        expectations = expectations.map((initial, i) => {
          const later = after[i];
          if (!initial.ok) return initial;
          if (!later || later.ok) return later ?? initial;
          return {
            expectation: initial.expectation,
            ok: false,
            detail: `held at first check but failed after ${opts.persistMs}ms: ${later.detail ?? "no detail"}`
          };
        });
        for (let i = 0; i < expectations.length; i++) {
          const e = expectations[i];
          if (!e) continue;
          const wasOk = after[i]?.ok ?? false;
          const tag = e.ok ? "✓" : wasOk ? "✓" : "✗";
          const desc = describeExpectation(e.expectation);
          if (!e.ok)
            log.fail(`  ${tag} persist ${desc} — ${e.detail ?? "failed"}`);
        }
      }
    }

    final = await captureSnapshot(
      session.page,
      paths,
      "final",
      opts.captureHtml,
      opts.captureStorage,
      opts.fullPageScreenshots
    );
    title = await session.page.title().catch(() => "");
  } finally {
    // Save the browser session (cookies + localStorage) when:
    //   - `--save-session` was passed (bootstrap a login), OR
    //   - one was already loaded (refresh rotated auth tokens into the next run).
    // Only on a clean run: a failed run might mean the server rejected the
    // cookies, and saving the now-anonymous state would log the user out on
    // every subsequent run, so we keep the old file instead.
    const wantSave = opts.saveSession || session.storageStateLoaded;
    if (wantSave && failedSteps === 0) {
      await session
        .saveStorageState()
        .then(() => log.dim("  · session saved to ~/.web-tester/session.json"))
        .catch((err) =>
          log.fail(
            `  · could not save session: ${err instanceof Error ? err.message : String(err)}`
          )
        );
    } else if (wantSave) {
      log.dim(
        "  · session not saved (a step failed; preserving any previous session.json)"
      );
    }
    // Drain any in-flight body reads before the context closes — a closed
    // context can't return a response body.
    await flushBodies(buffers).catch(() => {});
    if (deepCapture) await deepCapture.detach().catch(() => {});
    await session.close();
  }

  // The video file is finalised on context close; resolve its path now and
  // store it relative to runDir for portable report references.
  let video: string | undefined;
  if (opts.recordVideo) {
    const videoAbs = await session.videoPath();
    if (videoAbs) {
      const rel = videoAbs.startsWith(paths.runDir)
        ? videoAbs.slice(paths.runDir.length + 1)
        : videoAbs;
      video = rel;
    }
  }

  const verdict = computeVerdict({
    failedSteps,
    pageErrors: buffers.pageErrors,
    consoleEntries: buffers.consoleEntries,
    networkEntries: buffers.networkEntries,
    expectations,
    failOn: opts.failOn
  });

  const result: InspectResult = {
    runId: paths.runId,
    runDir: paths.runDir,
    startedAt: startedAt.toISOString(),
    durationMs: Date.now() - startedAt.getTime(),
    baseUrl: session.baseUrl,
    requestedUrl,
    finalUrl: steps[steps.length - 1]?.url ?? requestedUrl,
    title,
    device: device.name,
    viewport: { ...device.viewport },
    ...(video !== undefined ? { video } : {}),
    ok: verdict.ok,
    failedSteps,
    verdictTriggers: verdict.triggers,
    failOn: opts.failOn,
    expectations,
    initial,
    final,
    console: {
      totals: tally(buffers.consoleEntries),
      entries: buffers.consoleEntries
    },
    network: {
      count: buffers.networkEntries.length,
      failedCount: buffers.networkEntries.filter(
        (e) => (e.status !== null && e.status >= 400) || e.failureText !== null
      ).length,
      entries: buffers.networkEntries
    },
    pageErrors: buffers.pageErrors,
    ...(deepCapture && deepCapture.buffers.errors.length
      ? { deepErrors: deepCapture.buffers.errors }
      : {}),
    ...(deepCapture && deepCapture.buffers.rejections.length
      ? { unhandledRejections: deepCapture.buffers.rejections }
      : {}),
    steps
  };

  writeFileSync(paths.consolePath, JSON.stringify(buffers.consoleEntries, null, 2));
  writeFileSync(paths.networkPath, JSON.stringify(buffers.networkEntries, null, 2));

  // Ask Sonnet for a short TL;DR before rendering — runs in a child process,
  // returns null on any failure so the report still writes either way.
  const summary = await summariseRun(result, { enabled: opts.summary });
  if (summary) result.summary = summary;

  // `writeReport` writes both result.json and report.html.
  writeReport(result, paths);

  return result;
}

function describeExpectation(e: Expectation): string {
  if (e.kind === "text") return `text="${e.text}"`;
  if (e.kind === "no-text") return `no-text="${e.text}"`;
  if (e.kind === "selector") return `selector="${e.selector}"`;
  if (e.kind === "no-selector") return `no-selector="${e.selector}"`;
  return `attr ${e.name}="${e.value}"`;
}
