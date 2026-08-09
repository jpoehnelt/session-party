import { describe, expect, it } from "vitest";
import type { InstitutionalArchive } from "../schema";
import { archiveFiles, path } from "./exports";

const archive = {
  format: "session-party.archive.v1",
  exportedAt: 1_786_291_200_000,
  event: {
    id: "event-1",
    slug: "durable-summit",
    name: "Durable Summit",
    description: null,
    location: null,
    timezone: "UTC",
    startsAt: null,
    endsAt: null,
    version: 1,
    createdAt: 1_786_291_200_000,
    updatedAt: 1_786_291_200_000,
  },
  speakers: [],
  submissions: [],
  sessions: [],
  reviews: [],
  reviewComments: [],
  decisions: [],
  tasks: [],
  taskCompletions: [],
  speakerContacts: [],
} satisfies InstitutionalArchive;

describe("institutional export route", () => {
  it("exposes a first-class organizer route and stable focused filenames", () => {
    expect(path).toBe("/e/:eventSlug/exports");
    expect(Object.keys(archiveFiles(archive))).toEqual([
      "durable-summit-archive.json",
      "durable-summit-speakers.json",
      "durable-summit-sessions.json",
      "durable-summit-submissions.json",
      "durable-summit-decisions.json",
      "durable-summit-onboarding.json",
    ]);
  });
});
