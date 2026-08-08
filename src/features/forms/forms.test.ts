import { applyD1Migrations, env, type D1Migration } from "cloudflare:test";
import { auditLog, domainChanges, eventMembers, events, formVersionFields, forms, idempotencyRecords, users } from "contracts/schema";
import { and, asc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { Effect, Layer } from "effect";
import { beforeAll, describe, expect, it } from "vitest";
import { AppLayer, type Db, CurrentUser, type CurrentUserValue } from "@/server/services";
import { FORMS_FIXTURE_EVENT_ID, FORMS_FIXTURE_NOW, formsFixtures, routedFormsFixture } from "./fixtures";
import { operations } from "./operations";
import type { FormFieldDraft } from "./schema";
import { createForm, getForm, listForms, publishForm, setFormStatus, updateForm } from "./service";

type TestEnv = Cloudflare.Env & {
  readonly TEST_MIGRATIONS: readonly D1Migration[];
};

function hasTestMigrations(value: Cloudflare.Env): value is TestEnv {
  return "TEST_MIGRATIONS" in value;
}

const owner: CurrentUserValue = {
  kind: "browser-session",
  userId: "user-forms-owner",
  email: "forms-owner@example.com",
  name: "Forms Owner",
  sessionId: "session-forms-owner",
  expiresAt: FORMS_FIXTURE_NOW + 86_400_000,
};

const runAs = <A, E>(principal: CurrentUserValue, effect: Effect.Effect<A, E, Db | CurrentUser>) =>
  Effect.runPromise(
    effect.pipe(Effect.provide(Layer.merge(AppLayer(env), Layer.succeed(CurrentUser, principal)))),
  );

const fixtureDraftFields: readonly FormFieldDraft[] = routedFormsFixture.forms[0]!.fields.map((field) => ({
  id: field.id,
  type: field.type,
  label: field.label,
  helpText: field.helpText,
  required: field.required,
  options: field.options,
  logic: field.logic,
  routing: field.routing,
}));

beforeAll(async () => {
  if (!hasTestMigrations(env)) throw new Error("TEST_MIGRATIONS test binding is unavailable");
  await applyD1Migrations(env.DB, [...env.TEST_MIGRATIONS]);
  // BaselineGreen owns the migration that makes the frozen schema real. The
  // focused slice fixture mirrors only the frozen columns this service uses.
  await env.DB.batch([
    env.DB.prepare("ALTER TABLE users ADD COLUMN version integer NOT NULL DEFAULT 1"),
    env.DB.prepare("ALTER TABLE events ADD COLUMN version integer NOT NULL DEFAULT 1"),
    env.DB.prepare("ALTER TABLE event_members ADD COLUMN version integer NOT NULL DEFAULT 1"),
    env.DB.prepare("ALTER TABLE forms ADD COLUMN version integer NOT NULL DEFAULT 1"),
    env.DB.prepare("ALTER TABLE form_fields ADD COLUMN event_id text"),
    env.DB.prepare("ALTER TABLE form_fields ADD COLUMN version integer NOT NULL DEFAULT 1"),
    env.DB.prepare(`
      CREATE TABLE form_versions (
        id text PRIMARY KEY NOT NULL,
        event_id text NOT NULL,
        form_id text NOT NULL,
        version_number integer NOT NULL,
        name text NOT NULL,
        description text,
        published_at integer NOT NULL,
        retired_at integer,
        created_at integer NOT NULL
      )
    `),
    env.DB.prepare(`
      CREATE TABLE form_version_fields (
        id text PRIMARY KEY NOT NULL,
        event_id text NOT NULL,
        form_version_id text NOT NULL,
        source_field_id text,
        "order" integer NOT NULL,
        type text NOT NULL,
        label text NOT NULL,
        help_text text,
        required integer NOT NULL,
        options text,
        logic text,
        routing text,
        created_at integer NOT NULL
      )
    `),
    env.DB.prepare(`
      CREATE TABLE idempotency_records (
        id text PRIMARY KEY NOT NULL,
        event_id text NOT NULL,
        operation_id text NOT NULL,
        principal_id text NOT NULL,
        key_hash text NOT NULL,
        request_hash text NOT NULL,
        status text NOT NULL,
        response_status integer,
        response_body text,
        expires_at integer NOT NULL,
        completed_at integer,
        created_at integer NOT NULL
      )
    `),
    env.DB.prepare(`
      CREATE UNIQUE INDEX idempotency_key_unique
        ON idempotency_records (event_id, operation_id, principal_id, key_hash)
    `),
    env.DB.prepare(`
      CREATE TABLE domain_changes (
        sequence integer PRIMARY KEY AUTOINCREMENT,
        id text NOT NULL,
        event_id text NOT NULL,
        aggregate_type text NOT NULL,
        aggregate_id text NOT NULL,
        aggregate_version integer NOT NULL,
        event_type text NOT NULL,
        audiences text NOT NULL,
        payload text NOT NULL,
        actor_user_id text,
        actor_api_key_id text,
        request_id text NOT NULL,
        idempotency_record_id text,
        occurred_at integer NOT NULL
      )
    `),
    env.DB.prepare(`
      CREATE UNIQUE INDEX domain_changes_aggregate_version_unique
        ON domain_changes (event_id, aggregate_type, aggregate_id, aggregate_version, event_type)
    `),
    env.DB.prepare(`
      CREATE TABLE audit_log (
        id text PRIMARY KEY NOT NULL,
        event_id text NOT NULL,
        request_id text NOT NULL,
        actor_user_id text,
        actor_api_key_id text,
        action text NOT NULL,
        resource_type text NOT NULL,
        resource_id text NOT NULL,
        before text,
        after text,
        metadata text,
        occurred_at integer NOT NULL
      )
    `),
  ]);
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
      "forms.get",
      "forms.list",
      "forms.publish",
      "forms.setStatus",
      "forms.update",
    ]);
    expect(operations.filter((operation) => "mcp" in operation).map((operation) => operation.id)).toEqual([
      "forms.create",
      "forms.get",
      "forms.list",
      "forms.update",
    ]);
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
      helpText: field.helpText,
      required: field.required,
      options: field.options,
      logic: field.logic,
      routing: field.routing,
    }));
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
    expect(updated.publishedVersion?.fields[0]?.label).toBe("Session title");
    const loaded = await runAs(owner, getForm({ eventId: FORMS_FIXTURE_EVENT_ID, formId: created.id }));
    expect(loaded.publishedVersion?.fields[0]?.label).toBe("Session title");

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
    const concurrentFields = (prefix: string): readonly FormFieldDraft[] =>
      fixtureDraftFields.map((field) => ({
        ...field,
        id: `${prefix}-${field.id}`,
        logic: field.logic
          ? {
              ...field.logic,
              conditions: field.logic.conditions.map((condition) => ({
                ...condition,
                fieldId: `${prefix}-${condition.fieldId}`,
              })) as typeof field.logic.conditions,
            }
          : null,
      }));
    const attempts = await Promise.all([
      runAs(owner, createForm({
        eventId: concurrencyEventId,
        purpose: "primary-cfp",
        name: "Primary attempt A",
        description: null,
        opensAt: null,
        closesAt: null,
        fields: concurrentFields("a"),
        idempotencyKey: "forms-primary-concurrent-a",
      }).pipe(Effect.either)),
      runAs(owner, createForm({
        eventId: concurrencyEventId,
        purpose: "primary-cfp",
        name: "Primary attempt B",
        description: null,
        opensAt: null,
        closesAt: null,
        fields: concurrentFields("b"),
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

    const wrongEventKey: CurrentUserValue = {
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
