import { createInterface } from "node:readline";

/** True when we can run an interactive prompt (both ends are a TTY). */
export function isInteractive(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

function question(query: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise<string>((resolve) => {
    rl.question(query, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

/** Free-text prompt with a default shown in brackets. Empty input → default. */
export async function ask(label: string, def: string): Promise<string> {
  const answer = (await question(`${label} [${def}]: `)).trim();
  return answer || def;
}

/** Yes/no prompt. Empty input → default. */
export async function confirm(label: string, def: boolean): Promise<boolean> {
  const hint = def ? "Y/n" : "y/N";
  const answer = (await question(`${label} (${hint}): `)).trim().toLowerCase();
  if (!answer) return def;
  return answer === "y" || answer === "yes";
}

/**
 * Pick one of `options`. Accepts a full value or a unique prefix
 * (case-insensitive). Empty input → default.
 */
export async function choice<T extends string>(
  label: string,
  options: readonly T[],
  def: T
): Promise<T> {
  const rendered = options
    .map((o) => (o === def ? o.toUpperCase() : o))
    .join("/");
  const answer = (await question(`${label} [${rendered}]: `)).trim().toLowerCase();
  if (!answer) return def;
  const match = options.find(
    (o) => o.toLowerCase() === answer || o.toLowerCase().startsWith(answer)
  );
  return match ?? def;
}
