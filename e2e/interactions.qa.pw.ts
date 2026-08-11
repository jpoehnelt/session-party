import { expect, test, type BrowserContext, type Page, type TestInfo } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { installDeterministicBrowser } from "./helpers/visual-readiness";

const EVENT = "ai-engineer-sandbox";
const OWNER_SESSION = "demo-owner-session";

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

test("communications tabs and new-template editor preserve local-only state", async ({ context, page, baseURL }, testInfo) => {
  desktopOnly(testInfo);
  await openOwnerPage(context, page, baseURL ?? "http://127.0.0.1:5173", "/comms");
  for (const name of ["01 / Templates", "02 / Audience & queue", "03 / Delivery history"]) {
    const tab = page.getByRole("tab", { name });
    await tab.click();
    await expect(tab).toHaveAttribute("aria-selected", "true");
  }
  await page.getByRole("tab", { name: "01 / Templates" }).click();
  await page.getByRole("button", { name: "+ New template" }).click();
  await expect(page.getByRole("heading", { name: /New message master/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /Create template|Save changes/ })).toBeVisible();
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
