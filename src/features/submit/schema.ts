import { EntityId, Pagination, PaginationInput, UnixTimestampMs } from "contracts/domain";
import { AnswerValue } from "contracts/types";
import { Schema } from "effect";
import { ConditionalLogic, FormFieldType } from "@/features/forms/schema";

const EventSlug = Schema.String.pipe(
  Schema.minLength(2),
  Schema.maxLength(80),
  Schema.pattern(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
);
const IdempotencyKey = Schema.String.pipe(Schema.minLength(8), Schema.maxLength(200));
const TurnstileToken = Schema.String.pipe(Schema.minLength(1), Schema.maxLength(2_048));
const NullableText = Schema.NullOr(Schema.String);
export const MAX_PUBLIC_SUBMISSION_ANSWERS = 100;

export const SubmissionStatus = Schema.Literal(
  "submitted",
  "in_review",
  "accepted",
  "rejected",
  "waitlist",
  "withdrawn",
);
export type SubmissionStatus = typeof SubmissionStatus.Type;

export const PublicFormAvailability = Schema.Literal("scheduled", "open", "closed");
export type PublicFormAvailability = typeof PublicFormAvailability.Type;

export const PublicFormField = Schema.Struct({
  id: EntityId,
  order: Schema.Int.pipe(Schema.positive()),
  type: FormFieldType,
  label: Schema.String,
  helpText: NullableText,
  required: Schema.Boolean,
  options: Schema.Array(Schema.String),
  logic: Schema.NullOr(ConditionalLogic),
});
export type PublicFormField = typeof PublicFormField.Type;

export const PublicSubmissionForm = Schema.Struct({
  event: Schema.Struct({
    name: Schema.String,
    slug: EventSlug,
    description: NullableText,
    timezone: Schema.String,
    startsAt: Schema.NullOr(UnixTimestampMs),
    endsAt: Schema.NullOr(UnixTimestampMs),
    location: NullableText,
    accentColor: NullableText,
  }),
  form: Schema.Struct({
    id: EntityId,
    versionId: EntityId,
    versionNumber: Schema.Int.pipe(Schema.positive()),
    name: Schema.String,
    description: NullableText,
    availability: PublicFormAvailability,
    opensAt: Schema.NullOr(UnixTimestampMs),
    closesAt: Schema.NullOr(UnixTimestampMs),
    fields: Schema.Array(PublicFormField),
  }),
  /** Public site keys are safe to render; the secret stays only in AppLayer. */
  turnstileSiteKey: Schema.optional(Schema.NullOr(Schema.String.pipe(Schema.minLength(1), Schema.maxLength(200)))),
});
export type PublicSubmissionForm = typeof PublicSubmissionForm.Type;

export const GetPublicSubmissionFormInput = Schema.Struct({
  eventSlug: EventSlug,
  formId: EntityId,
});
export type GetPublicSubmissionFormInput = typeof GetPublicSubmissionFormInput.Type;

export const GetTaskSubmissionFormInput = Schema.Struct({
  eventId: EntityId,
  formId: EntityId,
});
export type GetTaskSubmissionFormInput = typeof GetTaskSubmissionFormInput.Type;

export const SubmissionAnswer = Schema.Struct({
  fieldId: EntityId,
  value: AnswerValue,
});
export type SubmissionAnswer = typeof SubmissionAnswer.Type;

const SpeakerName = Schema.String.pipe(Schema.maxLength(200));
const SpeakerEmail = Schema.String.pipe(Schema.maxLength(320));
const SpeakerProfileText = Schema.String.pipe(Schema.maxLength(200));
const SpeakerRoleLabel = Schema.String.pipe(Schema.maxLength(80));

/** A public co-speaker never needs an account to be recorded against a CFP submission. */
export const PublicCoSpeaker = Schema.Struct({
  name: SpeakerName,
  email: Schema.optional(SpeakerEmail),
  roleLabel: Schema.optional(SpeakerRoleLabel),
  title: Schema.optional(SpeakerProfileText),
  organization: Schema.optional(SpeakerProfileText),
});
export type PublicCoSpeaker = typeof PublicCoSpeaker.Type;

export const CreatePublicSubmissionInput = Schema.Struct({
  eventSlug: EventSlug,
  formId: EntityId,
  idempotencyKey: IdempotencyKey,
  /** Omitted only for a known idempotent replay; fresh production writes fail closed. */
  turnstileToken: Schema.optional(TurnstileToken),
  answers: Schema.Array(SubmissionAnswer).pipe(Schema.maxItems(MAX_PUBLIC_SUBMISSION_ANSWERS)),
  /** Optional public profile context for the primary speaker. */
  primarySpeakerTitle: Schema.optional(SpeakerProfileText),
  primarySpeakerOrganization: Schema.optional(SpeakerProfileText),
  /** Bounded so one public submission cannot reserve an unbounded number of speaker records. */
  coSpeakers: Schema.optional(Schema.Array(PublicCoSpeaker).pipe(Schema.maxItems(10))),
});
export type CreatePublicSubmissionInput = typeof CreatePublicSubmissionInput.Type;

export const CreateTaskSubmissionInput = Schema.Struct({
  eventId: EntityId,
  formId: EntityId,
  idempotencyKey: IdempotencyKey,
  answers: Schema.Array(SubmissionAnswer),
});
export type CreateTaskSubmissionInput = typeof CreateTaskSubmissionInput.Type;

export const CreatePublicSubmissionOutput = Schema.Struct({
  submissionId: EntityId,
  status: Schema.Literal("submitted"),
  submittedAt: UnixTimestampMs,
});
export type CreatePublicSubmissionOutput = typeof CreatePublicSubmissionOutput.Type;

export const ListSubmissionsInput = Schema.extend(
  Schema.Struct({
    eventId: EntityId,
    status: Schema.optional(SubmissionStatus),
    formId: Schema.optional(EntityId),
    category: Schema.optional(Schema.String.pipe(Schema.minLength(1), Schema.maxLength(200))),
  }),
  PaginationInput,
);
export type ListSubmissionsInput = typeof ListSubmissionsInput.Type;

export const SubmissionSummary = Schema.Struct({
  id: EntityId,
  formId: EntityId,
  formName: Schema.String,
  title: Schema.String,
  category: NullableText,
  status: SubmissionStatus,
  primarySpeakerName: NullableText,
  submittedAt: UnixTimestampMs,
  version: Schema.Int.pipe(Schema.positive()),
});
export type SubmissionSummary = typeof SubmissionSummary.Type;

export const SubmissionPage = Schema.Struct({
  results: Schema.Array(SubmissionSummary),
  categories: Schema.Array(Schema.String),
  pagination: Pagination,
});
export type SubmissionPage = typeof SubmissionPage.Type;

export const GetOwnSubmissionsInput = Schema.Struct({
  eventSlug: EventSlug,
});
export type GetOwnSubmissionsInput = typeof GetOwnSubmissionsInput.Type;

export const OwnSubmissionSummary = Schema.Struct({
  id: EntityId,
  formId: EntityId,
  formName: Schema.String,
  title: Schema.String,
  abstract: Schema.String,
  category: NullableText,
  status: SubmissionStatus,
  submittedAt: UnixTimestampMs,
  version: Schema.Int.pipe(Schema.positive()),
  editable: Schema.Boolean,
  /** Preserves the submitted participant roster and its explicit presentation roles. */
  participants: Schema.optional(Schema.Array(Schema.Struct({
    speakerId: EntityId,
    displayName: Schema.String,
    roleLabel: Schema.String,
    isPrimary: Schema.Boolean,
    title: NullableText,
    organization: NullableText,
  }))),
});
export type OwnSubmissionSummary = typeof OwnSubmissionSummary.Type;

export const OwnSubmissions = Schema.Struct({
  event: Schema.Struct({
    name: Schema.String,
    slug: EventSlug,
  }),
  submissions: Schema.Array(OwnSubmissionSummary),
});
export type OwnSubmissions = typeof OwnSubmissions.Type;

export const UpdateOwnSubmissionAbstractInput = Schema.Struct({
  eventSlug: EventSlug,
  submissionId: EntityId,
  abstract: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(20_000)),
  expectedVersion: Schema.Int.pipe(Schema.positive()),
  idempotencyKey: IdempotencyKey,
});
export type UpdateOwnSubmissionAbstractInput = typeof UpdateOwnSubmissionAbstractInput.Type;

export const UpdateOwnSubmissionAbstractOutput = Schema.Struct({
  submission: OwnSubmissionSummary,
  idempotent: Schema.Boolean,
});
export type UpdateOwnSubmissionAbstractOutput = typeof UpdateOwnSubmissionAbstractOutput.Type;

export const WithdrawOwnSubmissionInput = Schema.Struct({
  eventSlug: EventSlug,
  submissionId: EntityId,
  /** Optional context for the organizer; recorded in the change feed and audit log. */
  reason: Schema.optional(Schema.String.pipe(Schema.maxLength(2_000))),
  expectedVersion: Schema.Int.pipe(Schema.positive()),
  idempotencyKey: IdempotencyKey,
});
export type WithdrawOwnSubmissionInput = typeof WithdrawOwnSubmissionInput.Type;

export const WithdrawOwnSubmissionOutput = Schema.Struct({
  submission: OwnSubmissionSummary,
  idempotent: Schema.Boolean,
});
export type WithdrawOwnSubmissionOutput = typeof WithdrawOwnSubmissionOutput.Type;
