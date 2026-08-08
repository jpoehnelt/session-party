import { EntityId, UnixTimestampMs } from "contracts/domain";
import { Schema } from "effect";

export const FORM_FIELD_TYPES = [
  "text",
  "textarea",
  "select",
  "multiselect",
  "radio",
  "checkbox",
  "email",
  "url",
  "file",
  "date",
  "heading",
  "html",
] as const;

export const FormFieldType = Schema.Literal(...FORM_FIELD_TYPES);
export type FormFieldType = typeof FormFieldType.Type;

export const FormStatus = Schema.Literal("draft", "open", "closed");
export type FormStatus = typeof FormStatus.Type;

/** `primary-cfp` maps to the frozen `forms.kind = cfp`; additional forms map to `task`. */
export const FormPurpose = Schema.Literal("primary-cfp", "additional");
export type FormPurpose = typeof FormPurpose.Type;

export const LogicOperator = Schema.Literal("eq", "neq", "in", "not_empty");
export type LogicOperator = typeof LogicOperator.Type;

export const LogicCondition = Schema.Struct({
  fieldId: EntityId,
  op: LogicOperator,
  value: Schema.optional(Schema.Union(Schema.String, Schema.Array(Schema.String))),
});
export type LogicCondition = typeof LogicCondition.Type;

/** Local extension of the frozen show-only shape; absence of `action` in old rows decodes as `show`. */
export const ConditionalLogic = Schema.Struct({
  action: Schema.optionalWith(Schema.Literal("show", "hide"), { default: () => "show" as const }),
  mode: Schema.Literal("all", "any"),
  conditions: Schema.NonEmptyArray(LogicCondition),
});
export type ConditionalLogic = typeof ConditionalLogic.Type;

const Label = Schema.String.pipe(Schema.minLength(1), Schema.maxLength(240));
const Option = Schema.String.pipe(Schema.minLength(1), Schema.maxLength(160));
const NullableText = Schema.NullOr(Schema.String);
const NullableTimestamp = Schema.NullOr(UnixTimestampMs);
const Routing = Schema.Record({ key: Schema.String, value: Schema.String });

export const FormFieldDraft = Schema.Struct({
  id: Schema.optional(EntityId),
  type: FormFieldType,
  label: Label,
  helpText: NullableText,
  required: Schema.Boolean,
  options: Schema.Array(Option),
  logic: Schema.NullOr(ConditionalLogic),
  routing: Routing,
});
export type FormFieldDraft = typeof FormFieldDraft.Type;

export const FormField = Schema.Struct({
  id: EntityId,
  order: Schema.Int.pipe(Schema.positive()),
  type: FormFieldType,
  label: Label,
  helpText: NullableText,
  required: Schema.Boolean,
  options: Schema.Array(Option),
  logic: Schema.NullOr(ConditionalLogic),
  routing: Routing,
  version: Schema.Int.pipe(Schema.positive()),
});
export type FormField = typeof FormField.Type;

export const FormVersionField = Schema.Struct({
  id: EntityId,
  sourceFieldId: Schema.NullOr(EntityId),
  order: Schema.Int.pipe(Schema.positive()),
  type: FormFieldType,
  label: Label,
  helpText: NullableText,
  required: Schema.Boolean,
  options: Schema.Array(Option),
  logic: Schema.NullOr(ConditionalLogic),
  routing: Routing,
});
export type FormVersionField = typeof FormVersionField.Type;

export const PublishedFormVersion = Schema.Struct({
  id: EntityId,
  versionNumber: Schema.Int.pipe(Schema.positive()),
  name: Schema.String,
  description: NullableText,
  publishedAt: UnixTimestampMs,
  retiredAt: NullableTimestamp,
  fields: Schema.Array(FormVersionField),
});
export type PublishedFormVersion = typeof PublishedFormVersion.Type;

export const FormSummary = Schema.Struct({
  id: EntityId,
  eventId: EntityId,
  purpose: FormPurpose,
  name: Schema.String,
  description: NullableText,
  status: FormStatus,
  opensAt: NullableTimestamp,
  closesAt: NullableTimestamp,
  version: Schema.Int.pipe(Schema.positive()),
  publishedVersionNumber: Schema.NullOr(Schema.Int.pipe(Schema.positive())),
  updatedAt: UnixTimestampMs,
});
export type FormSummary = typeof FormSummary.Type;

export const FormDetail = Schema.Struct({
  id: EntityId,
  eventId: EntityId,
  purpose: FormPurpose,
  name: Schema.String,
  description: NullableText,
  status: FormStatus,
  opensAt: NullableTimestamp,
  closesAt: NullableTimestamp,
  version: Schema.Int.pipe(Schema.positive()),
  createdAt: UnixTimestampMs,
  updatedAt: UnixTimestampMs,
  fields: Schema.Array(FormField),
  publishedVersion: Schema.NullOr(PublishedFormVersion),
});
export type FormDetail = typeof FormDetail.Type;

export const ListFormsInput = Schema.Struct({ eventId: EntityId });
export type ListFormsInput = typeof ListFormsInput.Type;

export const GetFormInput = Schema.Struct({ eventId: EntityId, formId: EntityId });
export type GetFormInput = typeof GetFormInput.Type;

const FormName = Schema.String.pipe(Schema.minLength(1), Schema.maxLength(200), Schema.pattern(/\S/));
const IdempotencyKey = Schema.String.pipe(Schema.minLength(8), Schema.maxLength(200));
const DraftFields = Schema.NonEmptyArray(FormFieldDraft);
const PositiveVersion = Schema.Int.pipe(Schema.positive());
const HeaderVersion = Schema.transform(
  Schema.String.pipe(Schema.pattern(/^(?:"[1-9]\d*"|[1-9]\d*)$/)),
  PositiveVersion,
  {
    decode: (value) => Number(value.startsWith("\"") ? value.slice(1, -1) : value),
    encode: (value) => String(value),
  },
);
export const ExpectedVersion = Schema.Union(PositiveVersion, HeaderVersion);

export const CreateFormInput = Schema.Struct({
  eventId: EntityId,
  purpose: FormPurpose,
  name: FormName,
  description: NullableText,
  opensAt: NullableTimestamp,
  closesAt: NullableTimestamp,
  fields: DraftFields,
  idempotencyKey: IdempotencyKey,
});
export type CreateFormInput = typeof CreateFormInput.Type;

export const UpdateFormInput = Schema.Struct({
  eventId: EntityId,
  formId: EntityId,
  expectedVersion: ExpectedVersion,
  name: FormName,
  description: NullableText,
  opensAt: NullableTimestamp,
  closesAt: NullableTimestamp,
  fields: DraftFields,
  idempotencyKey: IdempotencyKey,
});
export type UpdateFormInput = typeof UpdateFormInput.Type;

export const PublishFormInput = Schema.Struct({
  eventId: EntityId,
  formId: EntityId,
  expectedVersion: ExpectedVersion,
  idempotencyKey: IdempotencyKey,
});
export type PublishFormInput = typeof PublishFormInput.Type;

export const SetFormStatusInput = Schema.Struct({
  eventId: EntityId,
  formId: EntityId,
  expectedVersion: ExpectedVersion,
  status: Schema.Literal("open", "closed"),
  idempotencyKey: IdempotencyKey,
});
export type SetFormStatusInput = typeof SetFormStatusInput.Type;

export const FormList = Schema.Array(FormSummary);
