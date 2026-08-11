import { expect, test, type BrowserContext, type Page, type TestInfo } from "@playwright/test";
import { installDeterministicBrowser } from "./helpers/visual-readiness";

const EVENT = "ai-engineer-sandbox";

type Persona = "public" | "owner" | "reviewer" | "speaker";

interface KeyboardTarget {
  readonly name: string;
  readonly path: string;
  readonly persona: Persona;
}

const SESSION_BY_PERSONA: Partial<Record<Persona, string>> = {
  owner: "demo-owner-session",
  reviewer: "demo-reviewer-session",
  speaker: "demo-speaker-session",
};

const TARGETS: readonly KeyboardTarget[] = [
  { name: "landing", path: "/", persona: "public" },
  { name: "login", path: "/login", persona: "public" },
  { name: "events", path: "/events", persona: "owner" },
  { name: "overview", path: `/e/${EVENT}`, persona: "owner" },
  { name: "forms", path: `/e/${EVENT}/forms`, persona: "owner" },
  { name: "submissions", path: `/e/${EVENT}/submissions`, persona: "owner" },
  { name: "review", path: `/e/${EVENT}/review`, persona: "reviewer" },
  { name: "onboarding", path: `/e/${EVENT}/dashboard`, persona: "owner" },
  { name: "speakers", path: `/e/${EVENT}/speakers`, persona: "owner" },
  { name: "tasks", path: `/e/${EVENT}/tasks`, persona: "owner" },
  { name: "resources", path: `/e/${EVENT}/resources`, persona: "owner" },
  { name: "content", path: `/e/${EVENT}/content`, persona: "owner" },
  { name: "agenda", path: `/e/${EVENT}/agenda`, persona: "owner" },
  { name: "communications", path: `/e/${EVENT}/comms`, persona: "owner" },
  { name: "publication", path: `/e/${EVENT}/publication`, persona: "owner" },
  { name: "exports", path: `/e/${EVENT}/exports`, persona: "owner" },
  { name: "integrations", path: `/e/${EVENT}/integrations`, persona: "owner" },
  { name: "settings", path: `/e/${EVENT}/settings`, persona: "owner" },
  { name: "speaker-portal", path: `/e/${EVENT}/portal`, persona: "speaker" },
  { name: "reusable-speaker-profile", path: "/speaker/profile", persona: "speaker" },
  { name: "my-submissions", path: `/portal/events/${EVENT}/submissions`, persona: "speaker" },
  { name: "public-program", path: `/event/${EVENT}`, persona: "public" },
  { name: "public-sessions", path: `/event/${EVENT}/sessions`, persona: "public" },
  { name: "public-speakers", path: `/event/${EVENT}/speakers`, persona: "public" },
  { name: "public-reusable-speaker-profile", path: "/speakers/priya-raman", persona: "public" },
  { name: "schedule-embed", path: `/embed/${EVENT}/schedule`, persona: "public" },
  { name: "speaker-embed", path: `/embed/${EVENT}/speakers`, persona: "public" },
  { name: "reviewer-invitation-invalid", path: "/reviewer-invitations/accept", persona: "public" },
  { name: "not-found", path: "/qa-route-that-does-not-exist", persona: "public" },
] as const;

const INTERACTIVE_SELECTOR = [
  "a[href]",
  "button",
  "input:not([type=hidden])",
  "select",
  "textarea",
  "summary",
  "iframe",
  "[contenteditable=true]",
  "[role=button]",
  "[role=link]",
  "[role=tab]",
  "[role=checkbox]",
  "[role=radio]",
  "[role=switch]",
  "[role=menuitem]",
  "[tabindex]",
].join(",");

async function authenticate(context: BrowserContext, persona: Persona, baseURL: string): Promise<void> {
  await context.clearCookies();
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

async function registerTabStops(page: Page): Promise<readonly { readonly id: string; readonly description: string }[]> {
  return page.locator(INTERACTIVE_SELECTOR).evaluateAll((elements) => elements.flatMap((element, index) => {
    const html = element as HTMLElement;
    const field = element as HTMLInputElement;
    if (html.getAttribute("role") === "tablist") return [];
    let id = `qa-tab-${index}`;
    if (field instanceof HTMLInputElement && field.type === "radio" && field.name) {
      const group = elements.filter((candidate): candidate is HTMLInputElement =>
        candidate instanceof HTMLInputElement
        && candidate.type === "radio"
        && candidate.name === field.name
        && !candidate.matches(":disabled"));
      const groupTabStop = group.find((candidate) => candidate.checked) ?? group[0];
      id = `qa-tab-radio-${elements.indexOf(group[0]!)}`;
      for (const candidate of group) candidate.dataset.qaTabId = id;
      if (field !== groupTabStop) return [];
    }
    const rect = html.getBoundingClientRect();
    const style = getComputedStyle(html);
    const hidden = style.display === "none"
      || style.visibility === "hidden"
      || rect.width === 0
      || rect.height === 0
      || html.closest("[hidden], [inert], [aria-hidden=true]") !== null
      || (html.tagName !== "SUMMARY" && html.closest("details:not([open])") !== null);
    const disabled = html.matches(":disabled") || html.getAttribute("aria-disabled") === "true";
    if (hidden || disabled || html.tabIndex < 0) return [];
    html.dataset.qaTabId = id;
    const name = html.getAttribute("aria-label")
      || html.getAttribute("title")
      || html.textContent?.replace(/\s+/g, " ").trim()
      || html.getAttribute("name")
      || html.id
      || "unnamed";
    return [{ id, description: `${html.tagName.toLowerCase()} “${name.slice(0, 100)}”` }];
  }));
}

async function traverseTabStops(page: Page, expected: readonly { readonly id: string; readonly description: string }[]) {
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    window.scrollTo(0, 0);
  });
  const observed = new Set<string>();
  for (let index = 0; index < expected.length * 2 + 20 && observed.size < expected.length; index += 1) {
    await page.keyboard.press("Tab");
    const id = await page.evaluate(() => {
      const active = document.activeElement as HTMLElement | null;
      return active?.dataset.qaTabId ?? null;
    });
    if (id) observed.add(id);
  }
  return expected.filter(({ id }) => !observed.has(id));
}

test("every stable interactive control is reachable in the sequential Tab order", async ({ context, page, request, baseURL }, testInfo) => {
  test.setTimeout(300_000);
  test.skip(!["desktop-chromium", "mobile-chromium"].includes(testInfo.project.name), "Chromium desktop/mobile provide the exhaustive keyboard sweep");
  const runtimeBaseURL = baseURL ?? "http://127.0.0.1:5173";
  await installDeterministicBrowser(page);
  await page.route(/^https:\/\/(?:www\.)?youtube(?:-nocookie)?\.com\//, (route) => route.fulfill({
    body: "<!doctype html><title>Deterministic embedded video</title>",
    contentType: "text/html",
    status: 200,
  }));

  const formsResponse = await request.get("/api/v1/events/demo-event/forms", {
    headers: { Cookie: "sp_session=demo-owner-session" },
  });
  expect(formsResponse.status()).toBe(200);
  const forms = await formsResponse.json() as readonly { readonly id: string; readonly purpose: string }[];
  const cfp = forms.find(({ purpose }) => purpose === "primary-cfp");
  expect(cfp).toBeDefined();
  const directoryResponse = await request.get(`/api/v1/events/demo-event/portal/speakers`, {
    headers: { Cookie: "sp_session=demo-owner-session" },
  });
  expect(directoryResponse.status()).toBe(200);
  const directory = await directoryResponse.json() as { readonly speakers: readonly { readonly speaker: { readonly id: string } }[] };
  expect(directory.speakers.length).toBeGreaterThan(0);
  const targets = [...TARGETS, {
    name: "speaker-detail",
    path: `/e/${EVENT}/speakers/${encodeURIComponent(directory.speakers[0]!.speaker.id)}`,
    persona: "owner" as const,
  }, {
    name: "public-cfp",
    path: `/submit/${EVENT}/${cfp!.id}`,
    persona: "public" as const,
  }];

  const evidence: { readonly target: string; readonly path: string; readonly tabStops: number }[] = [];
  for (const target of targets) {
    await authenticate(context, target.persona, runtimeBaseURL);
    const response = await page.goto(target.path, { waitUntil: "domcontentloaded" });
    expect(response?.status(), target.path).toBeLessThan(400);
    await page.getByRole("heading", { level: 1 }).waitFor({ state: "visible", timeout: 45_000 });
    await page.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => undefined);
    const expected = await registerTabStops(page);
    const missing = await traverseTabStops(page, expected);
    expect(missing, `${target.path} has controls missing from sequential keyboard navigation`).toEqual([]);
    evidence.push({ target: target.name, path: target.path, tabStops: expected.length });
  }

  await testInfo.attach("keyboard-control-reconciliation", {
    body: Buffer.from(JSON.stringify(evidence, null, 2)),
    contentType: "application/json",
  });
});
