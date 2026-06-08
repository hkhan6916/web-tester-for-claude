import { existsSync } from "node:fs";
import {
  type Browser,
  type BrowserContext,
  chromium,
  type Page
} from "playwright";
import { ensureWebTesterHome, SESSION_STATE_PATH } from "../util/paths";
import { DEFAULT_DEVICE, type Device, deviceContextOptions } from "./devices";

export type SessionOptions = {
  baseUrl: string;
  headed?: boolean;
  /** Form factor to emulate (viewport, touch, UA). Defaults to desktop. */
  device?: Device;
  /** Directory to record a video into. If omitted, no recording. */
  videoDir?: string;
  /**
   * When true (the default), `~/.web-tester/session.json` is loaded into
   * the browser context if it exists, so runs against authenticated pages
   * can skip the login flow. Pass `false` to force an anonymous context
   * (e.g. to test the logged-out experience).
   */
  loadStorageState?: boolean;
};

export type Session = {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  baseUrl: string;
  /** True if `SESSION_STATE_PATH` existed and was loaded into this context. */
  storageStateLoaded: boolean;
  /**
   * Persist the current browser context (cookies + localStorage) to
   * `~/.web-tester/session.json` so subsequent runs can skip the login
   * dance. Safe to call multiple times — overwrites in place.
   */
  saveStorageState: () => Promise<void>;
  /** Resolves to the saved video file path after the context is closed. */
  videoPath: () => Promise<string | null>;
  close: () => Promise<void>;
};

/**
 * Hides Next.js dev-mode overlays (portal, toasts, error dialogs) so they
 * don't intercept clicks or appear in screenshots. They use Shadow DOM and
 * survive page CSS `display:none`, so a MutationObserver also removes them.
 * Consent banners and other app-specific widgets are deliberately left alone.
 */
const NEXTJS_OVERLAY_HIDE_CSS = `
  nextjs-portal,
  [data-nextjs-toast],
  [data-nextjs-dialog-overlay],
  [data-nextjs-dialog] {
    display: none !important;
    visibility: hidden !important;
    pointer-events: none !important;
    opacity: 0 !important;
  }
  html, body { overflow: auto !important; }
`;

export async function configureContext(
  context: BrowserContext,
  _baseUrl: string
): Promise<void> {
  // Injected as a content string, not a function: tsx's esbuild compile
  // would otherwise wrap functions with `__name(...)` helpers that don't
  // exist in the browser and surface as a page error on every run.
  const initScript = `
(function (css) {
  function inject() {
    var style = document.createElement('style');
    style.setAttribute('data-web-tester', 'overlay-suppression');
    style.textContent = css;
    (document.head || document.documentElement).appendChild(style);
  }
  if (document.head) inject();
  else document.addEventListener('DOMContentLoaded', inject, { once: true });

  function killPortals() {
    var portals = document.querySelectorAll('nextjs-portal, [data-nextjs-toast], [data-nextjs-dialog-overlay]');
    portals.forEach(function (p) { p.remove(); });
  }
  killPortals();
  var observer = new MutationObserver(killPortals);
  function start() {
    if (document.body) observer.observe(document.body, { childList: true, subtree: true });
  }
  if (document.body) start();
  else document.addEventListener('DOMContentLoaded', start, { once: true });
})(${JSON.stringify(NEXTJS_OVERLAY_HIDE_CSS)});
`;
  await context.addInitScript({ content: initScript });
}

export async function openSession(opts: SessionOptions): Promise<Session> {
  const baseUrl = opts.baseUrl.replace(/\/$/, "");
  const device = opts.device ?? DEFAULT_DEVICE;
  const browser = await chromium.launch({ headless: !opts.headed });
  const shouldLoadState = opts.loadStorageState !== false;
  const storageStateLoaded = shouldLoadState && existsSync(SESSION_STATE_PATH);
  const context = await browser.newContext({
    ...deviceContextOptions(device),
    recordVideo: opts.videoDir ? { dir: opts.videoDir, size: device.viewport } : undefined,
    ...(storageStateLoaded ? { storageState: SESSION_STATE_PATH } : {})
  });
  await configureContext(context, baseUrl);
  const page = await context.newPage();
  return {
    browser,
    context,
    page,
    baseUrl,
    storageStateLoaded,
    saveStorageState: async () => {
      ensureWebTesterHome();
      await context.storageState({ path: SESSION_STATE_PATH });
    },
    videoPath: async () => {
      const video = page.video();
      if (!video) return null;
      // Playwright finalises the video file on context close, so callers must
      // call this *after* close(). Resolves to the absolute path on disk.
      return video.path().catch(() => null);
    },
    close: async () => {
      await context.close().catch(() => {});
      await browser.close().catch(() => {});
    }
  };
}
