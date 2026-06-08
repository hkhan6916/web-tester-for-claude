// Generates the two comparison charts in the README from the measured
// benchmark numbers (docs/bench.js) and published Claude token prices.
// Run:  node docs/make-charts.js
const fs = require("fs");
const path = require("path");

// Measured token I/O per task. input = tokens that enter the model's context
// (measured); output = a modest per-round-trip estimate stated in the README.
const TASKS = [
  { name: "TodoMVC: add 3 todos, complete one, filter", mcp: { in: 1243, out: 600, rt: 6 }, wt: { in: 304, out: 150, rt: 1 } },
  { name: "Hacker News front page: verify it renders", mcp: { in: 10091, out: 100, rt: 1 }, wt: { in: 216, out: 150, rt: 1 } }
];

// Claude Sonnet 4.6 list price, dollars per 1M tokens.
const PRICE = { in: 3, out: 15 };
const cost = (t) => (t.in * PRICE.in + t.out * PRICE.out) / 1e6;

const C = { bg: "#fafaf9", text: "#1c1917", muted: "#78716c", faint: "#a8a29e", grid: "#e7e5e4", mcp: "#c2660c", wt: "#15803d" };
const FONT = `-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, system-ui, sans-serif`;
const commas = (n) => n.toLocaleString("en-US");

function doc(w, h, body) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" font-family='${FONT}'>
<style>
 .title{font-size:16px;font-weight:700;fill:${C.text}} .sub{font-size:12px;fill:${C.muted}}
 .task{font-size:13.5px;font-weight:600;fill:${C.text}} .side{font-size:12px;fill:${C.muted}}
 .val{font-size:12px;fill:${C.muted};font-variant-numeric:tabular-nums} .ax{font-size:11px;fill:${C.faint};font-variant-numeric:tabular-nums}
 .grid{stroke:${C.grid};stroke-width:1} .leg{font-size:12px;fill:${C.muted}} .end{font-weight:700;font-size:13px}
</style>
<rect width="${w}" height="${h}" rx="10" fill="${C.bg}"/>${body}</svg>`;
}

function legend(x, y) {
  return `<rect x="${x}" y="${y - 10}" width="12" height="12" rx="3" fill="${C.mcp}"/><text x="${x + 18}" y="${y}" class="leg">Playwright MCP</text>
<rect x="${x + 140}" y="${y - 10}" width="12" height="12" rx="3" fill="${C.wt}"/><text x="${x + 158}" y="${y}" class="leg">web-tester</text>`;
}

// ---- Chart 1: tokens into context (grouped horizontal bars, per-row scale) ----
function tokensChart() {
  const W = 960, bx = 168, maxBar = 470, barH = 26, gap = 12, top = 116, rowH = 108;
  const H = top + TASKS.length * rowH - 18;
  const p = [
    `<text x="28" y="34" class="title">Tokens read to finish the same task</text>`,
    `<text x="28" y="54" class="sub">Lower is better. Measured on two real pages.</text>`,
    legend(28, 80)
  ];
  let y = top;
  for (const t of TASKS) {
    const max = Math.max(t.mcp.in, t.wt.in);
    const w = (v) => Math.max(4, Math.round((v / max) * maxBar));
    const mid = (by) => by + barH / 2 + 4;
    p.push(`<text x="28" y="${y}" class="task">${t.name}</text>`);
    const y1 = y + 12, y2 = y1 + barH + gap;
    p.push(`<text x="${bx - 12}" y="${mid(y1)}" class="side" text-anchor="end">MCP</text>`);
    p.push(`<rect x="${bx}" y="${y1}" width="${w(t.mcp.in)}" height="${barH}" rx="5" fill="${C.mcp}"/>`);
    p.push(`<text x="${bx + w(t.mcp.in) + 12}" y="${mid(y1)}" class="val">${commas(t.mcp.in)} tokens, ${t.mcp.rt} round-trip${t.mcp.rt > 1 ? "s" : ""}</text>`);
    p.push(`<text x="${bx - 12}" y="${mid(y2)}" class="side" text-anchor="end" style="fill:${C.wt};font-weight:600">web-tester</text>`);
    p.push(`<rect x="${bx}" y="${y2}" width="${w(t.wt.in)}" height="${barH}" rx="5" fill="${C.wt}"/>`);
    p.push(`<text x="${bx + w(t.wt.in) + 12}" y="${mid(y2)}" class="val" style="fill:${C.wt}">${commas(t.wt.in)} tokens, ${t.wt.rt} round-trip</text>`);
    y += rowH;
  }
  return doc(W, H, p.join("\n"));
}

// ---- Chart 2: cumulative cost over 5 reruns (line chart) ----
function costChart() {
  const N = 5, t = TASKS[0];
  const mcpRun = cost(t.mcp), wtFresh = cost(t.wt), wtRerun = cost({ in: 318, out: 80 });
  const mcp = [], wt = [];
  let m = 0, w = 0;
  for (let i = 1; i <= N; i++) { m += mcpRun; mcp.push(m); w += i === 1 ? wtFresh : wtRerun; wt.push(w); }

  // Axis max = next $0.02 step strictly above the data, so the top line is the
  // labelled top gridline and nothing draws above it.
  const step = 0.02;
  const ymax = (Math.floor(mcp[N - 1] / step) + 1) * step;

  const W = 860, H = 360, L = 66, R = 196, T = 100, B = 56;
  const pw = W - L - R, ph = H - T - B;
  const X = (i) => L + (i / (N - 1)) * pw;
  const Y = (v) => T + (1 - v / ymax) * ph;
  const line = (a, col) => `<polyline points="${a.map((v, i) => `${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join(" ")}" fill="none" stroke="${col}" stroke-width="2.5" stroke-linejoin="round"/>`;
  const dots = (a, col) => a.map((v, i) => `<circle cx="${X(i).toFixed(1)}" cy="${Y(v).toFixed(1)}" r="3.5" fill="${col}"/>`).join("");

  let grid = "";
  for (let g = 0; g <= ymax + 1e-9; g += step) {
    const yy = Y(g).toFixed(1);
    grid += `<line x1="${L}" y1="${yy}" x2="${L + pw}" y2="${yy}" class="grid"/><text x="${L - 12}" y="${(+yy + 4).toFixed(1)}" class="ax" text-anchor="end">$${g.toFixed(2)}</text>`;
  }
  const xl = Array.from({ length: N }, (_, i) => `<text x="${X(i).toFixed(1)}" y="${H - 28}" class="ax" text-anchor="middle">Run ${i + 1}</text>`).join("");
  const ex = (X(N - 1) + 12).toFixed(1);

  return doc(W, H, [
    `<text x="28" y="34" class="title">Cost of running the same task five times</text>`,
    `<text x="28" y="54" class="sub">Running total at Claude Sonnet 4.6 prices. Lower is better.</text>`,
    legend(28, 80),
    grid,
    line(mcp, C.mcp), line(wt, C.wt), dots(mcp, C.mcp), dots(wt, C.wt), xl,
    `<text x="${ex}" y="${(Y(mcp[N - 1]) + 4).toFixed(1)}" class="end" fill="${C.mcp}">$${mcp[N - 1].toFixed(3)}</text>`,
    `<text x="${ex}" y="${(Y(mcp[N - 1]) + 20).toFixed(1)}" class="leg" fill="${C.mcp}">Playwright MCP, ${t.mcp.rt * N} round-trips</text>`,
    `<text x="${ex}" y="${(Y(wt[N - 1]) - 8).toFixed(1)}" class="end" fill="${C.wt}">$${wt[N - 1].toFixed(3)}</text>`,
    `<text x="${ex}" y="${(Y(wt[N - 1]) + 8).toFixed(1)}" class="leg" fill="${C.wt}">web-tester, ${N} round-trips</text>`
  ].join("\n"));
}

fs.writeFileSync(path.join(__dirname, "mcp-comparison.svg"), tokensChart());
fs.writeFileSync(path.join(__dirname, "mcp-cost.svg"), costChart());
console.log("wrote mcp-comparison.svg, mcp-cost.svg");
for (const t of TASKS) console.log(`  ${t.name}: MCP $${cost(t.mcp).toFixed(4)} vs web-tester $${cost(t.wt).toFixed(4)}  (${(cost(t.mcp) / cost(t.wt)).toFixed(1)}x)`);
