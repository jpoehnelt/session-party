import { expect, test, type TestInfo } from "@playwright/test";
import { installDeterministicBrowser } from "./helpers/visual-readiness";

const EVENT = "ai-engineer-sandbox";

function chromiumOnly(testInfo: TestInfo): void {
  test.skip(testInfo.project.name !== "desktop-chromium", "Failure injection and timing smoke checks are browser-independent");
}

test("deployed static document responses carry baseline browser security headers", async ({ baseURL, request }, testInfo) => {
  chromiumOnly(testInfo);
  test.skip(new URL(baseURL ?? "http://127.0.0.1").hostname === "127.0.0.1", "Cloudflare applies public/_headers at build preview and deploy time, not Vite dev time");
  for (const path of ["/", `/e/${EVENT}`, `/event/${EVENT}/sessions`]) {
    const response = await request.get(path);
    expect(response.status(), path).toBe(200);
    const headers = response.headers();
    expect(headers["x-content-type-options"], path).toBe("nosniff");
    expect(headers["referrer-policy"], path).toBe("strict-origin-when-cross-origin");
    expect(headers["permissions-policy"], path).toBe("camera=(), geolocation=(), microphone=()");
  }
});

test("an organizer event-load failure renders a usable retry state and recovers", async ({ page }, testInfo) => {
  chromiumOnly(testInfo);
  await page.context().addCookies([{
    name: "sp_session",
    value: "demo-owner-session",
    domain: "127.0.0.1",
    path: "/",
    httpOnly: true,
    sameSite: "Lax",
  }]);
  await installDeterministicBrowser(page);
  const eventPattern = `**/api/v1/events/${EVENT}`;
  await page.route(eventPattern, (route) => route.abort("failed"));
  await page.goto(`/e/${EVENT}/forms`);
  await expect(page.getByRole("heading", { level: 1, name: /Could not load event/i })).toBeVisible();
  const retry = page.getByRole("button", { name: "Try again" });
  await expect(retry).toBeVisible();
  await page.unroute(eventPattern);
  await retry.click();
  await expect(page.getByRole("heading", { level: 1, name: "CFP & forms" })).toBeVisible();
  await expect(page.getByRole("button", { name: "New additional form" })).toBeEnabled();
});

test("representative public and organizer routes stay within local LCP and CLS smoke budgets", async ({ context, page }, testInfo) => {
  chromiumOnly(testInfo);
  await context.addCookies([{
    name: "sp_session",
    value: "demo-owner-session",
    domain: "127.0.0.1",
    path: "/",
    httpOnly: true,
    sameSite: "Lax",
  }]);
  await page.addInitScript(() => {
    const metrics = { cls: 0, lcp: 0, shifts: [] as string[] };
    (window as typeof window & { __qaVitals: typeof metrics }).__qaVitals = metrics;
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) metrics.lcp = Math.max(metrics.lcp, entry.startTime);
    }).observe({ type: "largest-contentful-paint", buffered: true });
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries() as (PerformanceEntry & { value: number; hadRecentInput: boolean })[]) {
        if (!entry.hadRecentInput) {
          metrics.cls += entry.value;
          const sources = (entry as PerformanceEntry & { sources?: { node?: Node | null }[] }).sources ?? [];
          metrics.shifts.push(...sources.map(({ node }) => node instanceof Element
            ? `${node.tagName.toLowerCase()}${node.id ? `#${node.id}` : ""}.${[...node.classList].slice(0, 2).join(".")}`
            : "unknown"));
        }
      }
    }).observe({ type: "layout-shift", buffered: true });
  });

  for (const path of ["/", `/event/${EVENT}/sessions`, `/e/${EVENT}/dashboard`]) {
    await page.goto(path);
    await page.getByRole("heading", { level: 1 }).waitFor({ state: "visible" });
    await page.waitForTimeout(500);
    const metrics = await page.evaluate(() => {
      const vitals = (window as typeof window & { __qaVitals: { cls: number; lcp: number; shifts: string[] } }).__qaVitals;
      const navigation = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming;
      return { ...vitals, load: navigation.loadEventEnd || performance.now() };
    });
    expect(metrics.lcp || metrics.load, `${path} local LCP proxy`).toBeLessThanOrEqual(2_500);
    expect(metrics.cls, `${path} local CLS; sources: ${metrics.shifts.join(", ")}`).toBeLessThanOrEqual(0.1);
  }
});
