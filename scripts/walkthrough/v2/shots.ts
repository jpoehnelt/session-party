import { loginAs } from "../accounts";
import type { DemoRole } from "../types";
import type { BrowserContext } from "playwright";
import type { ShotContext, WalkthroughShot } from "./types";

const route = async (context: ShotContext, role: DemoRole, path: string) => {
  const destination = path.replace(":event", context.eventSlug);
  const authKey = `auth:${role}`;
  const cached = context.state.get(authKey);
  if (cached) {
    const storage = JSON.parse(cached) as { readonly cookies: Parameters<BrowserContext["addCookies"]>[0] };
    await context.page.context().addCookies(storage.cookies);
    await context.page.goto(`${context.baseUrl}${destination}`, { waitUntil: "domcontentloaded" });
    if (!context.page.url().includes("/login")) {
      await context.page.waitForLoadState("networkidle");
      return;
    }
    context.state.delete(authKey);
  }
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      await loginAs(context.page, context.baseUrl, role, destination);
      context.state.set(authKey, JSON.stringify(await context.page.context().storageState()));
      lastError = undefined;
      break;
    } catch (error) {
      lastError = error;
      if (attempt < 3) await context.page.waitForTimeout(1_200);
    }
  }
  if (lastError) throw lastError;
  await context.page.goto(`${context.baseUrl}${destination}`, { waitUntil: "networkidle" });
};

const hold = (context: ShotContext, milliseconds = 2_800) => context.pause(milliseconds);

export const shots: readonly WalkthroughShot[] = [
  {
    id: "organizer-overview",
    chapter: "Orientation",
    title: "One event operations workspace",
    durationSeconds: 10,
    shortSeconds: 4,
    async prepare(context) {
      await route(context, "organizer", "/e/:event/dashboard");
      await context.anchor(context.page.locator("h1").first(), 0.22);
    },
    async capture(context) {
      await context.trace({ action: "Inspect event readiness", operation: "portal.getDashboard", state: "Event-scoped D1 read model → named task progress" });
      await context.focus(context.page.locator("h1").first(), "Organizer workspace");
      await hold(context, 3_000);
      await context.clearFocus();
      const attention = context.page.getByRole("checkbox", { name: /Needs attention only/i });
      if (await attention.count()) await context.click(attention, "Filter unresolved work");
      await hold(context, 2_800);
    },
  },
  {
    id: "cfp-builder",
    chapter: "Proposal intake",
    title: "A published, routed CFP",
    durationSeconds: 14,
    shortSeconds: 5,
    async prepare(context) {
      await route(context, "organizer", "/e/:event/forms");
      const primary = context.page.getByText(/Call for proposals/i).first();
      await primary.waitFor({ state: "visible" });
      await primary.click();
      await context.page.waitForURL(/formId=/);
      const formId = new URL(context.page.url()).searchParams.get("formId");
      if (!formId) throw new Error("CFP builder did not expose its form ID");
      context.state.set("formId", formId);
      await context.anchor(context.page.locator("h1").first(), 0.2);
    },
    async capture(context) {
      await context.trace({ action: "Inspect the published form version", operation: "forms.get / forms.publish", state: "Semantic field roles → immutable versioned definition" });
      await context.focus(context.page.locator("h1").first(), "Primary CFP");
      await hold(context, 3_000);
      await context.clearFocus();
      const routing = context.page.getByText("Proposal routing map", { exact: true }).first();
      if (await routing.count()) await context.focus(routing, "Typed routing and conditional rules");
      await hold(context, 3_000);
      await context.clearFocus();
      const publish = context.page.getByRole("button", { name: /Publish|Close|Reopen/i }).first();
      if (await publish.count()) await context.focus(publish, "Explicit lifecycle control");
      await hold(context, 2_800);
    },
  },
  {
    id: "public-cfp",
    chapter: "Proposal intake",
    title: "Conditional public submission",
    durationSeconds: 14,
    shortSeconds: 6,
    async prepare(context) {
      let formId = context.state.get("formId");
      if (!formId) {
        await route(context, "organizer", "/e/:event/forms");
        const primary = context.page.getByText(/Call for proposals/i).first();
        await primary.click();
        await context.page.waitForURL(/formId=/);
        formId = new URL(context.page.url()).searchParams.get("formId") ?? undefined;
        if (formId) context.state.set("formId", formId);
      }
      if (!formId) throw new Error("The primary CFP did not expose a public form ID");
      await context.page.goto(`${context.baseUrl}/submit/${context.eventSlug}/${encodeURIComponent(formId)}`, { waitUntil: "networkidle" });
      await context.anchor(context.page.locator("h1").first(), 0.18);
    },
    async capture(context) {
      await context.trace({ action: "Route a workshop proposal", operation: "submit.create", state: "Effect Schema validation → durable abuse budget → D1" });
      const title = context.page.getByLabel(/Session title/i).first();
      if (await title.count()) {
        await context.focus(title, "Canonical title field");
        await title.fill("Taming 40-Minute CI: Incremental Builds at Monorepo Scale");
      }
      await hold(context, 2_000);
      await context.clearFocus();
      const format = context.page.getByLabel("Session format");
      if (await format.count()) {
        const label = (await format.locator("option").allTextContents()).find((value) => /workshop/i.test(value));
        if (label) await format.selectOption({ label });
      }
      const conditional = context.page.getByText("Workshop prerequisites", { exact: true });
      if (await conditional.count()) await context.focus(conditional, "Conditional branch resolved");
      await hold(context, 3_200);
      await context.clearFocus();
      const disclosure = context.page.getByText(/Demo verification disabled/i);
      if (await disclosure.count()) await context.focus(disclosure, "Hackathon-only verification policy");
      await hold(context, 2_800);
    },
  },
  {
    id: "submission-board",
    chapter: "Proposal intake",
    title: "Organizer submission management",
    durationSeconds: 12,
    shortSeconds: 4,
    async prepare(context) {
      await route(context, "organizer", "/e/:event/submissions");
      await context.anchor(context.page.getByRole("heading", { name: "Submission board" }), 0.2);
    },
    async capture(context) {
      await context.trace({ action: "Filter and inspect proposals", operation: "submit.list", state: "Paginated event boundary → versioned proposal records" });
      await context.focus(context.page.getByRole("heading", { name: "Submission board" }), "Submission queue");
      await hold(context, 3_000);
      await context.clearFocus();
      const queue = context.page.getByText("Queue controls", { exact: true });
      if (await queue.count()) await context.focus(queue, "Search and status filters");
      await hold(context, 3_200);
      await context.clearFocus();
    },
  },
  {
    id: "review-workbench",
    chapter: "Review and decisions",
    title: "Blind review with human authority",
    durationSeconds: 18,
    shortSeconds: 7,
    async prepare(context) {
      await route(context, "reviewer", "/e/:event/review");
      const target = context.page.getByRole("button", { name: /Taming 40-Minute CI/i }).first();
      if (await target.count()) await target.click();
      await context.anchor(context.page.getByRole("heading", { name: "Proposal review" }), 0.18);
    },
    async capture(context) {
      await context.trace({ action: "Review assigned evidence", operation: "review.getWorkbench / review.saveScore", state: "Blind role projection → separate human and AI evidence rows" });
      await context.focus(context.page.getByRole("heading", { name: "Proposal review" }), "Reviewer-only workspace");
      await hold(context, 3_200);
      await context.clearFocus();
      const ai = context.page.getByRole("button", { name: /Request AI suggestion/i });
      if (await ai.count()) await context.focus(ai, "Optional labeled AI draft");
      await hold(context, 3_200);
      await context.clearFocus();
      const save = context.page.getByRole("button", { name: /Save my review/i });
      if (await save.count()) await context.focus(save, "Human commit boundary");
      await hold(context, 3_600);
      await context.clearFocus();
    },
  },
  {
    id: "speaker-tasks",
    chapter: "Speaker production",
    title: "Accepted session and dated tasks",
    durationSeconds: 16,
    shortSeconds: 6,
    async prepare(context) {
      await route(context, "speaker", "/e/:event/portal");
      const accepted = context.page.getByText(/Taming 40-Minute CI/i).first();
      await context.anchor((await accepted.count()) ? accepted : context.page.locator("h1").first(), 0.22);
    },
    async capture(context) {
      await context.trace({ action: "Complete speaker production work", operation: "portal.getSnapshot / portal.setTaskCompletion", state: "Accepted identity → session-scoped tasks, dates, and readiness" });
      const accepted = context.page.getByText(/Taming 40-Minute CI/i).first();
      if (await accepted.count()) await context.focus(accepted, "Accepted session");
      await hold(context, 3_000);
      await context.clearFocus();
      const task = context.page.getByText(/Confirm participation/i).first();
      if (await task.count()) await context.focus(task, "Persisted task and deadline");
      await hold(context, 3_500);
      await context.clearFocus();
    },
  },
  {
    id: "speaker-assets",
    chapter: "Speaker production",
    title: "Versioned files and cross-role comments",
    durationSeconds: 16,
    shortSeconds: 6,
    async prepare(context) {
      await route(context, "speaker", "/e/:event/portal");
      await context.anchor(context.page.getByText("Production files", { exact: true }), 0.24);
    },
    async capture(context) {
      await context.trace({ action: "Inspect the production asset", operation: "portal.uploadAsset / portal.addContentComment", state: "R2 object + D1 version, owner, task, and comment thread" });
      const uploaded = context.page.getByText(/(slides\.pdf|headshot\.png|\.pdf$|\.png$)/i).first();
      if (await uploaded.count()) await context.focus(uploaded, "Persisted file after reload");
      await hold(context, 3_200);
      await context.clearFocus();
      const comments = context.page.locator("ul[aria-label^='Comments for']").first();
      if (await comments.count()) await context.focus(comments, "Speaker ↔ organizer thread");
      else {
        const comment = context.page.getByLabel(/Add comment to/i).first();
        if (await comment.count()) await context.focus(comment, "Role-attributed asset comments");
      }
      await hold(context, 3_800);
      await context.clearFocus();
    },
  },
  {
    id: "content-history",
    chapter: "Production operations",
    title: "Content versions and restore history",
    durationSeconds: 12,
    shortSeconds: 4,
    async prepare(context) {
      await route(context, "organizer", "/e/:event/content");
      await context.anchor(context.page.getByText("Content library", { exact: true }), 0.2);
    },
    async capture(context) {
      await context.trace({ action: "Inspect retained content revisions", operation: "portal.getContentLibrary", state: "Latest asset projection + immutable prior versions in R2" });
      await context.focus(context.page.getByText("Content library", { exact: true }), "Versioned content library");
      await hold(context, 3_000);
      await context.clearFocus();
      const versions = context.page.getByLabel("Versions").first();
      if (await versions.count()) {
        await versions.selectOption("history").catch(() => undefined);
        await context.focus(versions, "Retained history filter");
      }
      await hold(context, 3_000);
      await context.clearFocus();
    },
  },
  {
    id: "communications-history",
    chapter: "Production operations",
    title: "Durable delivery history",
    durationSeconds: 12,
    shortSeconds: 4,
    async prepare(context) {
      await route(context, "organizer", "/e/:event/comms?tab=history");
      await context.anchor(context.page.locator("h1").first(), 0.2);
    },
    async capture(context) {
      await context.trace({ action: "Audit a committed campaign", operation: "comms.listDeliveries", state: "Immutable mail snapshot → attempts, provider ID, retry evidence" });
      await context.focus(context.page.locator("h1").first(), "Communications desk");
      await hold(context, 2_800);
      await context.clearFocus();
      const history = context.page.getByText(/Delivery history/i).first();
      if (await history.count()) await context.focus(history, "Durable delivery ledger");
      await hold(context, 3_400);
      await context.clearFocus();
    },
  },
  {
    id: "integrations",
    chapter: "Production operations",
    title: "Import and sync evidence",
    durationSeconds: 12,
    shortSeconds: 4,
    async prepare(context) {
      await route(context, "organizer", "/e/:event/integrations");
      await context.anchor(context.page.getByRole("heading", { name: "Integrations" }), 0.2);
    },
    async capture(context) {
      await context.trace({ action: "Inspect connector state", operation: "integrations.getAirtableSyncStatus", state: "Airtable unavailable; Accelevents fixture stays explicitly labeled" });
      await context.focus(context.page.getByRole("heading", { name: "Integrations" }), "Connector control plane");
      await hold(context, 2_800);
      await context.clearFocus();
      const airtable = context.page.getByText("Airtable", { exact: true }).first();
      if (await airtable.count()) await context.focus(airtable, "Airtable mapping and evidence");
      await hold(context, 3_200);
      await context.clearFocus();
    },
  },
  {
    id: "agenda-handoff",
    chapter: "Agenda",
    title: "Accepted proposal becomes a talk",
    durationSeconds: 16,
    shortSeconds: 6,
    async prepare(context) {
      await route(context, "organizer", "/e/:event/agenda");
      const taming = context.page.getByText(/Taming 40-Minute CI/i).first();
      await context.anchor((await taming.count()) ? taming : context.page.locator("h1").first(), 0.3);
    },
    async capture(context) {
      await context.trace({ action: "Carry acceptance into the schedule", operation: "agenda.createTalk", state: "Title, speakers, category answer → configured track without re-entry" });
      const taming = context.page.getByText(/Taming 40-Minute CI/i).first();
      if (await taming.count()) await context.focus(taming, "Exact accepted session");
      await hold(context, 3_200);
      await context.clearFocus();
      const track = context.page.getByText(/Platform & Infra/i).first();
      if (await track.count()) await context.focus(track, "Configured track carried forward");
      await hold(context, 3_500);
      await context.clearFocus();
    },
  },
  {
    id: "agenda-conflicts",
    chapter: "Agenda",
    title: "Named conflict validation",
    durationSeconds: 12,
    shortSeconds: 5,
    async prepare(context) {
      await route(context, "organizer", "/e/:event/agenda");
      const status = context.page.getByText(/conflict/i).first();
      await context.anchor((await status.count()) ? status : context.page.locator("h1").first(), 0.25);
    },
    async capture(context) {
      await context.trace({ action: "Validate the private run of show", operation: "agenda.list / agenda.scheduleTalk", state: "Normalized speaker identity + room/time overlap graph" });
      const status = context.page.getByText(/conflict/i).first();
      if (await status.count()) await context.focus(status, "Named blocking conflicts");
      await hold(context, 3_500);
      await context.clearFocus();
      const board = context.page.getByText(/Accepted backlog/i).first();
      if (await board.count()) await context.focus(board, "Draft remains private");
      await hold(context, 2_800);
      await context.clearFocus();
    },
  },
  {
    id: "live-control",
    chapter: "Live operations",
    title: "PartyServer live state machine",
    durationSeconds: 24,
    shortSeconds: 9,
    async prepare(context) {
      await route(context, "organizer", "/e/:event/agenda");
      await context.page.getByRole("button", { name: "Open live show" }).click();
      await context.page.getByText("Live show control", { exact: true }).waitFor({ state: "visible" });
      const reset = context.page.getByRole("button", { name: "Reset" });
      if (await reset.isEnabled().catch(() => false)) await reset.click();
      await context.anchor(context.page.getByText("Live show control", { exact: true }), 0.18);
    },
    async capture(context) {
      await context.trace({ action: "Run the live session", operation: "PartySocket show/control → show/state", state: "EventRoom Durable Object — one authoritative state machine per event" });
      const session = context.page.getByLabel("Current session");
      const options = await session.locator("option").all();
      if (options.length < 2) throw new Error("No scheduled session is available for live control");
      await session.selectOption({ index: 1 });
      await context.focus(session, "Select the active session");
      await hold(context, 1_600);
      await context.clearFocus();
      await context.click(context.page.getByRole("button", { name: "Set ready" }), "Ready");
      await hold(context, 1_300);
      await context.clearFocus();
      await context.click(context.page.getByRole("button", { name: "Start", exact: true }).first(), "Start");
      await hold(context, 1_500);
      await context.clearFocus();
      await context.click(context.page.getByRole("button", { name: "Hold", exact: true }).first(), "Hold");
      await hold(context, 1_400);
      await context.clearFocus();
      await context.click(context.page.getByRole("button", { name: "Resume", exact: true }), "Resume");
      await hold(context, 2_500);
      await context.clearFocus();
    },
  },
  {
    id: "live-reconnect",
    chapter: "Live operations",
    title: "Reconnect-safe live state",
    durationSeconds: 12,
    shortSeconds: 5,
    async prepare(context) {
      await route(context, "organizer", "/e/:event/agenda");
      await context.page.reload({ waitUntil: "networkidle" });
      await context.page.getByRole("button", { name: "Open live show" }).click();
      await context.page.getByText("Live show control", { exact: true }).waitFor({ state: "visible" });
      await context.anchor(context.page.getByText("Live show control", { exact: true }), 0.18);
    },
    async capture(context) {
      await context.trace({ action: "Reconnect a fresh browser context", operation: "PartySocket reconnect → show/state", state: "Running timer and monotonic revision survive the browser" });
      const running = context.page.getByText(/running/i).first();
      if (await running.count()) await context.focus(running, "State recovered after reconnect");
      await hold(context, 4_000);
      await context.clearFocus();
      const reset = context.page.getByRole("button", { name: "Reset" });
      if (await reset.isEnabled().catch(() => false)) await reset.click();
      await hold(context, 1_800);
    },
  },
  {
    id: "publication",
    chapter: "Publication",
    title: "Immutable revision and portable outputs",
    durationSeconds: 16,
    shortSeconds: 6,
    async prepare(context) {
      await route(context, "organizer", "/e/:event/publication");
      await context.anchor(context.page.getByRole("heading", { name: "Publish the run of show" }), 0.18);
      const enabled = context.page.getByRole("listitem").filter({ hasText: /· Enabled/i }).first();
      if (await enabled.count()) {
        const path = await enabled.getByRole("link", { name: "Preview" }).getAttribute("href");
        if (path) context.state.set("embedPath", path);
      }
    },
    async capture(context) {
      await context.trace({ action: "Inspect the live audience revision", operation: "agenda.publish / publication.listEmbeds", state: "Immutable privacy-filtered snapshot → stable URL and portable feeds" });
      await context.focus(context.page.getByRole("heading", { name: "Publish the run of show" }), "Publication boundary");
      await hold(context, 3_000);
      await context.clearFocus();
      const refresh = context.page.getByRole("button", { name: /Refresh live widgets/i });
      if (await refresh.count()) await context.focus(refresh, "Refresh without changing embed URLs");
      await hold(context, 3_200);
      await context.clearFocus();
      const formats = context.page.getByText("Output formats", { exact: true });
      if (await formats.count()) {
        await context.anchor(formats, 0.38);
        await context.focus(formats, "HTML · JSON · XML · iCalendar");
      }
      await hold(context, 3_000);
      await context.clearFocus();
    },
  },
  {
    id: "public-program",
    chapter: "Public program",
    title: "Attendee search and itinerary",
    durationSeconds: 16,
    shortSeconds: 6,
    async prepare(context) {
      await context.page.goto(`${context.baseUrl}/event/${context.eventSlug}/sessions`, { waitUntil: "networkidle" });
      const firstTitle = context.page.locator("article h2").first();
      await firstTitle.waitFor({ state: "visible" });
      context.state.set("publicSessionTitle", (await firstTitle.innerText()).trim());
      await context.anchor(context.page.locator("h1").first(), 0.18);
    },
    async capture(context) {
      await context.trace({ action: "Find and save a public session", operation: "agenda.getPublished", state: "Anonymous immutable revision + browser-local itinerary" });
      const search = context.page.getByLabel("Search sessions or speakers");
      await context.focus(search, "Search the published program");
      await search.fill(context.state.get("publicSessionTitle") ?? "production patterns");
      await hold(context, 2_600);
      await context.clearFocus();
      const add = context.page.getByRole("button", { name: "Add to my schedule" }).first();
      if (await add.count()) await context.click(add, "Add to my schedule");
      await hold(context, 2_800);
      await context.clearFocus();
      const mine = context.page.getByRole("button", { name: /My schedule \(1\)/i });
      if (await mine.count()) await context.focus(mine, "Local itinerary persisted");
      await hold(context, 2_600);
      await context.clearFocus();
    },
  },
  {
    id: "public-speakers",
    chapter: "Public program",
    title: "Published speaker profiles",
    durationSeconds: 12,
    shortSeconds: 4,
    async prepare(context) {
      await context.page.goto(`${context.baseUrl}/event/${context.eventSlug}/speakers`, { waitUntil: "networkidle" });
      await context.anchor(context.page.getByRole("heading", { name: "Speakers" }), 0.18);
    },
    async capture(context) {
      await context.trace({ action: "Browse the approved speaker directory", operation: "portal.getPublicSpeakers", state: "Published names, bios, links, and R2 headshots only" });
      await context.focus(context.page.getByRole("heading", { name: "Speakers" }), "Anonymous speaker directory");
      await hold(context, 3_000);
      await context.clearFocus();
      const priya = context.page.getByText("Priya Raman", { exact: true }).first();
      if (await priya.count()) await context.focus(priya, "Same identity as the accepted session");
      await hold(context, 3_200);
      await context.clearFocus();
    },
  },
  {
    id: "stable-embed",
    chapter: "Public program",
    title: "Stable embeddable output",
    durationSeconds: 12,
    shortSeconds: 5,
    async prepare(context) {
      let path = context.state.get("embedPath");
      if (!path) {
        await route(context, "organizer", "/e/:event/publication");
        const enabled = context.page.getByRole("listitem").filter({ hasText: /· Enabled/i }).first();
        path = (await enabled.getByRole("link", { name: "Preview" }).getAttribute("href")) ?? undefined;
        if (path) context.state.set("embedPath", path);
      }
      if (!path) throw new Error("Publication did not expose an enabled embed preview");
      await context.page.goto(new URL(path, context.baseUrl).toString(), { waitUntil: "networkidle" });
      await context.anchor(context.page.locator("body"), 0.08);
    },
    async capture(context) {
      await context.trace({ action: "Render a saved embed definition", operation: "publication.getPublicEmbed", state: "Stable embed ID → enabled definition → current published revision" });
      await context.focus(context.page.locator("body"), "Portable public projection");
      await hold(context, 5_500);
      await context.clearFocus();
    },
  },
] as const;
