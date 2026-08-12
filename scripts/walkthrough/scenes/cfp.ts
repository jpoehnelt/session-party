import { loginAs } from "../accounts";
import type { Scene } from "../types";

export const cfpScene: Scene = {
  id: "cfp",
  title: "A routed call for proposals",
  narration: "Organizers build and publish a routed CFP with tracks, formats, deadlines, required answers, and conditional questions. The hackathon demo disables interactive human verification; the production integration can be enabled later.",
  shortSeconds: 10,
  async run({ page, baseUrl, eventSlug, titleCard, spotlight, clearSpotlight, clearTechnicalOverlay, scrollBy, pause }) {
    await loginAs(page, baseUrl, "organizer", `/e/${eventSlug}/forms`);
    await page.goto(`${baseUrl}/e/${eventSlug}/forms`, { waitUntil: "networkidle" });
    await titleCard("Call for proposals", "Routed fields, conditional questions, deadlines, and one-click publishing.", [
      "Replaces|Form-builder and intake-automation SaaS",
      "Operations|forms.publish → immutable version; submit.create → proposal",
      "Validation|Effect Schema plus canonical semantic field roles",
      "Abuse budget|Durable Object limiter; Turnstile disabled only for this demo",
    ]);
    await spotlight("h1", "Organizer form builder");
    await pause(1_800);
    await clearSpotlight();
    const primary = page.getByText(/Call for proposals/i).first();
    if (await primary.count()) {
      await primary.click().catch(() => undefined);
      await pause(1_600);
    }
    await page.waitForURL(/formId=/);
    const formId = new URL(page.url()).searchParams.get("formId");
    if (!formId) throw new Error("The organizer CFP did not expose its current form id");
    await scrollBy(480);
    await pause(2_000);
    await clearTechnicalOverlay();
    await page.goto(`${baseUrl}/submit/${eventSlug}/${encodeURIComponent(formId)}`, { waitUntil: "networkidle" });
    await spotlight("h1", "Public CFP");
    await pause(1_200);
    await clearSpotlight();
    const title = page.getByLabel(/Session title/i).first();
    if (await title.count()) await title.fill("Taming 40-Minute CI: Incremental Builds at Monorepo Scale");
    const abstract = page.getByLabel(/Abstract/i).first();
    if (await abstract.count()) await abstract.fill("A concrete production case study with measured build, cache, and developer-feedback outcomes.");
    const format = page.getByLabel("Session format");
    if (await format.count()) {
      const workshop = (await format.locator("option").allTextContents()).find((option) => /workshop/i.test(option));
      if (workshop) await format.selectOption({ label: workshop });
      await pause(1_500);
    }
    const conditional = page.getByText("Workshop prerequisites", { exact: true });
    if (await conditional.count()) await spotlight("text=Workshop prerequisites", "Conditional question");
    await pause(2_000);
    await clearSpotlight();
    const disclosure = page.getByText(/Demo verification disabled/i);
    if (await disclosure.count()) await spotlight("text=/Demo verification disabled/i", "Hackathon demo only");
    await pause(2_500);
    await clearSpotlight();
  },
};
