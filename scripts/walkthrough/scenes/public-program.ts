import type { Scene } from "../types";

export const publicProgramScene: Scene = {
  id: "widgets_and_close",
  title: "A calm audience experience",
  narration: "Attendees browse sessions, speakers, agenda, schedule, and gallery without an account. Search, filters, personal schedules, speaker photos, and calendar export all use the same published source of truth.",
  shortSeconds: 10,
  async run({ page, baseUrl, eventSlug, titleCard, spotlight, clearSpotlight, pause }) {
    await page.goto(`${baseUrl}/embed/${eventSlug}/embed_p4AlHKPU3DCwFg9m5sgx_`, { waitUntil: "networkidle" });
    if (await page.getByText(/Embed unavailable/i).count()) {
      await page.goto(`${baseUrl}/event/${eventSlug}/sessions`, { waitUntil: "networkidle" });
    }
    await titleCard("Stable widgets and public pages", "Embed once, refresh in place, and give every attendee a calm public program.", [
      "Replace widget SaaS → stable embed + live revision lookup",
      "Anonymous public routes with CORS + ETag feeds",
      "One published source across every audience surface",
    ]);
    await spotlight("body", "Stable public projection");
    await pause(2_000);
    await clearSpotlight();
    await page.goto(`${baseUrl}/event/${eventSlug}/speakers`, { waitUntil: "domcontentloaded" });
    await page.getByRole("heading", { name: "Speakers" }).waitFor({ state: "visible", timeout: 15_000 });
    await spotlight("h1", "Published speaker directory");
    await pause(1_500);
    await clearSpotlight();
    const agendaLink = page.getByRole("link", { name: /Agenda/i }).first();
    if (await agendaLink.count()) {
      await agendaLink.click();
      await page.waitForLoadState("networkidle");
      await pause(3_000);
    }
    const galleryLink = page.getByRole("link", { name: /Gallery/i }).first();
    if (await galleryLink.count()) {
      await galleryLink.click();
      await page.waitForLoadState("networkidle");
      await pause(3_000);
    }
  },
};
