import { applyD1Migrations, env, type D1Migration } from "cloudflare:test";
import { External, Validation } from "contracts/errors";
import type { Principal } from "contracts/principal";
import {
  acceptanceEvents,
  airtableOutbox,
  auditLog,
  domainChanges,
  eventMembers,
  events,
  formVersionFields,
  formVersions,
  forms,
  idempotencyRecords,
  integrations,
  reviewAssignments,
  reviewRounds,
  speakerProvisioning,
  speakers,
  submissionAnswers,
  submissionSpeakers,
  submissions,
  users,
} from "contracts/schema";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { Hono } from "hono";
import { Effect, Either, Layer } from "effect";
import { beforeAll, describe, expect, it } from "vitest";
import { runRestOperation, type AppHono } from "@/server/adapt";
import { AppLayer, CurrentUser } from "@/server/services";
import {
  createPublicSubmissionOperation,
  createTaskSubmissionOperation,
  getPublicSubmissionFormOperation,
  operations,
} from "./operations";
import { localTestPublicSubmissionAbuse, PublicSubmissionAbuse, PublicSubmissionRequest, type PublicSubmissionAbuseAttempt } from "./abuse";
import type { CreatePublicSubmissionInput, CreateTaskSubmissionInput } from "./schema";
import {
  createPublicSubmission,
  createTaskSubmission,
  getOwnSubmissions,
  getPublicSubmissionForm,
  getTaskSubmissionForm,
  listSubmissions,
  updateOwnSubmissionAbstract,
} from "./service";

type TestEnv = Cloudflare.Env & { readonly TEST_MIGRATIONS: readonly D1Migration[] };
const EVENT_ID = "event-submit-tests";
const EVENT_SLUG = "submit-tests";
const OPEN_FORM_ID = "form-submit-open";
const OPEN_VERSION_ID = "form-submit-open-v1";
const CLOSED_FORM_ID = "form-submit-closed";
const CLOSED_VERSION_ID = "form-submit-closed-v1";
const RACE_FORM_ID = "form-submit-race";
const RACE_VERSION_ID = "form-submit-race-v1";
const EXTRAS_FORM_ID = "form-submit-extras";
const EXTRAS_VERSION_ID = "form-submit-extras-v1";
const TASK_FORM_ID = "form-submit-task";
const TASK_VERSION_ID = "form-submit-task-v1";
const TASK_FIELD_ID = "submit-task-notes";
const NOW = Date.UTC(2026, 7, 8, 12, 0, 0);

const owner: Principal = {
  kind: "browser-session",
  userId: "user-submit-owner",
  email: "submit-owner@example.com",
  name: "Submit Owner",
  sessionId: "session-submit-owner",
  expiresAt: NOW + 86_400_000,
};
const reviewer: Principal = {
  kind: "browser-session",
  userId: "user-submit-reviewer",
  email: "submit-reviewer@example.com",
  name: "Submit Reviewer",
  sessionId: "session-submit-reviewer",
  expiresAt: NOW + 86_400_000,
};
const outsider: Principal = {
  kind: "browser-session",
  userId: "user-submit-outsider",
  email: "submit-outsider@example.com",
  name: "Submit Outsider",
  sessionId: "session-submit-outsider",
  expiresAt: NOW + 86_400_000,
};
const submittingSpeaker: Principal = {
  kind: "browser-session",
  userId: "user-submitting-speaker",
  email: "sam@example.com",
  name: "Sam Rivera",
  sessionId: "session-submitting-speaker",
  expiresAt: NOW + 86_400_000,
};
const wrongEventApiKey: Principal = {
  kind: "api-key",
  userId: "api-key:key-submit-wrong-event",
  apiKeyId: "key-submit-wrong-event",
  eventId: "another-event",
  name: "Wrong event key",
  scopes: ["submissions:read"],
  expiresAt: NOW + 86_400_000,
};

const fieldIds = {
  title: "submit-field-title",
  abstract: "submit-field-abstract",
  speakerName: "submit-field-speaker-name",
  speakerEmail: "submit-field-speaker-email",
  category: "submit-field-category",
} as const;
const extraFieldIds = {
  title: "submit-extra-title",
  abstract: "submit-extra-abstract",
  speakerName: "submit-extra-speaker-name",
  consent: "submit-extra-consent",
  details: "submit-extra-details",
  when: "submit-extra-when",
  category: "submit-extra-category",
} as const;


const submissionInput = (
  idempotencyKey: string,
  formId = OPEN_FORM_ID,
  title = "Effect at the edge",
): CreatePublicSubmissionInput => {
  const versionId = formId === CLOSED_FORM_ID
    ? CLOSED_VERSION_ID
    : formId === RACE_FORM_ID ? RACE_VERSION_ID : OPEN_VERSION_ID;
  return {
    eventSlug: EVENT_SLUG,
    formId,
    idempotencyKey,
    turnstileToken: "local-test-turnstile-token",
    answers: [
      { fieldId: `${versionId}-${fieldIds.title}`, value: title },
      { fieldId: `${versionId}-${fieldIds.abstract}`, value: "A proposal grounded in real immutable answers." },
      { fieldId: `${versionId}-${fieldIds.speakerName}`, value: "Sam Rivera" },
      { fieldId: `${versionId}-${fieldIds.speakerEmail}`, value: "sam@example.com" },
      { fieldId: `${versionId}-${fieldIds.category}`, value: "Architecture" },
    ],
  };
};

const extrasInput = (
  idempotencyKey: string,
  answers: readonly { readonly fieldId: string; readonly value: string | readonly string[] }[],
): CreatePublicSubmissionInput => ({
  eventSlug: EVENT_SLUG,
  formId: EXTRAS_FORM_ID,
  idempotencyKey,
  answers: [
    { fieldId: `${EXTRAS_VERSION_ID}-${extraFieldIds.title}`, value: "Follow-up task" },
    { fieldId: `${EXTRAS_VERSION_ID}-${extraFieldIds.abstract}`, value: "Focused validation behavior." },
    { fieldId: `${EXTRAS_VERSION_ID}-${extraFieldIds.speakerName}`, value: "Robin Vale" },
    { fieldId: `${EXTRAS_VERSION_ID}-${extraFieldIds.category}`, value: "Validation" },
    ...answers.map((answer) => ({
      fieldId: `${EXTRAS_VERSION_ID}-${answer.fieldId}`,
      value: answer.value,
    })),
  ],
});

const taskInput = (): CreatePublicSubmissionInput => ({
  eventSlug: EVENT_SLUG,
  formId: TASK_FORM_ID,
  idempotencyKey: "submit-task-public-001",
  answers: [{
    fieldId: `${TASK_VERSION_ID}-${TASK_FIELD_ID}`,
    value: "Portal follow-up details",
  }],
});

const taskSpeakerInput = (
  idempotencyKey = "submit-task-speaker-001",
  value = "Portal follow-up details",
): CreateTaskSubmissionInput => ({
  eventId: EVENT_ID,
  formId: TASK_FORM_ID,
  idempotencyKey,
  answers: [{ fieldId: `${TASK_VERSION_ID}-${TASK_FIELD_ID}`, value }],
});

const publicAbuseTestLayer = Layer.mergeAll(
  AppLayer(env),
  Layer.succeed(PublicSubmissionAbuse, localTestPublicSubmissionAbuse),
  Layer.succeed(PublicSubmissionRequest, { remoteIp: "198.51.100.7" }),
);

const runPublic = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.runPromise(effect.pipe(Effect.provide(publicAbuseTestLayer)) as Effect.Effect<A, E, never>);

const runPublicWithAbuse = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  authorize: (attempt: PublicSubmissionAbuseAttempt) => Effect.Effect<void, Validation | External>,
) => Effect.runPromise(effect.pipe(Effect.provide(Layer.mergeAll(
  AppLayer(env),
  Layer.succeed(PublicSubmissionAbuse, { ...localTestPublicSubmissionAbuse, authorize }),
  Layer.succeed(PublicSubmissionRequest, { remoteIp: "198.51.100.7" }),
))) as Effect.Effect<A, E, never>);

const runAs = <A, E, R>(principal: Principal, effect: Effect.Effect<A, E, R>) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(Layer.merge(AppLayer(env), Layer.succeed(CurrentUser, principal))),
    ) as Effect.Effect<A, E, never>,
  );

const runEitherAs = <A, E, R>(principal: Principal, effect: Effect.Effect<A, E, R>) =>
  Effect.runPromise(
    effect.pipe(
      Effect.either,
      Effect.provide(Layer.merge(AppLayer(env), Layer.succeed(CurrentUser, principal))),
    ) as Effect.Effect<Either.Either<A, E>, never, never>,
  );

beforeAll(async () => {
  if (!("TEST_MIGRATIONS" in env)) throw new Error("TEST_MIGRATIONS test binding is unavailable");
  await applyD1Migrations(env.DB, [...(env as TestEnv).TEST_MIGRATIONS]);
  const db = drizzle(env.DB);
  const now = new Date(NOW);
  await db.batch([
    db.insert(users).values([
      { id: owner.userId, email: owner.email!, name: owner.name, createdAt: now, updatedAt: now },
      { id: reviewer.userId, email: reviewer.email!, name: reviewer.name, createdAt: now, updatedAt: now },
      { id: outsider.userId, email: outsider.email!, name: outsider.name, createdAt: now, updatedAt: now },
      { id: submittingSpeaker.userId, email: submittingSpeaker.email!, name: submittingSpeaker.name, createdAt: now, updatedAt: now },
    ]),
    db.insert(events).values({
      id: EVENT_ID,
      slug: EVENT_SLUG,
      name: "Submit behavior tests",
      description: "Public CFP behavior",
      createdAt: now,
      updatedAt: now,
    }),
    db.insert(eventMembers).values([
      { id: "member-submit-owner", eventId: EVENT_ID, userId: owner.userId, role: "owner", createdAt: now, updatedAt: now },
      { id: "member-submit-reviewer", eventId: EVENT_ID, userId: reviewer.userId, role: "reviewer", createdAt: now, updatedAt: now },
    ]),
    db.insert(forms).values([
      {
        id: OPEN_FORM_ID,
        eventId: EVENT_ID,
        kind: "cfp",
        name: "Open CFP draft",
        status: "open",
        createdAt: now,
        updatedAt: now,
      },
      {
        id: CLOSED_FORM_ID,
        eventId: EVENT_ID,
        kind: "cfp",
        name: "Closed CFP draft",
        status: "closed",
        createdAt: now,
        updatedAt: now,
      },
      {
        id: RACE_FORM_ID,
        eventId: EVENT_ID,
        kind: "cfp",
        name: "Race CFP draft",
        status: "open",
        createdAt: now,
        updatedAt: now,
      },
      {
        id: EXTRAS_FORM_ID,
        eventId: EVENT_ID,
        kind: "cfp",
        name: "Extras CFP draft",
        status: "open",
        createdAt: now,
        updatedAt: now,
      },
      {
        id: TASK_FORM_ID,
        eventId: EVENT_ID,
        kind: "task",
        name: "Portal follow-up",
        status: "open",
        createdAt: now,
        updatedAt: now,
      },
    ]),
    db.insert(formVersions).values([
      {
        id: OPEN_VERSION_ID,
        eventId: EVENT_ID,
        formId: OPEN_FORM_ID,
        versionNumber: 1,
        name: "Published open CFP",
        description: "Immutable public snapshot",
        publishedAt: now,
        createdAt: now,
      },
      {
        id: CLOSED_VERSION_ID,
        eventId: EVENT_ID,
        formId: CLOSED_FORM_ID,
        versionNumber: 1,
        name: "Published closed CFP",
        description: "Closed immutable snapshot",
        publishedAt: now,
        createdAt: now,
      },
      {
        id: RACE_VERSION_ID,
        eventId: EVENT_ID,
        formId: RACE_FORM_ID,
        versionNumber: 1,
        name: "Published race CFP",
        description: "Race immutable snapshot",
        publishedAt: now,
        createdAt: now,
      },
      {
        id: EXTRAS_VERSION_ID,
        eventId: EVENT_ID,
        formId: EXTRAS_FORM_ID,
        versionNumber: 1,
        name: "Published extras form",
        description: "Conditional and date behavior",
        publishedAt: now,
        createdAt: now,
      },
      {
        id: TASK_VERSION_ID,
        eventId: EVENT_ID,
        formId: TASK_FORM_ID,
        versionNumber: 1,
        name: "Published portal follow-up",
        description: "Immutable additional-form snapshot",
        publishedAt: now,
        createdAt: now,
      },
    ]),
  ]);

  const fields = [
    { id: fieldIds.title, order: 1, type: "text", label: "Proposal title", semanticKey: "submissionTitle" as const, required: true },
    { id: fieldIds.abstract, order: 2, type: "textarea", label: "Abstract", semanticKey: "submissionAbstract" as const, required: true },
    { id: fieldIds.speakerName, order: 3, type: "text", label: "Speaker name", semanticKey: "speakerName" as const, required: true },
    { id: fieldIds.speakerEmail, order: 4, type: "email", label: "Speaker email", semanticKey: "speakerEmail" as const, required: true },
    {
      id: fieldIds.category,
      order: 5,
      type: "select",
      label: "Track",
      semanticKey: null,
      required: true,
      options: ["Architecture", "Operations"],
      routing: { Architecture: "architecture", Operations: "operations" },
    },
  ];
  for (const versionId of [OPEN_VERSION_ID, CLOSED_VERSION_ID, RACE_VERSION_ID]) {
    await db.insert(formVersionFields).values(fields.map((field) => ({
      ...field,
      id: `${versionId}-${field.id}`,
      sourceFieldId: field.id,
      eventId: EVENT_ID,
      formVersionId: versionId,
      createdAt: now,
    })));
  }

  await db.insert(formVersionFields).values([
    { id: extraFieldIds.title, order: 1, type: "text", label: "Task title", semanticKey: "submissionTitle" as const, required: true, logic: null },
    { id: extraFieldIds.abstract, order: 2, type: "textarea", label: "Abstract", semanticKey: "submissionAbstract" as const, required: true, logic: null },
    { id: extraFieldIds.speakerName, order: 3, type: "text", label: "Speaker name", semanticKey: "speakerName" as const, required: true, logic: null },
    { id: extraFieldIds.consent, order: 4, type: "checkbox", label: "Needs follow-up", semanticKey: null, required: false, logic: null },
    {
      id: extraFieldIds.details,
      order: 5,
      type: "textarea",
      label: "Follow-up details",
      semanticKey: null,
      required: true,
      logic: JSON.stringify({
        action: "show",
        mode: "all",
        conditions: [{ fieldId: extraFieldIds.consent, op: "not_empty" }],
      }),
    },
    { id: extraFieldIds.when, order: 6, type: "date", label: "Preferred date", semanticKey: null, required: false, logic: null },
    {
      id: extraFieldIds.category,
      order: 7,
      type: "select",
      label: "Track",
      semanticKey: null,
      required: true,
      options: ["Validation"],
      routing: { Validation: "validation" },
      logic: null,
    },
  ].map((field) => ({
    ...field,
    id: `${EXTRAS_VERSION_ID}-${field.id}`,
    sourceFieldId: field.id,
    eventId: EVENT_ID,
    formVersionId: EXTRAS_VERSION_ID,
    createdAt: now,
  })));

  await db.insert(formVersionFields).values({
    id: `${TASK_VERSION_ID}-${TASK_FIELD_ID}`,
    sourceFieldId: TASK_FIELD_ID,
    eventId: EVENT_ID,
    formVersionId: TASK_VERSION_ID,
    order: 1,
    type: "text",
    label: "Follow-up notes",
    required: true,
    createdAt: now,
  });

  await db.batch([
    db.insert(submissions).values({
      id: "submission-seeded-accepted",
      eventId: EVENT_ID,
      formId: OPEN_FORM_ID,
      formVersionId: OPEN_VERSION_ID,
      title: "Seeded accepted proposal",
      category: "seed-category",
      status: "accepted",
      submittedAt: new Date(NOW - 5_000),
      acceptedAt: new Date(NOW - 1_000),
      createdAt: new Date(NOW - 5_000),
      updatedAt: new Date(NOW - 1_000),
    }),
    db.insert(speakers).values({
      id: "speaker-seeded",
      eventId: EVENT_ID,
      userId: owner.userId,
      displayName: "Seeded Speaker",
      title: "Principal Engineer",
      company: "Latticework Systems",
      createdAt: now,
      updatedAt: now,
    }),
    db.insert(submissionSpeakers).values({
      id: "submission-speaker-seeded",
      eventId: EVENT_ID,
      submissionId: "submission-seeded-accepted",
      speakerId: "speaker-seeded",
      isPrimary: true,
      createdAt: now,
    }),
    db.insert(acceptanceEvents).values({
      id: "acceptance-submit-seeded",
      eventId: EVENT_ID,
      submissionId: "submission-seeded-accepted",
      primarySubmissionSpeakerId: "submission-speaker-seeded",
      primarySpeakerId: "speaker-seeded",
      primaryAssociationIsPrimary: true,
      type: "accepted",
      submissionVersion: 1,
      actorUserId: owner.userId,
      occurredAt: new Date(NOW - 1_000),
    }),
    db.insert(speakerProvisioning).values({
      id: "provisioning-submit-seeded",
      eventId: EVENT_ID,
      acceptanceEventId: "acceptance-submit-seeded",
      submissionId: "submission-seeded-accepted",
      primarySpeakerId: "speaker-seeded",
      status: "provisioned",
      availableAt: new Date(NOW - 1_000),
      provisionedAt: new Date(NOW - 500),
      createdAt: new Date(NOW - 1_000),
      updatedAt: new Date(NOW - 500),
    }),
    db.insert(reviewRounds).values({
      id: "review-round-submit",
      eventId: EVENT_ID,
      name: "Submit review round",
      order: 1,
      status: "active",
      createdAt: now,
      updatedAt: now,
    }),
    db.insert(reviewAssignments).values({
      id: "review-assignment-submit",
      eventId: EVENT_ID,
      roundId: "review-round-submit",
      submissionId: "submission-seeded-accepted",
      reviewerUserId: reviewer.userId,
      createdAt: now,
      updatedAt: now,
    }),
  ]);
});

describe("submit operation descriptors", () => {
  it("owns only submit operations and the frozen routes", () => {
    expect(operations.map((operation) => operation.id)).toEqual([
      "submit.create",
      "submit.createTask",
      "submit.getOwn",
      "submit.getPublicForm",
      "submit.getTaskForm",
      "submit.list",
      "submit.updateOwnAbstract",
    ]);
    expect(operations.map((operation) => "rest" in operation ? [operation.rest.method, operation.rest.path] : null)).toEqual([
      ["post", "/public/events/:eventSlug/forms/:formId/submissions"],
      ["post", "/events/:eventId/portal/forms/:formId/submissions"],
      ["get", "/events/by-slug/:eventSlug/my-submissions"],
      ["get", "/public/events/:eventSlug/forms/:formId"],
      ["get", "/events/:eventId/portal/forms/:formId"],
      ["get", "/events/:eventId/submissions"],
      ["put", "/events/by-slug/:eventSlug/my-submissions/:submissionId/abstract"],
    ]);
    expect(operations.filter((operation) => "mcp" in operation).map((operation) => operation.mcp.name)).toEqual([
      "submit_list",
    ]);
  });
});

describe("public submission creation", () => {
  it("creates a real routed submission, immutable answers, primary speaker, and evidence", async () => {
    const input = submissionInput("submit-create-public-001");
    const output = await runPublic(createPublicSubmission(input));
    const db = drizzle(env.DB);
    const [submission] = await db.select().from(submissions).where(eq(submissions.id, output.submissionId));
    const answers = await db.select().from(submissionAnswers).where(eq(submissionAnswers.submissionId, output.submissionId));
    const [speaker] = await db
      .select({ name: speakers.displayName })
      .from(submissionSpeakers)
      .innerJoin(speakers, and(eq(speakers.eventId, submissionSpeakers.eventId), eq(speakers.id, submissionSpeakers.speakerId)))
      .where(eq(submissionSpeakers.submissionId, output.submissionId));
    const [change] = await db.select().from(domainChanges).where(eq(domainChanges.aggregateId, output.submissionId));
    const [audit] = await db.select().from(auditLog).where(eq(auditLog.resourceId, output.submissionId));

    expect(submission).toMatchObject({
      formVersionId: OPEN_VERSION_ID,
      title: "Effect at the edge",
      category: "architecture",
      status: "submitted",
    });
    expect(answers).toHaveLength(5);
    expect(speaker?.name).toBe("Sam Rivera");
    expect(change).toMatchObject({ eventType: "submit.created", idempotencyRecordId: expect.any(String) });
    expect(audit).toMatchObject({ action: "submit.create", actorUserId: null, actorApiKeyId: null });
  });

  it("creates trimmed primary and repeatable co-speaker snapshots atomically and replays without duplicates", async () => {
    const input: CreatePublicSubmissionInput = {
      ...submissionInput("submit-co-speakers-001", OPEN_FORM_ID, "A panel with co-speakers"),
      primarySpeakerTitle: "  Staff Engineer  ",
      primarySpeakerOrganization: "  Open Systems  ",
      coSpeakers: [
        { name: "  Alex Chen  ", email: " ALEX@example.com ", title: "  Principal  ", organization: "  Acme Labs  " },
        { name: "Jordan Patel", title: "Designer", organization: "Studio North" },
      ],
    };
    const first = await runPublic(createPublicSubmission(input));
    const replay = await runPublic(createPublicSubmission(input));
    expect(replay).toEqual(first);

    const db = drizzle(env.DB);
    const associations = await db
      .select({
        associationId: submissionSpeakers.id,
        speakerId: speakers.id,
        name: speakers.displayName,
        contactEmail: speakers.contactEmail,
        title: speakers.title,
        organization: speakers.company,
        isPrimary: submissionSpeakers.isPrimary,
        titleAtTime: submissionSpeakers.titleAtTime,
        organizationAtTime: submissionSpeakers.organizationAtTime,
      })
      .from(submissionSpeakers)
      .innerJoin(speakers, and(eq(speakers.eventId, submissionSpeakers.eventId), eq(speakers.id, submissionSpeakers.speakerId)))
      .where(eq(submissionSpeakers.submissionId, first.submissionId));
    expect(associations).toHaveLength(3);
    expect(associations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: "Sam Rivera",
        contactEmail: "sam@example.com",
        title: "Staff Engineer",
        organization: "Open Systems",
        isPrimary: true,
        titleAtTime: "Staff Engineer",
        organizationAtTime: "Open Systems",
      }),
      expect.objectContaining({
        name: "Alex Chen",
        contactEmail: "alex@example.com",
        title: "Principal",
        organization: "Acme Labs",
        isPrimary: false,
        titleAtTime: "Principal",
        organizationAtTime: "Acme Labs",
      }),
      expect.objectContaining({
        name: "Jordan Patel",
        contactEmail: null,
        title: "Designer",
        organization: "Studio North",
        isPrimary: false,
        titleAtTime: "Designer",
        organizationAtTime: "Studio North",
      }),
    ]));

    await Promise.all(associations.map((association) =>
      db.update(speakers).set({ title: "Changed", company: "Changed" }).where(eq(speakers.id, association.speakerId))));
    const frozen = await db
      .select({ titleAtTime: submissionSpeakers.titleAtTime, organizationAtTime: submissionSpeakers.organizationAtTime })
      .from(submissionSpeakers)
      .where(eq(submissionSpeakers.submissionId, first.submissionId));
    expect(frozen).toEqual(expect.arrayContaining([
      { titleAtTime: "Staff Engineer", organizationAtTime: "Open Systems" },
      { titleAtTime: "Principal", organizationAtTime: "Acme Labs" },
      { titleAtTime: "Designer", organizationAtTime: "Studio North" },
    ]));
  });

  it("rejects normalized duplicate co-speaker emails, including the primary speaker, before reserving rows", async () => {
    const db = drizzle(env.DB);
    const before = await Promise.all([
      db.select({ id: submissions.id }).from(submissions),
      db.select({ id: speakers.id }).from(speakers),
      db.select({ id: submissionSpeakers.id }).from(submissionSpeakers),
    ]);
    const result = await runPublic(createPublicSubmission({
      ...submissionInput("submit-co-speakers-duplicate-001"),
      coSpeakers: [{ name: "Alex Chen", email: " SAM@EXAMPLE.COM " }],
    }).pipe(Effect.either));
    expect(result._tag).toBe("Left");
    if (result._tag === "Left") {
      expect(result.left).toMatchObject({ _tag: "Validation", message: "Each speaker email must be unique." });
    }
    expect(await Promise.all([
      db.select({ id: submissions.id }).from(submissions),
      db.select({ id: speakers.id }).from(speakers),
      db.select({ id: submissionSpeakers.id }).from(submissionSpeakers),
    ])).toEqual(before);
  });

  it("scopes a speaker dashboard by signed-in email and edits the canonical abstract while the CFP is open", async () => {
    const created = await runPublic(createPublicSubmission(submissionInput(
      "submit-own-dashboard-create-001",
      OPEN_FORM_ID,
      "A speaker-owned proposal",
    )));
    const owned = await runAs(submittingSpeaker, getOwnSubmissions({ eventSlug: EVENT_SLUG }));
    expect(owned.event).toMatchObject({ slug: EVENT_SLUG, name: "Submit behavior tests" });
    expect(owned.submissions.find((submission) => submission.id === created.submissionId)).toMatchObject({
      title: "A speaker-owned proposal",
      abstract: "A proposal grounded in real immutable answers.",
      status: "submitted",
      editable: true,
      version: 1,
    });

    const outsiderView = await runAs(outsider, getOwnSubmissions({ eventSlug: EVENT_SLUG }));
    expect(outsiderView.submissions.map((submission) => submission.id)).not.toContain(created.submissionId);

    const input = {
      eventSlug: EVENT_SLUG,
      submissionId: created.submissionId,
      abstract: "An edited abstract from the submitting account.",
      expectedVersion: 1,
      idempotencyKey: "submit-own-dashboard-update-001",
    };
    const updated = await runAs(submittingSpeaker, updateOwnSubmissionAbstract(input));
    const replayed = await runAs(submittingSpeaker, updateOwnSubmissionAbstract(input));
    expect(updated).toMatchObject({
      submission: { id: created.submissionId, abstract: input.abstract, version: 2, editable: true },
      idempotent: false,
    });
    expect(replayed).toMatchObject({ submission: { version: 2 }, idempotent: true });

    const db = drizzle(env.DB);
    const [storedAbstract] = await db
      .select({ value: submissionAnswers.value, answerVersion: submissionAnswers.version })
      .from(submissionAnswers)
      .innerJoin(formVersionFields, eq(formVersionFields.id, submissionAnswers.formVersionFieldId))
      .where(and(
        eq(submissionAnswers.submissionId, created.submissionId),
        eq(formVersionFields.semanticKey, "submissionAbstract"),
      ));
    expect(storedAbstract).toEqual({ value: input.abstract, answerVersion: 2 });
    const unauthorized = await runEitherAs(outsider, updateOwnSubmissionAbstract({
      ...input,
      expectedVersion: 2,
      idempotencyKey: "submit-own-dashboard-outsider-001",
    }));
    expect(unauthorized._tag).toBe("Left");
    if (unauthorized._tag === "Left") expect(unauthorized.left._tag).toBe("Forbidden");
  });

  it("collapses concurrent retries of one speaker edit into a single version", async () => {
    const created = await runPublic(createPublicSubmission(submissionInput(
      "submit-own-dashboard-concurrent-create",
      OPEN_FORM_ID,
      "A concurrently edited proposal",
    )));
    const input = {
      eventSlug: EVENT_SLUG,
      submissionId: created.submissionId,
      abstract: "One durable result from two network retries.",
      expectedVersion: 1,
      idempotencyKey: "submit-own-dashboard-concurrent-update",
    } as const;
    const results = await Promise.all([
      runAs(submittingSpeaker, updateOwnSubmissionAbstract(input)),
      runAs(submittingSpeaker, updateOwnSubmissionAbstract(input)),
    ]);
    expect(results.map((result) => result.idempotent).sort()).toEqual([false, true]);
    expect(new Set(results.map((result) => result.submission.version))).toEqual(new Set([2]));
    const db = drizzle(env.DB);
    const [stored] = await db.select({ version: submissions.version }).from(submissions).where(eq(submissions.id, created.submissionId));
    expect(stored?.version).toBe(2);
  });

  it("passes only a bounded Turnstile token and trusted request metadata to the abuse boundary", async () => {
    const input = { ...submissionInput("submit-abuse-boundary-001"), turnstileToken: undefined };
    let observed: PublicSubmissionAbuseAttempt | null = null;
    const result = await runPublicWithAbuse(
      createPublicSubmission(input).pipe(Effect.either),
      (attempt) => {
        observed = attempt;
        return attempt.turnstileToken
          ? Effect.void
          : Effect.fail(new Validation({ message: "Complete the human verification challenge and try again." }));
      },
    );
    expect(result._tag).toBe("Left");
    expect(observed).toEqual({
      eventId: EVENT_ID,
      formId: OPEN_FORM_ID,
      normalizedEmail: "sam@example.com",
      turnstileToken: undefined,
      remoteIp: "198.51.100.7",
    });
  });

  it("renders the immutable closed snapshot but rejects creation without writes", async () => {
    const form = await runPublic(getPublicSubmissionForm({ eventSlug: EVENT_SLUG, formId: CLOSED_FORM_ID }));
    expect(form.form).toMatchObject({
      versionId: CLOSED_VERSION_ID,
      name: "Published closed CFP",
      availability: "closed",
    });
    expect(form.form.fields.every((field) => !("semanticKey" in field) && !("routing" in field))).toBe(true);

    const input = submissionInput("submit-closed-public-001", CLOSED_FORM_ID);
    const result = await runPublic(createPublicSubmission(input).pipe(Effect.either));
    expect(result._tag).toBe("Left");
    if (result._tag === "Left") expect(result.left).toMatchObject({ _tag: "Validation", message: "This form is not accepting submissions." });
    const db = drizzle(env.DB);
    const rows = await db.select().from(submissions).where(eq(submissions.formId, CLOSED_FORM_ID));
    expect(rows).toEqual([]);
  });

  it("returns only CFP forms publicly and rejects task-form reads before producer writes", async () => {
    const cfp = await runPublic(getPublicSubmissionForm({ eventSlug: EVENT_SLUG, formId: OPEN_FORM_ID }));
    expect(cfp.form).toMatchObject({
      versionId: OPEN_VERSION_ID,
      name: "Published open CFP",
      availability: "open",
    });
    const taskRead = await runPublic(
      getPublicSubmissionForm({ eventSlug: EVENT_SLUG, formId: TASK_FORM_ID }).pipe(Effect.either),
    );
    expect(taskRead._tag).toBe("Left");
    if (taskRead._tag === "Left") {
      expect(taskRead.left).toMatchObject({ _tag: "NotFound", entity: "published CFP form" });
    }
    const db = drizzle(env.DB);
    const producerCounts = async () => {
      const [submissionRows, speakerRows, answerRows, speakerLinkRows, idempotencyRows, changeRows, auditRows] =
        await Promise.all([
          db.select({ id: submissions.id }).from(submissions),
          db.select({ id: speakers.id }).from(speakers),
          db.select({ id: submissionAnswers.id }).from(submissionAnswers),
          db.select({ id: submissionSpeakers.id }).from(submissionSpeakers),
          db.select({ id: idempotencyRecords.id }).from(idempotencyRecords),
          db.select({ id: domainChanges.id }).from(domainChanges),
          db.select({ id: auditLog.id }).from(auditLog),
        ]);
      return {
        submissions: submissionRows.length,
        speakers: speakerRows.length,
        answers: answerRows.length,
        speakerLinks: speakerLinkRows.length,
        idempotency: idempotencyRows.length,
        changes: changeRows.length,
        audits: auditRows.length,
      };
    };
    const before = await producerCounts();
    const result = await runPublic(createPublicSubmission(taskInput()).pipe(Effect.either));

    expect(result._tag).toBe("Left");
    if (result._tag === "Left") {
      expect(result.left).toMatchObject({
        _tag: "Validation",
        message: "Public submissions are only available for CFP forms.",
      });
    }
    expect(await producerCounts()).toEqual(before);
    expect(await db.select().from(submissions).where(eq(submissions.formId, TASK_FORM_ID))).toEqual([]);
  });

  it("maps anonymous task-form reads to not found over public HTTP", async () => {
    const app = new Hono<AppHono>();
    const rest = getPublicSubmissionFormOperation.rest;
    app.get(`/api/v1${rest.path}`, (context) =>
      runRestOperation(context, null, getPublicSubmissionFormOperation, rest.input));

    const response = await app.request(
      `/api/v1/public/events/${EVENT_SLUG}/forms/${TASK_FORM_ID}`,
      undefined,
      env,
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({
      error: "NotFound",
      requestId: expect.any(String),
    });
  });

  it("maps the non-CFP producer validation to the public HTTP response", async () => {
    const app = new Hono<AppHono>();
    const rest = createPublicSubmissionOperation.rest;
    app.post(`/api/v1${rest.path}`, (context) =>
      runRestOperation(context, null, createPublicSubmissionOperation, rest.input));
    const input = taskInput();

    const response = await app.request(
      `/api/v1/public/events/${EVENT_SLUG}/forms/${TASK_FORM_ID}/submissions`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": input.idempotencyKey,
        },
        body: JSON.stringify({ answers: input.answers }),
      },
      env,
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: "Validation",
      message: "Public submissions are only available for CFP forms.",
      requestId: expect.any(String),
    });
  });

  it("replays one creation and rejects reuse with different answers", async () => {
    const input = submissionInput("submit-idempotency-001", OPEN_FORM_ID, "One idempotent proposal");
    const first = await runPublic(createPublicSubmission(input));
    const replay = await runPublic(createPublicSubmission(input));
    expect(replay).toEqual(first);

    const changed = {
      ...input,
      answers: input.answers.map((answer, index) => index === 0 ? { ...answer, value: "Changed proposal" } : answer),
    };
    const conflict = await runPublic(createPublicSubmission(changed).pipe(Effect.either));
    expect(conflict._tag).toBe("Left");
    if (conflict._tag === "Left") expect(conflict.left).toMatchObject({ _tag: "Conflict" });

    const db = drizzle(env.DB);
    const created = await db.select().from(submissions).where(eq(submissions.id, first.submissionId));
    const evidence = (await db
      .select()
      .from(idempotencyRecords)
      .where(eq(idempotencyRecords.operationId, "submit.create")))
      .filter((record) =>
        typeof record.responseBody === "object"
        && record.responseBody !== null
        && "submissionId" in record.responseBody
        && record.responseBody.submissionId === first.submissionId);
    expect(created).toHaveLength(1);
    expect(evidence).toHaveLength(1);
  });

  it("aborts every write when the form closes between validation and commit", async () => {
    const db = drizzle(env.DB);
    const input = submissionInput("submit-race-status-001", RACE_FORM_ID, "Closed before commit");
    const result = await runPublic(createPublicSubmission(input, {
      beforeCommit: async () => {
        await db.update(forms).set({ status: "closed" }).where(eq(forms.id, RACE_FORM_ID));
      },
    }).pipe(Effect.either));

    expect(result._tag).toBe("Left");
    if (result._tag === "Left") {
      expect(result.left).toMatchObject({ _tag: "Validation", message: "This form is not accepting submissions." });
    }
    const submissionsBefore = await db.select({ id: submissions.id }).from(submissions);
    const [created, evidence, changes, audits, speakerRows] = await Promise.all([
      db.select().from(submissions).where(eq(submissions.formId, RACE_FORM_ID)),
      db.select().from(idempotencyRecords).where(eq(idempotencyRecords.principalId, `public-form:${RACE_FORM_ID}`)),
      db.select().from(domainChanges).where(eq(domainChanges.requestId, "")),
      db.select().from(auditLog).where(eq(auditLog.resourceType, "submission")),
      db.select().from(speakers).where(eq(speakers.displayName, "Sam Rivera")),
    ]);
    const liveSubmissionIds = new Set(submissionsBefore.map((row) => row.id));
    expect(created).toEqual([]);
    expect(evidence).toEqual([]);
    expect(changes).toEqual([]);
    expect(audits.every((audit) => liveSubmissionIds.has(audit.resourceId))).toBe(true);
    expect(speakerRows.every((speaker) => speaker.displayName === "Sam Rivera")).toBe(true);

    await db.update(forms).set({ status: "open" }).where(eq(forms.id, RACE_FORM_ID));
  });

  it("aborts every write when an unchanged close time passes before commit", async () => {
    const db = drizzle(env.DB);
    const closesAt = new Date(Date.now() + 500);
    await db.update(forms).set({ closesAt }).where(eq(forms.id, RACE_FORM_ID));
    let hookRan = false;
    const input = submissionInput("submit-race-closes-001", RACE_FORM_ID, "Expired before commit");
    const result = await runPublic(createPublicSubmission(input, {
      beforeCommit: async () => {
        hookRan = true;
        // This integration check must advance D1's SQLite clock; fake JS timers do not affect SQL `now`.
        await new Promise<void>((resolve) => {
          setTimeout(resolve, Math.max(0, closesAt.getTime() - Date.now() + 100));
        });
      },
    }).pipe(Effect.either));

    expect(hookRan).toBe(true);
    expect(result._tag).toBe("Left");
    if (result._tag === "Left") {
      expect(result.left).toMatchObject({ _tag: "Validation", message: "This form is not accepting submissions." });
    }
    const [created, evidence, form] = await Promise.all([
      db.select().from(submissions).where(eq(submissions.formId, RACE_FORM_ID)),
      db.select().from(idempotencyRecords).where(eq(idempotencyRecords.principalId, `public-form:${RACE_FORM_ID}`)),
      db.select({ closesAt: forms.closesAt }).from(forms).where(eq(forms.id, RACE_FORM_ID)).get(),
    ]);
    expect(created).toEqual([]);
    expect(evidence).toEqual([]);
    expect(form?.closesAt?.getTime()).toBe(closesAt.getTime());

    await db.update(forms).set({ closesAt: null }).where(eq(forms.id, RACE_FORM_ID));
    const recovered = await runPublic(createPublicSubmission(
      submissionInput("submit-race-recovered-001", RACE_FORM_ID, "Committed after reopen"),
    ));
    const [row] = await db.select().from(submissions).where(eq(submissions.id, recovered.submissionId));
    expect(row).toMatchObject({ formId: RACE_FORM_ID, title: "Committed after reopen", status: "submitted" });
  });

  it("treats an unchecked checkbox as empty for dependent visibility", async () => {
    const unchecked = await runPublic(createPublicSubmission(extrasInput("submit-checkbox-false-001", [
      { fieldId: extraFieldIds.consent, value: "false" },
    ])));
    const db = drizzle(env.DB);
    const storedAnswers = await db
      .select()
      .from(submissionAnswers)
      .where(eq(submissionAnswers.submissionId, unchecked.submissionId));
    expect(storedAnswers.some(
      (answer) => answer.formVersionFieldId === `${EXTRAS_VERSION_ID}-${extraFieldIds.details}`,
    )).toBe(false);

    const hidden = await runPublic(createPublicSubmission(extrasInput("submit-checkbox-false-002", [
      { fieldId: extraFieldIds.consent, value: "false" },
      { fieldId: extraFieldIds.details, value: "Should not be accepted." },
    ])).pipe(Effect.either));
    expect(hidden._tag).toBe("Left");
    if (hidden._tag === "Left") {
      expect(hidden.left).toMatchObject({ _tag: "Validation", message: "Follow-up details is not currently visible." });
    }

    const checkedMissing = await runPublic(createPublicSubmission(extrasInput("submit-checkbox-true-001", [
      { fieldId: extraFieldIds.consent, value: "true" },
    ])).pipe(Effect.either));
    expect(checkedMissing._tag).toBe("Left");
    if (checkedMissing._tag === "Left") {
      expect(checkedMissing.left).toMatchObject({ _tag: "Validation", message: "Follow-up details is required." });
    }
  });

  it("rejects impossible calendar dates and accepts real ones", async () => {
    const impossible = await runPublic(createPublicSubmission(extrasInput("submit-date-invalid-001", [
      { fieldId: extraFieldIds.when, value: "2026-02-31" },
    ])).pipe(Effect.either));
    expect(impossible._tag).toBe("Left");
    if (impossible._tag === "Left") {
      expect(impossible.left).toMatchObject({ _tag: "Validation", message: "Preferred date must be a real calendar date." });
    }

    const outOfRange = await runPublic(createPublicSubmission(extrasInput("submit-date-invalid-002", [
      { fieldId: extraFieldIds.when, value: "2026-13-01" },
    ])).pipe(Effect.either));
    expect(outOfRange._tag).toBe("Left");

    const valid = await runPublic(createPublicSubmission(extrasInput("submit-date-valid-001", [
      { fieldId: extraFieldIds.when, value: "2026-02-28" },
    ])));
    const db = drizzle(env.DB);
    const storedAnswers = await db
      .select()
      .from(submissionAnswers)
      .where(eq(submissionAnswers.submissionId, valid.submissionId));
    expect(storedAnswers.some((answer) => answer.value === "2026-02-28")).toBe(true);
  });
});

describe("provisioned speaker task-form submission", () => {
  it("loads a task form only for the exact currently provisioned speaker", async () => {
    const form = await runAs(owner, getTaskSubmissionForm({ eventId: EVENT_ID, formId: TASK_FORM_ID }));
    expect(form.form).toMatchObject({
      id: TASK_FORM_ID,
      versionId: TASK_VERSION_ID,
      name: "Published portal follow-up",
    });
    expect(form.turnstileSiteKey).toBeNull();

    const outsiderResult = await runEitherAs(
      outsider,
      getTaskSubmissionForm({ eventId: EVENT_ID, formId: TASK_FORM_ID }),
    );
    expect(outsiderResult).toMatchObject({ _tag: "Left", left: { _tag: "Forbidden" } });

    const cfpResult = await runEitherAs(
      owner,
      getTaskSubmissionForm({ eventId: EVENT_ID, formId: OPEN_FORM_ID }),
    );
    expect(cfpResult).toMatchObject({
      _tag: "Left",
      left: { _tag: "NotFound", entity: "published task form" },
    });

    const db = drizzle(env.DB);
    await db
      .update(speakerProvisioning)
      .set({ status: "revoked" })
      .where(eq(speakerProvisioning.id, "provisioning-submit-seeded"));
    try {
      const revokedResult = await runEitherAs(
        owner,
        getTaskSubmissionForm({ eventId: EVENT_ID, formId: TASK_FORM_ID }),
      );
      expect(revokedResult).toMatchObject({ _tag: "Left", left: { _tag: "Forbidden" } });
    } finally {
      await db
        .update(speakerProvisioning)
        .set({ status: "provisioned" })
        .where(eq(speakerProvisioning.id, "provisioning-submit-seeded"));
    }
  });

  it("stores immutable answers against the exact existing speaker with actor evidence", async () => {
    const db = drizzle(env.DB);
    const speakerCountBefore = (await db.select({ id: speakers.id }).from(speakers)).length;
    const output = await runAs(owner, createTaskSubmission(taskSpeakerInput()));
    const [submission] = await db.select().from(submissions).where(eq(submissions.id, output.submissionId));
    const [association] = await db
      .select()
      .from(submissionSpeakers)
      .where(eq(submissionSpeakers.submissionId, output.submissionId));
    const answers = await db
      .select()
      .from(submissionAnswers)
      .where(eq(submissionAnswers.submissionId, output.submissionId));
    const [change] = await db.select().from(domainChanges).where(eq(domainChanges.aggregateId, output.submissionId));
    const [audit] = await db.select().from(auditLog).where(eq(auditLog.resourceId, output.submissionId));

    expect(submission).toMatchObject({
      eventId: EVENT_ID,
      formId: TASK_FORM_ID,
      formVersionId: TASK_VERSION_ID,
      title: "Published portal follow-up",
      category: null,
      status: "submitted",
    });
    expect(association).toMatchObject({
      speakerId: "speaker-seeded",
      isPrimary: true,
      titleAtTime: "Principal Engineer",
      organizationAtTime: "Latticework Systems",
    });
    expect(answers).toHaveLength(1);
    expect(answers[0]).toMatchObject({
      formVersionId: TASK_VERSION_ID,
      formVersionFieldId: `${TASK_VERSION_ID}-${TASK_FIELD_ID}`,
      value: "Portal follow-up details",
    });
    expect((await db.select({ id: speakers.id }).from(speakers))).toHaveLength(speakerCountBefore);
    expect(change).toMatchObject({
      eventType: "submit.created",
      actorUserId: owner.userId,
      audiences: [{ kind: "admins" }, { kind: "speaker", speakerIds: ["speaker-seeded"] }],
    });
    expect(audit).toMatchObject({ action: "submit.createTask", actorUserId: owner.userId });
  });

  it("replays by speaker and rejects the same key with changed answers", async () => {
    const input = taskSpeakerInput("submit-task-idempotent-001", "First answer");
    const first = await runAs(owner, createTaskSubmission(input));
    expect(await runAs(owner, createTaskSubmission(input))).toEqual(first);

    const conflict = await runAs(
      owner,
      createTaskSubmission(taskSpeakerInput("submit-task-idempotent-001", "Changed answer")).pipe(Effect.either),
    );
    expect(conflict._tag).toBe("Left");
    if (conflict._tag === "Left") expect(conflict.left).toMatchObject({ _tag: "Conflict" });

    const db = drizzle(env.DB);
    expect(await db.select().from(idempotencyRecords).where(and(
      eq(idempotencyRecords.operationId, "submit.createTask"),
      eq(idempotencyRecords.principalId, `speaker:speaker-seeded:form:${TASK_FORM_ID}`),
    ))).toHaveLength(2);
    expect(await db.select().from(submissions).where(and(
      eq(submissions.formId, TASK_FORM_ID),
      eq(submissions.id, first.submissionId),
    ))).toHaveLength(1);
  });

  it("requires the exact session-linked currently provisioned speaker", async () => {
    const outsiderResult = await runAs(
      outsider,
      createTaskSubmission(taskSpeakerInput("submit-task-outsider-001")).pipe(Effect.either),
    );
    expect(outsiderResult._tag).toBe("Left");
    if (outsiderResult._tag === "Left") expect(outsiderResult.left).toMatchObject({ _tag: "Forbidden" });

    const db = drizzle(env.DB);
    await db
      .update(speakerProvisioning)
      .set({ status: "revoked" })
      .where(eq(speakerProvisioning.id, "provisioning-submit-seeded"));
    try {
      const revokedResult = await runAs(
        owner,
        createTaskSubmission(taskSpeakerInput("submit-task-revoked-001")).pipe(Effect.either),
      );
      expect(revokedResult._tag).toBe("Left");
      if (revokedResult._tag === "Left") expect(revokedResult.left).toMatchObject({ _tag: "Forbidden" });
    } finally {
      await db
        .update(speakerProvisioning)
        .set({ status: "provisioned" })
        .where(eq(speakerProvisioning.id, "provisioning-submit-seeded"));
    }
  });

  it("re-checks current acceptance inside the commit and leaves no partial evidence", async () => {
    const db = drizzle(env.DB);
    const input = taskSpeakerInput("submit-task-provisioning-race-001", "Race answer");
    const result = await runAs(owner, createTaskSubmission(input, {
      beforeCommit: async () => {
        await db.insert(acceptanceEvents).values({
          id: "acceptance-submit-race-revoked",
          eventId: EVENT_ID,
          submissionId: "submission-seeded-accepted",
          primarySubmissionSpeakerId: "submission-speaker-seeded",
          primarySpeakerId: "speaker-seeded",
          primaryAssociationIsPrimary: true,
          type: "revoked",
          submissionVersion: 2,
          actorUserId: owner.userId,
          occurredAt: new Date(NOW + 1_000),
        });
      },
    }).pipe(Effect.either));
    expect(result._tag).toBe("Left");
    if (result._tag === "Left") expect(result.left).toMatchObject({ _tag: "Forbidden" });
    expect(await db.select().from(idempotencyRecords).where(and(
      eq(idempotencyRecords.operationId, "submit.createTask"),
      eq(idempotencyRecords.principalId, `speaker:speaker-seeded:form:${TASK_FORM_ID}`),
    ))).toHaveLength(2);
    expect(await db.select().from(submissions).where(and(
      eq(submissions.formId, TASK_FORM_ID),
      eq(submissions.title, "Published portal follow-up"),
    ))).toHaveLength(2);

    await db
      .delete(acceptanceEvents)
      .where(eq(acceptanceEvents.id, "acceptance-submit-race-revoked"));
    const recovered = await runAs(owner, createTaskSubmission(input));
    expect(recovered.status).toBe("submitted");
  });

  it("rejects CFP forms and maps the authenticated REST operation", async () => {
    const cfpResult = await runAs(owner, createTaskSubmission({
      eventId: EVENT_ID,
      formId: OPEN_FORM_ID,
      idempotencyKey: "submit-task-cfp-001",
      answers: submissionInput("submit-task-cfp-source-001").answers,
    }).pipe(Effect.either));
    expect(cfpResult._tag).toBe("Left");
    if (cfpResult._tag === "Left") {
      expect(cfpResult.left).toMatchObject({
        _tag: "Validation",
        message: "Speaker task submissions are only available for task forms.",
      });
    }

    const app = new Hono<AppHono>();
    const rest = createTaskSubmissionOperation.rest;
    app.post(`/api/v1${rest.path}`, (context) =>
      runRestOperation(context, owner, createTaskSubmissionOperation, rest.input));
    const input = taskSpeakerInput("submit-task-http-001", "Submitted over REST");
    const response = await app.request(
      `/api/v1/events/${EVENT_ID}/portal/forms/${TASK_FORM_ID}/submissions`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": input.idempotencyKey,
        },
        body: JSON.stringify({ answers: input.answers }),
      },
      env,
    );
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      submissionId: expect.any(String),
      status: "submitted",
      submittedAt: expect.any(Number),
    });
  });
});

describe("organizer submission privacy and listing", () => {
  it("denies non-members and cross-event API keys", async () => {
    for (const principal of [outsider, wrongEventApiKey]) {
      const result = await runAs(principal, listSubmissions({ eventId: EVENT_ID, page: 1, pageSize: 25 }).pipe(Effect.either));
      expect(result._tag).toBe("Left");
      if (result._tag === "Left") expect(result.left).toMatchObject({ _tag: "Forbidden" });
    }
  });
  it("lets reviewers list only their assigned submissions", async () => {
    const page = await runAs(reviewer, listSubmissions({
      eventId: EVENT_ID,
      page: 1,
      pageSize: 25,
    }));
    expect(page.pagination).toEqual({ page: 1, pageSize: 25, total: 1, pageCount: 1 });
    expect(page.categories).toEqual(["seed-category"]);
    expect(page.results.map((submission) => submission.id)).toEqual(["submission-seeded-accepted"]);
    expect(page.results[0]).toMatchObject({
      title: "Seeded accepted proposal",
      status: "accepted",
      primarySpeakerName: "Seeded Speaker",
    });
    expect("answers" in page.results[0]!).toBe(false);
    expect("speakerEmail" in page.results[0]!).toBe(false);
  });


  it("lists and filters real organizer-visible submission state without private answers", async () => {
    const page = await runAs(owner, listSubmissions({
      eventId: EVENT_ID,
      status: "accepted",
      category: "seed-category",
      page: 1,
      pageSize: 25,
    }));
    expect(page.pagination).toEqual({ page: 1, pageSize: 25, total: 1, pageCount: 1 });
    expect(page.categories).toEqual(["architecture", "seed-category", "validation"]);
    expect(page.results).toEqual([{
      id: "submission-seeded-accepted",
      formId: OPEN_FORM_ID,
      formName: "Published open CFP",
      title: "Seeded accepted proposal",
      category: "seed-category",
      status: "accepted",
      primarySpeakerName: "Seeded Speaker",
      submittedAt: NOW - 5_000,
      version: 1,
    }]);
    expect("answers" in page.results[0]!).toBe(false);
    expect("speakerEmail" in page.results[0]!).toBe(false);
  });
});

describe("submission Airtable outbox", () => {
  it("atomically bootstraps the new speaker and submission projections", async () => {
    const db = drizzle(env.DB);
    const integrationId = "airtable-submit-outbox";
    const integrationNow = new Date(NOW);
    await db.insert(integrations).values({
      id: integrationId,
      eventId: EVENT_ID,
      kind: "airtable",
      secretRef: "AIRTABLE_PAT",
      config: {},
      createdAt: integrationNow,
      updatedAt: integrationNow,
    });
    const output = await runPublic(createPublicSubmission(
      submissionInput("submit-airtable-outbox-001", OPEN_FORM_ID, "Transactional sync proof"),
    ));
    const rows = await db.select().from(airtableOutbox).where(eq(airtableOutbox.integrationId, integrationId));

    expect(rows).toHaveLength(2);
    expect(rows).toEqual(expect.arrayContaining([
      expect.objectContaining({
        entityType: "speaker",
        changedFields: expect.objectContaining({ displayName: "Sam Rivera", visible: true }),
        status: "pending",
      }),
      expect.objectContaining({
        entityType: "submission",
        entityId: output.submissionId,
        changedFields: expect.objectContaining({
          title: "Transactional sync proof",
          abstract: "A proposal grounded in real immutable answers.",
          status: "submitted",
        }),
        status: "pending",
      }),
    ]));
  });
});
