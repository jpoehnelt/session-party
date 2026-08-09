import { describe, expect, it } from "vitest";
import { availableEventNavItems } from "./event-nav";

describe("availableEventNavItems", () => {
  it("shows only registered feature routes and adds review when its route exists", () => {
    const baseRoutes = ["/e/:eventSlug", "/e/:eventSlug/forms", "/e/:eventSlug/agenda"];

    expect(availableEventNavItems(baseRoutes).map(({ label }) => label)).toEqual([
      "Overview",
      "Forms",
      "Agenda",
    ]);
    expect(availableEventNavItems([...baseRoutes, "/e/:eventSlug/review"]).map(({ label }) => label)).toEqual([
      "Overview",
      "Forms",
      "Review",
      "Agenda",
    ]);
  });

  it("exposes every registered organizer workspace in workflow order", () => {
    const routes = [
      "/e/:eventSlug",
      "/e/:eventSlug/forms",
      "/e/:eventSlug/submissions",
      "/e/:eventSlug/review",
      "/e/:eventSlug/dashboard",
      "/e/:eventSlug/speakers",
      "/e/:eventSlug/tasks",
      "/e/:eventSlug/resources",
      "/e/:eventSlug/agenda",
      "/e/:eventSlug/comms",
      "/e/:eventSlug/publication",
      "/e/:eventSlug/exports",
      "/e/:eventSlug/integrations",
      "/e/:eventSlug/settings",
    ];

    expect(availableEventNavItems(routes).map(({ label }) => label)).toEqual([
      "Overview",
      "Forms",
      "Submissions",
      "Review",
      "Onboarding",
      "Speakers",
      "Tasks",
      "Resources",
      "Agenda",
      "Communications",
      "Publication",
      "Exports",
      "Integrations",
      "Settings",
    ]);
  });
});
