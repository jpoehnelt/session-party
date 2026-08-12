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
      scheduledAgendaFixture.snapshot.tracks,
    )).resolves.toEqual(placed);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [createPath, createRequest] = fetchMock.mock.calls[0]!;
    expect(String(createPath)).toBe(
      `/api/v1/events/${scheduledAgendaFixture.snapshot.eventId}/agenda/talks`,
    );
    expect(createRequest).toMatchObject({ method: "POST", credentials: "include" });
    expect(JSON.parse(String(createRequest?.body))).toMatchObject({
      submissionId: proposal.submissionId,
      trackId: scheduledAgendaFixture.snapshot.tracks[0]!.id,
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

  it("hands an accepted proposal to its corresponding track instead of the first track", async () => {
    const proposal = {
      ...acceptedProposalFixtures[0],
      title: "Taming agents in production",
      category: " Platform & Infra ",
    };
    const tracks = [
      { id: "track-developer-tools", name: "Developer tools", color: null, order: 0, version: 1 },
      { id: "track-platform-infra", name: "platform & infra", color: null, order: 1, version: 1 },
    ];
    const created: AgendaMutationResult = {
      talk: {
        ...scheduledAgendaFixture.snapshot.talks[0]!,
        id: "talk-platform-infra",
        submissionId: proposal.submissionId,
        title: proposal.title,
        trackId: tracks[1]!.id,
        roomId: null,
        startsAt: null,
        status: "draft",
        version: 1,
      },
      conflicts: [],
      changeId: "change-platform-infra",
      auditId: "audit-platform-infra",
      replayed: false,
    };
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify(created), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(createAcceptedAgendaTalk(
      scheduledAgendaFixture.snapshot.eventId,
      proposal,
      false,
      tracks,
    )).resolves.toEqual(created);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, createRequest] = fetchMock.mock.calls[0]!;
    expect(JSON.parse(String(createRequest?.body))).toMatchObject({
      submissionId: proposal.submissionId,
      trackId: "track-platform-infra",
    });
  });
});
