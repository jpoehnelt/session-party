import { EntityId, UnixTimestampMs } from "contracts/domain";
import { Schema } from "effect";

const NullableText = Schema.Union(Schema.String, Schema.Null);
const NullableId = Schema.Union(EntityId, Schema.Null);
const NullableTimestamp = Schema.Union(UnixTimestampMs, Schema.Null);

export const GetInstitutionalArchiveInput = Schema.Struct({ eventId: EntityId });
export type GetInstitutionalArchiveInput = typeof GetInstitutionalArchiveInput.Type;

export const ArchiveEvent = Schema.Struct({
  id: EntityId,
  slug: Schema.String,
  name: Schema.String,
  description: NullableText,
  location: NullableText,
  timezone: Schema.String,
  startsAt: NullableTimestamp,
  endsAt: NullableTimestamp,
  version: Schema.Int.pipe(Schema.positive()),
  createdAt: UnixTimestampMs,
  updatedAt: UnixTimestampMs,
});

export const ArchiveSpeaker = Schema.Struct({
  id: EntityId,
  eventId: EntityId,
  userId: NullableId,
  contactEmail: NullableText,
  displayName: Schema.String,
  title: NullableText,
  organization: NullableText,
  bio: NullableText,
  visible: Schema.Boolean,
  version: Schema.Int.pipe(Schema.positive()),
  createdAt: UnixTimestampMs,
  updatedAt: UnixTimestampMs,
});

export const ArchiveSubmissionSpeaker = Schema.Struct({
  id: EntityId,
  speakerId: EntityId,
  isPrimary: Schema.Boolean,
  titleAtTime: NullableText,
  organizationAtTime: NullableText,
  linkedAt: UnixTimestampMs,
});

export const ArchiveAnswer = Schema.Struct({
  id: EntityId,
  fieldId: EntityId,
  value: Schema.Unknown,
  version: Schema.Int.pipe(Schema.positive()),
  createdAt: UnixTimestampMs,
  updatedAt: UnixTimestampMs,
});

export const ArchiveSubmission = Schema.Struct({
  id: EntityId,
  eventId: EntityId,
  formId: EntityId,
  formVersionId: EntityId,
  title: Schema.String,
  category: NullableText,
  status: Schema.String,
  submittedAt: UnixTimestampMs,
  acceptedAt: NullableTimestamp,
  version: Schema.Int.pipe(Schema.positive()),
  createdAt: UnixTimestampMs,
  updatedAt: UnixTimestampMs,
  speakers: Schema.Array(ArchiveSubmissionSpeaker),
  answers: Schema.Array(ArchiveAnswer),
});

export const ArchiveSession = Schema.Struct({
  id: EntityId,
  eventId: EntityId,
  submissionId: NullableId,
  title: Schema.String,
  description: NullableText,
  trackId: NullableId,
  roomId: NullableId,
  startsAt: NullableTimestamp,
  durationMin: Schema.Int.pipe(Schema.positive()),
  status: Schema.String,
  version: Schema.Int.pipe(Schema.positive()),
  speakerIds: Schema.Array(EntityId),
  createdAt: UnixTimestampMs,
  updatedAt: UnixTimestampMs,
});

export const ArchiveReview = Schema.Struct({
  id: EntityId,
  eventId: EntityId,
  roundId: EntityId,
  submissionId: EntityId,
  reviewerUserId: NullableId,
  ai: Schema.Boolean,
  score: Schema.Number,
  scores: Schema.Union(Schema.Record({ key: Schema.String, value: Schema.Number }), Schema.Null),
  comment: NullableText,
  version: Schema.Int.pipe(Schema.positive()),
  createdAt: UnixTimestampMs,
  updatedAt: UnixTimestampMs,
});

export const ArchiveReviewComment = Schema.Struct({
  id: EntityId,
  eventId: EntityId,
  submissionId: EntityId,
  authorUserId: EntityId,
  body: Schema.String,
  createdAt: UnixTimestampMs,
});

export const ArchiveDecision = Schema.Struct({
  id: EntityId,
  eventId: EntityId,
  submissionId: EntityId,
  primarySpeakerId: EntityId,
  type: Schema.String,
  submissionVersion: Schema.Int.pipe(Schema.positive()),
  actorUserId: NullableId,
  occurredAt: UnixTimestampMs,
});

export const ArchiveTask = Schema.Struct({
  id: EntityId,
  eventId: EntityId,
  name: Schema.String,
  description: NullableText,
  kind: Schema.String,
  formId: NullableId,
  dueAt: NullableTimestamp,
  order: Schema.Int,
  version: Schema.Int.pipe(Schema.positive()),
  createdAt: UnixTimestampMs,
  updatedAt: UnixTimestampMs,
});

export const ArchiveTaskCompletion = Schema.Struct({
  id: EntityId,
  eventId: EntityId,
  taskId: EntityId,
  speakerId: EntityId,
  completedAt: UnixTimestampMs,
  data: Schema.Unknown,
  version: Schema.Int.pipe(Schema.positive()),
  createdAt: UnixTimestampMs,
  updatedAt: UnixTimestampMs,
});

export const ArchiveSpeakerContact = Schema.Struct({
  id: EntityId,
  eventId: EntityId,
  speakerId: EntityId,
  actorUserId: EntityId,
  medium: Schema.String,
  note: NullableText,
  contactedAt: UnixTimestampMs,
  createdAt: UnixTimestampMs,
});

export const InstitutionalArchive = Schema.Struct({
  format: Schema.Literal("session-party.archive.v1"),
  exportedAt: UnixTimestampMs,
  event: ArchiveEvent,
  speakers: Schema.Array(ArchiveSpeaker),
  submissions: Schema.Array(ArchiveSubmission),
  sessions: Schema.Array(ArchiveSession),
  reviews: Schema.Array(ArchiveReview),
  reviewComments: Schema.Array(ArchiveReviewComment),
  decisions: Schema.Array(ArchiveDecision),
  tasks: Schema.Array(ArchiveTask),
  taskCompletions: Schema.Array(ArchiveTaskCompletion),
  speakerContacts: Schema.Array(ArchiveSpeakerContact),
});
export type InstitutionalArchive = typeof InstitutionalArchive.Type;
