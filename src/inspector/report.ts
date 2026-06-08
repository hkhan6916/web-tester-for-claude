import { writeFileSync } from "node:fs";
import type { RunPaths } from "../util/paths";
import type {
  ConsoleEntry,
  NetworkEntry,
  PageErrorEntry
} from "./capture";
import type { InspectResult, StepReport } from "./run";
import type { Expectation } from "./verdict";

function describeExpectationHtml(e: Expectation): string {
  if (e.kind === "text") return `<code>text=${esc(e.text)}</code>`;
  if (e.kind === "no-text") return `<code>no-text=${esc(e.text)}</code>`;
  if (e.kind === "selector") return `<code>selector=${esc(e.selector)}</code>`;
  if (e.kind === "no-selector")
    return `<code>no-selector=${esc(e.selector)}</code>`;
  return `<code>attr ${esc(e.name)}=${esc(e.value)}</code>`;
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function consoleClass(type: string): string {
  if (type === "error") return "log-error";
  if (type === "warning") return "log-warn";
  if (type === "info") return "log-info";
  return "log-log";
}

function networkClass(entry: NetworkEntry): string {
  if (entry.failureText) return "net-fail";
  const status = entry.status ?? 0;
  if (status >= 500) return "net-fail";
  if (status >= 400) return "net-warn";
  return "net-ok";
}

function shortenUrl(url: string, max = 80): string {
  if (url.length <= max) return url;
  const u = new URL(url);
  const path = u.pathname + u.search;
  if (path.length <= max - u.host.length - 3) return `${u.host}${path}`;
  return `${u.host}${path.slice(0, max - u.host.length - 4)}…`;
}

function renderConsole(entries: ConsoleEntry[]): string {
  if (!entries.length) return '<div class="empty">no console output</div>';
  return entries
    .map(
      (e) =>
        `<div class="log-row ${consoleClass(e.type)}">
          <span class="log-type">${esc(e.type)}</span>
          <span class="log-text">${esc(e.text)}</span>
          ${e.location ? `<span class="log-loc">${esc(e.location)}</span>` : ""}
        </div>`
    )
    .join("");
}

function renderNetworkBody(e: NetworkEntry): string {
  const parts: string[] = [];
  if (e.requestBody)
    parts.push(
      `<div class="body-label">request</div><pre class="net-pre">${esc(e.requestBody)}</pre>`
    );
  if (e.responseBody)
    parts.push(
      `<div class="body-label">response</div><pre class="net-pre">${esc(e.responseBody)}</pre>`
    );
  if (!parts.length) return "";
  return `<details class="net-bodies"><summary>body</summary>${parts.join("")}</details>`;
}

function renderNetwork(entries: NetworkEntry[]): string {
  if (!entries.length) return '<div class="empty">no network activity</div>';
  return entries
    .map((e) => {
      const status = e.failureText
        ? esc(e.failureText)
        : e.status !== null
          ? `${e.status}`
          : "—";
      const row = `<div class="net-row ${networkClass(e)}">
        <span class="net-method">${esc(e.method)}</span>
        <span class="net-status">${status}</span>
        <span class="net-url" title="${esc(e.url)}">${esc(shortenUrl(e.url, 90))}</span>
        ${e.durationMs !== null ? `<span class="net-time">${e.durationMs}ms</span>` : ""}
      </div>`;
      const body = renderNetworkBody(e);
      return body ? `<div class="net-entry">${row}${body}</div>` : row;
    })
    .join("");
}

function renderDeepErrors(
  deepErrors: InspectResult["deepErrors"],
  rejections: InspectResult["unhandledRejections"]
): string {
  if (!deepErrors?.length && !rejections?.length) return "";
  const errorBlocks = (deepErrors ?? [])
    .map((e) => {
      const scopes = e.scopes
        .map((s) => {
          const rows = Object.entries(s.vars)
            .map(
              ([k, v]) =>
                `<tr><td>${esc(k)}</td><td><code>${esc(v)}</code></td></tr>`
            )
            .join("");
          return `<div class="scope"><div class="scope-type">${esc(s.type)} scope</div>
            <table class="attrs">${rows}</table></div>`;
        })
        .join("");
      return `<div class="page-error">
        <div class="page-error-msg">${esc(e.reason)}</div>
        <div class="scope-meta">in <code>${esc(e.functionName)}</code>${e.location ? ` · ${esc(e.location)}` : ""}</div>
        ${scopes}
      </div>`;
    })
    .join("");
  const rejectionBlock = rejections?.length
    ? `<h3 style="font-size:11px; color: var(--muted); margin: 12px 0 6px;">unhandled rejections (${rejections.length})</h3>
       ${rejections
         .map((r) => `<div class="page-error"><div class="page-error-msg">${esc(r)}</div></div>`)
         .join("")}`
    : "";
  return `<section class="card">
    <h2>deep errors</h2>
    ${errorBlocks}
    ${rejectionBlock}
  </section>`;
}

function renderPageErrors(errs: PageErrorEntry[]): string {
  if (!errs.length) return "";
  return errs
    .map(
      (e) =>
        `<div class="page-error">
          <div class="page-error-msg">${esc(e.message)}</div>
          ${e.stack ? `<pre class="page-error-stack">${esc(e.stack)}</pre>` : ""}
        </div>`
    )
    .join("");
}

function renderStep(step: StepReport): string {
  const stateClass = step.ok ? "ok" : "fail";
  const screenshot = step.screenshot
    ? `<a class="thumb" href="${esc(step.screenshot)}" data-lightbox>
         <img loading="lazy" src="${esc(step.screenshot)}" alt="step ${step.index}" />
       </a>`
    : '<div class="thumb empty">no screenshot</div>';
  const consoleCount = step.console.length;
  const networkCount = step.network.length;
  const errorCount = step.pageErrors.length;
  const consoleErrorCount = step.console.filter((c) => c.type === "error").length;
  const failedNetCount = step.network.filter(
    (n) => n.failureText !== null || (n.status !== null && n.status >= 400)
  ).length;
  const evalBlock =
    step.evalResult !== undefined
      ? `<details class="step-pane">
           <summary>eval result</summary>
           <pre>${esc(JSON.stringify(step.evalResult, null, 2))}</pre>
         </details>`
      : "";
  const errBlock = step.error
    ? `<div class="step-error">${esc(step.error)}</div>`
    : "";
  return `<article class="step step-${stateClass}" id="step-${step.index}" data-step="${step.index}">
    <header class="step-head">
      <span class="step-index">${step.index}</span>
      <span class="step-state">${step.ok ? "ok" : "fail"}</span>
      <span class="step-label">${esc(step.label)}</span>
      <span class="step-duration">${step.durationMs}ms</span>
    </header>
    <div class="step-url">${esc(step.url)}</div>
    ${errBlock}
    <div class="step-body">
      ${screenshot}
      <div class="step-panes">
        <details class="step-pane" ${consoleErrorCount > 0 ? "open" : ""}>
          <summary>
            console <span class="badge">${consoleCount}</span>
            ${consoleErrorCount > 0 ? `<span class="badge badge-err">${consoleErrorCount} err</span>` : ""}
          </summary>
          <div class="log-list">${renderConsole(step.console)}</div>
        </details>
        <details class="step-pane" ${failedNetCount > 0 ? "open" : ""}>
          <summary>
            network <span class="badge">${networkCount}</span>
            ${failedNetCount > 0 ? `<span class="badge badge-err">${failedNetCount} failed</span>` : ""}
          </summary>
          <div class="net-list">${renderNetwork(step.network)}</div>
        </details>
        ${
          errorCount > 0
            ? `<details class="step-pane" open>
                 <summary>page errors <span class="badge badge-err">${errorCount}</span></summary>
                 <div class="errors-list">${renderPageErrors(step.pageErrors)}</div>
               </details>`
            : ""
        }
        ${evalBlock}
      </div>
    </div>
  </article>`;
}

/**
 * Tiny markdown renderer for the Sonnet summary block. Covers only what the
 * prompt asks for: paragraphs, `- ` bullet lists, `**bold**`, inline `code`.
 * We escape first, then re-introduce the formatting markers, so no raw HTML
 * from the model output ever reaches the page.
 */
function renderSummaryMarkdown(raw: string): string {
  const lines = raw.replace(/\r/g, "").split("\n");
  const blocks: string[] = [];
  let para: string[] = [];
  let bullets: string[] = [];

  const flushPara = (): void => {
    if (!para.length) return;
    blocks.push(`<p>${formatInline(para.join(" "))}</p>`);
    para = [];
  };
  const flushBullets = (): void => {
    if (!bullets.length) return;
    blocks.push(
      `<ul>${bullets.map((b) => `<li>${formatInline(b)}</li>`).join("")}</ul>`
    );
    bullets = [];
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      flushPara();
      flushBullets();
      continue;
    }
    const bullet = trimmed.match(/^[-*]\s+(.*)$/);
    if (bullet?.[1]) {
      flushPara();
      bullets.push(bullet[1]);
      continue;
    }
    flushBullets();
    para.push(trimmed);
  }
  flushPara();
  flushBullets();
  return blocks.join("");
}

function formatInline(text: string): string {
  let out = esc(text);
  out = out.replace(/`([^`]+)`/g, "<code>$1</code>");
  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  return out;
}

function renderAttrs(
  attrs: { name: string; value: string; label: string }[]
): string {
  if (!attrs.length) return '<div class="empty">no data-attr-* markers on page</div>';
  return `<table class="attrs">
    <thead><tr><th>name</th><th>value</th><th>label</th></tr></thead>
    <tbody>
      ${attrs
        .map(
          (a) =>
            `<tr><td>${esc(a.name)}</td><td>${esc(a.value)}</td><td>${esc(a.label)}</td></tr>`
        )
        .join("")}
    </tbody>
  </table>`;
}

const CSS = `
  :root {
    --bg: #fafaf9;
    --surface: #ffffff;
    --border: #e7e5e4;
    --border-strong: #d6d3d1;
    --text: #18181b;
    --muted: #57534e;
    --subtle: #a8a29e;
    --err: #b91c1c;
    --err-bg: #fef2f2;
    --warn: #a16207;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: var(--bg); color: var(--text); }
  body { font: 14px/1.55 -apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", system-ui, sans-serif; -webkit-font-smoothing: antialiased; }
  a { color: var(--text); text-decoration: underline; text-decoration-color: var(--border-strong); text-underline-offset: 2px; }
  a:hover { text-decoration-color: var(--text); }
  code, .mono { font: 12px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; }
  code { background: var(--bg); padding: 1px 5px; border-radius: 3px; border: 1px solid var(--border); }
  pre { font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; background: var(--bg); color: var(--text); padding: 10px 12px; border-radius: 4px; border: 1px solid var(--border); overflow: auto; margin: 6px 0 0; max-height: 360px; }
  details summary { cursor: pointer; user-select: none; }
  details summary::-webkit-details-marker { display: none; }
  details summary::before { content: "›"; display: inline-block; width: 1em; color: var(--subtle); transition: transform 0.1s; font-weight: 600; }
  details[open] > summary::before { transform: rotate(90deg); }

  .layout { display: grid; grid-template-columns: minmax(0, 1fr); max-width: 1240px; margin: 0 auto; padding: 28px 24px; gap: 24px; }
  @media (min-width: 1100px) { .layout { grid-template-columns: 340px minmax(0, 1fr); } }

  header.top { grid-column: 1 / -1; display: flex; flex-direction: column; gap: 10px; padding-bottom: 18px; border-bottom: 1px solid var(--border); margin-bottom: 4px; }
  header.top h1 { font-size: 20px; font-weight: 600; margin: 0; letter-spacing: -0.01em; line-height: 1.3; }
  header.top h1 .verdict { font-size: 12px; font-weight: 500; color: var(--muted); margin-left: 8px; }
  header.top h1 .verdict-fail { color: var(--err); }
  .meta { color: var(--muted); font-size: 12px; }
  .meta code { background: transparent; border: 0; padding: 0; color: var(--text); }
  .meta .sep { color: var(--subtle); margin: 0 4px; }

  .totals { display: flex; flex-wrap: wrap; gap: 18px; margin-top: 6px; font-size: 13px; }
  .totals .stat { color: var(--muted); }
  .totals .stat strong { color: var(--text); font-weight: 600; font-variant-numeric: tabular-nums; }
  .totals .stat-err strong { color: var(--err); }

  .side { position: sticky; top: 20px; align-self: start; display: flex; flex-direction: column; gap: 14px; max-height: calc(100vh - 40px); overflow-y: auto; }
  .video-card { background: var(--surface); border: 1px solid var(--border); border-radius: 6px; padding: 10px; }
  .video-card video { width: 100%; border-radius: 3px; background: #000; display: block; }
  .video-controls { display: flex; align-items: center; gap: 4px; margin-top: 8px; font-size: 11px; color: var(--muted); flex-wrap: wrap; }
  .video-controls button { padding: 2px 8px; border: 1px solid var(--border); background: var(--surface); color: var(--muted); border-radius: 3px; cursor: pointer; font: inherit; font-size: 11px; font-variant-numeric: tabular-nums; }
  .video-controls button:hover { color: var(--text); border-color: var(--border-strong); }
  .video-controls button.active { background: var(--text); color: var(--surface); border-color: var(--text); }

  .timeline { background: var(--surface); border: 1px solid var(--border); border-radius: 6px; padding: 8px 4px; }
  .timeline h3 { font-size: 11px; font-weight: 600; color: var(--muted); margin: 4px 8px 4px; letter-spacing: 0; }
  .timeline a { display: flex; gap: 8px; padding: 5px 8px; border-radius: 3px; color: var(--text); font-size: 12px; align-items: center; text-decoration: none; }
  .timeline a:hover { background: var(--bg); }
  .timeline a.fail { color: var(--err); }
  .timeline a .idx { color: var(--subtle); width: 1.5em; text-align: right; font-variant-numeric: tabular-nums; }
  .timeline a .lbl { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .timeline a .ms { color: var(--subtle); font-size: 11px; font-variant-numeric: tabular-nums; }

  .main { display: flex; flex-direction: column; gap: 14px; min-width: 0; }
  .summary-card { background: var(--surface); border: 1px solid var(--border); border-left: 3px solid var(--text); border-radius: 6px; padding: 16px 18px; }
  .summary-card .summary-tag { font-size: 11px; font-weight: 600; color: var(--muted); margin: 0 0 8px; letter-spacing: 0.02em; text-transform: uppercase; display: flex; align-items: center; gap: 6px; }
  .summary-card .summary-tag::before { content: "✱"; color: var(--subtle); }
  .summary-card .summary-body { font-size: 14px; line-height: 1.6; color: var(--text); }
  .summary-card .summary-body p { margin: 0 0 8px; }
  .summary-card .summary-body p:last-child { margin-bottom: 0; }
  .summary-card .summary-body strong { font-weight: 600; }
  .summary-card .summary-body ul { margin: 4px 0 8px; padding-left: 20px; }
  .summary-card .summary-body li { margin: 2px 0; }
  .summary-card .summary-body code { background: var(--bg); }
  .card { background: var(--surface); border: 1px solid var(--border); border-radius: 6px; padding: 16px 18px; }
  .card h2 { font-size: 12px; font-weight: 600; color: var(--muted); margin: 0 0 12px; letter-spacing: 0.02em; text-transform: uppercase; }
  .urls { font-size: 13px; color: var(--text); display: grid; grid-template-columns: max-content 1fr; gap: 6px 14px; }
  .urls dt { color: var(--muted); font-size: 12px; }
  .urls dd { margin: 0; word-break: break-all; }

  .snapshot-pair { display: grid; grid-template-columns: 1fr; gap: 12px; }
  @media (min-width: 700px) { .snapshot-pair { grid-template-columns: 1fr 1fr; } }
  .snapshot h3 { font-size: 11px; font-weight: 600; color: var(--muted); margin: 0 0 6px; }
  .snapshot img { width: 100%; border-radius: 3px; border: 1px solid var(--border); cursor: zoom-in; display: block; }

  .step { background: var(--surface); border: 1px solid var(--border); border-radius: 6px; padding: 14px 16px; scroll-margin-top: 12px; }
  .step-fail { border-color: var(--err); background: var(--err-bg); }
  .step-head { display: flex; align-items: baseline; gap: 10px; }
  .step-index { color: var(--subtle); font-size: 12px; font-weight: 500; font-variant-numeric: tabular-nums; min-width: 1.5em; }
  .step-state { display: none; }
  .step-fail .step-state { display: inline; font-size: 11px; font-weight: 600; color: var(--err); text-transform: uppercase; letter-spacing: 0.04em; }
  .step-label { font-weight: 500; flex: 1; min-width: 0; overflow-wrap: break-word; }
  .step-duration { color: var(--subtle); font-size: 11px; font-variant-numeric: tabular-nums; }
  .step-url { color: var(--muted); font-size: 11px; margin: 6px 0 0; word-break: break-all; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  .step-error { color: var(--err); padding: 8px 10px; margin: 8px 0 0; border: 1px solid var(--err); background: var(--surface); border-radius: 3px; font: 12px/1.5 ui-monospace, monospace; }

  .step-body { display: grid; grid-template-columns: 1fr; gap: 14px; margin-top: 12px; }
  @media (min-width: 800px) { .step-body { grid-template-columns: 220px minmax(0, 1fr); } }
  .thumb { display: block; }
  .thumb img { width: 100%; border-radius: 3px; border: 1px solid var(--border); cursor: zoom-in; display: block; background: #000; }
  .thumb.empty { background: var(--bg); color: var(--subtle); padding: 30px; border-radius: 3px; border: 1px dashed var(--border); text-align: center; font-style: italic; font-size: 12px; }

  .step-panes { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
  .step-pane summary { font-size: 12px; padding: 4px 0; color: var(--muted); display: flex; align-items: center; gap: 6px; }
  .step-pane .badge { color: var(--muted); padding: 0 4px; font-size: 11px; font-variant-numeric: tabular-nums; }
  .step-pane .badge-err { color: var(--err); font-weight: 600; }
  .step-pane[open] > summary { color: var(--text); }

  .log-list, .net-list { background: var(--bg); border: 1px solid var(--border); border-radius: 3px; padding: 6px; max-height: 280px; overflow: auto; font: 11px/1.5 ui-monospace, monospace; }
  .log-row { display: grid; grid-template-columns: 60px 1fr; gap: 8px; padding: 2px 4px; border-radius: 2px; }
  .log-row .log-type { color: var(--subtle); font-weight: 600; text-transform: lowercase; }
  .log-row.log-error .log-type { color: var(--err); }
  .log-row.log-warn .log-type { color: var(--warn); }
  .log-row .log-loc { grid-column: 2; color: var(--subtle); font-size: 10px; }
  .log-text { word-break: break-word; color: var(--text); }

  .net-row { display: grid; grid-template-columns: 50px 60px 1fr 60px; gap: 8px; padding: 2px 4px; border-radius: 2px; align-items: center; }
  .net-row .net-method { color: var(--muted); font-weight: 600; }
  .net-row .net-status { font-weight: 600; color: var(--text); font-variant-numeric: tabular-nums; }
  .net-row.net-warn .net-status { color: var(--warn); }
  .net-row.net-fail .net-status { color: var(--err); }
  .net-row .net-url { color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .net-row .net-time { color: var(--subtle); font-size: 10px; text-align: right; font-variant-numeric: tabular-nums; }
  .net-entry { display: flex; flex-direction: column; }
  .net-bodies { margin: 0 0 4px 6px; }
  .net-bodies summary { font-size: 11px; color: var(--subtle); padding: 2px 0; }
  .net-bodies .body-label { font-size: 10px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--subtle); margin: 6px 0 2px; }
  .net-pre { max-height: 220px; margin: 0; }

  .page-error { border-left: 2px solid var(--err); padding: 6px 10px; margin: 6px 0; background: var(--err-bg); border-radius: 0 3px 3px 0; }
  .page-error-msg { color: var(--err); font-weight: 500; }
  .page-error-stack { background: var(--surface); border: 1px solid var(--border); color: var(--text); margin-top: 6px; font-size: 10px; max-height: 200px; }
  .scope-meta { color: var(--muted); font-size: 11px; margin: 4px 0 6px; }
  .scope { margin: 6px 0 0; }
  .scope-type { font-size: 10px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--muted); margin: 6px 0 2px; }
  .scope .attrs code { background: var(--bg); }

  .attrs { width: 100%; border-collapse: collapse; font-size: 12px; }
  .attrs th, .attrs td { padding: 4px 8px; border-bottom: 1px solid var(--border); text-align: left; }
  .attrs th { color: var(--muted); font-weight: 600; font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; }
  .empty { color: var(--muted); font-style: italic; padding: 6px 0; font-size: 12px; }

  .global-logs { display: grid; grid-template-columns: 1fr; gap: 12px; }
  @media (min-width: 800px) { .global-logs { grid-template-columns: 1fr 1fr; } }

  .verdict-card { border-left: 3px solid #15803d; }
  .verdict-card-fail { border-left-color: var(--err); background: var(--err-bg); }
  .verdict-card h2 { display: flex; align-items: center; gap: 8px; }
  .verdict-card .vd-ok { color: #15803d; font-weight: 700; text-transform: uppercase; font-size: 11px; letter-spacing: 0.04em; }
  .verdict-card .vd-fail { color: var(--err); font-weight: 700; text-transform: uppercase; font-size: 11px; letter-spacing: 0.04em; }
  .verdict-triggers { margin: 0 0 10px; padding-left: 18px; color: var(--err); font-size: 13px; }

  /* Lightbox */
  #lightbox { position: fixed; inset: 0; background: rgba(0,0,0,0.85); display: none; align-items: center; justify-content: center; z-index: 1000; cursor: zoom-out; padding: 24px; }
  #lightbox.open { display: flex; }
  #lightbox img { max-width: 100%; max-height: 100%; border-radius: 4px; }
`;

const JS = `
  // Lightbox
  const lb = document.getElementById('lightbox');
  const lbImg = lb.querySelector('img');
  document.querySelectorAll('[data-lightbox], .snapshot img').forEach((el) => {
    const handler = (e) => {
      e.preventDefault();
      const src = el.tagName === 'A' ? el.getAttribute('href') : el.getAttribute('src');
      lbImg.src = src;
      lb.classList.add('open');
    };
    el.addEventListener('click', handler);
  });
  lb.addEventListener('click', () => { lb.classList.remove('open'); lbImg.src = ''; });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { lb.classList.remove('open'); lbImg.src = ''; } });

  // Video speed control
  const video = document.querySelector('.video-card video');
  if (video) {
    const RATES = [0.5, 1, 1.5, 2.5, 4];
    const DEFAULT_RATE = 2.5;
    const setRate = (rate) => {
      video.playbackRate = rate;
      document.querySelectorAll('.video-controls .rate').forEach((b) => {
        b.classList.toggle('active', Number(b.dataset.rate) === rate);
      });
    };
    video.addEventListener('loadedmetadata', () => setRate(DEFAULT_RATE));
    video.addEventListener('play', () => { video.playbackRate = video.playbackRate || DEFAULT_RATE; }, { once: true });
    document.querySelectorAll('.video-controls .rate').forEach((b) => {
      b.addEventListener('click', () => setRate(Number(b.dataset.rate)));
    });
  }
`;

export function writeReport(result: InspectResult, paths: RunPaths): void {
  writeFileSync(paths.resultPath, JSON.stringify(result, null, 2));

  const hasGate =
    result.expectations.length > 0 || result.failOn.length > 0;
  const verdictText = result.ok
    ? hasGate
      ? "pass"
      : "completed"
    : "fail";
  const verdictClass = result.ok ? "" : "verdict-fail";

  const verdictBlock =
    result.verdictTriggers.length > 0 || result.expectations.length > 0
      ? `<section class="card verdict-card ${result.ok ? "" : "verdict-card-fail"}">
           <h2>verdict ${result.ok ? "<span class=\"vd-ok\">pass</span>" : "<span class=\"vd-fail\">fail</span>"}</h2>
           ${
             result.verdictTriggers.length > 0
               ? `<ul class="verdict-triggers">${result.verdictTriggers
                   .map((t) => `<li>${esc(t)}</li>`)
                   .join("")}</ul>`
               : ""
           }
           ${
             result.expectations.length > 0
               ? `<table class="attrs">
                    <thead><tr><th>expect</th><th>result</th><th>detail</th></tr></thead>
                    <tbody>${result.expectations
                      .map((r) => {
                        const desc = describeExpectationHtml(r.expectation);
                        return `<tr><td>${desc}</td><td>${r.ok ? "<span class=\"vd-ok\">pass</span>" : "<span class=\"vd-fail\">fail</span>"}</td><td>${esc(r.detail ?? "")}</td></tr>`;
                      })
                      .join("")}</tbody>
                  </table>`
               : ""
           }
         </section>`
      : "";
  const consoleErr = result.console.totals.error ?? 0;
  const consoleWarn = result.console.totals.warning ?? 0;

  const rates = [0.5, 1, 1.5, 2.5, 4];
  const videoBlock = result.video
    ? `<aside class="video-card">
         <video controls preload="metadata" src="${esc(result.video)}"></video>
         <div class="video-controls">
           <span>speed</span>
           ${rates.map((r) => `<button class="rate" data-rate="${r}">${r}x</button>`).join("")}
         </div>
       </aside>`
    : "";

  const timeline = result.steps.length
    ? `<nav class="timeline">
         <h3>steps</h3>
         ${result.steps
           .map(
             (s) => `<a href="#step-${s.index}" class="${s.ok ? "" : "fail"}">
                <span class="dot"></span>
                <span class="idx">${s.index}</span>
                <span class="lbl">${esc(s.label)}</span>
                <span class="ms">${s.durationMs}ms</span>
              </a>`
           )
           .join("")}
       </nav>`
    : "";

  const html = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>web-tester · ${esc(result.requestedUrl)}</title>
<style>${CSS}</style>
</head><body>
<div class="layout">
  <header class="top">
    <h1>
      ${esc(result.title || result.requestedUrl)}
      <span class="verdict ${verdictClass}">${verdictText}</span>
    </h1>
    <div class="meta">
      <code>${esc(result.runId)}</code><span class="sep">·</span>
      <code>${esc(result.baseUrl)}</code><span class="sep">·</span>
      ${esc(result.startedAt)}<span class="sep">·</span>
      ${result.durationMs}ms
    </div>
    <div class="totals">
      <div class="stat"><strong>${result.steps.length}</strong> steps</div>
      <div class="stat ${result.failedSteps > 0 ? "stat-err" : ""}"><strong>${result.failedSteps}</strong> failed</div>
      <div class="stat"><strong>${result.network.count}</strong> network</div>
      <div class="stat ${result.network.failedCount > 0 ? "stat-err" : ""}"><strong>${result.network.failedCount}</strong> 4xx</div>
      <div class="stat ${consoleErr > 0 ? "stat-err" : ""}"><strong>${consoleErr}</strong> console errors</div>
      <div class="stat"><strong>${consoleWarn}</strong> warnings</div>
      <div class="stat ${result.pageErrors.length > 0 ? "stat-err" : ""}"><strong>${result.pageErrors.length}</strong> page errors</div>
    </div>
  </header>

  <div class="side">
    ${videoBlock}
    ${timeline}
  </div>

  <div class="main">
    ${verdictBlock}
    ${
      result.summary
        ? `<section class="summary-card">
             <div class="summary-tag">summary</div>
             <div class="summary-body">${renderSummaryMarkdown(result.summary)}</div>
           </section>`
        : ""
    }
    <section class="card">
      <h2>URLs</h2>
      <dl class="urls">
        <dt>requested</dt><dd><a href="${esc(result.requestedUrl)}" target="_blank">${esc(result.requestedUrl)}</a></dd>
        <dt>final</dt><dd><a href="${esc(result.finalUrl)}" target="_blank">${esc(result.finalUrl)}</a></dd>
      </dl>
    </section>

    <section class="card">
      <h2>snapshots</h2>
      <div class="snapshot-pair">
        <div class="snapshot">
          <h3>initial</h3>
          <img src="${esc(result.initial.screenshot)}" alt="initial" />
        </div>
        <div class="snapshot">
          <h3>final</h3>
          <img src="${esc(result.final.screenshot)}" alt="final" />
        </div>
      </div>
      <details style="margin-top: 12px;">
        <summary>data-attr-* (initial / final)</summary>
        <div class="snapshot-pair" style="margin-top: 8px;">
          <div>
            <h3 style="font-size:11px; color: var(--muted); margin: 0 0 4px;">initial (${result.initial.attrs.length})</h3>
            ${renderAttrs(result.initial.attrs)}
          </div>
          <div>
            <h3 style="font-size:11px; color: var(--muted); margin: 0 0 4px;">final (${result.final.attrs.length})</h3>
            ${renderAttrs(result.final.attrs)}
          </div>
        </div>
      </details>
    </section>

    ${
      result.steps.length
        ? `<section class="card">
             <h2>steps</h2>
             <div class="step-list" style="display: flex; flex-direction: column; gap: 12px;">
               ${result.steps.map(renderStep).join("")}
             </div>
           </section>`
        : ""
    }

    ${
      result.pageErrors.length
        ? `<section class="card">
             <h2>page errors</h2>
             ${renderPageErrors(result.pageErrors)}
           </section>`
        : ""
    }

    ${renderDeepErrors(result.deepErrors, result.unhandledRejections)}

    <section class="card">
      <h2>global logs</h2>
      <div class="global-logs">
        <details>
          <summary>console (${result.console.entries.length})</summary>
          <div class="log-list" style="max-height: 480px;">${renderConsole(result.console.entries)}</div>
        </details>
        <details>
          <summary>network (${result.network.entries.length})</summary>
          <div class="net-list" style="max-height: 480px;">${renderNetwork(result.network.entries)}</div>
        </details>
      </div>
    </section>
  </div>
</div>

<div id="lightbox"><img alt="" /></div>
<script>${JS}</script>
</body></html>`;

  writeFileSync(paths.reportHtmlPath, html);
}
