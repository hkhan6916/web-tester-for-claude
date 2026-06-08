import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { userKnowledgeDirs } from "./util/paths";

export type KnowledgeFile = {
  /** Slug derived from filename (no `.md`). */
  topic: string;
  /** First markdown H1 in the file, or filename if absent. */
  title: string;
  /** Absolute path on disk. */
  path: string;
  /** Tags / id parsed out of any YAML-ish frontmatter block. */
  meta: Record<string, string | string[] | boolean>;
};

function parseSimpleFrontmatter(
  raw: string
): { meta: Record<string, string | string[] | boolean>; body: string } {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match || match[1] === undefined || match[2] === undefined) {
    return { meta: {}, body: raw };
  }
  const meta: Record<string, string | string[] | boolean> = {};
  for (const line of match[1].split("\n")) {
    const kv = line.match(/^([a-zA-Z][a-zA-Z0-9_]*):\s*(.*)$/);
    if (!kv) continue;
    const key = kv[1] ?? "";
    const value = (kv[2] ?? "").trim();
    if (value === "") continue;
    if (value === "true") meta[key] = true;
    else if (value === "false") meta[key] = false;
    else if (/^\[.*\]$/.test(value)) {
      meta[key] = value
        .slice(1, -1)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    } else meta[key] = value;
  }
  return { meta, body: match[2] };
}

function firstH1(body: string): string | null {
  const line = body.split("\n").find((l) => l.startsWith("# "));
  return line ? line.replace(/^#\s+/, "").trim() : null;
}

/**
 * Locate the directory that holds the user's KB markdown. Walks the
 * candidate locations returned by `userKnowledgeDirs()` in order; first
 * match wins. Returns null if none of the candidates exist.
 */
function resolveKnowledgeDir(): string | null {
  for (const dir of userKnowledgeDirs()) {
    if (existsSync(dir)) return dir;
  }
  return null;
}

export function listKnowledge(): KnowledgeFile[] {
  const dir = resolveKnowledgeDir();
  if (!dir) return [];
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".md") && f !== "README.md")
    .sort();
  return files.map((f) => {
    const path = resolve(dir, f);
    const raw = readFileSync(path, "utf-8");
    const { meta, body } = parseSimpleFrontmatter(raw);
    const titleMeta = typeof meta.title === "string" ? meta.title : null;
    const title = titleMeta ?? firstH1(body) ?? f;
    return { topic: f.replace(/\.md$/, ""), title, path, meta };
  });
}

export function readKnowledge(topic: string): KnowledgeFile & { contents: string } {
  const all = listKnowledge();
  const found = all.find((k) => k.topic === topic);
  if (!found) {
    const known = all.map((k) => k.topic).join(", ") || "(no .md files found in .web-tester/)";
    throw new Error(`knowledge topic "${topic}" not found. Known: ${known}`);
  }
  return { ...found, contents: readFileSync(found.path, "utf-8") };
}
