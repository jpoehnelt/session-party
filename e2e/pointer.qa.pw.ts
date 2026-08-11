import { expect, test, type BrowserContext, type Page, type TestInfo } from "@playwright/test";
import { loadPublicRouteFixtures } from "./helpers/public-route-fixtures";
import { installDeterministicBrowser } from "./helpers/visual-readiness";

const EVENT = "ai-engineer-sandbox";

type Persona = "public" | "owner" | "reviewer" | "speaker";

interface PointerTarget {
  readonly name: string;
  readonly path: string;
  readonly persona: Persona;
}

const SESSION_BY_PERSONA: Partial<Record<Persona, string>> = {
  owner: "demo-owner-session",
  reviewer: "demo-reviewer-session",
  speaker: "demo-speaker-session",
};

const TARGETS: readonly PointerTarget[] = [
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

const POINTER_SELECTOR = [
  'a[href]:not([href="#main-content"])',
  "button",
  "input:not([type=hidden]):not([type=file])",
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

async function registerPointerTargets(page: Page): Promise<readonly { readonly id: string; readonly description: string }[]> {
  return page.locator(POINTER_SELECTOR).evaluateAll((elements) => elements.flatMap((element, index) => {
    const html = element as HTMLElement;
    const field = element as HTMLInputElement;
    const rect = html.getBoundingClientRect();
    const style = getComputedStyle(html);
    const hidden = style.display === "none"
      || style.visibility === "hidden"
      || rect.width === 0
      || rect.height === 0
      || html.closest("[hidden], [inert], [aria-hidden=true]") !== null
      || (html.tagName !== "SUMMARY" && html.closest("details:not([open])") !== null);
    const disabled = html.matches(":disabled") || html.getAttribute("aria-disabled") === "true";
    if (hidden || disabled) return [];
    const id = `qa-pointer-${index}`;
    html.dataset.qaPointerId = id;
    const label = "labels" in field && field.labels
      ? [...field.labels].map((candidate) => candidate.textContent?.trim()).find(Boolean)
      : undefined;
    const name = html.getAttribute("aria-label")
      || label
      || html.getAttribute("title")
      || html.textContent?.replace(/\s+/g, " ").trim()
      || html.getAttribute("name")
      || html.id
      || "unnamed";
    return [{ id, description: `${html.tagName.toLowerCase()} “${name.slice(0, 100)}”` }];
  }));
}

test("every enabled stable control receives unobstructed pointer input", async ({ context, page, request, baseURL }, testInfo) => {
  test.setTimeout(300_000);
  test.skip(!["desktop-chromium", "mobile-chromium"].includes(testInfo.project.name), "Chromium desktop/mobile provide the exhaustive pointer sweep");
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
  const publicFixtures = await loadPublicRouteFixtures(request);
  const targets = [...TARGETS, {
    name: "speaker-detail",
    path: `/e/${EVENT}/speakers/${encodeURIComponent(directory.speakers[0]!.speaker.id)}`,
    persona: "owner" as const,
  }, {
    name: "public-cfp",
    path: `/submit/${EVENT}/${cfp!.id}`,
    persona: "public" as const,
  }, {
    name: "public-agenda",
    path: `/event/${EVENT}/agenda`,
    persona: "public" as const,
  }, {
    name: "public-schedule",
    path: `/event/${EVENT}/schedule`,
    persona: "public" as const,
  }, {
    name: "public-gallery",
    path: `/event/${EVENT}/gallery`,
    persona: "public" as const,
  }, {
    name: "public-session-detail",
    path: `/event/${EVENT}/sessions/${encodeURIComponent(publicFixtures.talkId)}`,
    persona: "public" as const,
  }, {
    name: "public-session-missing",
    path: `/event/${EVENT}/sessions/talk_qa_missing`,
    persona: "public" as const,
  }, {
    name: "public-speaker-detail",
    path: `/event/${EVENT}/speakers/${encodeURIComponent(publicFixtures.speakerId)}`,
    persona: "public" as const,
  }, {
    name: "public-speaker-missing",
    path: `/event/${EVENT}/speakers/speaker_qa_missing`,
    persona: "public" as const,
  }, {
    name: "public-gallery-detail",
    path: `/event/${EVENT}/gallery/${encodeURIComponent(publicFixtures.speakerId)}`,
    persona: "public" as const,
  }, {
    name: "persisted-embed",
    path: `/embed/${EVENT}/${encodeURIComponent(publicFixtures.embedId)}`,
    persona: "public" as const,
  }, {
    name: "persisted-embed-unavailable",
    path: `/embed/${EVENT}/embed_qa_missing`,
    persona: "public" as const,
  }];

  const evidence: { readonly target: string; readonly path: string; readonly pointerTargets: number }[] = [];
  for (const target of targets) {
    await authenticate(context, target.persona, runtimeBaseURL);
    const response = await page.goto(target.path, { waitUntil: "domcontentloaded" });
    expect(response?.status(), target.path).toBeLessThan(400);
    await page.getByRole("heading", { level: 1 }).waitFor({ state: "visible", timeout: 45_000 });
    await page.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => undefined);
    const controls = await registerPointerTargets(page);
    const blocked: string[] = [];
    for (const control of controls) {
      const locator = page.locator(`[data-qa-pointer-id="${control.id}"]`);
      try {
        await locator.click({ trial: true, timeout: 5_000 });
      } catch {
        blocked.push(control.description);
      }
    }
    expect(blocked, `${target.path} has enabled controls that cannot receive pointer input`).toEqual([]);
    evidence.push({ target: target.name, path: target.path, pointerTargets: controls.length });
  }

  await testInfo.attach("pointer-control-reconciliation", {
    body: Buffer.from(JSON.stringify(evidence, null, 2)),
    contentType: "application/json",
  });
});
