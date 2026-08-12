import { loginAs } from "../accounts";
import type { Scene } from "../types";

export const publicationScene: Scene = {
  id: "publication",
  title: "Publish once, distribute everywhere",
  narration: "Publishing creates an immutable audience revision. Organizers can refresh stable live widgets, configure embeds, and distribute the same privacy-filtered program as HTML, JSON, XML, and iCalendar.",
  shortSeconds: 9,
  async run({ page, baseUrl, eventSlug, state, titleCard, spotlight, clearSpotlight, scrollBy, pause }) {
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

    let enabled = page.getByRole("listitem").filter({ hasText: /· Enabled/i }).first();
    if (!(await enabled.count())) {
      const disabled = page.getByRole("listitem").filter({ hasText: /· Disabled/i }).first();
      if (await disabled.count()) {
        await disabled.getByRole("button", { name: "Enable" }).click();
        await page.getByText(/Enabled “/i).waitFor({ state: "visible" });
      } else {
        await page.getByLabel("Embed name").fill("Walkthrough schedule");
        await page.getByRole("button", { name: "Create embed" }).click();
        await page.getByText(/Created “Walkthrough schedule”/i).waitFor({ state: "visible" });
      }
      enabled = page.getByRole("listitem").filter({ hasText: /· Enabled/i }).first();
    }
    const embedPath = await enabled.getByRole("link", { name: "Preview" }).getAttribute("href");
    if (!embedPath) throw new Error("Publication did not expose an enabled embed preview path");
    state.set("publicEmbedPath", embedPath);
  },
};
