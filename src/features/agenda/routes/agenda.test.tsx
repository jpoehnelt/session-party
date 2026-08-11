import { afterEach, describe, expect, it, vi } from "vitest";
import { acceptedProposalFixtures, FIXED_DAY_START, scheduledAgendaFixture } from "../fixtures";
import type { AgendaMutationResult } from "../schema";
import { createAcceptedAgendaTalk, path } from "./agenda";

afterEach(() => vi.unstubAllGlobals());

describe("agenda organizer route", () => {
  it("exports the agenda navigation route", () => {
    expect(path).toBe("/e/:eventSlug/agenda");
  });

  it("creates an accepted session and immediately auto-schedules the resulting talk", async () => {
    const proposal = acceptedProposalFixtures[2];
    const existing = scheduledAgendaFixture.snapshot.talks[0]!;
    const draft: AgendaMutationResult = {
      talk: {
        ...existing,
        id: "talk-auto-schedule",
        submissionId: proposal.submissionId,
        title: proposal.title,
        trackId: null,
        roomId: null,
        startsAt: null,
        status: "draft",
        version: 1,
        speakerIds: [proposal.primarySpeakerId],
        speakerNames: [proposal.primarySpeakerName],
      },
      conflicts: [],
      changeId: "change-create-auto-schedule",
      auditId: "audit-create-auto-schedule",
      replayed: false,
    };
    const placed: AgendaMutationResult = {
      ...draft,
      talk: {
        ...draft.talk,
        roomId: scheduledAgendaFixture.snapshot.rooms[0]!.id,
        startsAt: FIXED_DAY_START,
        status: "confirmed",
        version: 2,
      },
      changeId: "change-place-auto-schedule",
      auditId: "audit-place-auto-schedule",
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/agenda/talks")) return new Response(JSON.stringify(draft), { status: 200 });
      if (url.endsWith(`/agenda/talks/${draft.talk.id}/auto-placement`)) {
        return new Response(JSON.stringify(placed), { status: 200 });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(createAcceptedAgendaTalk(
      scheduledAgendaFixture.snapshot.eventId,
      proposal,
      true,
    )).resolves.toEqual(placed);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [createPath, createRequest] = fetchMock.mock.calls[0]!;
    expect(String(createPath)).toBe(
      `/api/v1/events/${scheduledAgendaFixture.snapshot.eventId}/agenda/talks`,
    );
    expect(createRequest).toMatchObject({ method: "POST", credentials: "include" });
    expect(JSON.parse(String(createRequest?.body))).toMatchObject({
      submissionId: proposal.submissionId,
      roomId: null,
      startsAt: null,
      durationMin: 30,
    });
    expect(JSON.parse(String(createRequest?.body)).idempotencyKey).toMatch(/^create-talk-/);

    const [placementPath, placementRequest] = fetchMock.mock.calls[1]!;
    expect(String(placementPath)).toBe(
      `/api/v1/events/${scheduledAgendaFixture.snapshot.eventId}/agenda/talks/${draft.talk.id}/auto-placement`,
    );
    expect(placementRequest).toMatchObject({ method: "POST", credentials: "include" });
    expect(JSON.parse(String(placementRequest?.body))).toMatchObject({ expectedVersion: draft.talk.version });
    expect(JSON.parse(String(placementRequest?.body)).idempotencyKey).toMatch(/^auto-place-talk-/);
  });
});
