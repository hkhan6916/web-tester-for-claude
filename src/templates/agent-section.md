## Inspecting the site with web-tester

### The rule

**For any runtime-behaviour question, your FIRST tool call is web-tester — not Read, Grep, or a code-search agent.** Bug reproductions, "does X work" verifications, "this URL renders weirdly" reports, "state doesn't match what I see" — these are all observable in a browser. Run it first, look at the evidence, *then* read code based on what the run shows you. Reading code before driving the live site is what burns sessions and frustrates the developer.

### Triggers — these are all "web-tester first" questions

- **Bug reproduction**: "the form submits but nothing happens", "this page renders weirdly", "the count is wrong", anything that starts with a QA report.
- **Change verification**: "did my refactor still let users sign up?", "does the navbar still work after I touched the layout?", "verify <component> still works on <route>".
- **Cross-page regression** (after touching shared code — layout, design-system primitives, data-fetching hooks, providers): use `web-tester sweep --preset smoke` (or whichever preset covers the high-value pages) against **localhost**. Each URL in the preset can be annotated with an expectation pack so a regression in one page family fails specifically.
- **"What might my diff have broken?"** (the *fix one thing, break another* class): use `web-tester impact`. It reads `git diff` vs origin/main, matches changed paths against rules in `.web-tester/impact-rules.json`, and runs the matched sweeps + journeys against localhost. **Output is advisory only — it never blocks anything.**
- **Behaviour discovery**: "what does the page actually do when I click X?", "what's in the network when the page settles?".
- **Live diagnostics for an open issue**: console errors, hydration warnings, 4xx responses, missing data on a page.

Don't reach for web-tester for pure code-reading ("what does this function do?"), unscoped implementation work ("add a feature"), test-file writing, or anything with no specific URL/flow in mind.

### Ask before assuming the page or feature

If the developer hasn't named a specific URL, page, or feature, **ask before running**. Many domain terms ("the form", "the buttons", "the page") overlap multiple page types. One short clarifying question is cheaper than running the wrong recipe.

The shape of the question: *"Which page is this happening on?"* or *"Can you share a URL that reproduces it?"* Then route based on the URL, not your guess.

### Auto-use opt-in (per developer)

Auto-use is gated by `WEB_TESTER_AUTO_USE` in `.claude/settings.local.json` (the `env` block). Values:

- `"on"` — proceed silently; run web-tester when the intent matches the triggers above.
- `"ask"` — propose the run in **one sentence** as your **first** response (e.g. *"I'd verify with `web-tester inspect /pricing --quick --expect 'text=$49/mo' --fail-on http-5xx`; confirm and I'll run."*). **Do not Read source files, do not Grep, do not spawn an explorer agent — propose first.** When the developer confirms, your very next tool call must be `web-tester inspect …` or `… sweep …`. Reading code happens *after* the run, targeted by what the run shows.
- `"off"` — never auto-run. Only run when the developer explicitly says so.

**One-time introduction on the first session of a branch.** The first time you respond in a session where `env.WEB_TESTER_AUTO_USE` is not yet set, briefly introduce web-tester and capture the developer's preference **before** answering whatever else they asked. Then write their choice to that file (merge into the existing JSON; never overwrite other keys). From that turn on, honour the flag. If the developer ignores the intro and proceeds with their task, assume `"ask"` for the rest of the session and move on.

### How to use it (the recipe-first flow)

1. **Pick a recipe.** `web-tester kb` (and `web-tester kb <topic>`) lists the recipe notes the project has in `.web-tester/instructions/`. If none match cleanly, skim them once to learn the step grammar, then write your own.
2. **Pick the base — this matters.** Default to **localhost** (your dev server). Prod / preview deployments are ONLY for "does this bug exist on the live site, before I touch any code". **Verifying your own local change against prod is meaningless — prod doesn't have your edit.**
3. **Run it.** Always with `--quick` (skips video, full-page screenshots, AI summary) and `--fail-on http-5xx`. Add `--expect "<assertion>"` for the specific thing you're verifying.
4. **Read `result.json`** at the path the CLI prints. Look at `ok`, `verdictTriggers`, `expectations[]`, `pageErrors`, `console.entries`, `network.entries`, `steps[N].evalResult`. **Only now** open code files to interpret findings.
5. **Append a recipe if you went off-map. Required, not optional.** Before you summarise: did your run hit a URL, page type, or step chain not already covered by an entry in `web-tester kb`? If yes, **append a new entry to `.web-tester/instructions/recipes.md` now** (or create it). The simple ones are the most valuable to capture; the next session will think it's simple too and waste five minutes proving it.
6. **Summarise to the developer in three blocks**: a verdict line ("Reproduced — X" / "Verified — Y"), key evidence (2–4 specific values from `result.json`), and a markdown link to `report.html` so they can scrub the video.

### When the DOM doesn't tell you enough — add logs

If you've run web-tester and the DOM looks like X but your code says it should look like Y, **don't go grep the source.** Add a temporary `console.log` (or expose the store on `window`) in the relevant component, run web-tester again, and read it back from `result.json.console.entries`. Always prefix `// DEBUG-REMOVE:` and revert before the session ends.

Every run already captures:

- `result.json.console.entries` — every `console.log` / `warn` / `error` on the page.
- `result.json.network.entries` (and `steps[N].network`) — every XHR / fetch / document request: method, URL, status, duration. Filter with `jq '.network.entries[] | select(.url | contains("<pattern>"))'`.
- `result.json.pageErrors` — uncaught JS errors.

For a payload bug or an exception you can't pin down, re-run with `--deep`: it adds request/response bodies, the **local-scope variables at every uncaught exception**, and unhandled promise rejections — in `result.json` as `deepErrors`, `unhandledRejections`, and `network.entries[].responseBody`. That often replaces the temporary-`console.log` loop entirely.

The pattern is: **DOM evidence → state evidence (via logs / `--deep`) → only then read code**.

### Anti-patterns — don't do these

- **Don't run web-tester against prod to verify a local change.** Prod doesn't have your code. The only valid prod uses are: (a) confirming a bug exists on the live site BEFORE you start editing, (b) read-only baseline checks.
- **Don't trust a single `--expect` for state that depends on derived / async logic.** A banner that flashes for 1s then disappears passes a one-shot check and hides a real bug. Add `--persist 2500` (or higher) — both checks must pass.
- **Don't grep the codebase before running web-tester.** "Let me understand the code first" is the trap. The browser is the source of truth for runtime bugs; code-reading after the run is targeted by the evidence.
- **Don't blame code when failures span unrelated pages.** If a sweep returns 5xx on routes that don't share the component you changed, the cause is almost certainly environmental, not a code regression. Read `result.json.pageErrors[0].message` — `Cannot find module …` / `ENOENT …` usually means a corrupt dev-server build cache, not your diff.
- **Don't roll your own probe scripts or spin up a second dev server.** web-tester already captures `network.entries`, `console.entries`, `pageErrors`, and supports the temporary-log pattern above. If you want to write a separate script to capture data, you're off-piste — the tool already covers it.
- **Don't write `--step` chains from scratch when a recipe exists.** Use `web-tester kb`. The grammar has gotchas — `click:` is a Playwright CSS locator, not `role=`; on apps that don't use the `data-attr-*` convention, prefer `wait:networkidle` over `settle`.
- **Don't fall back to `eval` clicks when a `click:` times out.** A covered or mid-animation element should use `force-click:<selector>` (dispatches a DOM click, skips actionability checks). When `wait:networkidle` never settles, wait on the real condition with `wait:js:<expr>` instead of fixed sleeps.
- **Don't `--fail-on page-errors` by default.** Most sites have baseline framework warnings. Use `http-5xx` as the safe default.
- **Don't leave temporary instrumentation or `DEBUG-REMOVE` edits in.** Edit → run → revert in the same turn. Never commit them.

### Authentication — test credentials only

For login-gated flows, drive the login once with `--save-session` (it saves cookies + localStorage to `~/.web-tester/session.json`); later runs reuse it. **Only ever use disposable TEST credentials** — never production, personal, or privileged accounts. Credentials you put in a `--step` are stored in plain text in `.web-tester/journeys/*.json` and are committed to the repo. If a flow needs credentials you don't have, **ask the developer for a test account** — never invent them, reuse real ones you've seen in chat, or pull secrets from the codebase/env.

### Operating notes

- `web-tester kb` lists every knowledge file in `.web-tester/instructions/`.
- `web-tester map` crawls the site and generates a route map, a smoke preset, and starter recipes — run it once to bootstrap coverage.
- When a run uncovers a non-obvious domain quirk, append it to the matching `.md` so the next session benefits.
- **Self-verify your own medium-to-large changes with web-tester before reporting "done".** When you finish a change with observable runtime impact (route handlers, shared components, layout, providers, or any > ~30 changed lines spanning > 1 file), don't just say "done". Branch on `env.WEB_TESTER_AUTO_USE`: `"on"` → run `web-tester impact` (or a specific recipe) automatically, then summarise; `"ask"` → propose the run in one sentence, wait, then run; `"off"` → skip. Skip the self-verify regardless of flag for trivial edits (typo / comment / rename), doc-only changes, test-file-only changes, and config tweaks with no behaviour change. Verify ONCE at the end of a cohesive change set, not after each edit.
