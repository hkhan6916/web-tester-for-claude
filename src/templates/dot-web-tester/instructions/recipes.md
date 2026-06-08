# Recipes

Copy-paste one-liners for common web-tester runs. Add new entries as you
discover new flows so future sessions don't re-derive the step grammar.

## Format

Each recipe has:

- A **title** (one line, action-oriented: "Verify the contact form submits")
- A **when** clause (one line — the trigger that should pull this recipe)
- A **command** block — the exact shell line, ready to copy
- An **expected outcome** line — what "pass" looks like

## Template

```
### <title>

**When:** <one-line trigger>

**Command:**

```bash
web-tester inspect "<path>" \
  --step settle --quick \
  --expect "<assertion>" \
  --fail-on http-5xx
```

**Expected:** <one line — what verdict / evidence proves the run worked>
```

---

## Built-in starters

### Smoke-check the homepage

**When:** "is the site up?" / "did my change break the homepage?"

**Command:**

```bash
web-tester inspect / \
  --step wait:networkidle --quick \
  --expect "selector=header" \
  --expect "selector=footer" \
  --expect "selector=main" \
  --fail-on http-5xx
```

**Expected:** verdict: pass, all three selectors visible.

### Verify a form submits and lands on a thank-you page

**When:** "did my form change still work?"

**Command:**

```bash
web-tester inspect "/contact" \
  --step "wait:networkidle" \
  --step "fill:input[name=email]=test@example.com" \
  --step "fill:textarea[name=message]=hello from web-tester" \
  --step "click:button[type=submit]" \
  --step "wait:url-contains:/thanks@10000" \
  --quick \
  --expect "text=Thanks" \
  --fail-on http-5xx
```

**Expected:** URL transitions to `/thanks`, "Thanks" text visible.

### Sweep your smoke URL list against localhost

**When:** structural change (layout / header / shared component) — broad regression check.

**Command:**

```bash
web-tester sweep --preset smoke --fail-on http-5xx
```

**Expected:** every URL reports ok in the sweep summary; the HTML report opens to a green table.

### Diff-aware advisory run

**When:** about to push — "what might my diff have broken?"

**Command:**

```bash
web-tester impact
```

**Expected:** plan prints matching rules, then advisory findings (or "nothing flagged"). Exits 0 either way.

---

## Project-specific recipes

<!-- Add your project's recipes below. Copy the template above, fill it in,
     point the URL at whatever you're testing. `web-tester map` can generate
     a starter set of these for you. -->
