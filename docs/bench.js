// Reproducible benchmark behind the "Why a CLI, and not an MCP server?" section
// of the README. Measures the per-step payload Playwright MCP returns into the
// conversation (its accessibility snapshot) and compares it to what web-tester's
// CLI returns for the identical task.
//
// We reproduce MCP's snapshot with Playwright's own ariaSnapshot() on the same
// live pages. This UNDER-counts MCP: the real server also attaches a [ref=…]
// handle to every node, which we omit — so the gap in practice is larger.
//
// Run:  node docs/bench.js     (from the repo root, so `playwright` resolves)
//
// For the web-tester side, run these and compare the printed summary length:
//
//   WEB_TESTER_BASE_URL=https://demo.playwright.dev \
//     npx web-tester-for-claude inspect /todomvc/ --quick \
//       --step "fill:.new-todo=Buy milk"   --step "press:.new-todo=Enter" \
//       --step "fill:.new-todo=Walk dog"   --step "press:.new-todo=Enter" \
//       --step "fill:.new-todo=Write tests" --step "press:.new-todo=Enter" \
//       --step "click:.todo-list li .toggle" --step "click:text=Active" \
//       --expect "selector=.todo-list li" --fail-on http-5xx
//
//   WEB_TESTER_BASE_URL=https://news.ycombinator.com \
//     npx web-tester-for-claude inspect / --quick \
//       --expect "selector=.athing" --expect "selector=.titleline" --fail-on http-5xx
//
// One web-tester run = ONE model round-trip (one bash call) regardless of step
// count; an MCP flow is one round-trip per action, each returning a snapshot.

const { chromium } = require("playwright");
const estTokens = (chars) => Math.round(chars / 4);

async function snap(page, label, snaps) {
  const aria = await page.locator("body").ariaSnapshot().catch(() => "");
  snaps.push({ label, chars: aria.length });
}

async function todomvc() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const snaps = [];
  await page.goto("https://demo.playwright.dev/todomvc/", { waitUntil: "domcontentloaded" });
  await snap(page, "navigate (empty list)", snaps);
  const input = page.locator(".new-todo");
  for (const todo of ["Buy milk", "Walk dog", "Write tests"]) {
    await input.fill(todo);
    await input.press("Enter");
    await snap(page, `add "${todo}"`, snaps);
  }
  await page.locator(".todo-list li .toggle").first().click();
  await snap(page, "complete first", snaps);
  await page.getByRole("link", { name: "Active" }).click();
  await snap(page, "filter: Active", snaps);
  await browser.close();
  return { page: "TodoMVC (add 3, complete 1, filter)", snaps };
}

async function hn() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const snaps = [];
  await page.goto("https://news.ycombinator.com/", { waitUntil: "domcontentloaded" });
  await snap(page, "navigate (front page)", snaps);
  await browser.close();
  return { page: "Hacker News front page (verify renders)", snaps };
}

(async () => {
  for (const r of [await todomvc(), await hn()]) {
    const chars = r.snaps.reduce((a, s) => a + s.chars, 0);
    console.log(`\n${r.page}`);
    for (const s of r.snaps) console.log(`   ${s.label.padEnd(26)}${String(s.chars).padStart(7)} chars`);
    console.log(`   ${"TOTAL into context".padEnd(26)}${String(chars).padStart(7)} chars  ~${estTokens(chars)} tokens  (${r.snaps.length} MCP round-trips)`);
  }
})();
