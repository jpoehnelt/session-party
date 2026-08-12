import { loginAs } from "../accounts";
import type { Scene } from "../types";

export const reviewScene: Scene = {
  id: "review",
  title: "Blind, structured review",
  narration: "Reviewers see only their assignments. Blind rounds hide speaker identity, rubrics capture structured scores and comments, and AI suggestions remain labeled and subordinate to the human decision.",
  shortSeconds: 10,
  async run({ page, baseUrl, eventSlug, titleCard, spotlight, clearSpotlight, scrollBy, pause }) {
    await loginAs(page, baseUrl, "reviewer", `/e/${eventSlug}/review`);
    await page.goto(`${baseUrl}/e/${eventSlug}/review`, { waitUntil: "networkidle" });
    await titleCard("Review workspace", "Scoped assignments, blind evidence, rubric scores, and human-owned decisions.", [
      "Replace review SaaS → reviewer-scoped blind projections",
      "Versioned rubric scores + optional AI assistance",
      "Domain changes + audit evidence persisted in D1",
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
    await pause(2_200);
    await clearSpotlight();
    await scrollBy(520);
    await pause(3_000);
  },
};
