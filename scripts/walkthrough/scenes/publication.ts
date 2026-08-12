import { loginAs } from "../accounts";
import type { Scene } from "../types";

export const publicationScene: Scene = {
  id: "publication",
  title: "Publish once, distribute everywhere",
  narration: "Publishing creates an immutable audience revision. Organizers can refresh stable live widgets, configure embeds, and distribute the same privacy-filtered program as HTML, JSON, XML, and iCalendar.",
  shortSeconds: 9,
  async run({ page, baseUrl, eventSlug, titleCard, spotlight, clearSpotlight, scrollBy, pause }) {
    await loginAs(page, baseUrl, "organizer", `/e/${eventSlug}/publication`);
    await page.goto(`${baseUrl}/e/${eventSlug}/publication`, { waitUntil: "networkidle" });
    await titleCard("Publication", "Immutable revisions, stable embeds, and standards-based schedule feeds.", [
      "Replace publishing SaaS → immutable audience revision",
      "Privacy-filtered public projection",
      "HTML + JSON + XML + iCalendar endpoints",
    ]);
    await spotlight("h1", "Audience revision");
    await pause(1_500);
    await clearSpotlight();
    const refresh = page.getByRole("button", { name: /Refresh live widgets/i });
    if (await refresh.count()) await spotlight("button:has-text('Refresh live widgets')", "Stable live URL");
    await pause(2_000);
    await clearSpotlight();
    await scrollBy(720);
    await pause(2_800);
    const formats = page.getByText("Output formats", { exact: true }).first();
    if (await formats.count()) await spotlight("text=Output formats", "HTML · JSON · XML · iCal");
    await pause(2_600);
    await clearSpotlight();
  },
};
