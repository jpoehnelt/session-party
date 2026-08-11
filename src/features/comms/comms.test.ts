import { applyD1Migrations, env, runInDurableObject, type D1Migration } from "cloudflare:test";
import type { Principal } from "contracts/principal";
import {
  acceptanceEvents,
  domainChanges,
  emailTemplates,
  eventMembers,
  events,
  formVersions,
  forms,
  idempotencyRecords,
  mailCalendarEvents,
  mailDeliveries,
  mailDeliveryAttempts,
  mailDeliverySnapshots,
  rooms,
  speakers,
  submissions,
  submissionSpeakers,
  talks,
  talkSpeakers,
  users,
} from "contracts/schema";
import * as contractSchema from "contracts/schema";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { Effect, Layer } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { recoverMailScheduler } from "@/server/index";
import { MAIL_SCHEDULER_NAME } from "@/server/party/Scheduler";
import { AppLayer, Authorizer, CurrentUser, Db, MailQueue, type AppDatabase } from "@/server/services";
import {
  enqueueCommunication,
  listAudience,
  listTemplates,
  previewCommunication,
  retryDelivery,
  updateTemplate,
  validateTemplate,
} from "./service";

interface TestEnv extends Cloudflare.Env {
  readonly TEST_MIGRATIONS: readonly D1Migration[];
}

const hasMigrations = (value: Cloudflare.Env): value is TestEnv => "TEST_MIGRATIONS" in value;
const now = new Date("2026-08-08T18:00:00.000Z");

const browserPrincipal = (userId: string, name = "Communications Owner"): Principal => ({
  kind: "browser-session",
  userId,
  email: `${userId}@example.com`,
  name,
  sessionId: `session-${userId}`,
  expiresAt: now.getTime() + 86_400_000,
});

interface MailQueueStub {
  readonly appOrigin: string;
  readonly fromEmail: string;
  readonly wake: () => Effect.Effect<void>;
}

const runAs = <A, E>(
  principal: Principal,
  effect: Effect.Effect<A, E, Authorizer | CurrentUser | Db | MailQueue>,
  mailQueue?: MailQueueStub,
) => {
  const withQueue = mailQueue === undefined ? effect : effect.pipe(Effect.provideService(MailQueue, mailQueue));
  return Effect.runPromise(withQueue.pipe(
    Effect.provide(Layer.merge(AppLayer(env), Layer.succeed(CurrentUser, principal))),
  ));
};

const runEitherAs = <A, E>(
  principal: Principal,
  effect: Effect.Effect<A, E, Authorizer | CurrentUser | Db | MailQueue>,
) =>
  Effect.runPromise(effect.pipe(
    Effect.either,
    Effect.provide(Layer.merge(AppLayer(env), Layer.succeed(CurrentUser, principal))),
  ));

interface SeededCommunication {
  readonly db: AppDatabase;
  readonly eventId: string;
  readonly owner: Principal;
  readonly speakerId: string;
  readonly templateId: string;
  readonly talkId: string;
  readonly roomId: string;
}

const seedCommunication = async (label: string): Promise<SeededCommunication> => {
  const db = drizzle(env.DB, { schema: contractSchema });
  const eventId = `event-comms-${label}`;
  const ownerId = `owner-comms-${label}`;
  const speakerUserId = `speaker-user-comms-${label}`;
  const speakerId = `speaker-comms-${label}`;
  const formId = `form-comms-${label}`;
  const formVersionId = `form-version-comms-${label}`;
  const submissionId = `submission-comms-${label}`;
  const associationId = `association-comms-${label}`;
  const templateId = `template-comms-${label}`;
  const talkId = `talk-comms-${label}`;
  const roomId = `room-comms-${label}`;
  const owner = browserPrincipal(ownerId);

  await db.batch([
    db.insert(users).values([
      { id: ownerId, email: owner.email!, name: owner.name, version: 1, createdAt: now, updatedAt: now },
      { id: speakerUserId, email: `${speakerUserId}@example.com`, name: "Accepted Speaker", version: 1, createdAt: now, updatedAt: now },
    ]),
    db.insert(events).values({
      id: eventId,
      slug: `comms-${label}`,
      name: `Communications ${label}`,
      location: "Main Hall",
      timezone: "America/Los_Angeles",
      startsAt: new Date("2026-08-12T16:00:00.000Z"),
      endsAt: new Date("2026-08-13T00:00:00.000Z"),
      version: 1,
      createdAt: now,
      updatedAt: now,
    }),
    db.insert(eventMembers).values({
      id: `member-comms-${label}`,
      eventId,
      userId: ownerId,
      role: "owner",
      version: 1,
      createdAt: now,
      updatedAt: now,
    }),
    db.insert(forms).values({
      id: formId,
      eventId,
      kind: "cfp",
      name: "Call for proposals",
      status: "closed",
      version: 1,
      createdAt: now,
      updatedAt: now,
    }),
    db.insert(formVersions).values({
      id: formVersionId,
      eventId,
      formId,
      versionNumber: 1,
      name: "Call for proposals",
      publishedAt: now,
      createdAt: now,
    }),
    db.insert(submissions).values({
      id: submissionId,
      eventId,
      formId,
      formVersionId,
      title: "Durable systems without surprises",
      status: "accepted",
      submittedAt: new Date(now.getTime() - 10_000),
      acceptedAt: now,
      version: 2,
      createdAt: now,
      updatedAt: now,
    }),
    db.insert(speakers).values({
      id: speakerId,
      eventId,
      userId: speakerUserId,
      displayName: "Accepted Speaker",
      visible: true,
      version: 1,
      createdAt: now,
      updatedAt: now,
    }),
    db.insert(submissionSpeakers).values({
      id: associationId,
      eventId,
      submissionId,
      speakerId,
      isPrimary: true,
      createdAt: now,
    }),
    db.insert(acceptanceEvents).values({
      id: `acceptance-comms-${label}`,
      eventId,
      submissionId,
      primarySubmissionSpeakerId: associationId,
      primarySpeakerId: speakerId,
      primaryAssociationIsPrimary: true,
      type: "accepted",
      submissionVersion: 2,
      actorUserId: ownerId,
      occurredAt: now,
    }),
    db.insert(rooms).values({
      id: roomId,
      eventId,
      name: "Main Stage",
      order: 1,
      version: 1,
      createdAt: now,
      updatedAt: now,
    }),
    db.insert(talks).values({
      id: talkId,
      eventId,
      submissionId,
      title: "Durable systems without surprises",
      roomId,
      startsAt: new Date("2026-08-12T18:30:00.000Z"),
      durationMin: 30,
      status: "confirmed",
      version: 1,
      createdAt: now,
      updatedAt: now,
    }),
    db.insert(talkSpeakers).values({
      id: `talk-speaker-comms-${label}`,
      eventId,
      talkId,
      speakerId,
      createdAt: now,
    }),
    db.insert(emailTemplates).values({
      id: templateId,
      eventId,
      name: "Acceptance note",
      subject: "Welcome, {{speaker.name}}",
      body: "Your session {{talk.title}} is accepted for {{event.name}} at {{event.location}}.",
      attachIcs: false,
      version: 1,
      createdAt: now,
      updatedAt: now,
    }),
  ]);

  return { db, eventId, owner, speakerId, templateId, talkId, roomId };
};

const publishAgenda = async (
  seeded: SeededCommunication,
  revision: number,
  startsAt: Date,
  room: string,
  publishedAt: Date,
  title = "Durable systems without surprises",
  roomId = seeded.roomId,
) => {
  await seeded.db.batch([
    seeded.db.insert(domainChanges).values({
      id: `agenda-publication-${seeded.eventId}-${revision}`,
      eventId: seeded.eventId,
      aggregateType: "agenda-publication",
      aggregateId: seeded.eventId,
      aggregateVersion: revision,
      eventType: "agenda/published",
      audiences: [{ kind: "public" }],
      payload: {
        eventId: seeded.eventId,
        eventName: `Communications ${seeded.eventId.replace("event-comms-", "")}`,
        eventSlug: seeded.eventId.replace("event-", ""),
        timezone: "America/Los_Angeles",
        location: "Main Hall",
        revision,
        publishedAt: publishedAt.getTime(),
        talks: [{
          id: seeded.talkId,
          title,
          description: null,
          track: null,
          room,
          startsAt: startsAt.getTime(),
          durationMin: 30,
          speakerNames: ["Accepted Speaker"],
        }],
      },
      actorUserId: seeded.owner.userId,
      requestId: `agenda-publication-request-${seeded.eventId}-${revision}`,
      occurredAt: publishedAt,
    }),
    seeded.db.insert(domainChanges).values({
      id: `agenda-delivery-${seeded.eventId}-${revision}`,
      eventId: seeded.eventId,
      aggregateType: "agenda-delivery",
      aggregateId: seeded.eventId,
      aggregateVersion: revision,
      eventType: "agenda/delivery-published",
      audiences: [{ kind: "admins" }],
      payload: {
        eventId: seeded.eventId,
        revision,
        eventStartsAt: new Date("2026-08-12T16:00:00.000Z").getTime(),
        eventEndsAt: new Date("2026-08-13T00:00:00.000Z").getTime(),
        talks: [{
          talkId: seeded.talkId,
          roomId,
          startsAt: startsAt.getTime(),
          durationMin: 30,
          speakerIds: [seeded.speakerId],
        }],
      },
      actorUserId: seeded.owner.userId,
      requestId: `agenda-publication-request-${seeded.eventId}-${revision}`,
      occurredAt: publishedAt,
    }),
  ]);
};

beforeAll(async () => {
  if (!hasMigrations(env)) throw new Error("TEST_MIGRATIONS test binding is unavailable");
  await applyD1Migrations(env.DB, [...env.TEST_MIGRATIONS]);
});

afterAll(async () => {
  const scheduler = env.SCHEDULER.get(env.SCHEDULER.idFromName(MAIL_SCHEDULER_NAME));
  await runInDurableObject(scheduler, async (_instance, state) => {
    await state.storage.deleteAlarm();
    await state.storage.deleteAll();
  });
});

describe("communications authorization and validation", () => {
  it("limits organizer reads to owners/admins and exact communications scopes", async () => {
    const seeded = await seedCommunication("authorization");
    const reviewerId = "reviewer-comms-authorization";
    await seeded.db.batch([
      seeded.db.insert(users).values({
        id: reviewerId,
        email: `${reviewerId}@example.com`,
        name: "Reviewer",
        version: 1,
        createdAt: now,
        updatedAt: now,
      }),
      seeded.db.insert(eventMembers).values({
        id: "member-reviewer-comms-authorization",
        eventId: seeded.eventId,
        userId: reviewerId,
        role: "reviewer",
        version: 1,
        createdAt: now,
        updatedAt: now,
      }),
    ]);

    const reviewerResult = await runEitherAs(browserPrincipal(reviewerId), listTemplates({ eventId: seeded.eventId }));
    expect(reviewerResult._tag).toBe("Left");
    if (reviewerResult._tag === "Left") expect(reviewerResult.left).toMatchObject({ _tag: "Forbidden" });

    const scopedApiKey: Principal = {
      kind: "api-key",
      userId: "api-key:comms-read",
      apiKeyId: "comms-read",
      eventId: seeded.eventId,
      name: "Comms read key",
      scopes: ["communications:read"],
      expiresAt: now.getTime() + 86_400_000,
    };
    await expect(runAs(scopedApiKey, listTemplates({ eventId: seeded.eventId }))).resolves.toHaveLength(1);
  });

  it("uses an event-scoped contact address when an accepted speaker has no account", async () => {
    const seeded = await seedCommunication("contact-email");
    await seeded.db.batch([
      seeded.db.update(speakers).set({
        userId: null,
        contactEmail: "speaker-contact@example.com",
      }).where(eq(speakers.id, seeded.speakerId)),
      seeded.db.insert(speakers).values({
        id: "co-speaker-comms-contact-email",
        eventId: seeded.eventId,
        userId: null,
        contactEmail: "co-speaker@example.com",
        displayName: "Co-speaker",
        createdAt: now,
        updatedAt: now,
      }),
      seeded.db.insert(submissionSpeakers).values({
        id: "co-association-comms-contact-email",
        eventId: seeded.eventId,
        submissionId: "submission-comms-contact-email",
        speakerId: "co-speaker-comms-contact-email",
        isPrimary: false,
        createdAt: now,
      }),
    ]);

    const audience = await runAs(seeded.owner, listAudience({ eventId: seeded.eventId }));
    expect(audience.recipients).toEqual(expect.arrayContaining([
      expect.objectContaining({
        speakerId: seeded.speakerId,
        userId: null,
        email: "speaker-contact@example.com",
        eligibility: "eligible",
      }),
      expect.objectContaining({
        speakerId: "co-speaker-comms-contact-email",
        userId: null,
        email: "co-speaker@example.com",
        eligibility: "eligible",
      }),
    ]));
    expect(audience.eligibleCount).toBe(2);
  });

  it("queues organizer-confirmed acceptance and rejection notification snapshots", async () => {
    const seeded = await seedCommunication("rejected-audience");
    const mailQueue: MailQueueStub = {
      appOrigin: "https://events.example.com",
      fromEmail: "Events <configured@example.com>",
      wake: () => Effect.void,
    };
    const acceptedAudience = await runAs(seeded.owner, listAudience({ eventId: seeded.eventId }));
    expect(acceptedAudience.recipients).toContainEqual(expect.objectContaining({
      speakerId: seeded.speakerId,
      decision: "accepted",
      eligibility: "eligible",
    }));
    const accepted = await runAs(seeded.owner, enqueueCommunication({
      eventId: seeded.eventId,
      templateId: seeded.templateId,
      expectedTemplateVersion: 1,
      recipientKeys: [seeded.speakerId],
      replyToEmail: null,
      scheduledFor: null,
      idempotencyKey: "comms-accepted-audience-001",
    }), mailQueue);
    const [acceptedSnapshot] = await seeded.db.select().from(mailDeliverySnapshots)
      .where(eq(mailDeliverySnapshots.id, accepted.deliveries[0]!.snapshotId));
    expect(acceptedSnapshot).toMatchObject({
      recipientEmail: "speaker-user-comms-rejected-audience@example.com",
      subject: "Welcome, Accepted Speaker",
    });

    await seeded.db.batch([
      seeded.db.update(submissions).set({ status: "rejected", acceptedAt: null, version: 3, updatedAt: now }).where(eq(submissions.id, "submission-comms-rejected-audience")),
      seeded.db.update(emailTemplates).set({
        subject: "An update on your {{event.name}} proposal",
        body: "Hi {{speaker.name}},\n\nThank you for submitting to {{event.name}}.",
        attachIcs: false,
        version: 2,
        updatedAt: now,
      }).where(eq(emailTemplates.id, seeded.templateId)),
    ]);
    const audience = await runAs(seeded.owner, listAudience({ eventId: seeded.eventId }));
    expect(audience.recipients).toContainEqual(expect.objectContaining({
      speakerId: seeded.speakerId,
      name: "Accepted Speaker",
      decision: "rejected",
      eligibility: "eligible",
    }));
    const rejected = await runAs(seeded.owner, enqueueCommunication({
      eventId: seeded.eventId,
      templateId: seeded.templateId,
      expectedTemplateVersion: 2,
      recipientKeys: [seeded.speakerId],
      replyToEmail: null,
      scheduledFor: null,
      idempotencyKey: "comms-rejected-audience-001",
    }), mailQueue);
    expect(rejected.deliveries).toHaveLength(1);
    const [rejectedSnapshot] = await seeded.db.select().from(mailDeliverySnapshots).where(eq(mailDeliverySnapshots.id, rejected.deliveries[0]!.snapshotId));
    expect(rejectedSnapshot).toMatchObject({
      recipientEmail: "speaker-user-comms-rejected-audience@example.com",
      subject: "An update on your Communications rejected-audience proposal",
    });
  });

  it("keeps one speaker in both accepted and rejected decision cohorts", async () => {
    const seeded = await seedCommunication("mixed-decisions");
    const rejectedSubmissionId = "submission-comms-mixed-decisions-rejected";
    await seeded.db.batch([
      seeded.db.insert(submissions).values({
        id: rejectedSubmissionId,
        eventId: seeded.eventId,
        formId: "form-comms-mixed-decisions",
        formVersionId: "form-version-comms-mixed-decisions",
        title: "A second proposal",
        status: "rejected",
        submittedAt: new Date(now.getTime() + 1_000),
        version: 2,
        createdAt: now,
        updatedAt: now,
      }),
      seeded.db.insert(submissionSpeakers).values({
        id: "association-comms-mixed-decisions-rejected",
        eventId: seeded.eventId,
        submissionId: rejectedSubmissionId,
        speakerId: seeded.speakerId,
        isPrimary: true,
        createdAt: now,
      }),
    ]);

    const audience = await runAs(seeded.owner, listAudience({ eventId: seeded.eventId }));
    const speakerRecipients = audience.recipients.filter(({ speakerId }) => speakerId === seeded.speakerId);
    expect(speakerRecipients).toMatchObject([
      { recipientKey: `${seeded.speakerId}:accepted`, decision: "accepted", sessionTitles: ["Durable systems without surprises"] },
      { recipientKey: `${seeded.speakerId}:rejected`, decision: "rejected", sessionTitles: ["A second proposal"] },
    ]);

    const queue: MailQueueStub = {
      appOrigin: "https://events.example.com",
      fromEmail: "Events <configured@example.com>",
      wake: () => Effect.void,
    };
    const rejectedPreview = await runAs(seeded.owner, previewCommunication({
      eventId: seeded.eventId,
      subject: "{{talk.title}}",
      textBody: "{{talk.title}}",
      htmlBody: "<p>{{talk.title}}</p>",
      attachIcs: false,
      recipientKey: `${seeded.speakerId}:rejected`,
    }), queue);
    expect(rejectedPreview.text).toContain("A second proposal");
    expect(rejectedPreview.text).not.toContain("Durable systems without surprises");
    const accepted = await runAs(seeded.owner, enqueueCommunication({
      eventId: seeded.eventId,
      templateId: seeded.templateId,
      expectedTemplateVersion: 1,
      recipientKeys: [`${seeded.speakerId}:accepted`],
      replyToEmail: null,
      scheduledFor: null,
      idempotencyKey: "comms-mixed-accepted-001",
    }), queue);
    await seeded.db.update(emailTemplates).set({
      subject: "A decision on your proposal",
      body: "Thank you for submitting.",
      version: 2,
      updatedAt: now,
    }).where(eq(emailTemplates.id, seeded.templateId));
    const rejected = await runAs(seeded.owner, enqueueCommunication({
      eventId: seeded.eventId,
      templateId: seeded.templateId,
      expectedTemplateVersion: 2,
      recipientKeys: [`${seeded.speakerId}:rejected`],
      replyToEmail: null,
      scheduledFor: null,
      idempotencyKey: "comms-mixed-rejected-001",
    }), queue);
    expect(accepted.deliveries).toHaveLength(1);
    expect(rejected.deliveries).toHaveLength(1);
    const snapshots = await seeded.db.select().from(mailDeliverySnapshots)
      .where(eq(mailDeliverySnapshots.eventId, seeded.eventId));
    expect(snapshots.map(({ subject }) => subject).sort()).toEqual([
      "A decision on your proposal",
      "Welcome, Accepted Speaker",
    ]);
  });

  it("accepts the frozen dotted merge contract and rejects unknown or malformed variables", async () => {
    await expect(Effect.runPromise(validateTemplate(
      "Accepted",
      "Welcome {{speaker.name}}",
      "{{talk.title}} at {{event.name}} on {{event.dates}}",
      "<p>{{talk.title}} at {{event.name}} on {{event.dates}}</p>",
    ))).resolves.toMatchObject({ name: "Accepted" });

    const unknown = await Effect.runPromise(validateTemplate(
      "Invalid",
      "Welcome {{speakerName}}",
      "Body",
      "<p>Body</p>",
    ).pipe(Effect.either));
    expect(unknown._tag).toBe("Left");
    if (unknown._tag === "Left") expect(unknown.left.message).toContain("Unknown template variable");

    const malformed = await Effect.runPromise(
      validateTemplate("Invalid", "Subject", "Hello {{speaker.name", "<p>Hello</p>").pipe(Effect.either),
    );
    expect(malformed._tag).toBe("Left");
    if (malformed._tag === "Left") {
      expect(malformed.left).toMatchObject({ _tag: "Validation", message: "Template contains a malformed variable" });
    }
  });
});

describe("communications immutable delivery workflow", () => {
  it("wakes only after one durable enqueue and wakes the same durable row again on replay", async () => {
    const seeded = await seedCommunication("enqueue");
    const wakeObservations: Array<{
      readonly snapshots: number;
      readonly deliveries: number;
      readonly completedCommands: number;
      readonly statuses: readonly string[];
    }> = [];
    const mailQueue: MailQueueStub = {
      appOrigin: "https://events.example.com",
      fromEmail: "Events <configured@example.com>",
      wake: () => Effect.promise(async () => {
        const snapshots = await seeded.db.select().from(mailDeliverySnapshots)
          .where(eq(mailDeliverySnapshots.eventId, seeded.eventId));
        const snapshotIds = new Set(snapshots.map(({ id }) => id));
        const deliveries = (await seeded.db.select().from(mailDeliveries))
          .filter(({ snapshotId }) => snapshotIds.has(snapshotId));
        const completedCommands = await seeded.db.select().from(idempotencyRecords).where(and(
          eq(idempotencyRecords.eventId, seeded.eventId),
          eq(idempotencyRecords.operationId, "comms.enqueueCommunication"),
          eq(idempotencyRecords.status, "completed"),
        ));
        wakeObservations.push({
          snapshots: snapshots.length,
          deliveries: deliveries.length,
          completedCommands: completedCommands.length,
          statuses: deliveries.map(({ status }) => status),
        });
      }),
    };
    const input = {
      eventId: seeded.eventId,
      templateId: seeded.templateId,
      expectedTemplateVersion: 1,
      recipientKeys: [seeded.speakerId] as [string],
      replyToEmail: "team@example.com",
      scheduledFor: null,
      idempotencyKey: "comms-enqueue-immutable-001",
    } as const;

    const first = await runAs(seeded.owner, enqueueCommunication(input), mailQueue);
    expect(wakeObservations).toEqual([{
      snapshots: 1,
      deliveries: 1,
      completedCommands: 1,
      statuses: ["pending"],
    }]);
    const replay = await runAs(seeded.owner, enqueueCommunication(input), mailQueue);
    expect(wakeObservations).toEqual([
      { snapshots: 1, deliveries: 1, completedCommands: 1, statuses: ["pending"] },
      { snapshots: 1, deliveries: 1, completedCommands: 1, statuses: ["pending"] },
    ]);
    expect(first).toMatchObject({
      queueState: "persisted",
      dispatchState: "deferred",
      schedulerWake: "requested",
      replayed: false,
    });
    expect(replay).toMatchObject({ replayed: true, deliveries: first.deliveries });

    await seeded.db.update(emailTemplates).set({
      subject: "Changed mutable template",
      body: "Changed after enqueue",
      version: 2,
      updatedAt: new Date(now.getTime() + 1_000),
    }).where(and(eq(emailTemplates.eventId, seeded.eventId), eq(emailTemplates.id, seeded.templateId)));

    const [snapshots, allDeliveries, attempts, idempotency] = await Promise.all([
      seeded.db.select().from(mailDeliverySnapshots).where(eq(mailDeliverySnapshots.eventId, seeded.eventId)),
      seeded.db.select().from(mailDeliveries),
      seeded.db.select().from(mailDeliveryAttempts),
      seeded.db.select().from(idempotencyRecords).where(and(
        eq(idempotencyRecords.eventId, seeded.eventId),
        eq(idempotencyRecords.operationId, "comms.enqueueCommunication"),
      )),
    ]);
    const eventDeliveries = allDeliveries.filter((delivery) =>
      first.deliveries.some((queued) => queued.deliveryId === delivery.id));
    expect(snapshots).toHaveLength(1);
    expect(eventDeliveries).toHaveLength(1);
    expect(idempotency).toHaveLength(1);
    expect(attempts.filter(({ deliveryId }) => deliveryId === eventDeliveries[0]!.id)).toHaveLength(0);
    expect(snapshots[0]).toMatchObject({
      subject: "Welcome, Accepted Speaker",
      renderedText: "Your session Durable systems without surprises is accepted for Communications enqueue at Main Hall.",
      renderedHtml: "<p>Your session Durable systems without surprises is accepted for Communications enqueue at Main Hall.</p>",
      fromEmail: mailQueue.fromEmail,
      replyToEmail: input.replyToEmail,
    });
    expect(eventDeliveries[0]).toMatchObject({
      status: "pending",
      attemptCount: 0,
      provider: "cloudflare-email",
    });
  });

  it("rejects a campaign when its authorized template version changed before enqueue", async () => {
    const seeded = await seedCommunication("stale-template");
    await seeded.db.update(emailTemplates).set({
      subject: "Unreviewed concurrent edit",
      version: 2,
      updatedAt: new Date(now.getTime() + 1_000),
    }).where(and(
      eq(emailTemplates.eventId, seeded.eventId),
      eq(emailTemplates.id, seeded.templateId),
    ));
    const deliveriesBefore = await seeded.db.select().from(mailDeliveries);

    const result = await runEitherAs(seeded.owner, enqueueCommunication({
      eventId: seeded.eventId,
      templateId: seeded.templateId,
      expectedTemplateVersion: 1,
      recipientKeys: [seeded.speakerId],
      replyToEmail: null,
      scheduledFor: null,
      idempotencyKey: "comms-stale-template-001",
    }));

    expect(result._tag).toBe("Left");
    if (result._tag === "Left") {
      expect(result.left).toMatchObject({
        _tag: "Conflict",
        message: "Template version is 2; expected 1",
      });
    }
    expect(await seeded.db.select().from(mailDeliverySnapshots)
      .where(eq(mailDeliverySnapshots.eventId, seeded.eventId))).toHaveLength(0);
    expect(await seeded.db.select().from(mailDeliveries)).toEqual(deliveriesBefore);
    expect(await seeded.db.select().from(idempotencyRecords).where(and(
      eq(idempotencyRecords.eventId, seeded.eventId),
      eq(idempotencyRecords.operationId, "comms.enqueueCommunication"),
    ))).toHaveLength(0);
  });

  it("does not roll back a committed outbox when the first wake fails", async () => {
    const seeded = await seedCommunication("failed-wake");
    const scheduler = env.SCHEDULER.get(env.SCHEDULER.idFromName(MAIL_SCHEDULER_NAME));
    await runInDurableObject(scheduler, async (_instance, state) => state.storage.deleteAll());
    const result = await runAs(seeded.owner, enqueueCommunication({
      eventId: seeded.eventId,
      templateId: seeded.templateId,
      expectedTemplateVersion: 1,
      recipientKeys: [seeded.speakerId],
      replyToEmail: null,
      scheduledFor: null,
      idempotencyKey: "comms-failed-wake-001",
    }), {
      appOrigin: "https://events.example.com",
      fromEmail: "Events <configured@example.com>",
      wake: () => Effect.die(new Error("simulated first wake failure")),
    });
    await expect(seeded.db.select().from(mailDeliverySnapshots)
      .where(eq(mailDeliverySnapshots.id, result.deliveries[0].snapshotId))).resolves.toHaveLength(1);
    await expect(seeded.db.select().from(mailDeliveries)
      .where(eq(mailDeliveries.id, result.deliveries[0].deliveryId))).resolves.toEqual([
      expect.objectContaining({ status: "pending", attemptCount: 0 }),
    ]);
    await recoverMailScheduler(env);
    await runInDurableObject(scheduler, async (instance) => instance.alarm());
    await expect(seeded.db.select().from(mailDeliveries)
      .where(eq(mailDeliveries.id, result.deliveries[0].deliveryId))).resolves.toEqual([
      expect.objectContaining({ status: "sent", attemptCount: 1 }),
    ]);
  });

  it("persists exact-revision companion data despite mutable agenda changes", async () => {
    const seeded = await seedCommunication("calendar");
    await runAs(seeded.owner, updateTemplate({
      eventId: seeded.eventId,
      templateId: seeded.templateId,
      name: "Scheduled reminder",
      subject: "{{talk.title}} reminder",
      textBody: "{{speaker.name}}, {{talk.title}} starts at {{talk.time}} in {{talk.room}}.",
      htmlBody: "<p><strong>{{speaker.name}}</strong>, {{talk.title}} starts at {{talk.time}} in {{talk.room}}.</p>",
      attachIcs: true,
      expectedVersion: 1,
      idempotencyKey: "comms-calendar-template-001",
    }));
    await publishAgenda(
      seeded,
      1,
      new Date("2026-08-12T18:30:00.000Z"),
      "Main Stage",
      now,
    );
    await seeded.db.delete(talkSpeakers).where(and(
      eq(talkSpeakers.eventId, seeded.eventId),
      eq(talkSpeakers.talkId, seeded.talkId),
    ));
    const scheduledFor = new Date("2026-08-12T17:30:00.000Z").getTime();
    const result = await runAs(seeded.owner, enqueueCommunication({
      eventId: seeded.eventId,
      templateId: seeded.templateId,
      expectedTemplateVersion: 2,
      recipientKeys: [seeded.speakerId],
      replyToEmail: null,
      scheduledFor,
      idempotencyKey: "comms-calendar-reminder-001",
    }), {
      appOrigin: "https://agenda.example.com",
      fromEmail: "Agenda <agenda@example.com>",
      wake: () => Effect.void,
    });

    const [snapshot] = await seeded.db.select().from(mailDeliverySnapshots)
      .where(eq(mailDeliverySnapshots.id, result.deliveries[0].snapshotId));
    const [delivery] = await seeded.db.select().from(mailDeliveries)
      .where(eq(mailDeliveries.id, result.deliveries[0].deliveryId));
    expect(snapshot).toMatchObject({
      recipientName: "Accepted Speaker",
      fromEmail: "Agenda <agenda@example.com>",
      subject: "Durable systems without surprises reminder",
      renderedText: "Accepted Speaker, Durable systems without surprises starts at Aug 12, 2026, 11:30 AM in Main Stage.",
      renderedHtml: "<p><strong>Accepted Speaker</strong>, Durable systems without surprises starts at Aug 12, 2026, 11:30 AM in Main Stage.</p>",
      icsFilename: "comms-calendar-accepted-speaker-agenda.ics",
    });
    const invite = snapshot!.icsContent!.replace(/\r\n[ \t]/g, "");
    expect(invite).toContain("METHOD:REQUEST");
    expect(invite).toContain("UID:talk-comms-calendar@event-comms-calendar.session-party");
    expect(invite).toContain("DTSTART:20260812T183000Z");
    expect(invite).toContain("DTEND:20260812T190000Z");
    expect(invite).toContain("SEQUENCE:1");
    expect(invite).toContain("ORGANIZER:mailto:agenda@example.com");
    expect(invite).toContain('ATTENDEE;CN="Accepted Speaker";ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:speaker-user-comms-calendar@example.com');
    expect(invite).not.toContain("METHOD:PUBLISH");
    expect(invite).not.toContain("URL:");
    expect(invite).toContain("SUMMARY:Durable systems without surprises");
    expect(snapshot!.icsContent).toContain("LOCATION:Main Stage");
    expect(delivery).toMatchObject({
      scheduledFor: new Date(scheduledFor),
      availableAt: new Date(scheduledFor),
      status: "pending",
      provider: "cloudflare-email",
    });
    await expect(seeded.db.select().from(mailCalendarEvents)
      .where(eq(mailCalendarEvents.snapshotId, snapshot!.id))).resolves.toEqual([
      expect.objectContaining({
        eventId: seeded.eventId,
        speakerId: seeded.speakerId,
        talkId: seeded.talkId,
        calendarUid: `talk-comms-calendar@${seeded.eventId}.session-party`,
        sequence: 1,
        status: "confirmed",
      }),
    ]);

    const rescheduledRoomId = `room-rescheduled-${seeded.eventId}`;
    await seeded.db.batch([
      seeded.db.insert(rooms).values({
        id: rescheduledRoomId,
        eventId: seeded.eventId,
        name: "Studio B",
        order: 2,
        version: 1,
        createdAt: now,
        updatedAt: now,
      }),
      seeded.db.update(talks).set({
        roomId: rescheduledRoomId,
        startsAt: new Date("2026-08-12T19:30:00.000Z"),
        version: 2,
        updatedAt: new Date(now.getTime() + 60_000),
      }).where(and(eq(talks.eventId, seeded.eventId), eq(talks.id, seeded.talkId))),
    ]);
    const privateReschedule = await runAs(seeded.owner, enqueueCommunication({
      eventId: seeded.eventId,
      templateId: seeded.templateId,
      expectedTemplateVersion: 2,
      recipientKeys: [seeded.speakerId],
      replyToEmail: null,
      scheduledFor,
      idempotencyKey: "comms-calendar-reminder-002",
    }), {
      appOrigin: "https://agenda.example.com",
      fromEmail: "Agenda <agenda@example.com>",
      wake: () => Effect.void,
    });
    const [privateRescheduleSnapshot] = await seeded.db.select().from(mailDeliverySnapshots)
      .where(eq(mailDeliverySnapshots.id, privateReschedule.deliveries[0].snapshotId));
    expect(privateRescheduleSnapshot!.icsContent).toContain("SEQUENCE:1");
    expect(privateRescheduleSnapshot!.icsContent).toContain("DTSTART:20260812T183000Z");
    expect(privateRescheduleSnapshot!.icsContent).toContain("LOCATION:Main Stage");
    expect(privateRescheduleSnapshot!.icsContent).not.toContain("Studio B");

    await publishAgenda(
      seeded,
      2,
      new Date("2026-08-12T19:30:00.000Z"),
      "Studio B",
      new Date(now.getTime() + 120_000),
      "Durable systems without surprises",
      rescheduledRoomId,
    );
    const rescheduled = await runAs(seeded.owner, enqueueCommunication({
      eventId: seeded.eventId,
      templateId: seeded.templateId,
      expectedTemplateVersion: 2,
      recipientKeys: [seeded.speakerId],
      replyToEmail: null,
      scheduledFor,
      idempotencyKey: "comms-calendar-reminder-003",
    }), {
      appOrigin: "https://agenda.example.com",
      fromEmail: "Agenda <agenda@example.com>",
      wake: () => Effect.void,
    });
    const [rescheduledSnapshot] = await seeded.db.select().from(mailDeliverySnapshots)
      .where(eq(mailDeliverySnapshots.id, rescheduled.deliveries[0].snapshotId));
    expect(snapshot!.icsContent).toContain("DTSTART:20260812T183000Z");
    expect(snapshot!.icsContent).toContain("LOCATION:Main Stage");
    expect(rescheduledSnapshot!.icsContent).toContain("UID:talk-comms-calendar@event-comms-calendar.session-party");
    expect(rescheduledSnapshot!.icsContent).toContain("SEQUENCE:2");
    expect(rescheduledSnapshot!.icsContent).toContain("DTSTART:20260812T193000Z");
    expect(rescheduledSnapshot!.icsContent).toContain("DTEND:20260812T200000Z");
    expect(rescheduledSnapshot!.icsContent).toContain("LOCATION:Studio B");
    expect(rescheduledSnapshot!.icsContent).not.toContain("URL:");
    await seeded.db.update(mailDeliveries).set({
      status: "dead_letter",
      deadLetteredAt: now,
      lastError: "Provider rejected the calendar update",
    }).where(eq(mailDeliveries.id, rescheduled.deliveries[0].deliveryId));
    const retriedCalendar = await runAs(seeded.owner, retryDelivery({
      eventId: seeded.eventId,
      deliveryId: rescheduled.deliveries[0].deliveryId,
      idempotencyKey: "comms-calendar-retry-001",
    }), {
      appOrigin: "https://agenda.example.com",
      fromEmail: "Agenda <agenda@example.com>",
      wake: () => Effect.void,
    });
    const sourceLineage = await seeded.db.select().from(mailCalendarEvents)
      .where(eq(mailCalendarEvents.snapshotId, rescheduledSnapshot!.id));
    const retryLineage = await seeded.db.select().from(mailCalendarEvents)
      .where(eq(mailCalendarEvents.snapshotId, retriedCalendar.snapshotId));
    expect(retryLineage).toEqual(sourceLineage.map((calendarEvent) =>
      expect.objectContaining({
        eventId: calendarEvent.eventId,
        speakerId: calendarEvent.speakerId,
        talkId: calendarEvent.talkId,
        calendarUid: calendarEvent.calendarUid,
        sequence: calendarEvent.sequence,
        publicationRevision: calendarEvent.publicationRevision,
        status: calendarEvent.status,
      })
    ));

    const longTitle = `Résumé — ${"é".repeat(60)}`;
    await publishAgenda(
      seeded,
      3,
      new Date("2026-08-12T19:30:00.000Z"),
      "Studio B",
      new Date(now.getTime() + 180_000),
      longTitle,
      rescheduledRoomId,
    );
    const folded = await runAs(seeded.owner, enqueueCommunication({
      eventId: seeded.eventId,
      templateId: seeded.templateId,
      expectedTemplateVersion: 2,
      recipientKeys: [seeded.speakerId],
      replyToEmail: null,
      scheduledFor,
      idempotencyKey: "comms-calendar-reminder-004",
    }), {
      appOrigin: "https://agenda.example.com",
      fromEmail: "Agenda <agenda@example.com>",
      wake: () => Effect.void,
    });
    const [foldedSnapshot] = await seeded.db.select().from(mailDeliverySnapshots)
      .where(eq(mailDeliverySnapshots.id, folded.deliveries[0].snapshotId));
    const encoder = new TextEncoder();
    expect(foldedSnapshot!.icsContent).toContain("\r\n ");
    for (const line of foldedSnapshot!.icsContent!.split("\r\n")) {
      expect(encoder.encode(line).byteLength).toBeLessThanOrEqual(75);
    }
    const unfolded = foldedSnapshot!.icsContent!.replace(/\r\n[ \t]/g, "");
    expect(unfolded).toContain(`SUMMARY:${longTitle}`);
  });
  it("claims one durable retry across concurrent different command keys and replays it", async () => {
    const seeded = await seedCommunication("retry");
    const durableCounts: number[] = [];
    const queue: MailQueueStub = {
      appOrigin: "https://retries.example.com",
      fromEmail: "Retries <retries@example.com>",
      wake: () => Effect.promise(async () => {
        const snapshots = await seeded.db.select().from(mailDeliverySnapshots)
          .where(eq(mailDeliverySnapshots.eventId, seeded.eventId));
        durableCounts.push(snapshots.length);
      }),
    };
    const enqueued = await runAs(seeded.owner, enqueueCommunication({
      eventId: seeded.eventId,
      templateId: seeded.templateId,
      expectedTemplateVersion: 1,
      recipientKeys: [seeded.speakerId],
      replyToEmail: null,
      scheduledFor: null,
      idempotencyKey: "comms-retry-source-001",
    }), queue);
    await seeded.db.update(mailDeliveries).set({
      status: "dead_letter",
      deadLetteredAt: now,
      lastError: "Provider rejected the message",
    }).where(eq(mailDeliveries.id, enqueued.deliveries[0].deliveryId));
    const input = {
      eventId: seeded.eventId,
      deliveryId: enqueued.deliveries[0].deliveryId,
    } as const;

    const concurrent = await Promise.all([
      runAs(seeded.owner, retryDelivery({ ...input, idempotencyKey: "comms-retry-command-001" }), queue),
      runAs(seeded.owner, retryDelivery({ ...input, idempotencyKey: "comms-retry-command-002" }), queue),
    ]);
    expect(new Set(concurrent.map(({ deliveryId }) => deliveryId)).size).toBe(1);
    expect(new Set(concurrent.map(({ snapshotId }) => snapshotId)).size).toBe(1);
    expect(concurrent.map(({ replayed }) => replayed).sort()).toEqual([false, true]);

    const replay = await runAs(
      seeded.owner,
      retryDelivery({ ...input, idempotencyKey: "comms-retry-command-001" }),
      queue,
    );
    expect(replay).toMatchObject({
      deliveryId: concurrent[0]!.deliveryId,
      snapshotId: concurrent[0]!.snapshotId,
      replayed: true,
    });
    expect(durableCounts).toEqual([1, 2, 2, 2]);
    const snapshots = await seeded.db.select().from(mailDeliverySnapshots)
      .where(eq(mailDeliverySnapshots.eventId, seeded.eventId));
    const snapshotIds = new Set(snapshots.map(({ id }) => id));
    const deliveries = (await seeded.db.select().from(mailDeliveries))
      .filter(({ snapshotId }) => snapshotIds.has(snapshotId));
    expect(snapshots).toHaveLength(2);
    expect(deliveries).toHaveLength(2);
    expect(deliveries.filter(({ id }) => id !== enqueued.deliveries[0].deliveryId)).toHaveLength(1);
    expect(snapshots.find(({ id }) => id === concurrent[0]!.snapshotId)?.fromEmail).toBe(queue.fromEmail);
  });

  it("renders camelCase wire variables from confirmed agenda data without delivery egress", async () => {
    const seeded = await seedCommunication("preview");
    await publishAgenda(
      seeded,
      1,
      new Date("2026-08-12T18:30:00.000Z"),
      "Main Stage",
      now,
    );
    await seeded.db.update(events).set({
      slug: "mutable-preview-slug",
      updatedAt: new Date(now.getTime() + 1_000),
    }).where(eq(events.id, seeded.eventId));
    const queue: MailQueueStub = {
      appOrigin: "https://conference.example",
      fromEmail: "Conference <conference@example.com>",
      wake: () => Effect.void,
    };
    const deliveriesBefore = await seeded.db.select().from(mailDeliveries);
    const preview = await runAs(seeded.owner, previewCommunication({
      eventId: seeded.eventId,
      subject: "{{speaker.name}} — {{event.name}}",
      textBody: "{{talk.title}} starts at {{talk.time}} in {{talk.room}}. Portal: {{portal.url}}",
      htmlBody: "<p>{{talk.title}} starts at {{talk.time}} in {{talk.room}}. Portal: {{portal.url}}</p>",
      attachIcs: true,
      recipientKey: seeded.speakerId,
    }), queue);
    const deliveriesAfter = await seeded.db.select().from(mailDeliveries);
    expect(preview).toMatchObject({
      mode: "decidedApplicant",
      subject: "Accepted Speaker — Communications preview",
      recipientEmail: "speaker-user-comms-preview@example.com",
      delivery: "notSent",
      icsStatus: "available",
    });
    expect(preview.text).toContain("Aug 12, 2026, 11:30 AM in Main Stage");
    expect(preview.text).toContain("Portal: https://conference.example/e/comms-preview/portal");
    expect(preview.variables.map(({ key }) => key)).toEqual([
      "speakerName",
      "speakerEmail",
      "eventName",
      "eventLocation",
      "eventDates",
      "talkTitle",
      "talkTime",
      "talkRoom",
      "portalUrl",
    ]);
    expect(preview.unavailableVariables).toEqual([]);
    expect(deliveriesAfter).toHaveLength(deliveriesBefore.length);
  });

  it("snapshots an absolute origin-safe portal URL from MailQueue and the immutable publication slug", async () => {
    const seeded = await seedCommunication("portal-url");
    await publishAgenda(
      seeded,
      1,
      new Date("2026-08-12T18:30:00.000Z"),
      "Main Stage",
      now,
    );
    await seeded.db.update(events).set({
      slug: "mutable-portal-url",
      updatedAt: new Date(now.getTime() + 1_000),
    }).where(eq(events.id, seeded.eventId));
    await runAs(seeded.owner, updateTemplate({
      eventId: seeded.eventId,
      templateId: seeded.templateId,
      name: "Portal link",
      subject: "{{event.name}} portal",
      textBody: "Portal: {{portal.url}}",
      htmlBody: "<p>Portal: {{portal.url}}</p>",
      attachIcs: false,
      expectedVersion: 1,
      idempotencyKey: "comms-portal-url-template-001",
    }));
    const queue: MailQueueStub = {
      appOrigin: "https://conference.example",
      fromEmail: "Conference <conference@example.com>",
      wake: () => Effect.void,
    };
    const result = await runAs(seeded.owner, enqueueCommunication({
      eventId: seeded.eventId,
      templateId: seeded.templateId,
      expectedTemplateVersion: 2,
      recipientKeys: [seeded.speakerId],
      replyToEmail: null,
      scheduledFor: null,
      idempotencyKey: "comms-portal-url-enqueue-001",
    }), queue);
    const [snapshot] = await seeded.db.select().from(mailDeliverySnapshots)
      .where(eq(mailDeliverySnapshots.id, result.deliveries[0].snapshotId));

    expect(snapshot).toMatchObject({
      renderedText: "Portal: https://conference.example/e/comms-portal-url/portal",
      renderedHtml: "<p>Portal: https://conference.example/e/comms-portal-url/portal</p>",
    });
    expect(snapshot?.renderedText).not.toContain("mutable-portal-url");
  });

  it("labels missing event metadata in preview and rejects referenced placeholders before enqueue", async () => {
    const seeded = await seedCommunication("unavailable-event");
    await seeded.db.update(events).set({
      location: null,
      startsAt: null,
      endsAt: null,
      updatedAt: now,
    }).where(eq(events.id, seeded.eventId));
    await runAs(seeded.owner, updateTemplate({
      eventId: seeded.eventId,
      templateId: seeded.templateId,
      name: "Event details",
      subject: "{{event.name}} details",
      textBody: "Join us at {{event.location}} on {{event.dates}}.",
      htmlBody: "<p>Join us at {{event.location}} on {{event.dates}}.</p>",
      attachIcs: false,
      expectedVersion: 1,
      idempotencyKey: "comms-unavailable-template-001",
    }));
    const preview = await runAs(seeded.owner, previewCommunication({
      eventId: seeded.eventId,
      subject: "{{event.name}} details",
      textBody: "Join us at {{event.location}} on {{event.dates}}.",
      htmlBody: "<p>Join us at {{event.location}} on {{event.dates}}.</p>",
      attachIcs: false,
      recipientKey: seeded.speakerId,
    }));
    expect(preview.text).toContain("Location to be announced");
    expect(preview.text).toContain("Dates to be announced");
    expect(preview.unavailableVariables).toEqual(["eventLocation", "eventDates"]);

    const result = await runEitherAs(seeded.owner, enqueueCommunication({
      eventId: seeded.eventId,
      templateId: seeded.templateId,
      expectedTemplateVersion: 2,
      recipientKeys: [seeded.speakerId],
      replyToEmail: null,
      scheduledFor: null,
      idempotencyKey: "comms-unavailable-enqueue-001",
    }));
    expect(result._tag).toBe("Left");
    if (result._tag === "Left") {
      expect(result.left).toMatchObject({
        _tag: "Conflict",
        message: "Delivery cannot resolve event.location or event.dates because event metadata is unavailable",
      });
    }
    expect(await seeded.db.select().from(mailDeliverySnapshots)
      .where(eq(mailDeliverySnapshots.eventId, seeded.eventId))).toHaveLength(0);
  });

  it("uses immutable companion event dates instead of current event dates", async () => {
    const seeded = await seedCommunication("published-dates");
    await publishAgenda(
      seeded,
      1,
      new Date("2026-08-12T18:30:00.000Z"),
      "Main Stage",
      now,
    );
    await seeded.db.update(events).set({
      startsAt: new Date("2026-09-20T16:00:00.000Z"),
      endsAt: new Date("2026-09-21T00:00:00.000Z"),
      updatedAt: new Date(now.getTime() + 1_000),
    }).where(eq(events.id, seeded.eventId));
    await runAs(seeded.owner, updateTemplate({
      eventId: seeded.eventId,
      templateId: seeded.templateId,
      name: "Published event dates",
      subject: "{{event.name}} dates",
      textBody: "Event dates: {{event.dates}}",
      htmlBody: "<p>Event dates: {{event.dates}}</p>",
      attachIcs: false,
      expectedVersion: 1,
      idempotencyKey: "comms-published-dates-template-001",
    }));
    const preview = await runAs(seeded.owner, previewCommunication({
      eventId: seeded.eventId,
      subject: "{{event.name}} dates",
      textBody: "Event dates: {{event.dates}}",
      htmlBody: "<p>Event dates: {{event.dates}}</p>",
      attachIcs: false,
      recipientKey: seeded.speakerId,
    }));
    expect(preview.text).toContain("Event dates: Aug 12, 2026 – Aug 12, 2026");
    expect(preview.text).not.toContain("Sep 20, 2026");
    expect(preview.unavailableVariables).toEqual([]);

    const result = await runAs(seeded.owner, enqueueCommunication({
      eventId: seeded.eventId,
      templateId: seeded.templateId,
      expectedTemplateVersion: 2,
      recipientKeys: [seeded.speakerId],
      replyToEmail: null,
      scheduledFor: null,
      idempotencyKey: "comms-published-dates-enqueue-001",
    }), {
      appOrigin: "https://agenda.example.com",
      fromEmail: "Agenda <agenda@example.com>",
      wake: () => Effect.void,
    });
    const [snapshot] = await seeded.db.select().from(mailDeliverySnapshots)
      .where(eq(mailDeliverySnapshots.id, result.deliveries[0].snapshotId));
    expect(snapshot?.renderedText).toBe("Event dates: Aug 12, 2026 – Aug 12, 2026");
  });

  it("fails closed when the exact-revision agenda companion is missing", async () => {
    const seeded = await seedCommunication("missing-companion");
    await publishAgenda(
      seeded,
      1,
      new Date("2026-08-12T18:30:00.000Z"),
      "Main Stage",
      now,
    );
    await seeded.db.delete(domainChanges).where(eq(
      domainChanges.id,
      `agenda-delivery-${seeded.eventId}-1`,
    ));

    const result = await runEitherAs(seeded.owner, previewCommunication({
      eventId: seeded.eventId,
      subject: "{{talk.title}}",
      textBody: "{{talk.time}}",
      htmlBody: "<p>{{talk.time}}</p>",
      attachIcs: true,
      recipientKey: seeded.speakerId,
    }));
    expect(result._tag).toBe("Left");
    if (result._tag === "Left") {
      expect(result.left).toMatchObject({
        _tag: "NotFound",
        entity: "agenda delivery projection",
        id: `${seeded.eventId}:1`,
      });
    }
  });

  it("fails closed when the exact-revision agenda companion payload is mismatched", async () => {
    const seeded = await seedCommunication("mismatched-companion");
    await publishAgenda(
      seeded,
      1,
      new Date("2026-08-12T18:30:00.000Z"),
      "Main Stage",
      now,
    );
    await seeded.db.update(domainChanges).set({
      payload: {
        eventId: seeded.eventId,
        revision: 2,
        eventStartsAt: new Date("2026-08-12T16:00:00.000Z").getTime(),
        eventEndsAt: new Date("2026-08-13T00:00:00.000Z").getTime(),
        talks: [{
          talkId: seeded.talkId,
          roomId: seeded.roomId,
          startsAt: new Date("2026-08-12T18:30:00.000Z").getTime(),
          durationMin: 30,
          speakerIds: [seeded.speakerId],
        }],
      },
    }).where(eq(domainChanges.id, `agenda-delivery-${seeded.eventId}-1`));

    const result = await runEitherAs(seeded.owner, previewCommunication({
      eventId: seeded.eventId,
      subject: "{{talk.title}}",
      textBody: "{{talk.time}}",
      htmlBody: "<p>{{talk.time}}</p>",
      attachIcs: true,
      recipientKey: seeded.speakerId,
    }));
    expect(result._tag).toBe("Left");
    if (result._tag === "Left") {
      expect(result.left).toMatchObject({
        _tag: "External",
        service: "agenda-delivery-projection",
        detail: `Projection key does not match ${seeded.eventId}:1`,
      });
    }
  });

  it("rejects a rendered subject containing merge-sourced line breaks before snapshots", async () => {
    const seeded = await seedCommunication("subject-break");
    await runAs(seeded.owner, updateTemplate({
      eventId: seeded.eventId,
      templateId: seeded.templateId,
      name: "Unsafe rendered subject",
      subject: "{{event.name}}",
      textBody: "Body",
      htmlBody: "<p>Body</p>",
      attachIcs: false,
      expectedVersion: 1,
      idempotencyKey: "comms-rendered-subject-template-001",
    }));
    await seeded.db.update(events).set({
      name: "Production Summit\r\nBcc: injected@example.com",
      updatedAt: now,
    }).where(eq(events.id, seeded.eventId));
    const result = await runEitherAs(seeded.owner, enqueueCommunication({
      eventId: seeded.eventId,
      templateId: seeded.templateId,
      expectedTemplateVersion: 2,
      recipientKeys: [seeded.speakerId],
      replyToEmail: null,
      scheduledFor: null,
      idempotencyKey: "comms-rendered-subject-001",
    }));
    expect(result._tag).toBe("Left");
    if (result._tag === "Left") {
      expect(result.left).toMatchObject({
        _tag: "Validation",
        message: "Rendered subject for 'Accepted Speaker' must be a single line",
      });
    }
    expect(await seeded.db.select().from(mailDeliverySnapshots)
      .where(eq(mailDeliverySnapshots.eventId, seeded.eventId))).toHaveLength(0);
  });
});
