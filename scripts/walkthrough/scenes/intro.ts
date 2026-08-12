import type { Scene } from "../types";

export const introScene: Scene = {
  id: "intro",
  title: "Session Party",
  narration: "Session Party is an open-source, Cloudflare-native replacement for the event operations workflow—proposals, review, speakers, agenda, and public program in one place.",
  shortSeconds: 7,
  async run({ page, baseUrl, eventSlug, titleCard, spotlight, clearSpotlight, scrollBy, pause }) {
    await page.goto(`${baseUrl}/event/${eventSlug}/sessions`, { waitUntil: "networkidle" });
    await titleCard("Session Party", "From call for proposals to a published program—without the SaaS lock-in.", [
      "Replace the event-ops SaaS suite with one Cloudflare Worker",
      "Published revision → sessions + speakers + gallery",
      "Open code + event-scoped data ownership",
    ]);
    await spotlight("h1", "Live public program");
    await pause(2_000);
    await clearSpotlight();
    await scrollBy(520);
    await pause(3_000);
  },
};
