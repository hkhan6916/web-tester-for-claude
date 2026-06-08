import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { userJourneysDir } from "./util/paths";

/**
 * A "journey" bundles a URL + step chain + assertions into a single named
 * recipe — the same shape as a manual `inspect` invocation, but persisted
 * to disk so it can be invoked by name (and by the `impact` command). New
 * journeys go in `.web-tester/journeys/<name>.json` at your project root.
 */
export type Journey = {
  /** Optional human description, for the CLI listing. */
  description?: string;
  /** Path or absolute URL; resolved against WEB_TESTER_BASE_URL if relative. */
  url: string;
  /** Step strings in the same grammar as `--step` (parsed with `parseStep`). */
  steps: string[];
  /** Expectation strings in `--expect` syntax (parsed with `parseExpectation`). */
  expectations?: string[];
  /** Fail-on signals (`page-errors,4xx,5xx,console-errors`). Default 5xx only. */
  failOn?: string;
  /** Persist-check window in ms; 0 = single check. */
  persistMs?: number;
};

export function loadJourney(name: string): Journey {
  const dir = userJourneysDir();
  const path = resolve(dir, `${name}.json`);
  if (!existsSync(path))
    throw new Error(
      `unknown journey "${name}". Looked for ${path}. Known: ${listJourneyNames().join(", ") || "(none — add .json files to .web-tester/journeys/)"}`
    );
  const raw = readFileSync(path, "utf-8");
  const parsed = JSON.parse(raw) as Journey;
  if (!parsed.url || !Array.isArray(parsed.steps))
    throw new Error(`journey "${name}" is missing required "url" or "steps"`);
  return parsed;
}

/**
 * Persist a journey to `.web-tester/journeys/<name>.json` — the plain-text
 * "recipe" a rerun replays. Stores only the flow (url + steps + assertions),
 * never run artifacts. The name is slugified so it's safe as a filename.
 * Returns the absolute path written.
 */
export function saveJourney(name: string, journey: Journey): string {
  const slug = name
    .replace(/\.json$/i, "")
    .replace(/[^a-z0-9_-]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
  if (!slug) throw new Error(`invalid journey name: "${name}"`);
  const dir = userJourneysDir();
  mkdirSync(dir, { recursive: true });
  const path = resolve(dir, `${slug}.json`);
  writeFileSync(path, `${JSON.stringify(journey, null, 2)}\n`);
  return path;
}

export function listJourneyNames(): string[] {
  const dir = userJourneysDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.slice(0, -".json".length))
    .sort();
}

export function listJourneys(): Array<{ name: string; description: string }> {
  return listJourneyNames().map((name) => {
    try {
      const j = loadJourney(name);
      return { name, description: j.description ?? "" };
    } catch {
      return { name, description: "(failed to load)" };
    }
  });
}
