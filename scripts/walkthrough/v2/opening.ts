import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Browser, BrowserContext, Page } from "playwright";
import { loginAs } from "../accounts";
import type { DemoRole } from "../types";
import type { RecordedOpeningView } from "./types";

type OpeningRole = DemoRole | "public";

type OpeningView = {
  readonly id: string;
  readonly role: OpeningRole;
  readonly path: string;
  readonly tab?: string;
  readonly tabIndex?: number;
  readonly text?: string;
  readonly clickText?: string;
  readonly buttonText?: string;
  readonly checkLabel?: string;
  readonly fillLabel?: string;
  readonly fillValue?: string;
  readonly scrollRatio?: number;
  readonly linkIncludes?: string;
  readonly linkIndex?: number;
};

// A dedicated view list prevents the opening from cycling the same proof shots.
// Repeated routes use a visibly distinct tab, detail record, filter, or region.
const openingViews: readonly OpeningView[] = [
  { id: "landing", role: "public", path: "/" },
  { id: "events-home", role: "organizer", path: "/events" },
  { id: "public-sessions", role: "public", path: "/event/:event/sessions" },
  { id: "event-overview", role: "organizer", path: "/e/:event" },
  { id: "public-speakers", role: "public", path: "/event/:event/speakers" },
  { id: "forms", role: "organizer", path: "/e/:event/forms" },
  { id: "public-agenda", role: "public", path: "/event/:event/agenda" },
  { id: "submissions", role: "organizer", path: "/e/:event/submissions" },
  { id: "public-schedule", role: "public", path: "/event/:event/schedule" },
  { id: "reviewer-workbench", role: "reviewer", path: "/e/:event/review" },
  { id: "public-gallery", role: "public", path: "/event/:event/gallery" },
  { id: "onboarding-dashboard", role: "organizer", path: "/e/:event/dashboard" },
  { id: "speaker-portal", role: "speaker", path: "/e/:event/portal" },
  { id: "speaker-directory", role: "organizer", path: "/e/:event/speakers" },
  { id: "public-session-one", role: "public", path: "/event/:event/sessions", linkIncludes: "/sessions/", linkIndex: 0 },
  { id: "task-workflow", role: "organizer", path: "/e/:event/tasks" },
  { id: "public-speaker-one", role: "public", path: "/event/:event/speakers", linkIncludes: "/speakers/", linkIndex: 0 },
  { id: "resources", role: "organizer", path: "/e/:event/resources" },
  { id: "content-library", role: "organizer", path: "/e/:event/content" },
  { id: "public-session-search", role: "public", path: "/event/:event/sessions?q=agent" },
  { id: "agenda-day", role: "organizer", path: "/e/:event/agenda", tab: "Day" },
  { id: "comms-templates", role: "organizer", path: "/e/:event/comms?tab=templates" },
  { id: "public-speaker-search", role: "public", path: "/event/:event/speakers?q=Priya" },
  { id: "publication", role: "organizer", path: "/e/:event/publication" },
  { id: "reusable-profile", role: "speaker", path: "/speaker/profile" },
  { id: "exports", role: "organizer", path: "/e/:event/exports" },
  { id: "integrations", role: "organizer", path: "/e/:event/integrations" },
  { id: "settings", role: "organizer", path: "/e/:event/settings" },
  { id: "comms-audience", role: "organizer", path: "/e/:event/comms?tab=send" },
  { id: "agenda-list", role: "organizer", path: "/e/:event/agenda", tab: "List" },
  { id: "portal-files", role: "speaker", path: "/e/:event/portal", text: "Production files" },
  { id: "public-agenda-day-two", role: "public", path: "/event/:event/agenda", tabIndex: 1 },
  { id: "review-organizer", role: "organizer", path: "/e/:event/review", text: "Assign filtered proposals" },
  { id: "form-settings", role: "organizer", path: "/e/:event/forms", buttonText: "Accepted speaker" },
  { id: "readiness-matrix", role: "organizer", path: "/e/:event/dashboard", checkLabel: "Needs attention only" },
  { id: "speaker-proposals", role: "speaker", path: "/portal/events/:event/submissions" },
  { id: "public-schedule-day-two", role: "public", path: "/event/:event/schedule", tabIndex: 1 },
  { id: "agenda-week", role: "organizer", path: "/e/:event/agenda", tab: "Week" },
  { id: "comms-history", role: "organizer", path: "/e/:event/comms?tab=history" },
  { id: "publication-embeds", role: "organizer", path: "/e/:event/publication", text: "Embed" },
  { id: "speaker-detail", role: "organizer", path: "/e/:event/dashboard", linkIncludes: "/speakers/", linkIndex: 0 },
  { id: "public-session-two", role: "public", path: "/event/:event/sessions", linkIncludes: "/sessions/", linkIndex: 1 },
  { id: "public-speaker-two", role: "public", path: "/event/:event/speakers", linkIncludes: "/speakers/", linkIndex: 1 },
  { id: "agenda-track", role: "organizer", path: "/e/:event/agenda", tab: "Track" },
  { id: "agenda-room", role: "organizer", path: "/e/:event/agenda", tab: "Room" },
  { id: "speaker-embed", role: "public", path: "/embed/:event/speakers" },
  { id: "schedule-embed", role: "public", path: "/embed/:event/schedule" },
  { id: "content-versions", role: "organizer", path: "/e/:event/content", fillLabel: "Search", fillValue: "Priya" },
  { id: "resource-library", role: "organizer", path: "/e/:event/resources", text: "Speaker production guide" },
  { id: "event-team", role: "organizer", path: "/e/:event/settings", text: "Existing account email" },
] as const;

if (openingViews.length !== 50) throw new Error(`The opening must define exactly 50 views; found ${openingViews.length}`);

const pathFor = (path: string, eventSlug: string) => path.replaceAll(":event", encodeURIComponent(eventSlug));

async function settle(page: Page) {
  await page.waitForLoadState("domcontentloaded");
  await page.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => undefined);
  await page.evaluate(async () => {
    const browserGlobal = globalThis as any;
    await browserGlobal.document.fonts.ready;
    browserGlobal.scrollTo({ top: 0, behavior: "instant" });
  });
  await page.waitForTimeout(350);
}

async function applyViewState(page: Page, view: OpeningView) {
  if (view.tab || view.tabIndex !== undefined) {
    const tab = view.tab
      ? page.getByRole("tab", { name: view.tab, exact: false }).first()
      : page.getByRole("tab").nth(view.tabIndex!);
    await tab.waitFor({ state: "visible" });
    await tab.click();
    await page.waitForTimeout(250);
  }
  if (view.linkIncludes) {
    const links = page.locator(`a[href*="${view.linkIncludes}"]`);
    await links.first().waitFor({ state: "visible" });
    const hrefs = [...new Set((await links.evaluateAll((nodes) => nodes.map((node: any) => node.href as string))).filter(Boolean))];
    const href = hrefs[view.linkIndex ?? 0];
    if (!href) throw new Error(`${view.id} could not find unique link ${view.linkIndex ?? 0} matching ${view.linkIncludes}`);
    await page.goto(href, { waitUntil: "domcontentloaded" });
    await settle(page);
  }
  if (view.clickText) {
    const target = page.getByText(view.clickText, { exact: false }).first();
    await target.waitFor({ state: "visible" });
    await target.click();
    await page.waitForTimeout(300);
  }
  if (view.buttonText) {
    const target = page.getByRole("button", { name: view.buttonText, exact: false }).first();
    await target.waitFor({ state: "visible" });
    await target.click();
    await page.waitForTimeout(300);
  }
  if (view.checkLabel) {
    const target = page.getByLabel(view.checkLabel, { exact: false }).first();
    await target.waitFor({ state: "visible" });
    await target.check();
    await page.waitForTimeout(300);
  }
  if (view.fillLabel) {
    const target = page.getByLabel(view.fillLabel, { exact: false }).first();
    await target.waitFor({ state: "visible" });
    await target.fill(view.fillValue ?? "");
    await page.waitForTimeout(300);
  }
  if (view.text) {
    const target = page.getByText(view.text, { exact: false }).first();
    await target.waitFor({ state: "visible" });
    await target.scrollIntoViewIfNeeded();
    await page.waitForTimeout(200);
  }
  if (view.scrollRatio !== undefined) {
    await page.evaluate((ratio) => {
      const browserGlobal = globalThis as any;
      const max = Math.max(0, browserGlobal.document.documentElement.scrollHeight - browserGlobal.innerHeight);
      browserGlobal.scrollTo({ top: max * ratio, behavior: "instant" });
    }, view.scrollRatio);
    await page.waitForTimeout(200);
  }
}

async function createPage(browser: Browser, role: OpeningRole, baseUrl: string) {
  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    deviceScaleFactor: 1,
    colorScheme: "light",
    reducedMotion: "reduce",
  });
  await context.addInitScript(() => localStorage.setItem("session-party-walkthrough", "v2"));
  const page = await context.newPage();
  page.setDefaultTimeout(15_000);
  if (role !== "public") await loginAs(page, baseUrl, role);
  return { context, page };
}

export async function captureOpeningViews(input: {
  readonly browser: Browser;
  readonly baseUrl: string;
  readonly eventSlug: string;
  readonly outputDir: string;
  readonly startAt?: number;
}): Promise<readonly RecordedOpeningView[]> {
  const pages = new Map<OpeningRole, { readonly context: BrowserContext; readonly page: Page }>();
  const recorded: RecordedOpeningView[] = [];
  const hashes = new Map<string, string>();
  try {
    for (const [index, view] of openingViews.entries()) {
      const destination = pathFor(view.path, input.eventSlug);
      const screenshotPath = resolve(input.outputDir, "opening", `${String(index + 1).padStart(2, "0")}-${view.id}.png`);
      if (index + 1 < (input.startAt ?? 1)) {
        const sha256 = createHash("sha256").update(await readFile(screenshotPath)).digest("hex");
        const duplicate = hashes.get(sha256);
        if (duplicate) throw new Error(`Existing opening views ${duplicate} and ${view.id} contain identical pixels`);
        hashes.set(sha256, view.id);
        recorded.push({ id: view.id, path: destination, screenshotPath, sha256 });
        continue;
      }
      let holder = pages.get(view.role);
      if (!holder) {
        holder = await createPage(input.browser, view.role, input.baseUrl);
        pages.set(view.role, holder);
      }
      await holder.page.goto(`${input.baseUrl}${destination}`, { waitUntil: "domcontentloaded" });
      await settle(holder.page);
      if (holder.page.url().includes("/login")) throw new Error(`${view.id} unexpectedly reached the login page`);
      await applyViewState(holder.page, view);
      await holder.page.screenshot({ path: screenshotPath });
      const sha256 = createHash("sha256").update(await readFile(screenshotPath)).digest("hex");
      const duplicate = hashes.get(sha256);
      if (duplicate) throw new Error(`Opening views ${duplicate} and ${view.id} rendered identical pixels`);
      hashes.set(sha256, view.id);
      recorded.push({ id: view.id, path: destination, screenshotPath, sha256 });
      process.stdout.write(`Captured opening view ${recorded.length}/50: ${view.id}\n`);
    }
  } finally {
    await Promise.all([...pages.values()].map(({ context }) => context.close().catch(() => undefined)));
  }
  return recorded;
}
