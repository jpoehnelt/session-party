import {
  applyD1Migrations,
  env,
  runInDurableObject,
  type D1Migration,
} from "cloudflare:test";
import {
  airtableDeadLetters,
  airtableOutbox,
  airtablePendingEdits,
  airtableRecordLinks,
  airtableRefreshState,
  auditLog,
  domainChanges,
  events,
  integrations,
  speakers,
} from "contracts/schema";
import type { ServerMessage } from "contracts/protocol";
import type { AirtableConfig } from "contracts/types";
import { eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { beforeAll, describe, expect, it } from "vitest";
import {
  AirtableAdapterError,
  createFakeAirtableAdapter,
  fakeAirtableStorageKey,
  type AirtableRecord,
} from "../airtable";
import { internalServiceToken } from "../services";
import { setAirtableAlarmNoLaterThan } from "./AirtableSyncLane";
import {
  AIRTABLE_PROJECTION_SCAN_PAGE_SIZE,
  drainAirtableBase,
  type AirtableProjectionCursor,
  requestRefreshRows,
} from "./airtable-engine";
import { sha256 } from "./airtable-mapping";

type TestEnv = Cloudflare.Env & { readonly TEST_MIGRATIONS: readonly D1Migration[] };

const EVENT_ID = "airtable-sync-event";
const BASE_ID = "appAirtableSyncProof";
const INTEGRATION_ID = "airtable-sync-integration";
const SPEAKER_ID = "airtable-sync-speaker";

const config: AirtableConfig = {
  kind: "airtable",
  baseId: BASE_ID,
  origin: "test-suite",
  tables: {
    speakers: {
      tableId: "tblSpeakers",
      fields: {
        sessionPartyId: "fldSpeakerSessionPartyId",
        spRevision: "fldSpeakerRevision",
        spHash: "fldSpeakerHash",
        spOrigin: "fldSpeakerOrigin",
        displayName: "fldDisplayName",
        jobTitle: "fldJobTitle",
        company: "fldCompany",
        bio: "fldBio",
        visibility: "fldVisibility",
      },
    },
    submissions: {
      tableId: "tblSubmissions",
      fields: {
        sessionPartyId: "fldSubmissionSessionPartyId",
        spRevision: "fldSubmissionRevision",
        spHash: "fldSubmissionHash",
        spOrigin: "fldSubmissionOrigin",
        title: "fldSubmissionTitle",
        abstract: "fldAbstract",
        category: "fldCategory",
        status: "fldSubmissionStatus",
        submittedAt: "fldSubmittedAt",
        speakerLinks: "fldSubmissionSpeakers",
      },
    },
    talks: {
      tableId: "tblTalks",
      fields: {
        sessionPartyId: "fldTalkSessionPartyId",
        spRevision: "fldTalkRevision",
        spHash: "fldTalkHash",
        spOrigin: "fldTalkOrigin",
        title: "fldTalkTitle",
        description: "fldTalkDescription",
        track: "fldTrack",
        room: "fldRoom",
        startsAt: "fldStartsAt",
        durationMin: "fldDuration",
        status: "fldTalkStatus",
        speakerLinks: "fldTalkSpeakers",
        submissionLink: "fldTalkSubmission",
      },
    },
  },
};

beforeAll(async () => {
  if (!("TEST_MIGRATIONS" in env)) throw new Error("TEST_MIGRATIONS binding is unavailable");
  await applyD1Migrations(env.DB, [...(env as TestEnv).TEST_MIGRATIONS]);
  const now = new Date();
  const db = drizzle(env.DB);
  await db.insert(events).values({
    id: EVENT_ID,
    slug: EVENT_ID,
    name: "Airtable Sync Proof",
    timezone: "UTC",
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(integrations).values({
    id: INTEGRATION_ID,
    eventId: EVENT_ID,
    kind: "airtable",
    secretRef: "AIRTABLE_PAT",
    config,
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(speakers).values({
    id: SPEAKER_ID,
    eventId: EVENT_ID,
    displayName: "Original Speaker",
    title: null,
    company: "Session Party",
    bio: "Original biography",
    visible: true,
    createdAt: now,
    updatedAt: now,
  });
});

describe("AirtableSyncLane", () => {
  it("requires an internal wake and binds one Durable Object to one base", async () => {
    const authorizationBase = "appLaneAuthorizationProof";
    const stub = env.AIRTABLE_SYNC.get(env.AIRTABLE_SYNC.idFromName(authorizationBase));
    await runInDurableObject(stub, async (_instance, state) => state.storage.deleteAll());
    await expect(stub.fetch("https://airtable-sync/poke", {
      method: "POST",
      body: JSON.stringify({ baseId: authorizationBase }),
    }).then((response) => response.status)).resolves.toBe(403);
    const response = await stub.fetch("https://airtable-sync/poke", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-session-party-internal": await internalServiceToken(env),
      },
      body: JSON.stringify({ baseId: authorizationBase }),
    });
    expect(response.status).toBe(200);
    const mismatch = await stub.fetch("https://airtable-sync/poke", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-session-party-internal": await internalServiceToken(env),
      },
      body: JSON.stringify({ baseId: "appDifferentBase" }),
    });
    expect(mismatch.status).toBe(409);
  });

  it("never postpones an earlier poke alarm", async () => {
    const stub = env.AIRTABLE_SYNC.get(env.AIRTABLE_SYNC.idFromName("appAlarmOrderingProof"));
    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.deleteAll();
      const now = Date.now();
      const recovery = now + 60_000;
      const poke = now + 10_000;
      await state.storage.setAlarm(recovery);
      await setAirtableAlarmNoLaterThan(state.storage, poke);
      expect(await state.storage.getAlarm()).toBe(poke);
      await setAirtableAlarmNoLaterThan(state.storage, recovery + 60_000);
      expect(await state.storage.getAlarm()).toBe(poke);
    });
  });

  it("bootstraps outbound state, confirms pending edits, and broadcasts only after commit", async () => {
    const db = drizzle(env.DB);
    const stub = env.AIRTABLE_SYNC.get(env.AIRTABLE_SYNC.idFromName(BASE_ID));
    const messages = await runInDurableObject(stub, async (_instance, state) => {
      await drainAirtableBase({
        database: env.DB,
        adapter: createFakeAirtableAdapter(state.storage),
        broadcast: async (_eventId, message) => {
          await state.storage.put("test-broadcast-bootstrap", message);
        },
      }, BASE_ID);
      const fake = await state.storage.get<{
        records: Readonly<Record<string, AirtableRecord>>;
      }>(fakeAirtableStorageKey(BASE_ID, config.tables.speakers.tableId));
      const record = Object.values(fake?.records ?? {})[0];
      expect(record?.fields).toMatchObject({
        fldSpeakerSessionPartyId: SPEAKER_ID,
        fldDisplayName: "Original Speaker",
        fldVisibility: true,
      });
      const delivered = await state.storage.get<ServerMessage>("test-broadcast-bootstrap");
      return delivered ? [delivered] : [];
    });
    const [bootstrap] = await db.select().from(airtableOutbox).where(eq(airtableOutbox.entityId, SPEAKER_ID));
    expect(bootstrap).toMatchObject({ status: "succeeded", entityType: "speaker", attemptCount: 1 });
    expect(messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ t: "integrations/airtable_sync", entityId: SPEAKER_ID, state: "refreshed" }),
    ]));

    const now = new Date();
    await db.insert(airtablePendingEdits).values({
      id: "pending-speaker-title",
      eventId: EVENT_ID,
      integrationId: INTEGRATION_ID,
      entityType: "speaker",
      entityId: SPEAKER_ID,
      speakerId: SPEAKER_ID,
      fieldKey: "title",
      intendedValue: "Principal Engineer",
      status: "pending",
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(airtableOutbox).values({
      id: "outbox-speaker-title",
      eventId: EVENT_ID,
      integrationId: INTEGRATION_ID,
      pendingEditId: "pending-speaker-title",
      entityType: "speaker",
      entityId: SPEAKER_ID,
      speakerId: SPEAKER_ID,
      sessionPartyId: SPEAKER_ID,
      operation: "upsert",
      changedFields: { title: "Principal Engineer" },
      outboundRevision: (bootstrap?.outboundRevision ?? 1) + 1,
      outboundHash: "a".repeat(64),
      origin: "speaker-portal",
      idempotencyKey: "pending-speaker-title",
      status: "pending",
      availableAt: now,
      attemptCount: 0,
      createdAt: now,
    });
    const confirmationMessages = await runInDurableObject(stub, async (_instance, state) => {
      await drainAirtableBase({
        database: env.DB,
        adapter: createFakeAirtableAdapter(state.storage),
        broadcast: async (_eventId, message) => {
          await state.storage.put("test-broadcast-confirmation", message);
        },
      }, BASE_ID);
      const delivered = await state.storage.get<ServerMessage>("test-broadcast-confirmation");
      return delivered ? [delivered] : [];
    });
    await expect(db.select().from(airtablePendingEdits).where(eq(airtablePendingEdits.id, "pending-speaker-title")))
      .resolves.toEqual([expect.objectContaining({ status: "confirmed", conflictValue: null })]);
    await expect(db.select().from(airtableOutbox).where(eq(airtableOutbox.id, "outbox-speaker-title")))
      .resolves.toEqual([expect.objectContaining({ status: "succeeded" })]);
    await expect(db.select().from(speakers).where(eq(speakers.id, SPEAKER_ID)))
      .resolves.toEqual([expect.objectContaining({ title: "Principal Engineer" })]);
    expect(confirmationMessages.at(-1)).toMatchObject({ state: "confirmed", fields: ["title"] });
  });

  it("refreshes Airtable-owned fields, ignores D1-owned edits, and records ownership violations", async () => {
    const db = drizzle(env.DB);
    const stub = env.AIRTABLE_SYNC.get(env.AIRTABLE_SYNC.idFromName(BASE_ID));
    await requestRefreshRows(env.DB, INTEGRATION_ID, EVENT_ID, ["speaker"]);
    await runInDurableObject(stub, async (_instance, state) => {
      const key = fakeAirtableStorageKey(BASE_ID, config.tables.speakers.tableId);
      const fake = await state.storage.get<{
        readonly nextRecord: number;
        readonly records: Readonly<Record<string, AirtableRecord>>;
      }>(key);
      if (!fake) throw new Error("Expected bootstrapped fake Airtable table");
      const [record] = Object.values(fake.records);
      if (!record) throw new Error("Expected bootstrapped fake Airtable record");
      await state.storage.put(key, {
        ...fake,
        records: {
          ...fake.records,
          [record.id]: {
            ...record,
            fields: {
              ...record.fields,
              [config.tables.speakers.fields.displayName]: "Airtable Speaker",
              [config.tables.speakers.fields.visibility]: false,
            },
          },
        },
      });
      await drainAirtableBase({
        database: env.DB,
        adapter: createFakeAirtableAdapter(state.storage),
        broadcast: async () => {
          const [speaker] = await drizzle(env.DB).select().from(speakers).where(eq(speakers.id, SPEAKER_ID));
          expect(speaker).toMatchObject({ displayName: "Airtable Speaker", visible: true });
        },
      }, BASE_ID);
    });
    await expect(db.select().from(speakers).where(eq(speakers.id, SPEAKER_ID)))
      .resolves.toEqual([expect.objectContaining({ displayName: "Airtable Speaker", visible: true })]);
    await expect(db.select().from(airtableDeadLetters).where(eq(airtableDeadLetters.errorCode, "d1_authority_violation")))
      .resolves.toHaveLength(1);
    await expect(db.select().from(airtableRefreshState).where(eq(airtableRefreshState.integrationId, INTEGRATION_ID)))
      .resolves.toEqual(expect.arrayContaining([
        expect.objectContaining({ entityType: "speaker", status: "idle" }),
      ]));
    await expect(db.select().from(domainChanges).where(eq(domainChanges.eventType, "integrations.airtable.refreshed")))
      .resolves.not.toHaveLength(0);
    await expect(db.select().from(auditLog).where(eq(auditLog.action, "integrations.airtable.refreshed")))
      .resolves.not.toHaveLength(0);
  });

  it("requests and begins a coalesced refresh when the alarm observes stale cache state", async () => {
    const db = drizzle(env.DB);
    await db.update(airtableRefreshState).set({
      status: "idle",
      lastSuccessAt: new Date(0),
      dueAt: null,
      cursor: null,
      leaseOwner: null,
      leaseExpiresAt: null,
    }).where(eq(airtableRefreshState.integrationId, INTEGRATION_ID));
    const now = new Date(Date.now() + 61_000);
    const stub = env.AIRTABLE_SYNC.get(env.AIRTABLE_SYNC.idFromName(BASE_ID));
    const result = await runInDurableObject(stub, async (_instance, state) => drainAirtableBase({
      database: env.DB,
      adapter: createFakeAirtableAdapter(state.storage),
      broadcast: async () => undefined,
      now: () => now,
    }, BASE_ID));

    const refreshes = await db.select().from(airtableRefreshState)
      .where(eq(airtableRefreshState.integrationId, INTEGRATION_ID));
    expect(result).toEqual({ processed: true, nextAlarmAt: now.getTime() + 250 });
    expect(refreshes).toHaveLength(3);
    expect(refreshes.filter((row) => row.status === "idle")).toHaveLength(1);
    expect(refreshes.filter((row) => row.status === "requested")).toHaveLength(2);
  });

  it("lets an inbound Airtable edit win over a pending organizer intent", async () => {
    const db = drizzle(env.DB);
    const entityId = "airtable-inbound-conflict-speaker";
    const pendingId = "airtable-inbound-conflict-pending";
    const now = new Date();
    await db.insert(speakers).values({
      id: entityId,
      eventId: EVENT_ID,
      displayName: "Inbound Conflict Speaker",
      title: "Before",
      visible: true,
      version: 1,
      createdAt: now,
      updatedAt: now,
    });
    const stub = env.AIRTABLE_SYNC.get(env.AIRTABLE_SYNC.idFromName(BASE_ID));
    const record = await runInDurableObject(stub, async (_instance, state) => {
      const fake = createFakeAirtableAdapter(state.storage);
      const [written] = await fake.upsertBatch({
        baseId: BASE_ID,
        tableId: config.tables.speakers.tableId,
        mergeFieldId: config.tables.speakers.fields.sessionPartyId,
        records: [{
          sessionPartyId: entityId,
          fields: {
            [config.tables.speakers.fields.displayName]: "Inbound Conflict Speaker",
            [config.tables.speakers.fields.jobTitle]: "Before",
            [config.tables.speakers.fields.visibility]: true,
          },
        }],
      });
      return written!;
    });
    const inboundHash = await sha256({
      displayName: "Inbound Conflict Speaker",
      title: "Before",
      company: null,
      bio: null,
    });
    await db.insert(airtableRecordLinks).values({
      id: "airtable-inbound-conflict-link",
      eventId: EVENT_ID,
      integrationId: INTEGRATION_ID,
      entityType: "speaker",
      entityId,
      speakerId: entityId,
      sessionPartyId: entityId,
      airtableRecordId: record.id,
      outboundRevision: 1,
      outboundHash: await sha256({ visible: true }),
      inboundRevision: inboundHash,
      inboundHash,
      origin: config.origin,
      lastRefreshedAt: now,
      version: 1,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(airtablePendingEdits).values({
      id: pendingId,
      eventId: EVENT_ID,
      integrationId: INTEGRATION_ID,
      entityType: "speaker",
      entityId,
      speakerId: entityId,
      fieldKey: "title",
      intendedValue: "Organizer Intent",
      baseInboundRevision: inboundHash,
      baseInboundHash: inboundHash,
      status: "pending",
      createdAt: now,
      updatedAt: now,
    });
    await db.update(airtableRefreshState).set({
      status: "idle",
      lastSuccessAt: now,
      dueAt: null,
      cursor: null,
      leaseOwner: null,
      leaseExpiresAt: null,
    }).where(eq(airtableRefreshState.integrationId, INTEGRATION_ID));
    await requestRefreshRows(env.DB, INTEGRATION_ID, EVENT_ID, ["speaker"], now);

    const messages = await runInDurableObject(stub, async (_instance, state) => {
      const key = fakeAirtableStorageKey(BASE_ID, config.tables.speakers.tableId);
      const fake = await state.storage.get<{
        readonly nextRecord: number;
        readonly records: Readonly<Record<string, AirtableRecord>>;
      }>(key);
      if (!fake) throw new Error("Expected fake Airtable records");
      await state.storage.put(key, {
        ...fake,
        records: {
          ...fake.records,
          [record.id]: {
            ...record,
            fields: {
              ...record.fields,
              [config.tables.speakers.fields.jobTitle]: "Airtable Wins",
            },
          },
        },
      });
      const delivered: ServerMessage[] = [];
      await drainAirtableBase({
        database: env.DB,
        adapter: createFakeAirtableAdapter(state.storage),
        broadcast: async (_eventId, message) => { delivered.push(message); },
        now: () => now,
      }, BASE_ID);
      return delivered;
    });

    await expect(db.select().from(airtablePendingEdits).where(eq(airtablePendingEdits.id, pendingId)))
      .resolves.toEqual([expect.objectContaining({ status: "conflict", conflictValue: "Airtable Wins" })]);
    await expect(db.select().from(speakers).where(eq(speakers.id, entityId)))
      .resolves.toEqual([expect.objectContaining({ title: "Airtable Wins", version: 2 })]);
    expect(messages.at(-1)).toMatchObject({ state: "conflict", entityId });
  });

  it("promotes organizer edits to durable conflicts when Airtable returns a different value", async () => {
    const db = drizzle(env.DB);
    const entityId = "airtable-conflict-speaker";
    const pendingId = "airtable-conflict-pending";
    const outboxId = "airtable-conflict-outbox";
    const now = new Date();
    await db.insert(speakers).values({
      id: entityId,
      eventId: EVENT_ID,
      displayName: "Conflict Speaker",
      title: "Before",
      visible: true,
      version: 1,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(airtablePendingEdits).values({
      id: pendingId,
      eventId: EVENT_ID,
      integrationId: INTEGRATION_ID,
      entityType: "speaker",
      entityId,
      speakerId: entityId,
      fieldKey: "title",
      intendedValue: "Organizer Intent",
      status: "pending",
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(airtableOutbox).values({
      id: outboxId,
      eventId: EVENT_ID,
      integrationId: INTEGRATION_ID,
      pendingEditId: pendingId,
      entityType: "speaker",
      entityId,
      speakerId: entityId,
      sessionPartyId: entityId,
      operation: "upsert",
      changedFields: { title: "Organizer Intent", visible: true },
      outboundRevision: 1,
      outboundHash: await sha256({ visible: true }),
      origin: "speaker-portal",
      idempotencyKey: outboxId,
      status: "pending",
      availableAt: now,
      attemptCount: 0,
      createdAt: now,
    });

    const stub = env.AIRTABLE_SYNC.get(env.AIRTABLE_SYNC.idFromName(BASE_ID));
    const messages = await runInDurableObject(stub, async (_instance, state) => {
      const fake = createFakeAirtableAdapter(state.storage);
      const delivered: ServerMessage[] = [];
      await drainAirtableBase({
        database: env.DB,
        adapter: {
          ...fake,
          upsertBatch: async (input) => (await fake.upsertBatch(input)).map((record) => ({
            ...record,
            fields: {
              ...record.fields,
              [config.tables.speakers.fields.jobTitle]: "Airtable Override",
            },
          })),
        },
        broadcast: async (_eventId, message) => { delivered.push(message); },
      }, BASE_ID);
      return delivered;
    });

    await expect(db.select().from(airtablePendingEdits).where(eq(airtablePendingEdits.id, pendingId)))
      .resolves.toEqual([expect.objectContaining({ status: "conflict", conflictValue: "Airtable Override" })]);
    await expect(db.select().from(speakers).where(eq(speakers.id, entityId)))
      .resolves.toEqual([expect.objectContaining({ title: "Airtable Override", version: 2 })]);
    expect(messages.at(-1)).toMatchObject({ state: "conflict", entityId, fields: ["title", "visible"] });
  });

  it("respects Airtable retry timing without dead-lettering transient failures", async () => {
    const db = drizzle(env.DB);
    const entityId = "airtable-retry-speaker";
    const outboxId = "airtable-retry-outbox";
    const now = new Date();
    await db.insert(speakers).values({
      id: entityId,
      eventId: EVENT_ID,
      displayName: "Retry Speaker",
      visible: true,
      version: 1,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(airtableOutbox).values({
      id: outboxId,
      eventId: EVENT_ID,
      integrationId: INTEGRATION_ID,
      entityType: "speaker",
      entityId,
      speakerId: entityId,
      sessionPartyId: entityId,
      operation: "upsert",
      changedFields: { visible: true },
      outboundRevision: 1,
      outboundHash: await sha256({ visible: true }),
      origin: "test",
      idempotencyKey: outboxId,
      status: "pending",
      availableAt: now,
      attemptCount: 0,
      createdAt: now,
    });
    await db.insert(airtableOutbox).values({
      id: `${outboxId}-later`,
      eventId: EVENT_ID,
      integrationId: INTEGRATION_ID,
      entityType: "speaker",
      entityId,
      speakerId: entityId,
      sessionPartyId: entityId,
      operation: "upsert",
      changedFields: { visible: false },
      outboundRevision: 2,
      outboundHash: await sha256({ visible: false }),
      origin: "test",
      idempotencyKey: `${outboxId}-later`,
      status: "pending",
      availableAt: now,
      attemptCount: 0,
      createdAt: new Date(now.getTime() + 1),
    });

    let upsertCalls = 0;
    const retryingAdapter = {
      mode: "live" as const,
      upsertBatch: async (): Promise<readonly AirtableRecord[]> => {
        upsertCalls += 1;
        throw new AirtableAdapterError({
          code: "http_429",
          message: "Rate limited",
          retryable: true,
          retryAfterMs: 30_000,
        });
      },
      deleteBatch: async () => undefined,
      listPage: async () => ({ records: [] }),
    };
    await drainAirtableBase({
      database: env.DB,
      adapter: retryingAdapter,
      broadcast: async () => undefined,
      now: () => now,
    }, BASE_ID);

    const [retry] = await db.select().from(airtableOutbox).where(eq(airtableOutbox.id, outboxId));
    expect(retry).toMatchObject({ status: "retry", attemptCount: 1, deadLetteredAt: null });
    expect(retry!.availableAt.getTime()).toBeGreaterThanOrEqual(now.getTime() + 30_000);
    await drainAirtableBase({
      database: env.DB,
      adapter: retryingAdapter,
      broadcast: async () => undefined,
      now: () => new Date(now.getTime() + 1_000),
    }, BASE_ID);
    await expect(db.select().from(airtableOutbox).where(eq(airtableOutbox.id, `${outboxId}-later`)))
      .resolves.toEqual([expect.objectContaining({ status: "pending", attemptCount: 0 })]);
    expect(upsertCalls).toBe(1);
  });

  it("dead-letters permanent mapping failures and blocks later ordered work", async () => {
    const db = drizzle(env.DB);
    const [link] = await db.select().from(airtableRecordLinks).where(eq(airtableRecordLinks.entityId, SPEAKER_ID));
    const now = new Date();
    await db.insert(airtableOutbox).values([
      {
        id: "outbox-invalid-field",
        eventId: EVENT_ID,
        integrationId: INTEGRATION_ID,
        entityType: "speaker" as const,
        entityId: SPEAKER_ID,
        speakerId: SPEAKER_ID,
        sessionPartyId: SPEAKER_ID,
        operation: "upsert" as const,
        changedFields: { notMapped: "value" },
        outboundRevision: (link?.outboundRevision ?? 2) + 1,
        outboundHash: "b".repeat(64),
        origin: "test",
        idempotencyKey: "invalid-field",
        status: "pending" as const,
        availableAt: now,
        attemptCount: 0,
        createdAt: now,
      },
      {
        id: "outbox-after-invalid",
        eventId: EVENT_ID,
        integrationId: INTEGRATION_ID,
        entityType: "speaker" as const,
        entityId: SPEAKER_ID,
        speakerId: SPEAKER_ID,
        sessionPartyId: SPEAKER_ID,
        operation: "upsert" as const,
        changedFields: { visible: false },
        outboundRevision: (link?.outboundRevision ?? 2) + 2,
        outboundHash: "c".repeat(64),
        origin: "test",
        idempotencyKey: "after-invalid",
        status: "pending" as const,
        availableAt: now,
        attemptCount: 0,
        createdAt: new Date(now.getTime() + 1),
      },
    ]);
    const stub = env.AIRTABLE_SYNC.get(env.AIRTABLE_SYNC.idFromName(BASE_ID));
    await runInDurableObject(stub, async (_instance, state) => {
      await drainAirtableBase({
        database: env.DB,
        adapter: createFakeAirtableAdapter(state.storage),
        broadcast: async () => undefined,
      }, BASE_ID);
    });
    await expect(db.select({ id: airtableOutbox.id, status: airtableOutbox.status }).from(airtableOutbox).where(
      inArray(airtableOutbox.id, ["outbox-invalid-field", "outbox-after-invalid"]),
    )).resolves.toEqual(expect.arrayContaining([
      { id: "outbox-invalid-field", status: "dead_letter" },
      { id: "outbox-after-invalid", status: "blocked" },
    ]));
  });

  it("rolls back the terminal outbox transition when dead-letter evidence cannot commit", async () => {
    const db = drizzle(env.DB);
    const now = new Date();
    await db.insert(airtableOutbox).values([
      {
        id: "outbox-atomic-failure",
        eventId: EVENT_ID,
        integrationId: INTEGRATION_ID,
        entityType: "speaker",
        entityId: SPEAKER_ID,
        speakerId: SPEAKER_ID,
        sessionPartyId: SPEAKER_ID,
        operation: "upsert",
        changedFields: { notMapped: "value" },
        outboundRevision: 100_000,
        outboundHash: "d".repeat(64),
        origin: "test",
        idempotencyKey: "atomic-failure",
        status: "pending",
        availableAt: now,
        attemptCount: 0,
        createdAt: now,
      },
      {
        id: "outbox-after-atomic-failure",
        eventId: EVENT_ID,
        integrationId: INTEGRATION_ID,
        entityType: "speaker",
        entityId: SPEAKER_ID,
        speakerId: SPEAKER_ID,
        sessionPartyId: SPEAKER_ID,
        operation: "upsert",
        changedFields: { visible: false },
        outboundRevision: 100_001,
        outboundHash: "e".repeat(64),
        origin: "test",
        idempotencyKey: "after-atomic-failure",
        status: "pending",
        availableAt: now,
        attemptCount: 0,
        createdAt: new Date(now.getTime() + 1),
      },
    ]);
    await env.DB.prepare(
      "CREATE TRIGGER fail_airtable_dead_letter BEFORE INSERT ON airtable_dead_letters WHEN new.source_id = 'outbox-atomic-failure' BEGIN SELECT RAISE(ABORT, 'forced dead-letter failure'); END",
    ).run();
    try {
      const stub = env.AIRTABLE_SYNC.get(env.AIRTABLE_SYNC.idFromName(BASE_ID));
      await runInDurableObject(stub, async (_instance, state) => {
        await expect(drainAirtableBase({
          database: env.DB,
          adapter: createFakeAirtableAdapter(state.storage),
          broadcast: async () => undefined,
          now: () => now,
        }, BASE_ID)).rejects.toThrow(/forced dead-letter failure/);
      });
    } finally {
      await env.DB.prepare("DROP TRIGGER IF EXISTS fail_airtable_dead_letter").run();
    }

    await expect(db.select({ id: airtableOutbox.id, status: airtableOutbox.status }).from(airtableOutbox).where(
      inArray(airtableOutbox.id, ["outbox-atomic-failure", "outbox-after-atomic-failure"]),
    )).resolves.toEqual(expect.arrayContaining([
      { id: "outbox-atomic-failure", status: "claimed" },
      { id: "outbox-after-atomic-failure", status: "pending" },
    ]));
    await expect(db.select().from(airtableDeadLetters).where(eq(airtableDeadLetters.sourceId, "outbox-atomic-failure")))
      .resolves.toEqual([]);
  });

  it("advances a durable bounded recovery cursor instead of rescanning the event", async () => {
    const now = new Date();
    const hash = await sha256({ visible: true });
    const ids = Array.from(
      { length: AIRTABLE_PROJECTION_SCAN_PAGE_SIZE + 5 },
      (_, index) => `zz-airtable-scan-${String(index).padStart(2, "0")}`,
    );
    await env.DB.batch(ids.map((id) => env.DB.prepare(
      `INSERT INTO speakers (id, event_id, display_name, visible, version, created_at, updated_at)
       VALUES (?, ?, ?, 1, 1, ?, ?)`,
    ).bind(id, EVENT_ID, id, now.getTime(), now.getTime())));
    await env.DB.batch(ids.map((id, index) => env.DB.prepare(
      `INSERT INTO airtable_record_links
        (id, event_id, integration_id, entity_type, entity_id, speaker_id, session_party_id,
         airtable_record_id, outbound_revision, outbound_hash, origin, last_refreshed_at,
         version, created_at, updated_at)
       VALUES (?, ?, ?, 'speaker', ?, ?, ?, ?, 1, ?, ?, ?, 1, ?, ?)`,
    ).bind(
      `zz-airtable-scan-link-${index}`,
      EVENT_ID,
      INTEGRATION_ID,
      id,
      id,
      id,
      `recAirtableScan${String(index).padStart(2, "0")}`,
      hash,
      config.origin,
      now.getTime(),
      now.getTime(),
      now.getTime(),
    )));
    await env.DB.prepare(
      `UPDATE airtable_refresh_state
       SET status = 'idle', due_at = NULL, last_success_at = ?, cursor = NULL,
           lease_owner = NULL, lease_expires_at = NULL, last_error = NULL, dead_lettered_at = NULL
       WHERE integration_id = ?`,
    ).bind(now.getTime(), INTEGRATION_ID).run();

    const stub = env.AIRTABLE_SYNC.get(env.AIRTABLE_SYNC.idFromName(BASE_ID));
    await runInDurableObject(stub, async (_instance, state) => {
      const cursorKey = "test-performance-projection-cursor";
      await state.storage.put<AirtableProjectionCursor>(cursorKey, {
        entityType: "speaker",
        afterId: "zz-airtable-scan-",
      });
      const cursorStore = {
        get: async () => state.storage.get<AirtableProjectionCursor>(cursorKey),
        set: async (_integrationId: string, cursor: AirtableProjectionCursor) => state.storage.put(cursorKey, cursor),
      };
      let requests = 0;
      const noRequestAdapter = {
        mode: "fake" as const,
        upsertBatch: async (): Promise<readonly AirtableRecord[]> => { requests += 1; return []; },
        deleteBatch: async (): Promise<void> => { requests += 1; },
        listPage: async () => { requests += 1; return { records: [] }; },
      };
      await drainAirtableBase({
        database: env.DB,
        adapter: noRequestAdapter,
        broadcast: async () => undefined,
        now: () => now,
        projectionCursor: cursorStore,
      }, BASE_ID);
      expect(await state.storage.get(cursorKey)).toEqual({
        entityType: "speaker",
        afterId: ids[AIRTABLE_PROJECTION_SCAN_PAGE_SIZE - 1],
      });
      await drainAirtableBase({
        database: env.DB,
        adapter: noRequestAdapter,
        broadcast: async () => undefined,
        now: () => now,
        projectionCursor: cursorStore,
      }, BASE_ID);
      expect(await state.storage.get(cursorKey)).toEqual({ entityType: "submission", afterId: null });
      expect(requests).toBe(0);
    });
  });

  it("processes one refresh page with bounded record concurrency", async () => {
    const now = new Date(Date.now() + 1_000);
    const ids = Array.from({ length: 8 }, (_, index) => `zz-airtable-scan-${String(index).padStart(2, "0")}`);
    await requestRefreshRows(env.DB, INTEGRATION_ID, EVENT_ID, ["speaker"], now);
    let listRequests = 0;
    let activeBroadcasts = 0;
    let maxActiveBroadcasts = 0;
    const records = ids.map((id, index): AirtableRecord => ({
      id: `recAirtableScan${String(index).padStart(2, "0")}`,
      createdTime: "2000-01-01T00:00:00.000Z",
      fields: {
        [config.tables.speakers.fields.sessionPartyId]: id,
        [config.tables.speakers.fields.displayName]: id,
        [config.tables.speakers.fields.visibility]: true,
      },
    }));
    await drainAirtableBase({
      database: env.DB,
      adapter: {
        mode: "fake",
        upsertBatch: async () => { throw new Error("unexpected outbound request"); },
        deleteBatch: async () => { throw new Error("unexpected delete request"); },
        listPage: async () => { listRequests += 1; return { records }; },
      },
      broadcast: async () => {
        activeBroadcasts += 1;
        maxActiveBroadcasts = Math.max(maxActiveBroadcasts, activeBroadcasts);
        await new Promise((resolve) => setTimeout(resolve, 5));
        activeBroadcasts -= 1;
      },
      now: () => now,
      projectionCursor: {
        get: async () => ({ entityType: "submission", afterId: "zzzz" }),
        set: async () => undefined,
      },
    }, BASE_ID);
    expect(listRequests).toBe(1);
    expect(maxActiveBroadcasts).toBeGreaterThan(1);
    expect(maxActiveBroadcasts).toBeLessThanOrEqual(4);
  });

  it("batches independent outbox claims while preserving earlier-revision ordering", async () => {
    const now = new Date(Date.now() + 2_000);
    const dueIds = Array.from({ length: 10 }, (_, index) => `zz-airtable-scan-${String(index).padStart(2, "0")}`);
    await env.DB.batch(dueIds.map((entityId, index) => env.DB.prepare(
      `INSERT INTO airtable_outbox
        (id, event_id, integration_id, entity_type, entity_id, speaker_id, session_party_id,
         operation, changed_fields, outbound_revision, outbound_hash, origin, idempotency_key,
         status, available_at, attempt_count, created_at)
       VALUES (?, ?, ?, 'speaker', ?, ?, ?, 'upsert', '{"visible":false}', 2, ?, 'test', ?, 'pending', ?, 0, ?)`,
    ).bind(
      `batched-claim-${index}`,
      EVENT_ID,
      INTEGRATION_ID,
      entityId,
      entityId,
      entityId,
      "f".repeat(64),
      `batched-claim-${index}`,
      now.getTime(),
      now.getTime(),
    )));
    const orderedEntity = "zz-airtable-scan-10";
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO airtable_outbox
          (id, event_id, integration_id, entity_type, entity_id, speaker_id, session_party_id,
           operation, changed_fields, outbound_revision, outbound_hash, origin, idempotency_key,
           status, available_at, attempt_count, created_at)
         VALUES ('ordered-earlier', ?, ?, 'speaker', ?, ?, ?, 'upsert', '{"visible":true}', 2, ?, 'test', 'ordered-earlier', 'pending', ?, 0, ?)`,
      ).bind(EVENT_ID, INTEGRATION_ID, orderedEntity, orderedEntity, orderedEntity, "e".repeat(64), now.getTime() + 60_000, now.getTime()),
      env.DB.prepare(
        `INSERT INTO airtable_outbox
          (id, event_id, integration_id, entity_type, entity_id, speaker_id, session_party_id,
           operation, changed_fields, outbound_revision, outbound_hash, origin, idempotency_key,
           status, available_at, attempt_count, created_at)
         VALUES ('ordered-later', ?, ?, 'speaker', ?, ?, ?, 'upsert', '{"visible":false}', 3, ?, 'test', 'ordered-later', 'pending', ?, 0, ?)`,
      ).bind(EVENT_ID, INTEGRATION_ID, orderedEntity, orderedEntity, orderedEntity, "d".repeat(64), now.getTime(), now.getTime() + 1),
    ]);

    let batchCalls = 0;
    const countedDatabase = new Proxy(env.DB, {
      get(target, property) {
        const value = Reflect.get(target, property, target);
        if (property === "batch") {
          return (...args: Parameters<D1Database["batch"]>) => {
            batchCalls += 1;
            return target.batch(...args);
          };
        }
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    let claimedRecords = 0;
    await drainAirtableBase({
      database: countedDatabase,
      adapter: {
        mode: "live",
        upsertBatch: async (input): Promise<readonly AirtableRecord[]> => {
          claimedRecords = input.records.length;
          throw new AirtableAdapterError({ code: "test_retry", message: "retry", retryable: true });
        },
        deleteBatch: async () => undefined,
        listPage: async () => ({ records: [] }),
      },
      broadcast: async () => undefined,
      now: () => now,
      projectionCursor: {
        get: async () => ({ entityType: "speaker", afterId: "zzzz" }),
        set: async () => undefined,
      },
    }, BASE_ID);
    expect(claimedRecords).toBe(10);
    expect(batchCalls).toBe(1);
    await expect(env.DB.prepare(
      "SELECT id, status, attempt_count FROM airtable_outbox WHERE id IN ('ordered-earlier', 'ordered-later') ORDER BY id",
    ).all()).resolves.toMatchObject({
      results: [
        { id: "ordered-earlier", status: "pending", attempt_count: 0 },
        { id: "ordered-later", status: "pending", attempt_count: 0 },
      ],
    });
  });
});
