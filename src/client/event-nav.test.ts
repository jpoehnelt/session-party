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
});
