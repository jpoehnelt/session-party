import { applyD1Migrations, env, type D1Migration } from "cloudflare:test";
import type { Principal } from "contracts/principal";
import {
  auditLog,
  domainChanges,
  eventMembers,
  events,
  formVersionFields,
  formVersions,
  forms,
  idempotencyRecords,
  reviewAssignments,
  reviewRounds,
  speakers,
  submissionAnswers,
  submissionSpeakers,
  submissions,
  users,
} from "contracts/schema";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { Effect, Layer } from "effect";
import { beforeAll, describe, expect, it } from "vitest";
import { AppLayer, CurrentUser } from "@/server/services";
import { operations } from "./operations";
import type { CreatePublicSubmissionInput } from "./schema";
import { createPublicSubmission, getPublicSubmissionForm, listSubmissions } from "./service";

type TestEnv = Cloudflare.Env & { readonly TEST_MIGRATIONS: readonly D1Migration[] };
const EVENT_ID = "event-submit-tests";
const EVENT_SLUG = "submit-tests";
const OPEN_FORM_ID = "form-submit-open";
const OPEN_VERSION_ID = "form-submit-open-v1";
const CLOSED_FORM_ID = "form-submit-closed";
const CLOSED_VERSION_ID = "form-submit-closed-v1";
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

const fieldIds = {
  title: "submit-field-title",
  abstract: "submit-field-abstract",
  speakerName: "submit-field-speaker-name",
  speakerEmail: "submit-field-speaker-email",
  category: "submit-field-category",
} as const;

const submissionInput = (
  idempotencyKey: string,
  formId = OPEN_FORM_ID,
  title = "Effect at the edge",
): CreatePublicSubmissionInput => {
  const versionId = formId === CLOSED_FORM_ID ? CLOSED_VERSION_ID : OPEN_VERSION_ID;
  return {
    eventSlug: EVENT_SLUG,
    formId,
    idempotencyKey,
    answers: [
      { fieldId: `${versionId}-${fieldIds.title}`, value: title },
      { fieldId: `${versionId}-${fieldIds.abstract}`, value: "A proposal grounded in real immutable answers." },
      { fieldId: `${versionId}-${fieldIds.speakerName}`, value: "Sam Rivera" },
      { fieldId: `${versionId}-${fieldIds.speakerEmail}`, value: "sam@example.com" },
      { fieldId: `${versionId}-${fieldIds.category}`, value: "Architecture" },
    ],
  };
};

const runPublic = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.runPromise(effect.pipe(Effect.provide(AppLayer(env))) as Effect.Effect<A, E, never>);

const runAs = <A, E, R>(principal: Principal, effect: Effect.Effect<A, E, R>) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(Layer.merge(AppLayer(env), Layer.succeed(CurrentUser, principal))),
    ) as Effect.Effect<A, E, never>,
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
  for (const versionId of [OPEN_VERSION_ID, CLOSED_VERSION_ID]) {
    await db.insert(formVersionFields).values(fields.map((field) => ({
      ...field,
      id: `${versionId}-${field.id}`,
      sourceFieldId: field.id,
      eventId: EVENT_ID,
      formVersionId: versionId,
      createdAt: now,
    })));
  }

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
      displayName: "Seeded Speaker",
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
      "submit.getPublicForm",
      "submit.list",
    ]);
    expect(operations.map((operation) => "rest" in operation ? [operation.rest.method, operation.rest.path] : null)).toEqual([
      ["post", "/public/events/:eventSlug/forms/:formId/submissions"],
      ["get", "/public/events/:eventSlug/forms/:formId"],
      ["get", "/events/:eventId/submissions"],
    ]);
    expect(operations.filter((operation) => "mcp" in operation).map((operation) => operation.mcp.name)).toEqual([
      "submit_get_public_form",
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
});

describe("organizer submission privacy and listing", () => {
  it("denies non-members and cross-event API keys", async () => {
    for (const principal of [outsider, {
      kind: "api-key" as const,
      apiKeyId: "key-submit-wrong-event",
      eventId: "another-event",
      name: "Wrong event key",
      scopes: ["submissions:read" as const],
      expiresAt: NOW + 86_400_000,
    }]) {
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
