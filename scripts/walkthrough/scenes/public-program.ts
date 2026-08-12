import type { Scene } from "../types";

export const publicProgramScene: Scene = {
  id: "widgets_and_close",
  title: "A calm audience experience",
  narration: "Attendees browse sessions, speakers, agenda, schedule, and gallery without an account. Search, filters, personal schedules, speaker photos, and calendar export all use the same published source of truth.",
  shortSeconds: 10,
  async run({ page, baseUrl, eventSlug, state, titleCard, spotlight, clearSpotlight, clearTechnicalOverlay, pause }) {
    const embedPath = state.get("publicEmbedPath");
    if (!embedPath) throw new Error("The publication scene did not provide a current public embed path");
    await page.goto(new URL(embedPath, baseUrl).toString(), { waitUntil: "networkidle" });
    if (await page.getByText(/Embed unavailable/i).count()) throw new Error("The discovered public embed is unavailable");
    await titleCard("Stable widgets and public pages", "Embed once, refresh in place, and give every attendee a calm public program.", [
      "Replaces|Hosted widget vendor and proprietary export layer",
      "Resolve|Stable embed ID → enabled definition → live published revision",
      "Privacy|Confirmed audience fields only; no organizer session required",
      "Portability|Iframe plus cacheable CORS/ETag feeds",
    ]);
    await spotlight("body", "Stable public projection");
    await pause(2_000);
    await clearSpotlight();
    await clearTechnicalOverlay();
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
