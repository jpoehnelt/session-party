import {
  airtableOutbox,
  airtableRecordLinks,
  integrations,
  rooms,
  speakers,
  submissionSpeakers,
  submissions,
  talks,
  tracks,
} from "contracts/schema";
import type { AirtableEntityType } from "contracts/types";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import type { AppDatabase } from "../services";
import { sha256 } from "./airtable-mapping";

export interface AirtableProjectionInput {
  readonly eventId: string;
  readonly entityType: AirtableEntityType;
  readonly entityId: string;
  /** Entity version visible after the caller's mutation statement runs. */
  readonly entityVersion: number;
  /** Only the typed fields changed by this domain operation. */
  readonly changedFields: Readonly<Record<string, unknown>>;
  /** The complete normalized D1-authoritative projection after this operation. */
  readonly d1Projection: Readonly<Record<string, unknown>>;
  readonly origin: string;
  readonly idempotencyKey: string;
  readonly now: Date;
}

export interface PreparedAirtableProjection {
  readonly statement: BatchItem<"sqlite">;
}

/**
 * Prepares an immutable Airtable outbox insert for inclusion in the caller's
 * existing D1 batch. Returning null means this event has no Airtable mapping.
 */
export const prepareAirtableProjection = async (
  db: AppDatabase,
  input: AirtableProjectionInput,
): Promise<PreparedAirtableProjection | null> => {
  const [integration] = await db
    .select({ id: integrations.id })
    .from(integrations)
    .where(and(eq(integrations.eventId, input.eventId), eq(integrations.kind, "airtable")))
    .limit(1);
  if (!integration) return null;
  const [[link], [latest]] = await Promise.all([
    db
      .select({ outboundRevision: airtableRecordLinks.outboundRevision })
      .from(airtableRecordLinks)
      .where(and(
        eq(airtableRecordLinks.integrationId, integration.id),
        eq(airtableRecordLinks.entityType, input.entityType),
        eq(airtableRecordLinks.entityId, input.entityId),
      ))
      .limit(1),
    db
      .select({ outboundRevision: airtableOutbox.outboundRevision })
      .from(airtableOutbox)
      .where(and(
        eq(airtableOutbox.integrationId, integration.id),
        eq(airtableOutbox.entityType, input.entityType),
        eq(airtableOutbox.entityId, input.entityId),
      ))
      .orderBy(desc(airtableOutbox.outboundRevision))
      .limit(1),
  ]);
  const outboundRevision = Math.max(
    link?.outboundRevision ?? 0,
    latest?.outboundRevision ?? 0,
  ) + 1;
  const owner = input.entityType === "speaker"
    ? { speakerId: input.entityId, submissionId: null, talkId: null }
    : input.entityType === "submission"
      ? { speakerId: null, submissionId: input.entityId, talkId: null }
      : { speakerId: null, submissionId: null, talkId: input.entityId };
  const outboxId = crypto.randomUUID();
  const outboundHash = await sha256(input.d1Projection);
  const selected = {
    id: sql<string>`${outboxId}`.as("id"),
    eventId: sql<string>`${input.eventId}`.as("event_id"),
    integrationId: sql<string>`${integration.id}`.as("integration_id"),
    pendingEditId: sql<string | null>`null`.as("pending_edit_id"),
    entityType: sql<AirtableEntityType>`${input.entityType}`.as("entity_type"),
    entityId: sql<string>`${input.entityId}`.as("entity_id"),
    speakerId: owner.speakerId === null
      ? sql<string | null>`null`.as("speaker_id")
      : sql<string | null>`${owner.speakerId}`.as("speaker_id"),
    submissionId: owner.submissionId === null
      ? sql<string | null>`null`.as("submission_id")
      : sql<string | null>`${owner.submissionId}`.as("submission_id"),
    talkId: owner.talkId === null
      ? sql<string | null>`null`.as("talk_id")
      : sql<string | null>`${owner.talkId}`.as("talk_id"),
    sessionPartyId: sql<string>`${input.entityId}`.as("session_party_id"),
    operation: sql<"upsert">`'upsert'`.as("operation"),
    changedFields: sql<Record<string, unknown>>`${JSON.stringify(input.changedFields)}`.as("changed_fields"),
    outboundRevision: sql<number>`${outboundRevision}`.as("outbound_revision"),
    outboundHash: sql<string>`${outboundHash}`.as("outbound_hash"),
    origin: sql<string>`${input.origin}`.as("origin"),
    idempotencyKey: sql<string>`${input.idempotencyKey}`.as("idempotency_key"),
    status: sql<"pending">`'pending'`.as("status"),
    availableAt: sql<Date>`${input.now.getTime()}`.as("available_at"),
    leaseOwner: sql<string | null>`null`.as("lease_owner"),
    leaseExpiresAt: sql<Date | null>`null`.as("lease_expires_at"),
    attemptCount: sql<number>`0`.as("attempt_count"),
    lastError: sql<string | null>`null`.as("last_error"),
    completedAt: sql<Date | null>`null`.as("completed_at"),
    deadLetteredAt: sql<Date | null>`null`.as("dead_lettered_at"),
    createdAt: sql<Date>`${input.now.getTime()}`.as("created_at"),
  };
  const source = input.entityType === "speaker"
    ? db.select(selected).from(speakers).where(and(
      eq(speakers.eventId, input.eventId),
      eq(speakers.id, input.entityId),
      eq(speakers.version, input.entityVersion),
    ))
    : input.entityType === "submission"
      ? db.select(selected).from(submissions).where(and(
        eq(submissions.eventId, input.eventId),
        eq(submissions.id, input.entityId),
        eq(submissions.version, input.entityVersion),
      ))
      : db.select(selected).from(talks).where(and(
        eq(talks.eventId, input.eventId),
        eq(talks.id, input.entityId),
        eq(talks.version, input.entityVersion),
      ));
  const statement = db.insert(airtableOutbox).select(source).onConflictDoNothing({
    target: [airtableOutbox.integrationId, airtableOutbox.idempotencyKey],
  });
  return { statement } as PreparedAirtableProjection;
};

export interface AirtableTalkProjectionInput {
  readonly eventId: string;
  readonly talk: {
    readonly id: string;
    readonly submissionId: string | null;
    readonly title: string;
    readonly description: string | null;
    readonly trackId: string | null;
    readonly roomId: string | null;
    readonly startsAt: number | null;
    readonly durationMin: number;
    readonly status: "draft" | "confirmed" | "cancelled";
    readonly version: number;
    readonly speakerIds: readonly string[];
  };
  readonly changedKeys: readonly string[];
  readonly bootstrap?: boolean;
  readonly origin: string;
  readonly idempotencyKey: string;
  readonly now: Date;
}

export const prepareAirtableTalkProjection = async (
  db: AppDatabase,
  input: AirtableTalkProjectionInput,
): Promise<PreparedAirtableProjection | null> => {
  const [integration] = await db
    .select({ id: integrations.id })
    .from(integrations)
    .where(and(eq(integrations.eventId, input.eventId), eq(integrations.kind, "airtable")))
    .limit(1);
  if (!integration) return null;
  const [[track], [room], speakerLinks, [submissionLink]] = await Promise.all([
    input.talk.trackId
      ? db.select({ name: tracks.name }).from(tracks).where(and(
        eq(tracks.eventId, input.eventId),
        eq(tracks.id, input.talk.trackId),
      )).limit(1)
      : Promise.resolve([]),
    input.talk.roomId
      ? db.select({ name: rooms.name }).from(rooms).where(and(
        eq(rooms.eventId, input.eventId),
        eq(rooms.id, input.talk.roomId),
      )).limit(1)
      : Promise.resolve([]),
    input.talk.speakerIds.length > 0
      ? db.select({ entityId: airtableRecordLinks.entityId, recordId: airtableRecordLinks.airtableRecordId })
        .from(airtableRecordLinks)
        .where(and(
          eq(airtableRecordLinks.integrationId, integration.id),
          eq(airtableRecordLinks.entityType, "speaker"),
          inArray(airtableRecordLinks.entityId, [...input.talk.speakerIds]),
        ))
      : Promise.resolve([]),
    input.talk.submissionId
      ? db.select({ recordId: airtableRecordLinks.airtableRecordId }).from(airtableRecordLinks).where(and(
        eq(airtableRecordLinks.integrationId, integration.id),
        eq(airtableRecordLinks.entityType, "submission"),
        eq(airtableRecordLinks.entityId, input.talk.submissionId),
      )).limit(1)
      : Promise.resolve([]),
  ]);
  const speakerRecordById = new Map(speakerLinks.map((link) => [link.entityId, link.recordId]));
  const d1Projection = {
    title: input.talk.title,
    description: input.talk.description,
    track: track?.name ?? null,
    room: room?.name ?? null,
    startsAt: input.talk.startsAt === null ? null : new Date(input.talk.startsAt).toISOString(),
    durationMin: input.talk.durationMin,
    status: input.talk.status,
    speakerLinks: input.talk.speakerIds.flatMap((speakerId) => {
      const recordId = speakerRecordById.get(speakerId);
      return recordId ? [recordId] : [];
    }),
    submissionLink: submissionLink ? [submissionLink.recordId] : [],
  };
  const changedFields = Object.fromEntries(
    input.changedKeys.flatMap((key) => Object.hasOwn(d1Projection, key)
      ? [[key, d1Projection[key as keyof typeof d1Projection]]]
      : []),
  );
  return prepareAirtableProjection(db, {
    eventId: input.eventId,
    entityType: "talk",
    entityId: input.talk.id,
    entityVersion: input.talk.version,
    changedFields: input.bootstrap
      ? d1Projection
      : changedFields,
    d1Projection,
    origin: input.origin,
    idempotencyKey: input.idempotencyKey,
    now: input.now,
  });
};

export interface AirtableSubmissionProjectionInput {
  readonly eventId: string;
  readonly submission: {
    readonly id: string;
    readonly title: string;
    readonly abstract?: unknown;
    readonly category: string | null;
    readonly status: "submitted" | "in_review" | "accepted" | "rejected" | "waitlist" | "withdrawn";
    readonly submittedAt: Date | number;
    readonly version: number;
  };
  readonly changedKeys: readonly string[];
  readonly bootstrap?: boolean;
  readonly origin: string;
  readonly idempotencyKey: string;
  readonly now: Date;
}

export const prepareAirtableSubmissionProjection = async (
  db: AppDatabase,
  input: AirtableSubmissionProjectionInput,
): Promise<PreparedAirtableProjection | null> => {
  const [integration] = await db
    .select({ id: integrations.id })
    .from(integrations)
    .where(and(eq(integrations.eventId, input.eventId), eq(integrations.kind, "airtable")))
    .limit(1);
  if (!integration) return null;
  const linkedSpeakers = await db
    .select({ speakerId: submissionSpeakers.speakerId })
    .from(submissionSpeakers)
    .where(and(
      eq(submissionSpeakers.eventId, input.eventId),
      eq(submissionSpeakers.submissionId, input.submission.id),
    ))
    .orderBy(desc(submissionSpeakers.isPrimary), submissionSpeakers.createdAt);
  const speakerLinks = linkedSpeakers.length > 0
    ? await db
      .select({ entityId: airtableRecordLinks.entityId, recordId: airtableRecordLinks.airtableRecordId })
      .from(airtableRecordLinks)
      .where(and(
        eq(airtableRecordLinks.integrationId, integration.id),
        eq(airtableRecordLinks.entityType, "speaker"),
        inArray(airtableRecordLinks.entityId, linkedSpeakers.map((row) => row.speakerId)),
      ))
    : [];
  const recordBySpeaker = new Map(speakerLinks.map((link) => [link.entityId, link.recordId]));
  const d1Projection = {
    status: input.submission.status,
    submittedAt: new Date(input.submission.submittedAt).toISOString(),
    speakerLinks: linkedSpeakers.flatMap((row) => {
      const recordId = recordBySpeaker.get(row.speakerId);
      return recordId ? [recordId] : [];
    }),
  };
  const changedFields = Object.fromEntries(
    input.changedKeys.flatMap((key) => Object.hasOwn(d1Projection, key)
      ? [[key, d1Projection[key as keyof typeof d1Projection]]]
      : []),
  );
  return prepareAirtableProjection(db, {
    eventId: input.eventId,
    entityType: "submission",
    entityId: input.submission.id,
    entityVersion: input.submission.version,
    changedFields: input.bootstrap
      ? {
          title: input.submission.title,
          abstract: input.submission.abstract ?? "",
          category: input.submission.category,
          ...d1Projection,
        }
      : changedFields,
    d1Projection,
    origin: input.origin,
    idempotencyKey: input.idempotencyKey,
    now: input.now,
  });
};
