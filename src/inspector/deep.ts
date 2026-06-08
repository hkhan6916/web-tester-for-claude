import type { CDPSession, Page } from "playwright";

/** One scope frame from a paused exception, variable name → rendered value. */
export type ScopeDump = {
  type: string;
  vars: Record<string, string>;
};

/** An uncaught exception captured with its local scope, via the debugger. */
export type DeepError = {
  /** First line of the exception (e.g. `TypeError: x is not a function`). */
  reason: string;
  functionName: string;
  /** Script URL + line where it threw, when known. */
  location: string | null;
  /** Local + closure scope at the throw site. Empty when nothing readable. */
  scopes: ScopeDump[];
  timestamp: number;
};

export type DeepBuffers = {
  /** Uncaught exceptions, enriched with scope. */
  errors: DeepError[];
  /** Unhandled promise rejections (message text). Often missed by `pageerror`. */
  rejections: string[];
};

/** Stop pausing once we've collected this many — a throw-loop shouldn't stall the run. */
const MAX_DEEP_ERRORS = 25;

type RemoteObject = {
  value?: unknown;
  description?: string;
  type?: string;
  preview?: { properties?: Array<{ name: string; value?: string }> };
};

/** Render a CDP RemoteObject compactly: primitive value, object preview, or type. */
function renderRemote(obj: RemoteObject | undefined): string {
  if (!obj) return "undefined";
  if (obj.value !== undefined) return JSON.stringify(obj.value);
  if (obj.preview?.properties?.length) {
    const parts = obj.preview.properties
      .slice(0, 8)
      .map((p) => `${p.name}: ${p.value ?? "…"}`);
    return `{ ${parts.join(", ")} }`;
  }
  return obj.description ?? obj.type ?? "?";
}

/**
 * Attach a CDP debugger to `page` that pauses on every uncaught exception,
 * snapshots the throwing frame's local + closure scope, then resumes
 * immediately — so the page never deadlocks. Also records unhandled promise
 * rejections, which Playwright's `pageerror` event doesn't surface.
 *
 * This is opt-in (`--deep`): pausing on exceptions adds protocol overhead and
 * is wasted on a healthy page. Returns the growing buffers plus a `detach`.
 */
export async function attachDeepCapture(
  page: Page
): Promise<{ buffers: DeepBuffers; detach: () => Promise<void> }> {
  const buffers: DeepBuffers = { errors: [], rejections: [] };
  const cdp: CDPSession = await page.context().newCDPSession(page);

  await cdp.send("Debugger.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Debugger.setPauseOnExceptions", { state: "uncaught" });

  cdp.on("Debugger.paused", async (evt) => {
    // The page's JS thread is frozen here. Whatever happens, resume in the
    // finally so a read error can't strand the page mid-exception.
    try {
      if (buffers.errors.length >= MAX_DEEP_ERRORS) return;
      const frames = (evt as { callFrames?: unknown[] }).callFrames ?? [];
      const top = frames[0] as
        | {
            functionName?: string;
            url?: string;
            location?: { lineNumber?: number };
            scopeChain?: Array<{
              type?: string;
              object?: { objectId?: string };
            }>;
          }
        | undefined;
      const data = (evt as { data?: { description?: string } }).data;
      const reason = (data?.description ?? "(uncaught exception)").split("\n")[0]!;

      const scopes: ScopeDump[] = [];
      for (const scope of top?.scopeChain ?? []) {
        if (scope.type !== "local" && scope.type !== "closure") continue;
        if (!scope.object?.objectId) continue;
        const props = await cdp
          .send("Runtime.getProperties", {
            objectId: scope.object.objectId,
            ownProperties: true,
            generatePreview: true
          })
          .catch(() => null);
        if (!props) continue;
        const vars: Record<string, string> = {};
        for (const p of (props as { result?: Array<{ name: string; value?: RemoteObject }> }).result ?? []) {
          if (p.name === "this" || !p.value) continue;
          vars[p.name] = renderRemote(p.value);
        }
        if (Object.keys(vars).length > 0) scopes.push({ type: scope.type, vars });
      }

      // Only record exceptions we could enrich with scope — an exception with
      // no readable variables adds nothing over the message+stack already in
      // `pageErrors`. This keeps `deepErrors` purely the value-add: the throw
      // site's variable state. (Rejections, which rarely have useful scope at
      // the pause point, are covered by `rejections` below.)
      if (scopes.length === 0) return;
      const line = top?.location?.lineNumber;
      buffers.errors.push({
        reason,
        functionName: top?.functionName || "(anonymous)",
        location: top?.url
          ? `${top.url}${line !== undefined ? `:${line + 1}` : ""}`
          : null,
        scopes,
        timestamp: Date.now()
      });
    } finally {
      await cdp.send("Debugger.resume").catch(() => {});
    }
  });

  cdp.on("Runtime.exceptionThrown", (evt) => {
    const details = (evt as { exceptionDetails?: { text?: string; exception?: { description?: string } } })
      .exceptionDetails;
    const text = details?.exception?.description ?? details?.text;
    // Only rejections land here that the pause path doesn't already cover well.
    if (text && /uncaught \(in promise\)/i.test(details?.text ?? "")) {
      buffers.rejections.push(text.split("\n")[0]!);
    }
  });

  const detach = async (): Promise<void> => {
    await cdp.send("Debugger.disable").catch(() => {});
    await cdp.detach().catch(() => {});
  };

  return { buffers, detach };
}
