import type { PageType, RouteGroup } from "./classify";

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

export type MapReportData = {
  baseUrl: string;
  startedAt: string;
  durationMs: number;
  pageCount: number;
  groups: RouteGroup[];
};

const TYPE_COLOR: Record<PageType, string> = {
  home: "#1d4ed8",
  list: "#0e7490",
  detail: "#7c3aed",
  form: "#b45309",
  auth: "#be123c",
  search: "#0f766e",
  content: "#57534e",
  error: "#b91c1c"
};

export function renderMapHtml(data: MapReportData): string {
  const typeCounts = new Map<PageType, number>();
  for (const g of data.groups)
    typeCounts.set(g.type, (typeCounts.get(g.type) ?? 0) + 1);

  const rows = data.groups
    .map((g) => {
      const rep = g.representative;
      const path = rep.finalPath || rep.path;
      const color = TYPE_COLOR[g.type];
      const statusClass =
        rep.status === null || rep.status >= 500
          ? "stat-fail"
          : rep.status >= 400
            ? "stat-warn"
            : "stat-ok";
      const thumb = rep.screenshot
        ? `<a href="${esc(rep.screenshot)}" target="_blank"><img src="${esc(rep.screenshot)}" loading="lazy"></a>`
        : '<span class="dim">—</span>';
      const formBadge = rep.forms.length
        ? `<span class="badge">${rep.forms.length} form${rep.forms.length > 1 ? "s" : ""}</span>`
        : "";
      const countBadge =
        g.count > 1 ? `<span class="badge">${g.count} pages</span>` : "";
      return `<tr>
        <td><span class="type" style="background:${color}">${g.type}</span></td>
        <td><code>${esc(g.template)}</code><div class="dim">${esc(rep.title || "")}</div></td>
        <td><a href="${esc(rep.url)}" target="_blank">${esc(path)}</a> ${countBadge}${formBadge}</td>
        <td class="status ${statusClass}">${rep.status ?? "—"}</td>
        <td class="num">${rep.internalLinks.length}</td>
        <td>${thumb}</td>
      </tr>`;
    })
    .join("");

  const legend = Array.from(typeCounts.entries())
    .map(
      ([type, count]) =>
        `<span class="badge"><span class="dot" style="background:${TYPE_COLOR[type]}"></span>${type} · ${count}</span>`
    )
    .join("");

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>web-tester map · ${data.pageCount} pages</title>
<style>
  :root { --bg:#fafaf9; --surface:#fff; --border:#e7e5e4; --muted:#57534e; --subtle:#a8a29e; --ok:#15803d; --warn:#a16207; --err:#b91c1c; --text:#18181b; }
  * { box-sizing: border-box; }
  body { font: 13px/1.5 -apple-system, BlinkMacSystemFont, "Inter", system-ui, sans-serif; margin: 0; padding: 24px; background: var(--bg); color: var(--text); }
  h1 { font-size: 18px; margin: 0 0 4px; font-weight: 600; letter-spacing: -0.01em; }
  .meta { color: var(--muted); font-size: 12px; margin-bottom: 12px; }
  .badges { margin: 0 0 16px; display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
  .badge { font-size: 11px; padding: 2px 8px; border: 1px solid var(--border); border-radius: 99px; color: var(--muted); background: var(--surface); display: inline-flex; align-items: center; gap: 5px; }
  .badge .dot { width: 8px; height: 8px; border-radius: 99px; display: inline-block; }
  table { width: 100%; border-collapse: collapse; background: var(--surface); border: 1px solid var(--border); border-radius: 6px; overflow: hidden; }
  th, td { padding: 8px 10px; text-align: left; border-bottom: 1px solid var(--border); vertical-align: top; }
  th { font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--muted); font-weight: 600; background: var(--bg); }
  td.num { font-variant-numeric: tabular-nums; color: var(--muted); }
  td .type { color: #fff; font-size: 10px; text-transform: uppercase; letter-spacing: 0.04em; font-weight: 600; padding: 2px 7px; border-radius: 99px; }
  td.stat-ok { color: var(--ok); font-weight: 600; }
  td.stat-warn { color: var(--warn); font-weight: 600; }
  td.stat-fail { color: var(--err); font-weight: 600; }
  td .dim, .dim { color: var(--subtle); font-size: 11px; }
  td img { width: 140px; height: auto; border: 1px solid var(--border); border-radius: 3px; display: block; }
  code { font: 12px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; }
  a { color: var(--text); text-decoration: underline; text-decoration-color: var(--subtle); }
</style>
</head><body>
<h1>site map · ${data.groups.length} routes · ${data.pageCount} pages crawled</h1>
<div class="meta">${esc(data.baseUrl)} · ${esc(data.startedAt)} · ${data.durationMs}ms</div>
<div class="badges">${legend}</div>
<table>
  <thead><tr>
    <th>type</th><th>route template · title</th><th>example · forms</th>
    <th>status</th><th>links</th><th>preview</th>
  </tr></thead>
  <tbody>${rows}</tbody>
</table>
</body></html>`;
}
