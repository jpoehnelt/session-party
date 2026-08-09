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

const STRING_COMPATIBLE_FIELD_TYPES: Partial<Record<FormFieldType, true>> = {
  text: true,
  textarea: true,
  select: true,
  radio: true,
  email: true,
  url: true,
  date: true,
};

const isStringCompatibleFieldType = (type: FormFieldType): boolean =>
  STRING_COMPATIBLE_FIELD_TYPES[type] === true;

export const FORM_SEMANTIC_KEYS = [
  "submissionTitle",
  "submissionAbstract",
  "speakerName",
  "speakerEmail",
] as const;

export const FormSemanticKey = Schema.Literal(...FORM_SEMANTIC_KEYS);
export type FormSemanticKey = typeof FormSemanticKey.Type;

export const FORM_FIELD_OPTION_TYPES: Readonly<Record<FormFieldType, boolean>> = {
  text: false,
  textarea: false,
  select: true,
  multiselect: true,
  radio: true,
  checkbox: false,
  email: false,
  url: false,
  file: false,
  date: false,
  heading: false,
  html: false,
};

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
const NullableSemanticKey = Schema.NullOr(FormSemanticKey);
const NullableTimestamp = Schema.NullOr(UnixTimestampMs);
export const Routing = Schema.Record({ key: Schema.String, value: Schema.String });

export const PreviewAnswer = Schema.Union(
  Schema.String,
  Schema.Array(Schema.String),
  Schema.Boolean,
);
export type PreviewAnswer = typeof PreviewAnswer.Type;

export const PreviewAnswers = Schema.Record({
  key: EntityId,
  value: PreviewAnswer,
});
export type PreviewAnswers = typeof PreviewAnswers.Type;

export const FormFieldDraft = Schema.Struct({
  id: Schema.optional(EntityId),
  type: FormFieldType,
  label: Label,
  semanticKey: NullableSemanticKey,
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
  semanticKey: NullableSemanticKey,
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
  semanticKey: NullableSemanticKey,
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

export interface PublishValidationIssue {
  readonly controlId: string;
  readonly message: string;
}

export type PreviewField = FormField | FormVersionField;
export type FormAvailability = "draft" | "scheduled" | "open" | "expired" | "closed";

const conditionMatches = (condition: LogicCondition, answer: PreviewAnswer | undefined): boolean => {
  if (condition.op === "not_empty") {
    return Array.isArray(answer) ? answer.length > 0 : answer !== undefined && answer !== "" && answer !== false;
  }
  if (condition.op === "in") {
    const accepted = Array.isArray(condition.value) ? condition.value : [condition.value ?? ""];
    return Array.isArray(answer)
      ? answer.some((value) => accepted.includes(value))
      : typeof answer === "string" && accepted.includes(answer);
  }
  const expected = Array.isArray(condition.value) ? condition.value[0] : condition.value;
  const equal = Array.isArray(answer) ? answer.includes(expected ?? "") : answer === expected;
  return condition.op === "eq" ? equal : !equal;
};


export const getFormAvailability = (form: FormDetail, now: number): FormAvailability => {
  if (form.status === "closed") return "closed";
  if (form.status === "draft" || form.publishedVersion === null) return "draft";
  if (form.opensAt !== null && now < form.opensAt) return "scheduled";
  if (form.closesAt !== null && now >= form.closesAt) return "expired";
  return "open";
};

export const projectActiveAnswers = (
  fields: readonly PreviewField[],
  answers: Readonly<Record<string, PreviewAnswer>>,
): { readonly visibleFields: readonly PreviewField[]; readonly activeAnswers: Readonly<Record<string, PreviewAnswer>> } => {
  const visibleFields: PreviewField[] = [];
  const activeAnswers: Record<string, PreviewAnswer> = {};
  for (const field of fields) {
    const visible = field.logic === null || (() => {
      const matches = field.logic.conditions.map((condition) =>
        conditionMatches(condition, activeAnswers[condition.fieldId]));
      const conditionsPass = field.logic.mode === "all" ? matches.every(Boolean) : matches.some(Boolean);
      return field.logic.action === "hide" ? !conditionsPass : conditionsPass;
    })();
    if (!visible) continue;
    visibleFields.push(field);
    const fieldId = "sourceFieldId" in field ? field.sourceFieldId ?? field.id : field.id;
    if (answers[fieldId] !== undefined) activeAnswers[fieldId] = answers[fieldId];
  }
  return { visibleFields, activeAnswers };
};

export const validatePublishIntent = (form: FormDetail): readonly PublishValidationIssue[] => {
  const issues: PublishValidationIssue[] = [];
  if (form.name.trim().length === 0) {
    issues.push({ controlId: "builder-form-name", message: "Enter a form name." });
  }
  if (form.opensAt !== null && form.closesAt !== null && form.closesAt < form.opensAt) {
    issues.push({ controlId: "builder-closes-at", message: "Close time must be at or after open time." });
  }
  const semanticFields = new Map<FormSemanticKey, FormField>();
  for (const [fieldIndex, field] of form.fields.entries()) {
    if (field.label.trim().length === 0) {
      issues.push({
        controlId: `builder-field-${field.id}-label`,
        message: `Field ${field.order} needs a label.`,
      });
    }
    if (field.semanticKey !== null) {
      const duplicate = semanticFields.get(field.semanticKey);
      if (duplicate) {
        issues.push({
          controlId: `builder-field-${field.id}-semantic-key`,
          message: `${field.semanticKey} is already assigned to ${duplicate.label}.`,
        });
      } else {
        semanticFields.set(field.semanticKey, field);
      }
    }
    if (FORM_FIELD_OPTION_TYPES[field.type]) {
      if (field.options.length === 0) {
        issues.push({
          controlId: `builder-field-${field.id}-options`,
          message: `${field.label || `Field ${field.order}`} needs at least one option.`,
        });
      }
      const normalized = field.options.map((option) => option.trim());
      if (normalized.some((option) => option.length === 0) || new Set(normalized).size !== normalized.length) {
        issues.push({
          controlId: `builder-field-${field.id}-options`,
          message: `${field.label || `Field ${field.order}`} has blank or duplicate options.`,
        });
      }
    }
    field.logic?.conditions.forEach((condition, conditionIndex) => {
      const sourceIndex = form.fields.findIndex((candidate) => candidate.id === condition.fieldId);
      if (sourceIndex < 0 || sourceIndex >= fieldIndex) {
        issues.push({
          controlId: `builder-field-${field.id}-condition-${conditionIndex}-source`,
          message: `${field.label || `Field ${field.order}`} must depend on an earlier field.`,
        });
      }
    });
  }
  if (form.purpose === "primary-cfp") {
    for (const requiredKey of ["submissionTitle", "submissionAbstract", "speakerName"] as const) {
      const assignedFields = form.fields.filter((field) => field.semanticKey === requiredKey);
      const assignedField = assignedFields[0];
      if (assignedFields.length !== 1 || !assignedField) {
        issues.push({
          controlId: assignedField
            ? `builder-field-${assignedField.id}-semantic-key`
            : (form.fields[0] ? `builder-field-${form.fields[0].id}-semantic-key` : "builder-add-field"),
          message: `The primary CFP needs exactly one ${requiredKey} field.`,
        });
        continue;
      }
      if (!assignedField.required) {
        issues.push({
          controlId: `builder-field-${assignedField.id}-semantic-key`,
          message: `The primary CFP ${requiredKey} field must be required.`,
        });
      }
      if (assignedField.logic !== null) {
        issues.push({
          controlId: `builder-field-${assignedField.id}-semantic-key`,
          message: `The primary CFP ${requiredKey} field cannot be conditional.`,
        });
      }
      if (!isStringCompatibleFieldType(assignedField.type)) {
        issues.push({
          controlId: `builder-field-${assignedField.id}-type`,
          message: `The primary CFP ${requiredKey} field must submit a text value.`,
        });
      }
    }
  }
  if (form.purpose === "primary-cfp") {
    const completeRouter = form.fields.find((field) =>
      (field.type === "select" || field.type === "radio") &&
      field.options.length > 0 &&
      field.options.every((option) => field.routing[option]?.trim()));
    if (!completeRouter) {
      const candidate = form.fields.find((field) => field.type === "select" || field.type === "radio");
      const missingOptionIndex = candidate?.options.findIndex((option) =>
        !candidate.routing[option]?.trim()) ?? -1;
      issues.push({
        controlId: candidate
          ? candidate.options.length > 0
            ? `builder-field-${candidate.id}-routing-${Math.max(0, missingOptionIndex)}`
            : `builder-field-${candidate.id}-options`
          : form.fields[0]
            ? `builder-field-${form.fields[0].id}-type`
            : "builder-add-field",
        message: "Route every option in one select or radio field to a review category.",
      });
    }
  }
  return issues;
};

export const updateConditionAt = (
  logic: ConditionalLogic,
  conditionIndex: number,
  patch: Partial<LogicCondition>,
): ConditionalLogic => ({
  ...logic,
  conditions: logic.conditions.map((condition, index) =>
    index === conditionIndex ? { ...condition, ...patch } : condition) as unknown as ConditionalLogic["conditions"],
});

export const normalizeOptionDraft = (
  raw: string,
  routing: Readonly<Record<string, string>>,
): { readonly options: readonly string[]; readonly routing: Readonly<Record<string, string>> } => {
  const options = raw.split(/\r?\n/).map((option) => option.trim()).filter(Boolean);
  return {
    options,
    routing: Object.fromEntries(
      Object.entries(routing).filter(([option]) => options.includes(option)),
    ),
  };
};

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
