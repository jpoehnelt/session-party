import { describe, expect, it } from "vitest";
import { discoveredClientRouteModules, discoveredClientRoutePaths } from "./route-discovery";

describe("client route discovery", () => {
  it("excludes support modules from the client router", () => {
    expect(discoveredClientRoutePaths).not.toEqual([]);
    expect(discoveredClientRoutePaths.every((path) =>
      !path.includes(".test.") &&
      !path.includes(".browser.") &&
      !path.includes(".stories.")
    )).toBe(true);
    expect(discoveredClientRouteModules.every((route) =>
      typeof route.load === "function" && !("default" in route)
    )).toBe(true);
  });

  it("assigns an intentional content width to every organizer page", () => {
    const organizerWidths = Object.fromEntries(
      discoveredClientRouteModules
        .filter(({ path, layout }) => layout !== "bare" && (path === "/events" || path.startsWith("/e/:eventSlug")))
        .map(({ path, contentWidth }) => [path, contentWidth]),
    );

    expect(organizerWidths).toEqual({
      "/events": "standard",
      "/e/:eventSlug": "compact",
      "/e/:eventSlug/forms": "canvas",
      "/e/:eventSlug/submissions": "wide",
      "/e/:eventSlug/review": "canvas",
      "/e/:eventSlug/dashboard": "canvas",
      "/e/:eventSlug/speakers": "wide",
      "/e/:eventSlug/tasks": "standard",
      "/e/:eventSlug/resources": "standard",
      "/e/:eventSlug/agenda": "canvas",
      "/e/:eventSlug/comms": "canvas",
      "/e/:eventSlug/content": "wide",
      "/e/:eventSlug/publication": "wide",
      "/e/:eventSlug/exports": "compact",
      "/e/:eventSlug/integrations": "wide",
      "/e/:eventSlug/appearance": "compact",
      "/e/:eventSlug/settings": "compact",
    });
  });
});
