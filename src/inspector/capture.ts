import type { BrowserContext, Page, Request, Response } from "playwright";

export type ConsoleEntry = {
  type: string;
  text: string;
  location?: string;
  timestamp: number;
};

export type NetworkEntry = {
  method: string;
  url: string;
  resourceType: string;
  status: number | null;
  statusText: string | null;
  durationMs: number | null;
  fromCache: boolean;
  failureText: string | null;
  timestamp: number;
  /** Request payload (truncated). Only captured under `--deep`. */
  requestBody?: string | null;
  /** Response payload, textual content only (truncated). `--deep` only. */
  responseBody?: string | null;
};

export type PageErrorEntry = {
  message: string;
  stack: string | null;
  timestamp: number;
};

export type CaptureBuffers = {
  consoleEntries: ConsoleEntry[];
  networkEntries: NetworkEntry[];
  pageErrors: PageErrorEntry[];
  /** Marks where each step starts so we can slice the buffers per-step. */
  cursor: { console: number; network: number; pageErrors: number };
  /**
   * In-flight `--deep` response-body reads. Each resolves once it has mutated
   * its already-pushed network entry. `flushBodies` awaits these before the
   * context closes (a closed context can't return a body).
   */
  pendingBodies: Promise<void>[];
};

const TRACKED_RESOURCE_TYPES = new Set([
  "xhr",
  "fetch",
  "document",
  "websocket"
]);

const NOISY_URL_FRAGMENTS = [
  "/__nextjs",
  "_next/static/chunks/",
  "_next/static/css/",
  "_next/static/media/",
  "/_next/data/",
  "/_next/image",
  "favicon.ico",
  "googletagmanager",
  "google-analytics",
  "googleadservices",
  "doubleclick",
  "hotjar",
  "fullstory",
  "intercom",
  "segment.io",
  "cookiebot",
  "consentcdn",
  "hs-scripts.com",
  "hsforms.com",
  "hs-analytics.net",
  "hubapi.com",
  "hubspot.com",
  "px.ads.linkedin",
  "linkedin.com/li/track"
];

function isNoisyUrl(url: string): boolean {
  return NOISY_URL_FRAGMENTS.some((frag) => url.includes(frag));
}

/**
 * Console messages we drop by default. These are CSP `report-only` violations
 * from third-party tags, Microsoft Clarity beacons, and similar tracker chatter
 * — interesting to no one diagnosing an app bug. Matched against text
 * and location URL. Pass `--all-console` (or `captureAllConsole: true`) to keep
 * everything.
 */
const NOISY_CONSOLE_FRAGMENTS = [
  "Content Security Policy",
  "Refused to load",
  "Refused to execute",
  "Refused to apply",
  "Refused to connect",
  "googleads",
  "google.com/pagead",
  "googletagmanager",
  "doubleclick",
  "google-analytics",
  "clarity.ms",
  "px.ads.linkedin",
  "facebook.com/tr",
  "hubspot",
  "cookiebot",
  "consentcdn",
  "Tracking Prevention blocked",
  "Loading failed for the <script>",
  "Failed to load resource"
];

function isNoisyConsole(text: string, location?: string): boolean {
  const haystack = `${text}\n${location ?? ""}`;
  return NOISY_CONSOLE_FRAGMENTS.some((frag) => haystack.includes(frag));
}

export function newBuffers(): CaptureBuffers {
  return {
    consoleEntries: [],
    networkEntries: [],
    pageErrors: [],
    cursor: { console: 0, network: 0, pageErrors: 0 },
    pendingBodies: []
  };
}

/** Await any in-flight `--deep` body reads. Call before closing the context. */
export async function flushBodies(buffers: CaptureBuffers): Promise<void> {
  if (buffers.pendingBodies.length === 0) return;
  await Promise.all(buffers.pendingBodies);
}

export function snapshotCursor(buffers: CaptureBuffers): CaptureBuffers["cursor"] {
  return {
    console: buffers.consoleEntries.length,
    network: buffers.networkEntries.length,
    pageErrors: buffers.pageErrors.length
  };
}

export function sliceSince(
  buffers: CaptureBuffers,
  from: CaptureBuffers["cursor"]
): {
  console: ConsoleEntry[];
  network: NetworkEntry[];
  pageErrors: PageErrorEntry[];
} {
  return {
    console: buffers.consoleEntries.slice(from.console),
    network: buffers.networkEntries.slice(from.network),
    pageErrors: buffers.pageErrors.slice(from.pageErrors)
  };
}

export type AttachCaptureOptions = {
  /** Keep every network request, not just XHR/fetch/document, and skip noise filter. */
  allNetwork: boolean;
  /** Keep every console line, including CSP / tracker chatter. */
  allConsole: boolean;
  /** Record request + (textual) response bodies, truncated. Off by default. */
  captureBodies?: boolean;
};

/** Cap on captured body size — enough to read a JSON error, not a whole HTML doc. */
const MAX_BODY_CHARS = 8_192;

/** Content types we'll read a response body for. Skips images, fonts, binaries. */
const TEXTUAL_CONTENT_TYPE =
  /(application\/(json|.*\+json|xml|.*\+xml|javascript|x-www-form-urlencoded)|text\/)/i;

function truncateBody(raw: string): string {
  if (raw.length <= MAX_BODY_CHARS) return raw;
  return `${raw.slice(0, MAX_BODY_CHARS)}… (${raw.length - MAX_BODY_CHARS} more chars)`;
}

/**
 * Read a response body when it's textual (JSON/text/xml/js). Returns null for
 * binary responses, empty bodies, or anything Playwright can't hand back (e.g.
 * redirects, served-from-cache). Never throws — body capture is best-effort.
 */
async function readTextualBody(response: Response | null): Promise<string | null> {
  if (!response) return null;
  const contentType = response.headers()["content-type"] ?? "";
  if (!TEXTUAL_CONTENT_TYPE.test(contentType)) return null;
  try {
    const buf = await response.body();
    if (!buf || buf.length === 0) return null;
    return truncateBody(buf.toString("utf-8"));
  } catch {
    return null;
  }
}

/**
 * Attach console + network + pageerror listeners to a context. The returned
 * buffers grow for the lifetime of the context.
 *
 * By default both streams are filtered: network keeps XHR/fetch/document and
 * drops static asset chunks + known analytics noise; console drops CSP report
 * violations and third-party tracker chatter (Clarity, ads, etc.). The two
 * `all*` flags opt out independently.
 */
export function attachCapture(
  context: BrowserContext,
  page: Page,
  opts: AttachCaptureOptions
): CaptureBuffers {
  const buffers = newBuffers();
  const requestStart = new Map<Request, number>();

  page.on("console", (msg) => {
    const location = msg.location();
    const locationStr =
      location?.url && location.url.length > 0
        ? `${location.url}:${location.lineNumber}:${location.columnNumber}`
        : undefined;
    const text = msg.text();
    if (!opts.allConsole && isNoisyConsole(text, locationStr)) return;
    buffers.consoleEntries.push({
      type: msg.type(),
      text,
      location: locationStr,
      timestamp: Date.now()
    });
  });

  page.on("pageerror", (err) => {
    buffers.pageErrors.push({
      message: err.message,
      stack: err.stack ?? null,
      timestamp: Date.now()
    });
  });

  context.on("request", (req) => {
    requestStart.set(req, Date.now());
  });

  const finalize = (
    req: Request,
    response: Response | null,
    failureText: string | null
  ): void => {
    if (!opts.allNetwork) {
      if (!TRACKED_RESOURCE_TYPES.has(req.resourceType())) return;
      if (isNoisyUrl(req.url())) return;
    }
    const startedAt = requestStart.get(req) ?? Date.now();
    requestStart.delete(req);

    const postData = opts.captureBodies ? req.postData() : null;
    const entry: NetworkEntry = {
      method: req.method(),
      url: req.url(),
      resourceType: req.resourceType(),
      status: response?.status() ?? null,
      statusText: response?.statusText() ?? null,
      durationMs: Date.now() - startedAt,
      fromCache: response ? response.fromServiceWorker() : false,
      failureText,
      timestamp: startedAt,
      ...(opts.captureBodies
        ? { requestBody: postData ? truncateBody(postData) : null }
        : {})
    };
    // Push synchronously so per-step `sliceSince` sees the entry immediately;
    // the response body (async) is mutated onto the same object once read, and
    // shows up in the report — which is written after `flushBodies`.
    buffers.networkEntries.push(entry);
    if (opts.captureBodies) {
      buffers.pendingBodies.push(
        readTextualBody(response).then((body) => {
          entry.responseBody = body;
        })
      );
    }
  };

  context.on("requestfinished", (req) => {
    void (async () => {
      const response = await req.response().catch(() => null);
      finalize(req, response ?? null, null);
    })();
  });

  context.on("requestfailed", (req) => {
    finalize(req, null, req.failure()?.errorText ?? "request failed");
  });

  return buffers;
}
