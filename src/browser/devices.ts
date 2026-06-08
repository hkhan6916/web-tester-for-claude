import { devices as playwrightDevices } from "playwright";

/**
 * A form factor to emulate. `desktop` is the default. `mobile` and `tablet`
 * carry a realistic viewport, device pixel ratio, touch, and user agent so
 * responsive layouts, touch handlers, and UA sniffing all behave as they would
 * on a real device. You can also name any Playwright device (e.g. "iPhone 13",
 * "Pixel 7") or define your own in `.web-tester/config.json`.
 */
export type Device = {
  name: string;
  viewport: { width: number; height: number };
  userAgent?: string;
  deviceScaleFactor?: number;
  isMobile?: boolean;
  hasTouch?: boolean;
};

const DESKTOP: Device = {
  name: "desktop",
  viewport: { width: 1280, height: 900 },
  userAgent: "Mozilla/5.0 (compatible; web-tester)"
};
const TABLET: Device = {
  name: "tablet",
  viewport: { width: 834, height: 1112 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
  userAgent:
    "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"
};
const MOBILE: Device = {
  name: "mobile",
  viewport: { width: 412, height: 915 },
  deviceScaleFactor: 2.625,
  isMobile: true,
  hasTouch: true,
  userAgent:
    "Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36"
};

export const BUILTIN_DEVICES: Record<string, Device> = {
  desktop: DESKTOP,
  tablet: TABLET,
  mobile: MOBILE
};

export const DEFAULT_DEVICE: Device = DESKTOP;

function parseViewport(raw: string): { width: number; height: number } {
  const m = raw.trim().toLowerCase().match(/^(\d+)\s*x\s*(\d+)$/);
  if (!m) throw new Error(`--viewport must be <width>x<height> (e.g. 390x844), got "${raw}"`);
  return { width: Number(m[1]), height: Number(m[2]) };
}

type PlaywrightDescriptor = {
  viewport: { width: number; height: number };
  userAgent?: string;
  deviceScaleFactor?: number;
  isMobile?: boolean;
  hasTouch?: boolean;
};

function fromPlaywright(name: string): Device | null {
  const all = playwrightDevices as unknown as Record<string, PlaywrightDescriptor>;
  const d = all[name];
  if (!d) return null;
  const out: Device = { name, viewport: d.viewport };
  if (d.userAgent) out.userAgent = d.userAgent;
  if (d.deviceScaleFactor !== undefined) out.deviceScaleFactor = d.deviceScaleFactor;
  if (d.isMobile !== undefined) out.isMobile = d.isMobile;
  if (d.hasTouch !== undefined) out.hasTouch = d.hasTouch;
  return out;
}

/**
 * Resolve a device from an optional name (built-in, Playwright, or user-defined
 * in `custom`) and an optional `<w>x<h>` viewport override. No name falls back
 * to `desktop`; a viewport override keeps the rest of the device's properties.
 */
export function resolveDevice(opts: {
  name?: string;
  viewport?: string;
  custom?: Record<string, Device>;
}): Device {
  const name = opts.name?.trim();
  let device: Device;
  if (name) {
    const found = opts.custom?.[name] ?? BUILTIN_DEVICES[name] ?? fromPlaywright(name);
    if (!found) {
      const builtins = Object.keys(BUILTIN_DEVICES).join(", ");
      throw new Error(
        `unknown device "${name}". Built-in: ${builtins}. You can also use any ` +
          `Playwright device name (e.g. "iPhone 13", "Pixel 7"), or define one ` +
          `in .web-tester/config.json under "devices".`
      );
    }
    device = { ...found, name };
  } else {
    device = { ...DEFAULT_DEVICE };
  }
  if (opts.viewport) {
    // Keep the device name plain; callers render the size separately (and it's
    // always in result.json's `viewport`), so a custom size shows once.
    device = { ...device, viewport: parseViewport(opts.viewport), name: name ?? "custom" };
  }
  return device;
}

/** The subset of Playwright `BrowserContext` options a device defines. */
export function deviceContextOptions(device: Device): {
  viewport: { width: number; height: number };
  userAgent?: string;
  deviceScaleFactor?: number;
  isMobile?: boolean;
  hasTouch?: boolean;
} {
  const o: ReturnType<typeof deviceContextOptions> = { viewport: device.viewport };
  if (device.userAgent !== undefined) o.userAgent = device.userAgent;
  if (device.deviceScaleFactor !== undefined) o.deviceScaleFactor = device.deviceScaleFactor;
  if (device.isMobile !== undefined) o.isMobile = device.isMobile;
  if (device.hasTouch !== undefined) o.hasTouch = device.hasTouch;
  return o;
}
