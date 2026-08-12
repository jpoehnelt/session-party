import { loginAs } from "../accounts";
import type { Scene } from "../types";

export const workspaceScene: Scene = {
  id: "workspace",
  title: "The organizer control room",
  narration: "The AI Engineer Sandbox brings proposals, review, speakers, tasks, content, agenda, communications, publication, and exports into one operational workspace, with readiness and next actions always visible.",
  shortSeconds: 6,
  async run({ page, baseUrl, eventSlug, titleCard, spotlight, clearSpotlight, clearTechnicalOverlay, scrollBy, pause }) {
    await loginAs(page, baseUrl, "organizer", `/e/${eventSlug}`);
    await page.goto(`${baseUrl}/e/${eventSlug}`, { waitUntil: "networkidle" });
    await titleCard("Organizer control room", "One operational home for the whole event team.", [
      "Replaces|Multi-product organizer administration",
      "Boundary|Registered OperationDef → Effect service → tagged domain errors",
      "Authorization|Role and event membership checked per operation",
      "State|Multi-tenant D1 records with domain-change and audit evidence",
    ]);
    await spotlight("h1", "AI Engineer Sandbox");
    await pause(1_800);
    await clearSpotlight();
    await scrollBy(420);
    await pause(3_000);
    await clearTechnicalOverlay();
  },
};
