import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { log } from "../util/log";
import type { InspectResult } from "./run";

/**
 * Locate the `claude` binary. Order:
 *   1. `which claude` (anything on PATH)
 *   2. VSCode extension bundled binary (anthropic.claude-code-*)
 *   3. Anthropic desktop app (macOS)
 * Returns the absolute path, or null if not found.
 */
function findClaudeBinary(): string | null {
  const which = spawnSync("which", ["claude"], { encoding: "utf-8" });
  if (which.status === 0 && which.stdout.trim()) return which.stdout.trim();

  const extRoot = resolve(homedir(), ".vscode/extensions");
  if (existsSync(extRoot)) {
    const matches = readdirSync(extRoot)
      .filter((d) => d.startsWith("anthropic.claude-code-"))
      .sort()
      .reverse();
    for (const dir of matches) {
      const candidate = resolve(extRoot, dir, "resources/native-binary/claude");
      if (existsSync(candidate)) return candidate;
    }
  }

  const desktopCandidate = "/Applications/Claude.app/Contents/Resources/bin/claude";
  if (existsSync(desktopCandidate)) return desktopCandidate;

  return null;
}

function summariseConsole(result: InspectResult): string {
  const errs = result.console.entries
    .filter((e) => e.type === "error")
    .slice(0, 6)
    .map((e) => `  - ${e.text.split("\n")[0]?.slice(0, 200)}`)
    .join("\n");
  return errs || "  (no console errors)";
}

function summariseNetworkFailures(result: InspectResult): string {
  const failed = result.network.entries
    .filter(
      (e) => e.failureText !== null || (e.status !== null && e.status >= 400)
    )
    .slice(0, 6);
  if (!failed.length) return "  (no failed/4xx requests)";
  return failed
    .map((e) =>
      e.failureText
        ? `  - ${e.method} ${e.url} :: ${e.failureText}`
        : `  - ${e.status} ${e.method} ${e.url}`
    )
    .join("\n");
}

function summarisePageErrors(result: InspectResult): string {
  if (!result.pageErrors.length) return "  (no uncaught JS errors)";
  const grouped = new Map<string, number>();
  for (const e of result.pageErrors)
    grouped.set(e.message.split("\n")[0] ?? e.message, (grouped.get(e.message.split("\n")[0] ?? e.message) ?? 0) + 1);
  return Array.from(grouped.entries())
    .slice(0, 6)
    .map(([msg, count]) => `  - ${msg}${count > 1 ? ` (×${count})` : ""}`)
    .join("\n");
}

function summariseSteps(result: InspectResult): string {
  if (!result.steps.length) return "  (no steps — single-page snapshot)";
  return result.steps
    .map((s) => {
      const tag = s.ok ? "✓" : "✗";
      const evalStr =
        s.evalResult !== undefined
          ? ` -> ${JSON.stringify(s.evalResult).slice(0, 120)}`
          : "";
      return `  ${tag} ${s.index}. ${s.label} (${s.durationMs}ms)${evalStr}`;
    })
    .join("\n");
}

function summariseAttrs(
  attrs: { name: string; value: string; label: string }[]
): string {
  if (!attrs.length) return "(none captured)";
  return attrs
    .slice(0, 20)
    .map((a) => `${a.name}=${a.label || a.value}`)
    .join(", ");
}

function buildPrompt(result: InspectResult): string {
  return `You are summarising the result of a web-tester run against the developer's web app for a developer who is about to open the HTML report. Be concise and useful.

# Run context
- URL: ${result.requestedUrl}
- Final URL: ${result.finalUrl}
- Page title: ${result.title || "(unknown)"}
- Duration: ${result.durationMs}ms
- Verdict: ${result.ok ? "all steps executed" : `${result.failedSteps} step(s) failed`}

# Steps (✓=ok, ✗=error during step)
${summariseSteps(result)}

# Page errors (uncaught JS)
${summarisePageErrors(result)}

# Console errors
${summariseConsole(result)}

# Failed / 4xx network requests
${summariseNetworkFailures(result)}

# Final on-page attrs
${summariseAttrs(result.final.attrs)}

---

Write a short summary aimed at a developer scanning the report. Format:

**TL;DR:** one sentence — what the run did and whether it looks healthy.

**Notable findings:** 2–4 bullets, each one short line. Focus on signal: real failures, surprising state, unexpected URLs, missing attrs, suspicious network calls. Skip hydration warnings unless they are the only issue. Skip generic noise.

**Suggested next look:** 1 bullet if there is anything specific in the report worth zooming into; omit otherwise.

Output only the summary in markdown — no preamble, no closing remarks, no headers other than the three bolded labels above.`;
}

const SUMMARY_TIMEOUT_MS = 60_000;

/**
 * Generate a short Sonnet-written summary of the run. Returns null if the
 * claude CLI isn't available, errors out, or times out — callers should treat
 * a null as "no summary, render the report without one".
 */
export async function summariseRun(
  result: InspectResult,
  opts: { enabled: boolean }
): Promise<string | null> {
  if (!opts.enabled) return null;
  const bin = findClaudeBinary();
  if (!bin) {
    log.dim("  summary: claude CLI not found, skipping");
    return null;
  }

  log.dim("  summary: asking sonnet to summarise…");
  const started = Date.now();
  const prompt = buildPrompt(result);
  const proc = spawnSync(
    bin,
    ["-p", "--model", "claude-sonnet-4-6", "--output-format", "text"],
    {
      input: prompt,
      encoding: "utf-8",
      timeout: SUMMARY_TIMEOUT_MS,
      maxBuffer: 4 * 1024 * 1024
    }
  );
  if (proc.error) {
    log.dim(`  summary: ${proc.error.message}, skipping`);
    return null;
  }
  if (proc.status !== 0) {
    log.dim(`  summary: claude exited ${proc.status}, skipping`);
    return null;
  }
  const text = proc.stdout.trim();
  if (!text) return null;
  log.dim(`  summary: done in ${Date.now() - started}ms`);
  return text;
}
