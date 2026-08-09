import { Conflict, External, NotFound } from "contracts/errors";
import * as tables from "contracts/schema";
import {
  AccelConfig,
  AcceleventsSnapshot,
  type AcceleventsImportCounts,
  type AcceleventsImportItem,
  type AcceleventsImportMode,
  AcceleventsImportRun,
  type AcceleventsImportStatus,
  type AcceleventsSourceSpeaker,
  type AcceleventsSourceTalk,
  type ExternalSecretRef,
} from "contracts/types";
import { and, desc, eq, lte, ne, sql } from "drizzle-orm";
import { Effect, Schema } from "effect";
import type { AppDatabase } from "./services";

const API_ORIGIN = "https://api.accelevents.com";
const IMPORT_OPERATION = "integrations.runAcceleventsImport";
const SECRET_REF = "ACCELEVENTS_API_TOKEN";
const DAY_MS = 86_400_000;

declare const secretBrand: unique symbol;
export type ResolvedSecret = string & { readonly [secretBrand]: true };

export interface SecretResolverService {
  readonly canResolve: (reference: ExternalSecretRef) => boolean;
  readonly resolve: (reference: ExternalSecretRef) => Effect.Effect<ResolvedSecret, External>;
}

export interface AcceleventsAdapterService {
  readonly mode: AcceleventsImportMode;
  readonly fetchSnapshot: (
    config: AccelConfig,
    credential: ResolvedSecret | null,
  ) => Effect.Effect<AcceleventsSnapshot, External>;
}

export interface ImportActor {
  readonly kind: "user" | "api-key";
  readonly id: string;
}

export interface RunAcceleventsImportInput {
  readonly eventId: string;
  readonly idempotencyKey: string;
  readonly actor: ImportActor;
}

export interface AcceleventsImportsService {
  readonly status: (eventId: string) => Effect.Effect<AcceleventsImportStatus, External>;
  readonly run: (
    input: RunAcceleventsImportInput,
  ) => Effect.Effect<AcceleventsImportRun, Conflict | External | NotFound>;
}

interface ImportDependencies {
  readonly db: AppDatabase;
  readonly adapter: AcceleventsAdapterService;
  /** Explicit demo fixture, selected only by the reserved fixture-event configuration. */
  readonly fixtureAdapter?: AcceleventsAdapterService;
  readonly secrets: SecretResolverService;
  readonly now?: () => number;
  readonly randomId?: () => string;
}

const decodeConfig = (value: unknown): Effect.Effect<AccelConfig, External> =>
  Schema.decodeUnknown(AccelConfig)(value).pipe(
    Effect.mapError(() => new External({
      service: "accelevents",
      detail: "Stored Accelevents configuration is invalid",
    })),
  );

const database = <A>(run: () => Promise<A>): Effect.Effect<A, External> =>
  Effect.tryPromise({
    try: run,
    catch: (error) => new External({
      service: "database",
      detail: error instanceof Error ? error.message : String(error),
    }),
  });

const sha256 = (value: string): Effect.Effect<string, External> =>
  Effect.tryPromise({
    try: async () => {
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
      return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
    },
    catch: () => new External({ service: "crypto", detail: "Unable to hash import identity" }),
  });

const safeExternalDetail = (error: External): string => {
  if (error.service === "accelevents-config") return "Accelevents credentials are unavailable";
  return "Accelevents did not return a usable snapshot";
};

const countsFor = (items: readonly AcceleventsImportItem[]): AcceleventsImportCounts => ({
  total: items.length,
  created: items.filter(({ action }) => action === "created").length,
  updated: items.filter(({ action }) => action === "updated").length,
  unchanged: items.filter(({ action }) => action === "unchanged").length,
  failed: items.filter(({ action }) => action === "failed").length,
});

const statusForCounts = (counts: AcceleventsImportCounts): "succeeded" | "partial" | "failed" => {
  if (counts.total > 0 && counts.failed === counts.total) return "failed";
  return counts.failed === 0 ? "succeeded" : "partial";
};

const actorColumns = (actor: ImportActor) => actor.kind === "user"
  ? { actorUserId: actor.id, actorApiKeyId: null }
  : { actorUserId: null, actorApiKeyId: actor.id };

const rowToRun = async (
  db: AppDatabase,
  row: typeof tables.acceleventsImportRuns.$inferSelect,
): Promise<AcceleventsImportRun> => {
  const items = await db
    .select()
    .from(tables.acceleventsImportItems)
    .where(and(
      eq(tables.acceleventsImportItems.eventId, row.eventId),
      eq(tables.acceleventsImportItems.runId, row.id),
    ))
    .orderBy(tables.acceleventsImportItems.order);
  if (row.status === "running") {
    throw new Error("Unfinished Accelevents runs cannot be exposed as completed results");
  }
  return {
    runId: row.id,
    mode: row.mode,
    eventId: row.eventId,
    integrationId: row.integrationId,
    providerEventId: row.sourceEventId,
    eventUrl: row.eventUrl,
    startedAt: row.startedAt.getTime(),
    completedAt: row.completedAt!.getTime(),
    status: row.status,
    counts: {
      total: row.totalCount,
      created: row.createdCount,
      updated: row.updatedCount,
      unchanged: row.unchangedCount,
      failed: row.failedCount,
    },
    errorCode: row.errorCode,
    errorDetail: row.errorDetail,
    items: items.map((item) => ({
      order: item.order,
      entityType: item.entityType,
      externalId: item.externalId,
      action: item.action,
      localId: item.localId,
      errorCode: item.errorCode,
      errorDetail: item.errorDetail,
    })),
  };
};

const storedIntegration = (db: AppDatabase, eventId: string) =>
  db
    .select()
    .from(tables.integrations)
    .where(and(
      eq(tables.integrations.eventId, eventId),
      eq(tables.integrations.kind, "accelevents"),
    ))
    .limit(1);

const latestRun = async (
  db: AppDatabase,
  eventId: string,
  integrationId: string,
): Promise<AcceleventsImportRun | null> => {
  const [row] = await db
    .select()
    .from(tables.acceleventsImportRuns)
    .where(and(
      eq(tables.acceleventsImportRuns.eventId, eventId),
      eq(tables.acceleventsImportRuns.integrationId, integrationId),
      ne(tables.acceleventsImportRuns.status, "running"),
    ))
    .orderBy(desc(tables.acceleventsImportRuns.startedAt), desc(tables.acceleventsImportRuns.id))
    .limit(1);
  return row ? rowToRun(db, row) : null;
};

type ReplayResult =
  | { readonly kind: "none" }
  | { readonly kind: "mismatch" }
  | { readonly kind: "in-progress" }
  | {
    readonly kind: "expired";
    readonly record: typeof tables.idempotencyRecords.$inferSelect;
    readonly run: typeof tables.acceleventsImportRuns.$inferSelect | null;
  }
  | { readonly kind: "completed"; readonly run: AcceleventsImportRun };

const claimedRunId = (body: unknown): string | null => {
  if (typeof body !== "object" || body === null || !("runId" in body)) return null;
  return typeof body.runId === "string" ? body.runId : null;
};

const replayFor = async (
  db: AppDatabase,
  input: RunAcceleventsImportInput,
  integrationId: string,
  keyHash: string,
  requestHash: string,
  nowMs: number,
): Promise<ReplayResult> => {
  const principalId = `${input.actor.kind}:${input.actor.id}`;
  const [record] = await db
    .select()
    .from(tables.idempotencyRecords)
    .where(and(
      eq(tables.idempotencyRecords.eventId, input.eventId),
      eq(tables.idempotencyRecords.operationId, IMPORT_OPERATION),
      eq(tables.idempotencyRecords.principalId, principalId),
      eq(tables.idempotencyRecords.keyHash, keyHash),
    ))
    .limit(1);
  if (!record) return { kind: "none" };
  if (record.requestHash !== requestHash) return { kind: "mismatch" };
  if (record.status === "in_progress" && record.expiresAt.getTime() <= nowMs) {
    const runId = claimedRunId(record.responseBody);
    const [run] = runId
      ? await db.select().from(tables.acceleventsImportRuns).where(and(
        eq(tables.acceleventsImportRuns.eventId, input.eventId),
        eq(tables.acceleventsImportRuns.integrationId, integrationId),
        eq(tables.acceleventsImportRuns.id, runId),
      )).limit(1)
      : [];
    return { kind: "expired", record, run: run ?? null };
  }
  if (record.status !== "completed" || !record.responseBody) return { kind: "in-progress" };
  return {
    kind: "completed",
    run: Schema.decodeUnknownSync(AcceleventsImportRun)(record.responseBody),
  };
};

const reclaimExpired = (
  db: AppDatabase,
  replay: Extract<ReplayResult, { readonly kind: "expired" }>,
  keyHash: string,
  completedAtMs: number,
) => Effect.gen(function* () {
  const completedAt = new Date(completedAtMs);
  const retiredKeyHash = yield* sha256(`${keyHash}:${replay.record.id}:${completedAtMs}`);
  const retireClaim = db.update(tables.idempotencyRecords).set({
    keyHash: retiredKeyHash,
    status: "failed",
    responseStatus: 500,
    responseBody: replay.run ? {
      runId: replay.run.id,
      errorCode: "import_interrupted",
      errorDetail: "The previous import did not complete",
    } : null,
    completedAt,
  }).where(and(
    eq(tables.idempotencyRecords.eventId, replay.record.eventId),
    eq(tables.idempotencyRecords.id, replay.record.id),
    eq(tables.idempotencyRecords.status, "in_progress"),
    lte(tables.idempotencyRecords.expiresAt, completedAt),
  ));
  if (replay.run?.status === "running") {
    yield* database(() => db.batch([
      db.update(tables.acceleventsImportRuns).set({
        status: "failed",
        errorCode: "import_interrupted",
        errorDetail: "The previous import did not complete",
        completedAt,
      }).where(and(
        eq(tables.acceleventsImportRuns.eventId, replay.run!.eventId),
        eq(tables.acceleventsImportRuns.integrationId, replay.run!.integrationId),
        eq(tables.acceleventsImportRuns.id, replay.run!.id),
        eq(tables.acceleventsImportRuns.status, "running"),
      )),
      retireClaim,
    ]));
    return;
  }
  yield* database(() => retireClaim);
});

const recordItem = (
  db: AppDatabase,
  runId: string,
  eventId: string,
  integrationId: string,
  item: AcceleventsImportItem,
  createdAt: Date,
) => db.insert(tables.acceleventsImportItems).values({
  id: crypto.randomUUID(),
  eventId,
  integrationId,
  runId,
  order: item.order,
  entityType: item.entityType,
  externalId: item.externalId,
  action: item.action,
  localId: item.localId,
  errorCode: item.errorCode,
  errorDetail: item.errorDetail,
  createdAt,
});

const importSpeaker = (
  dependencies: Required<Pick<ImportDependencies, "db" | "now" | "randomId">>,
  eventId: string,
  integrationId: string,
  runId: string,
  sourceEventId: string,
  speaker: AcceleventsSourceSpeaker,
  order: number,
): Effect.Effect<AcceleventsImportItem, External> => Effect.gen(function* () {
  const { db, now, randomId } = dependencies;
  const sourceHash = yield* sha256(JSON.stringify(speaker));
  const [identity] = yield* database(() => db
    .select()
    .from(tables.acceleventsExternalIdentities)
    .where(and(
      eq(tables.acceleventsExternalIdentities.eventId, eventId),
      eq(tables.acceleventsExternalIdentities.integrationId, integrationId),
      eq(tables.acceleventsExternalIdentities.sourceEventId, sourceEventId),
      eq(tables.acceleventsExternalIdentities.entityType, "speaker"),
      eq(tables.acceleventsExternalIdentities.externalId, speaker.externalId),
    ))
    .limit(1));
  if (identity?.sourceHash === sourceHash) {
    const item = { order, entityType: "speaker", externalId: speaker.externalId, action: "unchanged", localId: identity.entityId, errorCode: null, errorDetail: null } satisfies AcceleventsImportItem;
    yield* database(() => recordItem(db, runId, eventId, integrationId, item, new Date(now())));
    return item;
  }

  const timestamp = new Date(now());
  const localId = identity?.entityId ?? randomId();
  const speakerWrite = identity
    ? db.update(tables.speakers).set({
      displayName: speaker.displayName,
      title: speaker.title,
      company: speaker.company,
      bio: speaker.bio,
      updatedAt: timestamp,
      version: sql`${tables.speakers.version} + 1`,
    }).where(and(eq(tables.speakers.eventId, eventId), eq(tables.speakers.id, localId)))
    : db.insert(tables.speakers).values({
      id: localId,
      eventId,
      userId: null,
      displayName: speaker.displayName,
      title: speaker.title,
      company: speaker.company,
      bio: speaker.bio,
      headshotAssetId: null,
      links: [],
      visible: true,
      version: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
  const identityWrite = identity
    ? db.update(tables.acceleventsExternalIdentities).set({ sourceHash, updatedAt: timestamp }).where(and(
      eq(tables.acceleventsExternalIdentities.eventId, eventId),
      eq(tables.acceleventsExternalIdentities.id, identity.id),
    ))
    : db.insert(tables.acceleventsExternalIdentities).values({
      id: randomId(),
      eventId,
      integrationId,
      sourceEventId,
      entityType: "speaker",
      externalId: speaker.externalId,
      entityId: localId,
      speakerId: localId,
      talkId: null,
      sourceHash,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
  const item = {
    order,
    entityType: "speaker",
    externalId: speaker.externalId,
    action: identity ? "updated" : "created",
    localId,
    errorCode: null,
    errorDetail: null,
  } satisfies AcceleventsImportItem;
  const result = yield* database(() => db.batch([
    speakerWrite,
    identityWrite,
    recordItem(db, runId, eventId, integrationId, item, timestamp),
  ])).pipe(Effect.either);
  if (result._tag === "Right") return item;
  const failed = { order, entityType: "speaker", externalId: speaker.externalId, action: "failed", localId: null, errorCode: "persistence_failed", errorDetail: "Speaker could not be imported" } satisfies AcceleventsImportItem;
  yield* database(() => recordItem(db, runId, eventId, integrationId, failed, new Date(now())));
  return failed;
});

const importTalk = (
  dependencies: Required<Pick<ImportDependencies, "db" | "now" | "randomId">>,
  eventId: string,
  integrationId: string,
  runId: string,
  sourceEventId: string,
  talk: AcceleventsSourceTalk,
  order: number,
): Effect.Effect<AcceleventsImportItem, External> => Effect.gen(function* () {
  const { db, now, randomId } = dependencies;
  const sourceHash = yield* sha256(JSON.stringify(talk));
  const [identity] = yield* database(() => db
    .select()
    .from(tables.acceleventsExternalIdentities)
    .where(and(
      eq(tables.acceleventsExternalIdentities.eventId, eventId),
      eq(tables.acceleventsExternalIdentities.integrationId, integrationId),
      eq(tables.acceleventsExternalIdentities.sourceEventId, sourceEventId),
      eq(tables.acceleventsExternalIdentities.entityType, "talk"),
      eq(tables.acceleventsExternalIdentities.externalId, talk.externalId),
    ))
    .limit(1));
  if (identity?.sourceHash === sourceHash) {
    const item = { order, entityType: "talk", externalId: talk.externalId, action: "unchanged", localId: identity.entityId, errorCode: null, errorDetail: null } satisfies AcceleventsImportItem;
    yield* database(() => recordItem(db, runId, eventId, integrationId, item, new Date(now())));
    return item;
  }

  const speakerLinks = yield* database(() => db
    .select({ externalId: tables.acceleventsExternalIdentities.externalId, speakerId: tables.acceleventsExternalIdentities.speakerId })
    .from(tables.acceleventsExternalIdentities)
    .where(and(
      eq(tables.acceleventsExternalIdentities.eventId, eventId),
      eq(tables.acceleventsExternalIdentities.integrationId, integrationId),
      eq(tables.acceleventsExternalIdentities.sourceEventId, sourceEventId),
      eq(tables.acceleventsExternalIdentities.entityType, "speaker"),
    )));
  const speakersByExternalId = new Map(speakerLinks.map((link) => [link.externalId, link.speakerId]));
  const missing = talk.speakerExternalIds.find((externalId) => !speakersByExternalId.get(externalId));
  if (missing) {
    const item = { order, entityType: "talk", externalId: talk.externalId, action: "failed", localId: null, errorCode: "speaker_not_imported", errorDetail: "A referenced speaker was not imported" } satisfies AcceleventsImportItem;
    yield* database(() => recordItem(db, runId, eventId, integrationId, item, new Date(now())));
    return item;
  }

  const timestamp = new Date(now());
  const localId = identity?.entityId ?? randomId();
  const talkWrite = identity
    ? db.update(tables.talks).set({
      title: talk.title,
      description: talk.description,
      startsAt: talk.startsAt === null ? null : new Date(talk.startsAt),
      durationMin: talk.durationMin,
      status: talk.status,
      version: sql`${tables.talks.version} + 1`,
      updatedAt: timestamp,
    }).where(and(eq(tables.talks.eventId, eventId), eq(tables.talks.id, localId)))
    : db.insert(tables.talks).values({
      id: localId,
      eventId,
      submissionId: null,
      title: talk.title,
      description: talk.description,
      trackId: null,
      roomId: null,
      startsAt: talk.startsAt === null ? null : new Date(talk.startsAt),
      durationMin: talk.durationMin,
      status: talk.status,
      version: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
  const identityWrite = identity
    ? db.update(tables.acceleventsExternalIdentities).set({ sourceHash, updatedAt: timestamp }).where(and(
      eq(tables.acceleventsExternalIdentities.eventId, eventId),
      eq(tables.acceleventsExternalIdentities.id, identity.id),
    ))
    : db.insert(tables.acceleventsExternalIdentities).values({
      id: randomId(),
      eventId,
      integrationId,
      sourceEventId,
      entityType: "talk",
      externalId: talk.externalId,
      entityId: localId,
      speakerId: null,
      talkId: localId,
      sourceHash,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
  const item = {
    order,
    entityType: "talk",
    externalId: talk.externalId,
    action: identity ? "updated" : "created",
    localId,
    errorCode: null,
    errorDetail: null,
  } satisfies AcceleventsImportItem;
  const result = yield* database(() => db.batch([
    talkWrite,
    db.delete(tables.talkSpeakers).where(and(
      eq(tables.talkSpeakers.eventId, eventId),
      eq(tables.talkSpeakers.talkId, localId),
    )),
    ...talk.speakerExternalIds.map((externalId) => db.insert(tables.talkSpeakers).values({
      id: randomId(),
      eventId,
      talkId: localId,
      speakerId: speakersByExternalId.get(externalId)!,
      createdAt: timestamp,
    })),
    identityWrite,
    recordItem(db, runId, eventId, integrationId, item, timestamp),
  ])).pipe(Effect.either);
  if (result._tag === "Right") return item;
  const failed = { order, entityType: "talk", externalId: talk.externalId, action: "failed", localId: null, errorCode: "persistence_failed", errorDetail: "Talk could not be imported" } satisfies AcceleventsImportItem;
  yield* database(() => recordItem(db, runId, eventId, integrationId, failed, new Date(now())));
  return failed;
});

export const createAcceleventsImports = ({
  db,
  adapter,
  fixtureAdapter,
  secrets,
  now = Date.now,
  randomId = () => crypto.randomUUID(),
}: ImportDependencies): AcceleventsImportsService => ({
  status: (eventId) => Effect.gen(function* () {
    const [integration] = yield* database(() => storedIntegration(db, eventId));
    if (!integration) {
      return {
        configured: false,
        config: null,
        capability: { mode: null, state: "unavailable", reason: "not_configured" },
        latestRun: null,
      } satisfies AcceleventsImportStatus;
    }
    const config = yield* decodeConfig(integration.config);
    const selectedAdapter = fixtureAdapter?.mode === "fixture"
      && config.accelEventId === "fixture-event"
      && config.eventUrl === "fixture-event"
      ? fixtureAdapter
      : adapter;
    const ready = selectedAdapter.mode === "fixture" || secrets.canResolve(integration.secretRef);
    const latest = yield* database(() => latestRun(db, eventId, integration.id));
    return {
      configured: true,
      config,
      capability: {
        mode: selectedAdapter.mode,
        state: ready ? "ready" : "unavailable",
        reason: ready ? null : "credential_unavailable",
      },
      latestRun: latest,
    } satisfies AcceleventsImportStatus;
  }),
  run: (input) => Effect.gen(function* () {
    const [integration] = yield* database(() => storedIntegration(db, input.eventId));
    if (!integration) {
      return yield* Effect.fail(new NotFound({ entity: "integration", id: "accelevents" }));
    }
    const config = yield* decodeConfig(integration.config);
    const selectedAdapter = fixtureAdapter?.mode === "fixture"
      && config.accelEventId === "fixture-event"
      && config.eventUrl === "fixture-event"
      ? fixtureAdapter
      : adapter;
    const keyHash = yield* sha256(input.idempotencyKey);
    const requestHash = yield* sha256(JSON.stringify({
      eventId: input.eventId,
      integrationId: integration.id,
      providerEventId: config.accelEventId,
      eventUrl: config.eventUrl,
    }));
    const observedAtMs = now();
    const replay = yield* database(() => replayFor(
      db,
      input,
      integration.id,
      keyHash,
      requestHash,
      observedAtMs,
    ));
    if (replay.kind === "mismatch") {
      return yield* Effect.fail(
        new Conflict({ message: "Idempotency key was already used for a different request" }),
      );
    }
    if (replay.kind === "in-progress") {
      return yield* Effect.fail(
        new Conflict({ message: "An Accelevents import with this idempotency key is in progress" }),
      );
    }
    if (replay.kind === "completed") return replay.run;
    if (replay.kind === "expired") {
      yield* reclaimExpired(db, replay, keyHash, observedAtMs);
    }
    const startedAtMs = now();
    const startedAt = new Date(startedAtMs);
    const runId = randomId();
    const idempotencyId = randomId();
    const principalId = `${input.actor.kind}:${input.actor.id}`;
    const claim = yield* database(() => db.batch([
      db.insert(tables.idempotencyRecords).values({
        id: idempotencyId,
        eventId: input.eventId,
        operationId: IMPORT_OPERATION,
        principalId,
        keyHash,
        requestHash,
        status: "in_progress",
        responseStatus: null,
        responseBody: { runId },
        expiresAt: new Date(startedAtMs + DAY_MS),
        completedAt: null,
        createdAt: startedAt,
      }),
      db.insert(tables.acceleventsImportRuns).values({
        id: runId,
        eventId: input.eventId,
        integrationId: integration.id,
        sourceEventId: config.accelEventId,
        eventUrl: config.eventUrl,
        mode: selectedAdapter.mode,
        status: "running",
        totalCount: 0,
        createdCount: 0,
        updatedCount: 0,
        unchangedCount: 0,
        failedCount: 0,
        errorCode: null,
        errorDetail: null,
        startedAt,
        completedAt: null,
      }),
    ])).pipe(Effect.either);
    if (claim._tag === "Left") {
      const raced = yield* database(() => replayFor(
        db,
        input,
        integration.id,
        keyHash,
        requestHash,
        now(),
      ));
      if (raced.kind === "completed") return raced.run;
      if (raced.kind === "mismatch") {
        return yield* Effect.fail(
          new Conflict({ message: "Idempotency key was already used for a different request" }),
        );
      }
      if (raced.kind === "in-progress" || raced.kind === "expired") {
        return yield* Effect.fail(
          new Conflict({ message: "An Accelevents import with this idempotency key is in progress" }),
        );
      }
      return yield* Effect.fail(claim.left);
    }

    const snapshotResult = yield* (
      selectedAdapter.mode === "fixture"
        ? selectedAdapter.fetchSnapshot(config, null)
        : secrets.resolve(integration.secretRef).pipe(
          Effect.flatMap((credential) => selectedAdapter.fetchSnapshot(config, credential)),
        )
    ).pipe(Effect.either);

    const finalize = (run: AcceleventsImportRun, syncSucceeded: boolean) => database(() => {
      const completedAt = new Date(run.completedAt);
      const actor = actorColumns(input.actor);
      return db.batch([
        db.update(tables.acceleventsImportRuns).set({
          status: run.status,
          totalCount: run.counts.total,
          createdCount: run.counts.created,
          updatedCount: run.counts.updated,
          unchangedCount: run.counts.unchanged,
          failedCount: run.counts.failed,
          errorCode: run.errorCode,
          errorDetail: run.errorDetail,
          completedAt,
        }).where(and(
          eq(tables.acceleventsImportRuns.eventId, input.eventId),
          eq(tables.acceleventsImportRuns.id, runId),
        )),
        db.update(tables.integrations).set({
          lastSyncAt: syncSucceeded ? completedAt : integration.lastSyncAt,
          lastError: run.status === "failed" ? run.errorDetail : null,
          version: integration.version + 1,
          updatedAt: completedAt,
        }).where(and(
          eq(tables.integrations.eventId, input.eventId),
          eq(tables.integrations.id, integration.id),
        )),
        db.update(tables.idempotencyRecords).set({
          status: "completed",
          responseStatus: 200,
          responseBody: run,
          completedAt,
        }).where(and(
          eq(tables.idempotencyRecords.eventId, input.eventId),
          eq(tables.idempotencyRecords.id, idempotencyId),
        )),
        db.insert(tables.domainChanges).values({
          id: randomId(),
          eventId: input.eventId,
          aggregateType: "acceleventsImport",
          aggregateId: runId,
          aggregateVersion: 1,
          eventType: "accelevents.import.completed",
          audiences: [{ kind: "admins" }],
          payload: { runId, mode: selectedAdapter.mode, status: run.status, counts: run.counts },
          ...actor,
          requestId: runId,
          idempotencyRecordId: idempotencyId,
          occurredAt: completedAt,
        }),
        db.insert(tables.auditLog).values({
          id: randomId(),
          eventId: input.eventId,
          requestId: runId,
          ...actor,
          action: "accelevents.import",
          resourceType: "integration",
          resourceId: integration.id,
          before: null,
          after: { runId, mode: selectedAdapter.mode, status: run.status, counts: run.counts },
          metadata: { sourceEventId: config.accelEventId, eventUrl: config.eventUrl },
          occurredAt: completedAt,
        }),
      ]);
    });

    if (snapshotResult._tag === "Left") {
      const completedAt = now();
      const error = snapshotResult.left as External;
      const run: AcceleventsImportRun = {
        runId,
        mode: selectedAdapter.mode,
        eventId: input.eventId,
        integrationId: integration.id,
        providerEventId: config.accelEventId,
        eventUrl: config.eventUrl,
        startedAt: startedAtMs,
        completedAt,
        status: "failed",
        counts: { total: 0, created: 0, updated: 0, unchanged: 0, failed: 0 },
        errorCode: "snapshot_unavailable",
        errorDetail: safeExternalDetail(error),
        items: [],
      };
      yield* finalize(run, false);
      return run;
    }

    const snapshot = snapshotResult.right;
    if (snapshot.providerEventId !== config.accelEventId) {
      const completedAt = now();
      const run: AcceleventsImportRun = {
        runId,
        mode: selectedAdapter.mode,
        eventId: input.eventId,
        integrationId: integration.id,
        providerEventId: config.accelEventId,
        eventUrl: config.eventUrl,
        startedAt: startedAtMs,
        completedAt,
        status: "failed",
        counts: { total: 0, created: 0, updated: 0, unchanged: 0, failed: 0 },
        errorCode: "source_event_mismatch",
        errorDetail: "Accelevents returned a different event",
        items: [],
      };
      yield* finalize(run, false);
      return run;
    }

    const itemDependencies = { db, now, randomId };
    const items: AcceleventsImportItem[] = [];
    const processing = yield* Effect.gen(function* () {
      for (const speaker of snapshot.speakers) {
        const item = yield* importSpeaker(
          itemDependencies,
          input.eventId,
          integration.id,
          runId,
          config.accelEventId,
          speaker,
          items.length,
        );
        items.push(item);
      }
      for (const talk of snapshot.talks) {
        const item = yield* importTalk(
          itemDependencies,
          input.eventId,
          integration.id,
          runId,
          config.accelEventId,
          talk,
          items.length,
        );
        items.push(item);
      }
    }).pipe(Effect.either);
    if (processing._tag === "Left") {
      const completedAt = now();
      const run: AcceleventsImportRun = {
        runId,
        mode: selectedAdapter.mode,
        eventId: input.eventId,
        integrationId: integration.id,
        providerEventId: config.accelEventId,
        eventUrl: config.eventUrl,
        startedAt: startedAtMs,
        completedAt,
        status: "failed",
        counts: countsFor(items),
        errorCode: "import_persistence_failed",
        errorDetail: "Import processing could not be completed",
        items,
      };
      yield* finalize(run, false);
      return run;
    }
    const counts = countsFor(items);
    const status = statusForCounts(counts);
    const completedAt = now();
    const run: AcceleventsImportRun = {
      runId,
      mode: selectedAdapter.mode,
      eventId: input.eventId,
      integrationId: integration.id,
      providerEventId: config.accelEventId,
      eventUrl: config.eventUrl,
      startedAt: startedAtMs,
      completedAt,
      status,
      counts,
      errorCode: status === "failed" ? "all_items_failed" : null,
      errorDetail: status === "failed" ? "Every imported item failed" : null,
      items,
    };
    yield* finalize(run, status !== "failed");
    return run;
  }),
});

const VendorSpeaker = Schema.Struct({
  speakerId: Schema.Union(Schema.String, Schema.Number),
  name: Schema.String,
  title: Schema.optional(Schema.String),
  company: Schema.optional(Schema.String),
  bio: Schema.optional(Schema.String),
});
const VendorSession = Schema.Struct({
  sessionId: Schema.Union(Schema.String, Schema.Number),
  title: Schema.String,
  description: Schema.optional(Schema.String),
  startDate: Schema.optional(Schema.Union(Schema.String, Schema.Number)),
  endDate: Schema.optional(Schema.Union(Schema.String, Schema.Number)),
  status: Schema.optional(Schema.String),
  speakerList: Schema.optional(Schema.Array(VendorSpeaker)),
});
const VendorPage = <A, I>(item: Schema.Schema<A, I, never>) => Schema.Union(
  Schema.Array(item),
  Schema.Struct({ content: Schema.Array(item) }),
  Schema.Struct({ data: Schema.Array(item) }),
);

const pageItems = <A>(
  page: readonly A[] | { readonly content: readonly A[] } | { readonly data: readonly A[] },
): readonly A[] => {
  if ("content" in page) return page.content;
  if ("data" in page) return page.data;
  return page as readonly A[];
};

const fetchVendorPages = async <A, I>(
  fetchImpl: typeof fetch,
  url: URL,
  headers: Readonly<Record<string, string>>,
  itemSchema: Schema.Schema<A, I, never>,
): Promise<readonly A[]> => {
  const size = 500;
  const items: A[] = [];
  for (let page = 0; page < 10_000; page += 1) {
    url.searchParams.set("page", String(page));
    url.searchParams.set("size", String(size));
    const response = await fetchImpl(url, { headers });
    if (!response.ok) throw new Error(`provider status ${response.status}`);
    const decoded = Schema.decodeUnknownSync(VendorPage(itemSchema))(await response.json());
    const next = pageItems(decoded);
    items.push(...next);
    if (next.length < size) return items;
  }
  throw new Error("provider pagination limit exceeded");
};

const timestamp = (value: string | number | undefined): number | null => {
  if (value === undefined) return null;
  const parsed = typeof value === "number" ? value : Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
};

export const createLiveAcceleventsAdapter = (
  fetchImpl: typeof fetch = fetch,
): AcceleventsAdapterService => ({
  mode: "live",
  fetchSnapshot: (config, credential) => Effect.tryPromise({
    try: async () => {
      if (!credential) throw new Error("credential unavailable");
      const headers = { Accept: "application/json", Authorization: credential as string };
      const speakerUrl = new URL(`/rest/host/event/${encodeURIComponent(config.eventUrl)}/speaker`, API_ORIGIN);
      speakerUrl.searchParams.set("eventId", config.accelEventId);
      const sessionUrl = new URL(`/rest/events/${encodeURIComponent(config.eventUrl)}/session/v2/get-all-sessions`, API_ORIGIN);
      sessionUrl.searchParams.set("expand", "SPEAKER");
      const [speakerRows, sessionRows] = await Promise.all([
        fetchVendorPages(fetchImpl, speakerUrl, headers, VendorSpeaker),
        fetchVendorPages(fetchImpl, sessionUrl, headers, VendorSession),
      ]);
      const speakers = speakerRows.map((speaker) => ({
        externalId: String(speaker.speakerId),
        displayName: speaker.name,
        title: speaker.title ?? null,
        company: speaker.company ?? null,
        bio: speaker.bio ?? null,
      }));
      const talks = sessionRows.map((session) => {
        const startsAt = timestamp(session.startDate);
        const endsAt = timestamp(session.endDate);
        const durationMin = startsAt !== null && endsAt !== null && endsAt > startsAt
          ? Math.max(1, Math.round((endsAt - startsAt) / 60_000))
          : 30;
        return {
          externalId: String(session.sessionId),
          title: session.title,
          description: session.description ?? null,
          startsAt,
          durationMin,
          status: session.status?.toLowerCase() === "cancelled" ? "cancelled" as const : "confirmed" as const,
          speakerExternalIds: (session.speakerList ?? []).map((speaker) => String(speaker.speakerId)),
        };
      });
      return Schema.decodeUnknownSync(AcceleventsSnapshot)({
        providerEventId: config.accelEventId,
        speakers,
        talks,
      });
    },
    catch: () => new External({
      service: "accelevents",
      detail: "Accelevents snapshot request failed",
    }),
  }),
});

export const createFixtureAcceleventsAdapter = (): AcceleventsAdapterService => ({
  mode: "fixture",
  fetchSnapshot: (config) => Effect.succeed({
    providerEventId: config.accelEventId,
    speakers: [
      { externalId: "fixture-speaker-1", displayName: "Ada Lovelace", title: "Computing Pioneer", company: "Analytical Engines", bio: "Deterministic Accelevents fixture speaker." },
      { externalId: "fixture-speaker-2", displayName: "Grace Hopper", title: "Rear Admiral", company: "US Navy", bio: "Deterministic Accelevents fixture speaker." },
    ],
    talks: [
      { externalId: "fixture-talk-1", title: "Programming the Future", description: "A deterministic imported session.", startsAt: 1_800_000_000_000, durationMin: 45, status: "confirmed", speakerExternalIds: ["fixture-speaker-1"] },
      { externalId: "fixture-talk-2", title: "Debugging at Scale", description: "A second deterministic imported session.", startsAt: 1_800_003_600_000, durationMin: 30, status: "confirmed", speakerExternalIds: ["fixture-speaker-2"] },
    ],
  }),
});

export const createSecretResolver = (
  token: string | undefined,
): SecretResolverService => ({
  canResolve: (reference) => reference === SECRET_REF && typeof token === "string" && token.length > 0,
  resolve: (reference) => reference === SECRET_REF && typeof token === "string" && token.length > 0
    ? Effect.succeed(token as ResolvedSecret)
    : Effect.fail(new External({
      service: "accelevents-config",
      detail: "Configured secret reference is unavailable",
    })),
});
