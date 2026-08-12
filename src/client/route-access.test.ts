import { describe, expect, it } from "vitest";
import { canAccessClientRoute, clientRouteAccess } from "./route-access";

const auth = (installRole?: "staff") => ({ user: { email: "person@example.com", installRole } });
const eventAccess = (memberRole: "owner" | "admin" | "reviewer" | null, staff = false) => [{
  event: { slug: "summit" },
  memberRole,
  staff,
}] as const;

describe("client route access", () => {
  it("classifies organizer, reviewer, staff, speaker, and public routes", () => {
    expect(clientRouteAccess("/e/:eventSlug/settings")).toBe("event-organizer");
    expect(clientRouteAccess("/e/:eventSlug/speakers/:speakerId")).toBe("event-organizer");
    expect(clientRouteAccess("/e/:eventSlug/review")).toBe("event-review");
    expect(clientRouteAccess("/staff")).toBe("install-staff");
    expect(clientRouteAccess("/speaker-directory")).toBe("install-staff");
    expect(clientRouteAccess("/e/:eventSlug/portal/*")).toBe("public");
    expect(clientRouteAccess("/event/:eventSlug/*")).toBe("public");
  });

  it("allows organizer pages only to event organizers or installation staff", () => {
    expect(canAccessClientRoute("event-organizer", "summit", auth(), eventAccess("owner"))).toBe(true);
    expect(canAccessClientRoute("event-organizer", "summit", auth(), eventAccess("admin"))).toBe(true);
    expect(canAccessClientRoute("event-organizer", "summit", auth(), eventAccess("reviewer"))).toBe(false);
    expect(canAccessClientRoute("event-organizer", "summit", auth("staff"), eventAccess(null, true))).toBe(true);
    expect(canAccessClientRoute("event-organizer", "other", auth(), eventAccess("owner"))).toBe(false);
  });

  it("keeps review available to reviewers and install pages exclusive to staff", () => {
    expect(canAccessClientRoute("event-review", "summit", auth(), eventAccess("reviewer"))).toBe(true);
    expect(canAccessClientRoute("install-staff", undefined, auth("staff"), [])).toBe(true);
    expect(canAccessClientRoute("install-staff", undefined, auth(), [])).toBe(false);
  });
});
