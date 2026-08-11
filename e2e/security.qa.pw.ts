import { expect, test, type APIRequestContext, type BrowserContext, type TestInfo } from "@playwright/test";
import axe from "axe-core";

const EVENT_ID = "demo-event";
const EVENT_SLUG = "ai-engineer-sandbox";

const sessions = {
  owner: "demo-owner-session",
  admin: "demo-admin-session",
  reviewer: "demo-reviewer-session",
  speaker: "demo-speaker-session",
  observer: "demo-observer-session",
  expired: "demo-expired-session",
} as const;

function desktopOnly(testInfo: TestInfo): void {
  test.skip(testInfo.project.name !== "desktop-chromium", "API authorization matrix is browser-independent");
}

function cookie(session?: string): Record<string, string> | undefined {
  return session ? { Cookie: `sp_session=${encodeURIComponent(session)}` } : undefined;
}

async function getJson(request: APIRequestContext, path: string, session?: string): Promise<{
  readonly status: number;
  readonly body: unknown;
}> {
  const response = await request.get(path, { headers: cookie(session) });
  return {
    status: response.status(),
    body: await response.json().catch(() => response.text()),
  };
}

function expectSafeDenial(status: number, body: unknown): void {
  expect([401, 403, 404]).toContain(status);
  const serialized = JSON.stringify(body);
  expect(serialized).not.toMatch(/stack|cause|session_secret|api[_-]?key|token_hash|password/i);
}

function collectKeys(value: unknown, keys = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, keys);
  } else if (value !== null && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      keys.add(key);
      collectKeys(item, keys);
    }
  }
  return keys;
}

async function setSession(context: BrowserContext, baseURL: string, session?: string): Promise<void> {
  await context.clearCookies();
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

async function seriousAccessibilityViolations(page: import("@playwright/test").Page): Promise<readonly string[]> {
  await page.addScriptTag({ content: axe.source });
  const violations = await page.evaluate(async () => {
    const runtime = (window as typeof window & { axe: typeof axe }).axe;
    const results = await runtime.run(document, {
      runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] },
      resultTypes: ["violations"],
    });
    return results.violations
      .filter(({ impact }) => impact === "critical" || impact === "serious")
      .map(({ id }) => id);
  });
  return [...new Set(violations)].sort();
}

test("private REST surfaces reject signed-out, expired, malformed, and non-member sessions", async ({ request }, testInfo) => {
  desktopOnly(testInfo);
  const privatePaths = [
    `/api/v1/events/${EVENT_SLUG}`,
    `/api/v1/events/${EVENT_ID}/forms`,
    `/api/v1/events/${EVENT_ID}/review`,
    `/api/v1/events/${EVENT_ID}/portal/speakers`,
    `/api/v1/events/${EVENT_ID}/api-keys`,
  ];
  for (const path of privatePaths) {
    for (const session of [undefined, sessions.expired, "malformed-%-session", sessions.observer]) {
      const response = await getJson(request, path, session);
      expectSafeDenial(response.status, response.body);
    }
  }
});

test("owner, admin, reviewer, and speaker receive only their intended REST surfaces", async ({ request }, testInfo) => {
  desktopOnly(testInfo);

  const allowed = [
    [sessions.owner, `/api/v1/events/${EVENT_ID}/forms`],
    [sessions.owner, `/api/v1/events/${EVENT_ID}/portal/speakers`],
    [sessions.owner, `/api/v1/events/${EVENT_ID}/api-keys`],
    [sessions.admin, `/api/v1/events/${EVENT_ID}/forms`],
    [sessions.admin, `/api/v1/events/${EVENT_ID}/portal/speakers`],
    [sessions.admin, `/api/v1/events/${EVENT_ID}/api-keys`],
    [sessions.reviewer, `/api/v1/events/${EVENT_ID}/review`],
    [sessions.speaker, `/api/v1/events/${EVENT_SLUG}/portal`],
  ] as const;
  for (const [session, path] of allowed) {
    const response = await getJson(request, path, session);
    expect(response.status, `${path} should be available to its intended persona`).toBe(200);
  }

  const denied = [
    [sessions.reviewer, `/api/v1/events/${EVENT_ID}/forms`],
    [sessions.reviewer, `/api/v1/events/${EVENT_ID}/portal/speakers`],
    [sessions.reviewer, `/api/v1/events/${EVENT_ID}/api-keys`],
    [sessions.speaker, `/api/v1/events/${EVENT_ID}/forms`],
    [sessions.speaker, `/api/v1/events/${EVENT_ID}/review`],
    [sessions.speaker, `/api/v1/events/${EVENT_ID}/api-keys`],
  ] as const;
  for (const [session, path] of denied) {
    const response = await getJson(request, path, session);
    expectSafeDenial(response.status, response.body);
  }
});

test("private organizer UI fails closed for signed-out, expired, and other-event identities", async ({ baseURL, context, page }, testInfo) => {
  desktopOnly(testInfo);
  const runtimeBaseURL = baseURL ?? "http://127.0.0.1:5173";
  for (const session of [undefined, sessions.expired, sessions.observer]) {
    await setSession(context, runtimeBaseURL, session);
    await page.goto(`/e/${EVENT_SLUG}/forms`);
    await page.getByRole("heading", { level: 1 }).waitFor({ state: "visible" });
    await expect(page.getByText("Event form studio")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "New additional form" })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: /Sign in|Event not found|Could not load/i })).toBeVisible();
  }
});

test("every signed-out organizer route renders a truthful top-level error heading", async ({ baseURL, context, page }, testInfo) => {
  desktopOnly(testInfo);
  await setSession(context, baseURL ?? "http://127.0.0.1:5173");
  const paths = [
    "",
    "/forms",
    "/submissions",
    "/review",
    "/dashboard",
    "/speakers",
    "/tasks",
    "/resources",
    "/agenda",
    "/comms",
    "/publication",
    "/exports",
    "/integrations",
    "/settings",
  ];
  const failures: { readonly path: string; readonly h1Count: number; readonly title: string; readonly a11y: readonly string[] }[] = [];
  for (const suffix of paths) {
    const path = `/e/${EVENT_SLUG}${suffix}`;
    await page.goto(path, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(250);
    const h1Count = await page.locator("h1").count();
    const a11y = await seriousAccessibilityViolations(page);
    if (h1Count !== 1 || a11y.length > 0) failures.push({ path, h1Count, title: await page.title(), a11y });
    await expect(page.getByText(/sbek-organizer@example\.com/)).toHaveCount(0);
  }
  expect(failures, "signed-out route states must expose exactly one H1").toEqual([]);
});

test("published agenda and speaker projections exclude private operational data", async ({ request }, testInfo) => {
  desktopOnly(testInfo);
  const publicPaths = [
    `/api/v1/public/events/${EVENT_SLUG}/agenda/published`,
    `/api/v1/public/events/${EVENT_SLUG}/speakers`,
  ];
  const forbiddenKeys = /^(email|contactEmail|review|reviews|score|rationale|tasks|assets|audit|apiKey|secret|token|integration)$/i;
  for (const path of publicPaths) {
    const response = await getJson(request, path);
    expect(response.status).toBe(200);
    expect([...collectKeys(response.body)].filter((key) => forbiddenKeys.test(key))).toEqual([]);
    const serialized = JSON.stringify(response.body);
    expect(serialized).not.toMatch(/sbek-(organizer|reviewer|speaker)@|@sessionparty\.local/i);
    expect(serialized).not.toMatch(/demo-(owner|reviewer|admin|observer)-session/i);
  }
});

test("public projection matches the immutable published revision rather than private drafts", async ({ request }, testInfo) => {
  desktopOnly(testInfo);
  const privateAgenda = await getJson(request, `/api/v1/events/${EVENT_ID}/agenda?view=day`, sessions.owner);
  const publicAgenda = await getJson(request, `/api/v1/public/events/${EVENT_SLUG}/agenda/published`);
  expect(privateAgenda.status).toBe(200);
  expect(publicAgenda.status).toBe(200);

  const privateValue = privateAgenda.body as {
    readonly publication?: { readonly revision?: number; readonly talkCount?: number };
  };
  const publicValue = publicAgenda.body as {
    readonly revision?: number;
    readonly talks?: readonly unknown[];
  };
  expect(publicValue.revision).toBe(privateValue.publication?.revision);
  expect(publicValue.talks).toHaveLength(privateValue.publication?.talkCount ?? -1);
  expect(publicValue.revision).toBeGreaterThan(0);
});

test("hostile login return targets stay on the Session Party origin", async ({ baseURL, page }, testInfo) => {
  desktopOnly(testInfo);
  await page.goto(`/login?returnTo=${encodeURIComponent("https://example.invalid/steal")}`);
  await page.getByRole("button", { name: /Continue as Organizer/ }).click();
  await page.waitForURL(new RegExp(`/e/${EVENT_SLUG}/dashboard$`));
  expect(new URL(page.url()).origin).toBe(new URL(baseURL ?? "http://127.0.0.1:5173").origin);
});
