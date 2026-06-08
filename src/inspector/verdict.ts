import type { Page } from "playwright";
import type {
  ConsoleEntry,
  NetworkEntry,
  PageErrorEntry
} from "./capture";

export type FailOnKind =
  | "page-errors"
  | "console-errors"
  | "http-4xx"
  | "http-5xx";

const FAIL_ON_ALIASES: Record<string, FailOnKind> = {
  "page-errors": "page-errors",
  "console-errors": "console-errors",
  "http-4xx": "http-4xx",
  "http-5xx": "http-5xx",
  "4xx": "http-4xx",
  "5xx": "http-5xx"
};

export function parseFailOn(raw: string): FailOnKind[] {
  const parts = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const out: FailOnKind[] = [];
  for (const p of parts) {
    const mapped = FAIL_ON_ALIASES[p];
    if (!mapped)
      throw new Error(
        `--fail-on unknown kind "${p}". Known: page-errors, console-errors, 4xx, 5xx`
      );
    if (!out.includes(mapped)) out.push(mapped);
  }
  return out;
}

export type Expectation =
  | { kind: "text"; text: string }
  | { kind: "no-text"; text: string }
  | { kind: "selector"; selector: string }
  | { kind: "no-selector"; selector: string }
  | { kind: "attr"; name: string; value: string };

export type ExpectationResult = {
  expectation: Expectation;
  ok: boolean;
  detail?: string;
};

/**
 * Parse `--expect <kind>=<value>` shorthand.
 *
 *   text=Welcome                      → page must contain text "Welcome"
 *   no-text=Error                     → page must NOT contain text "Error"
 *   selector=button[type=submit]      → element must be visible
 *   no-selector=.error-banner         → element must not be visible
 *   attr=Quantity:1000                → data-attr-name="Quantity" must have value or label "1000"
 */
export function parseExpectation(raw: string): Expectation {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error("empty --expect");
  const eq = trimmed.indexOf("=");
  if (eq === -1)
    throw new Error(
      `--expect needs <kind>=<value> (got "${raw}"). Kinds: text, no-text, selector, no-selector, attr`
    );
  const kind = trimmed.slice(0, eq);
  const value = trimmed.slice(eq + 1);
  switch (kind) {
    case "text":
      if (!value) throw new Error("--expect text= needs text");
      return { kind: "text", text: value };
    case "no-text":
      if (!value) throw new Error("--expect no-text= needs text");
      return { kind: "no-text", text: value };
    case "selector":
      if (!value) throw new Error("--expect selector= needs a selector");
      return { kind: "selector", selector: value };
    case "no-selector":
      if (!value) throw new Error("--expect no-selector= needs a selector");
      return { kind: "no-selector", selector: value };
    case "attr": {
      const colon = value.indexOf(":");
      if (colon === -1)
        throw new Error(
          "--expect attr= needs <name>:<value> (e.g. attr=Quantity:1000)"
        );
      return {
        kind: "attr",
        name: value.slice(0, colon),
        value: value.slice(colon + 1)
      };
    }
    default:
      throw new Error(
        `--expect unknown kind "${kind}" in "${raw}". Kinds: text, no-text, selector, no-selector, attr`
      );
  }
}

/**
 * How long to wait for a positive assertion (text/selector visible, attr
 * present) before deciding it failed. 5s leaves room for an element that
 * renders a few seconds after a client-side route transition + hydration;
 * tighter values flake on prod-like latency.
 */
const EXPECT_TIMEOUT_MS = 5_000;

export async function evaluateExpectations(
  page: Page,
  expectations: Expectation[]
): Promise<ExpectationResult[]> {
  const results: ExpectationResult[] = [];
  for (const e of expectations) {
    results.push(await evaluateOne(page, e));
  }
  return results;
}

async function evaluateOne(
  page: Page,
  e: Expectation
): Promise<ExpectationResult> {
  try {
    if (e.kind === "text") {
      const found = await page
        .getByText(e.text)
        .first()
        .waitFor({ state: "visible", timeout: EXPECT_TIMEOUT_MS })
        .then(() => true)
        .catch(() => false);
      return {
        expectation: e,
        ok: found,
        ...(found ? {} : { detail: `text "${e.text}" not visible on final page` })
      };
    }
    if (e.kind === "no-text") {
      // Slightly shorter timeout — we expect this NOT to appear.
      const found = await page
        .getByText(e.text)
        .first()
        .waitFor({ state: "visible", timeout: 1_500 })
        .then(() => true)
        .catch(() => false);
      return {
        expectation: e,
        ok: !found,
        ...(found
          ? { detail: `text "${e.text}" was visible (should not be)` }
          : {})
      };
    }
    if (e.kind === "selector") {
      const found = await page
        .locator(e.selector)
        .first()
        .waitFor({ state: "visible", timeout: EXPECT_TIMEOUT_MS })
        .then(() => true)
        .catch(() => false);
      return {
        expectation: e,
        ok: found,
        ...(found ? {} : { detail: `selector "${e.selector}" not visible` })
      };
    }
    if (e.kind === "no-selector") {
      const found = await page
        .locator(e.selector)
        .first()
        .waitFor({ state: "visible", timeout: 1_500 })
        .then(() => true)
        .catch(() => false);
      return {
        expectation: e,
        ok: !found,
        ...(found
          ? { detail: `selector "${e.selector}" was visible (should not be)` }
          : {})
      };
    }
    // attr
    const snapshot = await page.evaluate((name) => {
      const el = document.querySelector(`[data-attr-name="${name}"]`);
      if (!el) return null;
      return {
        value: el.getAttribute("data-attr-selected-value") ?? "",
        label: el.getAttribute("data-attr-selected-label") ?? ""
      };
    }, e.name);
    if (snapshot === null) {
      return {
        expectation: e,
        ok: false,
        detail: `no data-attr-name="${e.name}" found — page may need instrumentation`
      };
    }
    const matches = snapshot.value === e.value || snapshot.label === e.value;
    return {
      expectation: e,
      ok: matches,
      ...(matches
        ? {}
        : {
            detail: `attr "${e.name}" was value="${snapshot.value}" label="${snapshot.label}", expected "${e.value}"`
          })
    };
  } catch (err) {
    return {
      expectation: e,
      ok: false,
      detail: err instanceof Error ? err.message : String(err)
    };
  }
}

export type VerdictInputs = {
  failedSteps: number;
  pageErrors: PageErrorEntry[];
  consoleEntries: ConsoleEntry[];
  networkEntries: NetworkEntry[];
  expectations: ExpectationResult[];
  failOn: FailOnKind[];
};

export type Verdict = {
  ok: boolean;
  triggers: string[];
};

/**
 * Compute the final pass/fail verdict. `ok` is true iff:
 *   - every step executed (failedSteps === 0)
 *   - every expectation passed
 *   - no signal from --fail-on tripped
 *
 * `triggers` is a list of one-line reasons the verdict failed, suitable for
 * surfacing in the CLI summary and HTML report. Empty when ok.
 */
export function computeVerdict(inputs: VerdictInputs): Verdict {
  const triggers: string[] = [];
  if (inputs.failedSteps > 0)
    triggers.push(`${inputs.failedSteps} step(s) failed`);

  if (inputs.failOn.includes("page-errors") && inputs.pageErrors.length > 0)
    triggers.push(`${inputs.pageErrors.length} uncaught page error(s)`);

  if (inputs.failOn.includes("console-errors")) {
    const n = inputs.consoleEntries.filter((e) => e.type === "error").length;
    if (n > 0) triggers.push(`${n} console error(s)`);
  }

  if (inputs.failOn.includes("http-4xx")) {
    const n = inputs.networkEntries.filter(
      (e) => e.status !== null && e.status >= 400 && e.status < 500
    ).length;
    if (n > 0) triggers.push(`${n} 4xx response(s)`);
  }

  if (inputs.failOn.includes("http-5xx")) {
    const n = inputs.networkEntries.filter(
      (e) => e.status !== null && e.status >= 500
    ).length;
    if (n > 0) triggers.push(`${n} 5xx response(s)`);
  }

  const failedExp = inputs.expectations.filter((r) => !r.ok);
  if (failedExp.length > 0)
    triggers.push(`${failedExp.length} expectation(s) failed`);

  return { ok: triggers.length === 0, triggers };
}
