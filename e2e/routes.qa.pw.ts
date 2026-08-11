import { expect, test, type BrowserContext, type Page, type TestInfo } from "@playwright/test";
import axe from "axe-core";
import { installDeterministicBrowser } from "./helpers/visual-readiness";

type Persona = "public" | "owner" | "admin" | "reviewer" | "speaker";

interface RouteTarget {
  readonly name: string;
  readonly path: string;
  readonly persona: Persona;
  readonly appShell?: boolean;
}

interface ControlRecord {
  readonly tag: string;
  readonly type: string | null;
  readonly role: string | null;
  readonly name: string;
  readonly disabled: boolean;
  readonly visible: boolean;
}

const EVENT_SLUG = "ai-engineer-sandbox";
const SESSION_BY_PERSONA: Partial<Record<Persona, string>> = {
  owner: "demo-owner-session",
  admin: "demo-admin-session",
  reviewer: "demo-reviewer-session",
  speaker: "demo-speaker-session",
};

const ORGANIZER_ROUTES: readonly RouteTarget[] = [
  { name: "overview", path: `/e/${EVENT_SLUG}`, persona: "owner", appShell: true },
  { name: "forms", path: `/e/${EVENT_SLUG}/forms`, persona: "owner", appShell: true },
  { name: "submissions", path: `/e/${EVENT_SLUG}/submissions`, persona: "owner", appShell: true },
  { name: "review", path: `/e/${EVENT_SLUG}/review`, persona: "reviewer", appShell: true },
  { name: "onboarding", path: `/e/${EVENT_SLUG}/dashboard`, persona: "owner", appShell: true },
  { name: "speakers", path: `/e/${EVENT_SLUG}/speakers`, persona: "owner", appShell: true },
  { name: "speaker-detail", path: `/e/${EVENT_SLUG}/speakers/__qa_speaker__`, persona: "owner", appShell: true },
  { name: "tasks", path: `/e/${EVENT_SLUG}/tasks`, persona: "owner", appShell: true },
  { name: "resources", path: `/e/${EVENT_SLUG}/resources`, persona: "owner", appShell: true },
  { name: "content", path: `/e/${EVENT_SLUG}/content`, persona: "owner", appShell: true },
  { name: "agenda", path: `/e/${EVENT_SLUG}/agenda`, persona: "owner", appShell: true },
  { name: "communications", path: `/e/${EVENT_SLUG}/comms`, persona: "owner", appShell: true },
  { name: "publication", path: `/e/${EVENT_SLUG}/publication`, persona: "owner", appShell: true },
  { name: "exports", path: `/e/${EVENT_SLUG}/exports`, persona: "owner", appShell: true },
  { name: "integrations", path: `/e/${EVENT_SLUG}/integrations`, persona: "owner", appShell: true },
  { name: "settings", path: `/e/${EVENT_SLUG}/settings`, persona: "owner", appShell: true },
] as const;

const ADMIN_ROUTES: readonly RouteTarget[] = ORGANIZER_ROUTES
  .filter(({ name }) => name !== "review")
  .map((target) => ({ ...target, name: `admin-${target.name}`, persona: "admin" as const }));

const PUBLIC_AND_PORTAL_ROUTES: readonly RouteTarget[] = [
  { name: "landing", path: "/", persona: "public" },
  { name: "login", path: "/login", persona: "public" },
  { name: "events", path: "/events", persona: "owner", appShell: true },
  { name: "speaker-portal", path: `/e/${EVENT_SLUG}/portal`, persona: "speaker" },
  { name: "reusable-speaker-profile", path: "/speaker/profile", persona: "speaker", appShell: true },
  { name: "my-submissions", path: `/portal/events/${EVENT_SLUG}/submissions`, persona: "speaker" },
  { name: "public-program", path: `/event/${EVENT_SLUG}`, persona: "public" },
  { name: "public-sessions", path: `/event/${EVENT_SLUG}/sessions`, persona: "public" },
  { name: "public-speakers", path: `/event/${EVENT_SLUG}/speakers`, persona: "public" },
  { name: "public-reusable-speaker-profile", path: "/speakers/priya-raman", persona: "public" },
  { name: "schedule-embed", path: `/embed/${EVENT_SLUG}/schedule`, persona: "public" },
  { name: "speaker-embed", path: `/embed/${EVENT_SLUG}/speakers`, persona: "public" },
  { name: "reviewer-invitation-invalid", path: "/reviewer-invitations/accept", persona: "public" },
  { name: "not-found", path: "/qa-route-that-does-not-exist", persona: "public", appShell: true },
] as const;

const ALL_ROUTES = [...ORGANIZER_ROUTES, ...ADMIN_ROUTES, ...PUBLIC_AND_PORTAL_ROUTES] as const;

async function authenticate(context: BrowserContext, persona: Persona, baseURL: string): Promise<void> {
  const session = SESSION_BY_PERSONA[persona];
  if (!session) return;
  const origin = new URL(baseURL);
  await context.addCookies([{
    name: "sp_session",
    value: session,
    domain: origin.hostname,
    path: "/",
    httpOnly: true,
    sameSite: "Lax",
    secure: origin.protocol === "https:",
  }]);
}

async function openStablePage(page: Page, target: RouteTarget): Promise<void> {
  let path = target.path;
  if (path.includes("__qa_speaker__")) {
    const directoryResponse = await page.request.get("/api/v1/events/demo-event/portal/speakers");
    expect(directoryResponse.status(), "speaker detail fixture could not load").toBe(200);
    const directory = await directoryResponse.json() as { readonly speakers: readonly { readonly speaker: { readonly id: string } }[] };
    expect(directory.speakers.length, "speaker detail fixture is empty").toBeGreaterThan(0);
    path = path.replace("__qa_speaker__", encodeURIComponent(directory.speakers[0]!.speaker.id));
  }
  const response = await page.goto(path, { waitUntil: "domcontentloaded" });
  expect(response, `${path} did not return a document`).not.toBeNull();
  expect(response?.status(), `${path} returned an HTTP error`).toBeLessThan(400);
  await page.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => undefined);
  await page.locator("h1").first().waitFor({ state: "visible", timeout: 45_000 });
  await expect(page.locator("main")).toBeVisible();
}

async function inventoryControls(page: Page): Promise<ControlRecord[]> {
  return page.locator("a[href], button, input, select, textarea, summary, [role]").evaluateAll((elements) =>
    elements.map((element) => {
      const html = element as HTMLElement;
      const field = element as HTMLInputElement;
      const labels = "labels" in field && field.labels
        ? [...field.labels].map((label) => label.textContent?.trim() ?? "").filter(Boolean)
        : [];
      const labelledBy = html.getAttribute("aria-labelledby")
        ?.split(/\s+/)
        .map((id) => document.getElementById(id)?.textContent?.trim() ?? "")
        .filter(Boolean) ?? [];
      const name = [
        html.getAttribute("aria-label")?.trim(),
        ...labelledBy,
        ...labels,
        html.textContent?.trim(),
        html.getAttribute("alt")?.trim(),
        html.getAttribute("title")?.trim(),
      ].find((value) => value) ?? "";
      const style = getComputedStyle(html);
      const rect = html.getBoundingClientRect();
      return {
        tag: html.tagName.toLowerCase(),
        type: html.getAttribute("type"),
        role: html.getAttribute("role"),
        name: name.replace(/\s+/g, " "),
        disabled: field.disabled || html.getAttribute("aria-disabled") === "true",
        visible: style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0,
      };
    }),
  );
}

async function attachInventory(testInfo: TestInfo, target: RouteTarget, controls: ControlRecord[]): Promise<void> {
  await testInfo.attach("control-inventory", {
    body: Buffer.from(JSON.stringify({ target, controls }, null, 2)),
    contentType: "application/json",
  });
}

async function auditAccessibility(page: Page, testInfo: TestInfo): Promise<void> {
  await page.addScriptTag({ content: axe.source });
  const results = await page.evaluate(async () => {
    const axeRuntime = (window as typeof window & { axe: typeof axe }).axe;
    return axeRuntime.run(document, {
      runOnly: {
        type: "tag",
        values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"],
      },
      resultTypes: ["violations"],
    });
  });
  await testInfo.attach("accessibility-audit", {
    body: Buffer.from(JSON.stringify(results.violations, null, 2)),
    contentType: "application/json",
  });
  const blocking = results.violations
    .filter(({ impact }) => impact === "critical" || impact === "serious")
    .map(({ id, impact, help, nodes }) => ({
      id,
      impact,
      help,
      targets: nodes.map((node) => node.target),
    }));
  expect(blocking, "route contains serious or critical WCAG violations").toEqual([]);
}

function consoleIsActionable(text: string): boolean {
  return !text.includes("favicon.ico")
    && !text.includes("Download the React DevTools")
    && !text.includes("WebSocket connection")
    && !text.includes("Failed to load resource: net::ERR_CONNECTION_REFUSED")
    && !/Failed to load resource: the server responded with a status of 4\d\d/.test(text);
}

for (const target of ALL_ROUTES) {
  test(`${target.persona}: ${target.name} has an accessible, stable control surface`, async ({ context, page, baseURL }, testInfo) => {
    const runtimeBaseURL = baseURL ?? "http://127.0.0.1:5173";
    await authenticate(context, target.persona, runtimeBaseURL);
    await installDeterministicBrowser(page);
    await page.route(/^https:\/\/(?:www\.)?youtube(?:-nocookie)?\.com\//, (route) => route.fulfill({
      body: "<!doctype html><title>Deterministic embedded video</title>",
      contentType: "text/html",
      status: 200,
    }));

    const runtimeErrors: string[] = [];
    page.on("pageerror", (error) => runtimeErrors.push(`pageerror: ${error.message}`));
    page.on("console", (message) => {
      if (message.type() === "error" && consoleIsActionable(message.text())) {
        runtimeErrors.push(`console: ${message.text()}`);
      }
    });

    await openStablePage(page, target);
    const controls = await inventoryControls(page);
    await attachInventory(testInfo, target, controls);
    await auditAccessibility(page, testInfo);

    const unnamed = controls.filter((control) => control.visible
      && control.type !== "hidden"
      && control.role !== "none"
      && control.role !== "presentation"
      && !control.name);
    expect(unnamed, `${target.path} contains visible interactive controls without accessible names`).toEqual([]);

    const h1s = page.locator("h1");
    await expect(h1s, `${target.path} must have exactly one H1`).toHaveCount(1);
    const h1 = (await h1s.first().innerText()).replace(/\s+/g, " ").trim();
    expect(h1, `${target.path} has an empty H1`).not.toBe("");
    const title = await page.title();
    expect(title, `${target.path} must identify Session Party`).toContain("Session Party");
    if (target.path === "/") {
      expect(title).toBe("Session Party — Your whole program, ready on cue.");
    } else {
      expect(title.replace(/\s+/g, " "), `${target.path} title must include its visible H1`).toContain(h1);
    }

    const canonical = page.locator('link[rel="canonical"]');
    await expect(canonical, `${target.path} must expose one canonical URL`).toHaveCount(1);
    const canonicalUrl = await canonical.getAttribute("href") ?? runtimeBaseURL;
    expect(new URL(canonicalUrl).pathname).toBe(new URL(page.url()).pathname);
    await expect(page.locator('meta[property="og:title"]')).toHaveAttribute("content", title);
    await expect(page.locator('meta[property="og:url"]')).toHaveAttribute("content", canonicalUrl);
    await expect(page.locator('meta[name="twitter:title"]')).toHaveAttribute("content", title);

    const overflow = await page.evaluate(() => ({
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
    }));
    expect(overflow.scrollWidth, `${target.path} has page-level horizontal overflow`).toBeLessThanOrEqual(overflow.clientWidth + 1);

    if (target.appShell && target.path.startsWith(`/e/${EVENT_SLUG}`)) {
      const current = page.locator('nav[aria-label="Event navigation"] a[aria-current="page"]');
      await expect(current, `${target.path} must identify exactly one current event-nav item`).toHaveCount(1);
    }

    expect(runtimeErrors, `${target.path} emitted browser runtime errors`).toEqual([]);
  });
}

test("global shell supports keyboard skip navigation", async ({ context, page, baseURL }, testInfo) => {
  await authenticate(context, "owner", baseURL ?? "http://127.0.0.1:5173");
  await page.goto(`/e/${EVENT_SLUG}`);
  await page.locator("h1").waitFor({ state: "visible" });
  await page.keyboard.press(testInfo.project.name === "desktop-webkit" ? "Alt+Tab" : "Tab");
  const skipLink = page.getByRole("link", { name: "Skip to main content" });
  await expect(skipLink).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator("main")).toBeFocused();
});

test("mobile navigation opens, identifies the route, closes with Escape, and restores focus", async ({ context, page, baseURL }, testInfo) => {
  test.skip(!testInfo.project.name.startsWith("mobile"), "mobile-only shell behavior");
  await authenticate(context, "owner", baseURL ?? "http://127.0.0.1:5173");
  await page.goto(`/e/${EVENT_SLUG}/dashboard`);
  await page.locator("h1").waitFor({ state: "visible" });
  const menu = page.locator('button[aria-controls="mobile-navigation"]');
  await expect(menu).toHaveAttribute("aria-expanded", "false");
  await menu.click();
  const dialog = page.getByRole("dialog", { name: "Navigation" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("link", { name: "Onboarding" })).toHaveAttribute("aria-current", "page");
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(menu).toBeFocused();
});

test("client navigation updates title, canonical URL, current nav, and heading focus", async ({ context, page, baseURL }) => {
  await authenticate(context, "owner", baseURL ?? "http://127.0.0.1:5173");
  await page.goto(`/e/${EVENT_SLUG}`);
  await page.getByRole("heading", { level: 1 }).waitFor({ state: "visible" });
  if (await page.locator('button[aria-controls="mobile-navigation"]').isVisible()) {
    await page.locator('button[aria-controls="mobile-navigation"]').click();
    await page.getByRole("dialog", { name: "Navigation" }).getByRole("link", { name: "Onboarding" }).click();
  } else {
    await page.getByRole("link", { name: "Onboarding" }).click();
  }
  await expect(page).toHaveURL(new RegExp(`/e/${EVENT_SLUG}/dashboard$`));
  const heading = page.getByRole("heading", { level: 1, name: "Speaker readiness" });
  await expect(heading).toBeFocused();
  await expect(page).toHaveTitle("Speaker readiness — Session Party");
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute("href", new RegExp(`/e/${EVENT_SLUG}/dashboard$`));
  await expect(page.locator('nav[aria-label="Event navigation"] a[aria-current="page"]')).toHaveText("Onboarding");
});
