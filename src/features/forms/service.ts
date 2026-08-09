import { Conflict, External, Forbidden, NotFound, Validation, type AppError } from "contracts/errors";
import type { Principal } from "contracts/principal";
import {
  auditLog,
  domainChanges,
  events,
  formFields,
  forms,
  formVersionFields,
  formVersions,
  idempotencyRecords,
  tasks,
} from "contracts/schema";
import { and, asc, desc, eq, isNull } from "drizzle-orm";
import { Effect, Schema } from "effect";
import { nanoid } from "nanoid";
import { Db } from "@/server/services";
// BaselineGreen compatibility seam: this is the only principal capability import.
import { CurrentUser } from "@/server/services";
import {
  ConditionalLogic,
  FormDetail,
  DeleteFormOutput,
  Routing,
  type CreateFormInput,
  type DeleteFormInput,
  type DeleteFormOutput as DeleteFormOutputType,
  type FormField,
  type FormFieldDraft,
  type FormFieldType,
  type FormSummary,
  type GetFormInput,
  type ListFormsInput,
  type PublishFormInput,
  type PublishedFormVersion,
  type SetFormStatusInput,
  type UpdateFormInput,
} from "./schema";

const COMMAND_TTL_MS = 24 * 60 * 60 * 1_000;
const OPTION_FIELD_TYPES: Partial<Record<FormFieldType, true>> = {
  select: true,
  multiselect: true,
  radio: true,
};
const ROUTING_FIELD_TYPES: Partial<Record<FormFieldType, true>> = {
  select: true,
  radio: true,
};

type DraftFieldRow = typeof formFields.$inferSelect;
type VersionFieldRow = typeof formVersionFields.$inferSelect;
type FormRow = typeof forms.$inferSelect;

type PreparedCommand = {
  readonly principal: Principal;
  readonly idempotencyId: string;
  readonly keyHash: string;
  readonly requestHash: string;
  readonly replay: FormDetail | null;
};

const database = <A>(run: () => Promise<A>): Effect.Effect<A, External | Conflict> =>
  Effect.tryPromise({
    try: run,
    catch: (error) => {
      const detail = error instanceof Error ? error.message : String(error);
      return (detail.includes("domain_changes_aggregate_version_unique") ||
        detail.includes("UNIQUE constraint failed: domain_changes.event_id"))
        ? new Conflict({ message: "The form changed while this command was running" })
        : new External({ service: "database", detail });
    },
  });

const stableStringify = (value: unknown): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`)
    .join(",")}}`;
};

const sha256 = (value: string): Effect.Effect<string, External> =>
  Effect.tryPromise({
    try: async () => {
      const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
      return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    },
    catch: (error) =>
      new External({
        service: "crypto",
        detail: error instanceof Error ? error.message : String(error),
      }),
  });

const decodeJsonColumn = (value: unknown): unknown =>
  typeof value === "string" ? JSON.parse(value) as unknown : value;


const fieldType = (value: string): FormFieldType =>
  Schema.decodeUnknownSync(Schema.Literal(
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
  ))(value);

const toField = (row: DraftFieldRow): FormField => ({
  id: row.id,
  order: row.order,
  type: fieldType(row.type),
  label: row.label,
  semanticKey: row.semanticKey,
  helpText: row.helpText,
  required: row.required,
  options: row.options ?? [],
  logic: row.logic === null
    ? null
    : Schema.decodeUnknownSync(ConditionalLogic)(decodeJsonColumn(row.logic)),
  routing: Schema.decodeUnknownSync(Routing)(decodeJsonColumn(row.routing ?? {})),
  version: row.version,
});

const toVersionField = (row: VersionFieldRow) => ({
  id: row.id,
  sourceFieldId: row.sourceFieldId,
  order: row.order,
  type: fieldType(row.type),
  label: row.label,
  semanticKey: row.semanticKey,
  helpText: row.helpText,
  required: row.required,
  options: row.options ?? [],
  logic: row.logic === null
    ? null
    : Schema.decodeUnknownSync(ConditionalLogic)(decodeJsonColumn(row.logic)),
  routing: Schema.decodeUnknownSync(Routing)(decodeJsonColumn(row.routing ?? {})),
});

const purpose = (row: FormRow): FormDetail["purpose"] =>
  row.kind === "cfp" ? "primary-cfp" : "additional";

const assertPrincipalTenant = (principal: Principal, eventId: string): Effect.Effect<void, Forbidden> =>
  principal.kind === "api-key" && principal.eventId !== eventId
    ? Effect.fail(new Forbidden({ reason: "API key is scoped to another event" }))
    : Effect.void;

const actorColumns = (principal: Principal) =>
  principal.kind === "browser-session"
    ? { actorUserId: principal.userId, actorApiKeyId: null }
    : { actorUserId: null, actorApiKeyId: principal.apiKeyId };

const latestPublishedVersion = (
  eventId: string,
  formId: string,
): Effect.Effect<PublishedFormVersion | null, AppError, Db> =>
  Effect.gen(function* () {
    const { db } = yield* Db;
    const [version] = yield* database(() =>
      db
        .select()
        .from(formVersions)
        .where(and(eq(formVersions.eventId, eventId), eq(formVersions.formId, formId)))
        .orderBy(desc(formVersions.versionNumber))
        .limit(1),
    );
    if (!version) return null;
    const rows = yield* database(() =>
      db
        .select()
        .from(formVersionFields)
        .where(and(
          eq(formVersionFields.eventId, eventId),
          eq(formVersionFields.formVersionId, version.id),
        ))
        .orderBy(asc(formVersionFields.order)),
    );
    return {
      id: version.id,
      versionNumber: version.versionNumber,
      name: version.name,
      description: version.description,
      publishedAt: version.publishedAt.getTime(),
      retiredAt: version.retiredAt?.getTime() ?? null,
      fields: rows.map(toVersionField),
    };
  });

const loadFormDetail = (eventId: string, formId: string): Effect.Effect<FormDetail, AppError, Db> =>
  Effect.gen(function* () {
    const { db } = yield* Db;
    const [form] = yield* database(() =>
      db
        .select()
        .from(forms)
        .where(and(eq(forms.eventId, eventId), eq(forms.id, formId)))
        .limit(1),
    );
    if (!form) return yield* Effect.fail(new NotFound({ entity: "form", id: formId }));
    const rows = yield* database(() =>
      db
        .select()
        .from(formFields)
        .where(and(eq(formFields.eventId, eventId), eq(formFields.formId, formId)))
        .orderBy(asc(formFields.order)),
    );
    const publishedVersion = yield* latestPublishedVersion(eventId, formId);
    return {
      id: form.id,
      eventId: form.eventId,
      purpose: purpose(form),
      name: form.name,
      description: form.description,
      status: form.status,
      opensAt: form.opensAt?.getTime() ?? null,
      closesAt: form.closesAt?.getTime() ?? null,
      version: form.version,
      createdAt: form.createdAt.getTime(),
      updatedAt: form.updatedAt.getTime(),
      fields: rows.map(toField),
      publishedVersion,
    };
  });

const normalizeFields = (
  fields: readonly FormFieldDraft[],
  previous: ReadonlyMap<string, FormField> = new Map(),
): readonly FormField[] =>
  fields.map((field, index) => {
    const id = field.id ?? nanoid();
    const prior = previous.get(id);
    const options = field.options.map((option) => option.trim()).filter(Boolean);
    const routing = Object.fromEntries(
      Object.entries(field.routing)
        .map(([option, category]) => [option.trim(), category.trim()] as const)
        .filter(([option, category]) => option.length > 0 && category.length > 0),
    );
    return {
      id,
      order: index + 1,
      type: field.type,
      label: field.label.trim(),
      semanticKey: field.semanticKey,
      helpText: field.helpText?.trim() || null,
      required: field.required,
      options,
      logic: field.logic,
      routing,
      version: prior ? prior.version + 1 : 1,
    };
  });

const validationProblem = (
  name: string,
  purposeValue: FormDetail["purpose"],
  opensAt: number | null,
  closesAt: number | null,
  fields: readonly FormField[],
): string | null => {
  if (name.trim().length === 0) return "Form name cannot be empty";
  if (opensAt !== null && closesAt !== null && closesAt < opensAt) {
    return "Close time must be at or after open time";
  }
  const seenIds = new Set<string>();
  const seenSemanticKeys = new Set<string>();
  for (const field of fields) {
    if (seenIds.has(field.id)) return `Field id '${field.id}' is duplicated`;
    if (field.semanticKey !== null) {
      if (seenSemanticKeys.has(field.semanticKey)) {
        return `Semantic key '${field.semanticKey}' is duplicated`;
      }
      seenSemanticKeys.add(field.semanticKey);
    }
    if (field.label.length === 0) return "Every field needs a label";
    if (field.type === "file") return `File upload field '${field.label}' is unavailable on public forms`;
    const optionSet = new Set(field.options);
    if (optionSet.size !== field.options.length) return `Field '${field.label}' has duplicate options`;
    if (OPTION_FIELD_TYPES[field.type] && field.options.length === 0) {
      return `Field '${field.label}' needs at least one option`;
    }
    if (!OPTION_FIELD_TYPES[field.type] && field.options.length > 0) {
      return `Field '${field.label}' cannot have options`;
    }
    if ((field.type === "heading" || field.type === "html") && field.required) {
      return `Display field '${field.label}' cannot be required`;
    }
    const routingEntries = Object.entries(field.routing);
    if (routingEntries.length > 0 && !ROUTING_FIELD_TYPES[field.type]) {
      return `Field '${field.label}' cannot route categories`;
    }
    if (routingEntries.some(([option]) => !optionSet.has(option))) {
      return `Field '${field.label}' routes an option that does not exist`;
    }
    if (field.logic) {
      for (const condition of field.logic.conditions) {
        if (!seenIds.has(condition.fieldId)) {
          return `Conditional field '${field.label}' must reference an earlier field`;
        }
        if (condition.op !== "not_empty" && condition.value === undefined) {
          return `Conditional field '${field.label}' needs a comparison value`;
        }
      }
    }
    seenIds.add(field.id);
  }
  if (purposeValue === "primary-cfp") {
    const categoryField = fields.find((field) => {
      const routes = Object.keys(field.routing);
      return ROUTING_FIELD_TYPES[field.type] && field.options.length > 0 &&
        routes.length === field.options.length && field.options.every((option) => routes.includes(option));
    });
    if (!categoryField) {
      return "The primary CFP needs a select or radio field that routes every option to a category";
    }
  }
  return null;
};

const validateFields = (
  name: string,
  purposeValue: FormDetail["purpose"],
  opensAt: number | null,
  closesAt: number | null,
  fields: readonly FormField[],
): Effect.Effect<void, Validation> => {
  const problem = validationProblem(name, purposeValue, opensAt, closesAt, fields);
  return problem ? Effect.fail(new Validation({ message: problem })) : Effect.void;
};

const validatePrimaryPublishSemantics = (
  purposeValue: FormDetail["purpose"],
  fields: readonly FormField[],
): Effect.Effect<void, Validation> => {
  if (purposeValue !== "primary-cfp") return Effect.void;
  for (const semanticKey of ["submissionTitle", "submissionAbstract"] as const) {
    const count = fields.filter((field) => field.semanticKey === semanticKey).length;
    if (count !== 1) {
      return Effect.fail(new Validation({
        message: `The primary CFP needs exactly one '${semanticKey}' field`,
      }));
    }
  }
  return Effect.void;
};

const loadCommandReplay = (
  operationId: string,
  eventId: string,
  principalId: string,
  keyHash: string,
  requestHash: string,
): Effect.Effect<FormDetail | null, AppError, Db> =>
  Effect.gen(function* () {
    const { db } = yield* Db;
    const [record] = yield* database(() =>
      db
        .select()
        .from(idempotencyRecords)
        .where(and(
          eq(idempotencyRecords.eventId, eventId),
          eq(idempotencyRecords.operationId, operationId),
          eq(idempotencyRecords.principalId, principalId),
          eq(idempotencyRecords.keyHash, keyHash),
        ))
        .limit(1),
    );
    if (!record) return null;
    if (record.requestHash !== requestHash) {
      return yield* Effect.fail(new Conflict({ message: "Idempotency key was already used for a different request" }));
    }
    if (record.status !== "completed" || record.responseBody === null) {
      return yield* Effect.fail(new Conflict({ message: "An operation with this idempotency key is still in progress" }));
    }
    return yield* Schema.decodeUnknown(FormDetail)(record.responseBody).pipe(
      Effect.mapError((error) => new External({ service: "database", detail: String(error) })),
    );
  });

const loadDeleteReplay = (
  eventId: string,
  principalId: string,
  keyHash: string,
  requestHash: string,
): Effect.Effect<DeleteFormOutputType | null, AppError, Db> =>
  Effect.gen(function* () {
    const { db } = yield* Db;
    const [record] = yield* database(() =>
      db
        .select()
        .from(idempotencyRecords)
        .where(and(
          eq(idempotencyRecords.eventId, eventId),
          eq(idempotencyRecords.operationId, "forms.deleteDraft"),
          eq(idempotencyRecords.principalId, principalId),
          eq(idempotencyRecords.keyHash, keyHash),
        ))
        .limit(1),
    );
    if (!record) return null;
    if (record.requestHash !== requestHash) {
      return yield* Effect.fail(new Conflict({ message: "Idempotency key was already used for a different request" }));
    }
    if (record.status !== "completed" || record.responseBody === null) {
      return yield* Effect.fail(new Conflict({ message: "An operation with this idempotency key is still in progress" }));
    }
    const decoded = yield* Schema.decodeUnknown(DeleteFormOutput)(record.responseBody).pipe(
      Effect.mapError((error) => new External({ service: "database", detail: String(error) })),
    );
    return { ...decoded, idempotent: true };
  });

const prepareCommand = (
  operationId: string,
  eventId: string,
  idempotencyKey: string,
  input: unknown,
): Effect.Effect<PreparedCommand, AppError, Db | CurrentUser> =>
  Effect.gen(function* () {
    const principal = yield* CurrentUser;
    yield* assertPrincipalTenant(principal, eventId);
    const keyHash = yield* sha256(idempotencyKey);
    const requestHash = yield* sha256(stableStringify(input));
    const replay = yield* loadCommandReplay(
      operationId,
      eventId,
      principal.userId,
      keyHash,
      requestHash,
    );
    return {
      principal,
      idempotencyId: replay ? "" : nanoid(),
      keyHash,
      requestHash,
      replay,
    };
  });

const commitCommand = (
  run: () => Promise<unknown>,
  operationId: string,
  eventId: string,
  prepared: PreparedCommand,
  after: FormDetail,
): Effect.Effect<FormDetail, AppError, Db> =>
  database(run).pipe(
    Effect.as(after),
    Effect.catchIf(
      (error): error is External =>
        error._tag === "External" &&
        (error.detail?.includes("idempotency_key_unique") === true ||
          error.detail?.includes("UNIQUE constraint failed: idempotency_records.event_id") === true),
      () =>
        loadCommandReplay(
          operationId,
          eventId,
          prepared.principal.userId,
          prepared.keyHash,
          prepared.requestHash,
        ).pipe(
          Effect.flatMap((replay) =>
            replay
              ? Effect.succeed(replay)
              : Effect.fail(new External({
                  service: "database",
                  detail: "Idempotency collision committed without a replayable response",
                }))),
        ),
    ),
  );

const commandEvidence = (
  operationId: string,
  eventType: string,
  eventId: string,
  formId: string,
  aggregateVersion: number,
  principal: Principal,
  idempotencyId: string,
  keyHash: string,
  requestHash: string,
  before: FormDetail | null,
  after: FormDetail,
  now: Date,
) => {
  const requestId = nanoid();
  const actors = actorColumns(principal);
  return {
    idempotency: {
      id: idempotencyId,
      eventId,
      operationId,
      principalId: principal.userId,
      keyHash,
      requestHash,
      status: "completed" as const,
      responseStatus: operationId === "forms.create" ? 201 : 200,
      responseBody: after,
      expiresAt: new Date(now.getTime() + COMMAND_TTL_MS),
      completedAt: now,
      createdAt: now,
    },
    versionClaim: {
      id: nanoid(),
      eventId,
      aggregateType: "form",
      aggregateId: formId,
      aggregateVersion,
      eventType: "forms.versionClaim",
      audiences: [{ kind: "admins" }],
      payload: { operationId, eventType },
      ...actors,
      requestId,
      idempotencyRecordId: idempotencyId,
      occurredAt: now,
    },
    change: {
      id: nanoid(),
      eventId,
      aggregateType: "form",
      aggregateId: formId,
      aggregateVersion,
      eventType,
      audiences: [{ kind: "admins" }],
      payload: after,
      ...actors,
      requestId,
      idempotencyRecordId: idempotencyId,
      occurredAt: now,
    },
    audit: {
      id: nanoid(),
      eventId,
      requestId,
      ...actors,
      action: operationId,
      resourceType: "form",
      resourceId: formId,
      before,
      after,
      metadata: { eventType },
      occurredAt: now,
    },
  };
};

const fieldRows = (eventId: string, formId: string, fields: readonly FormField[], now: Date) =>
  fields.map((field) => ({
    id: field.id,
    eventId,
    formId,
    order: field.order,
    type: field.type,
    label: field.label,
    semanticKey: field.semanticKey,
    helpText: field.helpText,
    required: field.required,
    options: field.options,
    logic: field.logic === null ? null : JSON.stringify(field.logic),
    routing: Object.keys(field.routing).length === 0 ? null : JSON.stringify(field.routing),
    version: field.version,
    createdAt: now,
    updatedAt: now,
  }));

export const listForms = (
  input: ListFormsInput,
): Effect.Effect<readonly FormSummary[], AppError, Db | CurrentUser> =>
  Effect.gen(function* () {
    const { db } = yield* Db;
    const principal = yield* CurrentUser;
    yield* assertPrincipalTenant(principal, input.eventId);
    const [formRows, versionRows] = yield* Effect.all([
      database(() =>
        db.select().from(forms).where(eq(forms.eventId, input.eventId)).orderBy(asc(forms.createdAt))),
      database(() =>
        db.select().from(formVersions).where(eq(formVersions.eventId, input.eventId))),
    ]);
    const latest = new Map<string, number>();
    for (const version of versionRows) {
      latest.set(version.formId, Math.max(latest.get(version.formId) ?? 0, version.versionNumber));
    }
    return formRows.map((form) => ({
      id: form.id,
      eventId: form.eventId,
      purpose: purpose(form),
      name: form.name,
      description: form.description,
      status: form.status,
      opensAt: form.opensAt?.getTime() ?? null,
      closesAt: form.closesAt?.getTime() ?? null,
      version: form.version,
      publishedVersionNumber: latest.get(form.id) ?? null,
      updatedAt: form.updatedAt.getTime(),
    }));
  });

export const getForm = (
  input: GetFormInput,
): Effect.Effect<FormDetail, AppError, Db | CurrentUser> =>
  Effect.gen(function* () {
    const principal = yield* CurrentUser;
    yield* assertPrincipalTenant(principal, input.eventId);
    return yield* loadFormDetail(input.eventId, input.formId);
  });

/** Focused-test synchronization only; transports never provide command hooks. */
export interface FormsCommandTestHooks {
  readonly afterIdempotencyLookup?: () => Promise<void>;
}

export const createForm = (
  input: CreateFormInput,
  testHooks?: FormsCommandTestHooks,
): Effect.Effect<FormDetail, AppError, Db | CurrentUser> =>
  Effect.gen(function* () {
    const prepared = yield* prepareCommand("forms.create", input.eventId, input.idempotencyKey, input);
    if (prepared.replay) return prepared.replay;
    if (testHooks?.afterIdempotencyLookup) {
      yield* Effect.promise(testHooks.afterIdempotencyLookup);
    }
    const { db } = yield* Db;
    const [event] = yield* database(() =>
      db.select({ id: events.id }).from(events).where(eq(events.id, input.eventId)).limit(1),
    );
    if (!event) return yield* Effect.fail(new NotFound({ entity: "event", id: input.eventId }));
    if (input.purpose === "primary-cfp") {
      const [existingPrimary] = yield* database(() =>
        db
          .select({ id: forms.id })
          .from(forms)
          .where(and(eq(forms.eventId, input.eventId), eq(forms.kind, "cfp")))
          .limit(1),
      );
      if (existingPrimary) {
        return yield* Effect.fail(new Conflict({ message: "This event already has a primary CFP" }));
      }
    }
    const normalizedFields = normalizeFields(input.fields);
    yield* validateFields(input.name, input.purpose, input.opensAt, input.closesAt, normalizedFields);
    const now = new Date();
    const formId = nanoid();
    const after: FormDetail = {
      id: formId,
      eventId: input.eventId,
      purpose: input.purpose,
      name: input.name.trim(),
      description: input.description?.trim() || null,
      status: "draft",
      opensAt: input.opensAt,
      closesAt: input.closesAt,
      version: 1,
      createdAt: now.getTime(),
      updatedAt: now.getTime(),
      fields: normalizedFields,
      publishedVersion: null,
    };
    const evidence = commandEvidence(
      "forms.create",
      "forms.created",
      input.eventId,
      formId,
      1,
      prepared.principal,
      prepared.idempotencyId,
      prepared.keyHash,
      prepared.requestHash,
      null,
      after,
      now,
    );
    const primaryClaim = input.purpose === "primary-cfp"
      ? {
          ...evidence.versionClaim,
          id: nanoid(),
          aggregateType: "eventForms",
          aggregateId: input.eventId,
          aggregateVersion: 1,
          eventType: "forms.primaryClaim",
          payload: { formId },
        }
      : null;
    return yield* commitCommand(
      () => db.batch([
        db.insert(idempotencyRecords).values(evidence.idempotency),
        db.insert(forms).values({
          id: formId,
          eventId: input.eventId,
          kind: input.purpose === "primary-cfp" ? "cfp" : "task",
          name: after.name,
          description: after.description,
          status: "draft",
          opensAt: input.opensAt === null ? null : new Date(input.opensAt),
          closesAt: input.closesAt === null ? null : new Date(input.closesAt),
          version: 1,
          createdAt: now,
          updatedAt: now,
        }),
        db.insert(formFields).values(fieldRows(input.eventId, formId, normalizedFields, now)),
        db.insert(domainChanges).values(evidence.versionClaim),
        ...(primaryClaim ? [db.insert(domainChanges).values(primaryClaim)] : []),
        db.insert(domainChanges).values(evidence.change),
        db.insert(auditLog).values(evidence.audit),
      ]),
      "forms.create",
      input.eventId,
      prepared,
      after,
    );
  });

export const deleteForm = (
  input: DeleteFormInput,
): Effect.Effect<DeleteFormOutputType, AppError, Db | CurrentUser> =>
  Effect.gen(function* () {
    const principal = yield* CurrentUser;
    yield* assertPrincipalTenant(principal, input.eventId);
    const keyHash = yield* sha256(input.idempotencyKey);
    const requestHash = yield* sha256(stableStringify(input));
    const replay = yield* loadDeleteReplay(
      input.eventId,
      principal.userId,
      keyHash,
      requestHash,
    );
    if (replay) return replay;

    const before = yield* loadFormDetail(input.eventId, input.formId);
    if (before.version !== input.expectedVersion) {
      return yield* Effect.fail(new Conflict({
        message: `Expected form version ${input.expectedVersion}, found ${before.version}`,
      }));
    }
    if (before.purpose !== "additional") {
      return yield* Effect.fail(new Conflict({ message: "The primary CFP cannot be deleted" }));
    }
    if (before.status !== "draft" || before.publishedVersion !== null) {
      return yield* Effect.fail(new Conflict({ message: "Only an unpublished additional-form draft can be deleted" }));
    }

    const { db } = yield* Db;
    const [linkedTask] = yield* database(() =>
      db.select({ id: tasks.id }).from(tasks).where(and(
        eq(tasks.eventId, input.eventId),
        eq(tasks.formId, input.formId),
      )).limit(1),
    );
    if (linkedTask) {
      return yield* Effect.fail(new Conflict({
        message: "Remove this form from its onboarding task before deleting the draft",
      }));
    }

    const deletedAt = new Date();
    const output: DeleteFormOutputType = {
      formId: input.formId,
      deleted: true,
      idempotent: false,
    };
    const idempotencyId = nanoid();
    const requestId = nanoid();
    const aggregateVersion = before.version + 1;
    const actors = actorColumns(principal);
    const commit = database(() => db.batch([
      db.insert(idempotencyRecords).values({
        id: idempotencyId,
        eventId: input.eventId,
        operationId: "forms.deleteDraft",
        principalId: principal.userId,
        keyHash,
        requestHash,
        status: "completed",
        responseStatus: 200,
        responseBody: output,
        expiresAt: new Date(deletedAt.getTime() + COMMAND_TTL_MS),
        completedAt: deletedAt,
        createdAt: deletedAt,
      }),
      db.delete(forms).where(and(
        eq(forms.eventId, input.eventId),
        eq(forms.id, input.formId),
        eq(forms.version, input.expectedVersion),
        eq(forms.kind, "task"),
        eq(forms.status, "draft"),
      )),
      db.insert(domainChanges).values({
        id: nanoid(),
        eventId: input.eventId,
        aggregateType: "form",
        aggregateId: input.formId,
        aggregateVersion,
        eventType: "forms.versionClaim",
        audiences: [{ kind: "admins" }],
        payload: { operationId: "forms.deleteDraft", eventType: "forms.deleted" },
        ...actors,
        requestId,
        idempotencyRecordId: idempotencyId,
        occurredAt: deletedAt,
      }),
      db.insert(domainChanges).values({
        id: nanoid(),
        eventId: input.eventId,
        aggregateType: "form",
        aggregateId: input.formId,
        aggregateVersion,
        eventType: "forms.deleted",
        audiences: [{ kind: "admins" }],
        payload: output,
        ...actors,
        requestId,
        idempotencyRecordId: idempotencyId,
        occurredAt: deletedAt,
      }),
      db.insert(auditLog).values({
        id: nanoid(),
        eventId: input.eventId,
        requestId,
        ...actors,
        action: "forms.deleteDraft",
        resourceType: "form",
        resourceId: input.formId,
        before,
        after: null,
        metadata: { eventType: "forms.deleted" },
        occurredAt: deletedAt,
      }),
    ])).pipe(
      Effect.as(output),
      Effect.catchIf(
        (error): error is External =>
          error._tag === "External" &&
          (error.detail?.includes("idempotency_key_unique") === true ||
            error.detail?.includes("UNIQUE constraint failed: idempotency_records.event_id") === true),
        () => loadDeleteReplay(input.eventId, principal.userId, keyHash, requestHash).pipe(
          Effect.flatMap((racedReplay) => racedReplay
            ? Effect.succeed(racedReplay)
            : Effect.fail(new External({
                service: "database",
                detail: "Idempotency collision committed without a replayable response",
              }))),
        ),
      ),
    );
    return yield* commit;
  });

export const updateForm = (
  input: UpdateFormInput,
): Effect.Effect<FormDetail, AppError, Db | CurrentUser> =>
  Effect.gen(function* () {
    const prepared = yield* prepareCommand("forms.update", input.eventId, input.idempotencyKey, input);
    if (prepared.replay) return prepared.replay;
    const { db } = yield* Db;
    const before = yield* loadFormDetail(input.eventId, input.formId);
    if (before.version !== input.expectedVersion) {
      return yield* Effect.fail(new Conflict({ message: `Expected form version ${input.expectedVersion}, found ${before.version}` }));
    }
    const previous = new Map(before.fields.map((field) => [field.id, field]));
    const normalizedFields = normalizeFields(input.fields, previous);
    yield* validateFields(input.name, before.purpose, input.opensAt, input.closesAt, normalizedFields);
    const now = new Date();
    const after: FormDetail = {
      ...before,
      name: input.name.trim(),
      description: input.description?.trim() || null,
      opensAt: input.opensAt,
      closesAt: input.closesAt,
      version: before.version + 1,
      updatedAt: now.getTime(),
      fields: normalizedFields,
    };
    const evidence = commandEvidence(
      "forms.update",
      "forms.updated",
      input.eventId,
      input.formId,
      after.version,
      prepared.principal,
      prepared.idempotencyId,
      prepared.keyHash,
      prepared.requestHash,
      before,
      after,
      now,
    );
    return yield* commitCommand(
      () => db.batch([
        db.insert(idempotencyRecords).values(evidence.idempotency),
        db.update(forms).set({
          name: after.name,
          description: after.description,
          opensAt: after.opensAt === null ? null : new Date(after.opensAt),
          closesAt: after.closesAt === null ? null : new Date(after.closesAt),
          version: after.version,
          updatedAt: now,
        }).where(and(eq(forms.eventId, input.eventId), eq(forms.id, input.formId), eq(forms.version, input.expectedVersion))),
        db.delete(formFields).where(and(eq(formFields.eventId, input.eventId), eq(formFields.formId, input.formId))),
        db.insert(formFields).values(fieldRows(input.eventId, input.formId, normalizedFields, now)),
        db.insert(domainChanges).values(evidence.versionClaim),
        db.insert(domainChanges).values(evidence.change),
        db.insert(auditLog).values(evidence.audit),
      ]),
      "forms.update",
      input.eventId,
      prepared,
      after,
    );
  });

export const publishForm = (
  input: PublishFormInput,
): Effect.Effect<FormDetail, AppError, Db | CurrentUser> =>
  Effect.gen(function* () {
    const prepared = yield* prepareCommand("forms.publish", input.eventId, input.idempotencyKey, input);
    if (prepared.replay) return prepared.replay;
    const { db } = yield* Db;
    const before = yield* loadFormDetail(input.eventId, input.formId);
    if (before.version !== input.expectedVersion) {
      return yield* Effect.fail(new Conflict({ message: `Expected form version ${input.expectedVersion}, found ${before.version}` }));
    }
    yield* validateFields(before.name, before.purpose, before.opensAt, before.closesAt, before.fields);
    yield* validatePrimaryPublishSemantics(before.purpose, before.fields);
    const now = new Date();
    const versionId = nanoid();
    const versionNumber = (before.publishedVersion?.versionNumber ?? 0) + 1;
    const snapshotFields = before.fields.map((field) => ({
      id: nanoid(),
      sourceFieldId: field.id,
      order: field.order,
      type: field.type,
      label: field.label,
      semanticKey: field.semanticKey,
      helpText: field.helpText,
      required: field.required,
      options: field.options,
      logic: field.logic,
      routing: field.routing,
    }));
    const publishedVersion: PublishedFormVersion = {
      id: versionId,
      versionNumber,
      name: before.name,
      description: before.description,
      publishedAt: now.getTime(),
      retiredAt: null,
      fields: snapshotFields,
    };
    const after: FormDetail = {
      ...before,
      status: "open",
      version: before.version + 1,
      updatedAt: now.getTime(),
      publishedVersion,
    };
    const evidence = commandEvidence(
      "forms.publish",
      "forms.published",
      input.eventId,
      input.formId,
      after.version,
      prepared.principal,
      prepared.idempotencyId,
      prepared.keyHash,
      prepared.requestHash,
      before,
      after,
      now,
    );
    return yield* commitCommand(
      () => db.batch([
        db.insert(idempotencyRecords).values(evidence.idempotency),
        db.update(formVersions).set({ retiredAt: now }).where(and(
          eq(formVersions.eventId, input.eventId),
          eq(formVersions.formId, input.formId),
          isNull(formVersions.retiredAt),
        )),
        db.insert(formVersions).values({
          id: versionId,
          eventId: input.eventId,
          formId: input.formId,
          versionNumber,
          name: before.name,
          description: before.description,
          publishedAt: now,
          retiredAt: null,
          createdAt: now,
        }),
        db.insert(formVersionFields).values(snapshotFields.map((field) => ({
          ...field,
          eventId: input.eventId,
          formVersionId: versionId,
          logic: field.logic === null ? null : JSON.stringify(field.logic),
          routing: Object.keys(field.routing).length === 0 ? null : JSON.stringify(field.routing),
          createdAt: now,
        }))),
        db.update(forms).set({ status: "open", version: after.version, updatedAt: now }).where(and(
          eq(forms.eventId, input.eventId),
          eq(forms.id, input.formId),
          eq(forms.version, input.expectedVersion),
        )),
        db.insert(domainChanges).values(evidence.versionClaim),
        db.insert(domainChanges).values(evidence.change),
        db.insert(auditLog).values(evidence.audit),
      ]),
      "forms.publish",
      input.eventId,
      prepared,
      after,
    );
  });

export const setFormStatus = (
  input: SetFormStatusInput,
): Effect.Effect<FormDetail, AppError, Db | CurrentUser> =>
  Effect.gen(function* () {
    const prepared = yield* prepareCommand("forms.setStatus", input.eventId, input.idempotencyKey, input);
    if (prepared.replay) return prepared.replay;
    const { db } = yield* Db;
    const before = yield* loadFormDetail(input.eventId, input.formId);
    if (before.version !== input.expectedVersion) {
      return yield* Effect.fail(new Conflict({ message: `Expected form version ${input.expectedVersion}, found ${before.version}` }));
    }
    if (input.status === "open" && before.publishedVersion === null) {
      return yield* Effect.fail(new Validation({ message: "Publish this form before opening it" }));
    }
    const now = new Date();
    const after: FormDetail = {
      ...before,
      status: input.status,
      version: before.version + 1,
      updatedAt: now.getTime(),
    };
    const evidence = commandEvidence(
      "forms.setStatus",
      input.status === "open" ? "forms.opened" : "forms.closed",
      input.eventId,
      input.formId,
      after.version,
      prepared.principal,
      prepared.idempotencyId,
      prepared.keyHash,
      prepared.requestHash,
      before,
      after,
      now,
    );
    return yield* commitCommand(
      () => db.batch([
        db.insert(idempotencyRecords).values(evidence.idempotency),
        db.update(forms).set({ status: input.status, version: after.version, updatedAt: now }).where(and(
          eq(forms.eventId, input.eventId),
          eq(forms.id, input.formId),
          eq(forms.version, input.expectedVersion),
        )),
        db.insert(domainChanges).values(evidence.versionClaim),
        db.insert(domainChanges).values(evidence.change),
        db.insert(auditLog).values(evidence.audit),
      ]),
      "forms.setStatus",
      input.eventId,
      prepared,
      after,
    );
  });
