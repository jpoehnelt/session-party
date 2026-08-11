import { expect, test, type BrowserContext, type Page, type TestInfo } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { installDeterministicBrowser } from "./helpers/visual-readiness";

const EVENT = "ai-engineer-sandbox";
const EVENT_ID = "demo-event";
const OWNER_SESSION = "demo-owner-session";
const ADMIN_SESSION = "demo-admin-session";
const REVIEWER_SESSION = "demo-reviewer-session";
const SPEAKER_SESSION = "demo-speaker-session";
const ADMIN_EMAIL = "admin@sessionparty.local";

async function signIn(context: BrowserContext, baseURL: string, session = OWNER_SESSION): Promise<void> {
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

async function openOwnerPage(context: BrowserContext, page: Page, baseURL: string, path: string): Promise<void> {
  await signIn(context, baseURL);
  await installDeterministicBrowser(page);
  await page.goto(`/e/${EVENT}${path}`, { waitUntil: "domcontentloaded" });
  await page.locator("h1").waitFor({ state: "visible" });
}

function desktopOnly(testInfo: TestInfo): void {
  test.skip(!testInfo.project.name.startsWith("desktop"), "covered once; route matrix provides mobile coverage");
}

function desktopChromiumOnly(testInfo: TestInfo): void {
  test.skip(testInfo.project.name !== "desktop-chromium", "clipboard permissions are exercised in desktop Chromium");
}

test("login validates email and demo personas preserve a safe return path", async ({ page }, testInfo) => {
  desktopOnly(testInfo);
  await page.goto(`/login?returnTo=${encodeURIComponent(`/e/${EVENT}/review`)}`);
  const email = page.getByRole("textbox", { name: "Email address" });
  const submit = page.getByRole("button", { name: "Email me a sign-in link" });
  await expect(email).toHaveAttribute("required", "");
  await submit.click();
  expect(await email.evaluate((field: HTMLInputElement) => field.validity.valueMissing)).toBe(true);
  await email.fill("not-an-email");
  await submit.click();
  expect(await email.evaluate((field: HTMLInputElement) => field.validity.typeMismatch)).toBe(true);
  await expect(page.getByRole("button", { name: /Continue as Organizer/ })).toBeEnabled();
  await expect(page.getByRole("button", { name: /Continue as Speaker/ })).toBeEnabled();
  await expect(page.getByRole("button", { name: /Continue as Reviewer/ })).toBeEnabled();
});

test("unknown routes provide a keyboard-operable recovery path", async ({ page }, testInfo) => {
  desktopOnly(testInfo);
  await page.goto("/qa-route-that-does-not-exist");
  await expect(page.getByRole("heading", { level: 1, name: "Page not found" })).toBeVisible();
  const recovery = page.getByRole("button", { name: "Return home" });
  await recovery.focus();
  await expect(recovery).toBeFocused();
  await recovery.press("Enter");
  await expect(page).toHaveURL("/");
  await expect(page.locator("h1")).toBeVisible();
});

test("forms additional-form dialog supports validation, Cancel, and focus return", async ({ context, page, baseURL }, testInfo) => {
  desktopOnly(testInfo);
  await openOwnerPage(context, page, baseURL ?? "http://127.0.0.1:5173", "/forms");
  const trigger = page.getByRole("button", { name: "New additional form" });
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "Create an additional form" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Create draft" })).toBeDisabled();
  await dialog.getByRole("textbox", { name: "Form name" }).fill("QA dialog validation");
  await expect(dialog.getByRole("button", { name: "Create draft" })).toBeEnabled();
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
});

test("forms builder creates every supported field type, persists edits, and deletes the disposable draft", async ({ context, page, request, baseURL }, testInfo) => {
  const runtimeBaseURL = baseURL ?? "http://127.0.0.1:5173";
  const collectionPath = `/api/v1/events/${EVENT_ID}/forms`;
  const ownerHeaders = { Cookie: `sp_session=${OWNER_SESSION}` };
  const runName = `QA builder ${testInfo.project.name} ${Date.now()}`;
  type FormDetail = Readonly<{
    id: string;
    name: string;
    purpose: string;
    status: string;
    version: number;
    publishedVersion: unknown;
    fields: readonly Readonly<{ label: string; type: string }>[];
  }>;
  const loadCreated = async (): Promise<FormDetail | undefined> => {
    const list = await request.get(collectionPath, { headers: ownerHeaders });
    expect(list.status()).toBe(200);
    const summaries = await list.json() as readonly { readonly id: string; readonly name: string }[];
    const summary = summaries.find(({ name }) => name === runName);
    if (!summary) return undefined;
    const detail = await request.get(`${collectionPath}/${summary.id}`, { headers: ownerHeaders });
    expect(detail.status()).toBe(200);
    return detail.json() as Promise<FormDetail>;
  };
  const cleanup = async (): Promise<void> => {
    const current = await loadCreated();
    if (!current) return;
    const removed = await request.delete(`${collectionPath}/${current.id}`, {
      headers: { ...ownerHeaders, "Idempotency-Key": `qa-builder-cleanup-${current.id}-${current.version}`, "If-Match": String(current.version) },
    });
    expect(removed.status()).toBe(200);
  };
  const formQueueButton = () => page.locator('aside[aria-label="Event forms"] button').filter({ hasText: runName });

  await openOwnerPage(context, page, runtimeBaseURL, "/forms");
  try {
    await page.getByRole("button", { name: "New additional form" }).click();
    const createDialog = page.getByRole("dialog", { name: "Create an additional form" });
    await createDialog.getByRole("textbox", { name: "Form name" }).fill(runName);
    await createDialog.getByRole("textbox", { name: "Description" }).fill("Disposable full builder interaction coverage — Unicode ✓");
    await createDialog.getByRole("button", { name: "Create draft" }).click();
    await expect(page.getByText("Additional form draft created.", { exact: true }).first()).toBeVisible();
    await expect(formQueueButton()).toHaveAttribute("aria-current", "page");

    const fieldTypes = [
      ["text", "QA short text"],
      ["textarea", "QA long text"],
      ["select", "QA select"],
      ["multiselect", "QA multi-select"],
      ["radio", "QA radio"],
      ["checkbox", "QA checkbox"],
      ["email", "QA email"],
      ["url", "QA URL"],
      ["date", "QA date"],
      ["heading", "QA section heading"],
      ["html", "QA guidance text"],
    ] as const;
    await page.getByLabel("Label", { exact: true }).first().fill(fieldTypes[0][1]);
    for (const [type, label] of fieldTypes.slice(1)) {
      await page.getByRole("button", { name: "+ Add field" }).click();
      await page.getByLabel("Label", { exact: true }).last().fill(label);
      await page.getByLabel("Field type", { exact: true }).last().selectOption(type);
      if (type === "select" || type === "multiselect" || type === "radio") {
        const options = page.getByLabel("Ordered options", { exact: true }).last();
        await options.fill("Alpha\nBeta\nUnicode ✓");
        await options.blur();
      }
    }

    await page.getByRole("button", { name: "+ Add field" }).click();
    await page.getByLabel("Label", { exact: true }).last().fill("QA removable field");
    await page.getByRole("button", { name: "Remove", exact: true }).last().click();
    await expect(page.getByLabel("Label", { exact: true })).toHaveCount(fieldTypes.length);

    const urlMove = page.getByRole("button", { name: "Move QA URL up" });
    await expect(urlMove).toBeEnabled();
    await urlMove.click();
    const labelsAfterMove = await page.getByLabel("Label", { exact: true }).evaluateAll((inputs) =>
      inputs.map((input) => (input as HTMLInputElement).value));
    expect(labelsAfterMove.indexOf("QA URL")).toBeLessThan(labelsAfterMove.indexOf("QA email"));

    await page.getByRole("button", { name: "Save draft" }).click();
    await expect(page.getByText("Draft saved.", { exact: true }).first()).toBeVisible();
    const saved = await loadCreated();
    expect(saved).toBeDefined();
    expect(saved!.fields).toHaveLength(fieldTypes.length);
    expect(new Set(saved!.fields.map(({ type }) => type))).toEqual(new Set(fieldTypes.map(([type]) => type)));

    await page.reload({ waitUntil: "domcontentloaded" });
    await page.locator("h1").waitFor({ state: "visible" });
    await formQueueButton().click();
    await expect(page.getByLabel("Label", { exact: true })).toHaveCount(fieldTypes.length);
    const reloadedLabels = await page.getByLabel("Label", { exact: true }).evaluateAll((inputs) =>
      inputs.map((input) => (input as HTMLInputElement).value));
    expect(reloadedLabels).toContain("QA guidance text");

    await page.getByLabel("Label", { exact: true }).first().fill("QA unsaved before new form");
    await page.getByRole("button", { name: "New additional form" }).click();
    await page.getByRole("alertdialog", { name: "Discard unsaved form changes?" }).getByRole("button", { name: "Discard changes" }).click();
    const protectedCreateDialog = page.getByRole("dialog", { name: "Create an additional form" });
    await expect(protectedCreateDialog).toBeVisible();
    await protectedCreateDialog.getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByLabel("Label", { exact: true }).first()).toHaveValue("QA short text");

    await page.getByLabel("Label", { exact: true }).first().fill("QA unsaved field edit");
    const primaryFormButton = page.locator('aside[aria-label="Event forms"] button').filter({ hasText: "Call for proposals" }).first();
    await primaryFormButton.click();
    const unsavedDialog = page.getByRole("alertdialog", { name: "Discard unsaved form changes?" });
    await expect(unsavedDialog).toBeVisible();
    await unsavedDialog.getByRole("button", { name: "Keep editing" }).click();
    await expect(page.getByLabel("Label", { exact: true }).first()).toHaveValue("QA unsaved field edit");
    await expect(formQueueButton()).toHaveAttribute("aria-current", "page");
    await primaryFormButton.click();
    await page.getByRole("alertdialog", { name: "Discard unsaved form changes?" }).getByRole("button", { name: "Discard changes" }).click();
    await expect(primaryFormButton).toHaveAttribute("aria-current", "page");
    await formQueueButton().click();
    await expect(page.getByLabel("Label", { exact: true }).first()).toHaveValue("QA short text");

    await page.getByRole("button", { name: "Delete draft" }).click();
    const deleteDialog = page.getByRole("alertdialog", { name: `Delete “${runName}”?` });
    await expect(deleteDialog).toContainText("permanently removes");
    await deleteDialog.getByRole("button", { name: "Keep draft" }).click();
    await expect(deleteDialog).toBeHidden();
    await expect(page.getByRole("button", { name: "Delete draft" })).toBeFocused();
    await page.getByRole("button", { name: "Delete draft" }).click();
    await page.getByRole("alertdialog", { name: `Delete “${runName}”?` }).getByRole("button", { name: "Delete draft" }).click();
    await expect(formQueueButton()).toHaveCount(0);
    expect(await loadCreated()).toBeUndefined();
  } finally {
    await cleanup();
  }
});

test("submission filters and pagination update the visible queue without mutation", async ({ context, page, baseURL }, testInfo) => {
  desktopOnly(testInfo);
  await openOwnerPage(context, page, baseURL ?? "http://127.0.0.1:5173", "/submissions");
  const state = page.getByRole("combobox", { name: "State" });
  await state.selectOption("accepted");
  await expect(page.getByText("accepted", { exact: true }).first()).toBeVisible();
  await expect(page.locator("tbody")).not.toContainText(/submitted/i);
  await state.selectOption("");
  const next = page.getByRole("button", { name: "Next" });
  await expect(next).toBeEnabled();
  await next.click();
  await expect(page.getByText("Page 2 · newest first", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Previous" }).click();
  await expect(page.getByText("Page 1 · newest first", { exact: true })).toBeVisible();
});

test("review search and filters expose a reversible empty state", async ({ context, page, baseURL }, testInfo) => {
  desktopOnly(testInfo);
  await openOwnerPage(context, page, baseURL ?? "http://127.0.0.1:5173", "/review");
  const search = page.getByRole("textbox", { name: "Search proposals" });
  await search.fill("QA-no-proposal-can-match-this-string");
  await expect(page.getByRole("heading", { name: "No proposals match these filters" })).toBeVisible();
  await page.getByRole("button", { name: "Clear filters" }).click();
  await expect(page.getByRole("list", { name: "Submission review queue" })).toBeVisible();
});

test("review score editor rejects a stale tab without losing its draft, then restores the fixture", async ({ context, page, request, baseURL }, testInfo) => {
  const runtimeBaseURL = baseURL ?? "http://127.0.0.1:5173";
  const reviewPath = `/api/v1/events/${EVENT_ID}/review`;
  const reviewerHeaders = { Cookie: `sp_session=${REVIEWER_SESSION}` };
  type Criterion = Readonly<{ key: string; label: string; type: string }>;
  type HumanReview = Readonly<{
    reviewerUserId: string;
    version: number;
    scores: readonly Readonly<{ criterionKey: string; score: number | string }>[];
    comment: string | null;
  }>;
  type Detail = Readonly<{
    id: string;
    title: string;
    round: null | Readonly<{ id: string; rubric: Readonly<{ criteria: readonly Criterion[] }> }>;
    reviews: readonly HumanReview[];
  }>;
  type Workbench = Readonly<{ queue: readonly Readonly<{ id: string }>[]; selected: Detail | null }>;
  const loadWorkbench = async (selectedSubmissionId?: string): Promise<Workbench> => {
    const query = new URLSearchParams({ status: "accepted", pageSize: "60" });
    if (selectedSubmissionId) query.set("selectedSubmissionId", selectedSubmissionId);
    const response = await request.get(`${reviewPath}?${query}`, { headers: reviewerHeaders });
    expect(response.status()).toBe(200);
    return response.json() as Promise<Workbench>;
  };
  const candidates = (await loadWorkbench()).queue;
  let selected: Detail | undefined;
  let initialReview: HumanReview | undefined;
  for (const candidate of candidates) {
    const detail = (await loadWorkbench(candidate.id)).selected;
    const review = detail?.reviews.find(({ reviewerUserId }) => reviewerUserId === "demo-reviewer");
    if (detail?.round && review) {
      selected = detail;
      initialReview = review;
      break;
    }
  }
  expect(selected, "the deterministic fixture must expose the reviewer's scored accepted proposal").toBeDefined();
  expect(initialReview).toBeDefined();
  const numericCriterion = selected!.round!.rubric.criteria.find(({ type }) => type === "numeric");
  expect(numericCriterion).toBeDefined();
  const initialNumeric = initialReview!.scores.find(({ criterionKey }) => criterionKey === numericCriterion!.key)?.score;
  expect(typeof initialNumeric).toBe("number");
  const winnerScore = initialNumeric === 1 ? 2 : 1;
  const staleScore = winnerScore === 5 ? 4 : 5;
  const winnerDraft = `QA review winner ${testInfo.project.name} — Unicode ✓`;
  const staleDraft = `QA review stale writer ${testInfo.project.name} — preserved`;
  const itemPath = `/api/v1/events/${EVENT_ID}/review/rounds/${selected!.round!.id}/submissions/${selected!.id}/score`;
  const currentReview = async (): Promise<HumanReview> => {
    const detail = (await loadWorkbench(selected!.id)).selected;
    const review = detail?.reviews.find(({ reviewerUserId }) => reviewerUserId === "demo-reviewer");
    expect(review).toBeDefined();
    return review!;
  };
  const restore = async (): Promise<void> => {
    const current = await currentReview();
    if (JSON.stringify(current.scores) === JSON.stringify(initialReview!.scores) && current.comment === initialReview!.comment) return;
    const response = await request.put(itemPath, {
      headers: { ...reviewerHeaders, "x-request-id": `qa-review-restore-${testInfo.project.name}` },
      data: {
        expectedVersion: current.version,
        scores: initialReview!.scores,
        ...(initialReview!.comment === null ? {} : { comment: initialReview!.comment }),
      },
    });
    expect(response.status()).toBe(200);
  };
  const route = `/e/${EVENT}/review?status=accepted&selectedSubmissionId=${encodeURIComponent(selected!.id)}`;
  const stalePage = await context.newPage();

  await signIn(context, runtimeBaseURL, REVIEWER_SESSION);
  await Promise.all([installDeterministicBrowser(page), installDeterministicBrowser(stalePage)]);
  try {
    await Promise.all([
      page.goto(route, { waitUntil: "domcontentloaded" }),
      stalePage.goto(route, { waitUntil: "domcontentloaded" }),
    ]);
    const winnerRationale = page.getByLabel("Private rationale");
    const staleRationale = stalePage.getByLabel("Private rationale");
    await expect(winnerRationale).toHaveValue(initialReview!.comment ?? "");
    await expect(staleRationale).toHaveValue(initialReview!.comment ?? "");

    const scoreButton = (targetPage: Page, score: number) => targetPage
      .locator(`[aria-label="${numericCriterion!.label} score"]`)
      .getByRole("button", { name: new RegExp(`^${score} —`) });
    await scoreButton(page, winnerScore).click();
    await winnerRationale.fill(winnerDraft);
    await page.getByRole("button", { name: "Save my review" }).click();
    await expect.poll(async () => (await currentReview()).comment).toBe(winnerDraft);
    await expect(scoreButton(page, winnerScore)).toHaveAttribute("aria-pressed", "true");

    await scoreButton(stalePage, staleScore).click();
    await staleRationale.fill(staleDraft);
    await stalePage.getByRole("button", { name: "Save my review" }).click();
    await expect(stalePage.getByRole("alert")).toContainText(/changed|reload/i);
    await expect(staleRationale).toHaveValue(staleDraft);
    expect((await currentReview()).comment).toBe(winnerDraft);

    await stalePage.reload({ waitUntil: "domcontentloaded" });
    await expect(stalePage.getByLabel("Private rationale")).toHaveValue(winnerDraft);
  } finally {
    await restore();
    await stalePage.close();
  }

  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.getByLabel("Private rationale")).toHaveValue(initialReview!.comment ?? "");
  expect((await currentReview()).scores).toEqual(initialReview!.scores);
});

test("onboarding contact editor cancels cleanly, records immutable evidence, and closes after Save", async ({ context, page, request, baseURL }, testInfo) => {
  desktopOnly(testInfo);
  const runtimeBaseURL = baseURL ?? "http://127.0.0.1:5173";
  const dashboardPath = `/api/v1/events/${EVENT_ID}/portal/dashboard`;
  const ownerHeaders = { Cookie: `sp_session=${OWNER_SESSION}` };
  type Dashboard = Readonly<{ speakers: readonly Readonly<{
    speaker: Readonly<{ id: string; displayName: string }>;
    latestContact: Readonly<{ medium: string; note: string | null; contactedAt: number }> | null;
  }>[] }>;
  const loadDashboard = async (): Promise<Dashboard> => {
    const response = await request.get(dashboardPath, { headers: ownerHeaders });
    expect(response.status()).toBe(200);
    return response.json() as Promise<Dashboard>;
  };
  const initial = await loadDashboard();
  const target = initial.speakers[0];
  expect(target).toBeDefined();
  const note = `QA completed contact for ${target!.speaker.displayName}`;

  await openOwnerPage(context, page, runtimeBaseURL, "/dashboard");
  const row = page.getByRole("row").filter({ hasText: target!.speaker.displayName }).first();
  const trigger = row.getByRole("button", { name: "Log contact" });
  await trigger.click();
  await expect(row.getByRole("button", { name: "Save contact" })).toBeVisible();
  await row.getByRole("button", { name: "Cancel" }).click();
  await expect(row.getByRole("button", { name: "Save contact" })).toHaveCount(0);
  await expect(trigger).toBeVisible();

  await trigger.click();
  await row.getByLabel("Medium").selectOption("phone");
  await row.getByLabel("Note (optional)").fill(note);
  await row.getByRole("button", { name: "Save contact" }).click();
  await expect(page.getByText("Contact logged", { exact: true }).first()).toBeVisible();
  await expect(row.getByRole("button", { name: "Save contact" })).toHaveCount(0);
  await expect(trigger).toBeVisible();
  await expect(row).toContainText("Phone");
  await expect(row).toContainText(note);
  await expect.poll(async () => (await loadDashboard()).speakers.find(({ speaker }) => speaker.id === target!.speaker.id)?.latestContact).toMatchObject({
    medium: "phone",
    note,
  });

  await page.reload({ waitUntil: "domcontentloaded" });
  const reloadedRow = page.getByRole("row").filter({ hasText: target!.speaker.displayName }).first();
  await expect(reloadedRow).toContainText("Phone");
  await expect(reloadedRow).toContainText(note);
});

test("speaker directory search, selection, and bulk-action disabled state remain coherent", async ({ context, page, baseURL }, testInfo) => {
  desktopOnly(testInfo);
  await openOwnerPage(context, page, baseURL ?? "http://127.0.0.1:5173", "/speakers");
  const search = page.getByRole("searchbox", { name: "Search speakers" });
  await search.fill("QA-no-speaker-can-match-this-string");
  await expect(page.getByRole("status").filter({ hasText: "No matching speakers" })).toBeVisible();
  await search.fill("");
  const invite = page.getByRole("button", { name: "Send invites" });
  await expect(invite).toBeDisabled();
  await page.getByRole("button", { name: "Select page" }).click();
  await expect(invite).toBeEnabled();
  await page.getByRole("button", { name: "Clear" }).click();
  await expect(invite).toBeDisabled();
});

test("reusable speaker profile validates, versions, publishes, and restores its canonical fields", async ({ context, page, request, baseURL }, testInfo) => {
  desktopOnly(testInfo);
  const runtimeBaseURL = baseURL ?? "http://127.0.0.1:5173";
  const profilePath = "/api/v1/speaker-profile";
  const speakerHeaders = { Cookie: `sp_session=${SPEAKER_SESSION}` };
  type ReusableProfile = Readonly<{
    slug: string;
    displayName: string;
    title: string | null;
    company: string | null;
    bio: string | null;
    headshotUrl: string | null;
    links: readonly Readonly<{ label: string; url: string }>[];
    visible: boolean;
    version: number;
  }>;
  const loadProfile = async (): Promise<ReusableProfile> => {
    const response = await request.get(profilePath, { headers: speakerHeaders });
    expect(response.status()).toBe(200);
    const profile = await response.json() as ReusableProfile | null;
    expect(profile, "reusable profile fixture must exist").not.toBeNull();
    return profile!;
  };
  const initial = await loadProfile();

  await signIn(context, runtimeBaseURL, SPEAKER_SESSION);
  await installDeterministicBrowser(page);
  await page.goto("/speaker/profile", { waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { level: 1, name: "Reusable speaker profile" }).waitFor({ state: "visible" });
  const save = page.getByRole("button", { name: "Save reusable profile" });
  const displayName = page.getByLabel("Display name");
  await displayName.fill("");
  await save.click();
  expect(await displayName.evaluate((field: HTMLInputElement) => field.validity.valueMissing)).toBe(true);
  expect((await loadProfile()).version).toBe(initial.version);

  await displayName.fill(initial.displayName);
  await page.getByLabel("Title").fill(`QA reusable ${testInfo.project.name}`);
  await page.getByRole("button", { name: "Add another link" }).click();
  await expect(page.getByLabel("Link 2 label")).toBeVisible();
  await page.getByLabel("Link 2 label").fill("QA documentation");
  await page.getByLabel("Link 2 URL").fill("https://example.com/qa-profile");
  await save.click();
  await expect(page.getByText("Reusable speaker profile saved", { exact: true }).last()).toBeVisible();
  await expect(page.getByLabel("Title")).toHaveValue(`QA reusable ${testInfo.project.name}`);
  await expect.poll(async () => await loadProfile()).toMatchObject({
    title: `QA reusable ${testInfo.project.name}`,
    links: [...initial.links, { label: "QA documentation", url: "https://example.com/qa-profile" }],
    visible: true,
  });

  await page.getByRole("link", { name: "View public profile" }).click();
  await expect(page).toHaveURL(`/speakers/${initial.slug}`);
  await expect(page.getByRole("heading", { level: 1, name: initial.displayName })).toBeVisible();
  await expect(page.getByRole("link", { name: "QA documentation" })).toHaveAttribute("href", "https://example.com/qa-profile");
  await page.goBack({ waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { level: 1, name: "Reusable speaker profile" }).waitFor({ state: "visible" });
  await page.getByLabel("Title").fill(initial.title ?? "");
  await page.getByLabel("Link 2 label").fill("");
  await page.getByLabel("Link 2 URL").fill("");
  await page.getByRole("button", { name: "Save reusable profile" }).click();
  await expect(page.getByText("Reusable speaker profile saved", { exact: true }).last()).toBeVisible();
  await expect.poll(async () => await loadProfile()).toMatchObject({
    slug: initial.slug,
    displayName: initial.displayName,
    title: initial.title,
    company: initial.company,
    bio: initial.bio,
    headshotUrl: initial.headshotUrl,
    links: initial.links,
    visible: initial.visible,
  });
});

test("direct speaker creation validates, resets, preserves a rejected draft, and persists privately", async ({ context, page, request, baseURL }, testInfo) => {
  desktopOnly(testInfo);
  const runtimeBaseURL = baseURL ?? "http://127.0.0.1:5173";
  const collectionPath = `/api/v1/events/${EVENT_ID}/portal/speakers`;
  const publicPath = `/api/v1/public/events/${EVENT}/speakers`;
  const ownerHeaders = { Cookie: `sp_session=${OWNER_SESSION}` };
  type Speaker = Readonly<{
    id: string;
    displayName: string;
    contactEmail: string | null;
    title: string | null;
    company: string | null;
    bio: string | null;
    workflowStatus: string;
    visible: boolean;
  }>;
  type Directory = Readonly<{ speakers: readonly Readonly<{ source: string; speaker: Speaker }>[] }>;
  const loadDirectory = async (): Promise<Directory> => {
    const response = await request.get(collectionPath, { headers: ownerHeaders });
    expect(response.status()).toBe(200);
    return response.json() as Promise<Directory>;
  };
  const loadPublic = async (): Promise<unknown> => {
    const response = await request.get(publicPath);
    expect(response.status()).toBe(200);
    return response.json();
  };
  const initial = await loadDirectory();
  const duplicateEmail = initial.speakers.find(({ speaker }) => speaker.contactEmail !== null)!.speaker.contactEmail!;
  const publicBefore = await loadPublic();
  const suffix = testInfo.project.name.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  const createdName = `QA Direct Speaker ${suffix}`;
  const createdEmail = `qa-direct-${suffix}@sessionparty.local`;

  await openOwnerPage(context, page, runtimeBaseURL, "/speakers");
  const form = page.getByRole("button", { name: "Add speaker" }).locator("xpath=ancestor::form");
  const name = form.getByLabel("Display name");
  const email = form.getByLabel("Contact email");
  const status = form.getByLabel("Workflow status");
  const visible = form.getByLabel("Visible when published");

  await form.getByRole("button", { name: "Add speaker" }).click();
  expect(await name.evaluate((element) => (element as HTMLInputElement).validity.valueMissing)).toBe(true);
  expect(await email.evaluate((element) => (element as HTMLInputElement).validity.valueMissing)).toBe(true);
  expect((await loadDirectory()).speakers).toHaveLength(initial.speakers.length);

  await name.fill("Discard this speaker draft");
  await email.fill("discard-this-speaker@sessionparty.local");
  await status.fill("Confirmed");
  await visible.uncheck();
  await form.getByRole("button", { name: "Reset" }).click();
  await expect(name).toHaveValue("");
  await expect(email).toHaveValue("");
  await expect(status).toHaveValue("Invited");
  await expect(visible).toBeChecked();

  await name.fill(createdName);
  await email.fill(duplicateEmail);
  await form.getByLabel("Title").fill("QA duplicate draft title");
  await form.getByRole("button", { name: "Add speaker" }).click();
  await expect(page.getByText("A speaker with this contact email already exists", { exact: true }).first()).toBeVisible();
  await expect(name).toHaveValue(createdName);
  await expect(email).toHaveValue(duplicateEmail);
  await expect(form.getByLabel("Title")).toHaveValue("QA duplicate draft title");
  expect((await loadDirectory()).speakers).toHaveLength(initial.speakers.length);

  await email.fill(createdEmail);
  await form.getByLabel("Title").fill("Principal QA Engineer");
  await form.getByLabel("Company").fill("Session Party QA");
  await form.getByLabel("Biography").fill("Created through the disposable sandbox QA workflow.");
  await form.getByRole("button", { name: "Add speaker" }).click();
  await expect(page.getByText("Speaker added", { exact: true }).first()).toBeVisible();
  await expect(name).toHaveValue("");
  await expect(email).toHaveValue("");
  await expect(status).toHaveValue("Invited");
  await expect(visible).toBeChecked();
  await expect.poll(async () => (await loadDirectory()).speakers.find(({ speaker }) => speaker.contactEmail === createdEmail)?.speaker).toMatchObject({
    displayName: createdName,
    title: "Principal QA Engineer",
    company: "Session Party QA",
    workflowStatus: "Invited",
    visible: true,
  });
  expect(await loadPublic()).toEqual(publicBefore);

  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByRole("searchbox", { name: "Search speakers" }).fill(createdEmail);
  const createdRow = page.getByRole("row").filter({ hasText: createdName });
  await expect(createdRow).toHaveCount(1);
  await expect(createdRow).toContainText("Direct");
  await expect(createdRow).toContainText("Principal QA Engineer");
});

test("speaker editor exposes only managed profiles and preserves a stale writer until recovery", async ({ context, page, request, baseURL }, testInfo) => {
  desktopOnly(testInfo);
  const runtimeBaseURL = baseURL ?? "http://127.0.0.1:5173";
  const collectionPath = `/api/v1/events/${EVENT_ID}/portal/speakers`;
  const ownerHeaders = { Cookie: `sp_session=${OWNER_SESSION}` };
  type Speaker = Readonly<{
    id: string;
    displayName: string;
    contactEmail: string | null;
    title: string | null;
    company: string | null;
    bio: string | null;
    workflowStatus: string;
    visible: boolean;
    version: number;
  }>;
  const loadManaged = async (): Promise<Speaker> => {
    const response = await request.get(collectionPath, { headers: ownerHeaders });
    expect(response.status()).toBe(200);
    const directory = await response.json() as { readonly speakers: readonly { readonly source: string; readonly speaker: Speaker }[] };
    return directory.speakers.find(({ source, speaker }) => source === "manual" && speaker.contactEmail === "dana.operations@sessionparty.local")!.speaker;
  };
  const initial = await loadManaged();
  const body = (speaker: Speaker) => ({
    displayName: speaker.displayName,
    contactEmail: speaker.contactEmail,
    title: speaker.title,
    company: speaker.company,
    bio: speaker.bio,
    workflowStatus: speaker.workflowStatus,
    visible: speaker.visible,
    expectedVersion: speaker.version,
  });
  const itemPath = `${collectionPath}/${initial.id}`;

  await openOwnerPage(context, page, runtimeBaseURL, "/speakers");
  const peer = await context.newPage();
  await installDeterministicBrowser(peer);
  await peer.goto(`/e/${EVENT}/speakers`, { waitUntil: "domcontentloaded" });
  await peer.locator("h1").waitFor({ state: "visible" });

  const editor = async (target: Page) => {
    const search = target.getByRole("searchbox", { name: "Search speakers" });
    await search.fill("dana.operations@sessionparty.local");
    const row = target.locator("tbody tr").filter({ hasText: "Dana Operations" });
    await expect(row).toHaveCount(1);
    await row.getByText("Edit profile", { exact: true }).click();
    return row;
  };

  try {
    const search = page.getByRole("searchbox", { name: "Search speakers" });
    await search.fill("Priya Raman");
    const acceptedRow = page.locator("tbody tr").filter({ hasText: "Priya Raman" }).filter({ hasText: "Provisioned" });
    await expect(acceptedRow).toHaveCount(1);
    await expect(acceptedRow.getByText("Edit profile", { exact: true })).toHaveCount(0);
    await expect(acceptedRow).toContainText("Profile details are managed by this accepted speaker in their portal.");

    const row = await editor(page);
    const peerRow = await editor(peer);
    const winningTitle = `QA speaker winner ${Date.now()}`;
    await row.getByLabel("Title").fill(winningTitle);
    await row.getByRole("button", { name: "Save speaker" }).click();
    await expect(page.getByText("Speaker updated").last()).toBeVisible();

    const losingTitle = `QA stale speaker ${Date.now()}`;
    await peerRow.getByLabel("Title").fill(losingTitle);
    await peerRow.getByRole("button", { name: "Save speaker" }).click();
    await expect(peer.getByText("Speaker changed; reload before saving").last()).toBeVisible();
    await expect(peerRow.getByLabel("Title")).toHaveValue(losingTitle);

    const restoreRow = await editor(page);
    await restoreRow.getByLabel("Title").fill(initial.title ?? "");
    await restoreRow.getByRole("button", { name: "Save speaker" }).click();
    await expect(page.getByText("Speaker updated").last()).toBeVisible();
    await page.reload();
    const verifiedRow = await editor(page);
    await expect(verifiedRow.getByLabel("Title")).toHaveValue(initial.title ?? "");
  } finally {
    const current = await loadManaged();
    if (current.displayName !== initial.displayName
      || current.contactEmail !== initial.contactEmail
      || current.title !== initial.title
      || current.company !== initial.company
      || current.bio !== initial.bio
      || current.workflowStatus !== initial.workflowStatus
      || current.visible !== initial.visible) {
      const restored = await request.put(itemPath, { headers: ownerHeaders, data: { ...body(initial), expectedVersion: current.version } });
      expect(restored.status()).toBe(200);
    }
    await peer.close();
  }
});

test("task and resource destructive dialogs both cancel without mutation", async ({ context, page, baseURL }, testInfo) => {
  desktopOnly(testInfo);
  const runtimeBaseURL = baseURL ?? "http://127.0.0.1:5173";
  await openOwnerPage(context, page, runtimeBaseURL, "/tasks");
  await page.getByRole("button", { name: "Delete task" }).first().click();
  let dialog = page.getByRole("alertdialog");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: /Keep task|Cancel/ }).click();
  await expect(dialog).toBeHidden();

  await page.goto(`/e/${EVENT}/resources`);
  await page.getByRole("heading", { level: 1 }).waitFor({ state: "visible" });
  await page.getByRole("button", { name: "Delete resource" }).first().click();
  dialog = page.getByRole("alertdialog");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: /Keep resource|Cancel/ }).click();
  await expect(dialog).toBeHidden();
});

test("task editor completes a conditional create, update, reload, and delete lifecycle", async ({ context, page, request, baseURL }, testInfo) => {
  const runtimeBaseURL = baseURL ?? "http://127.0.0.1:5173";
  const collectionPath = `/api/v1/events/${EVENT_ID}/portal/tasks`;
  const ownerHeaders = { Cookie: `sp_session=${OWNER_SESSION}` };
  const taskName = `QA UI task ${testInfo.project.name}`;
  const updatedName = `${taskName} updated`;
  type Task = Readonly<{ id: string; name: string; kind: string; formId: string | null; order: number; speakerIds: readonly string[]; version: number }>;
  const loadTasks = async (): Promise<readonly Task[]> => {
    const response = await request.get(collectionPath, { headers: ownerHeaders });
    expect(response.status()).toBe(200);
    return response.json() as Promise<readonly Task[]>;
  };
  const cleanup = async (): Promise<void> => {
    const current = (await loadTasks()).find(({ name }) => name === taskName || name === updatedName);
    if (!current) return;
    const removed = await request.delete(`${collectionPath}/${current.id}`, { headers: ownerHeaders, data: { expectedVersion: current.version } });
    expect(removed.status()).toBe(200);
  };
  const formForName = (name: string) => page.locator("form").filter({ has: page.locator(`input[name="name"][value="${name}"]`) });
  const formsResponse = await request.get(`/api/v1/events/${EVENT_ID}/forms`, { headers: ownerHeaders });
  expect(formsResponse.status()).toBe(200);
  const forms = await formsResponse.json() as readonly { readonly id: string; readonly purpose: string }[];
  const primaryForm = forms.find(({ purpose }) => purpose === "primary-cfp");
  expect(primaryForm).toBeDefined();

  await openOwnerPage(context, page, runtimeBaseURL, "/tasks");
  try {
    const createForm = page.locator("form").filter({ has: page.getByRole("button", { name: "Create task" }) });
    const name = createForm.getByLabel("Task name");
    await createForm.getByRole("button", { name: "Create task" }).click();
    expect(await name.evaluate((input: HTMLInputElement) => input.validity.valueMissing)).toBe(true);
    await name.fill(taskName);
    await createForm.getByLabel("Order").fill("981");
    await createForm.getByLabel("Instructions").fill("Disposable task lifecycle — Unicode ✓");
    await createForm.getByLabel("Due date").fill("2026-08-20T14:30");
    const type = createForm.getByLabel("Task type");
    for (const kind of ["profile", "upload", "link", "confirm"] as const) {
      await type.selectOption(kind);
      await expect(createForm.getByLabel("Form ID")).toHaveCount(0);
    }
    await type.selectOption("form");
    const formId = createForm.getByLabel("Form ID");
    await expect(formId).toHaveAttribute("required", "");
    await createForm.getByRole("button", { name: "Create task" }).click();
    expect(await formId.evaluate((input: HTMLInputElement) => input.validity.valueMissing)).toBe(true);
    await formId.fill(primaryForm!.id);
    await createForm.getByRole("checkbox").first().check();
    await createForm.getByRole("button", { name: "Create task" }).click();
    await expect(page.getByText("Task created", { exact: true }).first()).toBeVisible();

    const created = (await loadTasks()).find(({ name }) => name === taskName);
    expect(created).toMatchObject({ kind: "form", formId: primaryForm!.id, order: 981 });
    expect(created!.speakerIds).toHaveLength(1);
    const editForm = formForName(taskName);
    await expect(editForm).toHaveCount(1);
    await editForm.getByLabel("Task name").fill(updatedName);
    await editForm.getByLabel("Task type").selectOption("confirm");
    await expect(editForm.getByLabel("Form ID")).toHaveCount(0);
    await editForm.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByText("Task updated", { exact: true }).first()).toBeVisible();
    expect((await loadTasks()).find(({ name }) => name === updatedName)).toMatchObject({ kind: "confirm", formId: null, order: 981 });

    await page.reload({ waitUntil: "domcontentloaded" });
    await page.locator("h1").waitFor({ state: "visible" });
    const reloaded = formForName(updatedName);
    await expect(reloaded.getByLabel("Task type")).toHaveValue("confirm");
    await reloaded.getByRole("button", { name: "Delete task" }).click();
    const deleteDialog = page.getByRole("alertdialog", { name: `Delete ${updatedName}?` });
    await deleteDialog.getByRole("button", { name: "Keep task" }).click();
    await expect(reloaded).toHaveCount(1);
    await reloaded.getByRole("button", { name: "Delete task" }).click();
    await page.getByRole("alertdialog", { name: `Delete ${updatedName}?` }).getByRole("button", { name: "Delete task" }).click();
    await expect(formForName(updatedName)).toHaveCount(0);
    expect((await loadTasks()).some(({ name }) => name === updatedName)).toBe(false);
  } finally {
    await cleanup();
  }
});

test("resource editor preserves rejected input and completes a create, update, reload, and delete lifecycle", async ({ context, page, request, baseURL }, testInfo) => {
  const runtimeBaseURL = baseURL ?? "http://127.0.0.1:5173";
  const collectionPath = `/api/v1/events/${EVENT_ID}/portal/resources`;
  const ownerHeaders = { Cookie: `sp_session=${OWNER_SESSION}` };
  const token = `${testInfo.project.name}-${Date.now()}`.replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const slug = `qa-ui-resource-${token}`;
  const title = `QA UI resource ${testInfo.project.name}`;
  const updatedTitle = `${title} updated`;
  type Resource = Readonly<{ id: string; slug: string; title: string; body: string | null; embedUrl: string | null; audience: string; order: number; version: number }>;
  const loadResources = async (): Promise<readonly Resource[]> => {
    const response = await request.get(collectionPath, { headers: ownerHeaders });
    expect(response.status()).toBe(200);
    return response.json() as Promise<readonly Resource[]>;
  };
  const cleanup = async (): Promise<void> => {
    const current = (await loadResources()).find((resource) => resource.slug === slug);
    if (!current) return;
    const removed = await request.delete(`${collectionPath}/${current.id}`, { headers: ownerHeaders, data: { expectedVersion: current.version } });
    expect(removed.status()).toBe(200);
  };
  const formForTitle = (value: string) => page.locator("form").filter({ has: page.locator(`input[name="title"][value="${value}"]`) });

  await openOwnerPage(context, page, runtimeBaseURL, "/resources");
  try {
    const createForm = page.locator("form").filter({ has: page.getByRole("button", { name: "Create resource" }) });
    await createForm.getByLabel("Title").fill(title);
    const slugInput = createForm.getByLabel("Slug");
    await slugInput.fill("Invalid Slug");
    await createForm.getByRole("button", { name: "Create resource" }).click();
    expect(await slugInput.evaluate((input: HTMLInputElement) => input.validity.patternMismatch)).toBe(true);
    await slugInput.fill(slug);
    await createForm.getByLabel("Order").fill("982");
    await createForm.getByLabel("Resource text").fill("Disposable resource lifecycle — 東京");
    const audience = createForm.getByLabel("Audience");
    await audience.selectOption("public");
    await audience.selectOption("speakers");
    const embed = createForm.getByLabel("Approved embed URL");
    await embed.fill("https://youtube.com.evil.example/embed/unsafe");
    await createForm.getByRole("button", { name: "Create resource" }).click();
    await expect(page.getByText("Embed URL must use an allowlisted HTTPS provider", { exact: true }).first()).toBeVisible();
    await expect(createForm.getByLabel("Title")).toHaveValue(title);
    expect((await loadResources()).some((resource) => resource.slug === slug)).toBe(false);

    await embed.fill("https://www.youtube-nocookie.com/embed/aqz-KE-bpKQ");
    await createForm.getByRole("button", { name: "Create resource" }).click();
    await expect(page.getByText("Resource created", { exact: true }).first()).toBeVisible();
    expect((await loadResources()).find((resource) => resource.slug === slug)).toMatchObject({ title, audience: "speakers", order: 982 });

    const editForm = formForTitle(title);
    await expect(editForm).toHaveCount(1);
    await editForm.getByLabel("Title").fill(updatedTitle);
    await editForm.getByLabel("Audience").selectOption("public");
    await editForm.getByLabel("Resource text").fill("Updated public resource — Unicode ✓");
    await editForm.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByText("Resource updated", { exact: true }).first()).toBeVisible();
    expect((await loadResources()).find((resource) => resource.slug === slug)).toMatchObject({ title: updatedTitle, audience: "public", body: "Updated public resource — Unicode ✓" });

    await page.reload({ waitUntil: "domcontentloaded" });
    await page.locator("h1").waitFor({ state: "visible" });
    const reloaded = formForTitle(updatedTitle);
    await expect(reloaded.getByLabel("Audience")).toHaveValue("public");
    await reloaded.getByRole("button", { name: "Delete resource" }).click();
    const deleteDialog = page.getByRole("alertdialog", { name: `Delete ${updatedTitle}?` });
    await deleteDialog.getByRole("button", { name: "Keep resource" }).click();
    await expect(reloaded).toHaveCount(1);
    await reloaded.getByRole("button", { name: "Delete resource" }).click();
    await page.getByRole("alertdialog", { name: `Delete ${updatedTitle}?` }).getByRole("button", { name: "Delete resource" }).click();
    await expect(formForTitle(updatedTitle)).toHaveCount(0);
    expect((await loadResources()).some((resource) => resource.slug === slug)).toBe(false);
  } finally {
    await cleanup();
  }
});

test("speaker content filters, downloads, comments, and version restoration preserve canonical state", async ({ context, page, request, baseURL }, testInfo) => {
  desktopOnly(testInfo);
  const runtimeBaseURL = baseURL ?? "http://127.0.0.1:5173";
  const collectionPath = `/api/v1/events/${EVENT_ID}/portal/content`;
  const ownerHeaders = { Cookie: `sp_session=${OWNER_SESSION}` };
  const speakerHeaders = { Cookie: `sp_session=${SPEAKER_SESSION}` };
  type Asset = Readonly<{
    id: string;
    filename: string;
    contentType: string;
    purpose: "headshot" | "slides" | "document";
    version: number;
    current: boolean;
    speakerId: string;
    speakerName: string;
    speakerVersion: number;
    versionCount: number;
    supersedesAssetId: string | null;
    restoredFromAssetId: string | null;
    comments: readonly Readonly<{ id: string; body: string }>[];
  }>;
  type Library = Readonly<{ assets: readonly Asset[] }>;
  const loadLibrary = async (): Promise<Library> => {
    const response = await request.get(collectionPath, { headers: ownerHeaders });
    expect(response.status()).toBe(200);
    return response.json() as Promise<Library>;
  };
  const before = await loadLibrary();
  const previous = before.assets.find((asset) => asset.current && asset.purpose === "document");
  expect(previous).toBeDefined();
  const suffix = `${testInfo.project.name}-${Date.now()}`.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  const filename = `qa-content-${suffix}.pdf`;
  const comment = `QA content review ${testInfo.project.name} — Unicode ✓`;
  const pdfBase64 = "JVBERi0xLjQKJSBkZXRlcm1pbmlzdGljIHFhCiUlRU9G";
  const uploaded = await request.post(`/api/v1/events/${EVENT_ID}/portal/assets`, {
    headers: speakerHeaders,
    data: {
      purpose: "document",
      filename,
      contentType: "application/pdf",
      contentBase64: pdfBase64,
      expectedVersion: 0,
      idempotencyKey: `qa-content-upload-${suffix}`,
    },
  });
  expect(uploaded.status()).toBe(201);
  const created = (await uploaded.json() as { readonly asset: { readonly id: string; readonly version: number } }).asset;

  await openOwnerPage(context, page, runtimeBaseURL, "/content");
  await expect(page.getByRole("link", { name: "Content", exact: true })).toHaveAttribute("aria-current", "page");
  const search = page.getByRole("searchbox", { name: "Search" });
  const purpose = page.getByLabel("Purpose");
  const versions = page.getByLabel("Versions");
  await search.fill(filename);
  await purpose.selectOption("document");
  await expect(page.getByRole("row").filter({ hasText: filename })).toHaveCount(1);

  await page.getByRole("button", { name: "Select current results" }).click();
  await expect(page.getByText("1 files selected", { exact: true })).toBeVisible();
  const zipPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download selected ZIP" }).click();
  const zip = await zipPromise;
  expect(zip.suggestedFilename()).toBe("AI-Engineer-Sandbox-speaker-content.zip");
  const zipPath = await zip.path();
  expect(zipPath).not.toBeNull();
  expect([...((await readFile(zipPath!)).subarray(0, 4))]).toEqual([0x50, 0x4b, 0x03, 0x04]);
  await expect(page.getByRole("status")).toContainText("ZIP download started for 1 latest file.");
  await expect(search).toHaveValue(filename);
  await expect(purpose).toHaveValue("document");
  await expect(versions).toHaveValue("current");
  await expect(page.getByText("1 files selected", { exact: true })).toBeVisible();

  let currentRow = page.getByRole("row").filter({ hasText: filename }).filter({ hasText: "Current" });
  const filePromise = page.waitForEvent("download");
  await currentRow.getByRole("button", { name: "Download" }).click();
  const file = await filePromise;
  expect(file.suggestedFilename()).toBe(filename);
  const filePath = await file.path();
  expect(filePath).not.toBeNull();
  expect((await readFile(filePath!)).subarray(0, 4).toString()).toBe("%PDF");
  await expect(search).toHaveValue(filename);

  await currentRow.locator("summary").click();
  const commentInput = currentRow.getByLabel("Add comment");
  await currentRow.getByRole("button", { name: "Comment" }).click();
  expect(await commentInput.evaluate((input: HTMLInputElement) => input.validity.valueMissing)).toBe(true);
  expect((await loadLibrary()).assets.find(({ id }) => id === created.id)?.comments).toHaveLength(0);
  await commentInput.fill(comment);
  await currentRow.getByRole("button", { name: "Comment" }).click();
  await expect(page.getByText("Comment added", { exact: true }).first()).toBeVisible();
  await expect.poll(async () => (await loadLibrary()).assets.find(({ id }) => id === created.id)?.comments.map(({ body }) => body)).toContain(comment);

  await page.getByLabel("Versions").selectOption("history");
  const previousRow = page.getByRole("row")
    .filter({ hasText: previous!.filename })
    .filter({ hasText: `v${previous!.version} of` });
  await expect(previousRow).toHaveCount(1);
  await previousRow.getByRole("button", { name: "Restore as current" }).click();
  await expect(page.getByText("Version restored", { exact: true }).first()).toBeVisible();
  await expect.poll(async () => (await loadLibrary()).assets.find((asset) => asset.current && asset.purpose === "document")).toMatchObject({
    filename: previous!.filename,
    version: created.version + 1,
    restoredFromAssetId: previous!.id,
    supersedesAssetId: created.id,
  });

  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator("h1").waitFor({ state: "visible" });
  await page.getByLabel("Versions").selectOption("history");
  await expect(page.getByRole("row").filter({ hasText: filename }).filter({ hasText: comment })).toHaveCount(1);
  await expect(page.getByRole("row")
    .filter({ hasText: previous!.filename })
    .filter({ has: page.getByText("Current", { exact: true }) }))
    .toContainText(`Restored from v${previous!.version}`);
});

test("agenda views, setup, and live-show controls are keyboard-reachable and reversible", async ({ context, page, baseURL }, testInfo) => {
  desktopOnly(testInfo);
  await openOwnerPage(context, page, baseURL ?? "http://127.0.0.1:5173", "/agenda");
  for (const name of ["List", "Day", "Week", "Track", "Room"]) {
    const tab = page.getByRole("tab", { name });
    await tab.click();
    await expect(tab).toHaveAttribute("aria-selected", "true");
  }
  const setup = page.getByRole("button", { name: "Tracks & rooms" });
  await setup.click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  const live = page.getByRole("button", { name: "Open live show" });
  await live.click();
  await expect(page.getByRole("button", { name: "Back to agenda" })).toBeVisible();
  await page.getByRole("button", { name: "Back to agenda" }).click();
  await expect(live).toBeVisible();
});

test("agenda track and room editors protect drafts, persist updates, and restore the fixture", async ({ context, page, request, baseURL }, testInfo) => {
  const runtimeBaseURL = baseURL ?? "http://127.0.0.1:5173";
  const agendaPath = `/api/v1/events/${EVENT_ID}/agenda`;
  const ownerHeaders = { Cookie: `sp_session=${OWNER_SESSION}` };
  type Track = Readonly<{ id: string; name: string; color: string | null; order: number; version: number }>;
  type Room = Readonly<{ id: string; name: string; capacity: number | null; order: number; version: number }>;
  type Agenda = Readonly<{ tracks: readonly Track[]; rooms: readonly Room[] }>;
  const loadAgenda = async (): Promise<Agenda> => {
    const response = await request.get(agendaPath, { headers: ownerHeaders });
    expect(response.status()).toBe(200);
    return response.json() as Promise<Agenda>;
  };
  const initialAgenda = await loadAgenda();
  const initialTrack = initialAgenda.tracks[0];
  const initialRoom = initialAgenda.rooms[0];
  expect(initialTrack).toBeDefined();
  expect(initialRoom).toBeDefined();
  const updatedTrackName = `${initialTrack!.name} · QA ${testInfo.project.name}`;
  const updatedRoomName = `${initialRoom!.name} · QA ${testInfo.project.name}`;
  const idempotency = (kind: string) => `qa-agenda-${kind}-${testInfo.project.name}-${Date.now()}`;
  const restore = async (): Promise<void> => {
    const current = await loadAgenda();
    const track = current.tracks.find(({ id }) => id === initialTrack!.id);
    const room = current.rooms.find(({ id }) => id === initialRoom!.id);
    expect(track).toBeDefined();
    expect(room).toBeDefined();
    if (track!.name !== initialTrack!.name || track!.color !== initialTrack!.color || track!.order !== initialTrack!.order) {
      const response = await request.patch(`${agendaPath}/tracks/${track!.id}`, {
        headers: ownerHeaders,
        data: {
          name: initialTrack!.name,
          color: initialTrack!.color,
          order: initialTrack!.order,
          expectedVersion: track!.version,
          idempotencyKey: idempotency("restore-track"),
        },
      });
      expect(response.status()).toBe(200);
    }
    if (room!.name !== initialRoom!.name || room!.capacity !== initialRoom!.capacity || room!.order !== initialRoom!.order) {
      const latest = (await loadAgenda()).rooms.find(({ id }) => id === initialRoom!.id)!;
      const response = await request.patch(`${agendaPath}/rooms/${latest.id}`, {
        headers: ownerHeaders,
        data: {
          name: initialRoom!.name,
          capacity: initialRoom!.capacity,
          order: initialRoom!.order,
          expectedVersion: latest.version,
          idempotencyKey: idempotency("restore-room"),
        },
      });
      expect(response.status()).toBe(200);
    }
  };

  await openOwnerPage(context, page, runtimeBaseURL, "/agenda");
  try {
    await page.getByRole("button", { name: "Tracks & rooms" }).click();
    let setup = page.getByRole("dialog", { name: "Tracks and rooms" });
    await setup.getByRole("button", { name: `Edit track ${initialTrack!.name}`, exact: true }).click();
    const trackName = setup.getByLabel("Track name");
    await trackName.fill(`${initialTrack!.name} unsaved`);

    let closeMessage = "";
    page.once("dialog", async (dialog) => {
      closeMessage = dialog.message();
      await dialog.dismiss();
    });
    await setup.getByRole("button", { name: "Close" }).click();
    expect(closeMessage).toBe("Discard unsaved track or room changes?");
    await expect(setup).toBeVisible();
    await expect(trackName).toHaveValue(`${initialTrack!.name} unsaved`);

    page.once("dialog", (dialog) => dialog.accept());
    await setup.getByRole("button", { name: "Close" }).click();
    await expect(setup).toBeHidden();
    await page.getByRole("button", { name: "Tracks & rooms" }).click();
    setup = page.getByRole("dialog", { name: "Tracks and rooms" });
    await expect(setup.getByLabel("New track name")).toHaveValue("");

    const createTrackForm = setup.locator("form").filter({ has: page.getByRole("button", { name: "Create track" }) });
    await createTrackForm.getByLabel("New track name").fill("QA invalid track");
    await createTrackForm.getByLabel("Color (hex)").fill("not-a-color");
    await createTrackForm.getByRole("button", { name: "Create track" }).click();
    await expect(page.getByText("Track color must be a six-digit hex value such as #2563EB", { exact: true }).first()).toBeVisible();
    await expect(createTrackForm.getByLabel("New track name")).toHaveValue("QA invalid track");

    await setup.getByRole("button", { name: `Edit track ${initialTrack!.name}`, exact: true }).click();
    const trackForm = setup.locator("form").filter({ has: page.getByRole("button", { name: "Update track" }) });
    await trackForm.getByLabel("Track name").fill(updatedTrackName);
    await trackForm.getByLabel("Color (hex)").fill("#123ABC");
    await trackForm.getByLabel("Display order").fill(String(initialTrack!.order + 20));
    await trackForm.getByRole("button", { name: "Update track" }).click();
    await expect(page.getByText("Track updated", { exact: true }).first()).toBeVisible();
    await expect.poll(async () => (await loadAgenda()).tracks.find(({ id }) => id === initialTrack!.id)?.name).toBe(updatedTrackName);

    const createRoomForm = setup.locator("form").filter({ has: page.getByRole("button", { name: "Create room" }) });
    await createRoomForm.getByLabel("New room name").fill("QA invalid room");
    const invalidCapacity = createRoomForm.getByLabel("Capacity");
    await invalidCapacity.fill("0");
    await createRoomForm.getByRole("button", { name: "Create room" }).click();
    expect(await invalidCapacity.evaluate((input: HTMLInputElement) => input.validity.rangeUnderflow)).toBe(true);
    await expect(createRoomForm.getByLabel("New room name")).toHaveValue("QA invalid room");

    await setup.getByRole("button", { name: `Edit room ${initialRoom!.name}`, exact: true }).click();
    const roomForm = setup.locator("form").filter({ has: page.getByRole("button", { name: "Update room" }) });
    await roomForm.getByLabel("Room name").fill(updatedRoomName);
    await roomForm.getByLabel("Capacity").fill("321");
    await roomForm.getByLabel("Display order").fill(String(initialRoom!.order + 20));
    await roomForm.getByRole("button", { name: "Update room" }).click();
    await expect(page.getByText("Room updated", { exact: true }).first()).toBeVisible();
    await expect.poll(async () => (await loadAgenda()).rooms.find(({ id }) => id === initialRoom!.id)?.name).toBe(updatedRoomName);

    await page.reload({ waitUntil: "domcontentloaded" });
    await page.locator("h1").waitFor({ state: "visible" });
    await page.getByRole("button", { name: "Tracks & rooms" }).click();
    setup = page.getByRole("dialog", { name: "Tracks and rooms" });
    await expect(setup.getByRole("button", { name: `Edit track ${updatedTrackName}`, exact: true })).toBeVisible();
    await expect(setup.getByRole("button", { name: `Edit room ${updatedRoomName}`, exact: true })).toBeVisible();
  } finally {
    await restore();
  }

  const restored = await loadAgenda();
  expect(restored.tracks.find(({ id }) => id === initialTrack!.id)).toMatchObject({
    name: initialTrack!.name,
    color: initialTrack!.color,
    order: initialTrack!.order,
  });
  expect(restored.rooms.find(({ id }) => id === initialRoom!.id)).toMatchObject({
    name: initialRoom!.name,
    capacity: initialRoom!.capacity,
    order: initialRoom!.order,
  });
});

test("agenda talk editor protects drafts, validates mutations, preserves the public revision, and restores the fixture", async ({ context, page, request, baseURL }, testInfo) => {
  const runtimeBaseURL = baseURL ?? "http://127.0.0.1:5173";
  const agendaPath = `/api/v1/events/${EVENT_ID}/agenda`;
  const publicAgendaPath = `/api/v1/public/events/${EVENT}/agenda/published`;
  const ownerHeaders = { Cookie: `sp_session=${OWNER_SESSION}` };
  type Talk = Readonly<{
    id: string;
    title: string;
    description: string | null;
    trackId: string | null;
    roomId: string | null;
    startsAt: number | null;
    durationMin: number;
    status: "draft" | "confirmed" | "cancelled";
    version: number;
  }>;
  type Agenda = Readonly<{
    tracks: readonly Readonly<{ id: string; name: string }>[];
    talks: readonly Talk[];
  }>;
  const loadAgenda = async (): Promise<Agenda> => {
    const response = await request.get(agendaPath, { headers: ownerHeaders });
    expect(response.status()).toBe(200);
    return response.json() as Promise<Agenda>;
  };
  const loadPublicAgenda = async (): Promise<unknown> => {
    const response = await request.get(publicAgendaPath);
    expect(response.status()).toBe(200);
    return response.json();
  };
  const initialAgenda = await loadAgenda();
  const initialTalk = initialAgenda.talks.find(({ status, startsAt }) => status === "confirmed" && startsAt !== null);
  expect(initialTalk).toBeDefined();
  const alternateTrack = initialAgenda.tracks.find(({ id }) => id !== initialTalk!.trackId);
  expect(alternateTrack).toBeDefined();
  const publicBefore = await loadPublicAgenda();
  const updatedTitle = `${initialTalk!.title} · QA ${testInfo.project.name}`;
  const updatedDescription = `QA agenda content ${testInfo.project.name} — Unicode ✓`;
  const idempotency = (kind: string) => `qa-agenda-talk-${kind}-${testInfo.project.name}-${Date.now()}`;
  const editButton = (title: string) => page.locator(`button[aria-label^=${JSON.stringify(`Edit ${title}.`)}]`).first();
  const restore = async (): Promise<void> => {
    let current = (await loadAgenda()).talks.find(({ id }) => id === initialTalk!.id);
    expect(current).toBeDefined();
    if (current!.title !== initialTalk!.title || current!.description !== initialTalk!.description) {
      const response = await request.patch(`${agendaPath}/talks/${current!.id}/content`, {
        headers: ownerHeaders,
        data: {
          title: initialTalk!.title,
          description: initialTalk!.description,
          expectedVersion: current!.version,
          idempotencyKey: idempotency("restore-content"),
        },
      });
      expect(response.status()).toBe(200);
    }
    current = (await loadAgenda()).talks.find(({ id }) => id === initialTalk!.id);
    expect(current).toBeDefined();
    if (
      current!.trackId !== initialTalk!.trackId
      || current!.roomId !== initialTalk!.roomId
      || current!.startsAt !== initialTalk!.startsAt
      || current!.durationMin !== initialTalk!.durationMin
    ) {
      const response = await request.patch(`${agendaPath}/talks/${current!.id}/position`, {
        headers: ownerHeaders,
        data: {
          trackId: initialTalk!.trackId,
          roomId: initialTalk!.roomId,
          startsAt: initialTalk!.startsAt,
          durationMin: initialTalk!.durationMin,
          expectedVersion: current!.version,
          idempotencyKey: idempotency("restore-position"),
        },
      });
      expect(response.status()).toBe(200);
    }
  };

  await openOwnerPage(context, page, runtimeBaseURL, "/agenda");
  try {
    await editButton(initialTalk!.title).click();
    let editor = page.getByRole("dialog", { name: initialTalk!.title });
    await expect(editor).toBeVisible();
    const title = editor.getByLabel("Session title");
    await title.fill(`${initialTalk!.title} unsaved`);

    let closeMessage = "";
    page.once("dialog", async (dialog) => {
      closeMessage = dialog.message();
      await dialog.dismiss();
    });
    await editor.getByRole("button", { name: "Close" }).click();
    expect(closeMessage).toBe("Discard unsaved talk changes?");
    await expect(editor).toBeVisible();
    await expect(title).toHaveValue(`${initialTalk!.title} unsaved`);

    page.once("dialog", (dialog) => dialog.accept());
    await editor.getByRole("button", { name: "Close" }).click();
    await expect(editor).toBeHidden();
    await editButton(initialTalk!.title).click();
    editor = page.getByRole("dialog", { name: initialTalk!.title });
    await expect(editor.getByLabel("Session title")).toHaveValue(initialTalk!.title);

    await editor.getByLabel("Session title").fill("   ");
    await editor.getByRole("button", { name: "Save session content" }).click();
    await expect(page.getByText("Enter a session title", { exact: true }).first()).toBeVisible();
    await expect(editor.getByLabel("Session title")).toHaveValue("   ");
    await editor.getByLabel("Session title").fill(initialTalk!.title);

    const duration = editor.getByLabel("Duration (minutes)");
    await duration.fill("4");
    await editor.getByRole("button", { name: "Save schedule" }).click();
    expect(await duration.evaluate((input: HTMLInputElement) => input.validity.rangeUnderflow)).toBe(true);
    await expect(duration).toHaveValue("4");
    await duration.fill(String(initialTalk!.durationMin));

    await editor.getByLabel("Room (TBD allowed)").selectOption("");
    await editor.getByLabel(/^Start time/).fill("");
    await editor.getByRole("button", { name: "Save schedule" }).click();
    await expect(page.getByText("Draft saved with TBD placement", { exact: true }).first()).toBeVisible();
    await expect.poll(async () => (await loadAgenda()).talks.find(({ id }) => id === initialTalk!.id)).toMatchObject({
      roomId: null,
      startsAt: null,
      status: "draft",
    });
    expect(await loadPublicAgenda()).toEqual(publicBefore);

    await editor.getByRole("button", { name: "Auto-place talk" }).click();
    await expect(page.getByText("Talk auto-placed in the first conflict-free slot", { exact: true }).first()).toBeVisible();
    await expect.poll(async () => {
      const talk = (await loadAgenda()).talks.find(({ id }) => id === initialTalk!.id);
      return talk ? { roomPlaced: talk.roomId !== null, startsAtPlaced: talk.startsAt !== null, status: talk.status } : null;
    }).toEqual({ roomPlaced: true, startsAtPlaced: true, status: "confirmed" });

    await editor.getByLabel("Session title").fill(updatedTitle);
    await editor.getByLabel("Session abstract").fill(updatedDescription);
    await editor.getByRole("button", { name: "Save session content" }).click();
    await expect(page.getByText("Session title and abstract updated", { exact: true }).first()).toBeVisible();
    editor = page.getByRole("dialog", { name: updatedTitle });
    await expect(editor).toBeVisible();

    await editor.getByLabel("Track").selectOption(alternateTrack!.id);
    await editor.getByRole("button", { name: "Save schedule" }).click();
    await expect(page.getByText("Talk scheduled", { exact: true }).first()).toBeVisible();
    await expect.poll(async () => (await loadAgenda()).talks.find(({ id }) => id === initialTalk!.id)?.trackId).toBe(alternateTrack!.id);
    expect(await loadPublicAgenda()).toEqual(publicBefore);

    await page.reload({ waitUntil: "domcontentloaded" });
    await page.locator("h1").waitFor({ state: "visible" });
    editor = page.getByRole("dialog", { name: updatedTitle });
    if (!await editor.isVisible()) {
      await editButton(updatedTitle).click();
    }
    await expect(editor).toBeVisible();
    await expect(editor.getByLabel("Session title")).toHaveValue(updatedTitle);
    await expect(editor.getByLabel("Session abstract")).toHaveValue(updatedDescription);
    await expect(editor.getByLabel("Track")).toHaveValue(alternateTrack!.id);
  } finally {
    await restore();
  }

  const restored = (await loadAgenda()).talks.find(({ id }) => id === initialTalk!.id);
  expect(restored).toMatchObject({
    title: initialTalk!.title,
    description: initialTalk!.description,
    trackId: initialTalk!.trackId,
    roomId: initialTalk!.roomId,
    startsAt: initialTalk!.startsAt,
    durationMin: initialTalk!.durationMin,
    status: initialTalk!.status,
  });
  expect(await loadPublicAgenda()).toEqual(publicBefore);
});

test("agenda card drag-and-drop and keyboard placement move the canonical talk and restore it", async ({ context, page, request, baseURL }, testInfo) => {
  desktopChromiumOnly(testInfo);
  const runtimeBaseURL = baseURL ?? "http://127.0.0.1:5173";
  const agendaPath = `/api/v1/events/${EVENT_ID}/agenda`;
  const ownerHeaders = { Cookie: `sp_session=${OWNER_SESSION}` };
  type Talk = Readonly<{
    id: string;
    title: string;
    trackId: string | null;
    roomId: string | null;
    startsAt: number | null;
    durationMin: number;
    status: "draft" | "confirmed" | "cancelled";
    version: number;
  }>;
  type Agenda = Readonly<{
    tracks: readonly Readonly<{ id: string; name: string }>[];
    talks: readonly Talk[];
  }>;
  const loadAgenda = async (): Promise<Agenda> => {
    const response = await request.get(agendaPath, { headers: ownerHeaders });
    expect(response.status()).toBe(200);
    return response.json() as Promise<Agenda>;
  };
  const initialAgenda = await loadAgenda();
  const preferredTrackId = initialAgenda.tracks[0]?.id;
  const initialTalk = initialAgenda.talks.find(({ status, startsAt, trackId }) =>
    status === "confirmed" && startsAt !== null && trackId === preferredTrackId);
  expect(initialTalk).toBeDefined();
  const initialTrackIndex = initialAgenda.tracks.findIndex(({ id }) => id === initialTalk!.trackId);
  const initialTrack = initialAgenda.tracks[initialTrackIndex];
  const alternateTrack = initialAgenda.tracks.find(({ id }) => id !== initialTalk!.trackId);
  expect(initialTrack).toBeDefined();
  expect(alternateTrack).toBeDefined();
  const idempotency = (kind: string) => `qa-agenda-drag-${kind}-${Date.now()}`;
  const editSelector = `button[aria-label^=${JSON.stringify(`Edit ${initialTalk!.title}.`)}]`;
  const editButton = () => page.locator(editSelector).first();
  const restore = async (): Promise<void> => {
    const current = (await loadAgenda()).talks.find(({ id }) => id === initialTalk!.id);
    expect(current).toBeDefined();
    if (
      current!.trackId !== initialTalk!.trackId
      || current!.roomId !== initialTalk!.roomId
      || current!.startsAt !== initialTalk!.startsAt
      || current!.durationMin !== initialTalk!.durationMin
    ) {
      const response = await request.patch(`${agendaPath}/talks/${current!.id}/position`, {
        headers: ownerHeaders,
        data: {
          trackId: initialTalk!.trackId,
          roomId: initialTalk!.roomId,
          startsAt: initialTalk!.startsAt,
          durationMin: initialTalk!.durationMin,
          expectedVersion: current!.version,
          idempotencyKey: idempotency("restore"),
        },
      });
      expect(response.status()).toBe(200);
    }
  };

  await openOwnerPage(context, page, runtimeBaseURL, "/agenda");
  try {
    await page.getByRole("tab", { name: "Track" }).click();
    const source = editButton();
    const invalidTarget = page.getByText(/\d+ active/, { exact: true }).first();
    const versionBeforeInvalidDrop = initialTalk!.version;
    let dataTransfer = await page.evaluateHandle(() => new DataTransfer());
    await source.dispatchEvent("dragstart", { dataTransfer });
    await invalidTarget.dispatchEvent("dragover", { dataTransfer });
    await invalidTarget.dispatchEvent("drop", { dataTransfer });
    await source.dispatchEvent("dragend", { dataTransfer });
    await expect.poll(async () => (await loadAgenda()).talks.find(({ id }) => id === initialTalk!.id)?.version).toBe(versionBeforeInvalidDrop);

    const targetLane = page.getByRole("region", { name: alternateTrack!.name });
    dataTransfer = await page.evaluateHandle(() => new DataTransfer());
    await source.dispatchEvent("dragstart", { dataTransfer });
    await targetLane.dispatchEvent("dragenter", { dataTransfer });
    await targetLane.dispatchEvent("dragover", { dataTransfer });
    await targetLane.dispatchEvent("drop", { dataTransfer });
    await source.dispatchEvent("dragend", { dataTransfer });
    await expect(page.getByText("Talk moved", { exact: true }).first()).toBeVisible();
    await expect.poll(async () => (await loadAgenda()).talks.find(({ id }) => id === initialTalk!.id)?.trackId).toBe(alternateTrack!.id);
    await expect(targetLane.locator(editSelector)).toBeVisible();

    const movedEditButton = targetLane.locator(editSelector);
    await movedEditButton.focus();
    await movedEditButton.press("Enter");
    const editor = page.getByRole("dialog", { name: initialTalk!.title });
    const track = editor.getByLabel("Track");
    await track.focus();
    await track.pressSequentially(initialTrack!.name, { delay: 25 });
    await expect(track).toHaveValue(initialTrack!.id);
    const save = editor.getByRole("button", { name: "Save schedule" });
    await save.focus();
    await save.press("Enter");
    await expect(page.getByText("Talk scheduled", { exact: true }).first()).toBeVisible();
    await expect.poll(async () => (await loadAgenda()).talks.find(({ id }) => id === initialTalk!.id)?.trackId).toBe(initialTrack!.id);
    page.once("dialog", (dialog) => dialog.accept());
    await editor.getByRole("button", { name: "Close" }).click();
    await expect(editor).toBeHidden();

    await page.reload({ waitUntil: "domcontentloaded" });
    await page.locator("h1").waitFor({ state: "visible" });
    await page.getByRole("tab", { name: "Track" }).click();
    await expect(page.getByRole("region", { name: initialTrack!.name }).locator(editSelector)).toBeVisible();
  } finally {
    await restore();
  }
});

test("agenda talk cancellation discloses scope, preserves an aborted draft, and returns the proposal to backlog", async ({ context, page, request, baseURL }, testInfo) => {
  desktopChromiumOnly(testInfo);
  const runtimeBaseURL = baseURL ?? "http://127.0.0.1:5173";
  const agendaPath = `/api/v1/events/${EVENT_ID}/agenda`;
  const publicAgendaPath = `/api/v1/public/events/${EVENT}/agenda/published`;
  const ownerHeaders = { Cookie: `sp_session=${OWNER_SESSION}` };
  type Talk = Readonly<{ id: string; submissionId: string | null; status: "draft" | "confirmed" | "cancelled" }>;
  type Proposal = Readonly<{ submissionId: string; title: string }>;
  type Agenda = Readonly<{ backlog: readonly Proposal[]; talks: readonly Talk[] }>;
  const loadAgenda = async (): Promise<Agenda> => {
    const response = await request.get(agendaPath, { headers: ownerHeaders });
    expect(response.status()).toBe(200);
    return response.json() as Promise<Agenda>;
  };
  const loadPublicAgenda = async (): Promise<unknown> => {
    const response = await request.get(publicAgendaPath);
    expect(response.status()).toBe(200);
    return response.json();
  };
  const initialAgenda = await loadAgenda();
  const proposal = initialAgenda.backlog[0];
  expect(proposal).toBeDefined();
  const publicBefore = await loadPublicAgenda();

  await openOwnerPage(context, page, runtimeBaseURL, "/agenda");
  const backlogItem = page.locator("li").filter({ hasText: proposal!.title }).filter({ has: page.getByRole("button", { name: "Create talk" }) }).first();
  await backlogItem.getByRole("button", { name: "Create talk" }).click();
  await expect(page.getByText("Talk created", { exact: true }).first()).toBeVisible();
  const editor = page.getByRole("dialog", { name: proposal!.title });
  await expect(editor).toBeVisible();
  const created = (await loadAgenda()).talks.find(({ submissionId, status }) => submissionId === proposal!.submissionId && status === "draft");
  expect(created).toBeDefined();

  const unsavedTitle = `${proposal!.title} unsaved before cancel`;
  await editor.getByLabel("Session title").fill(unsavedTitle);
  let confirmationMessage = "";
  page.once("dialog", async (dialog) => {
    confirmationMessage = dialog.message();
    await dialog.dismiss();
  });
  await editor.getByRole("button", { name: "Cancel talk" }).click();
  expect(confirmationMessage).toBe(`Cancel "${proposal!.title}"? It will be removed from the draft schedule but kept in the audit history.`);
  await expect(editor).toBeVisible();
  await expect(editor.getByLabel("Session title")).toHaveValue(unsavedTitle);
  expect((await loadAgenda()).talks.find(({ id }) => id === created!.id)?.status).toBe("draft");

  page.once("dialog", (dialog) => dialog.accept());
  await editor.getByRole("button", { name: "Cancel talk" }).click();
  await expect(page.getByText("Talk cancelled", { exact: true }).first()).toBeVisible();
  await expect(editor).toBeHidden();
  await expect.poll(async () => (await loadAgenda()).talks.find(({ id }) => id === created!.id)?.status).toBe("cancelled");
  await expect.poll(async () => (await loadAgenda()).backlog.some(({ submissionId }) => submissionId === proposal!.submissionId)).toBe(true);
  await expect(page.locator("li").filter({ hasText: proposal!.title }).filter({ has: page.getByRole("button", { name: "Create talk" }) }).first()).toBeVisible();
  expect(await loadPublicAgenda()).toEqual(publicBefore);
});

test("communications protects unsaved edits and rejects a stale template writer without losing its draft", async ({ context, page, baseURL }, testInfo) => {
  desktopOnly(testInfo);
  await openOwnerPage(context, page, baseURL ?? "http://127.0.0.1:5173", "/comms");
  const peer = await context.newPage();
  await peer.goto(`/e/${EVENT}/comms`);
  await peer.getByRole("heading", { level: 1 }).waitFor({ state: "visible" });

  for (const name of ["01 / Templates", "02 / Audience & queue", "03 / Delivery history"]) {
    const tab = page.getByRole("tab", { name });
    await tab.click();
    await expect(tab).toHaveAttribute("aria-selected", "true");
  }
  await page.getByRole("tab", { name: "01 / Templates" }).click();
  await page.getByRole("button", { name: "+ New template" }).click();
  await expect(page.getByRole("heading", { name: /New message master/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /Create template|Save changes/ })).toBeVisible();
  await page.getByLabel("Template name").fill("QA unsaved template");
  await page.getByRole("tab", { name: "02 / Audience & queue" }).click();
  let dialog = page.getByRole("alertdialog", { name: "Discard unsaved template changes?" });
  await expect(dialog).toContainText("Your edits have not been saved");
  await dialog.getByRole("button", { name: "Keep editing" }).click();
  await expect(page.getByRole("tab", { name: "01 / Templates" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByLabel("Template name")).toHaveValue("QA unsaved template");

  await page.getByRole("tab", { name: "02 / Audience & queue" }).click();
  dialog = page.getByRole("alertdialog", { name: "Discard unsaved template changes?" });
  await dialog.getByRole("button", { name: "Discard changes" }).click();
  await expect(page.getByRole("tab", { name: "02 / Audience & queue" })).toHaveAttribute("aria-selected", "true");
  await page.getByRole("tab", { name: "01 / Templates" }).click();
  await page.getByRole("button").filter({ hasText: /V\d+/ }).first().click();

  const subject = page.getByLabel("Subject line");
  const originalSubject = await subject.inputValue();
  const winningSubject = `QA template winner ${Date.now()}`;
  await subject.fill(winningSubject);
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText("Template saved").last()).toBeVisible();

  const peerSubject = peer.getByLabel("Subject line");
  const losingSubject = `QA stale template ${Date.now()}`;
  await peerSubject.fill(losingSubject);
  await peer.getByRole("button", { name: "Save changes" }).click();
  await expect(peer.getByText(/Template (version is|changed concurrently)/).last()).toBeVisible();
  await expect(peerSubject).toHaveValue(losingSubject);

  await subject.fill(originalSubject);
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText("Template saved").last()).toBeVisible();
  await page.reload();
  await expect(page.getByLabel("Subject line")).toHaveValue(originalSubject);
  await peer.close();
});

test("publication and import confirmations disclose scope and Cancel cleanly", async ({ context, page, baseURL }, testInfo) => {
  desktopOnly(testInfo);
  const runtimeBaseURL = baseURL ?? "http://127.0.0.1:5173";
  await openOwnerPage(context, page, runtimeBaseURL, "/publication");
  await page.getByRole("button", { name: /Publish (schedule|new revision)/ }).click();
  let dialog = page.getByRole("alertdialog");
  await expect(dialog).toContainText(/replaces the audience-facing program/i);
  await dialog.getByRole("button", { name: "Keep backstage" }).click();
  await expect(dialog).toBeHidden();

  await page.goto(`/e/${EVENT}/integrations`);
  await page.getByRole("heading", { level: 1 }).waitFor({ state: "visible" });
  await page.getByRole("button", { name: "Import now" }).click();
  dialog = page.getByRole("alertdialog");
  await expect(dialog).toContainText(/import/i);
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toBeHidden();
});

test("settings role-change dialog can be cancelled without changing persisted membership", async ({ context, page, baseURL }, testInfo) => {
  desktopOnly(testInfo);
  await openOwnerPage(context, page, baseURL ?? "http://127.0.0.1:5173", "/settings");
  const role = page.getByRole("combobox", { name: /Role for admin@sessionparty\.local/ });
  const original = await role.inputValue();
  const replacement = original === "reviewer" ? "admin" : "reviewer";
  await role.selectOption(replacement);
  await page.getByRole("button", { name: "Change role" }).first().click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toContainText(/permissions change immediately/i);
  await dialog.getByRole("button", { name: "Keep current role" }).click();
  await expect(dialog).toBeHidden();
  await page.reload();
  await expect(page.getByRole("combobox", { name: /Role for admin@sessionparty\.local/ })).toHaveValue(original);
});

test("settings rejects a stale second organizer without overwriting the winning metadata", async ({ context, page, request, baseURL }, testInfo) => {
  desktopChromiumOnly(testInfo);
  const runtimeBaseURL = baseURL ?? "http://127.0.0.1:5173";
  const ownerHeaders = { Cookie: `sp_session=${OWNER_SESSION}` };
  const eventPath = `/api/v1/events/${EVENT_ID}`;
  const initialResponse = await request.get(eventPath, { headers: ownerHeaders });
  expect(initialResponse.status()).toBe(200);
  const initial = await initialResponse.json() as { readonly location: string | null; readonly version: number };
  const peer = await context.newPage();

  try {
    await openOwnerPage(context, page, runtimeBaseURL, "/settings");
    await installDeterministicBrowser(peer);
    await peer.goto(`/e/${EVENT}/settings`, { waitUntil: "domcontentloaded" });
    await peer.getByRole("heading", { level: 1, name: "Event settings" }).waitFor({ state: "visible" });
    await expect(page.getByRole("textbox", { name: "Location" })).toHaveValue(initial.location ?? "");
    await expect(peer.getByRole("textbox", { name: "Location" })).toHaveValue(initial.location ?? "");

    await page.getByRole("textbox", { name: "Location" }).fill("QA competing writer A");
    await page.getByRole("button", { name: "Save settings" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Event settings saved" }).first()).toBeVisible();

    await peer.getByRole("textbox", { name: "Location" }).fill("QA stale writer B");
    await peer.getByRole("button", { name: "Save settings" }).click();
    await expect(peer.getByRole("alert").filter({ hasText: /Event changed; reload before saving/i }).first()).toBeVisible();

    const canonicalResponse = await request.get(eventPath, { headers: ownerHeaders });
    expect(canonicalResponse.status()).toBe(200);
    const canonical = await canonicalResponse.json() as { readonly location: string | null; readonly version: number };
    expect(canonical.location).toBe("QA competing writer A");
    expect(canonical.version).toBe(initial.version + 1);
  } finally {
    await peer.close();
    const currentResponse = await request.get(eventPath, { headers: ownerHeaders });
    if (currentResponse.ok()) {
      const current = await currentResponse.json() as { readonly location: string | null; readonly version: number };
      if (current.location !== initial.location) {
        const restored = await request.patch(eventPath, {
          headers: ownerHeaders,
          data: { expectedVersion: current.version, location: initial.location },
        });
        expect(restored.status()).toBe(200);
      }
    }
  }
});

test("settings member controls apply role changes and removal immediately, then restore the fixture", async ({ context, page, request, baseURL }, testInfo) => {
  desktopChromiumOnly(testInfo);
  const runtimeBaseURL = baseURL ?? "http://127.0.0.1:5173";
  const ownerHeaders = { Cookie: `sp_session=${OWNER_SESSION}` };
  const adminHeaders = { Cookie: `sp_session=${ADMIN_SESSION}` };
  const collectionPath = `/api/v1/events/${EVENT_ID}/members`;
  const members = async () => {
    const response = await request.get(collectionPath, { headers: ownerHeaders });
    expect(response.status()).toBe(200);
    return response.json() as Promise<readonly { readonly id: string; readonly email: string; readonly role: string; readonly version: number }[]>;
  };
  const ensureAdminBaseline = async () => {
    const current = (await members()).find(({ email }) => email === ADMIN_EMAIL);
    if (!current) {
      const response = await request.post(collectionPath, {
        headers: ownerHeaders,
        data: { email: ADMIN_EMAIL, role: "admin", idempotencyKey: "qa-ui-member-finally-add" },
      });
      expect([200, 201]).toContain(response.status());
    } else if (current.role !== "admin") {
      const response = await request.patch(`${collectionPath}/${current.id}`, {
        headers: ownerHeaders,
        data: { role: "admin", expectedVersion: current.version, idempotencyKey: "qa-ui-member-finally-role" },
      });
      expect(response.status()).toBe(200);
    }
  };

  try {
    await openOwnerPage(context, page, runtimeBaseURL, "/settings");
    let row = page.getByRole("row").filter({ hasText: ADMIN_EMAIL });
    await expect(row).toBeVisible();

    await row.getByRole("combobox", { name: `Role for ${ADMIN_EMAIL}` }).selectOption("reviewer");
    await row.getByRole("button", { name: "Change role" }).click();
    let dialog = page.getByRole("alertdialog");
    await expect(dialog).toContainText(/permissions change immediately/i);
    await dialog.getByRole("button", { name: "Change role" }).click();
    await expect(row.getByText("reviewer", { exact: true }).first()).toBeVisible();

    const demotedSession = await request.get(collectionPath, { headers: adminHeaders });
    expect(demotedSession.status()).toBe(403);

    await row.getByRole("combobox", { name: `Role for ${ADMIN_EMAIL}` }).selectOption("admin");
    await row.getByRole("button", { name: "Change role" }).click();
    dialog = page.getByRole("alertdialog");
    await dialog.getByRole("button", { name: "Change role" }).click();
    await expect(row.getByText("admin", { exact: true }).first()).toBeVisible();
    expect((await request.get(collectionPath, { headers: adminHeaders })).status()).toBe(200);

    await row.getByRole("button", { name: "Remove" }).click();
    dialog = page.getByRole("alertdialog");
    await expect(dialog).toContainText(/lose their admin access.*immediately/i);
    await dialog.getByRole("button", { name: "Remove member" }).click();
    await expect(row).toHaveCount(0);
    expect((await request.get(`/api/v1/events/${EVENT_ID}`, { headers: adminHeaders })).status()).toBe(403);

    await page.getByRole("textbox", { name: "Existing account email" }).fill(ADMIN_EMAIL);
    await page.getByRole("combobox", { name: "Role", exact: true }).selectOption("admin");
    await page.getByRole("button", { name: "Add member" }).click();
    row = page.getByRole("row").filter({ hasText: ADMIN_EMAIL });
    await expect(row).toBeVisible();
    await expect(row.getByText("admin", { exact: true }).first()).toBeVisible();
    expect((await request.get(collectionPath, { headers: adminHeaders })).status()).toBe(200);

    await signIn(context, runtimeBaseURL, ADMIN_SESSION);
    await page.goto(`/e/${EVENT}/settings`);
    await page.getByRole("heading", { level: 1, name: "Event settings" }).waitFor({ state: "visible" });
    const addRole = page.getByRole("combobox", { name: "Role", exact: true });
    await expect(addRole.locator("option")).toHaveText(["Reviewer"]);
    const ownRow = page.getByRole("row").filter({ hasText: ADMIN_EMAIL });
    await expect(ownRow.getByText("Owner access required")).toBeVisible();
    await expect(ownRow.getByRole("button", { name: /Change role|Remove/ })).toHaveCount(0);
    const reviewerRow = page.getByRole("row").filter({ hasText: "sbek-reviewer@example.com" });
    await expect(reviewerRow.getByRole("button", { name: "Remove" })).toBeVisible();
    await expect(reviewerRow.getByRole("button", { name: "Change role" })).toHaveCount(0);
  } finally {
    await ensureAdminBaseline();
  }
});

test("browser history, logout, and a second tab converge on signed-out state", async ({ context, page, baseURL }, testInfo) => {
  desktopOnly(testInfo);
  const runtimeBaseURL = baseURL ?? "http://127.0.0.1:5173";
  await installDeterministicBrowser(page);
  await page.goto(`/login?returnTo=${encodeURIComponent(`/e/${EVENT}`)}`);
  await page.getByRole("button", { name: /Continue as Organizer/ }).click();
  await expect(page).toHaveURL(new RegExp(`/e/${EVENT}$`));
  await page.getByRole("heading", { level: 1 }).waitFor({ state: "visible" });
  await page.getByRole("link", { name: "Onboarding" }).click();
  await expect(page.locator('nav[aria-label="Event navigation"] a[aria-current="page"]')).toHaveText("Onboarding");
  await page.goBack();
  await expect(page.locator('nav[aria-label="Event navigation"] a[aria-current="page"]')).toHaveText("Overview");
  await page.goForward();
  await expect(page.locator('nav[aria-label="Event navigation"] a[aria-current="page"]')).toHaveText("Onboarding");

  const peer = await context.newPage();
  await peer.goto(`/e/${EVENT}/forms`);
  await expect(peer.getByRole("heading", { level: 1, name: "CFP & forms" })).toBeVisible();
  await page.getByRole("button", { name: "Log out" }).click();
  await expect(page).toHaveURL(/\/login$/);
  expect((await context.cookies()).some(({ name }) => name === "sp_session")).toBe(false);

  await peer.reload();
  await expect(peer.getByRole("heading", { level: 1, name: /Sign in|Could not load|Event not found/i })).toBeVisible();
  await expect(peer.getByRole("button", { name: "New additional form" })).toHaveCount(0);
});

test("every archive download has the promised filename and parseable projection", async ({ context, page, baseURL }, testInfo) => {
  desktopOnly(testInfo);
  await openOwnerPage(context, page, baseURL ?? "http://127.0.0.1:5173", "/exports");
  const downloads = [
    ["Download complete archive", `${EVENT}-archive.json`, "speakers"],
    ["Download speakers.json", `${EVENT}-speakers.json`, "speakers"],
    ["Download sessions.json", `${EVENT}-sessions.json`, "sessions"],
    ["Download submissions.json", `${EVENT}-submissions.json`, "submissions"],
    ["Download decisions.json", `${EVENT}-decisions.json`, "decisions"],
    ["Download onboarding.json", `${EVENT}-onboarding.json`, "tasks"],
  ] as const;

  for (const [buttonName, filename, projectionKey] of downloads) {
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.getByRole("button", { name: buttonName, exact: true }).click(),
    ]);
    expect(download.suggestedFilename()).toBe(filename);
    const path = await download.path();
    expect(path, `${filename} must produce readable bytes`).not.toBeNull();
    const body = await readFile(path!, "utf8");
    expect(body.endsWith("\n"), `${filename} should be a newline-terminated JSON file`).toBe(true);
    const value = JSON.parse(body) as Record<string, unknown>;
    expect(value.format).toBe("session-party.archive.v1");
    expect((value.event as { slug?: string }).slug).toBe(EVENT);
    expect(Array.isArray(value[projectionKey]), `${filename} must contain ${projectionKey}`).toBe(true);
  }
});

test("publication clipboard and persisted embed controls complete a versioned lifecycle", async ({ context, page, baseURL }, testInfo) => {
  desktopChromiumOnly(testInfo);
  const runtimeBaseURL = baseURL ?? "http://127.0.0.1:5173";
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: runtimeBaseURL });
  await openOwnerPage(context, page, runtimeBaseURL, "/publication");

  await page.getByRole("button", { name: "Copy public link" }).click();
  await expect(page.getByText("Public link copied", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(`${runtimeBaseURL}/event/${EVENT}/sessions`);

  const manager = page.getByRole("region", { name: "Embed & share" });
  await expect(manager.getByRole("heading", { name: /^Saved embeds/ })).toBeVisible();
  const widget = manager.getByRole("combobox", { name: "Widget" });
  const preset = manager.getByRole("combobox", { name: "Preset" });
  await widget.selectOption("speakerGallery");
  for (const option of ["speakerList", "speakerGallery"]) await preset.selectOption(option);
  await widget.selectOption("schedule");
  for (const option of ["sessions", "agenda", "itinerary"]) await preset.selectOption(option);
  await preset.selectOption("agenda");
  for (const aesthetic of ["bold", "minimal", "editorial"]) {
    await manager.getByRole("combobox", { name: "Design aesthetic" }).selectOption(aesthetic);
  }
  await manager.getByLabel("Brand color").fill("#123456");
  await manager.getByRole("combobox", { name: "Track filter" }).selectOption({ index: 1 });
  for (const field of ["Title", "Time", "Room", "Track", "Speakers", "Description"]) {
    const checkbox = manager.getByRole("checkbox", { name: field });
    await checkbox.uncheck();
    await expect(checkbox).not.toBeChecked();
    await checkbox.check();
  }

  await manager.getByRole("textbox", { name: "Embed name" }).fill("");
  await manager.getByRole("button", { name: "Create embed" }).click();
  await expect(manager.getByRole("status")).not.toHaveText("");
  await manager.getByRole("textbox", { name: "Embed name" }).fill("QA embed — 東京");
  await manager.getByRole("button", { name: "Create embed" }).click();
  await expect(manager.getByRole("status")).toContainText("Created “QA embed — 東京”");
  const saved = manager.locator("li").filter({ hasText: "QA embed — 東京" }).first();
  await expect(saved).toContainText("Schedule widget · agenda · v1 · Enabled");
  const code = saved.getByRole("textbox", { name: "QA embed — 東京 embed code" });
  await expect(code).toHaveValue(/<iframe[^>]+\/embed\/ai-engineer-sandbox\/embed_/);
  await expect(code).toHaveValue(/width:100%;min-height:720px/);
  await page.reload();
  const reloadedManager = page.getByRole("region", { name: "Embed & share" });
  const reloaded = reloadedManager.locator("li").filter({ hasText: "QA embed — 東京" }).first();
  await expect(reloaded).toBeVisible();
  await reloaded.getByRole("button", { name: "Edit" }).click();
  await reloadedManager.getByRole("combobox", { name: "Widget" }).selectOption("speakerGallery");
  await reloadedManager.getByRole("combobox", { name: "Preset" }).selectOption("speakerGallery");
  await reloadedManager.getByRole("button", { name: "Update embed" }).click();
  await expect(reloaded).toContainText("Speaker gallery widget · speakerGallery · v2 · Enabled");
  await reloaded.getByRole("button", { name: "Disable" }).click();
  await expect(reloaded).toContainText("Disabled");
  await expect(reloaded.getByRole("button", { name: "Copy embed code" })).toBeDisabled();
  await reloaded.getByRole("button", { name: "Enable" }).click();
  await reloaded.getByRole("button", { name: "Copy embed code" }).click();
  await expect(reloadedManager.getByRole("status")).toContainText("Copied “QA embed — 東京”.");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain("<iframe");
  const previewHref = await reloaded.getByRole("link", { name: "Preview" }).getAttribute("href");
  expect(previewHref).toMatch(/^\/embed\/ai-engineer-sandbox\/embed_/);

  for (const [buttonName, expected] of [
    ["Copy schedule page", `${runtimeBaseURL}/event/${EVENT}/schedule`],
    ["Copy speaker page", `${runtimeBaseURL}/event/${EVENT}/gallery`],
    ["Copy JSON feed", `${runtimeBaseURL}/events/${EVENT}/schedule.json`],
    ["Copy iCalendar feed", `${runtimeBaseURL}/events/${EVENT}/schedule.ics`],
  ] as const) {
    await reloadedManager.getByRole("button", { name: buttonName }).click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(expected);
  }
});

test("public program filters, deep links, history, and personal schedule controls preserve context", async ({ page }) => {
  const scheduleStorageKey = `session-party:${EVENT}:personal-schedule`;
  await page.goto(`/event/${EVENT}/sessions`);
  await page.getByRole("heading", { level: 1 }).waitFor({ state: "visible" });
  const nav = page.getByRole("navigation", { name: "Public event navigation" });
  for (const name of ["Sessions", "Speakers", "Agenda", "Schedule itinerary", "Speaker gallery"]) {
    await expect(nav.getByRole("link", { name })).toBeVisible();
  }

  const sessionSearch = page.getByRole("searchbox", { name: "Search sessions or speakers" });
  await sessionSearch.fill("QA no matching public session");
  await expect(page.getByRole("heading", { name: "No matching sessions" })).toBeVisible();
  await expect.poll(() => new URL(page.url()).searchParams.get("q")).toBe("QA no matching public session");
  await sessionSearch.fill("");
  await expect.poll(() => new URL(page.url()).searchParams.has("q")).toBe(false);

  for (const name of ["Track", "Room"] as const) {
    const select = page.getByRole("combobox", { name });
    const value = await select.locator('option:not([value=""])').first().getAttribute("value");
    expect(value, `${name} must expose a published filter fixture`).toBeTruthy();
    await select.selectOption(value!);
    await expect.poll(() => new URL(page.url()).searchParams.get(name.toLowerCase())).toBe(value);
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByRole("combobox", { name })).toHaveValue(value!);
    await page.getByRole("combobox", { name }).selectOption("");
    await expect.poll(() => new URL(page.url()).searchParams.has(name.toLowerCase())).toBe(false);
  }

  const sessionExpansion = page.getByRole("button", { name: "Show more", exact: true }).first();
  if (await sessionExpansion.count()) {
    await sessionExpansion.click();
    await expect(page.getByRole("button", { name: "Show less", exact: true }).first()).toHaveAttribute("aria-expanded", "true");
    await page.getByRole("button", { name: "Show less", exact: true }).first().press("Enter");
    await expect(page.getByRole("button", { name: "Show more", exact: true }).first()).toHaveAttribute("aria-expanded", "false");
  }

  const sessionLink = page.locator('main a[href*="/sessions/"]').first();
  await expect(sessionLink).toBeVisible();
  const sessionTitle = (await sessionLink.textContent())?.trim();
  expect(sessionTitle).toBeTruthy();
  await sessionSearch.fill(sessionTitle!);
  const sessionHref = await sessionLink.getAttribute("href");
  expect(sessionHref).toMatch(new RegExp(`^/event/${EVENT}/sessions/[^/]+\\?from=sessions`));
  await sessionLink.click();
  await expect(page).toHaveURL(new RegExp(`/event/${EVENT}/sessions/[^/]+`));
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await page.goBack({ waitUntil: "domcontentloaded" });
  await expect(page).toHaveURL(new RegExp(`/event/${EVENT}/sessions\\?`));
  await expect(page.getByRole("searchbox", { name: "Search sessions or speakers" })).toHaveValue(sessionTitle!);
  await page.locator('main a[href*="/sessions/"]').first().click();
  await page.getByRole("link", { name: "Back to sessions" }).click();
  await expect(page.getByRole("searchbox", { name: "Search sessions or speakers" })).toHaveValue(sessionTitle!);
  await page.getByRole("searchbox", { name: "Search sessions or speakers" }).fill("");

  await nav.getByRole("link", { name: "Speakers", exact: true }).click();
  const speakerSearch = page.getByRole("searchbox", { name: "Search speakers" });
  await speakerSearch.fill("QA no matching public speaker");
  await expect(page.getByRole("heading", { name: "No matching speakers" })).toBeVisible();
  await expect.poll(() => new URL(page.url()).searchParams.get("q")).toBe("QA no matching public speaker");
  await speakerSearch.fill("");
  await expect.poll(() => new URL(page.url()).searchParams.has("q")).toBe(false);
  const speakerLink = page.locator('main a[href*="/speakers/"]').first();
  const speakerName = (await speakerLink.textContent())?.trim();
  expect(speakerName).toBeTruthy();
  await speakerSearch.fill(speakerName!);
  await page.locator('main a[href*="/speakers/"]').first().click();
  await expect(page).toHaveURL(new RegExp(`/event/${EVENT}/speakers/[^/]+`));
  const biographyExpansion = page.getByRole("button", { name: "Show more biography" });
  if (await biographyExpansion.count()) {
    await biographyExpansion.click();
    await expect(page.getByRole("button", { name: "Show less biography" })).toHaveAttribute("aria-expanded", "true");
    await page.getByRole("button", { name: "Show less biography" }).press("Space");
    await expect(page.getByRole("button", { name: "Show more biography" })).toHaveAttribute("aria-expanded", "false");
  }
  await page.getByRole("link", { name: "Back to speakers" }).click();
  await expect(page.getByRole("searchbox", { name: "Search speakers" })).toHaveValue(speakerName!);

  await nav.getByRole("link", { name: "Speaker gallery" }).click();
  const galleryCard = page.locator("main ul button").first();
  await expect(galleryCard).toBeVisible();
  await galleryCard.focus();
  await galleryCard.press("Enter");
  await expect(page).toHaveURL(new RegExp(`/event/${EVENT}/speakers/[^/]+`));
  await page.getByRole("link", { name: "Back to speaker gallery" }).click();

  await nav.getByRole("link", { name: "Agenda" }).click();
  const dayTabs = page.getByRole("tab");
  if (await dayTabs.count() > 1) {
    const secondDay = dayTabs.nth(1);
    await secondDay.focus();
    await secondDay.press("Enter");
    await expect(secondDay).toHaveAttribute("aria-selected", "true");
    expect(new URL(page.url()).searchParams.get("day")).toBeTruthy();
  }
  const agendaDay = new URL(page.url()).searchParams.get("day");
  await page.locator('main a[href*="/sessions/"]').first().click();
  await page.getByRole("link", { name: "Back to agenda" }).click();
  if (agendaDay) expect(new URL(page.url()).searchParams.get("day")).toBe(agendaDay);

  await page.evaluate((key) => localStorage.removeItem(key), scheduleStorageKey);
  await nav.getByRole("link", { name: "Schedule itinerary" }).click();
  await expect(page).toHaveURL(new RegExp(`/event/${EVENT}/schedule$`));
  const mySchedule = page.getByRole("button", { name: "My schedule (0)" });
  await mySchedule.focus();
  await mySchedule.press("Enter");
  await expect(page.getByRole("heading", { name: "Your schedule is empty" })).toBeVisible();
  await page.getByRole("button", { name: "Full schedule" }).click();
  const scheduleItem = page.locator("main ol > li").first();
  const add = scheduleItem.getByRole("button", { name: "Add to my schedule" });
  await add.focus();
  await add.press("Space");
  await expect(scheduleItem.getByRole("button", { name: "Remove" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("button", { name: "My schedule (1)" })).toBeVisible();
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.getByRole("button", { name: "Remove" }).first()).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "My schedule (1)" }).click();
  const calendar = page.getByRole("link", { name: "Add to calendar (.ics)" });
  const calendarHref = await calendar.getAttribute("href");
  expect(calendarHref).toMatch(/^data:text\/calendar/);
  expect(decodeURIComponent(calendarHref!.split(",")[1] ?? "")).toContain("BEGIN:VCALENDAR");
  const downloadPromise = page.waitForEvent("download");
  await calendar.click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe(`${EVENT}-my-schedule.ics`);
  const downloadedPath = await download.path();
  expect(downloadedPath).not.toBeNull();
  expect(await readFile(downloadedPath!, "utf8")).toContain("BEGIN:VCALENDAR");
  const remove = page.getByRole("button", { name: "Remove" }).first();
  await remove.focus();
  await remove.press("Enter");
  await expect(page.getByRole("heading", { name: "Your schedule is empty" })).toBeVisible();
  await expect(page.getByRole("button", { name: "My schedule (0)" })).toBeVisible();
  await page.evaluate((key) => localStorage.removeItem(key), scheduleStorageKey);
});

test("public CFP supports conditional fields, co-speaker controls, validation, and local draft recovery", async ({ context, page, request }) => {
  const formsResponse = await request.get(`/api/v1/events/demo-event/forms`, {
    headers: { Cookie: `sp_session=${OWNER_SESSION}` },
  });
  expect(formsResponse.status()).toBe(200);
  const forms = await formsResponse.json() as readonly {
    readonly id: string;
    readonly purpose: string;
  }[];
  const cfp = forms.find(({ purpose }) => purpose === "primary-cfp");
  expect(cfp, "hydrated event must expose its primary CFP").toBeDefined();

  await context.clearCookies();
  await installDeterministicBrowser(page);
  await page.goto(`/submit/${EVENT}/${cfp!.id}`);
  await page.getByRole("heading", { level: 1 }).waitFor({ state: "visible" });

  const conditional = page.getByRole("textbox", { name: "Workshop exercise plan" });
  await expect(conditional).toHaveCount(0);
  await page.getByRole("combobox", { name: "Best-fit track" }).selectOption("Developer tools");
  await expect(conditional).toBeVisible();

  await page.getByRole("textbox", { name: "Session title" }).fill("QA conditional draft — 東京");
  await page.getByRole("textbox", { name: "Session abstract" }).fill("A deterministic draft for browser recovery.");
  await page.getByRole("textbox", { name: "Speaker name" }).fill("QA Speaker");
  await page.getByRole("textbox", { name: "Speaker email" }).fill("qa-speaker@example.test");
  await conditional.fill("Build, test, and explain the result.");

  await page.getByRole("button", { name: "Add co-speaker" }).click();
  const coSpeaker = page.getByRole("region", { name: "Co-speaker 1" });
  await coSpeaker.getByRole("textbox", { name: "Name" }).fill("QA Collaborator");
  const coSpeakerEmail = coSpeaker.getByRole("textbox", { name: "Email" });
  await coSpeakerEmail.fill("not-an-email");
  expect(await coSpeakerEmail.evaluate((field: HTMLInputElement) => field.validity.typeMismatch)).toBe(true);
  await coSpeaker.getByRole("button", { name: "Remove" }).click();
  await expect(coSpeaker).toHaveCount(0);

  await page.getByRole("button", { name: "Save draft" }).click();
  await expect(page.getByRole("status")).toContainText("Draft saved");
  await page.reload();
  await expect(page.getByRole("status")).toContainText("Draft restored");
  await expect(page.getByRole("textbox", { name: "Session title" })).toHaveValue("QA conditional draft — 東京");
  await expect(page.getByRole("textbox", { name: "Workshop exercise plan" })).toHaveValue("Build, test, and explain the result.");

  await page.getByRole("combobox", { name: "Best-fit track" }).selectOption("AI systems");
  await expect(page.getByRole("textbox", { name: "Workshop exercise plan" })).toHaveCount(0);
});

test("speaker upload rejects active content disguised as an allowed image without changing the asset list", async ({ context, page, baseURL }, testInfo) => {
  desktopOnly(testInfo);
  await signIn(context, baseURL ?? "http://127.0.0.1:5173", "demo-speaker-session");
  await installDeterministicBrowser(page);
  await page.goto(`/e/${EVENT}/portal`, { waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { level: 1 }).waitFor({ state: "visible" });
  const uploads = page.getByRole("region", { name: "Production files" });
  const before = await uploads.locator("li").allTextContents();
  await page.getByRole("combobox", { name: "File purpose" }).selectOption("headshot");
  await page.getByLabel("Choose files").setInputFiles({
    name: "renamed.png",
    mimeType: "image/png",
    buffer: Buffer.from("<html><script>document.location='https://attacker.invalid'</script></html>"),
  });
  await expect(page.getByRole("alert").first()).toContainText("Invalid headshot file content, type, extension, or size");
  await expect(uploads.getByText("renamed.png")).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(page.getByRole("region", { name: "Production files" }).locator("li")).toHaveText(before);
});
