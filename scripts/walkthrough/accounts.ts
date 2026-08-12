import type { Page } from "playwright";
import type { DemoRole } from "./types";

const roleLabels: Record<DemoRole, RegExp> = {
  organizer: /Continue as Organizer/i,
  reviewer: /Continue as Reviewer/i,
  speaker: /Continue as Speaker/i,
};

export async function loginAs(page: Page, baseUrl: string, role: DemoRole, returnTo = "/events") {
  await page.goto(`${baseUrl}/login?returnTo=${encodeURIComponent(returnTo)}`, { waitUntil: "domcontentloaded" });
  const button = page.getByRole("button", { name: roleLabels[role] });
  await button.waitFor({ state: "visible", timeout: 15_000 });
  await button.click();
  await page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 15_000 });
  await page.waitForLoadState("domcontentloaded");
}

export async function logout(page: Page) {
  const button = page.getByRole("button", { name: "Log out" });
  if (await button.count()) {
    await button.click();
    await page.waitForURL((url) => url.pathname.startsWith("/login"), { timeout: 10_000 });
  }
}
