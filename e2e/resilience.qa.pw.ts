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
    expect(headers["content-security-policy"], path).toContain("default-src 'self'");
    expect(headers["content-security-policy"], path).toContain("frame-ancestors 'none'");
    expect(headers["strict-transport-security"], path).toBe("max-age=31536000");
    expect(headers["x-frame-options"], path).toBe("DENY");
    expect(headers["x-content-type-options"], path).toBe("nosniff");
    expect(headers["referrer-policy"], path).toBe("strict-origin-when-cross-origin");
    expect(headers["permissions-policy"], path).toBe("camera=(), geolocation=(), microphone=()");
  }
});

test("deployed embed shells remain frameable while retaining the application CSP", async ({ baseURL, request }, testInfo) => {
  chromiumOnly(testInfo);
  test.skip(new URL(baseURL ?? "http://127.0.0.1").hostname === "127.0.0.1", "Cloudflare applies public/_headers at build preview and deploy time, not Vite dev time");
  const response = await request.get(`/embed/${EVENT}/embed_schedule`);
  expect(response.status()).toBe(200);
  const headers = response.headers();
  expect(headers["content-security-policy"]).toContain("default-src 'self'");
  expect(headers["content-security-policy"]).toContain("frame-ancestors *");
  expect(headers["content-security-policy"]).not.toContain("frame-ancestors 'none'");
  expect(headers["x-frame-options"]).toBeUndefined();
  expect(headers["referrer-policy"]).toBe("strict-origin-when-cross-origin");
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

test("agenda mutations fail closed while offline and recover from canonical state after reconnect", async ({ context, page }, testInfo) => {
  chromiumOnly(testInfo);
  await context.addCookies([{
    name: "sp_session",
    value: "demo-owner-session",
    domain: "127.0.0.1",
    path: "/",
    httpOnly: true,
    sameSite: "Lax",
  }]);
  await installDeterministicBrowser(page);
  await page.goto(`/e/${EVENT}/agenda`);
  await expect(page.getByRole("heading", { level: 1 })).toContainText("AI Engineer Sandbox");
  await expect(page.getByRole("button", { name: "Publish run sheet" })).toBeEnabled();
  await page.getByRole("button", { name: "Tracks & rooms" }).click();
  await expect(page.getByRole("dialog", { name: "Tracks and rooms" })).toBeVisible();

  await context.setOffline(true);
  await expect(page.getByRole("status").filter({ hasText: "Offline" })).toContainText("Changes are unavailable while offline.");
  await expect(page.getByRole("button", { name: "Create track" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Create room" })).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Tracks and rooms" })).toBeHidden();
  await expect(page.getByRole("button", { name: "Publish run sheet" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Tracks & rooms" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Create talk" }).first()).toBeDisabled();

  await context.setOffline(false);
  await expect(page.getByRole("status").filter({ hasText: "Live" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Publish run sheet" })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Tracks & rooms" })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Create talk" }).first()).toBeEnabled();
});

test("session expiry during form creation fails closed without creating a draft", async ({ context, page, request }, testInfo) => {
  chromiumOnly(testInfo);
  const ownerHeaders = { Cookie: "sp_session=demo-owner-session" };
  const before = await request.get(`/api/v1/events/demo-event/forms`, { headers: ownerHeaders });
  expect(before.status()).toBe(200);
  const beforeForms = (await before.json()) as readonly { readonly id: string }[];

  await context.addCookies([{
    name: "sp_session",
    value: "demo-owner-session",
    domain: "127.0.0.1",
    path: "/",
    httpOnly: true,
    sameSite: "Lax",
  }]);
  await installDeterministicBrowser(page);
  await page.goto(`/e/${EVENT}/forms`);
  await page.getByRole("button", { name: "New additional form" }).click();
  await page.getByRole("textbox", { name: "Form name" }).fill("Must not survive expired session");
  await context.clearCookies({ name: "sp_session" });
  await page.getByRole("button", { name: "Create draft" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Sign in to view this event" })).toBeVisible();

  const after = await request.get(`/api/v1/events/demo-event/forms`, { headers: ownerHeaders });
  expect(after.status()).toBe(200);
  const afterForms = (await after.json()) as readonly { readonly id: string }[];
  expect(afterForms.map(({ id }) => id)).toEqual(beforeForms.map(({ id }) => id));
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
