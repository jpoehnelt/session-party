import { loginAs } from "../accounts";
import type { Scene } from "../types";

export const liveShowScene: Scene = {
  id: "live_show",
  title: "Real-time show control",
  narration: "The live desk is coordinated by a per-event PartyServer Durable Object. Show state, timers, holds, and room-targeted cues update in real time; reconnects refresh the canonical agenda while the Durable Object preserves the active run of show.",
  shortSeconds: 10,
  async run({ page, baseUrl, eventSlug, titleCard, spotlight, clearSpotlight, pause }) {
    await loginAs(page, baseUrl, "organizer", `/e/${eventSlug}/agenda`);
    await page.goto(`${baseUrl}/e/${eventSlug}/agenda`, { waitUntil: "networkidle" });
    await page.getByRole("button", { name: "Open live show" }).click();
    await page.getByText("Live show control", { exact: true }).waitFor({ state: "visible" });
    await titleCard("PartyServer live desk", "A per-event Durable Object coordinates cues, timers, holds, and reconnect-safe show state.", [
      "Replace live-ops SaaS → React desk + PartySocket",
      "EventRoom PartyServer Durable Object",
      "Authoritative show state → broadcast + reconnect",
    ]);

    const reset = page.getByRole("button", { name: "Reset" });
    if (await reset.isEnabled().catch(() => false)) {
      await reset.click();
      await pause(1_000);
    }
    const session = page.getByLabel("Current session");
    const options = await session.locator("option").all();
    if (options.length < 2) throw new Error("Live show has no scheduled session to demonstrate");
    await session.selectOption({ index: 1 });
    await spotlight("select:has(option:text-is('Choose a scheduled session'))", "Choose a live session");
    await pause(1_500);
    await clearSpotlight();

    await page.getByRole("button", { name: "Set ready" }).click();
    await pause(1_300);
    await page.getByRole("button", { name: "Start", exact: true }).first().click();
    await spotlight("text=Now on stage", "Shared running state");
    await pause(2_000);
    await clearSpotlight();
    await page.getByRole("button", { name: "Hold", exact: true }).first().click();
    await spotlight("text=held", "Live hold");
    await pause(2_000);
    await clearSpotlight();
    await page.getByRole("button", { name: "Resume", exact: true }).click();
    await pause(1_500);

    await page.reload({ waitUntil: "networkidle" });
    await page.getByRole("button", { name: "Open live show" }).click();
    await page.getByText("Live show control", { exact: true }).waitFor({ state: "visible" });
    await spotlight("text=running", "Persisted after reconnect");
    await pause(2_500);
    await clearSpotlight();
    const resetAfterReload = page.getByRole("button", { name: "Reset" });
    if (await resetAfterReload.isEnabled().catch(() => false)) await resetAfterReload.click();
    await pause(2_000);
  },
};
