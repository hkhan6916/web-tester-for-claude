import type { PageFacts } from "./crawl";

export type PageType =
  | "home"
  | "auth"
  | "search"
  | "form"
  | "list"
  | "detail"
  | "content"
  | "error";

export type ClassifiedPage = PageFacts & {
  type: PageType;
  template: string;
};

export type RouteGroup = {
  template: string;
  type: PageType;
  count: number;
  /** Best representative path (prefers a healthy page). */
  representative: ClassifiedPage;
  members: ClassifiedPage[];
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX_RE = /^[0-9a-f]{12,}$/i;

/** Does a path segment look like a dynamic id/slug rather than a fixed route? */
function isDynamicSegment(seg: string): boolean {
  if (!seg) return false;
  if (/^\d+$/.test(seg)) return true; // numeric id
  if (UUID_RE.test(seg)) return true;
  if (HEX_RE.test(seg)) return true;
  // Slug ending in a numeric id, e.g. "blue-widget-12345".
  if (/-\d{3,}$/.test(seg)) return true;
  // A long run of digits strongly implies an id (e.g. "sku12345",
  // "order2024001"). Deliberately conservative: version-y segments like
  // "v2beta" or "apiv2docs" have no 4+ digit run, so they stay fixed routes —
  // over-collapsing distinct routes into one template is worse than the
  // reverse for a site map.
  if (/\d{4,}/.test(seg)) return true;
  return false;
}

/**
 * Collapse a concrete path into a route template by replacing dynamic
 * segments with `:id`. Query strings are dropped. `/products/12345?ref=x`
 * and `/products/67890` both become `/products/:id`.
 */
export function routeTemplate(path: string): string {
  const [pathname = "/"] = path.split("?");
  const segments = pathname.split("/").filter(Boolean);
  if (segments.length === 0) return "/";
  const mapped = segments.map((s) => (isDynamicSegment(s) ? ":id" : s));
  return `/${mapped.join("/")}`;
}

const AUTH_RE =
  /(^|\/)(login|log-in|signin|sign-in|signup|sign-up|register|auth|forgot|password|reset)(\/|$)/i;

export function classify(facts: PageFacts): PageType {
  if (!facts.ok) return "error";

  const path = facts.finalPath || facts.path;
  const template = routeTemplate(path);

  if (path === "/" || template === "/") return "home";

  if (facts.passwordFields > 0 || AUTH_RE.test(path)) return "auth";

  if (
    facts.searchInputs > 0 ||
    /(^|\/)search(\/|$)/i.test(path) ||
    /[?&](q|query|s|search)=/.test(path)
  )
    return "search";

  // A list/index page: several catalog-style card links, or many internal
  // links concentrated in <main>.
  if (facts.cardLinkCount >= 3) return "list";

  // A meaningful form (more than a newsletter single-field) that isn't auth.
  const richForm = facts.forms.some(
    (f) => f.fields.filter((x) => x.type !== "hidden").length >= 2
  );
  if (richForm) return "form";

  // Dynamic route → a detail/show page.
  if (template !== path && template.includes(":id")) return "detail";

  return "content";
}

export function classifyAll(pages: PageFacts[]): ClassifiedPage[] {
  return pages.map((p) => ({
    ...p,
    type: classify(p),
    template: routeTemplate(p.finalPath || p.path)
  }));
}

/** Group classified pages by route template, picking a healthy representative. */
export function groupByTemplate(pages: ClassifiedPage[]): RouteGroup[] {
  const groups = new Map<string, ClassifiedPage[]>();
  for (const p of pages) {
    const list = groups.get(p.template);
    if (list) list.push(p);
    else groups.set(p.template, [p]);
  }

  const result: RouteGroup[] = [];
  for (const [template, members] of groups) {
    // Prefer an ok page with the shortest path as the representative.
    const sorted = [...members].sort((a, b) => {
      if (a.ok !== b.ok) return a.ok ? -1 : 1;
      return a.path.length - b.path.length;
    });
    const representative = sorted[0]!;
    // The group's type is its representative's type, unless that's an error
    // but a healthy member exists.
    result.push({
      template,
      type: representative.type,
      count: members.length,
      representative,
      members
    });
  }

  // Stable, useful ordering: home first, then by type, then alphabetically.
  const typeRank: Record<PageType, number> = {
    home: 0,
    list: 1,
    detail: 2,
    form: 3,
    auth: 4,
    search: 5,
    content: 6,
    error: 7
  };
  result.sort((a, b) => {
    if (typeRank[a.type] !== typeRank[b.type])
      return typeRank[a.type] - typeRank[b.type];
    return a.template.localeCompare(b.template);
  });
  return result;
}
