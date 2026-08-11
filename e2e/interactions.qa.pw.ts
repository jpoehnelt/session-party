import { expect, test, type BrowserContext, type Page, type TestInfo } from "@playwright/test";
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
