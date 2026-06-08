/**
 * Fetch and parse a sitemap into a list of paths (pathname + search, no
 * host). Sitemaps often list a different host than the one under test
 * (e.g. a prod sitemap fetched from staging), so results are normalised to
 * paths usable against whatever base URL the caller points at.
 *
 * Sitemap-index files (a <sitemap> list pointing at child sitemaps) are
 * followed one level deep so `--sitemap` works on sites that shard their
 * sitemap.
 */
export type SitemapOptions = {
  /** Absolute URL to the sitemap. */
  url: string;
  /** Optional include regex; only paths whose pathname matches are kept. */
  filter?: RegExp;
  /** Optional exclude regex; paths whose pathname matches are dropped. */
  exclude?: RegExp;
  /** Max URLs to return (after filter/exclude). 0 = unlimited. */
  limit?: number;
};

async function fetchLocs(url: string): Promise<string[]> {
  const res = await fetch(url, {
    headers: { Accept: "application/xml,text/xml,*/*" }
  });
  if (!res.ok)
    throw new Error(
      `sitemap fetch failed: ${res.status} ${res.statusText} (${url})`
    );
  const body = await res.text();
  const out: string[] = [];
  for (const m of body.matchAll(/<loc[^>]*>([^<]+)<\/loc>/g)) {
    const raw = m[1]?.trim();
    if (raw) out.push(raw);
  }
  return out;
}

export async function fetchSitemapPaths(
  opts: SitemapOptions
): Promise<string[]> {
  const locs = await fetchLocs(opts.url);

  // A sitemap index lists child sitemaps (entries ending in `.xml`). Follow
  // them one level deep, ignoring failures so one bad child doesn't sink the
  // whole fetch.
  const childSitemaps = locs.filter((l) => /\.xml(\?|$)/.test(l));
  const pageLocs = locs.filter((l) => !/\.xml(\?|$)/.test(l));
  if (childSitemaps.length > 0) {
    const childResults = await Promise.all(
      childSitemaps.map((child) => fetchLocs(child).catch(() => [] as string[]))
    );
    for (const list of childResults)
      for (const loc of list) if (!/\.xml(\?|$)/.test(loc)) pageLocs.push(loc);
  }

  const paths: string[] = [];
  const seen = new Set<string>();
  for (const raw of pageLocs) {
    let path: string;
    try {
      const u = new URL(raw);
      path = u.pathname + u.search;
    } catch {
      path = raw.startsWith("/") ? raw : `/${raw}`;
    }
    if (opts.filter && !opts.filter.test(path)) continue;
    if (opts.exclude && opts.exclude.test(path)) continue;
    if (seen.has(path)) continue;
    seen.add(path);
    paths.push(path);
    if (opts.limit && paths.length >= opts.limit) break;
  }
  return paths;
}
