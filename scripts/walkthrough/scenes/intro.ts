import type { Scene } from "../types";

export const introScene: Scene = {
  id: "intro",
  title: "Session Party",
  narration: "Session Party is an open-source, Cloudflare-native replacement for the event operations workflow—proposals, review, speakers, agenda, and public program in one place.",
  shortSeconds: 7,
  async run({ page, baseUrl, eventSlug, titleCard, spotlight, clearSpotlight, clearTechnicalOverlay, scrollBy, pause }) {
    await page.goto(`${baseUrl}/event/${eventSlug}/sessions`, { waitUntil: "networkidle" });
    await titleCard("Session Party", "From call for proposals to a published program—without the SaaS lock-in.", [
      "Replaces|Form, review, speaker, scheduling, live-ops, and widget SaaS",
      "Runtime|One Cloudflare Worker with D1, R2, and Durable Objects",
      "Public contract|Immutable revision → pages, embeds, HTML, JSON, XML, iCal",
      "Ownership|Open code and portable event-scoped data",
    ]);
    await spotlight("h1", "Live public program");
    await pause(2_000);
    await clearSpotlight();
    await scrollBy(520);
    await pause(3_000);
    await clearTechnicalOverlay();
  },
};
