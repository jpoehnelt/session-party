import {
  airtableDeadLetters,
  airtableOutbox,
  airtablePendingEdits,
  airtableRecordLinks,
  airtableRefreshState,
  auditLog,
  domainChanges,
  formVersionFields,
  integrations,
  rooms,
  speakers,
  submissionAnswers,
  submissionSpeakers,
  submissions,
  talks,
  talkSpeakers,
  tracks,
} from "contracts/schema";
import * as schema from "contracts/schema";
import type { ServerMessage } from "contracts/protocol";
import type { AirtableConfig, AirtableEntityType } from "contracts/types";
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNull,
  lt,
  lte,
  or,
  sql,
} from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";
import {
  AirtableAdapterError,
  type AirtableAdapterService,
  type AirtableRecord,
} from "../airtable";
import {
  AIRTABLE_ENTITY_TYPES,
  airtableOwnedLogicalFields,
  allMappedFieldIds,
  connectorFields,
  d1OwnedLogicalFields,
  decodeAirtableConfig,
  mapLogicalFieldsToAirtable,
  readLogicalField,
  sha256,
  tableConfigFor,
  valueEquals,
} from "./airtable-mapping";

const MAX_AIRTABLE_BATCH = 10;
const LEASE_MS = 2 * 60_000;
const MAX_ATTEMPTS = 8;
const MIN_REQUEST_INTERVAL_MS = 250;
const RECOVERY_INTERVAL_MS = 60_000;
const BACKGROUND_REFRESH_INTERVAL_MS = 60_000;
const MAX_ERROR_LENGTH = 2_000;

type AppDb = DrizzleD1Database<typeof schema>;

type AirtableIntegration = {
  readonly id: string;
  readonly eventId: string;
  readonly config: AirtableConfig;
};

type EntityProjection = {
  readonly authoritative: Readonly<Record<string, unknown>>;
  readonly d1: Readonly<Record<string, unknown>>;
};

export interface AirtableLaneRuntime {
  readonly database: D1Database;
  readonly adapter: AirtableAdapterService;
  readonly broadcast: (eventId: string, message: ServerMessage) => Promise<void>;
  readonly now?: () => Date;
}

export interface AirtableDrainResult {
  readonly processed: boolean;
  readonly nextAlarmAt: number;
}

class AirtableSyncError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;

  constructor(input: {
    readonly code: string;
    readonly message: string;
    readonly retryable: boolean;
    readonly retryAfterMs?: number;
  }) {
    super(input.message);
    this.name = "AirtableSyncError";
    this.code = input.code;
    this.retryable = input.retryable;
    this.retryAfterMs = input.retryAfterMs;
  }
}

const syncError = (error: unknown): AirtableSyncError => {
  if (error instanceof AirtableSyncError) return error;
  if (error instanceof AirtableAdapterError) {
    return new AirtableSyncError({
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      retryAfterMs: error.retryAfterMs,
    });
  }
  return new AirtableSyncError({
    code: "unexpected_error",
    message: error instanceof Error ? error.message : String(error),
    retryable: true,
  });
};

const retryAt = (now: Date, attempt: number, requested?: number): Date => {
  const exponential = Math.min(15 * 60_000, 2 ** Math.max(0, attempt - 1) * 5_000);
  return new Date(now.getTime() + Math.max(requested ?? 0, exponential));
};

const dateValue = (value: Date | null): string | null => value?.toISOString() ?? null;

const integrationsForBase = async (
  db: AppDb,
  baseId: string,
): Promise<readonly AirtableIntegration[]> => {
  const rows = await db
    .select({ id: integrations.id, eventId: integrations.eventId, config: integrations.config })
    .from(integrations)
    .where(eq(integrations.kind, "airtable"));
  return rows.flatMap((row): AirtableIntegration[] => {
    const config = decodeAirtableConfig(row.config);
    return config?.baseId === baseId ? [{ id: row.id, eventId: row.eventId, config }] : [];
  });
};

const abstractValue = async (
  db: AppDb,
  eventId: string,
  submissionId: string,
): Promise<unknown> => {
  const [answer] = await db
    .select({ value: submissionAnswers.value })
    .from(submissionAnswers)
    .innerJoin(
      formVersionFields,
      and(
        eq(formVersionFields.eventId, submissionAnswers.eventId),
        eq(formVersionFields.formVersionId, submissionAnswers.formVersionId),
        eq(formVersionFields.id, submissionAnswers.formVersionFieldId),
      ),
    )
    .where(and(
      eq(submissionAnswers.eventId, eventId),
      eq(submissionAnswers.submissionId, submissionId),
      eq(formVersionFields.semanticKey, "submissionAbstract"),
    ))
    .limit(1);
  return answer?.value ?? "";
};

const recordIdsForSpeakers = async (
  db: AppDb,
  integration: AirtableIntegration,
  speakerIds: readonly string[],
): Promise<readonly string[]> => {
  if (speakerIds.length === 0) return [];
  const links = await db
    .select({ entityId: airtableRecordLinks.entityId, recordId: airtableRecordLinks.airtableRecordId })
    .from(airtableRecordLinks)
    .where(and(
      eq(airtableRecordLinks.integrationId, integration.id),
      eq(airtableRecordLinks.entityType, "speaker"),
      inArray(airtableRecordLinks.entityId, [...speakerIds]),
    ));
  const byEntity = new Map(links.map((link) => [link.entityId, link.recordId]));
  return speakerIds.flatMap((speakerId) => {
    const recordId = byEntity.get(speakerId);
    return recordId ? [recordId] : [];
  });
};

const entityProjection = async (
  db: AppDb,
  integration: AirtableIntegration,
  entityType: AirtableEntityType,
  entityId: string,
): Promise<EntityProjection | null> => {
  if (entityType === "speaker") {
    const [speaker] = await db
      .select()
      .from(speakers)
      .where(and(eq(speakers.eventId, integration.eventId), eq(speakers.id, entityId)))
      .limit(1);
    return speaker
      ? {
          authoritative: {
            displayName: speaker.displayName,
            title: speaker.title,
            company: speaker.company,
            bio: speaker.bio,
          },
          d1: { visible: speaker.visible },
        }
      : null;
  }
  if (entityType === "submission") {
    const [submission, speakerRows] = await Promise.all([
      db
        .select()
        .from(submissions)
        .where(and(eq(submissions.eventId, integration.eventId), eq(submissions.id, entityId)))
        .limit(1)
        .then((rows) => rows[0]),
      db
        .select({ speakerId: submissionSpeakers.speakerId })
        .from(submissionSpeakers)
        .where(and(
          eq(submissionSpeakers.eventId, integration.eventId),
          eq(submissionSpeakers.submissionId, entityId),
        ))
        .orderBy(desc(submissionSpeakers.isPrimary), asc(submissionSpeakers.createdAt)),
    ]);
    if (!submission) return null;
    const speakerLinks = await recordIdsForSpeakers(
      db,
      integration,
      speakerRows.map((row) => row.speakerId),
    );
    return {
      authoritative: {
        title: submission.title,
        abstract: await abstractValue(db, integration.eventId, entityId),
        category: submission.category,
      },
      d1: {
        status: submission.status,
        submittedAt: submission.submittedAt.toISOString(),
        speakerLinks,
      },
    };
  }
  const [talk] = await db
    .select({ talk: talks, trackName: tracks.name, roomName: rooms.name })
    .from(talks)
    .leftJoin(tracks, and(eq(tracks.eventId, talks.eventId), eq(tracks.id, talks.trackId)))
    .leftJoin(rooms, and(eq(rooms.eventId, talks.eventId), eq(rooms.id, talks.roomId)))
    .where(and(eq(talks.eventId, integration.eventId), eq(talks.id, entityId)))
    .limit(1);
  if (!talk) return null;
  const speakerRows = await db
    .select({ speakerId: talkSpeakers.speakerId })
    .from(talkSpeakers)
    .where(and(eq(talkSpeakers.eventId, integration.eventId), eq(talkSpeakers.talkId, entityId)))
    .orderBy(asc(talkSpeakers.createdAt));
  const speakerLinks = await recordIdsForSpeakers(
    db,
    integration,
    speakerRows.map((row) => row.speakerId),
  );
  const [submissionLink] = talk.talk.submissionId
    ? await db
      .select({ recordId: airtableRecordLinks.airtableRecordId })
      .from(airtableRecordLinks)
      .where(and(
        eq(airtableRecordLinks.integrationId, integration.id),
        eq(airtableRecordLinks.entityType, "submission"),
        eq(airtableRecordLinks.entityId, talk.talk.submissionId),
      ))
      .limit(1)
    : [];
  return {
    authoritative: { title: talk.talk.title, description: talk.talk.description },
    d1: {
      track: talk.trackName,
      room: talk.roomName,
      startsAt: dateValue(talk.talk.startsAt),
      durationMin: talk.talk.durationMin,
      status: talk.talk.status,
      speakerLinks,
      submissionLink: submissionLink ? [submissionLink.recordId] : [],
    },
  };
};

const entityIds = async (
  db: AppDb,
  eventId: string,
  entityType: AirtableEntityType,
): Promise<readonly string[]> => {
  if (entityType === "speaker") {
    return (await db.select({ id: speakers.id }).from(speakers).where(eq(speakers.eventId, eventId)).orderBy(asc(speakers.id)))
      .map((row) => row.id);
  }
  if (entityType === "submission") {
    return (await db.select({ id: submissions.id }).from(submissions).where(eq(submissions.eventId, eventId)).orderBy(asc(submissions.id)))
      .map((row) => row.id);
  }
  return (await db.select({ id: talks.id }).from(talks).where(eq(talks.eventId, eventId)).orderBy(asc(talks.id)))
    .map((row) => row.id);
};

/** Recovery projection: transactional feature producers remain the fast path. */
const enqueueOneMissingProjection = async (
  db: AppDb,
  integration: AirtableIntegration,
  now: Date,
): Promise<boolean> => {
  for (const entityType of AIRTABLE_ENTITY_TYPES) {
    for (const entityId of await entityIds(db, integration.eventId, entityType)) {
      const projection = await entityProjection(db, integration, entityType, entityId);
      if (!projection) continue;
      const desiredHash = await sha256(projection.d1);
      const [[link], [latest], pending] = await Promise.all([
        db
          .select({ outboundRevision: airtableRecordLinks.outboundRevision, outboundHash: airtableRecordLinks.outboundHash })
          .from(airtableRecordLinks)
          .where(and(
            eq(airtableRecordLinks.integrationId, integration.id),
            eq(airtableRecordLinks.entityType, entityType),
            eq(airtableRecordLinks.entityId, entityId),
          ))
          .limit(1),
        db
          .select({
            outboundRevision: airtableOutbox.outboundRevision,
            outboundHash: airtableOutbox.outboundHash,
            status: airtableOutbox.status,
          })
          .from(airtableOutbox)
          .where(and(
            eq(airtableOutbox.integrationId, integration.id),
            eq(airtableOutbox.entityType, entityType),
            eq(airtableOutbox.entityId, entityId),
          ))
          .orderBy(desc(airtableOutbox.outboundRevision))
          .limit(1),
        db
          .select({ fieldKey: airtablePendingEdits.fieldKey, intendedValue: airtablePendingEdits.intendedValue })
          .from(airtablePendingEdits)
          .where(and(
            eq(airtablePendingEdits.integrationId, integration.id),
            eq(airtablePendingEdits.entityType, entityType),
            eq(airtablePendingEdits.entityId, entityId),
            eq(airtablePendingEdits.status, "pending"),
          )),
      ]);
      if (link?.outboundHash === desiredHash) continue;
      if (latest?.outboundHash === desiredHash && latest.status !== "dead_letter" && latest.status !== "blocked") continue;
      if (latest?.status === "dead_letter" || latest?.status === "blocked") continue;

      const pendingValues = Object.fromEntries(pending.map((row) => [row.fieldKey, row.intendedValue]));
      const changedFields = link
        ? projection.d1
        : { ...projection.authoritative, ...pendingValues, ...projection.d1 };
      const outboundRevision = Math.max(link?.outboundRevision ?? 0, latest?.outboundRevision ?? 0) + 1;
      const ownerColumns = entityType === "speaker"
        ? { speakerId: entityId, submissionId: null, talkId: null }
        : entityType === "submission"
          ? { speakerId: null, submissionId: entityId, talkId: null }
          : { speakerId: null, submissionId: null, talkId: entityId };
      await db.insert(airtableOutbox).values({
        id: crypto.randomUUID(),
        eventId: integration.eventId,
        integrationId: integration.id,
        pendingEditId: null,
        entityType,
        entityId,
        ...ownerColumns,
        sessionPartyId: entityId,
        operation: "upsert",
        changedFields,
        outboundRevision,
        outboundHash: desiredHash,
        origin: integration.config.origin,
        idempotencyKey: `recovery:${entityType}:${entityId}:${desiredHash}`,
        status: "pending",
        availableAt: now,
        attemptCount: 0,
        createdAt: now,
      }).onConflictDoNothing({
        target: [airtableOutbox.integrationId, airtableOutbox.idempotencyKey],
      });
      return true;
    }
  }
  return false;
};

const requiredString = (value: unknown, field: string): string => {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new AirtableSyncError({
      code: "invalid_airtable_value",
      message: `Airtable field ${field} must be a non-empty string`,
      retryable: false,
    });
  }
  return value;
};

const optionalString = (value: unknown, field: string): string | null => {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") {
    throw new AirtableSyncError({
      code: "invalid_airtable_value",
      message: `Airtable field ${field} must be text`,
      retryable: false,
    });
  }
  return value;
};

const normalizeAuthoritative = (
  config: AirtableConfig,
  entityType: AirtableEntityType,
  fields: Readonly<Record<string, unknown>>,
  scope: readonly string[],
): Readonly<Record<string, unknown>> => {
  const values: Record<string, unknown> = {};
  for (const field of scope) {
    const value = readLogicalField(config, entityType, field, fields);
    if (field === "displayName" || (field === "title" && entityType !== "speaker")) {
      values[field] = requiredString(value, field);
    } else if (field === "abstract") {
      if (value === undefined || value === null || value === "") values[field] = "";
      else values[field] = requiredString(value, field);
    }
    else values[field] = optionalString(value, field);
  }
  return values;
};

const ownerColumns = (entityType: AirtableEntityType, entityId: string) => entityType === "speaker"
  ? { speakerId: entityId, submissionId: null, talkId: null }
  : entityType === "submission"
    ? { speakerId: null, submissionId: entityId, talkId: null }
    : { speakerId: null, submissionId: null, talkId: entityId };

const applyInboundRecord = async (
  db: AppDb,
  integration: AirtableIntegration,
  entityType: AirtableEntityType,
  entityId: string,
  record: AirtableRecord,
  input: {
    readonly now: Date;
    readonly authoritativeScope?: readonly string[];
    readonly outboundRevision?: number;
    readonly outboundHash?: string;
  },
): Promise<{ readonly state: "confirmed" | "refreshed" | "conflict"; readonly fields: readonly string[] }> => {
  const scope = input.authoritativeScope ?? airtableOwnedLogicalFields(entityType);
  const incoming = normalizeAuthoritative(integration.config, entityType, record.fields, scope);
  const [existingLink, pending, projection] = await Promise.all([
    db
      .select()
      .from(airtableRecordLinks)
      .where(and(
        eq(airtableRecordLinks.integrationId, integration.id),
        eq(airtableRecordLinks.entityType, entityType),
        eq(airtableRecordLinks.entityId, entityId),
      ))
      .limit(1)
      .then((rows) => rows[0]),
    db
      .select()
      .from(airtablePendingEdits)
      .where(and(
        eq(airtablePendingEdits.integrationId, integration.id),
        eq(airtablePendingEdits.entityType, entityType),
        eq(airtablePendingEdits.entityId, entityId),
        eq(airtablePendingEdits.status, "pending"),
      )),
    entityProjection(db, integration, entityType, entityId),
  ]);
  if (!projection) {
    throw new AirtableSyncError({
      code: "unknown_session_party_id",
      message: `Airtable record ${record.id} references missing ${entityType} ${entityId}`,
      retryable: false,
    });
  }
  const pendingByField = new Map(pending.map((row) => [row.fieldKey, row]));
  const changed = Object.entries(incoming).filter(
    ([field, value]) => !valueEquals(projection.authoritative[field], value),
  );
  const conflicted = Object.entries(incoming).filter(([field, value]) => {
    const edit = pendingByField.get(field);
    return edit ? !valueEquals(edit.intendedValue, value) : false;
  });
  const confirmed = Object.entries(incoming).filter(([field, value]) => {
    const edit = pendingByField.get(field);
    return edit ? valueEquals(edit.intendedValue, value) : false;
  });
  const inboundHash = await sha256({
    ...projection.authoritative,
    ...incoming,
  });
  const statements: BatchItem<"sqlite">[] = [];
  const linkId = existingLink?.id ?? crypto.randomUUID();
  statements.push(
    db.insert(airtableRecordLinks).values({
      id: linkId,
      eventId: integration.eventId,
      integrationId: integration.id,
      entityType,
      entityId,
      ...ownerColumns(entityType, entityId),
      sessionPartyId: entityId,
      airtableRecordId: record.id,
      outboundRevision: input.outboundRevision ?? existingLink?.outboundRevision ?? 0,
      outboundHash: input.outboundHash ?? existingLink?.outboundHash ?? null,
      inboundRevision: inboundHash,
      inboundHash,
      origin: integration.config.origin,
      lastRefreshedAt: input.now,
      version: (existingLink?.version ?? 0) + 1,
      createdAt: existingLink?.createdAt ?? input.now,
      updatedAt: input.now,
    }).onConflictDoUpdate({
      target: [
        airtableRecordLinks.eventId,
        airtableRecordLinks.integrationId,
        airtableRecordLinks.entityType,
        airtableRecordLinks.entityId,
      ],
      set: {
        airtableRecordId: record.id,
        outboundRevision: input.outboundRevision ?? existingLink?.outboundRevision ?? 0,
        outboundHash: input.outboundHash ?? existingLink?.outboundHash ?? null,
        inboundRevision: inboundHash,
        inboundHash,
        origin: integration.config.origin,
        lastRefreshedAt: input.now,
        version: (existingLink?.version ?? 0) + 1,
        updatedAt: input.now,
      },
    }),
  );
  for (const [field, value] of [...confirmed, ...conflicted]) {
    const edit = pendingByField.get(field);
    if (!edit) continue;
    const conflict = !valueEquals(edit.intendedValue, value);
    statements.push(
      db.update(airtablePendingEdits).set({
        status: conflict ? "conflict" : "confirmed",
        resolvedAt: input.now,
        conflictValue: conflict ? value : null,
        version: edit.version + 1,
        updatedAt: input.now,
      }).where(and(
        eq(airtablePendingEdits.id, edit.id),
        eq(airtablePendingEdits.status, "pending"),
        eq(airtablePendingEdits.version, edit.version),
      )),
    );
  }

  let nextVersion: number | null = null;
  let before: unknown = null;
  if (changed.length > 0) {
    if (entityType === "speaker") {
      const [row] = await db.select().from(speakers).where(and(
        eq(speakers.eventId, integration.eventId),
        eq(speakers.id, entityId),
      )).limit(1);
      if (!row) throw new AirtableSyncError({ code: "unknown_session_party_id", message: `Missing speaker ${entityId}`, retryable: false });
      nextVersion = row.version + 1;
      before = row;
      statements.push(db.update(speakers).set({
        ...(Object.hasOwn(incoming, "displayName") ? { displayName: incoming.displayName as string } : {}),
        ...(Object.hasOwn(incoming, "title") ? { title: incoming.title as string | null } : {}),
        ...(Object.hasOwn(incoming, "company") ? { company: incoming.company as string | null } : {}),
        ...(Object.hasOwn(incoming, "bio") ? { bio: incoming.bio as string | null } : {}),
        version: nextVersion,
        updatedAt: input.now,
      }).where(and(eq(speakers.id, entityId), eq(speakers.version, row.version))));
    } else if (entityType === "submission") {
      const [row] = await db.select().from(submissions).where(and(
        eq(submissions.eventId, integration.eventId),
        eq(submissions.id, entityId),
      )).limit(1);
      if (!row) throw new AirtableSyncError({ code: "unknown_session_party_id", message: `Missing submission ${entityId}`, retryable: false });
      nextVersion = row.version + 1;
      before = row;
      statements.push(db.update(submissions).set({
        ...(Object.hasOwn(incoming, "title") ? { title: incoming.title as string } : {}),
        ...(Object.hasOwn(incoming, "category") ? { category: incoming.category as string | null } : {}),
        version: nextVersion,
        updatedAt: input.now,
      }).where(and(eq(submissions.id, entityId), eq(submissions.version, row.version))));
      if (Object.hasOwn(incoming, "abstract")) {
        const [answer] = await db
          .select({ answer: submissionAnswers, field: formVersionFields })
          .from(submissionAnswers)
          .innerJoin(formVersionFields, and(
            eq(formVersionFields.eventId, submissionAnswers.eventId),
            eq(formVersionFields.formVersionId, submissionAnswers.formVersionId),
            eq(formVersionFields.id, submissionAnswers.formVersionFieldId),
          ))
          .where(and(
            eq(submissionAnswers.eventId, integration.eventId),
            eq(submissionAnswers.submissionId, entityId),
            eq(formVersionFields.semanticKey, "submissionAbstract"),
          ))
          .limit(1);
        if (!answer) {
          throw new AirtableSyncError({
            code: "abstract_mapping_missing",
            message: `Submission ${entityId} has no selected abstract answer`,
            retryable: false,
          });
        }
        statements.push(db.update(submissionAnswers).set({
          value: incoming.abstract,
          version: answer.answer.version + 1,
          updatedAt: input.now,
        }).where(and(
          eq(submissionAnswers.id, answer.answer.id),
          eq(submissionAnswers.version, answer.answer.version),
        )));
      }
    } else {
      const [row] = await db.select().from(talks).where(and(
        eq(talks.eventId, integration.eventId),
        eq(talks.id, entityId),
      )).limit(1);
      if (!row) throw new AirtableSyncError({ code: "unknown_session_party_id", message: `Missing talk ${entityId}`, retryable: false });
      nextVersion = row.version + 1;
      before = row;
      statements.push(db.update(talks).set({
        ...(Object.hasOwn(incoming, "title") ? { title: incoming.title as string } : {}),
        ...(Object.hasOwn(incoming, "description") ? { description: incoming.description as string | null } : {}),
        version: nextVersion,
        updatedAt: input.now,
      }).where(and(eq(talks.id, entityId), eq(talks.version, row.version))));
    }
    const requestId = crypto.randomUUID();
    const after = { ...(before as Record<string, unknown>), ...incoming, version: nextVersion, updatedAt: input.now };
    statements.push(
      db.insert(domainChanges).values({
        id: crypto.randomUUID(),
        eventId: integration.eventId,
        aggregateType: entityType,
        aggregateId: entityId,
        aggregateVersion: nextVersion,
        eventType: "integrations.airtable.refreshed",
        audiences: ["members"],
        payload: { entityType, entityId, fields: changed.map(([field]) => field) },
        actorUserId: null,
        actorApiKeyId: null,
        requestId,
        idempotencyRecordId: null,
        occurredAt: input.now,
      }),
      db.insert(auditLog).values({
        id: crypto.randomUUID(),
        eventId: integration.eventId,
        requestId,
        actorUserId: null,
        actorApiKeyId: null,
        action: "integrations.airtable.refreshed",
        resourceType: entityType,
        resourceId: entityId,
        before,
        after,
        metadata: { integrationId: integration.id, airtableRecordId: record.id },
        occurredAt: input.now,
      }),
    );
  }
  await db.batch(statements as [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]]);
  return {
    state: conflicted.length > 0 ? "conflict" : confirmed.length > 0 ? "confirmed" : "refreshed",
    fields: Object.keys(incoming),
  };
};

const deadLetterStatement = (
  db: AppDb,
  input: {
    readonly integration: AirtableIntegration;
    readonly sourceType: "outbox" | "refresh";
    readonly sourceId: string;
    readonly error: AirtableSyncError;
    readonly evidence: Readonly<Record<string, unknown>>;
    readonly now: Date;
  },
) => db.insert(airtableDeadLetters).values({
    id: crypto.randomUUID(),
    eventId: input.integration.eventId,
    integrationId: input.integration.id,
    sourceType: input.sourceType,
    sourceId: input.sourceId,
    errorCode: input.error.code,
    errorMessage: input.error.message.slice(0, MAX_ERROR_LENGTH),
    evidence: input.evidence,
    createdAt: input.now,
  }).onConflictDoUpdate({
    target: [
      airtableDeadLetters.integrationId,
      airtableDeadLetters.sourceType,
      airtableDeadLetters.sourceId,
    ],
    set: {
      errorCode: input.error.code,
      errorMessage: input.error.message.slice(0, MAX_ERROR_LENGTH),
      evidence: input.evidence,
    },
  });

const deadLetter = async (
  db: AppDb,
  input: Parameters<typeof deadLetterStatement>[1],
): Promise<void> => {
  await deadLetterStatement(db, input);
};

const failOutbound = async (
  db: AppDb,
  integration: AirtableIntegration,
  rows: readonly (typeof airtableOutbox.$inferSelect)[],
  error: unknown,
  now: Date,
  broadcast: AirtableLaneRuntime["broadcast"],
): Promise<void> => {
  const failure = syncError(error);
  await db.update(integrations).set({
    lastError: failure.message.slice(0, MAX_ERROR_LENGTH),
    updatedAt: now,
  }).where(eq(integrations.id, integration.id));
  for (const row of rows) {
    const terminal = !failure.retryable || row.attemptCount >= MAX_ATTEMPTS;
    if (terminal) {
      await db.batch([
        db.update(airtableOutbox).set({
          status: "dead_letter",
          availableAt: now,
          leaseOwner: null,
          leaseExpiresAt: null,
          lastError: failure.message.slice(0, MAX_ERROR_LENGTH),
          deadLetteredAt: now,
        }).where(and(eq(airtableOutbox.id, row.id), eq(airtableOutbox.status, "claimed"))),
        deadLetterStatement(db, {
          integration,
          sourceType: "outbox",
          sourceId: row.id,
          error: failure,
          evidence: { entityType: row.entityType, entityId: row.entityId, attemptCount: row.attemptCount },
          now,
        }),
        db.update(airtableOutbox).set({
          status: "blocked",
          lastError: `Blocked by failed revision ${row.outboundRevision}`,
        }).where(and(
          eq(airtableOutbox.integrationId, row.integrationId),
          eq(airtableOutbox.entityType, row.entityType),
          eq(airtableOutbox.entityId, row.entityId),
          sql`${airtableOutbox.outboundRevision} > ${row.outboundRevision}`,
          inArray(airtableOutbox.status, ["pending", "retry"]),
        )),
      ]);
      await integrationBroadcast(broadcast, integration, {
        t: "integrations/airtable_sync",
        entityType: row.entityType,
        entityId: row.entityId,
        state: "dead_letter",
        fields: Object.keys(row.changedFields),
      });
    } else {
      await db.update(airtableOutbox).set({
        status: "retry",
        availableAt: retryAt(now, row.attemptCount, failure.retryAfterMs),
        leaseOwner: null,
        leaseExpiresAt: null,
        lastError: failure.message.slice(0, MAX_ERROR_LENGTH),
        deadLetteredAt: null,
      }).where(and(eq(airtableOutbox.id, row.id), eq(airtableOutbox.status, "claimed")));
    }
  }
};

const integrationBroadcast = async (
  broadcast: AirtableLaneRuntime["broadcast"],
  integration: AirtableIntegration,
  message: ServerMessage,
): Promise<void> => {
  try {
    await broadcast(integration.eventId, message);
  } catch (error) {
    console.warn(JSON.stringify({
      message: "Airtable state committed but EventRoom broadcast failed",
      eventId: integration.eventId,
      error: error instanceof Error ? error.message : String(error),
    }));
  }
};

const claimOutbound = async (
  db: AppDb,
  integrationId: string,
  now: Date,
): Promise<readonly (typeof airtableOutbox.$inferSelect)[]> => {
  const candidates = await db.select().from(airtableOutbox).where(and(
    eq(airtableOutbox.integrationId, integrationId),
    or(
      and(
        inArray(airtableOutbox.status, ["pending", "retry"]),
        lte(airtableOutbox.availableAt, now),
        or(isNull(airtableOutbox.leaseExpiresAt), lte(airtableOutbox.leaseExpiresAt, now)),
      ),
      and(eq(airtableOutbox.status, "claimed"), lte(airtableOutbox.leaseExpiresAt, now)),
    ),
  )).orderBy(asc(airtableOutbox.createdAt), asc(airtableOutbox.outboundRevision)).limit(50);
  const firstByEntity = new Map<string, typeof airtableOutbox.$inferSelect>();
  for (const row of candidates) {
    const [earlier] = await db.select({ id: airtableOutbox.id }).from(airtableOutbox).where(and(
      eq(airtableOutbox.integrationId, row.integrationId),
      eq(airtableOutbox.entityType, row.entityType),
      eq(airtableOutbox.entityId, row.entityId),
      lt(airtableOutbox.outboundRevision, row.outboundRevision),
      inArray(airtableOutbox.status, ["pending", "retry", "claimed"]),
    )).limit(1);
    if (earlier) continue;
    const key = `${row.entityType}:${row.entityId}`;
    if (!firstByEntity.has(key)) firstByEntity.set(key, row);
  }
  const first = firstByEntity.values().next().value as typeof airtableOutbox.$inferSelect | undefined;
  if (!first) return [];
  const selected = [...firstByEntity.values()]
    .filter((row) => row.entityType === first.entityType && row.operation === first.operation)
    .slice(0, MAX_AIRTABLE_BATCH);
  const claimed: (typeof airtableOutbox.$inferSelect)[] = [];
  for (const row of selected) {
    const leaseOwner = crypto.randomUUID();
    const [updated] = await db.update(airtableOutbox).set({
      status: "claimed",
      leaseOwner,
      leaseExpiresAt: new Date(now.getTime() + LEASE_MS),
      attemptCount: row.attemptCount + 1,
    }).where(and(
      eq(airtableOutbox.id, row.id),
      row.status === "claimed"
        ? and(eq(airtableOutbox.status, "claimed"), lte(airtableOutbox.leaseExpiresAt, now))
        : and(inArray(airtableOutbox.status, ["pending", "retry"]), lte(airtableOutbox.availableAt, now)),
    )).returning();
    if (updated) claimed.push(updated);
  }
  return claimed;
};

const processOutbound = async (
  db: AppDb,
  integration: AirtableIntegration,
  adapter: AirtableAdapterService,
  now: Date,
  broadcast: AirtableLaneRuntime["broadcast"],
): Promise<boolean> => {
  const claimed = await claimOutbound(db, integration.id, now);
  if (claimed.length === 0) return false;
  try {
    const entityType = claimed[0]!.entityType;
    const table = tableConfigFor(integration.config, entityType);
    if (claimed[0]!.operation === "delete") {
      const links = await db.select().from(airtableRecordLinks).where(and(
        eq(airtableRecordLinks.integrationId, integration.id),
        eq(airtableRecordLinks.entityType, entityType),
        inArray(airtableRecordLinks.entityId, claimed.map((row) => row.entityId)),
      ));
      await adapter.deleteBatch({
        baseId: integration.config.baseId,
        tableId: table.tableId,
        recordIds: links.map((link) => link.airtableRecordId),
      });
      await db.batch(claimed.map((row) => db.update(airtableOutbox).set({
        status: "succeeded",
        completedAt: now,
        leaseOwner: null,
        leaseExpiresAt: null,
        lastError: null,
      }).where(and(eq(airtableOutbox.id, row.id), eq(airtableOutbox.status, "claimed")))) as unknown as [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]]);
      return true;
    }
    const records = claimed.map((row) => {
      const mapped = mapLogicalFieldsToAirtable(integration.config, entityType, row.changedFields);
      const unmapped = Object.keys(row.changedFields).filter(
        (field) => !airtableOwnedLogicalFields(entityType).includes(field) && !d1OwnedLogicalFields(entityType).includes(field),
      );
      if (unmapped.length > 0) {
        throw new AirtableSyncError({
          code: "unmapped_field",
          message: `Unmapped ${entityType} fields: ${unmapped.join(", ")}`,
          retryable: false,
        });
      }
      return {
        sessionPartyId: row.sessionPartyId,
        fields: {
          ...mapped,
          ...connectorFields(integration.config, entityType, {
            sessionPartyId: row.sessionPartyId,
            revision: row.outboundRevision,
            hash: row.outboundHash,
            origin: integration.config.origin,
          }),
        },
      };
    });
    const written = await adapter.upsertBatch({
      baseId: integration.config.baseId,
      tableId: table.tableId,
      mergeFieldId: table.fields.sessionPartyId,
      records,
    });
    const bySessionPartyId = new Map(written.flatMap((record) => {
      const value = record.fields[table.fields.sessionPartyId];
      return typeof value === "string" ? [[value, record] as const] : [];
    }));
    for (const row of claimed) {
      const record = bySessionPartyId.get(row.sessionPartyId);
      if (!record) {
        throw new AirtableSyncError({
          code: "missing_upsert_result",
          message: `Airtable did not confirm ${row.entityType} ${row.entityId}`,
          retryable: true,
        });
      }
      const authoritativeScope = Object.keys(row.changedFields).filter((field) =>
        airtableOwnedLogicalFields(row.entityType).includes(field)
      );
      const updatesD1Projection = Object.keys(row.changedFields).some((field) =>
        d1OwnedLogicalFields(row.entityType).includes(field)
      );
      const applied = await applyInboundRecord(db, integration, row.entityType, row.entityId, record, {
        now,
        authoritativeScope,
        outboundRevision: row.outboundRevision,
        outboundHash: updatesD1Projection ? row.outboundHash : undefined,
      });
      await db.update(airtableOutbox).set({
        status: "succeeded",
        completedAt: now,
        leaseOwner: null,
        leaseExpiresAt: null,
        lastError: null,
      }).where(and(
        eq(airtableOutbox.id, row.id),
        eq(airtableOutbox.status, "claimed"),
      ));
      await integrationBroadcast(broadcast, integration, {
        t: "integrations/airtable_sync",
        entityType: row.entityType,
        entityId: row.entityId,
        state: applied.state,
        fields: Object.keys(row.changedFields),
      });
    }
    await db.update(integrations).set({
      lastSyncAt: now,
      lastError: null,
      updatedAt: now,
    }).where(eq(integrations.id, integration.id));
  } catch (error) {
    await failOutbound(db, integration, claimed, error, now, broadcast);
  }
  return true;
};

const normalizeD1Field = (field: string, value: unknown): unknown => {
  if (field === "visible") return value === true;
  if (field === "speakerLinks" || field === "submissionLink") {
    return Array.isArray(value)
      ? value.filter((item): item is string => typeof item === "string").sort()
      : [];
  }
  if (field === "durationMin") return typeof value === "number" ? value : null;
  if (field === "startsAt" || field === "submittedAt") {
    if (typeof value !== "string") return value === undefined ? null : value;
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : value;
  }
  return value === undefined ? null : value;
};

const recordOwnershipViolations = async (
  db: AppDb,
  integration: AirtableIntegration,
  refreshId: string,
  entityType: AirtableEntityType,
  entityId: string,
  record: AirtableRecord,
  projection: EntityProjection,
  now: Date,
): Promise<void> => {
  for (const field of d1OwnedLogicalFields(entityType)) {
    const actual = normalizeD1Field(field, readLogicalField(integration.config, entityType, field, record.fields));
    const expected = normalizeD1Field(field, projection.d1[field]);
    if (valueEquals(actual, expected)) continue;
    await deadLetter(db, {
      integration,
      sourceType: "refresh",
      sourceId: `${refreshId}:${record.id}:${field}`,
      error: new AirtableSyncError({
        code: "d1_authority_violation",
        message: `Airtable attempted to author D1-owned ${entityType}.${field}`,
        retryable: false,
      }),
      evidence: { entityType, entityId, airtableRecordId: record.id, field, expected, actual },
      now,
    });
  }
};

const failRefresh = async (
  db: AppDb,
  integration: AirtableIntegration,
  refresh: typeof airtableRefreshState.$inferSelect,
  error: unknown,
  now: Date,
): Promise<void> => {
  const failure = syncError(error);
  await db.update(integrations).set({
    lastError: failure.message.slice(0, MAX_ERROR_LENGTH),
    updatedAt: now,
  }).where(eq(integrations.id, integration.id));
  const terminal = !failure.retryable || refresh.attemptCount >= MAX_ATTEMPTS;
  await db.update(airtableRefreshState).set({
    status: terminal ? "dead_letter" : "retry",
    dueAt: terminal ? now : retryAt(now, refresh.attemptCount, failure.retryAfterMs),
    leaseOwner: null,
    leaseExpiresAt: null,
    lastError: failure.message.slice(0, MAX_ERROR_LENGTH),
    deadLetteredAt: terminal ? now : null,
    version: refresh.version + 1,
    updatedAt: now,
  }).where(and(
    eq(airtableRefreshState.id, refresh.id),
    eq(airtableRefreshState.status, "claimed"),
  ));
  if (terminal) {
    await deadLetter(db, {
      integration,
      sourceType: "refresh",
      sourceId: refresh.id,
      error: failure,
      evidence: { entityType: refresh.entityType, attemptCount: refresh.attemptCount },
      now,
    });
  }
};

const processRefresh = async (
  db: AppDb,
  integration: AirtableIntegration,
  adapter: AirtableAdapterService,
  now: Date,
  broadcast: AirtableLaneRuntime["broadcast"],
): Promise<boolean> => {
  const [candidate] = await db.select().from(airtableRefreshState).where(and(
    eq(airtableRefreshState.integrationId, integration.id),
    or(
      and(
        inArray(airtableRefreshState.status, ["requested", "retry"]),
        or(isNull(airtableRefreshState.dueAt), lte(airtableRefreshState.dueAt, now)),
      ),
      and(eq(airtableRefreshState.status, "claimed"), lte(airtableRefreshState.leaseExpiresAt, now)),
    ),
  )).orderBy(asc(airtableRefreshState.requestedAt), asc(airtableRefreshState.entityType)).limit(1);
  if (!candidate) return false;
  const leaseOwner = crypto.randomUUID();
  const [claimed] = await db.update(airtableRefreshState).set({
    status: "claimed",
    leaseOwner,
    leaseExpiresAt: new Date(now.getTime() + LEASE_MS),
    attemptCount: candidate.attemptCount + 1,
    version: candidate.version + 1,
    updatedAt: now,
  }).where(and(
    eq(airtableRefreshState.id, candidate.id),
    eq(airtableRefreshState.version, candidate.version),
  )).returning();
  if (!claimed) return false;
  try {
    const table = tableConfigFor(integration.config, claimed.entityType);
    const page = await adapter.listPage({
      baseId: integration.config.baseId,
      tableId: table.tableId,
      fieldIds: allMappedFieldIds(integration.config, claimed.entityType),
      cursor: claimed.cursor ?? undefined,
    });
    const seen = new Set<string>();
    for (const record of page.records) {
      const sessionPartyId = record.fields[table.fields.sessionPartyId];
      if (typeof sessionPartyId !== "string" || sessionPartyId.length === 0) {
        await deadLetter(db, {
          integration,
          sourceType: "refresh",
          sourceId: `${claimed.id}:${record.id}:SessionPartyId`,
          error: new AirtableSyncError({
            code: "missing_session_party_id",
            message: `Airtable record ${record.id} has no SessionPartyId`,
            retryable: false,
          }),
          evidence: { entityType: claimed.entityType, airtableRecordId: record.id },
          now,
        });
        continue;
      }
      if (seen.has(sessionPartyId)) {
        await deadLetter(db, {
          integration,
          sourceType: "refresh",
          sourceId: `${claimed.id}:${record.id}:duplicate`,
          error: new AirtableSyncError({
            code: "duplicate_session_party_id",
            message: `Multiple Airtable records use SessionPartyId ${sessionPartyId}`,
            retryable: false,
          }),
          evidence: { entityType: claimed.entityType, entityId: sessionPartyId, airtableRecordId: record.id },
          now,
        });
        continue;
      }
      seen.add(sessionPartyId);
      try {
        const [existingRecordLink] = await db.select({
          airtableRecordId: airtableRecordLinks.airtableRecordId,
        }).from(airtableRecordLinks).where(and(
          eq(airtableRecordLinks.integrationId, integration.id),
          eq(airtableRecordLinks.entityType, claimed.entityType),
          eq(airtableRecordLinks.entityId, sessionPartyId),
        )).limit(1);
        if (existingRecordLink && existingRecordLink.airtableRecordId !== record.id) {
          throw new AirtableSyncError({
            code: "duplicate_session_party_id",
            message: `Multiple Airtable records use SessionPartyId ${sessionPartyId}`,
            retryable: false,
          });
        }
        const projection = await entityProjection(db, integration, claimed.entityType, sessionPartyId);
        if (!projection) {
          throw new AirtableSyncError({
            code: "unknown_session_party_id",
            message: `Airtable record ${record.id} references missing ${claimed.entityType} ${sessionPartyId}`,
            retryable: false,
          });
        }
        await recordOwnershipViolations(
          db,
          integration,
          claimed.id,
          claimed.entityType,
          sessionPartyId,
          record,
          projection,
          now,
        );
        const applied = await applyInboundRecord(
          db,
          integration,
          claimed.entityType,
          sessionPartyId,
          record,
          { now },
        );
        await integrationBroadcast(broadcast, integration, {
          t: "integrations/airtable_sync",
          entityType: claimed.entityType,
          entityId: sessionPartyId,
          state: applied.state,
          fields: [...applied.fields],
        });
      } catch (error) {
        const failure = syncError(error);
        if (failure.retryable) throw failure;
        await deadLetter(db, {
          integration,
          sourceType: "refresh",
          sourceId: `${claimed.id}:${record.id}`,
          error: failure,
          evidence: { entityType: claimed.entityType, entityId: sessionPartyId, airtableRecordId: record.id },
          now,
        });
      }
    }
    const finished = !page.cursor;
    await db.update(airtableRefreshState).set({
      status: finished ? "idle" : "requested",
      dueAt: finished ? null : new Date(now.getTime() + MIN_REQUEST_INTERVAL_MS),
      cursor: page.cursor ?? null,
      lastSuccessAt: finished ? now : claimed.lastSuccessAt,
      lastError: null,
      leaseOwner: null,
      leaseExpiresAt: null,
      attemptCount: finished ? 0 : claimed.attemptCount,
      version: claimed.version + 1,
      updatedAt: now,
    }).where(and(
      eq(airtableRefreshState.id, claimed.id),
      eq(airtableRefreshState.status, "claimed"),
      eq(airtableRefreshState.leaseOwner, leaseOwner),
    ));
    if (finished) {
      await db.update(integrations).set({ lastSyncAt: now, lastError: null, updatedAt: now })
        .where(eq(integrations.id, integration.id));
    }
  } catch (error) {
    await failRefresh(db, integration, claimed, error, now);
  }
  return true;
};

export const requestRefreshRows = async (
  database: D1Database,
  integrationId: string,
  eventId: string,
  entityTypes: readonly AirtableEntityType[] = AIRTABLE_ENTITY_TYPES,
  now = new Date(),
): Promise<void> => {
  const db = drizzle(database, { schema });
  const statements = entityTypes.map((entityType) =>
    db.insert(airtableRefreshState).values({
      id: crypto.randomUUID(),
      eventId,
      integrationId,
      entityType,
      status: "requested",
      requestedAt: now,
      dueAt: now,
      attemptCount: 0,
      version: 1,
      createdAt: now,
      updatedAt: now,
    }).onConflictDoUpdate({
      target: [
        airtableRefreshState.eventId,
        airtableRefreshState.integrationId,
        airtableRefreshState.entityType,
      ],
      set: {
        status: sql`case when ${airtableRefreshState.status} = 'claimed' then ${airtableRefreshState.status} else 'requested' end`,
        requestedAt: now,
        dueAt: sql`case when ${airtableRefreshState.status} = 'claimed' then ${airtableRefreshState.dueAt} else ${now.getTime()} end`,
        lastError: null,
        deadLetteredAt: null,
        version: sql`${airtableRefreshState.version} + 1`,
        updatedAt: now,
      },
    })
  );
  await db.batch(statements as unknown as [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]]);
};

const requestStaleBackgroundRefresh = async (
  database: D1Database,
  db: AppDb,
  integration: AirtableIntegration,
  now: Date,
): Promise<void> => {
  const rows = await db.select({
    entityType: airtableRefreshState.entityType,
    status: airtableRefreshState.status,
    lastSuccessAt: airtableRefreshState.lastSuccessAt,
  }).from(airtableRefreshState).where(eq(airtableRefreshState.integrationId, integration.id));
  const byEntity = new Map(rows.map((row) => [row.entityType, row]));
  const staleBefore = now.getTime() - BACKGROUND_REFRESH_INTERVAL_MS;
  const stale = AIRTABLE_ENTITY_TYPES.filter((entityType) => {
    const row = byEntity.get(entityType);
    return !row || (row.status === "idle" && (row.lastSuccessAt?.getTime() ?? 0) <= staleBefore);
  });
  if (stale.length > 0) {
    await requestRefreshRows(database, integration.id, integration.eventId, stale, now);
  }
};

export const drainAirtableBase = async (
  runtime: AirtableLaneRuntime,
  baseId: string,
): Promise<AirtableDrainResult> => {
  const db = drizzle(runtime.database, { schema });
  const now = runtime.now?.() ?? new Date();
  const baseIntegrations = await integrationsForBase(db, baseId);
  for (const integration of baseIntegrations) {
    await enqueueOneMissingProjection(db, integration, now);
    if (await processOutbound(db, integration, runtime.adapter, now, runtime.broadcast)) {
      return { processed: true, nextAlarmAt: now.getTime() + MIN_REQUEST_INTERVAL_MS };
    }
  }
  for (const integration of baseIntegrations) {
    await requestStaleBackgroundRefresh(runtime.database, db, integration, now);
  }
  for (const integration of baseIntegrations) {
    if (await processRefresh(db, integration, runtime.adapter, now, runtime.broadcast)) {
      return { processed: true, nextAlarmAt: now.getTime() + MIN_REQUEST_INTERVAL_MS };
    }
  }
  return { processed: false, nextAlarmAt: now.getTime() + RECOVERY_INTERVAL_MS };
};
