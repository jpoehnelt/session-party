import type {
  AgendaConflict,
  AgendaSnapshot,
  AgendaTalk,
  MoveTalkInput,
  PublishedAgenda,
} from "./schema";

export const FIXED_NOW = Date.UTC(2026, 7, 10, 16, 0, 0);
export const FIXED_DAY_START = Date.UTC(2026, 7, 12, 16, 0, 0);

export const deterministicAgendaIds = {
  event: "event-effect-days",
  form: "form-cfp",
  formVersion: "form-cfp-v1",
  submissionA: "submission-effects-at-scale",
  submissionB: "submission-durable-workflows",
  submissionC: "submission-schema-boundaries",
  acceptanceA: "acceptance-effects-at-scale",
  acceptanceB: "acceptance-durable-workflows",
  acceptanceC: "acceptance-schema-boundaries",
  provisioningA: "provisioning-effects-at-scale",
  provisioningB: "provisioning-durable-workflows",
  provisioningC: "provisioning-schema-boundaries",
  speakerAda: "speaker-ada",
  speakerLin: "speaker-lin",
  speakerMara: "speaker-mara",
  trackSystems: "track-systems",
  trackPractice: "track-practice",
  roomHarbor: "room-harbor",
  roomSummit: "room-summit",
  talkA: "talk-effects-at-scale",
  talkB: "talk-durable-workflows",
  talkC: "talk-schema-boundaries",
} as const;

export const acceptedProposalFixtures = [
  {
    submissionId: deterministicAgendaIds.submissionA,
    title: "Effects at scale",
    category: "Systems",
    submissionVersion: 3,
    acceptanceEventId: deterministicAgendaIds.acceptanceA,
    primarySpeakerId: deterministicAgendaIds.speakerAda,
    primarySpeakerName: "Ada Rivera",
    provisionedAt: FIXED_NOW - 86_400_000,
  },
  {
    submissionId: deterministicAgendaIds.submissionB,
    title: "Durable workflows without folklore",
    category: "Practice",
    submissionVersion: 2,
    acceptanceEventId: deterministicAgendaIds.acceptanceB,
    primarySpeakerId: deterministicAgendaIds.speakerLin,
    primarySpeakerName: "Lin Okafor",
    provisionedAt: FIXED_NOW - 43_200_000,
  },
  {
    submissionId: deterministicAgendaIds.submissionC,
    title: "Schema boundaries that hold",
    category: "Systems",
    submissionVersion: 4,
    acceptanceEventId: deterministicAgendaIds.acceptanceC,
    primarySpeakerId: deterministicAgendaIds.speakerMara,
    primarySpeakerName: "Mara Chen",
    provisionedAt: FIXED_NOW - 21_600_000,
  },
] as const;

export const deterministicTracks = [
  { id: deterministicAgendaIds.trackSystems, name: "Systems", color: "#2563EB", order: 0 },
  { id: deterministicAgendaIds.trackPractice, name: "Practice", color: "#7C3AED", order: 1 },
] as const;

export const deterministicRooms = [
  { id: deterministicAgendaIds.roomHarbor, name: "Harbor", capacity: 180, order: 0 },
  { id: deterministicAgendaIds.roomSummit, name: "Summit", capacity: 90, order: 1 },
] as const;

const talkA: AgendaTalk = {
  id: deterministicAgendaIds.talkA,
  eventId: deterministicAgendaIds.event,
  submissionId: deterministicAgendaIds.submissionA,
  title: "Effects at scale",
  description: "How a small team keeps failures explicit across a distributed system.",
  trackId: deterministicAgendaIds.trackSystems,
  roomId: deterministicAgendaIds.roomHarbor,
  startsAt: FIXED_DAY_START,
  durationMin: 45,
  status: "confirmed",
  version: 2,
  speakerIds: [deterministicAgendaIds.speakerAda],
  speakerNames: ["Ada Rivera"],
};

const talkB: AgendaTalk = {
  id: deterministicAgendaIds.talkB,
  eventId: deterministicAgendaIds.event,
  submissionId: deterministicAgendaIds.submissionB,
  title: "Durable workflows without folklore",
  description: "Operational patterns for work that must survive retries and restarts.",
  trackId: deterministicAgendaIds.trackPractice,
  roomId: deterministicAgendaIds.roomSummit,
  startsAt: FIXED_DAY_START + 3_600_000,
  durationMin: 45,
  status: "confirmed",
  version: 1,
  speakerIds: [deterministicAgendaIds.speakerLin],
  speakerNames: ["Lin Okafor"],
};

const baseSnapshot = (overrides: Partial<AgendaSnapshot> = {}): AgendaSnapshot => ({
  eventId: deterministicAgendaIds.event,
  eventName: "Effect Days 2026",
  eventSlug: "effect-days-2026",
  timezone: "America/Los_Angeles",
  view: "day",
  workspaceVersion: 0,
  eventVersion: 1,
  tracks: [...deterministicTracks],
  rooms: [...deterministicRooms],
  backlog: [],
  talks: [],
  conflicts: [],
  publication: { revision: 0, publishedAt: null, talkCount: 0 },
  ...overrides,
});

export interface AgendaScenarioFixture {
  readonly name: string;
  readonly snapshot: AgendaSnapshot;
  readonly expectedError?: "Conflict";
  readonly move?: MoveTalkInput;
  readonly published?: PublishedAgenda;
}

export const emptyAgendaFixture: AgendaScenarioFixture = {
  name: "empty",
  snapshot: baseSnapshot({ tracks: [], rooms: [] }),
};

export const backlogAgendaFixture: AgendaScenarioFixture = {
  name: "backlog",
  snapshot: baseSnapshot({ backlog: [...acceptedProposalFixtures] }),
};

export const scheduledAgendaFixture: AgendaScenarioFixture = {
  name: "scheduled",
  snapshot: baseSnapshot({ backlog: [acceptedProposalFixtures[2]], talks: [talkA, talkB] }),
};

const speakerConflict: AgendaConflict = {
  kind: "speaker_overlap",
  talkIds: [deterministicAgendaIds.talkA, deterministicAgendaIds.talkC],
  speakerId: deterministicAgendaIds.speakerAda,
  speakerName: "Ada Rivera",
  explanation: "Ada Rivera is already speaking in Effects at scale during this time.",
};

export const speakerConflictAgendaFixture: AgendaScenarioFixture = {
  name: "speaker-conflict",
  expectedError: "Conflict",
  snapshot: baseSnapshot({
    talks: [
      talkA,
      {
        ...talkA,
        id: deterministicAgendaIds.talkC,
        submissionId: deterministicAgendaIds.submissionC,
        title: "Schema boundaries that hold",
        roomId: deterministicAgendaIds.roomSummit,
        version: 1,
      },
    ],
    conflicts: [speakerConflict],
  }),
};

const roomConflict: AgendaConflict = {
  kind: "room_overlap",
  talkIds: [deterministicAgendaIds.talkA, deterministicAgendaIds.talkC],
  roomId: deterministicAgendaIds.roomHarbor,
  roomName: "Harbor",
  explanation: "Harbor already hosts Effects at scale during this time.",
};

export const roomConflictAgendaFixture: AgendaScenarioFixture = {
  name: "room-conflict",
  expectedError: "Conflict",
  snapshot: baseSnapshot({
    talks: [
      talkA,
      {
        ...talkB,
        id: deterministicAgendaIds.talkC,
        submissionId: deterministicAgendaIds.submissionC,
        title: "Schema boundaries that hold",
        roomId: deterministicAgendaIds.roomHarbor,
        startsAt: FIXED_DAY_START + 1_800_000,
      },
    ],
    conflicts: [roomConflict],
  }),
};

export const staleMoveAgendaFixture: AgendaScenarioFixture = {
  name: "stale-move",
  expectedError: "Conflict",
  snapshot: scheduledAgendaFixture.snapshot,
  move: {
    eventId: deterministicAgendaIds.event,
    talkId: deterministicAgendaIds.talkA,
    trackId: deterministicAgendaIds.trackPractice,
    roomId: deterministicAgendaIds.roomSummit,
    startsAt: FIXED_DAY_START + 7_200_000,
    durationMin: 30,
    expectedVersion: 1,
    idempotencyKey: "fixture-stale-move-0001",
  },
};

export const publishedAgendaFixture: AgendaScenarioFixture = {
  name: "published-revision",
  snapshot: baseSnapshot({
    backlog: [acceptedProposalFixtures[2]],
    talks: [talkA, talkB],
    publication: { revision: 1, publishedAt: FIXED_NOW, talkCount: 2 },
  }),
  published: {
    eventId: deterministicAgendaIds.event,
    eventName: "Effect Days 2026",
    eventSlug: "effect-days-2026",
    timezone: "America/Los_Angeles",
    location: "Pier 27, San Francisco",
    revision: 1,
    publishedAt: FIXED_NOW,
    talks: [
      {
        id: talkA.id,
        title: talkA.title,
        description: talkA.description,
        track: "Systems",
        room: "Harbor",
        startsAt: talkA.startsAt!,
        durationMin: talkA.durationMin,
        speakerNames: talkA.speakerNames,
      },
      {
        id: talkB.id,
        title: talkB.title,
        description: talkB.description,
        track: "Practice",
        room: "Summit",
        startsAt: talkB.startsAt!,
        durationMin: talkB.durationMin,
        speakerNames: talkB.speakerNames,
      },
    ],
  },
};

export const agendaFixtures = [
  emptyAgendaFixture,
  backlogAgendaFixture,
  scheduledAgendaFixture,
  speakerConflictAgendaFixture,
  roomConflictAgendaFixture,
  staleMoveAgendaFixture,
  publishedAgendaFixture,
] as const;
