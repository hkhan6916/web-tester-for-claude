import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync
} from "node:fs";
import { dirname, relative, resolve } from "node:path";
import {
  claudeSettingsLocalPath,
  claudeSkillPath,
  projectConfigPath,
  TEMPLATES_DIR,
  USER_CONFIG_DIRNAME
} from "./util/paths";

export type AutoUse = "on" | "ask" | "off";

export type InitOptions = {
  cwd: string;
  /** Overwrite files that already exist (default: skip them). */
  force: boolean;
  /**
   * Agent-instructions file to update (CLAUDE.md, AGENTS.md, …). When unset,
   * an existing CLAUDE.md or AGENTS.md is reused; otherwise CLAUDE.md is
   * created. Pass `null` to skip the agent file entirely.
   */
  agentFile: string | null | undefined;
  /** Base URL to persist to `.web-tester/config.json`. Skipped when undefined. */
  baseUrl?: string;
  /** Default device to persist to config (`desktop`, `tablet`, `mobile`, …). */
  device?: string;
  /** Auto-use preference written to `.claude/settings.local.json`. */
  autoUse?: AutoUse;
  /** Generate `.claude/skills/web-tester/SKILL.md` (default true). */
  skill?: boolean;
};

export type InitResult = {
  /** Files created or overwritten, relative to cwd. */
  written: string[];
  /** Files left untouched because they already existed (no --force). */
  skipped: string[];
  /** Path to the agent file that was written, relative to cwd, if any. */
  agentFile?: string;
  /** Whether the agent block was newly added (false = updated in place). */
  agentAdded?: boolean;
  /** Path to the generated skill, relative to cwd, if requested. */
  skillFile?: string;
  /** The auto-use value written to settings.local.json, if any. */
  autoUse?: AutoUse;
  /** Non-fatal warnings (e.g. a settings file we couldn't safely merge). */
  warnings: string[];
};

const SECTION_START = "<!-- web-tester:start -->";
const SECTION_END = "<!-- web-tester:end -->";

/** Recursively list files under `dir`, returning paths relative to it. */
function listFiles(dir: string, base = dir): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const abs = resolve(dir, entry);
    if (statSync(abs).isDirectory()) out.push(...listFiles(abs, base));
    else out.push(relative(base, abs));
  }
  return out;
}

/**
 * Scaffold `.web-tester/`, persist project config, generate the Claude Code
 * skill + agent-instructions block, and set the auto-use preference. Every
 * step is independent and idempotent; existing files are skipped unless
 * `force` is set (settings and config are merged, never clobbered).
 */
export function runInit(opts: InitOptions): InitResult {
  const written: string[] = [];
  const skipped: string[] = [];
  const warnings: string[] = [];
  const rel = (p: string): string => relative(opts.cwd, p);

  // 1. Scaffold .web-tester/ from the bundled templates.
  const srcRoot = resolve(TEMPLATES_DIR, "dot-web-tester");
  const destRoot = resolve(opts.cwd, USER_CONFIG_DIRNAME);
  for (const r of listFiles(srcRoot)) {
    const from = resolve(srcRoot, r);
    const to = resolve(destRoot, r);
    if (existsSync(to) && !opts.force) {
      skipped.push(rel(to));
      continue;
    }
    mkdirSync(dirname(to), { recursive: true });
    writeFileSync(to, readFileSync(from));
    written.push(rel(to));
  }

  // 2. Keep run artifacts out of version control via a scoped .gitignore.
  const gitignorePath = resolve(destRoot, ".gitignore");
  if (!existsSync(gitignorePath)) {
    mkdirSync(destRoot, { recursive: true });
    writeFileSync(gitignorePath, "runs/\n");
    written.push(rel(gitignorePath));
  }

  // 3. Persist the chosen base URL and default device so commands work
  //    without env vars or repeated flags.
  if (opts.baseUrl !== undefined || opts.device !== undefined) {
    const patch: { baseUrl?: string; device?: string } = {};
    if (opts.baseUrl !== undefined) patch.baseUrl = opts.baseUrl;
    if (opts.device !== undefined) patch.device = opts.device;
    const cfg = writeProjectConfig(opts.cwd, patch);
    if (cfg.changed) written.push(rel(cfg.path));
  }

  const result: InitResult = { written, skipped, warnings };

  // 4. Generate the Claude Code skill (.claude/skills/web-tester/SKILL.md).
  if (opts.skill !== false) {
    const skill = writeSkill(opts.cwd, opts.force);
    result.skillFile = rel(skill.path);
    (skill.written ? written : skipped).push(result.skillFile);
  }

  // 5. Inject the agent-instructions block into CLAUDE.md / AGENTS.md.
  if (opts.agentFile !== null) {
    const agent = writeAgentSection(opts.cwd, opts.agentFile);
    result.agentFile = rel(agent.path);
    result.agentAdded = agent.added;
    if (agent.added) written.push(result.agentFile);
  }

  // 6. Record the auto-use preference (merged into settings.local.json).
  if (opts.autoUse !== undefined) {
    const settings = writeAutoUse(opts.cwd, opts.autoUse);
    if (settings.changed) {
      const p = rel(settings.path);
      if (!written.includes(p) && !skipped.includes(p)) written.push(p);
      result.autoUse = opts.autoUse;
    }
    if (settings.warning) warnings.push(settings.warning);
  }

  return result;
}

/** Merge fields into `.web-tester/config.json`, preserving other keys. */
function writeProjectConfig(
  cwd: string,
  patch: { baseUrl?: string; device?: string }
): { path: string; changed: boolean } {
  const path = projectConfigPath(cwd);
  let config: Record<string, unknown> = {};
  if (existsSync(path)) {
    try {
      config = JSON.parse(readFileSync(path, "utf-8"));
    } catch {
      config = {};
    }
  }
  let changed = false;
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined && config[key] !== value) {
      config[key] = value;
      changed = true;
    }
  }
  if (!changed) return { path, changed: false };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
  return { path, changed: true };
}

/** Write the bundled SKILL.md. Won't overwrite an existing skill unless forced. */
function writeSkill(
  cwd: string,
  force: boolean
): { path: string; written: boolean } {
  const path = claudeSkillPath(cwd);
  if (existsSync(path) && !force) return { path, written: false };
  const content = readFileSync(resolve(TEMPLATES_DIR, "skill.md"), "utf-8");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  return { path, written: true };
}

/**
 * Merge `env.WEB_TESTER_AUTO_USE` into `.claude/settings.local.json`. Never
 * clobbers: if the file exists but isn't valid JSON, we leave it alone and
 * return a warning rather than risk destroying a developer's settings.
 */
function writeAutoUse(
  cwd: string,
  value: AutoUse
): { path: string; changed: boolean; warning?: string } {
  const path = claudeSettingsLocalPath(cwd);
  let settings: { env?: Record<string, unknown>; [k: string]: unknown } = {};
  if (existsSync(path)) {
    try {
      settings = JSON.parse(readFileSync(path, "utf-8"));
    } catch {
      return {
        path,
        changed: false,
        warning: `left ${relative(cwd, path)} untouched — it isn't valid JSON. Add \`"env": { "WEB_TESTER_AUTO_USE": "${value}" }\` yourself.`
      };
    }
  }
  if (settings.env?.WEB_TESTER_AUTO_USE === value) return { path, changed: false };
  settings.env = { ...(settings.env ?? {}), WEB_TESTER_AUTO_USE: value };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`);
  return { path, changed: true };
}

/** Resolve which agent file to write, honouring an explicit choice. */
function resolveAgentFile(cwd: string, explicit: string | undefined): string {
  if (explicit) return resolve(cwd, explicit);
  for (const name of ["CLAUDE.md", "AGENTS.md"]) {
    const candidate = resolve(cwd, name);
    if (existsSync(candidate)) return candidate;
  }
  return resolve(cwd, "CLAUDE.md");
}

/**
 * Insert or refresh the marker-fenced web-tester block in the agent file.
 * Idempotent: re-running replaces the block in place rather than duplicating.
 * Returns `added: true` when the block was newly inserted.
 */
function writeAgentSection(
  cwd: string,
  explicit: string | undefined
): { path: string; added: boolean } {
  const path = resolveAgentFile(cwd, explicit);
  const section = readFileSync(
    resolve(TEMPLATES_DIR, "agent-section.md"),
    "utf-8"
  ).trim();
  const block = `${SECTION_START}\n\n${section}\n\n${SECTION_END}`;

  mkdirSync(dirname(path), { recursive: true });

  if (!existsSync(path)) {
    writeFileSync(path, `# Agent instructions\n\n${block}\n`);
    return { path, added: true };
  }

  const current = readFileSync(path, "utf-8");
  const start = current.indexOf(SECTION_START);
  const end = current.indexOf(SECTION_END);
  if (start !== -1 && end !== -1 && end > start) {
    const before = current.slice(0, start);
    const after = current.slice(end + SECTION_END.length);
    writeFileSync(path, `${before}${block}${after}`);
    return { path, added: false };
  }
  // Exactly one marker, or end-before-start: the block is corrupted. Appending
  // would duplicate it (and again on every future run), so stop and let the
  // user fix it rather than silently make a mess.
  if (start !== -1 || end !== -1) {
    throw new Error(
      `${path} has a malformed web-tester block (a "${SECTION_START}" / ` +
        `"${SECTION_END}" marker is missing or out of order). Fix or remove ` +
        `the stray marker and re-run, or pass --no-agent to skip the agent file.`
    );
  }

  const sep = current.endsWith("\n") ? "\n" : "\n\n";
  writeFileSync(path, `${current}${sep}${block}\n`);
  return { path, added: true };
}
