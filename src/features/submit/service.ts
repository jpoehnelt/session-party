import { Conflict, External, Forbidden, NotFound, Validation, type AppError } from "contracts/errors";
import { eventAuthorization } from "contracts/principal";
import {
  acceptanceEvents,
  auditLog,
  domainChanges,
  events,
  eventMembers,
  formVersionFields,
  formVersions,
  forms,
  idempotencyRecords,
  reviewAssignments,
  speakerProvisioning,
  speakers,
  submissionAnswers,
  submissionSpeakers,
  submissions,
} from "contracts/schema";
import type { AnswerValue } from "contracts/types";
import { and, asc, count, desc, eq, exists, gt, inArray, isNotNull, isNull, lte, or, sql } from "drizzle-orm";
import { Effect, Schema } from "effect";
import { nanoid } from "nanoid";
import { Authorizer, CurrentUser, Db, Rooms } from "@/server/services";
import { ConditionalLogic, FormFieldType, Routing } from "@/features/forms/schema";
import { PublicSubmissionAbuse, PublicSubmissionRequest, normalizePublicEmail } from "./abuse";
import {
  CreatePublicSubmissionOutput,
  type CreatePublicSubmissionInput,
  type CreateTaskSubmissionInput,
  type GetOwnSubmissionsInput,
  type ListSubmissionsInput,
  type OwnSubmissionSummary,
  type OwnSubmissions,
  type PublicFormField,
  type PublicSubmissionForm,
  type SubmissionPage,
  UpdateOwnSubmissionAbstractOutput,
  type UpdateOwnSubmissionAbstractInput,
} from "./schema";

const COMMAND_TTL_MS = 24 * 60 * 60 * 1_000;
const organizerReadAuthorization = eventAuthorization(
  { kind: "event-member", roles: ["owner", "admin", "reviewer"] },
  { kind: "api-key", scopes: ["submissions:read"] },
);

type VersionFieldRow = typeof formVersionFields.$inferSelect;
type InternalField = PublicFormField & {
  readonly semanticKey: VersionFieldRow["semanticKey"];
  readonly routing: Readonly<Record<string, string>>;
};
type LoadedPublicForm = {
  readonly eventId: string;
  readonly formKind: "cfp" | "task";
  readonly publicForm: PublicSubmissionForm;
  readonly fields: readonly InternalField[];
};

const database = <A>(run: () => Promise<A>): Effect.Effect<A, External> =>
  Effect.tryPromise({
    try: run,
    catch: (error) =>
      new External({
        service: "database",
        detail: error instanceof Error ? error.message : String(error),
      }),
  });

const decodeColumn = <A, I>(
  schema: Schema.Schema<A, I, never>,
  value: unknown,
  name: string,
  parseJson = false,
) =>
  Effect.try({
    try: () => Schema.decodeUnknownSync(schema)(
      parseJson && typeof value === "string" ? JSON.parse(value) : value,
    ),
    catch: (error) =>
      new External({
        service: "database",
        detail: `Invalid ${name} in published form snapshot: ${error instanceof Error ? error.message : String(error)}`,
      }),
  });

const stableStringify = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
};

const sha256 = (value: string): Effect.Effect<string, External> =>
  Effect.tryPromise({
    try: async () => {
      const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
      return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
    },
    catch: (error) => new External({ service: "crypto", detail: String(error) }),
  });

const availability = (
  status: "draft" | "open" | "closed",
  opensAt: Date | null,
  closesAt: Date | null,
  now: number,
): PublicSubmissionForm["form"]["availability"] => {
  if (status !== "open") return "closed";
  if (opensAt && now < opensAt.getTime()) return "scheduled";
  if (closesAt && now >= closesAt.getTime()) return "closed";
  return "open";
};

const normalizeLogic = (
  logic: typeof ConditionalLogic.Type | null,
  immutableIdBySourceId: ReadonlyMap<string, string>,
): typeof ConditionalLogic.Type | null => {
  if (logic === null) return null;
  const remapCondition = (condition: typeof logic.conditions[number]) => ({
    ...condition,
    fieldId: immutableIdBySourceId.get(condition.fieldId) ?? condition.fieldId,
  });
  const [first, ...rest] = logic.conditions;
  return {
    ...logic,
    conditions: [remapCondition(first), ...rest.map(remapCondition)],
  };
};

const loadPublishedForm = (
  event: { readonly kind: "id" | "slug"; readonly value: string },
  formId: string,
): Effect.Effect<LoadedPublicForm, AppError, Db> =>
  Effect.gen(function* () {
    const { db } = yield* Db;
    const [record] = yield* database(() =>
      db
        .select({ event: events, form: forms, version: formVersions })
        .from(events)
        .innerJoin(forms, and(eq(forms.eventId, events.id), eq(forms.id, formId)))
        .innerJoin(
          formVersions,
          and(
            eq(formVersions.eventId, forms.eventId),
            eq(formVersions.formId, forms.id),
            isNull(formVersions.retiredAt),
          ),
        )
        .where(event.kind === "slug" ? eq(events.slug, event.value) : eq(events.id, event.value))
        .limit(1),
    );
    if (!record) return yield* Effect.fail(new NotFound({ entity: "published form", id: formId }));

    const rows = yield* database(() =>
      db
        .select()
        .from(formVersionFields)
        .where(
          and(
            eq(formVersionFields.eventId, record.event.id),
            eq(formVersionFields.formVersionId, record.version.id),
          ),
        )
        .orderBy(asc(formVersionFields.order)),
    );
    const immutableIdBySourceId = new Map<string, string>();
    for (const row of rows) {
      immutableIdBySourceId.set(row.id, row.id);
      if (row.sourceFieldId) immutableIdBySourceId.set(row.sourceFieldId, row.id);
    }
    const fields = yield* Effect.forEach(rows, (row) =>
      Effect.gen(function* () {
        const type = yield* decodeColumn(FormFieldType, row.type, "field type");
        const logic = row.logic === null
          ? null
          : yield* decodeColumn(ConditionalLogic, row.logic, "conditional logic", true);
        const routing = row.routing === null
          ? {}
          : yield* decodeColumn(Routing, row.routing, "routing", true);
        return {
          id: row.id,
          order: row.order,
          type,
          label: row.label,
          helpText: row.helpText,
          required: row.required,
          options: row.options ?? [],
          logic: normalizeLogic(logic, immutableIdBySourceId),
          semanticKey: row.semanticKey,
          routing,
        } satisfies InternalField;
      }),
    );
    const now = Date.now();
    return {
      eventId: record.event.id,
      formKind: record.form.kind,
      fields,
      publicForm: {
        event: {
          name: record.event.name,
          slug: record.event.slug,
          description: record.event.description,
          timezone: record.event.timezone,
          startsAt: record.event.startsAt?.getTime() ?? null,
          endsAt: record.event.endsAt?.getTime() ?? null,
          location: record.event.location,
          accentColor: record.event.accentColor,
        },
        form: {
          id: record.form.id,
          versionId: record.version.id,
          versionNumber: record.version.versionNumber,
          name: record.version.name,
          description: record.version.description,
          availability: availability(record.form.status, record.form.opensAt, record.form.closesAt, now),
          opensAt: record.form.opensAt?.getTime() ?? null,
          closesAt: record.form.closesAt?.getTime() ?? null,
          fields: fields.map(({ semanticKey: _semanticKey, routing: _routing, ...field }) => field),
        },
        turnstileSiteKey: null,
      },
    };
  });

export const getPublicSubmissionForm = (
  input: { readonly eventSlug: string; readonly formId: string },
): Effect.Effect<PublicSubmissionForm, AppError, Db | PublicSubmissionAbuse> =>
  Effect.gen(function* () {
    const { publicForm } = yield* loadPublishedForm({ kind: "slug", value: input.eventSlug }, input.formId);
    const abuse = yield* PublicSubmissionAbuse;
    return { ...publicForm, turnstileSiteKey: abuse.turnstileSiteKey };
  });

const conditionMatches = (
  condition: typeof ConditionalLogic.Type["conditions"][number],
  sourceType: InternalField["type"] | undefined,
  value: AnswerValue | undefined,
): boolean => {
  /** An unchecked checkbox persists the literal "false"; it is an empty answer, not a present one. */
  const empty = value === undefined
    || (Array.isArray(value) && value.length === 0)
    || (typeof value === "string" && value.trim().length === 0)
    || (sourceType === "checkbox" && value === "false");
  if (condition.op === "not_empty") return !empty;
  if (condition.op === "in") {
    const accepted = Array.isArray(condition.value) ? condition.value : [condition.value ?? ""];
    return Array.isArray(value)
      ? value.some((item) => accepted.includes(item))
      : typeof value === "string" && accepted.includes(value);
  }
  const expected = Array.isArray(condition.value) ? condition.value[0] : condition.value;
  const equal = Array.isArray(value) ? value.includes(expected ?? "") : value === expected;
  return condition.op === "eq" ? equal : !equal;
};

const isVisible = (
  field: InternalField,
  activeAnswers: Readonly<Record<string, AnswerValue>>,
  fieldsById: ReadonlyMap<string, InternalField>,
): boolean => {
  if (field.logic === null) return true;
  const matches = field.logic.conditions.map((condition) =>
    conditionMatches(
      condition,
      fieldsById.get(condition.fieldId)?.type,
      activeAnswers[condition.fieldId],
    ));
  const passed = field.logic.mode === "all" ? matches.every(Boolean) : matches.some(Boolean);
  return field.logic.action === "hide" ? !passed : passed;
};

const validateValue = (field: InternalField, value: AnswerValue | undefined): string | null => {
  const missing = value === undefined
    || (typeof value === "string" && value.trim().length === 0)
    || (Array.isArray(value) && value.length === 0);
  if (missing) return field.required ? `${field.label} is required.` : null;
  if (field.type === "heading" || field.type === "html") return `${field.label} does not accept an answer.`;
  if (field.type === "file") {
    return "File answers require a verified public upload capability, which is not available.";
  }
  if (field.type === "multiselect") {
    if (!Array.isArray(value) || value.some((item) => !field.options.includes(item))) {
      return `${field.label} contains an invalid option.`;
    }
    if (new Set(value).size !== value.length) return `${field.label} contains duplicate options.`;
    return null;
  }
  if (field.type === "checkbox") {
    return typeof value === "string" && (value === "true" || value === "false")
      ? field.required && value !== "true" ? `${field.label} is required.` : null
      : `${field.label} must be a checkbox value.`;
  }
  if (typeof value !== "string") return `${field.label} must be text.`;
  if ((field.type === "select" || field.type === "radio") && !field.options.includes(value)) {
    return `${field.label} contains an invalid option.`;
  }
  if (field.type === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
    return `${field.label} must be a valid email address.`;
  }
  if (field.type === "url") {
    try {
      const url = new URL(value);
      if (url.protocol !== "http:" && url.protocol !== "https:") return `${field.label} must be an HTTP URL.`;
    } catch {
      return `${field.label} must be a valid URL.`;
    }
  }
  if (field.type === "date") {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (!match) return `${field.label} must be a date.`;
    const [, year, month, day] = match;
    const parsed = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
    if (parsed.toISOString().slice(0, 10) !== value) return `${field.label} must be a real calendar date.`;
  }
  return null;
};

type ValidatedSubmission = {
  readonly answers: readonly { readonly field: InternalField; readonly value: AnswerValue }[];
  readonly title: string;
  readonly speakerName: string;
  readonly speakerEmail: string | null;
  readonly category: string | null;
};

type NormalizedSpeaker = {
  readonly name: string;
  readonly email: string | null;
  readonly title: string | null;
  readonly organization: string | null;
};

const normalizeOptionalText = (value: string | undefined): string | null => {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
};

const normalizePublicSpeakers = (
  input: Pick<CreatePublicSubmissionInput, "coSpeakers" | "primarySpeakerTitle" | "primarySpeakerOrganization">,
  primaryEmail: string | null,
): Effect.Effect<{ readonly primary: Pick<NormalizedSpeaker, "title" | "organization">; readonly coSpeakers: readonly NormalizedSpeaker[] }, Validation> =>
  Effect.gen(function* () {
    const normalizedPrimaryEmail = primaryEmail === null ? null : normalizePublicEmail(primaryEmail);
    const emails = new Set<string>();
    if (normalizedPrimaryEmail) emails.add(normalizedPrimaryEmail);
    const coSpeakers: NormalizedSpeaker[] = [];
    for (const [index, speaker] of (input.coSpeakers ?? []).entries()) {
      const name = speaker.name.trim();
      if (!name) {
        return yield* Effect.fail(new Validation({ message: `Co-speaker ${index + 1} needs a name.` }));
      }
      const email = normalizeOptionalText(speaker.email);
      if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return yield* Effect.fail(new Validation({ message: `Co-speaker ${index + 1} must have a valid email address.` }));
      }
      const normalizedEmail = email === null ? null : normalizePublicEmail(email);
      if (normalizedEmail && emails.has(normalizedEmail)) {
        return yield* Effect.fail(new Validation({ message: "Each speaker email must be unique." }));
      }
      if (normalizedEmail) emails.add(normalizedEmail);
      coSpeakers.push({
        name,
        email: normalizedEmail,
        title: normalizeOptionalText(speaker.title),
        organization: normalizeOptionalText(speaker.organization),
      });
    }
    return {
      primary: {
        title: normalizeOptionalText(input.primarySpeakerTitle),
        organization: normalizeOptionalText(input.primarySpeakerOrganization),
      },
      coSpeakers,
    };
  });

const validateAnswers = (
  loaded: LoadedPublicForm,
  input: { readonly answers: CreatePublicSubmissionInput["answers"] },
): Effect.Effect<ValidatedSubmission, Validation> =>
  Effect.gen(function* () {
    if (loaded.publicForm.form.availability !== "open") {
      return yield* Effect.fail(new Validation({ message: "This form is not accepting submissions." }));
    }
    const byId = new Map(loaded.fields.map((field) => [field.id, field]));
    const provided = new Map<string, AnswerValue>();
    for (const answer of input.answers) {
      if (provided.has(answer.fieldId)) {
        return yield* Effect.fail(new Validation({ message: `Answer field '${answer.fieldId}' is duplicated.` }));
      }
      if (!byId.has(answer.fieldId)) {
        return yield* Effect.fail(new Validation({ message: `Answer field '${answer.fieldId}' is not in the published form.` }));
      }
      provided.set(answer.fieldId, answer.value);
    }

    const activeAnswers: Record<string, AnswerValue> = {};
    const validated: Array<{ field: InternalField; value: AnswerValue }> = [];
    for (const field of loaded.fields) {
      const visible = isVisible(field, activeAnswers, byId);
      const value = provided.get(field.id);
      if (!visible) {
        if (value !== undefined) {
          return yield* Effect.fail(new Validation({ message: `${field.label} is not currently visible.` }));
        }
        continue;
      }
      const problem = validateValue(field, value);
      if (problem) return yield* Effect.fail(new Validation({ message: problem }));
      if (value !== undefined) {
        activeAnswers[field.id] = value;
        validated.push({ field, value });
      }
    }

    const semantic = (key: NonNullable<VersionFieldRow["semanticKey"]>): string | null => {
      const field = loaded.fields.find((candidate) => candidate.semanticKey === key);
      if (!field) return null;
      const value = activeAnswers[field.id];
      return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
    };
    const title = semantic("submissionTitle");
    const abstract = semantic("submissionAbstract");
    const speakerName = semantic("speakerName");
    const speakerEmail = semantic("speakerEmail");
    if (loaded.formKind === "task") {
      return {
        answers: validated,
        title: title ?? loaded.publicForm.form.name,
        speakerName: speakerName ?? "",
        speakerEmail: null,
        category: null,
      };
    }
    if (!title) {
      return yield* Effect.fail(new Validation({ message: "The published form is missing a completed submissionTitle field." }));
    }
    if (!abstract) {
      return yield* Effect.fail(new Validation({ message: "The published CFP is missing a completed submissionAbstract field." }));
    }
    if (!speakerName) {
      return yield* Effect.fail(new Validation({ message: "The published form is missing a completed speakerName field." }));
    }

    const routedCategories = new Set<string>();
    for (const { field, value } of validated) {
      const selected = Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
      for (const option of selected) {
        const category = field.routing[option]?.trim();
        if (category) routedCategories.add(category);
      }
    }
    if (routedCategories.size > 1) {
      return yield* Effect.fail(new Validation({ message: "The submitted answers route to conflicting categories." }));
    }
    if (routedCategories.size !== 1) {
      return yield* Effect.fail(new Validation({ message: "The submitted answers do not resolve to a review category." }));
    }
    return {
      answers: validated,
      title,
      speakerName,
      speakerEmail,
      category: routedCategories.values().next().value ?? null,
    };
  });

const replayOutput = (value: unknown): Effect.Effect<typeof CreatePublicSubmissionOutput.Type, External> =>
  Schema.decodeUnknown(CreatePublicSubmissionOutput)(value).pipe(
    Effect.mapError((error) =>
      new External({ service: "database", detail: `Invalid stored submit.create response: ${String(error)}` })),
  );

const loadReplay = (
  eventId: string,
  operationId: "submit.create" | "submit.createTask",
  principalId: string,
  keyHash: string,
  requestHash: string,
): Effect.Effect<typeof CreatePublicSubmissionOutput.Type | null, AppError, Db> =>
  Effect.gen(function* () {
    const { db } = yield* Db;
    const [record] = yield* database(() =>
      db
        .select()
        .from(idempotencyRecords)
        .where(
          and(
            eq(idempotencyRecords.eventId, eventId),
            eq(idempotencyRecords.operationId, operationId),
            eq(idempotencyRecords.principalId, principalId),
            eq(idempotencyRecords.keyHash, keyHash),
          ),
        )
        .limit(1),
    );
    if (!record) return null;
    if (record.requestHash !== requestHash) {
      return yield* Effect.fail(new Conflict({ message: "Idempotency key was already used with different submission answers." }));
    }
    if (record.status !== "completed" || record.responseBody === null) {
      return yield* Effect.fail(new Conflict({ message: "Submission creation with this idempotency key is still in progress." }));
    }
    return yield* replayOutput(record.responseBody);
  });

/** Focused-test synchronization only; transports never provide command hooks. */
export interface SubmitCommandTestHooks {
  readonly beforeCommit?: () => Promise<void>;
}

export const createPublicSubmission = (
  input: CreatePublicSubmissionInput,
  testHooks?: SubmitCommandTestHooks,
): Effect.Effect<typeof CreatePublicSubmissionOutput.Type, AppError, Db | Rooms | PublicSubmissionAbuse | PublicSubmissionRequest> =>
  Effect.gen(function* () {
    const loaded = yield* loadPublishedForm({ kind: "slug", value: input.eventSlug }, input.formId);
    if (loaded.formKind !== "cfp") {
      return yield* Effect.fail(new Validation({
        message: "Public submissions are only available for CFP forms.",
      }));
    }
    const [keyHash, requestHash] = yield* Effect.all([
      sha256(input.idempotencyKey),
      sha256(stableStringify({
        answers: input.answers,
        primarySpeakerTitle: input.primarySpeakerTitle ?? null,
        primarySpeakerOrganization: input.primarySpeakerOrganization ?? null,
        coSpeakers: input.coSpeakers ?? [],
      })),
    ]);
    const replay = yield* loadReplay(
      loaded.eventId,
      "submit.create",
      `public-form:${input.formId}`,
      keyHash,
      requestHash,
    );
    if (replay) return replay;
    const validated = yield* validateAnswers(loaded, input);
    const publicSpeakers = yield* normalizePublicSpeakers(input, validated.speakerEmail);
    const abuse = yield* PublicSubmissionAbuse;
    const request = yield* PublicSubmissionRequest;
    yield* abuse.authorize({
      eventId: loaded.eventId,
      formId: input.formId,
      normalizedEmail: validated.speakerEmail === null ? null : normalizePublicEmail(validated.speakerEmail),
      turnstileToken: input.turnstileToken,
      remoteIp: request.remoteIp,
    });
    const { db } = yield* Db;
    const now = new Date();
    const submissionId = nanoid();
    const speakerId = nanoid();
    const coSpeakerIds = publicSpeakers.coSpeakers.map(() => nanoid());
    const idempotencyId = nanoid();
    const requestId = nanoid();
    const output = {
      submissionId,
      status: "submitted" as const,
      submittedAt: now.getTime(),
    };
    const versionId = loaded.publicForm.form.versionId;
    const nowMs = now.getTime();
    const commitNowMs = sql<Date>`CAST(unixepoch('subsec') * 1000 AS INTEGER)`;
    /**
     * The reservation re-evaluates published availability inside the commit, so a
     * concurrent close or retirement between the read and the write yields zero rows.
     */
    const reserveSubmission = db.insert(submissions).select(
      db
        .select({
          id: sql<string>`${submissionId}`.as("id"),
          eventId: forms.eventId,
          formId: forms.id,
          formVersionId: formVersions.id,
          title: sql<string>`${validated.title}`.as("title"),
          category: validated.category === null
            ? sql<string | null>`null`.as("category")
            : sql<string | null>`${validated.category}`.as("category"),
          status: sql<"submitted">`'submitted'`.as("status"),
          submittedAt: sql<Date>`${nowMs}`.as("submitted_at"),
          acceptedAt: sql<Date | null>`null`.as("accepted_at"),
          version: sql<number>`1`.as("version"),
          createdAt: sql<Date>`${nowMs}`.as("created_at"),
          updatedAt: sql<Date>`${nowMs}`.as("updated_at"),
        })
        .from(forms)
        .innerJoin(
          formVersions,
          and(
            eq(formVersions.eventId, forms.eventId),
            eq(formVersions.formId, forms.id),
            eq(formVersions.id, versionId),
            isNull(formVersions.retiredAt),
          ),
        )
        .where(and(
          eq(forms.eventId, loaded.eventId),
          eq(forms.id, input.formId),
          eq(forms.status, "open"),
          or(isNull(forms.opensAt), lte(forms.opensAt, commitNowMs)),
          or(isNull(forms.closesAt), gt(forms.closesAt, commitNowMs)),
        )),
    );
    /** Every dependent write selects the reserved row, so an unavailable form writes nothing. */
    const statements = [
      reserveSubmission,
      db.insert(speakers).select(
        db
          .select({
            id: sql<string>`${speakerId}`.as("id"),
            eventId: submissions.eventId,
            userId: sql<string | null>`null`.as("user_id"),
            contactEmail: validated.speakerEmail === null
              ? sql<string | null>`null`.as("contact_email")
              : sql<string | null>`${normalizePublicEmail(validated.speakerEmail)}`.as("contact_email"),
            displayName: sql<string>`${validated.speakerName}`.as("display_name"),
            title: publicSpeakers.primary.title === null
              ? sql<string | null>`null`.as("title")
              : sql<string | null>`${publicSpeakers.primary.title}`.as("title"),
            company: publicSpeakers.primary.organization === null
              ? sql<string | null>`null`.as("company")
              : sql<string | null>`${publicSpeakers.primary.organization}`.as("company"),
            bio: sql<string | null>`null`.as("bio"),
            headshotAssetId: sql<string | null>`null`.as("headshot_asset_id"),
            links: sql<unknown>`null`.as("links"),
            visible: sql<boolean>`1`.as("visible"),
            version: sql<number>`1`.as("version"),
            createdAt: sql<Date>`${nowMs}`.as("created_at"),
            updatedAt: sql<Date>`${nowMs}`.as("updated_at"),
          })
          .from(submissions)
          .where(and(eq(submissions.eventId, loaded.eventId), eq(submissions.id, submissionId))),
      ),
      db.insert(submissionSpeakers).select(
        db
          .select({
            id: sql<string>`${nanoid()}`.as("id"),
            eventId: submissions.eventId,
            submissionId: submissions.id,
            speakerId: sql<string>`${speakerId}`.as("speaker_id"),
            isPrimary: sql<boolean>`1`.as("is_primary"),
            titleAtTime: publicSpeakers.primary.title === null
              ? sql<string | null>`null`.as("title_at_time")
              : sql<string | null>`${publicSpeakers.primary.title}`.as("title_at_time"),
            organizationAtTime: publicSpeakers.primary.organization === null
              ? sql<string | null>`null`.as("organization_at_time")
              : sql<string | null>`${publicSpeakers.primary.organization}`.as("organization_at_time"),
            createdAt: sql<Date>`${nowMs}`.as("created_at"),
          })
          .from(submissions)
          .where(and(eq(submissions.eventId, loaded.eventId), eq(submissions.id, submissionId))),
      ),
      ...publicSpeakers.coSpeakers.flatMap((speaker, index) => {
        const coSpeakerId = coSpeakerIds[index]!;
        return [
          db.insert(speakers).select(
            db
              .select({
                id: sql<string>`${coSpeakerId}`.as("id"),
                eventId: submissions.eventId,
                userId: sql<string | null>`null`.as("user_id"),
                contactEmail: speaker.email === null
                  ? sql<string | null>`null`.as("contact_email")
                  : sql<string | null>`${speaker.email}`.as("contact_email"),
                displayName: sql<string>`${speaker.name}`.as("display_name"),
                title: speaker.title === null
                  ? sql<string | null>`null`.as("title")
                  : sql<string | null>`${speaker.title}`.as("title"),
                company: speaker.organization === null
                  ? sql<string | null>`null`.as("company")
                  : sql<string | null>`${speaker.organization}`.as("company"),
                bio: sql<string | null>`null`.as("bio"),
                headshotAssetId: sql<string | null>`null`.as("headshot_asset_id"),
                links: sql<unknown>`null`.as("links"),
                visible: sql<boolean>`1`.as("visible"),
                version: sql<number>`1`.as("version"),
                createdAt: sql<Date>`${nowMs}`.as("created_at"),
                updatedAt: sql<Date>`${nowMs}`.as("updated_at"),
              })
              .from(submissions)
              .where(and(eq(submissions.eventId, loaded.eventId), eq(submissions.id, submissionId))),
          ),
          db.insert(submissionSpeakers).select(
            db
              .select({
                id: sql<string>`${nanoid()}`.as("id"),
                eventId: submissions.eventId,
                submissionId: submissions.id,
                speakerId: sql<string>`${coSpeakerId}`.as("speaker_id"),
                isPrimary: sql<boolean>`0`.as("is_primary"),
                titleAtTime: speaker.title === null
                  ? sql<string | null>`null`.as("title_at_time")
                  : sql<string | null>`${speaker.title}`.as("title_at_time"),
                organizationAtTime: speaker.organization === null
                  ? sql<string | null>`null`.as("organization_at_time")
                  : sql<string | null>`${speaker.organization}`.as("organization_at_time"),
                createdAt: sql<Date>`${nowMs}`.as("created_at"),
              })
              .from(submissions)
              .where(and(eq(submissions.eventId, loaded.eventId), eq(submissions.id, submissionId))),
          ),
        ];
      }),
      ...validated.answers.map(({ field, value }) =>
        db.insert(submissionAnswers).select(
          db
            .select({
              id: sql<string>`${nanoid()}`.as("id"),
              eventId: submissions.eventId,
              submissionId: submissions.id,
              formVersionId: submissions.formVersionId,
              formVersionFieldId: sql<string>`${field.id}`.as("form_version_field_id"),
              value: sql<AnswerValue>`${JSON.stringify(value)}`.as("value"),
              version: sql<number>`1`.as("version"),
              createdAt: sql<Date>`${nowMs}`.as("created_at"),
              updatedAt: sql<Date>`${nowMs}`.as("updated_at"),
            })
            .from(submissions)
            .where(and(eq(submissions.eventId, loaded.eventId), eq(submissions.id, submissionId))),
        )),
      db.insert(idempotencyRecords).select(
        db
          .select({
            id: sql<string>`${idempotencyId}`.as("id"),
            eventId: submissions.eventId,
            operationId: sql<string>`'submit.create'`.as("operation_id"),
            principalId: sql<string>`${`public-form:${input.formId}`}`.as("principal_id"),
            keyHash: sql<string>`${keyHash}`.as("key_hash"),
            requestHash: sql<string>`${requestHash}`.as("request_hash"),
            status: sql<"completed">`'completed'`.as("status"),
            responseStatus: sql<number>`201`.as("response_status"),
            responseBody: sql<unknown>`${JSON.stringify(output)}`.as("response_body"),
            expiresAt: sql<Date>`${nowMs + COMMAND_TTL_MS}`.as("expires_at"),
            completedAt: sql<Date>`${nowMs}`.as("completed_at"),
            createdAt: sql<Date>`${nowMs}`.as("created_at"),
          })
          .from(submissions)
          .where(and(eq(submissions.eventId, loaded.eventId), eq(submissions.id, submissionId))),
      ),
      db.insert(domainChanges).select(
        db
          .select({
            sequence: sql<number | null>`null`.as("sequence"),
            id: sql<string>`${nanoid()}`.as("id"),
            eventId: submissions.eventId,
            aggregateType: sql<string>`'submission'`.as("aggregate_type"),
            aggregateId: submissions.id,
            aggregateVersion: submissions.version,
            eventType: sql<string>`'submit.created'`.as("event_type"),
            audiences: sql<unknown>`${JSON.stringify([{ kind: "admins" }, { kind: "reviewers" }])}`.as("audiences"),
            payload: sql<unknown>`${JSON.stringify({
              submissionId,
              title: validated.title,
              category: validated.category,
              status: "submitted",
            })}`.as("payload"),
            actorUserId: sql<string | null>`null`.as("actor_user_id"),
            actorApiKeyId: sql<string | null>`null`.as("actor_api_key_id"),
            requestId: sql<string>`${requestId}`.as("request_id"),
            idempotencyRecordId: sql<string>`${idempotencyId}`.as("idempotency_record_id"),
            occurredAt: sql<Date>`${nowMs}`.as("occurred_at"),
          })
          .from(submissions)
          .where(and(eq(submissions.eventId, loaded.eventId), eq(submissions.id, submissionId))),
      ),
      db.insert(auditLog).select(
        db
          .select({
            id: sql<string>`${nanoid()}`.as("id"),
            eventId: submissions.eventId,
            requestId: sql<string>`${requestId}`.as("request_id"),
            actorUserId: sql<string | null>`null`.as("actor_user_id"),
            actorApiKeyId: sql<string | null>`null`.as("actor_api_key_id"),
            action: sql<string>`'submit.create'`.as("action"),
            resourceType: sql<string>`'submission'`.as("resource_type"),
            resourceId: submissions.id,
            before: sql<unknown>`null`.as("before"),
            after: sql<unknown>`${JSON.stringify(output)}`.as("after"),
            metadata: sql<unknown>`${JSON.stringify({
              formId: input.formId,
              formVersionId: versionId,
              answerCount: validated.answers.length,
            })}`.as("metadata"),
            occurredAt: sql<Date>`${nowMs}`.as("occurred_at"),
          })
          .from(submissions)
          .where(and(eq(submissions.eventId, loaded.eventId), eq(submissions.id, submissionId))),
      ),
    ];

    if (testHooks?.beforeCommit) {
      yield* Effect.promise(testHooks.beforeCommit);
    }

    const committed = yield* database(() => db.batch(statements as never)).pipe(
      Effect.as(true),
      Effect.catchIf(
        (error): error is External =>
          error.detail?.includes("idempotency_key_unique") === true
          || error.detail?.includes("UNIQUE constraint failed: idempotency_records.event_id") === true,
        () => Effect.succeed(false),
      ),
    );
    if (!committed) {
      const concurrentReplay = yield* loadReplay(
        loaded.eventId,
        "submit.create",
        `public-form:${input.formId}`,
        keyHash,
        requestHash,
      );
      if (concurrentReplay) return concurrentReplay;
      return yield* Effect.fail(new External({ service: "database", detail: "Idempotent submission replay was not found" }));
    }
    const [reserved] = yield* database(() =>
      db
        .select({ id: submissions.id })
        .from(submissions)
        .where(and(eq(submissions.eventId, loaded.eventId), eq(submissions.id, submissionId)))
        .limit(1),
    );
    if (!reserved) {
      return yield* Effect.fail(new Validation({ message: "This form is not accepting submissions." }));
    }
    const rooms = yield* Rooms;
    yield* rooms.broadcast(loaded.eventId, {
      t: "submissions/new",
      submissionId,
      title: validated.title,
    }).pipe(Effect.catchAll(() => Effect.void));
    return output;
  });

const loadProvisionedSpeaker = (eventId: string) =>
  Effect.gen(function* () {
    const principal = yield* CurrentUser;
    if (principal.kind !== "browser-session") {
      return yield* Effect.fail(new Forbidden({ reason: "Speaker task forms require a browser session" }));
    }
    const { db } = yield* Db;
    const [speaker] = yield* database(() =>
      db
        .select()
        .from(speakers)
        .where(and(eq(speakers.eventId, eventId), eq(speakers.userId, principal.userId)))
        .limit(1),
    );
    if (!speaker) {
      return yield* Effect.fail(new Forbidden({
        reason: "This browser session is not linked to a speaker for this event",
      }));
    }
    const [candidates, history] = yield* Effect.all([
      database(() =>
        db
          .select({ acceptance: acceptanceEvents, provisioning: speakerProvisioning })
          .from(acceptanceEvents)
          .innerJoin(
            speakerProvisioning,
            and(
              eq(speakerProvisioning.eventId, acceptanceEvents.eventId),
              eq(speakerProvisioning.acceptanceEventId, acceptanceEvents.id),
              eq(speakerProvisioning.status, "provisioned"),
            ),
          )
          .where(and(
            eq(acceptanceEvents.eventId, eventId),
            eq(acceptanceEvents.primarySpeakerId, speaker.id),
            eq(acceptanceEvents.type, "accepted"),
          ))
          .orderBy(desc(acceptanceEvents.occurredAt), desc(acceptanceEvents.id))),
      database(() =>
        db
          .select({
            id: acceptanceEvents.id,
            submissionId: acceptanceEvents.submissionId,
            type: acceptanceEvents.type,
          })
          .from(acceptanceEvents)
          .where(and(
            eq(acceptanceEvents.eventId, eventId),
            eq(acceptanceEvents.primarySpeakerId, speaker.id),
          ))
          .orderBy(desc(acceptanceEvents.occurredAt), desc(acceptanceEvents.id))),
    ], { concurrency: 1 });
    const latestBySubmission = new Map<string, (typeof history)[number]>();
    for (const acceptance of history) {
      if (!latestBySubmission.has(acceptance.submissionId)) {
        latestBySubmission.set(acceptance.submissionId, acceptance);
      }
    }
    const current = candidates.find((candidate) =>
      latestBySubmission.get(candidate.acceptance.submissionId)?.id === candidate.acceptance.id
    );
    if (!current) {
      return yield* Effect.fail(new Forbidden({
        reason: "A current accepted and provisioned speaker record is required",
      }));
    }
    return { principal, speaker, acceptance: current.acceptance, provisioning: current.provisioning };
  });

export const createTaskSubmission = (
  input: CreateTaskSubmissionInput,
  testHooks?: SubmitCommandTestHooks,
): Effect.Effect<typeof CreatePublicSubmissionOutput.Type, AppError, CurrentUser | Db | Rooms> =>
  Effect.gen(function* () {
    const actor = yield* loadProvisionedSpeaker(input.eventId);
    const loaded = yield* loadPublishedForm({ kind: "id", value: input.eventId }, input.formId);
    if (loaded.formKind !== "task") {
      return yield* Effect.fail(new Validation({
        message: "Speaker task submissions are only available for task forms.",
      }));
    }
    const principalId = `speaker:${actor.speaker.id}:form:${input.formId}`;
    const [keyHash, requestHash] = yield* Effect.all([
      sha256(input.idempotencyKey),
      sha256(stableStringify(input.answers)),
    ]);
    const replay = yield* loadReplay(
      loaded.eventId,
      "submit.createTask",
      principalId,
      keyHash,
      requestHash,
    );
    if (replay) return replay;
    const validated = yield* validateAnswers(loaded, input);
    const { db } = yield* Db;
    const now = new Date();
    const submissionId = nanoid();
    const idempotencyId = nanoid();
    const requestId = nanoid();
    const output = {
      submissionId,
      status: "submitted" as const,
      submittedAt: now.getTime(),
    };
    const versionId = loaded.publicForm.form.versionId;
    const nowMs = now.getTime();
    const commitNowMs = sql<Date>`CAST(unixepoch('subsec') * 1000 AS INTEGER)`;
    /** Re-check immutable publication, availability, speaker identity, and provisioning inside the atomic batch. */
    const reserveSubmission = db.insert(submissions).select(
      db
        .select({
          id: sql<string>`${submissionId}`.as("id"),
          eventId: forms.eventId,
          formId: forms.id,
          formVersionId: formVersions.id,
          title: sql<string>`${validated.title}`.as("title"),
          category: sql<string | null>`null`.as("category"),
          status: sql<"submitted">`'submitted'`.as("status"),
          submittedAt: sql<Date>`${nowMs}`.as("submitted_at"),
          acceptedAt: sql<Date | null>`null`.as("accepted_at"),
          version: sql<number>`1`.as("version"),
          createdAt: sql<Date>`${nowMs}`.as("created_at"),
          updatedAt: sql<Date>`${nowMs}`.as("updated_at"),
        })
        .from(forms)
        .innerJoin(
          formVersions,
          and(
            eq(formVersions.eventId, forms.eventId),
            eq(formVersions.formId, forms.id),
            eq(formVersions.id, versionId),
            isNull(formVersions.retiredAt),
          ),
        )
        .innerJoin(
          speakers,
          and(
            eq(speakers.eventId, forms.eventId),
            eq(speakers.id, actor.speaker.id),
            eq(speakers.userId, actor.principal.userId),
          ),
        )
        .innerJoin(
          acceptanceEvents,
          and(
            eq(acceptanceEvents.eventId, speakers.eventId),
            eq(acceptanceEvents.id, actor.acceptance.id),
            eq(acceptanceEvents.primarySpeakerId, speakers.id),
            eq(acceptanceEvents.type, "accepted"),
          ),
        )
        .innerJoin(
          speakerProvisioning,
          and(
            eq(speakerProvisioning.eventId, acceptanceEvents.eventId),
            eq(speakerProvisioning.id, actor.provisioning.id),
            eq(speakerProvisioning.acceptanceEventId, acceptanceEvents.id),
            eq(speakerProvisioning.status, "provisioned"),
          ),
        )
        .where(and(
          eq(forms.eventId, loaded.eventId),
          eq(forms.id, input.formId),
          eq(forms.kind, "task"),
          eq(forms.status, "open"),
          or(isNull(forms.opensAt), lte(forms.opensAt, commitNowMs)),
          or(isNull(forms.closesAt), gt(forms.closesAt, commitNowMs)),
          sql`not exists (
            select 1
            from acceptance_events as newer_acceptance
            where newer_acceptance.event_id = ${acceptanceEvents.eventId}
              and newer_acceptance.submission_id = ${acceptanceEvents.submissionId}
              and (
                newer_acceptance.occurred_at > ${acceptanceEvents.occurredAt}
                or (
                  newer_acceptance.occurred_at = ${acceptanceEvents.occurredAt}
                  and newer_acceptance.id > ${acceptanceEvents.id}
                )
              )
          )`,
        )),
    );
    /** All evidence selects from the reserved row, so a failed reservation leaves no partial writes. */
    const statements = [
      reserveSubmission,
      db.insert(submissionSpeakers).select(
        db
          .select({
            id: sql<string>`${nanoid()}`.as("id"),
            eventId: submissions.eventId,
            submissionId: submissions.id,
            speakerId: sql<string>`${actor.speaker.id}`.as("speaker_id"),
            isPrimary: sql<boolean>`1`.as("is_primary"),
            titleAtTime: sql<string | null>`${actor.speaker.title}`.as("title_at_time"),
            organizationAtTime: sql<string | null>`${actor.speaker.company}`.as("organization_at_time"),
            createdAt: sql<Date>`${nowMs}`.as("created_at"),
          })
          .from(submissions)
          .where(and(eq(submissions.eventId, loaded.eventId), eq(submissions.id, submissionId))),
      ),
      ...validated.answers.map(({ field, value }) =>
        db.insert(submissionAnswers).select(
          db
            .select({
              id: sql<string>`${nanoid()}`.as("id"),
              eventId: submissions.eventId,
              submissionId: submissions.id,
              formVersionId: submissions.formVersionId,
              formVersionFieldId: sql<string>`${field.id}`.as("form_version_field_id"),
              value: sql<AnswerValue>`${JSON.stringify(value)}`.as("value"),
              version: sql<number>`1`.as("version"),
              createdAt: sql<Date>`${nowMs}`.as("created_at"),
              updatedAt: sql<Date>`${nowMs}`.as("updated_at"),
            })
            .from(submissions)
            .where(and(eq(submissions.eventId, loaded.eventId), eq(submissions.id, submissionId))),
        )),
      db.insert(idempotencyRecords).select(
        db
          .select({
            id: sql<string>`${idempotencyId}`.as("id"),
            eventId: submissions.eventId,
            operationId: sql<string>`'submit.createTask'`.as("operation_id"),
            principalId: sql<string>`${principalId}`.as("principal_id"),
            keyHash: sql<string>`${keyHash}`.as("key_hash"),
            requestHash: sql<string>`${requestHash}`.as("request_hash"),
            status: sql<"completed">`'completed'`.as("status"),
            responseStatus: sql<number>`201`.as("response_status"),
            responseBody: sql<unknown>`${JSON.stringify(output)}`.as("response_body"),
            expiresAt: sql<Date>`${nowMs + COMMAND_TTL_MS}`.as("expires_at"),
            completedAt: sql<Date>`${nowMs}`.as("completed_at"),
            createdAt: sql<Date>`${nowMs}`.as("created_at"),
          })
          .from(submissions)
          .where(and(eq(submissions.eventId, loaded.eventId), eq(submissions.id, submissionId))),
      ),
      db.insert(domainChanges).select(
        db
          .select({
            sequence: sql<number | null>`null`.as("sequence"),
            id: sql<string>`${nanoid()}`.as("id"),
            eventId: submissions.eventId,
            aggregateType: sql<string>`'submission'`.as("aggregate_type"),
            aggregateId: submissions.id,
            aggregateVersion: submissions.version,
            eventType: sql<string>`'submit.created'`.as("event_type"),
            audiences: sql<unknown>`${JSON.stringify([
              { kind: "admins" },
              { kind: "speaker", speakerIds: [actor.speaker.id] },
            ])}`.as("audiences"),
            payload: sql<unknown>`${JSON.stringify({
              submissionId,
              formId: input.formId,
              title: validated.title,
              category: null,
              status: "submitted",
              speakerId: actor.speaker.id,
            })}`.as("payload"),
            actorUserId: sql<string | null>`${actor.principal.userId}`.as("actor_user_id"),
            actorApiKeyId: sql<string | null>`null`.as("actor_api_key_id"),
            requestId: sql<string>`${requestId}`.as("request_id"),
            idempotencyRecordId: sql<string>`${idempotencyId}`.as("idempotency_record_id"),
            occurredAt: sql<Date>`${nowMs}`.as("occurred_at"),
          })
          .from(submissions)
          .where(and(eq(submissions.eventId, loaded.eventId), eq(submissions.id, submissionId))),
      ),
      db.insert(auditLog).select(
        db
          .select({
            id: sql<string>`${nanoid()}`.as("id"),
            eventId: submissions.eventId,
            requestId: sql<string>`${requestId}`.as("request_id"),
            actorUserId: sql<string | null>`${actor.principal.userId}`.as("actor_user_id"),
            actorApiKeyId: sql<string | null>`null`.as("actor_api_key_id"),
            action: sql<string>`'submit.createTask'`.as("action"),
            resourceType: sql<string>`'submission'`.as("resource_type"),
            resourceId: submissions.id,
            before: sql<unknown>`null`.as("before"),
            after: sql<unknown>`${JSON.stringify(output)}`.as("after"),
            metadata: sql<unknown>`${JSON.stringify({
              formId: input.formId,
              formVersionId: versionId,
              answerCount: validated.answers.length,
              speakerId: actor.speaker.id,
            })}`.as("metadata"),
            occurredAt: sql<Date>`${nowMs}`.as("occurred_at"),
          })
          .from(submissions)
          .where(and(eq(submissions.eventId, loaded.eventId), eq(submissions.id, submissionId))),
      ),
    ];

    if (testHooks?.beforeCommit) yield* Effect.promise(testHooks.beforeCommit);
    const committed = yield* database(() => db.batch(statements as never)).pipe(
      Effect.as(true),
      Effect.catchIf(
        (error): error is External =>
          error.detail?.includes("idempotency_key_unique") === true
          || error.detail?.includes("UNIQUE constraint failed: idempotency_records.event_id") === true,
        () => Effect.succeed(false),
      ),
    );
    if (!committed) {
      const concurrentReplay = yield* loadReplay(
        loaded.eventId,
        "submit.createTask",
        principalId,
        keyHash,
        requestHash,
      );
      if (concurrentReplay) return concurrentReplay;
      return yield* Effect.fail(new External({
        service: "database",
        detail: "Idempotent task-form submission replay was not found",
      }));
    }
    const [reserved] = yield* database(() =>
      db
        .select({ id: submissions.id })
        .from(submissions)
        .where(and(eq(submissions.eventId, loaded.eventId), eq(submissions.id, submissionId)))
        .limit(1),
    );
    if (!reserved) {
      yield* loadProvisionedSpeaker(input.eventId);
      return yield* Effect.fail(new Validation({ message: "This form is not accepting submissions." }));
    }
    const rooms = yield* Rooms;
    yield* rooms.broadcast(loaded.eventId, {
      t: "submissions/new",
      submissionId,
      title: validated.title,
    }).pipe(Effect.catchAll(() => Effect.void));
    return output;
  });

type QueueViewer = {
  readonly role: "owner" | "admin" | "reviewer";
  readonly userId: string;
};

const authorizeQueueViewer = (
  eventId: string,
): Effect.Effect<QueueViewer, AppError, Authorizer | CurrentUser | Db> =>
  Effect.gen(function* () {
    const principal = yield* CurrentUser;
    const authorizer = yield* Authorizer;
    yield* authorizer.authorize({ principal, policy: organizerReadAuthorization, eventId });
    if (principal.kind === "api-key") return { role: "admin", userId: principal.userId };
    const { db } = yield* Db;
    const [membership] = yield* database(() =>
      db
        .select({ role: eventMembers.role })
        .from(eventMembers)
        .where(and(eq(eventMembers.eventId, eventId), eq(eventMembers.userId, principal.userId)))
        .limit(1),
    );
    if (!membership) {
      return yield* Effect.fail(new Forbidden({ reason: "Event membership required" }));
    }
    return { role: membership.role, userId: principal.userId };
  });

export const listSubmissions = (
  input: ListSubmissionsInput,
): Effect.Effect<SubmissionPage, AppError, Authorizer | CurrentUser | Db> =>
  Effect.gen(function* () {
    const viewer = yield* authorizeQueueViewer(input.eventId);
    const { db } = yield* Db;
    const accessFilters = [eq(submissions.eventId, input.eventId)];
    if (viewer.role === "reviewer") {
      accessFilters.push(exists(
        db
          .select({ id: reviewAssignments.id })
          .from(reviewAssignments)
          .where(and(
            eq(reviewAssignments.eventId, input.eventId),
            eq(reviewAssignments.reviewerUserId, viewer.userId),
            eq(reviewAssignments.submissionId, submissions.id),
          )),
      ));
    }
    const filters = [...accessFilters];
    if (input.status) filters.push(eq(submissions.status, input.status));
    if (input.formId) filters.push(eq(submissions.formId, input.formId));
    if (input.category) filters.push(eq(submissions.category, input.category));
    const where = and(...filters);
    const [rows, totals, categoryRows] = yield* Effect.all([
      database(() =>
        db
          .select({
            id: submissions.id,
            formId: submissions.formId,
            formName: formVersions.name,
            title: submissions.title,
            category: submissions.category,
            status: submissions.status,
            primarySpeakerName: speakers.displayName,
            submittedAt: submissions.submittedAt,
            version: submissions.version,
          })
          .from(submissions)
          .innerJoin(
            formVersions,
            and(
              eq(formVersions.eventId, submissions.eventId),
              eq(formVersions.formId, submissions.formId),
              eq(formVersions.id, submissions.formVersionId),
            ),
          )
          .leftJoin(
            submissionSpeakers,
            and(
              eq(submissionSpeakers.eventId, submissions.eventId),
              eq(submissionSpeakers.submissionId, submissions.id),
              eq(submissionSpeakers.isPrimary, true),
            ),
          )
          .leftJoin(
            speakers,
            and(
              eq(speakers.eventId, submissionSpeakers.eventId),
              eq(speakers.id, submissionSpeakers.speakerId),
            ),
          )
          .where(where)
          .orderBy(desc(submissions.submittedAt), desc(submissions.id))
          .limit(input.pageSize)
          .offset((input.page - 1) * input.pageSize),
      ),
      database(() => db.select({ total: count() }).from(submissions).where(where)),
      database(() =>
        db
          .selectDistinct({ category: submissions.category })
          .from(submissions)
          .where(and(...accessFilters, isNotNull(submissions.category)))
          .orderBy(asc(submissions.category)),
      ),
    ]);
    const total = totals[0]?.total ?? 0;
    return {
      results: rows.map((row) => ({
        ...row,
        submittedAt: row.submittedAt.getTime(),
      })),
      categories: categoryRows.flatMap(({ category }) => category === null ? [] : [category]),
      pagination: {
        page: input.page,
        pageSize: input.pageSize,
        total,
        pageCount: total === 0 ? 0 : Math.ceil(total / input.pageSize),
      },
    };
  });

type OwnSubmissionRow = {
  readonly id: string;
  readonly formId: string;
  readonly formName: string;
  readonly title: string;
  readonly category: string | null;
  readonly status: typeof submissions.$inferSelect.status;
  readonly submittedAt: Date;
  readonly version: number;
  readonly formStatus: typeof forms.$inferSelect.status;
  readonly opensAt: Date | null;
  readonly closesAt: Date | null;
  readonly primarySpeakerId: string | null;
  readonly primarySpeakerUserId: string | null;
};

type OwnAnswerRow = {
  readonly id: string;
  readonly submissionId: string;
  readonly semanticKey: typeof formVersionFields.$inferSelect.semanticKey;
  readonly value: unknown;
  readonly version: number;
};

const requireSubmissionOwner = (): Effect.Effect<{
  readonly userId: string;
  readonly email: string;
}, AppError, CurrentUser> =>
  Effect.gen(function* () {
    const principal = yield* CurrentUser;
    if (principal.kind !== "browser-session") {
      return yield* Effect.fail(new Forbidden({ reason: "Submission management requires a browser session" }));
    }
    const email = normalizePublicEmail(principal.email);
    if (email.length === 0) {
      return yield* Effect.fail(new Forbidden({ reason: "The signed-in account has no email" }));
    }
    return { userId: principal.userId, email };
  });

const ownSubmissionRows = (
  eventId: string,
  owner: { readonly userId: string; readonly email: string },
): Effect.Effect<{
  readonly submissions: readonly OwnSubmissionRow[];
  readonly answers: readonly OwnAnswerRow[];
}, AppError, Db> =>
  Effect.gen(function* () {
    const { db } = yield* Db;
    const rows = yield* database(() =>
      db
        .select({
          id: submissions.id,
          formId: submissions.formId,
          formName: formVersions.name,
          title: submissions.title,
          category: submissions.category,
          status: submissions.status,
          submittedAt: submissions.submittedAt,
          version: submissions.version,
          formStatus: forms.status,
          opensAt: forms.opensAt,
          closesAt: forms.closesAt,
          primarySpeakerId: speakers.id,
          primarySpeakerUserId: speakers.userId,
        })
        .from(submissions)
        .innerJoin(forms, and(eq(forms.eventId, submissions.eventId), eq(forms.id, submissions.formId)))
        .innerJoin(
          formVersions,
          and(
            eq(formVersions.eventId, submissions.eventId),
            eq(formVersions.id, submissions.formVersionId),
          ),
        )
        .leftJoin(
          submissionSpeakers,
          and(
            eq(submissionSpeakers.eventId, submissions.eventId),
            eq(submissionSpeakers.submissionId, submissions.id),
            eq(submissionSpeakers.isPrimary, true),
          ),
        )
        .leftJoin(
          speakers,
          and(eq(speakers.eventId, submissionSpeakers.eventId), eq(speakers.id, submissionSpeakers.speakerId)),
        )
        .where(and(eq(submissions.eventId, eventId), eq(forms.kind, "cfp")))
        .orderBy(desc(submissions.submittedAt), desc(submissions.id)),
    );
    const submissionIds = rows.map((row) => row.id);
    if (submissionIds.length === 0) return { submissions: [], answers: [] };
    const answers = yield* database(() =>
      db
        .select({
          id: submissionAnswers.id,
          submissionId: submissionAnswers.submissionId,
          semanticKey: formVersionFields.semanticKey,
          value: submissionAnswers.value,
          version: submissionAnswers.version,
        })
        .from(submissionAnswers)
        .innerJoin(
          formVersionFields,
          and(
            eq(formVersionFields.eventId, submissionAnswers.eventId),
            eq(formVersionFields.formVersionId, submissionAnswers.formVersionId),
            eq(formVersionFields.id, submissionAnswers.formVersionFieldId),
          ),
        )
        .where(
          and(
            eq(submissionAnswers.eventId, eventId),
            inArray(submissionAnswers.submissionId, submissionIds),
            inArray(formVersionFields.semanticKey, ["speakerEmail", "submissionAbstract"]),
          ),
        ),
    );
    const answerBySubmission = new Map<string, OwnAnswerRow[]>();
    for (const answer of answers) {
      answerBySubmission.set(answer.submissionId, [...(answerBySubmission.get(answer.submissionId) ?? []), answer]);
    }
    return {
      submissions: rows.filter((row) => {
        if (row.primarySpeakerUserId === owner.userId) return true;
        const email = answerBySubmission.get(row.id)?.find((answer) => answer.semanticKey === "speakerEmail")?.value;
        return typeof email === "string" && normalizePublicEmail(email) === owner.email;
      }),
      answers,
    };
  });

const ownSummary = (
  row: OwnSubmissionRow,
  answers: readonly OwnAnswerRow[],
  at: number,
): OwnSubmissionSummary => {
  const abstract = answers.find(
    (answer) => answer.submissionId === row.id && answer.semanticKey === "submissionAbstract" && typeof answer.value === "string",
  )?.value;
  return {
    id: row.id,
    formId: row.formId,
    formName: row.formName,
    title: row.title,
    abstract: typeof abstract === "string" ? abstract : "",
    category: row.category,
    status: row.status,
    submittedAt: row.submittedAt.getTime(),
    version: row.version,
    editable: availability(row.formStatus, row.opensAt, row.closesAt, at) === "open"
      && row.status !== "accepted"
      && row.status !== "rejected"
      && row.status !== "withdrawn",
  };
};

export const getOwnSubmissions = (
  input: GetOwnSubmissionsInput,
): Effect.Effect<OwnSubmissions, AppError, CurrentUser | Db> =>
  Effect.gen(function* () {
    const owner = yield* requireSubmissionOwner();
    const { db } = yield* Db;
    const [event] = yield* database(() =>
      db.select({ id: events.id, name: events.name, slug: events.slug }).from(events).where(eq(events.slug, input.eventSlug)).limit(1),
    );
    if (!event) return yield* Effect.fail(new NotFound({ entity: "event", id: input.eventSlug }));
    const owned = yield* ownSubmissionRows(event.id, owner);
    const at = Date.now();
    return {
      event: { name: event.name, slug: event.slug },
      submissions: owned.submissions.map((row) => ownSummary(row, owned.answers, at)),
    };
  });

const replayOwnUpdate = (value: unknown) =>
  Schema.decodeUnknown(UpdateOwnSubmissionAbstractOutput)(value).pipe(
    Effect.mapError((error) => new External({ service: "database", detail: `Invalid stored submit.updateOwnAbstract response: ${String(error)}` })),
  );

export const updateOwnSubmissionAbstract = (
  input: UpdateOwnSubmissionAbstractInput,
): Effect.Effect<typeof UpdateOwnSubmissionAbstractOutput.Type, AppError, CurrentUser | Db> =>
  Effect.gen(function* () {
    const owner = yield* requireSubmissionOwner();
    const { db } = yield* Db;
    const [event] = yield* database(() =>
      db.select({ id: events.id }).from(events).where(eq(events.slug, input.eventSlug)).limit(1),
    );
    if (!event) return yield* Effect.fail(new NotFound({ entity: "event", id: input.eventSlug }));
    const [keyHash, requestHash] = yield* Effect.all([
      sha256(input.idempotencyKey),
      sha256(stableStringify({ submissionId: input.submissionId, abstract: input.abstract, expectedVersion: input.expectedVersion })),
    ]);
    const principalId = owner.userId;
    const [replay] = yield* database(() =>
      db.select().from(idempotencyRecords).where(and(
        eq(idempotencyRecords.eventId, event.id),
        eq(idempotencyRecords.operationId, "submit.updateOwnAbstract"),
        eq(idempotencyRecords.principalId, principalId),
        eq(idempotencyRecords.keyHash, keyHash),
      )).limit(1),
    );
    if (replay) {
      if (replay.requestHash !== requestHash) {
        return yield* Effect.fail(new Conflict({ message: "Idempotency key was already used for a different proposal edit" }));
      }
      if (replay.status === "completed") {
        const output = yield* replayOwnUpdate(replay.responseBody);
        return { ...output, idempotent: true };
      }
      return yield* Effect.fail(new Conflict({ message: "Proposal edit with this idempotency key is already in progress" }));
    }

    const owned = yield* ownSubmissionRows(event.id, owner);
    const row = owned.submissions.find((candidate) => candidate.id === input.submissionId);
    if (!row) return yield* Effect.fail(new Forbidden({ reason: "This submission does not belong to the signed-in account" }));
    if (row.version !== input.expectedVersion) {
      return yield* Effect.fail(new Conflict({ message: "Submission changed; reload before saving" }));
    }
    if (!ownSummary(row, owned.answers, Date.now()).editable) {
      return yield* Effect.fail(new Conflict({ message: "This proposal can no longer be edited because the CFP is closed or a decision has been recorded" }));
    }
    const abstractAnswer = owned.answers.find(
      (answer) => answer.submissionId === row.id && answer.semanticKey === "submissionAbstract",
    );
    if (!abstractAnswer) {
      return yield* Effect.fail(new Validation({ message: "The immutable CFP version has no submissionAbstract field" }));
    }
    const abstract = input.abstract.trim();
    if (abstract.length === 0) return yield* Effect.fail(new Validation({ message: "Abstract is required" }));
    const savedAt = new Date();
    const nextVersion = row.version + 1;
    const idempotencyId = nanoid();
    const requestId = nanoid();
    const summary: OwnSubmissionSummary = {
      ...ownSummary({ ...row, version: nextVersion }, [
        ...owned.answers.filter((answer) => answer.id !== abstractAnswer.id),
        { ...abstractAnswer, value: abstract },
      ], savedAt.getTime()),
      editable: true,
    };
    const output = { submission: summary, idempotent: false } as const;
    const commitNowMs = sql<Date>`CAST(unixepoch('subsec') * 1000 AS INTEGER)`;
    const updatedAt = savedAt.getTime();

    const committed = yield* database(() => db.batch([
      db.update(submissions).set({ version: nextVersion, updatedAt: savedAt }).where(and(
        eq(submissions.eventId, event.id),
        eq(submissions.id, input.submissionId),
        eq(submissions.version, input.expectedVersion),
        inArray(submissions.status, ["submitted", "in_review", "waitlist"]),
        exists(db.select({ id: forms.id }).from(forms).where(and(
          eq(forms.eventId, submissions.eventId),
          eq(forms.id, submissions.formId),
          eq(forms.kind, "cfp"),
          eq(forms.status, "open"),
          or(isNull(forms.opensAt), lte(forms.opensAt, commitNowMs)),
          or(isNull(forms.closesAt), gt(forms.closesAt, commitNowMs)),
        ))),
      )),
      db.update(submissionAnswers).set({ value: abstract, version: abstractAnswer.version + 1, updatedAt: savedAt }).where(and(
        eq(submissionAnswers.id, abstractAnswer.id),
        eq(submissionAnswers.eventId, event.id),
        eq(submissionAnswers.version, abstractAnswer.version),
        sql`changes() > 0`,
      )),
      db.insert(idempotencyRecords).select(db.select({
        id: sql<string>`${idempotencyId}`.as("id"),
        eventId: submissions.eventId,
        operationId: sql<string>`'submit.updateOwnAbstract'`.as("operation_id"),
        principalId: sql<string>`${principalId}`.as("principal_id"),
        keyHash: sql<string>`${keyHash}`.as("key_hash"),
        requestHash: sql<string>`${requestHash}`.as("request_hash"),
        status: sql<"completed">`'completed'`.as("status"),
        responseStatus: sql<number>`200`.as("response_status"),
        responseBody: sql<unknown>`${JSON.stringify(output)}`.as("response_body"),
        expiresAt: sql<Date>`${updatedAt + COMMAND_TTL_MS}`.as("expires_at"),
        completedAt: sql<Date>`${updatedAt}`.as("completed_at"),
        createdAt: sql<Date>`${updatedAt}`.as("created_at"),
      }).from(submissions).where(and(
        eq(submissions.eventId, event.id), eq(submissions.id, input.submissionId), eq(submissions.version, nextVersion), sql`changes() > 0`,
      ))),
      db.insert(domainChanges).select(db.select({
        sequence: sql<number | null>`null`.as("sequence"),
        id: sql<string>`${nanoid()}`.as("id"), eventId: submissions.eventId,
        aggregateType: sql<string>`'submission'`.as("aggregate_type"), aggregateId: submissions.id,
        aggregateVersion: submissions.version, eventType: sql<string>`'submit.abstract.updated'`.as("event_type"),
        audiences: sql<unknown>`${JSON.stringify([
          { kind: "admins" },
          ...(row.primarySpeakerId ? [{ kind: "speaker", speakerIds: [row.primarySpeakerId] }] : []),
        ])}`.as("audiences"),
        payload: sql<unknown>`${JSON.stringify({ submissionId: input.submissionId, submissionVersion: nextVersion })}`.as("payload"),
        actorUserId: sql<string>`${owner.userId}`.as("actor_user_id"), actorApiKeyId: sql<string | null>`null`.as("actor_api_key_id"),
        requestId: sql<string>`${requestId}`.as("request_id"), idempotencyRecordId: sql<string>`${idempotencyId}`.as("idempotency_record_id"),
        occurredAt: sql<Date>`${updatedAt}`.as("occurred_at"),
      }).from(submissions).where(and(
        eq(submissions.eventId, event.id), eq(submissions.id, input.submissionId),
        exists(db.select({ id: idempotencyRecords.id }).from(idempotencyRecords).where(eq(idempotencyRecords.id, idempotencyId))),
      ))),
      db.insert(auditLog).select(db.select({
        id: sql<string>`${nanoid()}`.as("id"), eventId: submissions.eventId,
        requestId: sql<string>`${requestId}`.as("request_id"), actorUserId: sql<string>`${owner.userId}`.as("actor_user_id"),
        actorApiKeyId: sql<string | null>`null`.as("actor_api_key_id"), action: sql<string>`'submit.updateOwnAbstract'`.as("action"),
        resourceType: sql<string>`'submission'`.as("resource_type"), resourceId: submissions.id,
        before: sql<unknown>`${JSON.stringify({ abstract: abstractAnswer.value, version: row.version })}`.as("before"),
        after: sql<unknown>`${JSON.stringify({ abstract, version: nextVersion })}`.as("after"),
        metadata: sql<unknown>`null`.as("metadata"), occurredAt: sql<Date>`${updatedAt}`.as("occurred_at"),
      }).from(submissions).where(and(
        eq(submissions.eventId, event.id), eq(submissions.id, input.submissionId),
        exists(db.select({ id: idempotencyRecords.id }).from(idempotencyRecords).where(eq(idempotencyRecords.id, idempotencyId))),
      ))),
    ] as never)).pipe(
      Effect.as(true),
      Effect.catchIf(
        (error): error is External => error.detail?.includes("idempotency_key_unique") === true || error.detail?.includes("UNIQUE constraint failed: idempotency_records.event_id") === true,
        () => Effect.succeed(false),
      ),
    );
    const [ownCommit] = yield* database(() =>
      db.select({ id: idempotencyRecords.id }).from(idempotencyRecords).where(eq(idempotencyRecords.id, idempotencyId)).limit(1),
    );
    if (committed && ownCommit) return output;
    const [concurrent] = yield* database(() => db.select().from(idempotencyRecords).where(and(
      eq(idempotencyRecords.eventId, event.id), eq(idempotencyRecords.operationId, "submit.updateOwnAbstract"),
      eq(idempotencyRecords.principalId, principalId), eq(idempotencyRecords.keyHash, keyHash),
    )).limit(1));
    if (concurrent) {
      if (concurrent.requestHash !== requestHash) {
        return yield* Effect.fail(new Conflict({ message: "Idempotency key was already used for a different proposal edit" }));
      }
      if (concurrent.status === "completed") {
        const replayed = yield* replayOwnUpdate(concurrent.responseBody);
        return { ...replayed, idempotent: true };
      }
    }
    return yield* Effect.fail(new Conflict({ message: "Submission changed or the CFP closed; reload before saving" }));
  });
