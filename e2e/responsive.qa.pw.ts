import { expect, test, type BrowserContext, type Page, type TestInfo } from "@playwright/test";
import { installDeterministicBrowser } from "./helpers/visual-readiness";

const EVENT = "ai-engineer-sandbox";
const OWNER_SESSION = "demo-owner-session";

const viewports = [
  { name: "phone-320", width: 320, height: 720 },
  { name: "phone-375", width: 375, height: 812 },
  { name: "tablet-768", width: 768, height: 1024 },
  { name: "laptop-1024", width: 1024, height: 768 },
  { name: "desktop-1440", width: 1440, height: 900 },
  { name: "ultrawide-2560", width: 2560, height: 1080 },
] as const;

const representativeRoutes = [
  "/",
  `/event/${EVENT}/sessions`,
  `/e/${EVENT}/dashboard`,
  `/e/${EVENT}/agenda`,
  `/e/${EVENT}/settings`,
] as const;

function desktopOnly(testInfo: TestInfo): void {
  test.skip(testInfo.project.name !== "desktop-chromium", "The explicit viewport matrix runs once in Chromium");
}

async function authenticateOwner(context: BrowserContext, baseURL: string): Promise<void> {
  const origin = new URL(baseURL);
  await context.addCookies([{
    name: "sp_session",
    value: OWNER_SESSION,
    domain: origin.hostname,
    path: "/",
    httpOnly: true,
    sameSite: "Lax",
    secure: origin.protocol === "https:",
  }]);
}

async function layoutEvidence(page: Page): Promise<{
  readonly viewportWidth: number;
  readonly documentWidth: number;
  readonly clippedControls: readonly string[];
}> {
  return page.evaluate(() => {
    const viewportWidth = document.documentElement.clientWidth;
    const controls = [...document.querySelectorAll<HTMLElement>("main a[href], main button, main input, main select, main textarea")]
      .filter((element) => {
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
      });
    const clippedControls = controls
      .filter((element) => {
        const rect = element.getBoundingClientRect();
        if (rect.left >= -1 && rect.right <= viewportWidth + 1) return false;
        let ancestor = element.parentElement;
        while (ancestor) {
          const style = getComputedStyle(ancestor);
          if ((style.overflowX === "auto" || style.overflowX === "scroll") && ancestor.scrollWidth > ancestor.clientWidth) {
            return false;
          }
          ancestor = ancestor.parentElement;
        }
        return true;
      })
      .map((element) => element.getAttribute("aria-label") ?? element.textContent?.trim().slice(0, 80) ?? element.tagName);
    return {
      viewportWidth,
      documentWidth: document.documentElement.scrollWidth,
      clippedControls,
    };
  });
}

for (const viewport of viewports) {
  test(`${viewport.name} keeps representative public and organizer surfaces usable without horizontal clipping`, async ({ baseURL, context, page }, testInfo) => {
    desktopOnly(testInfo);
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await installDeterministicBrowser(page);
    await authenticateOwner(context, baseURL ?? "http://127.0.0.1:5173");

    for (const path of representativeRoutes) {
      await page.goto(path);
      await page.getByRole("heading", { level: 1 }).waitFor({ state: "visible" });
      await expect(page.locator("h1")).toHaveCount(1);
      const evidence = await layoutEvidence(page);
      expect(evidence.documentWidth, `${path} widened the ${viewport.name} document`).toBeLessThanOrEqual(evidence.viewportWidth + 1);
      expect(evidence.clippedControls, `${path} clipped interactive controls at ${viewport.width}px`).toEqual([]);
    }

    await page.goto(`/e/${EVENT}/dashboard`);
    if (viewport.width < 1024) {
      await expect(page.locator('button[aria-controls="mobile-navigation"]')).toBeVisible();
    } else {
      await expect(page.getByRole("navigation", { name: "Event navigation" })).toBeVisible();
    }
  });
}

test("forced-colors mode preserves headings, controls, and reflow on public and organizer routes", async ({ baseURL, context, page }, testInfo) => {
  desktopOnly(testInfo);
  await page.setViewportSize({ width: 768, height: 1024 });
  await page.emulateMedia({ forcedColors: "active", reducedMotion: "reduce" });
  await installDeterministicBrowser(page);
  await authenticateOwner(context, baseURL ?? "http://127.0.0.1:5173");

  for (const path of [`/event/${EVENT}/sessions`, `/e/${EVENT}/forms`, `/e/${EVENT}/agenda`]) {
    await page.goto(path);
    await page.getByRole("heading", { level: 1 }).waitFor({ state: "visible" });
    await expect(page.locator("h1")).toHaveCount(1);
    const evidence = await layoutEvidence(page);
    expect(evidence.documentWidth).toBeLessThanOrEqual(evidence.viewportWidth + 1);
    await expect(page.locator("main a[href], main button, main input, main select").first()).toBeVisible();
  }
});
