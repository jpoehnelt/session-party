import { loginAs } from "../accounts";
import type { Scene } from "../types";

export const agendaScene: Scene = {
  id: "agenda",
  title: "Conflict-aware agenda building",
  narration: "Accepted proposals enter the agenda without retyping. Organizers place sessions across days, rooms, and tracks; named conflict validation protects the plan, and publication enforces a clean schedule.",
  shortSeconds: 9,
  async run({ page, baseUrl, eventSlug, titleCard, spotlight, clearSpotlight, scrollBy, pause }) {
    await loginAs(page, baseUrl, "organizer", `/e/${eventSlug}/agenda`);
    await page.goto(`${baseUrl}/e/${eventSlug}/agenda`, { waitUntil: "networkidle" });
    await titleCard("Agenda builder", "Multi-day placement with named room and speaker conflict checks.", [
      "Replace scheduling SaaS → agenda.createTalk + placement ops",
      "Normalized speaker identity conflict graph",
      "D1 draft → immutable publication revision",
    ]);
    await spotlight("h1", "Private agenda");
    await pause(1_600);
    await clearSpotlight();
    const taming = page.getByText(/Taming 40-Minute CI/i).first();
    if (await taming.count()) await spotlight("text=/Taming 40-Minute CI/i", "Accepted backlog");
    await pause(2_000);
    await clearSpotlight();
    const conflict = page.getByText(/00.*conflict/i).first();
    if (await conflict.count()) await spotlight("text=/00.*conflict/i", "Clear to publish");
    await pause(2_000);
    await clearSpotlight();
    await scrollBy(500);
    await pause(3_000);
  },
};
