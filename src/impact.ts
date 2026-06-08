import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { log } from "./util/log";
import { userImpactRulesPath } from "./util/paths";

/**
 * impact-rules.json schema. Each rule has a name, a list of path globs,
 * and one of {sweep, journey} describing what to run if any glob matches.
 */
export type SweepDirective = {
  /** Bundled preset name (urls-<name>.txt). */
  preset?: string;
  /** Inline URL list — replaces preset if both set. */
  urls?: string[];
  /** Built-in packs applied to every URL in this sweep. */
  packs?: string[];
};

export type ImpactRule = {
  name: string;
  when_changed_any: string[];
  /** Mutually exclusive — exactly one of sweep / journey. */
  sweep?: SweepDirective;
  journey?: string;
};

export type ImpactRulesFile = {
  rules: ImpactRule[];
  /** Anything else (e.g. `$comment`) is ignored. */
  [k: string]: unknown;
};

/** Default rules location for the current cwd. Lazy so the cwd is honoured per-call. */
export function defaultImpactRulesPath(): string {
  return userImpactRulesPath();
}

export function loadImpactRules(path: string = defaultImpactRulesPath()): ImpactRule[] {
  if (!existsSync(path))
    throw new Error(
      `impact-rules.json not found at ${path}. Create one at .web-tester/impact-rules.json with at least one rule.`
    );
  const parsed = JSON.parse(readFileSync(path, "utf-8")) as ImpactRulesFile;
  if (!Array.isArray(parsed.rules))
    throw new Error(`${path} must have a top-level "rules" array.`);
  for (const r of parsed.rules) {
    if (!r.name || !Array.isArray(r.when_changed_any))
      throw new Error(
        `rule missing required fields: ${JSON.stringify(r).slice(0, 120)}`
      );
    const hasSweep = !!r.sweep;
    const hasJourney = !!r.journey;
    if (!hasSweep && !hasJourney)
      throw new Error(
        `rule "${r.name}" must specify either "sweep" or "journey".`
      );
    if (hasSweep && hasJourney)
      throw new Error(
        `rule "${r.name}" specifies both "sweep" and "journey" — pick one.`
      );
  }
  return parsed.rules;
}

/** Convert a path glob (`**`, `*`) into a regex anchored at both ends. */
function globToRegex(glob: string): RegExp {
  // Park double-star with a unique multi-char marker so the single-* rewrite
  // below does not claw at it; restore as .* afterwards.
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "__DOUBLESTAR__")
    .replace(/\*/g, "[^/]*")
    .replaceAll("__DOUBLESTAR__", ".*");
  return new RegExp(`^${escaped}$`);
}

/**
 * Returns the list of files changed between `base` and the current HEAD
 * (including unstaged + uncommitted changes — that's what a developer is
 * about to push). Empty list = no rules match = no impact run.
 */
export function getChangedFiles(base: string, cwd: string): string[] {
  // Combine three sources: committed diff vs base, staged-but-uncommitted,
  // and unstaged tracked changes. Sorted-unique result. Untracked new files
  // (`?? `) are intentionally not included — they can't have been changed.
  const safeExec = (cmd: string): string => {
    try {
      // Swallow git's stderr too (e.g. "Not a git repository") — a missing
      // ref or non-repo cwd just means "no changed files", not an error worth
      // printing.
      return execSync(cmd, { cwd, encoding: "utf-8", stdio: ["pipe", "pipe", "ignore"] });
    } catch {
      return "";
    }
  };
  const committed = safeExec(`git diff ${base}...HEAD --name-only`)
    .split("\n")
    .filter(Boolean);
  const staged = safeExec(`git diff --cached --name-only`).split("\n").filter(Boolean);
  const unstaged = safeExec(`git diff --name-only`).split("\n").filter(Boolean);
  return Array.from(new Set([...committed, ...staged, ...unstaged])).sort();
}

export type MatchedRule = {
  rule: ImpactRule;
  /** Subset of changed files that triggered this rule (for the plan output). */
  triggers: string[];
};

export function matchRules(
  rules: ImpactRule[],
  changedFiles: string[]
): MatchedRule[] {
  const matched: MatchedRule[] = [];
  for (const rule of rules) {
    const triggers: string[] = [];
    for (const glob of rule.when_changed_any) {
      const re = globToRegex(glob);
      for (const file of changedFiles)
        if (re.test(file) && !triggers.includes(file)) triggers.push(file);
    }
    if (triggers.length > 0) matched.push({ rule, triggers });
  }
  return matched;
}

/**
 * Pretty-print the impact plan so the developer can see what's about to
 * happen before any browser launches. Always called before execution.
 */
export function printPlan(
  matched: MatchedRule[],
  changedFiles: string[],
  base: string
): void {
  log.header(
    `impact plan — ${changedFiles.length} changed file(s) vs ${base}`
  );
  if (matched.length === 0) {
    log.dim(
      "  no rules matched the changed files. Nothing to run."
    );
    log.dim(
      "  (You can still run `web-tester inspect <url>` manually.)"
    );
    return;
  }
  for (const m of matched) {
    log.info(`  · ${m.rule.name}`);
    if (m.rule.sweep) {
      const tgt = m.rule.sweep.preset
        ? `preset ${m.rule.sweep.preset}`
        : `${m.rule.sweep.urls?.length ?? 0} URL(s)`;
      const packs = m.rule.sweep.packs
        ? ` + packs [${m.rule.sweep.packs.join(", ")}]`
        : "";
      log.dim(`      → sweep (${tgt}${packs})`);
    }
    if (m.rule.journey) log.dim(`      → journey ${m.rule.journey}`);
    log.dim(
      `      triggered by: ${m.triggers.slice(0, 3).join(", ")}${m.triggers.length > 3 ? `, +${m.triggers.length - 3} more` : ""}`
    );
  }
  log.info("");
}
