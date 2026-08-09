import { applyD1Migrations, env, type D1Migration } from "cloudflare:test";
import type { Principal } from "contracts/principal";
import { auditLog, domainChanges, eventMembers, events, formFields, formVersionFields, formVersions, forms, idempotencyRecords, users } from "contracts/schema";
import { and, asc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { Effect, Layer, Schema } from "effect";
import { beforeAll, describe, expect, it } from "vitest";
import { AppLayer, type Db, CurrentUser } from "@/server/services";
import { FORMS_FIXTURE_EVENT_ID, FORMS_FIXTURE_NOW, formsFixtures, routedFormsFixture } from "./fixtures";
import { deleteFormOperation, operations, publishFormOperation, setFormStatusOperation, updateFormOperation } from "./operations";
import {
  getFormAvailability,
  normalizeOptionDraft,
  projectActiveAnswers,
  updateConditionAt,
  validatePublishIntent,
  type ConditionalLogic,
  type CreateFormInput,
  type FormField,
} from "./schema";
import { createForm, deleteForm, getForm, listForms, publishForm, setFormStatus, updateForm } from "./service";

type TestEnv = Cloudflare.Env & {
  readonly TEST_MIGRATIONS: readonly D1Migration[];
};

function hasTestMigrations(value: Cloudflare.Env): value is TestEnv {
  return "TEST_MIGRATIONS" in value;
}

const owner: Principal = {
  kind: "browser-session",
  userId: "user-forms-owner",
  email: "forms-owner@example.com",
  name: "Forms Owner",
  sessionId: "session-forms-owner",
  expiresAt: FORMS_FIXTURE_NOW + 86_400_000,
};

const runAs = <A, E>(principal: Principal, effect: Effect.Effect<A, E, Db | CurrentUser>) =>
  Effect.runPromise(
    effect.pipe(Effect.provide(Layer.merge(AppLayer(env), Layer.succeed(CurrentUser, principal)))),
  );

const fixtureDraftFields = [
  ...routedFormsFixture.forms[0]!.fields.map((field) => ({
    id: field.id,
    type: field.type,
    label: field.label,
    semanticKey: field.semanticKey,
    helpText: field.helpText,
    required: field.required,
    options: field.options,
    logic: field.logic,
    routing: field.routing,
  })),
  {
    id: "field-speaker-name",
    type: "text" as const,
    label: "Speaker name",
    semanticKey: "speakerName" as const,
    helpText: null,
    required: true,
    options: [],
    logic: null,
    routing: {},
  },
] as unknown as CreateFormInput["fields"];

const prefixDraftFields = (prefix: string): CreateFormInput["fields"] =>
  fixtureDraftFields.map((field) => ({
    ...field,
    id: `${prefix}-${field.id}`,
    logic: field.logic
      ? {
          ...field.logic,
          conditions: field.logic.conditions.map((condition) => ({
            ...condition,
            fieldId: `${prefix}-${condition.fieldId}`,
          })) as unknown as ConditionalLogic["conditions"],
        }
      : null,
  })) as unknown as CreateFormInput["fields"];

const primaryPublishFixture = () => {
  const fixture = routedFormsFixture.forms[0]!;
  const form: typeof fixture = {
    ...fixture,
    fields: [
      ...fixture.fields,
      {
        id: "field-speaker-name",
        order: fixture.fields.length + 1,
        type: "text",
        label: "Speaker name",
        semanticKey: "speakerName",
        helpText: null,
        required: true,
        options: [],
        logic: null,
        routing: {},
        version: 1,
      },
    ],
  };
  return form;
};

beforeAll(async () => {
  if (!hasTestMigrations(env)) throw new Error("TEST_MIGRATIONS test binding is unavailable");
  await applyD1Migrations(env.DB, [...env.TEST_MIGRATIONS]);
  const db = drizzle(env.DB);
  const now = new Date(FORMS_FIXTURE_NOW);
  await db.batch([
    db.insert(users).values({
      id: owner.userId,
      email: owner.email!,
      name: owner.name,
      createdAt: now,
      updatedAt: now,
    }),
    db.insert(events).values({
      id: FORMS_FIXTURE_EVENT_ID,
      slug: "forms-service-test",
      name: "Forms service test",
      createdAt: now,
      updatedAt: now,
    }),
    db.insert(eventMembers).values({
      id: "member-forms-owner",
      eventId: FORMS_FIXTURE_EVENT_ID,
      userId: owner.userId,
      role: "owner",
      createdAt: now,
      updatedAt: now,
    }),
  ]);
});

describe("forms fixtures and operations", () => {
  it("exports deterministic lifecycle fixtures and bytewise-stable operations", () => {
    expect(formsFixtures.map((fixture) => fixture.id)).toEqual(["empty", "draft", "published", "routed"]);
    expect(formsFixtures.map((fixture) => JSON.stringify(fixture))).toEqual(
      formsFixtures.map((fixture) => JSON.stringify(fixture)),
    );
    expect(routedFormsFixture.forms[0]?.fields[2]?.routing).toEqual({
      "AI systems": "ai-systems",
      "Developer tools": "developer-tools",
      Research: "research",
    });

    const ids = operations.map((operation) => operation.id);
    expect(ids).toEqual([...ids].sort());
    expect(ids).toEqual([
      "forms.create",
      "forms.deleteDraft",
      "forms.get",
      "forms.list",
      "forms.publish",
      "forms.setStatus",
      "forms.update",
    ]);
    expect(operations.filter((operation) => "mcp" in operation).map((operation) => operation.id)).toEqual([
      "forms.create",
      "forms.deleteDraft",
      "forms.get",
      "forms.list",
      "forms.update",
    ]);
  });

  it("decodes REST If-Match headers and preserves direct numeric command input", () => {
    expect(Schema.decodeUnknownSync(deleteFormOperation.input)({
      eventId: FORMS_FIXTURE_EVENT_ID,
      formId: "form-header-delete",
      expectedVersion: "\"6\"",
      idempotencyKey: "forms-header-delete-001",
    }).expectedVersion).toBe(6);

    const update = Schema.decodeUnknownSync(updateFormOperation.input)({
      eventId: FORMS_FIXTURE_EVENT_ID,
      formId: "form-header-update",
      expectedVersion: "\"7\"",
      name: "Header update",
      description: null,
      opensAt: null,
      closesAt: null,
      fields: fixtureDraftFields,
      idempotencyKey: "forms-header-update-001",
    });
    const publish = Schema.decodeUnknownSync(publishFormOperation.input)({
      eventId: FORMS_FIXTURE_EVENT_ID,
      formId: "form-header-publish",
      expectedVersion: "8",
      idempotencyKey: "forms-header-publish-001",
    });
    const status = Schema.decodeUnknownSync(setFormStatusOperation.input)({
      eventId: FORMS_FIXTURE_EVENT_ID,
      formId: "form-header-status",
      expectedVersion: 9,
      status: "open",
      idempotencyKey: "forms-header-status-001",
    });
    expect([update.expectedVersion, publish.expectedVersion, status.expectedVersion]).toEqual([7, 8, 9]);
    expect(() => Schema.decodeUnknownSync(setFormStatusOperation.input)({
      eventId: FORMS_FIXTURE_EVENT_ID,
      formId: "form-header-invalid",
      expectedVersion: "\"0\"",
      status: "closed",
      idempotencyKey: "forms-header-status-002",
    })).toThrow();
  });
});

describe("forms organizer behavior", () => {
  it("validates publish intent and preserves every conditional rule update", () => {
    const valid = primaryPublishFixture();
    const duplicateSemantic: typeof valid = {
      ...valid,
      fields: valid.fields.map((field) =>
        field.id === "field-session-abstract"
          ? { ...field, semanticKey: "submissionTitle" }
          : field),
    };
    expect(validatePublishIntent(duplicateSemantic)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        controlId: "builder-field-field-session-abstract-semantic-key",
        message: expect.stringContaining("already assigned"),
      }),
      expect.objectContaining({ message: "The primary CFP needs exactly one submissionAbstract field." }),
    ]));

    const missingSpeakerName: typeof valid = {
      ...valid,
      fields: valid.fields.map((field) =>
        field.semanticKey === "speakerName" ? { ...field, semanticKey: null } : field),
    };
    expect(validatePublishIntent(missingSpeakerName)).toEqual([{
      controlId: "builder-field-field-session-title-semantic-key",
      message: "The primary CFP needs exactly one speakerName field.",
    }]);

    const missingPrimarySemantics: typeof valid = {
      ...valid,
      fields: valid.fields.map((field) => ({ ...field, semanticKey: null })),
    };
    expect(validatePublishIntent(missingPrimarySemantics).filter((issue) =>
      issue.message.startsWith("The primary CFP needs exactly one"))).toHaveLength(3);
    expect(validatePublishIntent(valid)).toEqual([]);

    const invalid: typeof valid = {
      ...valid,
      name: " ",
      opensAt: FORMS_FIXTURE_NOW + 10_000,
      closesAt: FORMS_FIXTURE_NOW,
      fields: valid.fields.map((field) =>
        field.order === 1
          ? { ...field, label: " " }
          : field.order === 3
            ? { ...field, options: ["Repeated", "Repeated"], routing: {} }
            : field),
    };
    expect(validatePublishIntent(invalid).map((issue) => issue.controlId)).toEqual([
      "builder-form-name",
      "builder-closes-at",
      "builder-field-field-session-title-label",
      "builder-field-field-track-options",
      "builder-field-field-track-routing-0",
    ]);

    const logic: ConditionalLogic = {
      action: "show",
      mode: "any",
      conditions: [
        { fieldId: "field-a", op: "eq", value: "A" },
        { fieldId: "field-b", op: "neq", value: "B" },
      ],
    };
    expect(updateConditionAt(logic, 1, { op: "not_empty", value: undefined })).toEqual({
      action: "show",
      mode: "any",
      conditions: [
        { fieldId: "field-a", op: "eq", value: "A" },
        { fieldId: "field-b", op: "not_empty", value: undefined },
      ],
    });
  });

  it.each([
    "submissionTitle",
    "submissionAbstract",
    "speakerName",
  ] as const)("rejects an optional %s field for the primary CFP", (semanticKey) => {
    const form = primaryPublishFixture();
    const assignedField = form.fields.find((field) => field.semanticKey === semanticKey)!;
    const optional = {
      ...form,
      fields: form.fields.map((field) =>
        field.id === assignedField.id ? { ...field, required: false } : field),
    };

    expect(validatePublishIntent(optional)).toContainEqual({
      controlId: `builder-field-${assignedField.id}-semantic-key`,
      message: `The primary CFP ${semanticKey} field must be required.`,
    });
  });

  it("rejects a conditional canonical field for the primary CFP", () => {
    const form = primaryPublishFixture();
    const speakerName = form.fields.find((field) => field.semanticKey === "speakerName")!;
    const conditional = {
      ...form,
      fields: form.fields.map((field) =>
        field.id === speakerName.id
          ? {
              ...field,
              logic: {
                action: "show" as const,
                mode: "all" as const,
                conditions: [{
                  fieldId: form.fields[0]!.id,
                  op: "not_empty" as const,
                }] as const,
              },
            }
          : field),
    };

    expect(validatePublishIntent(conditional)).toContainEqual({
      controlId: `builder-field-${speakerName.id}-semantic-key`,
      message: "The primary CFP speakerName field cannot be conditional.",
    });
  });

  it.each([
    "checkbox",
    "multiselect",
    "file",
    "heading",
    "html",
  ] as const)("rejects a %s canonical field for the primary CFP", (type) => {
    const form = primaryPublishFixture();
    const speakerName = form.fields.find((field) => field.semanticKey === "speakerName")!;
    const incompatible = {
      ...form,
      fields: form.fields.map((field) =>
        field.id === speakerName.id
          ? { ...field, type, options: type === "multiselect" ? ["One"] : [] }
          : field),
    };

    expect(validatePublishIntent(incompatible)).toContainEqual({
      controlId: `builder-field-${speakerName.id}-type`,
      message: "The primary CFP speakerName field must submit a text value.",
    });
  });

  it("leaves canonical-field restrictions off additional forms", () => {
    const form = primaryPublishFixture();
    const title = form.fields.find((field) => field.semanticKey === "submissionTitle")!;
    const unrestricted = {
      ...form,
      purpose: "additional" as const,
      fields: form.fields.map((field) => {
        if (field.semanticKey === "submissionTitle") return { ...field, required: false };
        if (field.semanticKey === "submissionAbstract") {
          return {
            ...field,
            logic: {
              action: "show" as const,
              mode: "all" as const,
              conditions: [{ fieldId: title.id, op: "not_empty" as const }] as const,
            },
          };
        }
        if (field.semanticKey === "speakerName") {
          return { ...field, type: "checkbox" as const, required: false };
        }
        return field;
      }),
    };

    expect(validatePublishIntent(unrestricted)).toEqual([]);
  });

  it("normalizes committed options and targets malformed routing and dependency controls", () => {
    expect(normalizeOptionDraft("AI systems\nDeveloper tools\n", {
      "AI systems": "ai-systems",
      "Developer tools": "developer-tools",
      Removed: "removed",
    })).toEqual({
      options: ["AI systems", "Developer tools"],
      routing: {
        "AI systems": "ai-systems",
        "Developer tools": "developer-tools",
      },
    });

    const valid = routedFormsFixture.forms[0]!;
    const incompleteRouting: typeof valid = {
      ...valid,
      fields: valid.fields.map((field) =>
        field.id === "field-track"
          ? { ...field, routing: { "AI systems": "ai-systems" } }
          : field),
    };
    expect(validatePublishIntent(incompleteRouting).find((issue) =>
      issue.message.startsWith("Route every option"))?.controlId).toBe(
      "builder-field-field-track-routing-1",
    );

    const reorderedIds = [
      "field-session-title",
      "field-session-abstract",
      "field-workshop-plan",
      "field-track",
      "field-commercial-disclosure",
    ];
    const malformedOrder: typeof valid = {
      ...valid,
      fields: reorderedIds.map((id, index) => ({
        ...valid.fields.find((field) => field.id === id)!,
        order: index + 1,
      })),
    };
    expect(validatePublishIntent(malformedOrder).map((issue) => issue.controlId)).toContain(
      "builder-field-field-workshop-plan-condition-0-source",
    );
  });

  it("uses deterministic availability boundaries and excludes recursively hidden answers", () => {
    const form = routedFormsFixture.forms[0]!;
    expect(getFormAvailability({ ...form, status: "draft" }, FORMS_FIXTURE_NOW)).toBe("draft");
    expect(getFormAvailability({ ...form, publishedVersion: null }, FORMS_FIXTURE_NOW)).toBe("draft");
    expect(getFormAvailability(form, form.opensAt! - 1)).toBe("scheduled");
    expect(getFormAvailability(form, form.opensAt!)).toBe("open");
    expect(getFormAvailability(form, form.closesAt! - 1)).toBe("open");
    expect(getFormAvailability(form, form.closesAt!)).toBe("expired");
    expect(getFormAvailability({ ...form, status: "closed" }, FORMS_FIXTURE_NOW)).toBe("closed");
    expect(getFormAvailability({
      ...form,
      status: "closed",
      publishedVersion: null,
    }, FORMS_FIXTURE_NOW)).toBe("closed");

    const fields: readonly FormField[] = [
      {
        id: "field-a",
        order: 1,
        type: "select",
        label: "A",
        semanticKey: null,
        helpText: null,
        required: true,
        options: ["yes", "no"],
        logic: null,
        routing: {},
        version: 1,
      },
      {
        id: "field-b",
        order: 2,
        type: "text",
        label: "B",
        semanticKey: null,
        helpText: null,
        required: false,
        options: [],
        logic: {
          action: "show",
          mode: "all",
          conditions: [{ fieldId: "field-a", op: "eq", value: "yes" }],
        },
        routing: {},
        version: 1,
      },
      {
        id: "field-c",
        order: 3,
        type: "text",
        label: "C",
        semanticKey: null,
        helpText: null,
        required: false,
        options: [],
        logic: {
          action: "show",
          mode: "all",
          conditions: [{ fieldId: "field-b", op: "eq", value: "go" }],
        },
        routing: {},
        version: 1,
      },
    ];
    const hidden = projectActiveAnswers(fields, {
      "field-a": "no",
      "field-b": "go",
    });
    expect(hidden.visibleFields.map((field) => field.id)).toEqual(["field-a"]);
    expect(hidden.activeAnswers).toEqual({ "field-a": "no" });

    const visible = projectActiveAnswers(fields, {
      "field-a": "yes",
      "field-b": "go",
    });
    expect(visible.visibleFields.map((field) => field.id)).toEqual(["field-a", "field-b", "field-c"]);
    expect(visible.activeAnswers).toEqual({ "field-a": "yes", "field-b": "go" });

    const fileFields: readonly FormField[] = [
      {
        id: "file-proof",
        order: 1,
        type: "file",
        label: "Supporting file",
        semanticKey: null,
        helpText: null,
        required: false,
        options: [],
        logic: null,
        routing: {},
        version: 1,
      },
      {
        id: "file-details",
        order: 2,
        type: "text",
        label: "File details",
        semanticKey: null,
        helpText: null,
        required: false,
        options: [],
        logic: {
          action: "show",
          mode: "all",
          conditions: [{ fieldId: "file-proof", op: "not_empty" }],
        },
        routing: {},
        version: 1,
      },
    ];
    expect(projectActiveAnswers(fileFields, { "file-proof": false }).visibleFields.map((field) =>
      field.id)).toEqual(["file-proof"]);
    expect(projectActiveAnswers(fileFields, { "file-proof": true }).visibleFields.map((field) =>
      field.id)).toEqual(["file-proof", "file-details"]);
  });
});

describe("forms service", () => {
  it("creates idempotently, snapshots on publish, and preserves published meaning across draft edits", async () => {
    const createInput = {
      eventId: FORMS_FIXTURE_EVENT_ID,
      purpose: "primary-cfp" as const,
      name: "AI Engineer CFP",
      description: "A routed CFP",
      opensAt: FORMS_FIXTURE_NOW,
      closesAt: FORMS_FIXTURE_NOW + 86_400_000,
      fields: fixtureDraftFields,
      idempotencyKey: "forms-create-primary-001",
    };
    const created = await runAs(owner, createForm(createInput));
    const replayed = await runAs(owner, createForm(createInput));

    expect(replayed).toEqual(created);
    expect(created.purpose).toBe("primary-cfp");
    expect(created.status).toBe("draft");
    expect(created.fields[2]?.options).toEqual(["AI systems", "Developer tools", "Research"]);
    expect(created.fields.filter((field) => field.semanticKey !== null).map((field) =>
      field.semanticKey)).toEqual([
      "submissionTitle",
      "submissionAbstract",
      "speakerName",
    ]);

    const published = await runAs(owner, publishForm({
      eventId: FORMS_FIXTURE_EVENT_ID,
      formId: created.id,
      expectedVersion: created.version,
      idempotencyKey: "forms-publish-primary-001",
    }));
    expect(published.status).toBe("open");
    expect(published.publishedVersion?.versionNumber).toBe(1);
    expect(published.publishedVersion?.fields[0]?.label).toBe("Session title");

    const changedFields = published.fields.map((field) => ({
      id: field.id,
      type: field.type,
      label: field.order === 1 ? "Revised draft session title" : field.label,
      semanticKey: field.order === 1
        ? "speakerName" as const
        : field.semanticKey === "speakerName"
          ? "submissionTitle" as const
          : field.semanticKey,
      helpText: field.helpText,
      required: field.required,
      options: field.options,
      logic: field.logic,
      routing: field.routing,
    })) as unknown as CreateFormInput["fields"];
    const updated = await runAs(owner, updateForm({
      eventId: FORMS_FIXTURE_EVENT_ID,
      formId: published.id,
      expectedVersion: published.version,
      name: "AI Engineer CFP — revised draft",
      description: published.description,
      opensAt: published.opensAt,
      closesAt: published.closesAt,
      fields: changedFields,
      idempotencyKey: "forms-update-primary-001",
    }));

    expect(updated.fields[0]?.label).toBe("Revised draft session title");
    expect(updated.fields[0]?.semanticKey).toBe("speakerName");
    expect(updated.publishedVersion?.fields[0]?.label).toBe("Session title");
    expect(updated.publishedVersion?.fields[0]?.semanticKey).toBe("submissionTitle");
    const loaded = await runAs(owner, getForm({ eventId: FORMS_FIXTURE_EVENT_ID, formId: created.id }));
    expect(loaded.publishedVersion?.fields[0]?.label).toBe("Session title");
    expect(loaded.publishedVersion?.fields[0]?.semanticKey).toBe("submissionTitle");

    const db = drizzle(env.DB);
    const snapshotRows = await db
      .select()
      .from(formVersionFields)
      .where(and(
        eq(formVersionFields.eventId, FORMS_FIXTURE_EVENT_ID),
        eq(formVersionFields.formVersionId, published.publishedVersion!.id),
      ))
      .orderBy(asc(formVersionFields.order));
    expect(snapshotRows[0]?.label).toBe("Session title");
    expect(snapshotRows[0]?.semanticKey).toBe("submissionTitle");

    const closed = await runAs(owner, setFormStatus({
      eventId: FORMS_FIXTURE_EVENT_ID,
      formId: created.id,
      expectedVersion: updated.version,
      status: "closed",
      idempotencyKey: "forms-close-primary-001",
    }));
    const reopened = await runAs(owner, setFormStatus({
      eventId: FORMS_FIXTURE_EVENT_ID,
      formId: created.id,
      expectedVersion: closed.version,
      status: "open",
      idempotencyKey: "forms-open-primary-001",
    }));
    expect(reopened.status).toBe("open");

    const concurrent = await Promise.all([
      runAs(owner, updateForm({
        eventId: FORMS_FIXTURE_EVENT_ID,
        formId: created.id,
        expectedVersion: reopened.version,
        name: "Concurrent draft edit",
        description: reopened.description,
        opensAt: reopened.opensAt,
        closesAt: reopened.closesAt,
        fields: changedFields,
        idempotencyKey: "forms-update-concurrent-001",
      }).pipe(Effect.either)),
      runAs(owner, setFormStatus({
        eventId: FORMS_FIXTURE_EVENT_ID,
        formId: created.id,
        expectedVersion: reopened.version,
        status: "closed",
        idempotencyKey: "forms-close-concurrent-001",
      }).pipe(Effect.either)),
    ]);
    expect(concurrent.map((result) => result._tag).sort()).toEqual(["Left", "Right"]);
    const rejected = concurrent.find((result) => result._tag === "Left");
    if (rejected?._tag === "Left") expect(rejected.left._tag).toBe("Conflict");
    const afterConcurrent = await runAs(owner, getForm({
      eventId: FORMS_FIXTURE_EVENT_ID,
      formId: created.id,
    }));
    expect(afterConcurrent.version).toBe(reopened.version + 1);

    const listed = await runAs(owner, listForms({ eventId: FORMS_FIXTURE_EVENT_ID }));
    expect(listed).toHaveLength(1);
    expect(listed[0]?.publishedVersionNumber).toBe(1);

    const [formRows, changes, audits, idempotency] = await Promise.all([
      db.select().from(forms).where(eq(forms.eventId, FORMS_FIXTURE_EVENT_ID)),
      db.select().from(domainChanges).where(eq(domainChanges.eventId, FORMS_FIXTURE_EVENT_ID)),
      db.select().from(auditLog).where(eq(auditLog.eventId, FORMS_FIXTURE_EVENT_ID)),
      db.select().from(idempotencyRecords).where(eq(idempotencyRecords.eventId, FORMS_FIXTURE_EVENT_ID)),
    ]);
    expect(formRows).toHaveLength(1);
    const semanticChanges = changes.filter((change) =>
      change.eventType !== "forms.versionClaim" && change.eventType !== "forms.primaryClaim");
    expect(semanticChanges.slice(0, 5).map((change) => change.eventType)).toEqual([
      "forms.created",
      "forms.published",
      "forms.updated",
      "forms.closed",
      "forms.opened",
    ]);
    expect(semanticChanges).toHaveLength(6);
    expect(["forms.updated", "forms.closed"]).toContain(semanticChanges[5]?.eventType);
    expect(changes.filter((change) => change.eventType === "forms.versionClaim")).toHaveLength(6);
    expect(changes.filter((change) => change.eventType === "forms.primaryClaim")).toHaveLength(1);
    expect(audits).toHaveLength(6);
    expect(idempotency).toHaveLength(6);
  });

  it("replays the winner of concurrent identical idempotency keys", async () => {
    const eventId = "event-idempotency-race";
    const db = drizzle(env.DB);
    const now = new Date(FORMS_FIXTURE_NOW);
    await db.insert(events).values({
      id: eventId,
      slug: "idempotency-race",
      name: "Idempotency race",
      createdAt: now,
      updatedAt: now,
    });
    const input = {
      eventId,
      purpose: "additional" as const,
      name: "Race-safe additional form",
      description: null,
      opensAt: null,
      closesAt: null,
      fields: prefixDraftFields("idempotency"),
      idempotencyKey: "forms-identical-race-001",
    };
    let preparedCount = 0;
    const releases: Array<() => void> = [];
    const afterIdempotencyLookup = () => new Promise<void>((resolve) => {
      preparedCount += 1;
      releases.push(resolve);
      if (preparedCount === 2) releases.splice(0).forEach((release) => release());
    });
    const responses = await Promise.all([
      runAs(owner, createForm(input, { afterIdempotencyLookup })),
      runAs(owner, createForm(input, { afterIdempotencyLookup })),
    ]);
    expect(responses[1]).toEqual(responses[0]);
    expect(preparedCount).toBe(2);

    const [formRows, changes, audits, idempotency] = await Promise.all([
      db.select().from(forms).where(eq(forms.eventId, eventId)),
      db.select().from(domainChanges).where(eq(domainChanges.eventId, eventId)),
      db.select().from(auditLog).where(eq(auditLog.eventId, eventId)),
      db.select().from(idempotencyRecords).where(eq(idempotencyRecords.eventId, eventId)),
    ]);
    expect(formRows).toHaveLength(1);

    expect(changes.map((change) => change.eventType).sort()).toEqual([
      "forms.created",
      "forms.versionClaim",
    ]);
    expect(audits).toHaveLength(1);
    expect(idempotency).toHaveLength(1);

    const mismatched = await runAs(owner, createForm({
      ...input,
      name: "Different request",
    }).pipe(Effect.either));
    expect(mismatched._tag).toBe("Left");
    if (mismatched._tag === "Left") expect(mismatched.left._tag).toBe("Conflict");
  });
  it("validates semantic uniqueness, primary publication requirements, and legacy null reads", async () => {
    const db = drizzle(env.DB);
    const now = new Date(FORMS_FIXTURE_NOW);
    const duplicateEventId = "event-semantic-duplicates";
    const primaryEventId = "event-semantic-primary";
    const additionalEventId = "event-semantic-additional";
    const legacyEventId = "event-semantic-legacy";
    await db.insert(events).values([
      { id: duplicateEventId, slug: "semantic-duplicates", name: "Semantic duplicates", createdAt: now, updatedAt: now },
      { id: primaryEventId, slug: "semantic-primary", name: "Semantic primary", createdAt: now, updatedAt: now },
      { id: additionalEventId, slug: "semantic-additional", name: "Semantic additional", createdAt: now, updatedAt: now },
      { id: legacyEventId, slug: "semantic-legacy", name: "Semantic legacy", createdAt: now, updatedAt: now },
    ]);

    const duplicateFields = prefixDraftFields("semantic-duplicate").map((field, index) => ({
      ...field,
      semanticKey: index < 2 ? "submissionTitle" as const : field.semanticKey,
    })) as unknown as CreateFormInput["fields"];
    const duplicate = await runAs(owner, createForm({
      eventId: duplicateEventId,
      purpose: "additional",
      name: "Duplicate semantics",
      description: null,
      opensAt: null,
      closesAt: null,
      fields: duplicateFields,
      idempotencyKey: "forms-semantic-duplicate-001",
    }).pipe(Effect.either));
    expect(duplicate._tag).toBe("Left");
    if (duplicate._tag === "Left") {
      expect(duplicate.left).toMatchObject({
        _tag: "Validation",
        message: "Semantic key 'submissionTitle' is duplicated",
      });
    }

    const titleOnlyFields = prefixDraftFields("semantic-primary").map((field, index) => ({
      ...field,
      semanticKey: index === 0 ? "submissionTitle" as const : null,
    })) as unknown as CreateFormInput["fields"];
    const primary = await runAs(owner, createForm({
      eventId: primaryEventId,
      purpose: "primary-cfp",
      name: "Primary missing abstract semantics",
      description: null,
      opensAt: null,
      closesAt: null,
      fields: titleOnlyFields,
      idempotencyKey: "forms-semantic-primary-create-001",
    }));
    expect(primary.fields[0]?.semanticKey).toBe("submissionTitle");
    expect(primary.fields[1]?.semanticKey).toBeNull();
    const rejectedPublish = await runAs(owner, publishForm({
      eventId: primaryEventId,
      formId: primary.id,
      expectedVersion: primary.version,
      idempotencyKey: "forms-semantic-primary-publish-001",
    }).pipe(Effect.either));
    expect(rejectedPublish._tag).toBe("Left");
    if (rejectedPublish._tag === "Left") {
      expect(rejectedPublish.left).toMatchObject({
        _tag: "Validation",
        message: "The primary CFP needs exactly one 'submissionAbstract' field",
      });
    }

    const nullSemanticFields = prefixDraftFields("semantic-additional").map((field) => ({
      ...field,
      semanticKey: null,
    })) as unknown as CreateFormInput["fields"];
    const additional = await runAs(owner, createForm({
      eventId: additionalEventId,
      purpose: "additional",
      name: "Additional form without submission semantics",
      description: null,
      opensAt: null,
      closesAt: null,
      fields: nullSemanticFields,
      idempotencyKey: "forms-semantic-additional-create-001",
    }));
    const additionalPublished = await runAs(owner, publishForm({
      eventId: additionalEventId,
      formId: additional.id,
      expectedVersion: additional.version,
      idempotencyKey: "forms-semantic-additional-publish-001",
    }));
    expect(additionalPublished.publishedVersion?.fields.every((field) =>
      field.semanticKey === null)).toBe(true);

    await db.batch([
      db.insert(forms).values({
        id: "form-semantic-legacy",
        eventId: legacyEventId,
        kind: "task",
        name: "Legacy form",
        description: null,
        status: "open",
        opensAt: null,
        closesAt: null,
        version: 1,
        createdAt: now,
        updatedAt: now,
      }),
      db.insert(formFields).values({
        id: "field-semantic-legacy",
        eventId: legacyEventId,
        formId: "form-semantic-legacy",
        order: 1,
        type: "text",
        label: "Submission title",
        helpText: null,
        semanticKey: null,
        required: true,
        options: [],
        logic: null,
        routing: null,
        version: 1,
        createdAt: now,
        updatedAt: now,
      }),
      db.insert(formVersions).values({
        id: "version-semantic-legacy",
        eventId: legacyEventId,
        formId: "form-semantic-legacy",
        versionNumber: 1,
        name: "Legacy form",
        description: null,
        publishedAt: now,
        retiredAt: null,
        createdAt: now,
      }),
      db.insert(formVersionFields).values({
        id: "version-field-semantic-legacy",
        eventId: legacyEventId,
        formVersionId: "version-semantic-legacy",
        sourceFieldId: "field-semantic-legacy",
        order: 1,
        type: "text",
        label: "Submission title",
        helpText: null,
        semanticKey: null,
        required: true,
        options: [],
        logic: null,
        routing: null,
        createdAt: now,
      }),
    ]);
    const legacy = await runAs(owner, getForm({ eventId: legacyEventId, formId: "form-semantic-legacy" }));
    expect(legacy.fields[0]?.semanticKey).toBeNull();
    expect(legacy.publishedVersion?.fields[0]?.semanticKey).toBeNull();
    expect((await runAs(owner, listForms({ eventId: legacyEventId })))[0]).toMatchObject({
      id: "form-semantic-legacy",
      publishedVersionNumber: 1,
    });
  });

  it("deletes only unpublished additional drafts with replay and evidence", async () => {
    const created = await runAs(owner, createForm({
      eventId: FORMS_FIXTURE_EVENT_ID,
      purpose: "additional",
      name: "Unpublished speaker follow-up",
      description: null,
      opensAt: null,
      closesAt: null,
      fields: prefixDraftFields("delete-draft"),
      idempotencyKey: "forms-create-delete-draft",
    }));

    const input = {
      eventId: FORMS_FIXTURE_EVENT_ID,
      formId: created.id,
      expectedVersion: created.version,
      idempotencyKey: "forms-delete-draft-001",
    };
    const deleted = await runAs(owner, deleteForm(input));
    const replayed = await runAs(owner, deleteForm(input));

    expect(deleted).toEqual({ formId: created.id, deleted: true, idempotent: false });
    expect(replayed).toEqual({ formId: created.id, deleted: true, idempotent: true });
    const missing = await runAs(owner, getForm({
      eventId: FORMS_FIXTURE_EVENT_ID,
      formId: created.id,
    }).pipe(Effect.either));
    expect(missing._tag).toBe("Left");
    if (missing._tag === "Left") expect(missing.left._tag).toBe("NotFound");

    const db = drizzle(env.DB);
    const changes = await db.select().from(domainChanges).where(and(
      eq(domainChanges.eventId, FORMS_FIXTURE_EVENT_ID),
      eq(domainChanges.aggregateId, created.id),
    ));
    expect(changes.map((change) => change.eventType)).toEqual([
      "forms.versionClaim",
      "forms.created",
      "forms.versionClaim",
      "forms.deleted",
    ]);
    const [audit] = await db.select().from(auditLog).where(and(
      eq(auditLog.eventId, FORMS_FIXTURE_EVENT_ID),
      eq(auditLog.resourceId, created.id),
      eq(auditLog.action, "forms.deleteDraft"),
    ));
    expect(audit?.after).toBeNull();

    const published = await runAs(owner, createForm({
      eventId: FORMS_FIXTURE_EVENT_ID,
      purpose: "additional",
      name: "Published speaker follow-up",
      description: null,
      opensAt: null,
      closesAt: null,
      fields: prefixDraftFields("delete-published"),
      idempotencyKey: "forms-create-delete-published",
    })).then((form) => runAs(owner, publishForm({
      eventId: FORMS_FIXTURE_EVENT_ID,
      formId: form.id,
      expectedVersion: form.version,
      idempotencyKey: "forms-publish-delete-guard",
    })));
    const publishedDelete = await runAs(owner, deleteForm({
      eventId: FORMS_FIXTURE_EVENT_ID,
      formId: published.id,
      expectedVersion: published.version,
      idempotencyKey: "forms-delete-published-guard",
    }).pipe(Effect.either));
    expect(publishedDelete._tag).toBe("Left");
    if (publishedDelete._tag === "Left") expect(publishedDelete.left._tag).toBe("Conflict");
  });

  it("rejects trim-empty names in create, update, and publish service paths", async () => {
    const eventId = "event-name-validation";
    const db = drizzle(env.DB);
    const now = new Date(FORMS_FIXTURE_NOW);
    await db.insert(events).values({
      id: eventId,
      slug: "name-validation",
      name: "Name validation",
      createdAt: now,
      updatedAt: now,
    });
    const baseInput = {
      eventId,
      purpose: "additional" as const,
      description: null,
      opensAt: null,
      closesAt: null,
      fields: prefixDraftFields("name-validation"),
    };
    const invalidCreate = await runAs(owner, createForm({
      ...baseInput,
      name: "   ",
      idempotencyKey: "forms-name-create-invalid",
    }).pipe(Effect.either));
    expect(invalidCreate._tag).toBe("Left");
    if (invalidCreate._tag === "Left") expect(invalidCreate.left._tag).toBe("Validation");

    const created = await runAs(owner, createForm({
      ...baseInput,
      name: "Valid name",
      idempotencyKey: "forms-name-create-valid",
    }));
    const invalidUpdate = await runAs(owner, updateForm({
      eventId,
      formId: created.id,
      expectedVersion: created.version,
      name: "\t ",
      description: created.description,
      opensAt: created.opensAt,
      closesAt: created.closesAt,
      fields: prefixDraftFields("name-validation"),
      idempotencyKey: "forms-name-update-invalid",
    }).pipe(Effect.either));
    expect(invalidUpdate._tag).toBe("Left");
    if (invalidUpdate._tag === "Left") expect(invalidUpdate.left._tag).toBe("Validation");

    await db.update(forms).set({ name: " " }).where(and(
      eq(forms.eventId, eventId),
      eq(forms.id, created.id),
    ));
    const invalidPublish = await runAs(owner, publishForm({
      eventId,
      formId: created.id,
      expectedVersion: created.version,
      idempotencyKey: "forms-name-publish-invalid",
    }).pipe(Effect.either));
    expect(invalidPublish._tag).toBe("Left");
    if (invalidPublish._tag === "Left") expect(invalidPublish.left._tag).toBe("Validation");
  });

  it("enforces the single primary CFP and event-scoped API-key tenancy", async () => {
    const concurrencyEventId = "event-concurrent-primary";
    const db = drizzle(env.DB);
    const now = new Date(FORMS_FIXTURE_NOW);
    await db.insert(events).values({
      id: concurrencyEventId,
      slug: "concurrent-primary",
      name: "Concurrent primary invariant",
      createdAt: now,
      updatedAt: now,
    });
    const attempts = await Promise.all([
      runAs(owner, createForm({
        eventId: concurrencyEventId,
        purpose: "primary-cfp",
        name: "Primary attempt A",
        description: null,
        opensAt: null,
        closesAt: null,
        fields: prefixDraftFields("a"),
        idempotencyKey: "forms-primary-concurrent-a",
      }).pipe(Effect.either)),
      runAs(owner, createForm({
        eventId: concurrencyEventId,
        purpose: "primary-cfp",
        name: "Primary attempt B",
        description: null,
        opensAt: null,
        closesAt: null,
        fields: prefixDraftFields("b"),
        idempotencyKey: "forms-primary-concurrent-b",
      }).pipe(Effect.either)),
    ]);
    expect(attempts.map((attempt) => attempt._tag).sort()).toEqual(["Left", "Right"]);
    const rejectedAttempt = attempts.find((attempt) => attempt._tag === "Left");
    if (rejectedAttempt?._tag === "Left") expect(rejectedAttempt.left._tag).toBe("Conflict");
    const primaryRows = await db
      .select()
      .from(forms)
      .where(and(eq(forms.eventId, concurrencyEventId), eq(forms.kind, "cfp")));
    expect(primaryRows).toHaveLength(1);

    const duplicate = await Effect.runPromise(
      createForm({
        eventId: FORMS_FIXTURE_EVENT_ID,
        purpose: "primary-cfp",
        name: "Duplicate primary",
        description: null,
        opensAt: null,
        closesAt: null,
        fields: fixtureDraftFields,
        idempotencyKey: "forms-create-primary-duplicate",
      }).pipe(
        Effect.either,
        Effect.provide(Layer.merge(AppLayer(env), Layer.succeed(CurrentUser, owner))),
      ),
    );
    expect(duplicate._tag).toBe("Left");
    if (duplicate._tag === "Left") expect(duplicate.left._tag).toBe("Conflict");

    const wrongEventKey: Principal = {
      kind: "api-key",
      userId: "api-key:wrong-event",
      apiKeyId: "wrong-event",
      eventId: "another-event",
      name: "Wrong event automation",
      scopes: ["forms:read"],
      expiresAt: FORMS_FIXTURE_NOW + 86_400_000,
    };
    const denied = await Effect.runPromise(
      listForms({ eventId: FORMS_FIXTURE_EVENT_ID }).pipe(
        Effect.either,
        Effect.provide(Layer.merge(AppLayer(env), Layer.succeed(CurrentUser, wrongEventKey))),
      ),
    );
    expect(denied._tag).toBe("Left");
    if (denied._tag === "Left") expect(denied.left._tag).toBe("Forbidden");
  });
});
