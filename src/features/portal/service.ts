import { Conflict, External, Forbidden, NotFound, Validation, type AppError } from "contracts/errors";
import type { Principal } from "contracts/principal";
import {
  acceptanceEvents,
  airtablePendingEdits,
  airtableOutbox,
  airtableRecordLinks,
  assets,
  auditLog,
  domainChanges,
  events,
  idempotencyRecords,
  integrations,
  pages,
  rooms,
  speakers,
  submissionSpeakers,
  submissions,
  taskCompletions,
  tasks,
  talks,
  tracks,
} from "contracts/schema";
import { and, asc, desc, eq, inArray, or } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { Effect, Schema } from "effect";
import { nanoid } from "nanoid";
import { CurrentUser, Db, Files } from "@/server/services";
import {
  PortalAssetContent,
  PortalMutationResult,
  type CompletePortalTaskInput,
  type GetPortalAssetInput,
  type GetPortalInput,
  type PortalAsset,
  type PortalAssetPurpose,
  type PortalMutationResult as PortalMutationResultType,
  type PortalSnapshot,
  type PortalTask,
  type UpdatePortalProfileInput,
  type UploadPortalAssetInput,
} from "./schema";

const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1_000;
const PROFILE_SYNC_FIELDS = ["displayName", "title", "company", "bio"] as const;
type ProfileSyncField = typeof PROFILE_SYNC_FIELDS[number];
const HEADSHOT_TYPES: Record<string, true> = {
  "image/jpeg": true,
  "image/png": true,
  "image/webp": true,
};
const SLIDE_TYPES: Record<string, true> = {
  "application/pdf": true,
  "application/vnd.ms-powerpoint": true,
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": true,
};
const SUPPORTING_DOCUMENT_TYPES: Record<string, true> = {
  "application/pdf": true,
  "application/msword": true,
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": true,
};
const PURPOSE_LIMITS: Record<PortalAssetPurpose, number> = {
  headshot: 10 * 1_024 * 1_024,
  slides: 100 * 1_024 * 1_024,
  supportingDocument: 25 * 1_024 * 1_024,
};

const database = <A>(run: () => Promise<A>): Effect.Effect<A, External> =>
  Effect.tryPromise({
    try: run,
    catch: (error) => new External({
      service: "database",
      detail: error instanceof Error ? error.message : String(error),
    }),
  });

const normalizeNullable = (value: string | null | undefined): string | null | undefined => {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const normalized = value.trim();
  return normalized.length === 0 ? null : normalized;
};

const requireBrowserSpeaker = (): Effect.Effect<Extract<Principal, { kind: "browser-session" }>, Forbidden, CurrentUser> =>
  Effect.gen(function* () {
    const principal = yield* CurrentUser;
    if (principal.kind !== "browser-session") {
      return yield* Effect.fail(new Forbidden({ reason: "The speaker portal requires a browser session" }));
    }
    return principal;
  });

const sha256 = (value: string): Effect.Effect<string, External> =>
  Effect.tryPromise({
    try: async () => {
      const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
      let result = "";
      for (const byte of digest) result += byte.toString(16).padStart(2, "0");
      return result;
    },
    catch: (error) => new External({ service: "crypto", detail: String(error) }),
  });

const decodeMutationReplay = (value: unknown) =>
  Schema.decodeUnknown(PortalMutationResult)(value).pipe(
    Effect.map((result) => ({ ...result, idempotent: true })),
    Effect.mapError((error) => new External({ service: "database", detail: `Invalid idempotency response: ${String(error)}` })),
  );

const commandHashes = (input: object) =>
  Effect.all({
    keyHash: sha256("idempotencyKey" in input ? String(input.idempotencyKey) : ""),
    requestHash: sha256(JSON.stringify(input)),
  });

const findReplay = (
  eventId: string,
  operationId: string,
  principalId: string,
  keyHash: string,
  requestHash: string,
): Effect.Effect<PortalMutationResultType | null, AppError, Db> =>
  Effect.gen(function* () {
    const { db } = yield* Db;
    const [record] = yield* database(() =>
      db.select().from(idempotencyRecords).where(and(
        eq(idempotencyRecords.eventId, eventId),
        eq(idempotencyRecords.operationId, operationId),
        eq(idempotencyRecords.principalId, principalId),
        eq(idempotencyRecords.keyHash, keyHash),
      )).limit(1),
    );
    if (!record) return null;
    if (record.requestHash !== requestHash) {
      return yield* Effect.fail(new Conflict({ message: "Idempotency key was already used for a different request" }));
    }
    if (record.status !== "completed" || record.responseBody === null) {
      return yield* Effect.fail(new Conflict({ message: "This request is already in progress; retry with the same key shortly" }));
    }
    return yield* decodeMutationReplay(record.responseBody);
  });

interface PortalContext {
  readonly principal: Extract<Principal, { kind: "browser-session" }>;
  readonly event: typeof events.$inferSelect;
  readonly speaker: typeof speakers.$inferSelect;
}

const portalContext = (eventSlug: string): Effect.Effect<PortalContext, AppError, CurrentUser | Db> =>
  Effect.gen(function* () {
    const principal = yield* requireBrowserSpeaker();
    const { db } = yield* Db;
    const [event] = yield* database(() =>
      db.select().from(events).where(eq(events.slug, eventSlug)).limit(1),
    );
    if (!event) return yield* Effect.fail(new NotFound({ entity: "event", id: eventSlug }));
    const [speaker] = yield* database(() =>
      db.select().from(speakers).where(and(
        eq(speakers.eventId, event.id),
        eq(speakers.userId, principal.userId),
      )).limit(1),
    );
    if (!speaker) {
      return yield* Effect.fail(new Forbidden({ reason: "No speaker profile is linked to this account for the event" }));
    }
    const [accepted] = yield* database(() =>
      db.select({ id: submissions.id }).from(submissions)
        .innerJoin(submissionSpeakers, and(
          eq(submissionSpeakers.eventId, submissions.eventId),
          eq(submissionSpeakers.submissionId, submissions.id),
        ))
        .where(and(
          eq(submissions.eventId, event.id),
          eq(submissions.status, "accepted"),
          eq(submissionSpeakers.speakerId, speaker.id),
        )).limit(1),
    );
    if (!accepted) {
      return yield* Effect.fail(new Forbidden({ reason: "The speaker portal is available after a proposal is accepted" }));
    }
    return { principal, event, speaker };
  });

const assetHref = (eventSlug: string, assetId: string) =>
  `/api/v1/events/${encodeURIComponent(eventSlug)}/portal/assets/${encodeURIComponent(assetId)}`;

const toPortalAsset = (
  eventSlug: string,
  asset: typeof assets.$inferSelect,
): PortalAsset => ({
  id: asset.id,
  filename: asset.filename,
  contentType: asset.contentType,
  size: asset.size,
  version: asset.version,
  href: assetHref(eventSlug, asset.id),
});

interface UploadCompletionData {
  readonly assetId: string;
  readonly purpose: "slides" | "supportingDocument";
}

const uploadCompletionData = (value: unknown): UploadCompletionData | null => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const assetId = Reflect.get(value, "assetId");
  const purpose = Reflect.get(value, "purpose");
  return typeof assetId === "string" && (purpose === "slides" || purpose === "supportingDocument")
    ? { assetId, purpose }
    : null;
};

export const safePortalEmbed = (stored: string | null, title: string): { src: string; title: string } | null => {
  if (!stored) return null;
  const match = stored.match(/^\s*<iframe\b[^>]*\bsrc=(?:"([^"]+)"|'([^']+)')[^>]*>\s*<\/iframe>\s*$/i);
  const candidate = match?.[1] ?? match?.[2];
  if (!candidate) return null;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  const allowed =
    ((url.hostname === "youtube.com" || url.hostname === "www.youtube.com" || url.hostname === "youtube-nocookie.com" || url.hostname === "www.youtube-nocookie.com") && url.pathname.startsWith("/embed/")) ||
    (url.hostname === "player.vimeo.com" && url.pathname.startsWith("/video/")) ||
    (url.hostname === "docs.google.com" && /^\/(?:presentation|document|spreadsheets)\/d\//.test(url.pathname));
  return allowed ? { src: url.toString(), title } : null;
};

const latestAcceptanceRows = (eventId: string, submissionIds: readonly string[]) =>
  submissionIds.length === 0
    ? Effect.succeed([] as readonly { submissionId: string; type: "accepted" | "revoked" }[])
    : Effect.gen(function* () {
      const { db } = yield* Db;
      const rows = yield* database(() =>
        db.select({ submissionId: acceptanceEvents.submissionId, type: acceptanceEvents.type })
          .from(acceptanceEvents)
          .where(and(eq(acceptanceEvents.eventId, eventId), inArray(acceptanceEvents.submissionId, submissionIds)))
          .orderBy(asc(acceptanceEvents.submissionId), desc(acceptanceEvents.occurredAt), desc(acceptanceEvents.id)),
      );
      const latest = new Map<string, { submissionId: string; type: "accepted" | "revoked" }>();
      for (const row of rows) if (!latest.has(row.submissionId)) latest.set(row.submissionId, row);
      return [...latest.values()];
    });

export const getPortal = ({ eventSlug }: GetPortalInput): Effect.Effect<PortalSnapshot, AppError, CurrentUser | Db> =>
  Effect.gen(function* () {
    const context = yield* portalContext(eventSlug);
    const { db } = yield* Db;
    const submissionRows = yield* database(() =>
      db.select({ submission: submissions }).from(submissions)
        .innerJoin(submissionSpeakers, and(
          eq(submissionSpeakers.eventId, submissions.eventId),
          eq(submissionSpeakers.submissionId, submissions.id),
        ))
        .where(and(
          eq(submissions.eventId, context.event.id),
          eq(submissions.status, "accepted"),
          eq(submissionSpeakers.speakerId, context.speaker.id),
        )).orderBy(asc(submissions.acceptedAt), asc(submissions.id)),
    );
    const submissionIds = submissionRows.map(({ submission }) => submission.id);
    const latestAcceptances = yield* latestAcceptanceRows(context.event.id, submissionIds);
    const activeSubmissionIds = new Set(latestAcceptances.filter(({ type }) => type === "accepted").map(({ submissionId }) => submissionId));
    const activeSubmissions = submissionRows.map(({ submission }) => submission).filter(({ id }) => activeSubmissionIds.has(id));
    if (activeSubmissions.length === 0) {
      return yield* Effect.fail(new Forbidden({ reason: "The proposal acceptance for this portal has been revoked" }));
    }

    const activeIds = activeSubmissions.map(({ id }) => id);
    const [associationRows, talkRows, taskRows, pageRows, pendingRows] = yield* Effect.all([
      database(() => db.select({
        submissionId: submissionSpeakers.submissionId,
        id: speakers.id,
        displayName: speakers.displayName,
        isPrimary: submissionSpeakers.isPrimary,
      }).from(submissionSpeakers).innerJoin(speakers, and(
        eq(speakers.eventId, submissionSpeakers.eventId),
        eq(speakers.id, submissionSpeakers.speakerId),
      )).where(and(
        eq(submissionSpeakers.eventId, context.event.id),
        inArray(submissionSpeakers.submissionId, activeIds),
      )).orderBy(asc(submissionSpeakers.submissionId), desc(submissionSpeakers.isPrimary), asc(speakers.displayName), asc(speakers.id))),
      database(() => db.select({ talk: talks, trackName: tracks.name, roomName: rooms.name })
        .from(talks)
        .leftJoin(tracks, and(eq(tracks.eventId, talks.eventId), eq(tracks.id, talks.trackId)))
        .leftJoin(rooms, and(eq(rooms.eventId, talks.eventId), eq(rooms.id, talks.roomId)))
        .where(and(eq(talks.eventId, context.event.id), inArray(talks.submissionId, activeIds)))
        .orderBy(asc(talks.startsAt), asc(talks.id))),
      database(() => db.select({ task: tasks, completion: taskCompletions })
        .from(tasks)
        .leftJoin(taskCompletions, and(
          eq(taskCompletions.eventId, tasks.eventId),
          eq(taskCompletions.taskId, tasks.id),
          eq(taskCompletions.speakerId, context.speaker.id),
        )).where(eq(tasks.eventId, context.event.id)).orderBy(asc(tasks.order), asc(tasks.id))),
      database(() => db.select().from(pages).where(and(
        eq(pages.eventId, context.event.id),
        or(eq(pages.audience, "speakers"), eq(pages.audience, "public")),
      )).orderBy(asc(pages.order), asc(pages.title), asc(pages.id))),
      database(() => db.select({ fieldKey: airtablePendingEdits.fieldKey, intendedValue: airtablePendingEdits.intendedValue })
        .from(airtablePendingEdits).where(and(
          eq(airtablePendingEdits.eventId, context.event.id),
          eq(airtablePendingEdits.entityType, "speaker"),
          eq(airtablePendingEdits.entityId, context.speaker.id),
          eq(airtablePendingEdits.status, "pending"),
        ))),
    ], { concurrency: 1 });

    const pending = new Map(pendingRows.map(({ fieldKey, intendedValue }) => [fieldKey, intendedValue]));
    const completionAssetData = taskRows.map(({ completion }) => uploadCompletionData(completion?.data)).filter((value): value is UploadCompletionData => value !== null);
    const assetIds = [...new Set([
      ...(context.speaker.headshotAssetId ? [context.speaker.headshotAssetId] : []),
      ...completionAssetData.map(({ assetId }) => assetId),
    ])];
    const assetRows = assetIds.length === 0
      ? []
      : yield* database(() => db.select().from(assets).where(and(
        eq(assets.eventId, context.event.id),
        inArray(assets.id, assetIds),
      )));
    const assetsById = new Map(assetRows.map((asset) => [asset.id, asset]));

    const completedFormIds = new Set<string>();
    const formTaskIds = taskRows.map(({ task }) => task.formId).filter((id): id is string => id !== null);
    if (formTaskIds.length > 0) {
      const completedForms = yield* database(() => db.select({ formId: submissions.formId })
        .from(submissions).innerJoin(submissionSpeakers, and(
          eq(submissionSpeakers.eventId, submissions.eventId),
          eq(submissionSpeakers.submissionId, submissions.id),
        )).where(and(
          eq(submissions.eventId, context.event.id),
          eq(submissions.status, "submitted"),
          eq(submissionSpeakers.speakerId, context.speaker.id),
          inArray(submissions.formId, formTaskIds),
        )));
      for (const { formId } of completedForms) completedFormIds.add(formId);
    }

    const profileValues = {
      displayName: typeof pending.get("displayName") === "string" ? pending.get("displayName") as string : context.speaker.displayName,
      title: pending.has("title") ? pending.get("title") as string | null : context.speaker.title,
      company: pending.has("company") ? pending.get("company") as string | null : context.speaker.company,
      bio: pending.has("bio") ? pending.get("bio") as string | null : context.speaker.bio,
    };
    const taskOutputs: PortalTask[] = taskRows.map(({ task, completion }) => {
      const data = uploadCompletionData(completion?.data);
      const asset = data ? assetsById.get(data.assetId) : undefined;
      const profileReady = Boolean(profileValues.bio?.trim());
      const linksReady = (context.speaker.links?.length ?? 0) > 0;
      const formReady = task.formId !== null && completedFormIds.has(task.formId);
      const prerequisite = completion
        ? { satisfied: true, message: null }
        : task.kind === "profile"
          ? { satisfied: profileReady, message: profileReady ? null : "Add your bio before completing this task." }
          : task.kind === "link"
            ? { satisfied: linksReady, message: linksReady ? null : "Add at least one profile link before completing this task." }
            : task.kind === "form"
              ? { satisfied: formReady, message: formReady ? null : "Submit the linked form before completing this task." }
              : task.kind === "upload"
                ? { satisfied: false, message: "Upload the requested file to complete this task." }
                : { satisfied: true, message: null };
      return {
        id: task.id,
        name: task.name,
        description: task.description,
        kind: task.kind,
        formId: task.formId,
        formPath: task.formId ? `/submit/${encodeURIComponent(context.event.slug)}/${encodeURIComponent(task.formId)}` : null,
        dueAt: task.dueAt?.getTime() ?? null,
        order: task.order,
        version: task.version,
        completion: completion ? {
          id: completion.id,
          completedAt: completion.completedAt.getTime(),
          version: completion.version,
          asset: asset ? toPortalAsset(context.event.slug, asset) : null,
          assetPurpose: data?.purpose ?? null,
        } : null,
        prerequisite,
      };
    });

    return {
      event: {
        id: context.event.id,
        slug: context.event.slug,
        name: context.event.name,
        timezone: context.event.timezone,
        startsAt: context.event.startsAt?.getTime() ?? null,
        endsAt: context.event.endsAt?.getTime() ?? null,
        location: context.event.location,
      },
      profile: {
        id: context.speaker.id,
        ...profileValues,
        links: context.speaker.links ?? [],
        headshot: context.speaker.headshotAssetId
          ? (() => {
            const asset = assetsById.get(context.speaker.headshotAssetId!);
            return asset ? toPortalAsset(context.event.slug, asset) : null;
          })()
          : null,
        version: context.speaker.version,
        pendingSyncFields: PROFILE_SYNC_FIELDS.filter((field) => pending.has(field)),
      },
      submissions: activeSubmissions.map((submission) => ({
        id: submission.id,
        title: submission.title,
        category: submission.category,
        acceptedAt: submission.acceptedAt!.getTime(),
        version: submission.version,
        coSpeakers: associationRows.filter((row) => row.submissionId === submission.id).map(({ id, displayName, isPrimary }) => ({ id, displayName, isPrimary })),
        talks: talkRows.filter(({ talk }) => talk.submissionId === submission.id).map(({ talk, trackName, roomName }) => ({
          id: talk.id,
          title: talk.title,
          description: talk.description,
          trackName,
          roomName,
          startsAt: talk.startsAt?.getTime() ?? null,
          durationMin: talk.durationMin,
          status: talk.status,
          version: talk.version,
        })),
      })),
      tasks: taskOutputs,
      pages: pageRows.map((page) => ({
        id: page.id,
        slug: page.slug,
        title: page.title,
        body: page.body,
        embed: safePortalEmbed(page.htmlEmbed, page.title),
        order: page.order,
        version: page.version,
      })),
      progress: {
        completed: taskOutputs.filter(({ completion }) => completion !== null).length,
        total: taskOutputs.length,
      },
    };
  });

const baseEvidence = (
  context: PortalContext,
  operationId: string,
  resourceType: string,
  resourceId: string,
  before: unknown,
  after: unknown,
  now: Date,
  requestId: string,
  idempotencyRecordId: string,
  version: number,
) => ({
  change: {
    id: nanoid(),
    eventId: context.event.id,
    aggregateType: resourceType,
    aggregateId: resourceId,
    aggregateVersion: version,
    eventType: operationId,
    audiences: [{ kind: "speaker", speakerIds: [context.speaker.id] }],
    payload: after,
    actorUserId: context.principal.userId,
    actorApiKeyId: null,
    requestId,
    idempotencyRecordId,
    occurredAt: now,
  },
  audit: {
    id: nanoid(),
    eventId: context.event.id,
    requestId,
    actorUserId: context.principal.userId,
    actorApiKeyId: null,
    action: operationId,
    resourceType,
    resourceId,
    before,
    after,
    metadata: null,
    occurredAt: now,
  },
});
const versionClaim = (
  context: PortalContext,
  aggregateType: "speaker" | "taskCompletion",
  aggregateId: string,
  aggregateVersion: number,
  requestId: string,
  idempotencyRecordId: string,
  occurredAt: Date,
) => ({
  id: nanoid(),
  eventId: context.event.id,
  aggregateType,
  aggregateId,
  aggregateVersion,
  eventType: `${aggregateType}.versionClaim`,
  audiences: [{ kind: "speaker", speakerIds: [context.speaker.id] }],
  payload: { aggregateVersion },
  actorUserId: context.principal.userId,
  actorApiKeyId: null,
  requestId,
  idempotencyRecordId,
  occurredAt,
});

const isVersionClaimCollision = (error: AppError): error is External =>
  error._tag === "External" &&
  (error.detail?.includes("domain_changes_aggregate_version_unique") === true ||
    error.detail?.includes("UNIQUE constraint failed: domain_changes.event_id") === true);


export const updatePortalProfile = (
  input: UpdatePortalProfileInput,
): Effect.Effect<PortalMutationResultType, AppError, CurrentUser | Db> =>
  Effect.gen(function* () {
    const context = yield* portalContext(input.eventSlug);
    const { keyHash, requestHash } = yield* commandHashes(input);
    const replay = yield* findReplay(context.event.id, "portal.updateProfile", context.principal.userId, keyHash, requestHash);
    if (replay) return replay;
    if (context.speaker.version !== input.expectedVersion) {
      return yield* Effect.fail(new Conflict({ message: "Profile changed; reload before saving" }));
    }
    const { db } = yield* Db;
    const [airtableIntegration] = yield* database(() =>
      db.select({ id: integrations.id }).from(integrations).where(and(
        eq(integrations.eventId, context.event.id),
        eq(integrations.kind, "airtable"),
      )).limit(1),
    );

    const now = new Date();
    const requestId = crypto.randomUUID();
    const idempotencyId = nanoid();
    const nextVersion = context.speaker.version + 1;
    const after = {
      displayName: input.displayName.trim(),
      title: input.title === undefined ? context.speaker.title : normalizeNullable(input.title)!,
      company: input.company === undefined ? context.speaker.company : normalizeNullable(input.company)!,
      bio: input.bio === undefined ? context.speaker.bio : normalizeNullable(input.bio)!,
      links: input.links?.map(({ label, url }) => ({ label: label.trim(), url })) ?? context.speaker.links ?? [],
      version: nextVersion,
    };
    const result: PortalMutationResultType = {
      eventSlug: context.event.slug,
      speakerId: context.speaker.id,
      profileVersion: nextVersion,
      taskId: null,
      taskCompletionVersion: null,
      assetId: null,
      idempotent: false,
    };
    const evidence = baseEvidence(context, "portal.profile.updated", "speaker", context.speaker.id, {
      displayName: context.speaker.displayName,
      title: context.speaker.title,
      company: context.speaker.company,
      bio: context.speaker.bio,
      links: context.speaker.links ?? [],
      version: context.speaker.version,
    }, after, now, requestId, idempotencyId, nextVersion);
    const syncStatements: BatchItem<"sqlite">[] = [];
    const changedSyncFields = PROFILE_SYNC_FIELDS.filter((field) => after[field] !== context.speaker[field]);
    if (airtableIntegration && changedSyncFields.length > 0) {
      const existingPending = yield* database(() => db.select({ fieldKey: airtablePendingEdits.fieldKey })
        .from(airtablePendingEdits).where(and(
          eq(airtablePendingEdits.eventId, context.event.id),
          eq(airtablePendingEdits.integrationId, airtableIntegration.id),
          eq(airtablePendingEdits.entityType, "speaker"),
          eq(airtablePendingEdits.entityId, context.speaker.id),
          eq(airtablePendingEdits.status, "pending"),
          inArray(airtablePendingEdits.fieldKey, changedSyncFields),
        )));
      if (existingPending.length > 0) {
        return yield* Effect.fail(new Conflict({ message: "Profile changes are already pending organizer sync" }));
      }
      const [[recordLink], [latestOutbox]] = yield* Effect.all([
        database(() => db.select({
          outboundRevision: airtableRecordLinks.outboundRevision,
          inboundRevision: airtableRecordLinks.inboundRevision,
          inboundHash: airtableRecordLinks.inboundHash,
        }).from(airtableRecordLinks).where(and(
          eq(airtableRecordLinks.eventId, context.event.id),
          eq(airtableRecordLinks.integrationId, airtableIntegration.id),
          eq(airtableRecordLinks.entityType, "speaker"),
          eq(airtableRecordLinks.entityId, context.speaker.id),
        )).limit(1)),
        database(() => db.select({ outboundRevision: airtableOutbox.outboundRevision }).from(airtableOutbox)
          .where(and(
            eq(airtableOutbox.eventId, context.event.id),
            eq(airtableOutbox.integrationId, airtableIntegration.id),
            eq(airtableOutbox.entityType, "speaker"),
            eq(airtableOutbox.entityId, context.speaker.id),
          )).orderBy(desc(airtableOutbox.outboundRevision)).limit(1)),
      ], { concurrency: 1 });
      let outboundRevision = Math.max(recordLink?.outboundRevision ?? 0, latestOutbox?.outboundRevision ?? 0);
      for (const field of changedSyncFields) {
        outboundRevision += 1;
        const pendingEditId = nanoid();
        const changedFields: Record<string, unknown> = { [field]: after[field] };
        const outboundHash = yield* sha256(JSON.stringify(changedFields));
        syncStatements.push(
          db.insert(airtablePendingEdits).values({
            id: pendingEditId,
            eventId: context.event.id,
            integrationId: airtableIntegration.id,
            entityType: "speaker",
            entityId: context.speaker.id,
            speakerId: context.speaker.id,
            submissionId: null,
            talkId: null,
            fieldKey: field,
            intendedValue: after[field],
            baseInboundRevision: recordLink?.inboundRevision ?? null,
            baseInboundHash: recordLink?.inboundHash ?? null,
            status: "pending",
            version: 1,
            createdAt: now,
            updatedAt: now,
          }),
          db.insert(airtableOutbox).values({
            id: nanoid(),
            eventId: context.event.id,
            integrationId: airtableIntegration.id,
            pendingEditId,
            entityType: "speaker",
            entityId: context.speaker.id,
            speakerId: context.speaker.id,
            submissionId: null,
            talkId: null,
            sessionPartyId: context.speaker.id,
            operation: "upsert",
            changedFields,
            outboundRevision,
            outboundHash,
            origin: "speaker-portal",
            idempotencyKey: `${input.idempotencyKey}:${field}`,
            status: "pending",
            availableAt: now,
            attemptCount: 0,
            createdAt: now,
          }),
        );
      }
    }
    const speakerUpdate = airtableIntegration
      ? { links: after.links, version: nextVersion, updatedAt: now }
      : { ...after, updatedAt: now };

    yield* database(() => db.batch([
      db.insert(idempotencyRecords).values({
        id: idempotencyId,
        eventId: context.event.id,
        operationId: "portal.updateProfile",
        principalId: context.principal.userId,
        keyHash,
        requestHash,
        status: "in_progress",
        expiresAt: new Date(now.getTime() + IDEMPOTENCY_TTL_MS),
        createdAt: now,
      }),
      db.update(speakers).set(speakerUpdate).where(and(
        eq(speakers.eventId, context.event.id),
        eq(speakers.id, context.speaker.id),
        eq(speakers.version, input.expectedVersion),
      )),
      ...syncStatements,
      db.insert(domainChanges).values(versionClaim(context, "speaker", context.speaker.id, nextVersion, requestId, idempotencyId, now)),
      db.insert(domainChanges).values(evidence.change),
      db.insert(auditLog).values(evidence.audit),
      db.update(idempotencyRecords).set({
        status: "completed",
        responseStatus: 200,
        responseBody: result,
        completedAt: now,
      }).where(eq(idempotencyRecords.id, idempotencyId)),
    ]));
    return result;
  }).pipe(
    Effect.catchIf(isVersionClaimCollision, () => Effect.fail(new Conflict({ message: "Profile changed; reload before saving" }))),
  );

const taskPrerequisiteSatisfied = (
  context: PortalContext,
  task: typeof tasks.$inferSelect,
): Effect.Effect<boolean, AppError, Db> =>
  Effect.gen(function* () {
    const { db } = yield* Db;
    if (task.kind === "confirm") return true;
    if (task.kind === "upload") return false;
    if (task.kind === "profile") {
      if (context.speaker.bio?.trim()) return true;
      const [pendingBio] = yield* database(() => db.select({ intendedValue: airtablePendingEdits.intendedValue })
        .from(airtablePendingEdits).where(and(
          eq(airtablePendingEdits.eventId, context.event.id),
          eq(airtablePendingEdits.entityType, "speaker"),
          eq(airtablePendingEdits.entityId, context.speaker.id),
          eq(airtablePendingEdits.fieldKey, "bio"),
          eq(airtablePendingEdits.status, "pending"),
        )).limit(1));
      return typeof pendingBio?.intendedValue === "string" && pendingBio.intendedValue.trim().length > 0;
    }
    if (task.kind === "link") return (context.speaker.links?.length ?? 0) > 0;
    if (!task.formId) return false;
    const [submission] = yield* database(() => db.select({ id: submissions.id }).from(submissions)
      .innerJoin(submissionSpeakers, and(
        eq(submissionSpeakers.eventId, submissions.eventId),
        eq(submissionSpeakers.submissionId, submissions.id),
      )).where(and(
        eq(submissions.eventId, context.event.id),
        eq(submissions.status, "submitted"),
        eq(submissions.formId, task.formId!),
        eq(submissionSpeakers.speakerId, context.speaker.id),
      )).limit(1));
    return Boolean(submission);
  });

export const completePortalTask = (
  input: CompletePortalTaskInput,
): Effect.Effect<PortalMutationResultType, AppError, CurrentUser | Db> =>
  Effect.gen(function* () {
    const context = yield* portalContext(input.eventSlug);
    const { db } = yield* Db;
    const [task] = yield* database(() => db.select().from(tasks).where(and(
      eq(tasks.eventId, context.event.id),
      eq(tasks.id, input.taskId),
    )).limit(1));
    if (!task) return yield* Effect.fail(new NotFound({ entity: "task", id: input.taskId }));
    const [existing] = yield* database(() => db.select().from(taskCompletions).where(and(
      eq(taskCompletions.eventId, context.event.id),
      eq(taskCompletions.taskId, task.id),
      eq(taskCompletions.speakerId, context.speaker.id),
    )).limit(1));
    const { keyHash, requestHash } = yield* commandHashes(input);
    const replay = yield* findReplay(context.event.id, "portal.completeTask", context.principal.userId, keyHash, requestHash);
    if (replay) return replay;
    const currentVersion = existing?.version ?? 0;
    if (currentVersion !== input.expectedVersion) {
      return yield* Effect.fail(new Conflict({ message: "Task changed; reload before completing it" }));
    }
    if (existing) return yield* Effect.fail(new Conflict({ message: "Task is already complete" }));
    if (!(yield* taskPrerequisiteSatisfied(context, task))) {
      return yield* Effect.fail(new Conflict({ message: task.kind === "upload" ? "Upload the requested file to complete this task" : "Complete the task prerequisite before marking it complete" }));
    }

    const now = new Date();
    const idempotencyId = nanoid();
    const requestId = crypto.randomUUID();
    const completionId = nanoid();
    const result: PortalMutationResultType = {
      eventSlug: context.event.slug,
      speakerId: context.speaker.id,
      profileVersion: context.speaker.version,
      taskId: task.id,
      taskCompletionVersion: 1,
      assetId: null,
      idempotent: false,
    };
    const after = { id: completionId, taskId: task.id, speakerId: context.speaker.id, completedAt: now.getTime(), version: 1 };
    const evidence = baseEvidence(context, "portal.task.completed", "taskCompletion", completionId, null, after, now, requestId, idempotencyId, 1);
    yield* database(() => db.batch([
      db.insert(idempotencyRecords).values({ id: idempotencyId, eventId: context.event.id, operationId: "portal.completeTask", principalId: context.principal.userId, keyHash, requestHash, status: "in_progress", expiresAt: new Date(now.getTime() + IDEMPOTENCY_TTL_MS), createdAt: now }),
      db.insert(taskCompletions).values({ id: completionId, eventId: context.event.id, taskId: task.id, speakerId: context.speaker.id, completedAt: now, data: null, version: 1, createdAt: now, updatedAt: now }),
      db.insert(domainChanges).values(evidence.change),
      db.insert(auditLog).values(evidence.audit),
      db.update(idempotencyRecords).set({ status: "completed", responseStatus: 200, responseBody: result, completedAt: now }).where(eq(idempotencyRecords.id, idempotencyId)),
    ]));
    return result;
  });

const decodeBase64 = (value: string): Effect.Effect<Uint8Array, Validation> =>
  Effect.try({
    try: () => {
      const binary = atob(value);
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
      return bytes;
    },
    catch: () => new Validation({ message: "File content is not valid base64" }),
  });

const validateUpload = (input: UploadPortalAssetInput, bytes: Uint8Array): Effect.Effect<void, Validation> => {
  const allowedTypes = input.purpose === "headshot" ? HEADSHOT_TYPES : input.purpose === "slides" ? SLIDE_TYPES : SUPPORTING_DOCUMENT_TYPES;
  if (!allowedTypes[input.contentType.toLowerCase()]) {
    return Effect.fail(new Validation({ message: `File type '${input.contentType}' is not allowed for ${input.purpose}` }));
  }
  if (bytes.byteLength === 0 || bytes.byteLength > PURPOSE_LIMITS[input.purpose]) {
    return Effect.fail(new Validation({ message: `${input.purpose} files must be between 1 byte and ${PURPOSE_LIMITS[input.purpose]} bytes` }));
  }
  if ((input.purpose === "headshot") !== (input.taskId === undefined)) {
    return Effect.fail(new Validation({ message: input.purpose === "headshot" ? "Headshots cannot be linked to an upload task" : "Slides and supporting documents require an upload task" }));
  }
  return Effect.void;
};

const safeFilename = (filename: string) => filename.trim().replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "upload";

export const uploadPortalAsset = (
  input: UploadPortalAssetInput,
): Effect.Effect<PortalMutationResultType, AppError, CurrentUser | Db | Files> =>
  Effect.gen(function* () {
    const context = yield* portalContext(input.eventSlug);
    const bytes = yield* decodeBase64(input.contentBase64);
    yield* validateUpload(input, bytes);
    const { db } = yield* Db;
    const files = yield* Files;
    let task: typeof tasks.$inferSelect | undefined;
    let existingCompletion: typeof taskCompletions.$inferSelect | undefined;
    if (input.taskId) {
      [task] = yield* database(() => db.select().from(tasks).where(and(eq(tasks.eventId, context.event.id), eq(tasks.id, input.taskId!))).limit(1));
      if (!task || task.kind !== "upload") return yield* Effect.fail(new NotFound({ entity: "upload task", id: input.taskId }));
      [existingCompletion] = yield* database(() => db.select().from(taskCompletions).where(and(
        eq(taskCompletions.eventId, context.event.id),
        eq(taskCompletions.taskId, input.taskId!),
        eq(taskCompletions.speakerId, context.speaker.id),
      )).limit(1));
    }
    const { keyHash, requestHash } = yield* commandHashes(input);
    const replay = yield* findReplay(context.event.id, "portal.uploadAsset", context.principal.userId, keyHash, requestHash);
    if (replay) return replay;
    const currentVersion = input.purpose === "headshot" ? context.speaker.version : existingCompletion?.version ?? 0;
    if (currentVersion !== input.expectedVersion) {
      return yield* Effect.fail(new Conflict({ message: "Asset changed; reload before uploading" }));
    }

    const now = new Date();
    const idempotencyId = nanoid();
    yield* database(() => db.insert(idempotencyRecords).values({
      id: idempotencyId,
      eventId: context.event.id,
      operationId: "portal.uploadAsset",
      principalId: context.principal.userId,
      keyHash,
      requestHash,
      status: "in_progress",
      expiresAt: new Date(now.getTime() + IDEMPOTENCY_TTL_MS),
      createdAt: now,
    }));
    const assetId = nanoid();
    const key = `events/${context.event.id}/portal/${context.speaker.id}/${assetId}/${safeFilename(input.filename)}`;
    const contentDisposition = input.purpose === "headshot" ? "inline" : `attachment; filename="${safeFilename(input.filename)}"`;
    yield* files.put(key, bytes, { httpMetadata: { contentType: input.contentType, contentDisposition } });

    const completionId = existingCompletion?.id ?? nanoid();
    const nextCompletionVersion = task ? (existingCompletion?.version ?? 0) + 1 : null;
    const nextProfileVersion = input.purpose === "headshot" ? context.speaker.version + 1 : context.speaker.version;
    const result: PortalMutationResultType = {
      eventSlug: context.event.slug,
      speakerId: context.speaker.id,
      profileVersion: nextProfileVersion,
      taskId: task?.id ?? null,
      taskCompletionVersion: nextCompletionVersion,
      assetId,
      idempotent: false,
    };
    const requestId = crypto.randomUUID();
    const evidence = baseEvidence(
      context,
      input.purpose === "headshot" ? "portal.headshot.replaced" : "portal.task.uploaded",
      input.purpose === "headshot" ? "speaker" : "taskCompletion",
      input.purpose === "headshot" ? context.speaker.id : completionId,
      input.purpose === "headshot" ? { headshotAssetId: context.speaker.headshotAssetId, version: context.speaker.version } : existingCompletion?.data ?? null,
      input.purpose === "headshot" ? { headshotAssetId: assetId, version: nextProfileVersion } : { assetId, purpose: input.purpose, version: nextCompletionVersion },
      now,
      requestId,
      idempotencyId,
      input.purpose === "headshot" ? nextProfileVersion : nextCompletionVersion!,
    );
    const completionStatement = task
      ? existingCompletion
        ? db.update(taskCompletions).set({ completedAt: now, data: { assetId, purpose: input.purpose }, version: nextCompletionVersion!, updatedAt: now }).where(and(eq(taskCompletions.id, existingCompletion.id), eq(taskCompletions.version, input.expectedVersion)))
        : db.insert(taskCompletions).values({ id: completionId, eventId: context.event.id, taskId: task.id, speakerId: context.speaker.id, completedAt: now, data: { assetId, purpose: input.purpose }, version: 1, createdAt: now, updatedAt: now })
      : db.update(speakers).set({ headshotAssetId: assetId, version: nextProfileVersion, updatedAt: now }).where(and(eq(speakers.id, context.speaker.id), eq(speakers.version, input.expectedVersion)));

    yield* database(() => db.batch([
      db.insert(assets).values({ id: assetId, eventId: context.event.id, uploaderUserId: context.principal.userId, filename: input.filename.trim(), contentType: input.contentType.toLowerCase(), size: bytes.byteLength, version: 1, createdAt: now, updatedAt: now }),
      completionStatement,
      db.insert(domainChanges).values(versionClaim(
        context,
        input.purpose === "headshot" ? "speaker" : "taskCompletion",
        input.purpose === "headshot" ? context.speaker.id : completionId,
        input.purpose === "headshot" ? nextProfileVersion : nextCompletionVersion!,
        requestId,
        idempotencyId,
        now,
      )),
      db.insert(domainChanges).values(evidence.change),
      db.insert(auditLog).values(evidence.audit),
      db.update(idempotencyRecords).set({ status: "completed", responseStatus: 200, responseBody: result, completedAt: now }).where(eq(idempotencyRecords.id, idempotencyId)),
    ])).pipe(
      Effect.tapError(() => files.delete(key).pipe(Effect.catchAll(() => Effect.void))),
      Effect.catchIf(isVersionClaimCollision, () => Effect.fail(new Conflict({ message: "Asset changed; reload before uploading" }))),
    );

    const oldAssetId = input.purpose === "headshot" ? context.speaker.headshotAssetId : uploadCompletionData(existingCompletion?.data)?.assetId;
    if (oldAssetId && oldAssetId !== assetId) {
      const oldKeyPrefix = `events/${context.event.id}/portal/${context.speaker.id}/${oldAssetId}/`;
      const [oldAsset] = yield* database(() => db.select().from(assets).where(and(eq(assets.eventId, context.event.id), eq(assets.id, oldAssetId))).limit(1));
      if (oldAsset) {
        yield* files.delete(`${oldKeyPrefix}${safeFilename(oldAsset.filename)}`).pipe(
          Effect.tap(() => database(() => db.delete(assets).where(and(eq(assets.eventId, context.event.id), eq(assets.id, oldAssetId))))),
          Effect.catchAll((error) => Effect.logWarning("Replaced portal asset cleanup failed", { assetId: oldAssetId, error })),
        );
      }
    }
    return result;
  });

const encodeBase64 = (buffer: ArrayBuffer): string => {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 32_768) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + 32_768, bytes.length)));
  }
  return btoa(binary);
};

export const getPortalAsset = (
  input: GetPortalAssetInput,
): Effect.Effect<typeof PortalAssetContent.Type, AppError, CurrentUser | Db | Files> =>
  Effect.gen(function* () {
    const context = yield* portalContext(input.eventSlug);
    const { db } = yield* Db;
    const [asset] = yield* database(() => db.select().from(assets).where(and(
      eq(assets.eventId, context.event.id),
      eq(assets.id, input.assetId),
      eq(assets.uploaderUserId, context.principal.userId),
    )).limit(1));
    if (!asset) return yield* Effect.fail(new NotFound({ entity: "asset", id: input.assetId }));
    const [headshot, completionRows] = yield* Effect.all([
      database(() => db.select({ id: speakers.id }).from(speakers).where(and(
        eq(speakers.id, context.speaker.id),
        eq(speakers.headshotAssetId, asset.id),
      )).limit(1)),
      database(() => db.select({ data: taskCompletions.data }).from(taskCompletions).where(and(
        eq(taskCompletions.eventId, context.event.id),
        eq(taskCompletions.speakerId, context.speaker.id),
      ))),
    ], { concurrency: 1 });
    const linkedToTask = completionRows.some(({ data }) => uploadCompletionData(data)?.assetId === asset.id);
    if (!headshot[0] && !linkedToTask) {
      return yield* Effect.fail(new Forbidden({ reason: "Asset is not linked to this speaker portal" }));
    }
    const files = yield* Files;
    const key = `events/${context.event.id}/portal/${context.speaker.id}/${asset.id}/${safeFilename(asset.filename)}`;
    const object = yield* files.get(key);
    if (!object) return yield* Effect.fail(new NotFound({ entity: "asset object", id: asset.id }));
    const contentBase64 = yield* Effect.tryPromise({
      try: async () => encodeBase64(await object.arrayBuffer()),
      catch: (error) => new External({ service: "r2", detail: error instanceof Error ? error.message : String(error) }),
    });
    return { filename: asset.filename, contentType: asset.contentType, contentBase64 };
  });
