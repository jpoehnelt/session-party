import { EntityId, UnixTimestampMs } from "contracts/domain";
import { Schema } from "effect";

const IdempotencyKey = Schema.String.pipe(Schema.minLength(8), Schema.maxLength(200));
const ExpectedVersion = Schema.Int.pipe(Schema.positive());
const TemplateName = Schema.String.pipe(Schema.minLength(1), Schema.maxLength(120));
const TemplateSubject = Schema.String.pipe(Schema.minLength(1), Schema.maxLength(240));
const TemplateBody = Schema.String.pipe(Schema.minLength(1), Schema.maxLength(20_000));
const Mailbox = Schema.String.pipe(Schema.minLength(3), Schema.maxLength(320));
const NullableMailbox = Schema.Union(Mailbox, Schema.Null);

export const TemplateVariableKey = Schema.Literal(
  "speakerName",
  "speakerEmail",
  "eventName",
  "eventLocation",
  "eventDates",
  "talkTitle",
  "talkTime",
  "talkRoom",
  "portalUrl",
);
export type TemplateVariableKey = typeof TemplateVariableKey.Type;

export const CommunicationTemplate = Schema.Struct({
  id: EntityId,
  eventId: EntityId,
  name: TemplateName,
  subject: TemplateSubject,
  textBody: TemplateBody,
  htmlBody: TemplateBody,
  attachIcs: Schema.Boolean,
  version: ExpectedVersion,
  createdAt: UnixTimestampMs,
  updatedAt: UnixTimestampMs,
});
export type CommunicationTemplate = typeof CommunicationTemplate.Type;

export const ListTemplatesInput = Schema.Struct({ eventId: EntityId });
export type ListTemplatesInput = typeof ListTemplatesInput.Type;

export const CreateTemplateInput = Schema.Struct({
  eventId: EntityId,
  name: TemplateName,
  subject: TemplateSubject,
  textBody: TemplateBody,
  htmlBody: TemplateBody,
  attachIcs: Schema.Boolean,
  idempotencyKey: IdempotencyKey,
});
export type CreateTemplateInput = typeof CreateTemplateInput.Type;

export const UpdateTemplateInput = Schema.Struct({
  eventId: EntityId,
  templateId: EntityId,
  name: TemplateName,
  subject: TemplateSubject,
  textBody: TemplateBody,
  htmlBody: TemplateBody,
  attachIcs: Schema.Boolean,
  expectedVersion: ExpectedVersion,
  idempotencyKey: IdempotencyKey,
});
export type UpdateTemplateInput = typeof UpdateTemplateInput.Type;

export const AudienceEligibility = Schema.Literal("eligible", "missingEmail");
export type AudienceEligibility = typeof AudienceEligibility.Type;
export const AudienceDecision = Schema.Literal("accepted", "rejected", "mixed");
export type AudienceDecision = typeof AudienceDecision.Type;

export const AudienceRecipient = Schema.Struct({
  speakerId: EntityId,
  userId: Schema.Union(EntityId, Schema.Null),
  name: Schema.String,
  email: Schema.Union(Mailbox, Schema.Null),
  decision: AudienceDecision,
  sessionTitles: Schema.Array(Schema.String),
  eligibility: AudienceEligibility,
});
export type AudienceRecipient = typeof AudienceRecipient.Type;

export const AudienceSnapshot = Schema.Struct({
  eventId: EntityId,
  recipients: Schema.Array(AudienceRecipient),
  eligibleCount: Schema.Int.pipe(Schema.nonNegative()),
  dependency: Schema.Literal("decidedApplicants"),
});
export type AudienceSnapshot = typeof AudienceSnapshot.Type;

export const ListAudienceInput = Schema.Struct({ eventId: EntityId });
export type ListAudienceInput = typeof ListAudienceInput.Type;

export const PreviewMode = Schema.Literal("decidedApplicant", "sample");
export type PreviewMode = typeof PreviewMode.Type;

export const PreviewCommunicationInput = Schema.Struct({
  eventId: EntityId,
  subject: TemplateSubject,
  textBody: TemplateBody,
  htmlBody: TemplateBody,
  attachIcs: Schema.Boolean,
  speakerId: Schema.Union(EntityId, Schema.Null),
});
export type PreviewCommunicationInput = typeof PreviewCommunicationInput.Type;

export const CommunicationPreview = Schema.Struct({
  mode: PreviewMode,
  subject: Schema.String,
  text: Schema.String,
  html: Schema.String,
  recipientName: Schema.String,
  recipientEmail: Mailbox,
  variables: Schema.Array(Schema.Struct({ key: TemplateVariableKey, value: Schema.String })),
  delivery: Schema.Literal("notSent"),
  icsStatus: Schema.Literal("notRequested", "available", "unavailableAgenda"),
  unavailableVariables: Schema.Array(TemplateVariableKey),
  note: Schema.String,
});
export type CommunicationPreview = typeof CommunicationPreview.Type;

export const DeliveryStatus = Schema.Literal(
  "pending",
  "claimed",
  "dispatching",
  "retry",
  "sent",
  "dead_letter",
  "cancelled",
);
export type DeliveryStatus = typeof DeliveryStatus.Type;

export const AttemptStatus = Schema.Literal("started", "sent", "retry", "failed");
export const DeliveryAttempt = Schema.Struct({
  id: EntityId,
  attemptNumber: Schema.Int.pipe(Schema.positive()),
  status: AttemptStatus,
  providerMessageId: Schema.Union(Schema.String, Schema.Null),
  error: Schema.Union(Schema.String, Schema.Null),
  startedAt: UnixTimestampMs,
  completedAt: Schema.Union(UnixTimestampMs, Schema.Null),
});
export type DeliveryAttempt = typeof DeliveryAttempt.Type;

export const DeliveryMode = Schema.Literal("awaitingWorker", "live", "localCapture");
export type DeliveryMode = typeof DeliveryMode.Type;

export const DeliveryHistoryItem = Schema.Struct({
  id: EntityId,
  snapshotId: EntityId,
  templateId: Schema.Union(EntityId, Schema.Null),
  templateName: Schema.Union(Schema.String, Schema.Null),
  recipientName: Schema.Union(Schema.String, Schema.Null),
  recipientEmail: Mailbox,
  subject: Schema.String,
  status: DeliveryStatus,
  provider: Schema.String,
  mode: DeliveryMode,
  scheduledFor: UnixTimestampMs,
  availableAt: UnixTimestampMs,
  attemptCount: Schema.Int.pipe(Schema.nonNegative()),
  maxAttempts: Schema.Int.pipe(Schema.positive()),
  providerMessageId: Schema.Union(Schema.String, Schema.Null),
  lastError: Schema.Union(Schema.String, Schema.Null),
  sentAt: Schema.Union(UnixTimestampMs, Schema.Null),
  deadLetteredAt: Schema.Union(UnixTimestampMs, Schema.Null),
  createdAt: UnixTimestampMs,
  canRetry: Schema.Boolean,
  retryOfDeliveryId: Schema.Union(EntityId, Schema.Null),
  attempts: Schema.Array(DeliveryAttempt),
});
export type DeliveryHistoryItem = typeof DeliveryHistoryItem.Type;

export const DeliveryHistory = Schema.Struct({
  eventId: EntityId,
  deliveries: Schema.Array(DeliveryHistoryItem),
  localCaptureCount: Schema.Int.pipe(Schema.nonNegative()),
});
export type DeliveryHistory = typeof DeliveryHistory.Type;

export const ListDeliveriesInput = Schema.Struct({ eventId: EntityId });
export type ListDeliveriesInput = typeof ListDeliveriesInput.Type;

export const EnqueueCommunicationInput = Schema.Struct({
  eventId: EntityId,
  templateId: EntityId,
  expectedTemplateVersion: ExpectedVersion,
  recipientSpeakerIds: Schema.NonEmptyArray(EntityId),
  replyToEmail: NullableMailbox,
  scheduledFor: Schema.Union(UnixTimestampMs, Schema.Null),
  idempotencyKey: IdempotencyKey,
});
export type EnqueueCommunicationInput = typeof EnqueueCommunicationInput.Type;

export const QueuedDelivery = Schema.Struct({
  deliveryId: EntityId,
  snapshotId: EntityId,
  speakerId: EntityId,
  recipientEmail: Mailbox,
  status: Schema.Literal("pending"),
  scheduledFor: UnixTimestampMs,
});
export type QueuedDelivery = typeof QueuedDelivery.Type;

export const EnqueueCommunicationResult = Schema.Struct({
  eventId: EntityId,
  templateId: EntityId,
  queuedAt: UnixTimestampMs,
  queueState: Schema.Literal("persisted"),
  dispatchState: Schema.Literal("deferred"),
  schedulerWake: Schema.Literal("requested"),
  deliveries: Schema.NonEmptyArray(QueuedDelivery),
  replayed: Schema.Boolean,
});
export type EnqueueCommunicationResult = typeof EnqueueCommunicationResult.Type;

export const RetryDeliveryInput = Schema.Struct({
  eventId: EntityId,
  deliveryId: EntityId,
  idempotencyKey: IdempotencyKey,
});
export type RetryDeliveryInput = typeof RetryDeliveryInput.Type;

export const RetryDeliveryResult = Schema.Struct({
  eventId: EntityId,
  sourceDeliveryId: EntityId,
  deliveryId: EntityId,
  snapshotId: EntityId,
  queuedAt: UnixTimestampMs,
  status: Schema.Literal("pending"),
  dispatchState: Schema.Literal("deferred"),
  schedulerWake: Schema.Literal("requested"),
  replayed: Schema.Boolean,
});
export type RetryDeliveryResult = typeof RetryDeliveryResult.Type;
