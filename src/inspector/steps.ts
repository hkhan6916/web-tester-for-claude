import type { Page } from "playwright";
import { waitForAttrsReady } from "../browser/attrs";

export type WaitTarget =
  | { kind: "loadState"; state: "load" | "domcontentloaded" | "networkidle" }
  | { kind: "ms"; ms: number }
  | { kind: "selector"; selector: string }
  | { kind: "text"; text: string }
  | { kind: "urlStable"; quietMs: number }
  | { kind: "urlContains"; substring: string; timeoutMs: number }
  | { kind: "predicate"; expression: string };

export type Step =
  | { kind: "goto"; url: string }
  | { kind: "click"; selector: string; nth: number; force: boolean }
  | { kind: "fill"; selector: string; value: string }
  | { kind: "reactFill"; selector: string; value: string }
  | { kind: "press"; selector: string; key: string }
  | { kind: "select"; selector: string; value: string }
  | { kind: "hover"; selector: string }
  | { kind: "scroll"; target: "top" | "bottom" | "px"; px?: number }
  | { kind: "wait"; target: WaitTarget }
  | { kind: "settle"; timeoutMs?: number }
  | { kind: "screenshot"; name?: string; fullPage?: boolean }
  | { kind: "eval"; script: string }
  | { kind: "reload" };

const LOAD_STATES = new Set(["load", "domcontentloaded", "networkidle"]);

/**
 * Split a `<selector>=<value>` step argument on the first `=` that sits
 * outside any `[...]`, `(...)`, or quotes. Attribute selectors like
 * `input[name=email]` and `:has-text("a=b")` keep their inner `=`; only the
 * real separator splits the value off. Returns null when there is no
 * top-level `=` (i.e. no value was supplied).
 */
function splitSelectorValue(
  arg: string
): { selector: string; value: string } | null {
  let depth = 0;
  let quote: string | null = null;
  for (let i = 0; i < arg.length; i++) {
    const c = arg[i];
    if (quote) {
      // A closing quote only counts if preceded by an even number of
      // backslashes (so `\"` stays escaped but `\\"` closes the string).
      if (c === quote) {
        let backslashes = 0;
        for (let j = i - 1; j >= 0 && arg[j] === "\\"; j--) backslashes++;
        if (backslashes % 2 === 0) quote = null;
      }
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === "[" || c === "(") depth++;
    else if (c === "]" || c === ")") depth = Math.max(0, depth - 1);
    else if (c === "=" && depth === 0)
      return { selector: arg.slice(0, i), value: arg.slice(i + 1) };
  }
  return null;
}

/**
 * Parse a click argument: an optional `nth=<n>:` prefix picks which match to
 * act on (default the first), the rest is the selector. `nth=2:button.card`
 * targets the third match; a plain selector targets the first. The prefix is
 * unambiguous because no valid CSS selector starts with `nth=<digits>:`.
 */
function parseClickArg(arg: string, force: boolean): Step {
  const label = force ? "force-click" : "click";
  if (!arg) throw new Error(`\`${label}\` needs a selector`);
  const m = /^nth=(\d+):/.exec(arg);
  const selector = m ? arg.slice(m[0].length) : arg;
  if (!selector) throw new Error(`\`${label}\` needs a selector after nth=<n>:`);
  return { kind: "click", selector, nth: m ? Number(m[1]) : 0, force };
}

/**
 * Parse a `--step <type>:<arg>` shorthand into a typed step.
 *
 * Examples:
 *   "settle"                                      → settle
 *   "goto:/checkout"                              → goto
 *   "wait:networkidle"                            → wait loadState
 *   "wait:2000"                                   → wait ms
 *   "wait:#cta"                                   → wait selector
 *   "wait:text=Submit"                            → wait text
 *   "wait:js:window.cartReady === true"           → wait until a JS expr is truthy
 *   "click:button:has-text(\"Submit\")"           → click (note: selector may contain `:`)
 *   "click:nth=2:.product-card a"                 → click the third match
 *   "force-click:button.add-to-bag"               → click, skipping actionability checks
 *   "fill:input[name=email]=user@example.com"     → fill (first `=` after selector splits value)
 *   "screenshot:after-submit"                     → screenshot
 *   "screenshot"                                  → screenshot anonymous
 */
export function parseStep(raw: string): Step {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error("empty --step");

  const colonAt = trimmed.indexOf(":");
  const type = colonAt === -1 ? trimmed : trimmed.slice(0, colonAt);
  const arg = colonAt === -1 ? "" : trimmed.slice(colonAt + 1);

  switch (type) {
    case "settle": {
      if (!arg) return { kind: "settle" };
      const ms = Number(arg);
      if (!Number.isFinite(ms) || ms <= 0)
        throw new Error("`settle:<ms>` needs a positive integer");
      return { kind: "settle", timeoutMs: ms };
    }
    case "reload":
      return { kind: "reload" };
    case "goto":
      if (!arg) throw new Error("`goto` needs a URL");
      return { kind: "goto", url: arg };
    case "click":
      return parseClickArg(arg, false);
    case "force-click":
      return parseClickArg(arg, true);
    case "hover":
      if (!arg) throw new Error("`hover` needs a selector");
      return { kind: "hover", selector: arg };
    case "fill": {
      const parts = splitSelectorValue(arg);
      if (!parts) throw new Error("`fill` needs `<selector>=<value>`");
      return { kind: "fill", selector: parts.selector, value: parts.value };
    }
    case "react-fill": {
      const parts = splitSelectorValue(arg);
      if (!parts) throw new Error("`react-fill` needs `<selector>=<value>`");
      return { kind: "reactFill", selector: parts.selector, value: parts.value };
    }
    case "press": {
      const parts = splitSelectorValue(arg);
      if (!parts) throw new Error("`press` needs `<selector>=<key>`");
      return { kind: "press", selector: parts.selector, key: parts.value };
    }
    case "select": {
      const parts = splitSelectorValue(arg);
      if (!parts) throw new Error("`select` needs `<selector>=<value>`");
      return { kind: "select", selector: parts.selector, value: parts.value };
    }
    case "scroll":
      if (arg === "top") return { kind: "scroll", target: "top" };
      if (arg === "bottom") return { kind: "scroll", target: "bottom" };
      if (/^\d+$/.test(arg))
        return { kind: "scroll", target: "px", px: Number(arg) };
      throw new Error(`unknown scroll target: ${arg}`);
    case "wait": {
      if (!arg) throw new Error("`wait` needs a target");
      if (LOAD_STATES.has(arg))
        return {
          kind: "wait",
          target: {
            kind: "loadState",
            state: arg as "load" | "domcontentloaded" | "networkidle"
          }
        };
      if (/^\d+$/.test(arg))
        return { kind: "wait", target: { kind: "ms", ms: Number(arg) } };
      if (arg.startsWith("text="))
        return {
          kind: "wait",
          target: { kind: "text", text: arg.slice("text=".length) }
        };
      if (arg.startsWith("js:")) {
        const expression = arg.slice("js:".length).trim();
        if (!expression) throw new Error("`wait:js:<expr>` needs a JS expression");
        return { kind: "wait", target: { kind: "predicate", expression } };
      }
      if (arg === "url-stable")
        return { kind: "wait", target: { kind: "urlStable", quietMs: 250 } };
      if (arg.startsWith("url-stable=")) {
        const ms = Number(arg.slice("url-stable=".length));
        if (!Number.isFinite(ms) || ms <= 0)
          throw new Error("`wait:url-stable=<ms>` needs a positive integer");
        return { kind: "wait", target: { kind: "urlStable", quietMs: ms } };
      }
      if (arg.startsWith("url-contains:")) {
        const rest = arg.slice("url-contains:".length);
        // Optional trailing `@<timeoutMs>` overrides the 10s default. The
        // separator is `@` (not `=`) so the substring can itself contain `=`
        // — e.g. `wait:url-contains:tab=details@30000`.
        const at = rest.lastIndexOf("@");
        if (at === -1 || !/^\d+$/.test(rest.slice(at + 1)))
          return {
            kind: "wait",
            target: { kind: "urlContains", substring: rest, timeoutMs: 10_000 }
          };
        const timeoutMs = Number(rest.slice(at + 1));
        if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
          throw new Error(
            "`wait:url-contains:<sub>@<ms>` timeout must be a positive integer"
          );
        return {
          kind: "wait",
          target: {
            kind: "urlContains",
            substring: rest.slice(0, at),
            timeoutMs
          }
        };
      }
      return { kind: "wait", target: { kind: "selector", selector: arg } };
    }
    case "screenshot":
      return { kind: "screenshot", name: arg || undefined, fullPage: false };
    case "screenshot-full":
      return { kind: "screenshot", name: arg || undefined, fullPage: true };
    case "eval":
      if (!arg) throw new Error("`eval` needs a JS expression");
      return { kind: "eval", script: arg };
    default:
      throw new Error(
        `unknown step type "${type}". See \`pnpm web-tester help\`.`
      );
  }
}

const DEFAULT_TIMEOUT_MS = Number(process.env.STEP_TIMEOUT_MS ?? 15_000);
const DEFAULT_SETTLE_MS = Number(process.env.SETTLE_TIMEOUT_MS ?? 30_000);

/**
 * Execute a single step against the page. Returns a short label describing
 * what happened and, optionally, an `evalResult` for `eval` steps.
 */
export async function executeStep(
  step: Step,
  page: Page
): Promise<{ label: string; evalResult?: unknown }> {
  switch (step.kind) {
    case "goto": {
      const baseUrl = new URL(page.url()).origin;
      const target = step.url.startsWith("http")
        ? step.url
        : new URL(step.url, baseUrl).toString();
      const response = await page.goto(target, {
        waitUntil: "domcontentloaded",
        timeout: DEFAULT_TIMEOUT_MS
      });
      return { label: `goto ${target} (${response?.status() ?? "?"})` };
    }
    case "reload":
      await page.reload({ waitUntil: "domcontentloaded" });
      return { label: "reload" };
    case "click": {
      const target = page.locator(step.selector).nth(step.nth);
      if (step.force) {
        // Dispatch a DOM click straight at the element, the way `el.click()`
        // does in the page. This ignores actionability checks AND overlay
        // hit-testing, so covered buttons, mid-animation elements, and links
        // Playwright deems "not stable" still go through. It's the built-in
        // version of the eval-click workaround. Only waits for the element to
        // be attached, not visible.
        await target.dispatchEvent("click", undefined, {
          timeout: DEFAULT_TIMEOUT_MS
        });
      } else {
        await target.click({ timeout: DEFAULT_TIMEOUT_MS });
      }
      const verb = step.force ? "force-click" : "click";
      const where = step.nth ? ` [nth=${step.nth}]` : "";
      return { label: `${verb} ${step.selector}${where}` };
    }
    case "hover":
      await page.locator(step.selector).first().hover({ timeout: DEFAULT_TIMEOUT_MS });
      return { label: `hover ${step.selector}` };
    case "fill":
      await page
        .locator(step.selector)
        .first()
        .fill(step.value, { timeout: DEFAULT_TIMEOUT_MS });
      return { label: `fill ${step.selector} = ${step.value}` };
    case "reactFill": {
      // React controlled inputs reset to their state value when you mutate
      // the DOM value directly, so Playwright's `fill` doesn't stick. Call
      // the native value setter on the prototype, then dispatch input/change
      // so React's synthetic event system picks up the change.
      const result = await page.evaluate(
        ({ selector, value }) => {
          const el = document.querySelector(
            selector
          ) as HTMLInputElement | HTMLTextAreaElement | null;
          if (!el) return { ok: false, reason: `selector not found: ${selector}` };
          const proto =
            el.tagName === "TEXTAREA"
              ? window.HTMLTextAreaElement.prototype
              : window.HTMLInputElement.prototype;
          const desc = Object.getOwnPropertyDescriptor(proto, "value");
          if (!desc?.set)
            return { ok: false, reason: "no value setter on prototype" };
          desc.set.call(el, value);
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
          el.blur();
          return { ok: true, finalDomValue: el.value };
        },
        { selector: step.selector, value: step.value }
      );
      if (!result.ok)
        throw new Error(`react-fill failed: ${result.reason ?? "unknown"}`);
      return {
        label: `react-fill ${step.selector} = ${step.value}`,
        evalResult: result
      };
    }
    case "press":
      await page
        .locator(step.selector)
        .first()
        .press(step.key, { timeout: DEFAULT_TIMEOUT_MS });
      return { label: `press ${step.key} on ${step.selector}` };
    case "select":
      await page
        .locator(step.selector)
        .first()
        .selectOption(step.value, { timeout: DEFAULT_TIMEOUT_MS });
      return { label: `select ${step.value} in ${step.selector}` };
    case "scroll":
      if (step.target === "top") {
        await page.evaluate(() => window.scrollTo(0, 0));
        return { label: "scroll top" };
      }
      if (step.target === "bottom") {
        await page.evaluate(() =>
          window.scrollTo(0, document.body.scrollHeight)
        );
        return { label: "scroll bottom" };
      }
      await page.evaluate((px) => window.scrollTo(0, px), step.px ?? 0);
      return { label: `scroll ${step.px}px` };
    case "wait": {
      const t = step.target;
      if (t.kind === "loadState") {
        await page.waitForLoadState(t.state, { timeout: DEFAULT_TIMEOUT_MS });
        return { label: `wait load=${t.state}` };
      }
      if (t.kind === "ms") {
        await page.waitForTimeout(t.ms);
        return { label: `wait ${t.ms}ms` };
      }
      if (t.kind === "selector") {
        await page.locator(t.selector).first().waitFor({ timeout: DEFAULT_TIMEOUT_MS });
        return { label: `wait selector ${t.selector}` };
      }
      if (t.kind === "predicate") {
        // Poll a JS expression in the page until it's truthy. Exceptions during
        // early polls (e.g. a store global that hasn't loaded yet) count as
        // "not ready" so it keeps waiting, instead of rejecting immediately.
        // The raw string is evaluated in the page, so esbuild never wraps it
        // (no `__name` helper) — same reason `eval` passes a string.
        const guarded = `(()=>{try{return (${t.expression})}catch(e){return false}})()`;
        try {
          await page.waitForFunction(guarded, undefined, {
            timeout: DEFAULT_TIMEOUT_MS
          });
        } catch {
          const current = await page
            .evaluate(
              `(()=>{try{return (${t.expression})}catch(e){return "ERR: "+e.message}})()`
            )
            .catch(() => "<eval failed>");
          throw new Error(
            `wait:js \`${t.expression}\` was not truthy within ${DEFAULT_TIMEOUT_MS}ms ` +
              `(current value: ${JSON.stringify(current)})`
          );
        }
        return { label: `wait js ${t.expression.slice(0, 50)}` };
      }
      if (t.kind === "urlStable") {
        // Wait for the URL to change at least once, then hold steady for
        // `quietMs`. Requiring an observed change (not just "stable from the
        // start") avoids a false pass when the action under test hasn't
        // written to the URL yet. Useful after a debounced router.replace.
        const POLL_MS = 50;
        const DEADLINE = Date.now() + DEFAULT_TIMEOUT_MS;
        const initial = page.url();
        let last = initial;
        let stableSince = Date.now();
        let hasChanged = false;
        while (Date.now() < DEADLINE) {
          await page.waitForTimeout(POLL_MS);
          const current = page.url();
          if (current !== last) {
            last = current;
            stableSince = Date.now();
            if (current !== initial) hasChanged = true;
          } else if (
            hasChanged &&
            Date.now() - stableSince >= t.quietMs
          ) {
            return { label: `wait url-stable (${t.quietMs}ms quiet)` };
          }
        }
        throw new Error(
          hasChanged
            ? `wait:url-stable timed out — URL kept changing past ${DEFAULT_TIMEOUT_MS}ms`
            : `wait:url-stable timed out — URL never changed from "${initial}" within ${DEFAULT_TIMEOUT_MS}ms. If the action under test doesn't write to the URL, use \`wait:<ms>\` or \`wait:url-contains:<sub>\` instead.`
        );
      }
      if (t.kind === "urlContains") {
        // Deterministic alternative to url-stable: wait until the URL contains
        // a known substring. Use when an action pushes a specific param or
        // navigates to a known path.
        const POLL_MS = 100;
        const DEADLINE = Date.now() + t.timeoutMs;
        while (Date.now() < DEADLINE) {
          if (page.url().includes(t.substring))
            return {
              label: `wait url-contains "${t.substring}" (${Date.now() - (DEADLINE - t.timeoutMs)}ms)`
            };
          await page.waitForTimeout(POLL_MS);
        }
        throw new Error(
          `wait:url-contains "${t.substring}" timed out after ${t.timeoutMs}ms (final URL: ${page.url()})`
        );
      }
      await page.getByText(t.text).first().waitFor({ timeout: DEFAULT_TIMEOUT_MS });
      return { label: `wait text="${t.text}"` };
    }
    case "settle":
      await waitForAttrsReady(page, step.timeoutMs ?? DEFAULT_SETTLE_MS);
      return {
        label:
          step.timeoutMs !== undefined
            ? `settle (attrs ready, ${step.timeoutMs}ms cap)`
            : "settle (attrs ready)"
      };
    case "screenshot":
      // Screenshot is captured by the runner, which also names it. The runner
      // looks at the step kind directly — we just pass through.
      return {
        label: step.fullPage
          ? `screenshot-full ${step.name ?? ""}`
          : `screenshot ${step.name ?? ""}`
      };
    case "eval": {
      // Pass as a raw expression string so we don't go through esbuild's
      // function compilation (which would inject `__name` helpers).
      const value = await page.evaluate(step.script);
      return { label: `eval ${step.script.slice(0, 40)}`, evalResult: value };
    }
  }
}
