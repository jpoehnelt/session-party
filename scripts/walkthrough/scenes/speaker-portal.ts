import { loginAs } from "../accounts";
import type { Scene } from "../types";

export const speakerPortalScene: Scene = {
  id: "speaker_portal",
  title: "One speaker production workspace",
  narration: "The speaker sees the accepted session, profile, exact due dates, uploads, comments, logistics, and readiness in one workspace. Uploaded headshots and slides persist and remain visible to the organizer.",
  shortSeconds: 11,
  async run({ page, baseUrl, eventSlug, titleCard, spotlight, clearSpotlight, scrollBy, pause }) {
    await loginAs(page, baseUrl, "speaker", `/e/${eventSlug}/portal`);
    await page.goto(`${baseUrl}/e/${eventSlug}/portal`, { waitUntil: "networkidle" });
    await titleCard("Speaker portal", "Accepted session, production tasks, profile, files, and organizer feedback.", [
      "Replace speaker SaaS → accepted-session + task projection",
      "Reusable profile ↔ reviewed event snapshot",
      "Versioned uploads in R2 with D1 metadata",
    ]);
    const accepted = page.getByText(/Taming 40-Minute CI/i).first();
    if (await accepted.count()) await spotlight("text=Taming 40-Minute CI", "Accepted session");
    await pause(1_800);
    await clearSpotlight();
    await scrollBy(520);
    await pause(2_800);
    const headshot = page.getByText(/Uploaded: headshot\.png/i).first();
    if (await headshot.count()) await spotlight("text=Uploaded: headshot.png", "Persisted upload");
    await pause(2_000);
    await clearSpotlight();
    await scrollBy(620);
    await pause(3_000);
  },
};
