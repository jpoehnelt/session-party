import type { AnyOperationDef, PartyIntentDescriptor } from "contracts/operation";
import { eventAuthorization, publicAuthorization } from "contracts/principal";
import type { JsonObject } from "contracts/domain";
import {
  cancelTalk,
  createRoom,
  createTalk,
  createTrack,
  getPublishedAgenda,
  listAgenda,
  moveTalk,
  publishAgenda,
  scheduleTalk,
  updateRoom,
  updateTrack,
} from "./service";
import {
  AgendaMutationResult,
  AgendaSnapshot,
  CancelTalkInput,
  CreateRoomInput,
  CreateTalkInput,
  CreateTrackInput,
  GetPublishedAgendaInput,
  ListAgendaInput,
  MoveTalkInput,
  PublishedAgenda,
  PublishAgendaInput,
  RoomMutationResult,
  ScheduleTalkInput,
  TrackMutationResult,
  UpdateRoomInput,
  UpdateTrackInput,
} from "./schema";

const readAuthorization = eventAuthorization(
  { kind: "event-member", roles: ["owner", "admin", "reviewer"] },
  { kind: "api-key", scopes: ["agenda:read"] },
);

const writeAuthorization = eventAuthorization(
  { kind: "event-member", roles: ["owner", "admin"] },
  { kind: "api-key", scopes: ["agenda:write"] },
);

export const createRoomOperation = {
  id: "agenda.createRoom",
  kind: "command",
  input: CreateRoomInput,
  output: RoomMutationResult,
  authorize: writeAuthorization,
  invoke: createRoom,
  rest: {
    method: "post",
    path: "/events/:eventId/agenda/rooms",
    input: { path: ["eventId"], body: ["name", "capacity", "order", "idempotencyKey"] },
    summary: "Create an agenda room",
    successStatus: 201,
  },
  idempotency: "required",
  concurrency: "none",
  emits: ["agenda.talk_changed"],
} as const satisfies AnyOperationDef;

export const cancelTalkOperation = {
  id: "agenda.cancelTalk",
  kind: "command",
  input: CancelTalkInput,
  output: AgendaMutationResult,
  authorize: writeAuthorization,
  invoke: cancelTalk,
  rest: {
    method: "delete",
    path: "/events/:eventId/agenda/talks/:talkId",
    input: { path: ["eventId", "talkId"], body: ["expectedVersion", "idempotencyKey"] },
    summary: "Cancel an agenda talk",
    successStatus: 200,
  },
  mcp: {
    name: "agenda_cancel_talk",
    description: "Cancel a versioned agenda talk without deleting its audit history.",
  },
  idempotency: "required",
  concurrency: "required",
  emits: ["agenda.talk_changed"],
} as const satisfies AnyOperationDef;

export const createTalkOperation = {
  id: "agenda.createTalk",
  kind: "command",
  input: CreateTalkInput,
  output: AgendaMutationResult,
  authorize: writeAuthorization,
  invoke: createTalk,
  rest: {
    method: "post",
    path: "/events/:eventId/agenda/talks",
    input: {
      path: ["eventId"],
      body: ["submissionId", "trackId", "roomId", "startsAt", "durationMin", "idempotencyKey"],
    },
    summary: "Create a talk from an accepted proposal",
    successStatus: 201,
  },
  mcp: {
    name: "agenda_create_talk",
    description: "Create a draft or scheduled talk from an accepted, provisioned proposal.",
  },
  idempotency: "required",
  concurrency: "none",
  emits: ["agenda.talk_changed"],
} as const satisfies AnyOperationDef;

export const createTrackOperation = {
  id: "agenda.createTrack",
  kind: "command",
  input: CreateTrackInput,
  output: TrackMutationResult,
  authorize: writeAuthorization,
  invoke: createTrack,
  rest: {
    method: "post",
    path: "/events/:eventId/agenda/tracks",
    input: { path: ["eventId"], body: ["name", "color", "order", "idempotencyKey"] },
    summary: "Create an agenda track",
    successStatus: 201,
  },
  idempotency: "required",
  concurrency: "none",
  emits: ["agenda.talk_changed"],
} as const satisfies AnyOperationDef;

export const getPublishedAgendaOperation = {
  id: "agenda.getPublished",
  kind: "query",
  input: GetPublishedAgendaInput,
  output: PublishedAgenda,
  authorize: publicAuthorization,
  invoke: getPublishedAgenda,
  rest: {
    method: "get",
    path: "/public/events/:eventSlug/agenda/published",
    input: { path: ["eventSlug"] },
    summary: "Get the published agenda projection by event slug",
    successStatus: 200,
  },
  idempotency: "none",
  concurrency: "none",
  emits: [],
} as const satisfies AnyOperationDef;

export const listAgendaOperation = {
  id: "agenda.list",
  kind: "query",
  input: ListAgendaInput,
  output: AgendaSnapshot,
  authorize: readAuthorization,
  invoke: listAgenda,
  rest: {
    method: "get",
    path: "/events/:eventId/agenda",
    input: { path: ["eventId"], query: ["view"] },
    summary: "List the private agenda workspace",
    successStatus: 200,
  },
  mcp: {
    name: "agenda_list",
    description: "List accepted backlog proposals, private talks, conflicts, rooms, tracks, and publication state.",
  },
  idempotency: "none",
  concurrency: "none",
  emits: [],
} as const satisfies AnyOperationDef;

export const moveTalkOperation = {
  id: "agenda.moveTalk",
  kind: "command",
  input: MoveTalkInput,
  output: AgendaMutationResult,
  authorize: writeAuthorization,
  invoke: moveTalk,
  rest: {
    method: "patch",
    path: "/events/:eventId/agenda/talks/:talkId/position",
    input: {
      path: ["eventId", "talkId"],
      body: ["trackId", "roomId", "startsAt", "durationMin", "expectedVersion", "idempotencyKey"],
    },
    summary: "Move or resize an agenda talk",
    successStatus: 200,
  },
  mcp: {
    name: "agenda_move_talk",
    description: "Move a versioned talk across track, room, start time, and duration.",
  },
  idempotency: "required",
  concurrency: "required",
  emits: ["agenda.talk_changed"],
} as const satisfies AnyOperationDef;

export const publishAgendaOperation = {
  id: "agenda.publish",
  kind: "command",
  input: PublishAgendaInput,
  output: PublishedAgenda,
  authorize: writeAuthorization,
  invoke: publishAgenda,
  rest: {
    method: "post",
    path: "/events/:eventId/agenda/publications",
    input: {
      path: ["eventId"],
      body: ["expectedRevision", "expectedWorkspaceVersion", "expectedEventVersion", "idempotencyKey"],
    },
    summary: "Publish an agenda revision",
    successStatus: 201,
  },
  mcp: {
    name: "agenda_publish",
    description: "Publish an immutable public projection of the current confirmed agenda.",
  },
  idempotency: "required",
  concurrency: "required",
  emits: ["agenda/published"],
} as const satisfies AnyOperationDef;

export const scheduleTalkOperation = {
  id: "agenda.scheduleTalk",
  kind: "command",
  input: ScheduleTalkInput,
  output: AgendaMutationResult,
  authorize: writeAuthorization,
  invoke: scheduleTalk,
  rest: {
    method: "put",
    path: "/events/:eventId/agenda/talks/:talkId/schedule",
    input: {
      path: ["eventId", "talkId"],
      body: ["trackId", "roomId", "startsAt", "durationMin", "expectedVersion", "idempotencyKey"],
    },
    summary: "Schedule a draft talk",
    successStatus: 200,
  },
  mcp: {
    name: "agenda_schedule_talk",
    description: "Confirm a draft talk at a conflict-free track, room, start time, and duration.",
  },
  idempotency: "required",
  concurrency: "required",
  emits: ["agenda.talk_changed"],
} as const satisfies AnyOperationDef;

export const updateRoomOperation = {
  id: "agenda.updateRoom",
  kind: "command",
  input: UpdateRoomInput,
  output: RoomMutationResult,
  authorize: writeAuthorization,
  invoke: updateRoom,
  rest: {
    method: "patch",
    path: "/events/:eventId/agenda/rooms/:roomId",
    input: {
      path: ["eventId", "roomId"],
      body: ["name", "capacity", "order", "expectedVersion", "idempotencyKey"],
    },
    summary: "Update an agenda room",
    successStatus: 200,
  },
  idempotency: "required",
  concurrency: "required",
  emits: ["agenda.talk_changed"],
} as const satisfies AnyOperationDef;

export const updateTrackOperation = {
  id: "agenda.updateTrack",
  kind: "command",
  input: UpdateTrackInput,
  output: TrackMutationResult,
  authorize: writeAuthorization,
  invoke: updateTrack,
  rest: {
    method: "patch",
    path: "/events/:eventId/agenda/tracks/:trackId",
    input: {
      path: ["eventId", "trackId"],
      body: ["name", "color", "order", "expectedVersion", "idempotencyKey"],
    },
    summary: "Update an agenda track",
    successStatus: 200,
  },
  idempotency: "required",
  concurrency: "required",
  emits: ["agenda.talk_changed"],
} as const satisfies AnyOperationDef;

/** Bytewise order is deliberate and matches the registry generator comparator. */
export const operations = [
  cancelTalkOperation,
  createRoomOperation,
  createTalkOperation,
  createTrackOperation,
  getPublishedAgendaOperation,
  listAgendaOperation,
  moveTalkOperation,
  publishAgendaOperation,
  scheduleTalkOperation,
  updateRoomOperation,
  updateTrackOperation,
] as const satisfies readonly AnyOperationDef[];

const moveInputSchema = {
  additionalProperties: false,
  properties: {
    durationMin: { maximum: 480, minimum: 5, type: "integer" },
    expectedVersion: { minimum: 1, type: "integer" },
    idempotencyKey: { maxLength: 200, minLength: 8, type: "string" },
    requestId: { minLength: 1, type: "string" },
    roomId: { minLength: 1, type: "string" },
    startsAt: { minimum: 0, type: "integer" },
    talkId: { minLength: 1, type: "string" },
    trackId: { anyOf: [{ minLength: 1, type: "string" }, { type: "null" }] },
  },
  required: [
    "durationMin",
    "expectedVersion",
    "idempotencyKey",
    "requestId",
    "roomId",
    "startsAt",
    "talkId",
    "trackId",
  ],
  type: "object",
} as const satisfies JsonObject;

const mutationOutputSchema = {
  additionalProperties: false,
  properties: {
    auditId: { type: "string" },
    changeId: { type: "string" },
    conflicts: { items: { type: "object" }, type: "array" },
    replayed: { type: "boolean" },
    talk: { type: "object" },
  },
  required: ["auditId", "changeId", "conflicts", "replayed", "talk"],
  type: "object",
} as const satisfies JsonObject;

/** Inactive projection of the accepted future Party move contract; no operation registers it yet. */
export const partyDescriptors = [
  {
    inputSchema: moveInputSchema,
    intentType: "agenda/move",
    operationId: "agenda.moveTalk",
    outputSchema: mutationOutputSchema,
  },
] as const satisfies readonly PartyIntentDescriptor[];
