import { loginAs } from "../accounts";
import type { Scene } from "../types";

export const workspaceScene: Scene = {
  id: "workspace",
  title: "The organizer control room",
  narration: "The AI Engineer Sandbox brings proposals, review, speakers, tasks, content, agenda, communications, publication, and exports into one operational workspace, with readiness and next actions always visible.",
  shortSeconds: 6,
  async run({ page, baseUrl, eventSlug, titleCard, spotlight, clearSpotlight, scrollBy, pause }) {
    await loginAs(page, baseUrl, "organizer", `/e/${eventSlug}`);
    await page.goto(`${baseUrl}/e/${eventSlug}`, { waitUntil: "networkidle" });
    await titleCard("Organizer control room", "One operational home for the whole event team.", [
      "Replace admin SaaS → React Router + registered operations",
      "Effect services + role authorization at the boundary",
      "Multi-tenant event records in Cloudflare D1",
    ]);
    await spotlight("h1", "AI Engineer Sandbox");
    await pause(1_800);
    await clearSpotlight();
    await scrollBy(420);
    await pause(3_000);
  },
};
