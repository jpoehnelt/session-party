import { afterEach, describe, expect, it, vi } from "vitest";
import { acceptReviewerInvitationToken, path } from "./reviewer-invitation";

afterEach(() => vi.unstubAllGlobals());

describe("reviewer invitation acceptance route", () => {
  it("publishes the token acceptance route", () => {
    expect(path).toBe("/reviewer-invitations/accept");
  });

  it("accepts through the authenticated operation without putting the token in the URL", async () => {
    const payload = {
      invitationId: "reviewer_invitation_1",
      eventId: "event_1",
      eventSlug: "event-one",
      eventName: "Event One",
      member: {
        id: "member_1",
        userId: "user_1",
        email: "reviewer@example.com",
        name: "Review Person",
        role: "reviewer",
        version: 1,
        createdAt: "2026-08-10T12:00:00.000Z",
        updatedAt: "2026-08-10T12:00:00.000Z",
      },
      idempotent: false,
    };
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(acceptReviewerInvitationToken("reviewer_inv_secret", "accept-key-1")).resolves.toMatchObject({
      eventId: "event_1",
      member: { role: "reviewer", createdAt: new Date("2026-08-10T12:00:00.000Z") },
    });
    expect(fetchMock).toHaveBeenCalledWith("/api/v1/reviewer-invitations/accept", expect.objectContaining({
      method: "POST",
      credentials: "include",
      headers: expect.objectContaining({
        "idempotency-key": "accept-key-1",
        "Content-Type": "application/json",
      }),
      body: JSON.stringify({ token: "reviewer_inv_secret" }),
    }));
  });
});
