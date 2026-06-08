import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

/** Root of the installed package (used to resolve bundled templates). */
export const PACKAGE_ROOT = resolve(__dirname, "../..");

/** Bundled scaffolding consumed by `web-tester init`. */
export const TEMPLATES_DIR = resolve(PACKAGE_ROOT, "src/templates");

/**
 * Where run artifacts are written. Defaults to `.web-tester/runs/` in the
 * project the CLI was invoked from, so output is namespaced under one dir
 * (which `init` adds to `.gitignore`) rather than dropping a stray top-level
 * `runs/`. Override with `WEB_TESTER_RUNS_DIR`.
 */
export const RUNS_DIR = process.env.WEB_TESTER_RUNS_DIR
  ? resolve(process.env.WEB_TESTER_RUNS_DIR)
  : resolve(process.cwd(), ".web-tester", "runs");

/**
 * Project config lives in `.web-tester/` at the project root, resolved
 * against `process.cwd()`. Everything in it is optional:
 *
 *   .web-tester/
 *     impact-rules.json        rules for `web-tester impact`
 *     urls-<name>.txt          URL presets for `web-tester sweep --preset <name>`
 *     journeys/<name>.json     named flows for `web-tester journey <name>`
 *     instructions/*.md        knowledge base for `web-tester kb [topic]`
 */
export const USER_CONFIG_DIRNAME = ".web-tester";

export function userConfigDir(cwd: string = process.cwd()): string {
  return resolve(cwd, USER_CONFIG_DIRNAME);
}

export function userImpactRulesPath(cwd: string = process.cwd()): string {
  return resolve(userConfigDir(cwd), "impact-rules.json");
}

export function userJourneysDir(cwd: string = process.cwd()): string {
  return resolve(userConfigDir(cwd), "journeys");
}

export function userPresetsDir(cwd: string = process.cwd()): string {
  // Presets are flat `urls-<name>.txt` files at the top of `.web-tester/`.
  return userConfigDir(cwd);
}

/**
 * KB markdown locations, in priority order: `.web-tester/instructions/`
 * first, then `.web-tester/` itself. First existing dir wins.
 */
export function userKnowledgeDirs(cwd: string = process.cwd()): string[] {
  return [resolve(userConfigDir(cwd), "instructions"), userConfigDir(cwd)];
}

/** `.web-tester/config.json` — persistent project defaults written by `init`. */
export function projectConfigPath(cwd: string = process.cwd()): string {
  return resolve(userConfigDir(cwd), "config.json");
}

export type ProjectConfig = {
  /** Default base URL, used when `WEB_TESTER_BASE_URL` isn't set. */
  baseUrl?: string;
  /** Default device name (`desktop`, `mobile`, `tablet`, or a custom one). */
  device?: string;
  /** Project-defined device presets, keyed by name. */
  devices?: Record<string, import("../browser/devices").Device>;
};

/** Read `.web-tester/config.json`. Returns {} when missing or unreadable. */
export function readProjectConfig(cwd: string = process.cwd()): ProjectConfig {
  try {
    const path = projectConfigPath(cwd);
    if (!existsSync(path)) return {};
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as ProjectConfig;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/** The project's `.claude/` integration directory and the files `init` touches. */
export function claudeDir(cwd: string = process.cwd()): string {
  return resolve(cwd, ".claude");
}

export function claudeSettingsLocalPath(cwd: string = process.cwd()): string {
  return resolve(claudeDir(cwd), "settings.local.json");
}

/** `.claude/skills/web-tester/SKILL.md` — the generated Claude Code skill. */
export function claudeSkillPath(cwd: string = process.cwd()): string {
  return resolve(claudeDir(cwd), "skills", "web-tester", "SKILL.md");
}

/**
 * Machine-local state in `~/.web-tester/`, kept outside the repo so saved
 * auth state is never committed. Holds the Playwright `storageState` dump
 * (cookies + localStorage) when a run persists a session.
 */
export const WEB_TESTER_HOME = resolve(homedir(), ".web-tester");
export const SESSION_STATE_PATH = resolve(WEB_TESTER_HOME, "session.json");

export function ensureWebTesterHome(): void {
  mkdirSync(WEB_TESTER_HOME, { recursive: true });
}

let lastRunId = "";
let lastRunIdSeq = 0;

export function newRunId(): string {
  const now = new Date();
  const pad = (n: number): string => String(n).padStart(2, "0");
  const base = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(
    now.getDate()
  )}T${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
  // Run IDs are second-granular. When several runs land in the same second
  // (e.g. one `inspect` across several devices), suffix the repeats so their
  // run dirs don't collide and overwrite each other.
  if (base === lastRunId) {
    lastRunIdSeq += 1;
    return `${base}-${lastRunIdSeq}`;
  }
  lastRunId = base;
  lastRunIdSeq = 1;
  return base;
}

export type RunPaths = {
  runId: string;
  runDir: string;
  stepsDir: string;
  videoDir: string;
  resultPath: string;
  reportHtmlPath: string;
  consolePath: string;
  networkPath: string;
};

export function ensureRunPaths(runId: string): RunPaths {
  const runDir = resolve(RUNS_DIR, runId);
  const stepsDir = resolve(runDir, "steps");
  const videoDir = resolve(runDir, "video");
  mkdirSync(stepsDir, { recursive: true });
  mkdirSync(videoDir, { recursive: true });
  return {
    runId,
    runDir,
    stepsDir,
    videoDir,
    resultPath: resolve(runDir, "result.json"),
    reportHtmlPath: resolve(runDir, "report.html"),
    consolePath: resolve(runDir, "console.json"),
    networkPath: resolve(runDir, "network.json")
  };
}
