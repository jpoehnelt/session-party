import { expect, test, type BrowserContext, type Page, type TestInfo } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { installDeterministicBrowser } from "./helpers/visual-readiness";

const EVENT = "ai-engineer-sandbox";
const EVENT_ID = "demo-event";
const OWNER_SESSION = "demo-owner-session";
const ADMIN_SESSION = "demo-admin-session";
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

test("onboarding contact editor can open and Cancel without recording contact", async ({ context, page, baseURL }, testInfo) => {
  desktopOnly(testInfo);
  await openOwnerPage(context, page, baseURL ?? "http://127.0.0.1:5173", "/dashboard");
  const trigger = page.getByRole("button", { name: "Log contact" }).first();
  await trigger.click();
  await expect(page.getByRole("button", { name: "Save contact" }).first()).toBeVisible();
  await page.getByRole("button", { name: "Cancel" }).first().click();
  await expect(page.getByRole("button", { name: "Save contact" })).toHaveCount(0);
  await expect(trigger).toBeVisible();
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

test("publication clipboard and embed-builder controls round-trip without server mutation", async ({ context, page, baseURL }, testInfo) => {
  desktopChromiumOnly(testInfo);
  const runtimeBaseURL = baseURL ?? "http://127.0.0.1:5173";
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: runtimeBaseURL });
  await openOwnerPage(context, page, runtimeBaseURL, "/publication");

  await page.getByRole("button", { name: "Copy public link" }).click();
  await expect(page.getByText("Public link copied", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(`${runtimeBaseURL}/event/${EVENT}/sessions`);

  const generated = page.getByRole("textbox", { name: "Generated share URL or code" });
  const initialCode = await generated.inputValue();
  for (const widget of ["sessions", "speakers", "agenda", "schedule", "gallery"]) {
    await page.getByRole("combobox", { name: "Widget type" }).selectOption(widget);
    expect(await generated.inputValue()).toContain(widget === "speakers" || widget === "gallery" ? "/speakers" : "/schedule");
  }
  await page.getByRole("combobox", { name: "Widget type" }).selectOption("sessions");
  for (const format of ["styled-html", "plain-html", "json", "ical"]) {
    await page.getByRole("combobox", { name: "Output format" }).selectOption(format);
    expect(await generated.inputValue(), `${format} must produce output`).not.toBe("");
  }
  await page.getByRole("combobox", { name: "Output format" }).selectOption("styled-html");
  for (const aesthetic of ["bold", "minimal", "editorial"]) {
    await page.getByRole("combobox", { name: "Design aesthetic" }).selectOption(aesthetic);
    expect(await generated.inputValue()).toContain(`aesthetic=${aesthetic}`);
  }
  await page.getByLabel("Brand color").fill("#123456");
  expect(await generated.inputValue()).toContain("123456");
  for (const field of ["Title", "Time", "Room", "Track", "Speakers", "Description"]) {
    const checkbox = page.getByRole("checkbox", { name: field });
    await checkbox.uncheck();
    await expect(checkbox).not.toBeChecked();
    await checkbox.check();
  }
  expect(await generated.inputValue()).not.toBe(initialCode);

  await page.getByRole("textbox", { name: "Embed name" }).fill("");
  await page.getByRole("button", { name: "Save embed definition" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Name this embed before saving." })).toBeVisible();
  await page.getByRole("textbox", { name: "Embed name" }).fill("QA embed — 東京");
  await page.getByRole("button", { name: "Save embed definition" }).click();
  await expect(page.getByRole("heading", { name: "Saved embeds (1)" })).toBeVisible();
  await page.reload();
  await expect(page.getByText("QA embed — 東京", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Disable" }).click();
  await expect(page.getByText(/sessions · styled-html · Disabled/)).toBeVisible();
  await page.getByRole("button", { name: "Enable" }).click();
  await page.getByRole("button", { name: "Get code" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Copied “QA embed — 東京”." })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain("<iframe");
  await page.getByRole("button", { name: "Delete" }).click();
  await expect(page.getByRole("heading", { name: "Saved embeds (0)" })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("heading", { name: "Saved embeds (0)" })).toBeVisible();
});

test("public program navigation, session detail, and personal schedule controls work on mobile", async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.startsWith("mobile"), "mobile public-program interaction");
  await page.goto(`/event/${EVENT}/sessions`);
  await page.getByRole("heading", { level: 1 }).waitFor({ state: "visible" });
  const nav = page.getByRole("navigation", { name: "Public event navigation" });
  for (const name of ["Sessions", "Speakers", "Agenda", "Schedule itinerary", "Speaker gallery", "Embed & share"]) {
    await expect(nav.getByRole("link", { name })).toBeVisible();
  }
  const sessionButton = page.locator('main button[type="button"]').first();
  await sessionButton.click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Close" }).click();
  await expect(dialog).toBeHidden();
  await nav.getByRole("link", { name: "Schedule itinerary" }).click();
  await expect(page).toHaveURL(new RegExp(`/event/${EVENT}/schedule$`));
  await expect(page.getByRole("button", { name: /^My schedule \(\d+\)$/i })).toBeVisible();
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
