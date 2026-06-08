import type { Page } from "playwright";

export type UiAttribute = {
  name: string;
  alias: string;
  type: string | null;
  hidden: boolean;
  value: string;
  label: string;
};

/**
 * Best-effort "is the page done rendering?" gate, driven by `data-attr-*`
 * markers on the page.
 *
 * Convention:
 *   <element data-attr-name="…" data-attr-selected-label="…" />
 *
 * If your app paints any element with a `data-attr-name` attribute, this
 * step will wait until at least one of them carries a non-empty
 * `data-attr-selected-label` — typically the last attribute to populate
 * when async state has finished arriving. That's a reliable "everything
 * settled" signal that doesn't depend on network idle.
 *
 * Fast-path: if no `data-attr-name` exists on the page within `probeMs`,
 * we return immediately rather than waiting out the full timeout. So
 * `settle` is cheap on pages that don't use the convention at all — it
 * adds ~3 s and moves on.
 *
 * Apps that don't use `data-attr-*` markers should prefer
 * `--step wait:networkidle` over `--step settle`.
 */
const SETTLE_PROBE_MS = 3_000;

export async function waitForAttrsReady(
  page: Page,
  timeoutMs: number
): Promise<{ probed: boolean; settled: boolean }> {
  try {
    await page
      .locator("[data-attr-name]")
      .first()
      .waitFor({ state: "attached", timeout: SETTLE_PROBE_MS });
  } catch {
    return { probed: false, settled: false };
  }
  const settled = await page
    .waitForFunction(
      () => {
        const candidates = document.querySelectorAll("[data-attr-name]");
        for (const el of Array.from(candidates)) {
          const label = el.getAttribute("data-attr-selected-label") ?? "";
          if (label.trim().length > 0) return true;
        }
        return false;
      },
      undefined,
      { timeout: timeoutMs, polling: 100 }
    )
    .then(() => true)
    .catch(() => false);
  return { probed: true, settled };
}

export async function readUiAttributes(page: Page): Promise<UiAttribute[]> {
  return page
    .evaluate(() => {
      const elements = document.querySelectorAll<HTMLElement>("[data-attr-name]");
      return Array.from(elements).map((el) => ({
        name: el.getAttribute("data-attr-name") ?? "",
        alias: el.getAttribute("data-attr-alias") ?? "",
        type: el.getAttribute("data-attr-type"),
        hidden: el.getAttribute("data-attr-hidden") === "true",
        value: el.getAttribute("data-attr-selected-value") ?? "",
        label: el.getAttribute("data-attr-selected-label") ?? ""
      }));
    })
    .catch(() => [] as UiAttribute[]);
}
