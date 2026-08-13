import { loginAs } from "../accounts";
import type { Scene } from "../types";

export const speakerPortalScene: Scene = {
  id: "speaker_portal",
  title: "One speaker production workspace",
  narration: "The speaker sees the accepted session, profile, exact due dates, uploads, comments, logistics, and readiness in one workspace. Uploaded headshots and slides persist and remain visible to the organizer.",
  shortSeconds: 11,
  async run({ page, baseUrl, eventSlug, titleCard, spotlight, clearSpotlight, clearTechnicalOverlay, scrollBy, pause }) {
    await loginAs(page, baseUrl, "speaker", `/e/${eventSlug}/portal`);
    await page.goto(`${baseUrl}/e/${eventSlug}/portal`, { waitUntil: "networkidle" });
    await titleCard("Speaker portal", "Accepted session, production tasks, profile, files, and organizer feedback.", [
      "Replaces|Speaker-management portal and asset inbox SaaS",
      "Read model|Exact accepted speaker → session, tasks, readiness, logistics",
      "Writes|portal task completion; portal.uploadAsset",
      "State|R2 object plus D1 owner, version, task, and reviewed-profile metadata",
    ]);
    const accepted = page.getByText(/Taming 40-Minute CI/i).first();
    if (await accepted.count()) await spotlight("text=Taming 40-Minute CI", "Accepted session");
    await pause(1_800);
    await clearSpotlight();
    const participation = page.getByRole("checkbox", { name: /Confirm participation/i });
    if (await participation.count()) {
      await spotlight("label:has-text('Confirm participation')", "Persisted task state");
      await pause(1_800);
      await clearSpotlight();
    }
    await scrollBy(520);
    await clearTechnicalOverlay();
    const headshot = page.getByText(/Uploaded: headshot\.png/i).first();
    if (await headshot.count()) await spotlight("text=Uploaded: headshot.png", "Persisted upload");
    await pause(2_000);
    await clearSpotlight();
    const comments = page.locator("ul[aria-label='Comments for slides.pdf']").first();
    if (await comments.count()) await spotlight("ul[aria-label='Comments for slides.pdf']", "Cross-role file thread");
    await pause(2_200);
    await clearSpotlight();
  },
};
