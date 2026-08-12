import { loginAs } from "../accounts";
import type { Scene } from "../types";

export const reviewScene: Scene = {
  id: "review",
  title: "Blind, structured review",
  narration: "Reviewers see only their assignments. Blind rounds hide speaker identity, rubrics capture structured scores and comments, and AI suggestions remain labeled and subordinate to the human decision.",
  shortSeconds: 10,
  async run({ page, baseUrl, eventSlug, titleCard, spotlight, clearSpotlight, clearTechnicalOverlay, pause }) {
    await loginAs(page, baseUrl, "reviewer", `/e/${eventSlug}/review`);
    await page.goto(`${baseUrl}/e/${eventSlug}/review`, { waitUntil: "networkidle" });
    await titleCard("Review workspace", "Scoped assignments, blind evidence, rubric scores, and human-owned decisions.", [
      "Replaces|Committee-review SaaS and scoring spreadsheets",
      "Read model|review.getWorkbench → assigned, optionally blind projection",
      "Writes|review.saveScore; review.acceptSubmission",
      "Guarantee|AI suggestion is labeled; human review and audit remain authoritative",
    ]);
    await spotlight("h1", "Reviewer queue");
    await pause(1_500);
    await clearSpotlight();
    const target = page.getByRole("button", { name: /Taming 40-Minute CI/i }).first();
    if (await target.count()) {
      await target.click();
      await pause(2_000);
    }
    const ai = page.getByRole("button", { name: /Request AI suggestion/i });
    if (await ai.count()) await spotlight("button:has-text('Request AI suggestion')", "Optional AI assist");
    await pause(1_500);
    await clearSpotlight();
    const useDraft = page.getByRole("button", { name: /Use as draft/i }).first();
    if (await useDraft.count()) {
      await useDraft.click();
      await pause(1_300);
    }
    const save = page.getByRole("button", { name: /Save my review/i });
    if (await save.count()) {
      await spotlight("button:has-text('Save my review')", "Human commit boundary");
      await pause(2_000);
      await clearSpotlight();
    }
    await clearTechnicalOverlay();
  },
};
