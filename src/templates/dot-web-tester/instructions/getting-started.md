# Getting started with web-tester in this project

This file is part of the `.web-tester/instructions/` knowledge base. Anything
in here is browseable with:

```bash
web-tester kb              # list topics
web-tester kb <topic>      # print one
```

Your AI agent reads these files in fresh sessions instead of grepping your
source to re-derive project knowledge. Keep them short and concrete.

## The unit of work — recipes

A "recipe" is a tested copy-paste `web-tester inspect …` one-liner for a
specific page type or flow. See [`recipes.md`](recipes.md) for the format.
Append new recipes whenever you run against an uncovered area.

## What goes in here

- `recipes.md` — copy-paste one-liners (the cookbook).
- `architecture.md` — short notes on app structure that matter at runtime
  (e.g. "the app store is exposed on `window.__store` in dev").
- `<feature>.md` — domain quirks worth remembering (e.g. "the pricing table
  takes ~3s to settle on cold loads — use `--persist 3000` for any pricing
  assertion").
- `auth.md` — how to drive sign-in, where the session lives, what test
  credentials to use.

Avoid:

- General code documentation — that belongs in source comments / READMEs.
- Anything that rots fast (specific commit refs, "the bug from last week").
- Anything secret (real credentials, API keys).

## Configuring the runner

Defaults come from `.env` or shell vars:

| Var | Default | Purpose |
|---|---|---|
| `WEB_TESTER_BASE_URL` | `http://localhost:3000` | Bare paths resolve against this. |
| `GOTO_TIMEOUT_MS` | `30000` | Initial navigation timeout. |
| `STEP_TIMEOUT_MS` | `15000` | Per-step action timeout. |
| `SETTLE_TIMEOUT_MS` | `30000` | `settle` step ceiling. |

Override per-run via env:

```bash
WEB_TESTER_BASE_URL=https://staging.example.com \
  web-tester inspect /pricing --quick
```

## Gotchas worth knowing

A few things that cost people time. Reach for these before writing `eval`
workarounds.

- **A `click:` keeps timing out.** The element is probably covered by an
  overlay, mid-animation, or otherwise "not actionable" to Playwright. Use
  `force-click:<selector>` instead. It dispatches a DOM click straight at the
  element (like `el.click()`), skipping the actionability and overlay checks.
  If a selector matches several elements and the first is the wrong one, target
  a specific match with `click:nth=<n>:<selector>` (0-based).
- **`wait:networkidle` never settles.** Sites with long-lived connections
  (websockets, polling, analytics keep-alives) never reach network idle, so the
  step burns the whole timeout. Wait on the actual condition instead:
  `wait:js:<expr>` polls a JS expression until it is truthy, e.g.
  `wait:js:window.__store.getState().price != null`. It beats both `networkidle`
  and fixed `wait:<ms>` sleeps.
- **An analytics or tracking POST is missing from `network.entries`.**
  `navigator.sendBeacon()` and batched senders (Segment and similar) don't show
  up in the captured network log. Run with `--deep` to capture request and
  response bodies, or log the payload in the page and read it back from
  `console.entries`.

## Sibling files in `.web-tester/`

- `impact-rules.json` — diff-aware rules for `web-tester impact`.
- `urls-<name>.txt` — URL presets for `web-tester sweep --preset <name>`.
- `journeys/<name>.json` — saved flows for `web-tester journey <name>`.

See the package README for the full schema of each. Run `web-tester map` to
auto-discover routes and generate a starter preset + recipes.
