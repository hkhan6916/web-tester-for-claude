---
name: web-tester
description: Drive the running dev site in a real browser (Playwright) to reproduce bugs, verify changes, and read runtime behavior — console, network, page errors, DOM, screenshots, video. Use this FIRST for any "does X work", bug-reproduction, "this page renders wrong", "the state is off", or "verify my change" question, before reading source. Also use to map a site, sweep many URLs, or run a saved journey.
allowed-tools: Bash(npx web-tester-for-claude *), Bash(web-tester *), Bash(npx web-tester *), Bash(npm run web-tester *), Bash(pnpm web-tester *), Read(**)
---

# Driving the site with web-tester

For any runtime-behavior question, reach for web-tester **before** Read/Grep. The
browser is the source of truth for runtime bugs; read code *after* the run,
guided by what the run shows.

## The core loop

1. **Run it** against your **localhost** dev server, always with `--quick` and
   `--fail-on http-5xx`. Add `--expect` for the specific thing you're checking:

   ```bash
   npx web-tester-for-claude inspect "/products/widget" \
     --step settle --quick \
     --expect "text=Add to Cart" \
     --fail-on http-5xx
   ```

2. **Read the report** at the path the CLI prints — `result.json` for
   programmatic reads (`ok`, `verdictTriggers`, `expectations`, `pageErrors`,
   `console.entries`, `network.entries`, `steps[N].evalResult`), `report.html`
   to scrub the video. **Only then** open source files.

3. **When the DOM isn't enough**, re-run with `--deep`: it adds request/response
   bodies, the **local-scope variables at every uncaught exception**, and
   unhandled promise rejections (`result.json` → `deepErrors`,
   `unhandledRejections`, `network.entries[].responseBody`).

4. **For responsive behaviour**, add `--device mobile` (or `tablet`, or any
   Playwright device like `"iPhone 13"`). Default is desktop. Pass a comma list
   such as `--device mobile,desktop` to run the flow on each one in a single
   command.

## Commands

| Command | Use it for |
|---|---|
| `inspect <url> [--step …]` | Drive one page / flow, capture everything. |
| `sweep --preset <name>` | Health-check many URLs in parallel. |
| `journey <name>` | Run a saved flow from `.web-tester/journeys/`. |
| `map` | Crawl the site and auto-generate a preset, recipes, and journey drafts. |
| `impact` | Diff-aware advisory run (reads `.web-tester/impact-rules.json`). |
| `kb [topic]` | List/print project recipe notes in `.web-tester/instructions/`. |

## Before you write a `--step` chain from scratch

Run `web-tester kb` first — the project's recipes live there. Step grammar
gotchas: `click:` takes a Playwright CSS locator (not `role=`); if a `click:`
times out on a covered or mid-animation element, use `force-click:` (dispatches
a DOM click, skips actionability checks) instead of reaching for `eval`; when
`wait:networkidle` never settles, wait on the real condition with
`wait:js:<expr>`; `settle` only does something on pages with `[data-attr-name]`
markers. Run `web-tester help` for the full grammar.

## Don't

- Don't verify a **local** change against **prod** — prod doesn't have your edit.
  localhost is the default and the right target.
- Don't `--fail-on page-errors` by default — most apps have baseline framework
  warnings. `http-5xx` is the safe gate.
- Don't trust a single `--expect` for async/derived state — add `--persist 2500`.
