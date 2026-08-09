import { EntityId, UnixTimestampMs } from "contracts/domain";
import { Schema } from "effect";

export const AgendaView = Schema.Literal("list", "day", "week", "track", "room");
export type AgendaView = typeof AgendaView.Type;

export const TalkStatus = Schema.Literal("draft", "confirmed", "cancelled");
export type TalkStatus = typeof TalkStatus.Type;

export const Track = Schema.Struct({
  id: EntityId,
  name: Schema.String,
  color: Schema.Union(Schema.String, Schema.Null),
  order: Schema.Int,
});
export type Track = typeof Track.Type;

export const Room = Schema.Struct({
  id: EntityId,
  name: Schema.String,
  capacity: Schema.Union(Schema.Int.pipe(Schema.positive()), Schema.Null),
  order: Schema.Int,
});
export type Room = typeof Room.Type;

export const AgendaTalk = Schema.Struct({
  id: EntityId,
  eventId: EntityId,
  submissionId: Schema.Union(EntityId, Schema.Null),
  title: Schema.String,
  description: Schema.Union(Schema.String, Schema.Null),
  trackId: Schema.Union(EntityId, Schema.Null),
  roomId: Schema.Union(EntityId, Schema.Null),
  startsAt: Schema.Union(UnixTimestampMs, Schema.Null),
  durationMin: Schema.Int.pipe(Schema.positive()),
  status: TalkStatus,
  version: Schema.Int.pipe(Schema.positive()),
  speakerIds: Schema.Array(EntityId),
  speakerNames: Schema.Array(Schema.String),
});
export type AgendaTalk = typeof AgendaTalk.Type;

export const BacklogProposal = Schema.Struct({
  submissionId: EntityId,
  title: Schema.String,
  category: Schema.Union(Schema.String, Schema.Null),
  submissionVersion: Schema.Int.pipe(Schema.positive()),
  acceptanceEventId: EntityId,
  primarySpeakerId: EntityId,
  primarySpeakerName: Schema.String,
  provisionedAt: UnixTimestampMs,
});
export type BacklogProposal = typeof BacklogProposal.Type;

export const AgendaConflict = Schema.Struct({
  kind: Schema.Literal("room_overlap", "speaker_overlap"),
  talkIds: Schema.Tuple(EntityId, EntityId),
  roomId: Schema.optional(EntityId),
  roomName: Schema.optional(Schema.String),
  speakerId: Schema.optional(EntityId),
  speakerName: Schema.optional(Schema.String),
  explanation: Schema.String,
});
export type AgendaConflict = typeof AgendaConflict.Type;

export const PublicationSummary = Schema.Struct({
  revision: Schema.Int.pipe(Schema.nonNegative()),
  publishedAt: Schema.Union(UnixTimestampMs, Schema.Null),
  talkCount: Schema.Int.pipe(Schema.nonNegative()),
});
export type PublicationSummary = typeof PublicationSummary.Type;

export const AgendaSnapshot = Schema.Struct({
  eventId: EntityId,
  eventName: Schema.String,
  eventSlug: Schema.String,
  timezone: Schema.String,
  view: AgendaView,
  workspaceVersion: Schema.Int.pipe(Schema.nonNegative()),
  tracks: Schema.Array(Track),
  rooms: Schema.Array(Room),
  backlog: Schema.Array(BacklogProposal),
  talks: Schema.Array(AgendaTalk),
  conflicts: Schema.Array(AgendaConflict),
  publication: PublicationSummary,
});
export type AgendaSnapshot = typeof AgendaSnapshot.Type;

export const ListAgendaInput = Schema.Struct({
  eventId: EntityId,
  view: Schema.optionalWith(AgendaView, { default: () => "day" as const }),
});
export type ListAgendaInput = typeof ListAgendaInput.Type;

const IdempotencyKey = Schema.String.pipe(Schema.minLength(8), Schema.maxLength(200));
const ExpectedVersion = Schema.Int.pipe(Schema.positive());
const DurationMinutes = Schema.Int.pipe(Schema.between(5, 480));
const NullableEntityId = Schema.Union(EntityId, Schema.Null);
const NullableTimestamp = Schema.Union(UnixTimestampMs, Schema.Null);

export const CreateTalkInput = Schema.Struct({
  eventId: EntityId,
  submissionId: EntityId,
  trackId: Schema.optionalWith(NullableEntityId, { default: () => null }),
  roomId: Schema.optionalWith(NullableEntityId, { default: () => null }),
  startsAt: Schema.optionalWith(NullableTimestamp, { default: () => null }),
  durationMin: Schema.optionalWith(DurationMinutes, { default: () => 30 }),
  idempotencyKey: IdempotencyKey,
});
export type CreateTalkInput = typeof CreateTalkInput.Type;

export const ScheduleTalkInput = Schema.Struct({
  eventId: EntityId,
  talkId: EntityId,
  trackId: NullableEntityId,
  roomId: EntityId,
  startsAt: UnixTimestampMs,
  durationMin: DurationMinutes,
  expectedVersion: ExpectedVersion,
  idempotencyKey: IdempotencyKey,
});
export type ScheduleTalkInput = typeof ScheduleTalkInput.Type;

export const MoveTalkInput = Schema.Struct({
  eventId: EntityId,
  talkId: EntityId,
  trackId: NullableEntityId,
  roomId: EntityId,
  startsAt: UnixTimestampMs,
  durationMin: DurationMinutes,
  expectedVersion: ExpectedVersion,
  idempotencyKey: IdempotencyKey,
});
export type MoveTalkInput = typeof MoveTalkInput.Type;

export const CancelTalkInput = Schema.Struct({
  eventId: EntityId,
  talkId: EntityId,
  expectedVersion: ExpectedVersion,
  idempotencyKey: IdempotencyKey,
});
export type CancelTalkInput = typeof CancelTalkInput.Type;

export const AgendaMutationResult = Schema.Struct({
  talk: AgendaTalk,
  conflicts: Schema.Array(AgendaConflict),
  changeId: EntityId,
  auditId: EntityId,
  replayed: Schema.Boolean,
});
export type AgendaMutationResult = typeof AgendaMutationResult.Type;

export const PublicAgendaTalk = Schema.Struct({
  id: EntityId,
  title: Schema.String,
  description: Schema.Union(Schema.String, Schema.Null),
  track: Schema.Union(Schema.String, Schema.Null),
  room: Schema.Union(Schema.String, Schema.Null),
  startsAt: UnixTimestampMs,
  durationMin: Schema.Int.pipe(Schema.positive()),
  speakerNames: Schema.Array(Schema.String),
});
export type PublicAgendaTalk = typeof PublicAgendaTalk.Type;

export const PublishedAgenda = Schema.Struct({
  eventId: EntityId,
  eventName: Schema.String,
  eventSlug: Schema.String,
  timezone: Schema.String,
  location: Schema.Union(Schema.String, Schema.Null),
  revision: Schema.Int.pipe(Schema.positive()),
  publishedAt: UnixTimestampMs,
  talks: Schema.Array(PublicAgendaTalk),
});
export type PublishedAgenda = typeof PublishedAgenda.Type;

export const PublishAgendaInput = Schema.Struct({
  eventId: EntityId,
  expectedRevision: Schema.Int.pipe(Schema.nonNegative()),
  expectedWorkspaceVersion: Schema.Int.pipe(Schema.nonNegative()),
  idempotencyKey: IdempotencyKey,
});
export type PublishAgendaInput = typeof PublishAgendaInput.Type;

export const GetPublishedAgendaInput = Schema.Struct({ eventId: EntityId });
export type GetPublishedAgendaInput = typeof GetPublishedAgendaInput.Type;

export const RealtimeConnectionState = Schema.Literal("connected", "reconnecting", "offline");
export type RealtimeConnectionState = typeof RealtimeConnectionState.Type;

export const RealtimeAcknowledgement = Schema.Literal(
  "idle",
  "pending",
  "acknowledged",
  "stale",
  "rejected",
);
export type RealtimeAcknowledgement = typeof RealtimeAcknowledgement.Type;

export const RealtimeIntentState = Schema.Struct({
  clientIntentId: Schema.Union(EntityId, Schema.Null),
  connection: RealtimeConnectionState,
  acknowledgement: RealtimeAcknowledgement,
  sentAt: Schema.Union(UnixTimestampMs, Schema.Null),
  message: Schema.Union(Schema.String, Schema.Null),
});
export type RealtimeIntentState = typeof RealtimeIntentState.Type;
