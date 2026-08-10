import { expect, type Page } from "@playwright/test";

const FROZEN_NOW = Date.parse("2026-08-09T18:00:00.000Z");

export async function installDeterministicBrowser(page: Page): Promise<void> {
  await page.addInitScript((now) => {
    const NativeDate = Date;
    class FrozenDate extends NativeDate {
      constructor(...args: ConstructorParameters<DateConstructor>) {
        super(...(args.length === 0 ? [now] : args));
      }
    }
    Object.setPrototypeOf(FrozenDate, NativeDate);
    FrozenDate.now = () => now;
    globalThis.Date = FrozenDate as DateConstructor;
  }, FROZEN_NOW);
}

export async function gotoVisualTarget(page: Page, path: string): Promise<void> {
  const response = await page.goto(path, { waitUntil: "domcontentloaded" });
  expect(response, `${path} did not produce a document response`).not.toBeNull();
  expect(response?.status(), `${path} returned an error response`).toBeLessThan(400);
  expect(new URL(page.url()).pathname, `${path} redirected to login`).not.toBe("/login");

  await page.addStyleTag({
    content: `
      *, *::before, *::after {
        animation-delay: 0s !important;
        animation-duration: 0s !important;
        caret-color: transparent !important;
        transition: none !important;
      }
    `,
  });

  await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => undefined);
  await page
    .waitForFunction(() => !document.querySelector('[aria-busy="true"]'), undefined, {
      timeout: 8_000,
    })
    .catch(() => undefined);
  await page.evaluate(() => document.fonts?.ready);
  await waitForStableLayout(page);
}

async function waitForStableLayout(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve, reject) => {
        let previous = "";
        let stableFrames = 0;
        const timeout = window.setTimeout(
          () => reject(new Error("Layout did not stabilize before visual capture")),
          5_000,
        );
        const sample = () => {
          const root = document.scrollingElement ?? document.documentElement;
          const current = `${root.scrollWidth}:${root.scrollHeight}:${document.body.offsetWidth}:${document.body.offsetHeight}`;
          stableFrames = current === previous ? stableFrames + 1 : 0;
          previous = current;
          if (stableFrames >= 4) {
            window.clearTimeout(timeout);
            resolve();
            return;
          }
          requestAnimationFrame(sample);
        };
        requestAnimationFrame(sample);
      }),
  );
}
