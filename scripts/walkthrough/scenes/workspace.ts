import { loginAs } from "../accounts";
import type { Scene } from "../types";

export const workspaceScene: Scene = {
  id: "workspace",
  title: "The organizer production loop",
  narration: "The organizer moves from readiness to content, communications, and integrations without leaving the event workspace.",
  shortSeconds: 6,
  async run({ page, baseUrl, eventSlug, titleCard, spotlight, clearSpotlight, clearTechnicalOverlay, pause }) {
    await loginAs(page, baseUrl, "organizer", `/e/${eventSlug}/dashboard`);
    await page.goto(`${baseUrl}/e/${eventSlug}/dashboard`, { waitUntil: "networkidle" });
    await titleCard("Organizer production loop", "Readiness, files, outreach, and external feeds share one event identity.", [
      "Replaces|Multi-product organizer administration",
      "Boundary|Registered OperationDef → Effect service → tagged domain errors",
      "Authorization|Role and event membership checked per operation",
      "State|Multi-tenant D1 records with domain-change and audit evidence",
    ]);
    await spotlight("h1", "Speaker readiness matrix");
    await pause(1_400);
    await clearSpotlight();
    const attention = page.getByRole("checkbox", { name: /Needs attention only/i });
    if (await attention.count()) {
      await attention.check();
      await pause(1_800);
    }

    await page.goto(`${baseUrl}/e/${eventSlug}/content`, { waitUntil: "networkidle" });
    await spotlight("h1", "Versioned content library");
    const history = page.getByLabel("Versions");
    if (await history.count()) await history.selectOption("history");
    await pause(1_800);
    await clearSpotlight();

    await page.goto(`${baseUrl}/e/${eventSlug}/comms?tab=history`, { waitUntil: "networkidle" });
    await spotlight("h1", "Durable delivery history");
    await pause(1_800);
    await clearSpotlight();

    await page.goto(`${baseUrl}/e/${eventSlug}/integrations`, { waitUntil: "networkidle" });
    await spotlight("h1", "Import and sync evidence");
    await pause(2_200);
    await clearSpotlight();
    await clearTechnicalOverlay();
  },
};
