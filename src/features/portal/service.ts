import { Conflict, External, Forbidden, NotFound, Validation, type AppError } from "contracts/errors";
import { eventAuthorization, type ApiScope } from "contracts/principal";
import {
  acceptanceEvents,
  airtableOutbox,
  airtablePendingEdits,
  airtableRecordLinks,
  assets,
  auditLog,
  domainChanges,
  events,
  idempotencyRecords,
  integrations,
  pages,
  speakerProvisioning,
  speakers,
  submissionSpeakers,
  submissions,
  taskCompletions,
  tasks,
} from "contracts/schema";
import { and, asc, desc, eq, inArray, or, sql } from "drizzle-orm";
import { Effect, Schema } from "effect";
import type { BatchItem } from "drizzle-orm/batch";
import { nanoid } from "nanoid";
import { Authorizer, CurrentUser, Db, Files, Rooms } from "@/server/services";
import {
  PortalTask as PortalTaskSchema,
  SpeakerProfile as SpeakerProfileSchema,
  UploadPortalAssetOutput as UploadPortalAssetOutputSchema,
  type CreateResourceInput,
  type CreateTaskInput,
  type DeletePortalEntityOutput,
  type DeleteResourceInput,
  type DeleteTaskInput,
  type PortalAsset,
  type PortalDashboard,
  type PortalEvent,
  type PortalProfileSyncField,
  type PortalResource,
  type PortalSnapshot,
  type PortalTask,
  type PortalTaskDefinition,
  type ProvisionSpeakerInput,
  type PublicSpeakerGallery,
  type PublicSpeakersInput,
  type ReadinessSummary,
  type SetTaskCompletionInput,
  type SpeakerDirectory,
  type SpeakerDirectoryItem,
  type SpeakerProfile,
  type UpdateProfileInput,
  type UpdateResourceInput,
  type UpdateSpeakerPublicationInput,
  type UpdateTaskInput,
  type UploadPortalAssetInput,
  type UploadPortalAssetOutput,
} from "./schema";

const database = <A>(run: () => Promise<A>): Effect.Effect<A, External> =>
  Effect.tryPromise({
    try: run,
    catch: (error) => new External({
      service: "database",
      detail: error instanceof Error ? error.message : String(error),
    }),
  });

const fileEffect = <A>(run: () => Promise<A>): Effect.Effect<A, External> =>
  Effect.tryPromise({
    try: run,
    catch: (error) => new External({
      service: "files",
      detail: error instanceof Error ? error.message : String(error),
    }),
  });

const id = (prefix: string) => `${prefix}_${nanoid()}`;
const now = () => new Date();
const millis = (value: Date | null) => value?.getTime() ?? null;
const assetKey = (eventId: string, assetId: string) => `portal/${eventId}/${assetId}`;
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1_000;
export const PORTAL_UPLOAD_MAX_BYTES = 10 * 1_024 * 1_024;
const PROFILE_SYNC_FIELDS = ["displayName", "title", "company", "bio"] as const satisfies readonly PortalProfileSyncField[];

const sha256 = (value: string): Effect.Effect<string, External> =>
  Effect.tryPromise({
    try: async () => {
      const digest = new Uint8Array(
        await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
      );
      let result = "";
      for (const byte of digest) result += byte.toString(16).padStart(2, "0");
      return result;
    },
    catch: (error) =>
      new External({
        service: "crypto",
        detail: error instanceof Error ? error.message : String(error),
      }),
  });

const commandHashes = (idempotencyKey: string, request: unknown) =>
  Effect.all({
    keyHash: sha256(idempotencyKey),
    requestHash: sha256(JSON.stringify(request)),
  });

const findReplay = (
  eventId: string,
  operationId: string,
  principalId: string,
  keyHash: string,
  requestHash: string,
) =>
  Effect.gen(function* () {
    const { db } = yield* Db;
    const [record] = yield* database(() =>
      db
        .select()
        .from(idempotencyRecords)
        .where(and(
          eq(idempotencyRecords.eventId, eventId),
          eq(idempotencyRecords.operationId, operationId),
          eq(idempotencyRecords.principalId, principalId),
          eq(idempotencyRecords.keyHash, keyHash),
        ))
        .limit(1),
    );
    if (!record) return null;
    if (record.requestHash !== requestHash) {
      return yield* Effect.fail(
        new Conflict({ message: "Idempotency key was already used for a different request" }),
      );
    }
    if (record.status !== "completed" || record.responseBody === null) {
      return yield* Effect.fail(
        new Conflict({ message: "This request is already in progress; retry shortly" }),
      );
    }
    return record.responseBody;
  });

const decodeReplay = <A, I>(
  schema: Schema.Schema<A, I, never>,
  value: unknown,
): Effect.Effect<A, External> =>
  Schema.decodeUnknown(schema)(value).pipe(
    Effect.mapError((error) =>
      new External({
        service: "database",
        detail: `Invalid idempotency response: ${String(error)}`,
      })),
  );

const idempotencyInsert = (
  eventId: string,
  operationId: string,
  principalId: string,
  keyHash: string,
  requestHash: string,
  createdAt: Date,
) => ({
  id: id("idempotency"),
  eventId,
  operationId,
  principalId,
  keyHash,
  requestHash,
  status: "in_progress" as const,
  expiresAt: new Date(createdAt.getTime() + IDEMPOTENCY_TTL_MS),
  createdAt,
});

type PrincipalActor = { readonly userId: string; readonly actorUserId: string | null; readonly actorApiKeyId: string | null };

const eventView = (event: typeof events.$inferSelect): PortalEvent => ({
  id: event.id,
  slug: event.slug,
  name: event.name,
  description: event.description,
  location: event.location,
  timezone: event.timezone,
  startsAt: millis(event.startsAt),
  endsAt: millis(event.endsAt),
  bannerAssetId: event.bannerAssetId,
  accentColor: event.accentColor,
});

const speakerView = (
  speaker: typeof speakers.$inferSelect,
  pending = new Map<PortalProfileSyncField, unknown>(),
): SpeakerProfile => ({
  id: speaker.id,
  eventId: speaker.eventId,
  displayName: typeof pending.get("displayName") === "string"
    ? pending.get("displayName") as string
    : speaker.displayName,
  title: pending.has("title") ? pending.get("title") as string | null : speaker.title,
  company: pending.has("company") ? pending.get("company") as string | null : speaker.company,
  bio: pending.has("bio") ? pending.get("bio") as string | null : speaker.bio,
  headshotAssetId: speaker.headshotAssetId,
  links: speaker.links ?? [],
  visible: speaker.visible,
  version: speaker.version,
  pendingSyncFields: PROFILE_SYNC_FIELDS.filter((field) => pending.has(field)),
});

const taskDefinitionView = (task: typeof tasks.$inferSelect): PortalTaskDefinition => ({
  id: task.id,
  eventId: task.eventId,
  name: task.name,
  description: task.description,
  kind: task.kind,
  formId: task.formId,
  dueAt: millis(task.dueAt),
  order: task.order,
  version: task.version,
});

const resourceView = (page: typeof pages.$inferSelect): PortalResource => ({
  id: page.id,
  eventId: page.eventId,
  slug: page.slug,
  title: page.title,
  body: page.body,
  embedUrl: page.htmlEmbed,
  audience: page.audience,
  order: page.order,
  version: page.version,
});

const assetView = (asset: typeof assets.$inferSelect, purpose: PortalAsset["purpose"]): PortalAsset => ({
  id: asset.id,
  eventId: asset.eventId!,
  filename: asset.filename,
  contentType: asset.contentType,
  size: asset.size,
  purpose,
  version: asset.version,
});

const organizer = (
  eventId: string,
  scope: ApiScope,
): Effect.Effect<PrincipalActor, AppError, Db | CurrentUser | Authorizer> =>
  Effect.gen(function* () {
    const principal = yield* CurrentUser;
    const { authorize } = yield* Authorizer;
    yield* authorize({
      principal,
      eventId,
      policy: eventAuthorization(
        { kind: "event-member", roles: ["owner", "admin"] },
        { kind: "api-key", scopes: [scope] },
      ),
    });
    return principal.kind === "api-key"
      ? { userId: principal.userId, actorUserId: null, actorApiKeyId: principal.apiKeyId }
      : { userId: principal.userId, actorUserId: principal.userId, actorApiKeyId: null };
  });

const selfPrincipal = (): Effect.Effect<PrincipalActor, Forbidden, CurrentUser> =>
  Effect.gen(function* () {
    const principal = yield* CurrentUser;
    if (principal.kind !== "browser-session") {
      return yield* Effect.fail(new Forbidden({ reason: "Speaker portal actions require a browser session" }));
    }
    return { userId: principal.userId, actorUserId: principal.userId, actorApiKeyId: null };
  });

const requireEvent = (eventId: string) => Effect.gen(function* () {
  const { db } = yield* Db;
  const [event] = yield* database(() => db.select().from(events).where(eq(events.id, eventId)).limit(1));
  if (!event) return yield* Effect.fail(new NotFound({ entity: "event", id: eventId }));
  return event;
});


const resolveEvent = (idOrSlug: string) => Effect.gen(function* () {
  const { db } = yield* Db;
  const [event] = yield* database(() => db.select().from(events).where(
    or(eq(events.id, idOrSlug), eq(events.slug, idOrSlug)),
  ).limit(1));
  if (!event) return yield* Effect.fail(new NotFound({ entity: "event", id: idOrSlug }));
  return event;
});
const loadCurrentProvisioning = (eventId: string, speakerId: string) => Effect.gen(function* () {
  const { db } = yield* Db;
  const [candidates, acceptanceHistory] = yield* Effect.all([
    database(() => db
      .select({
        acceptance: acceptanceEvents,
        provisioning: speakerProvisioning,
        submission: submissions,
      })
      .from(acceptanceEvents)
      .innerJoin(speakerProvisioning, and(
        eq(speakerProvisioning.eventId, acceptanceEvents.eventId),
        eq(speakerProvisioning.acceptanceEventId, acceptanceEvents.id),
        eq(speakerProvisioning.status, "provisioned"),
      ))
      .innerJoin(submissions, and(
        eq(submissions.eventId, acceptanceEvents.eventId),
        eq(submissions.id, acceptanceEvents.submissionId),
      ))
      .where(and(
        eq(acceptanceEvents.eventId, eventId),
        eq(acceptanceEvents.primarySpeakerId, speakerId),
        eq(acceptanceEvents.type, "accepted"),
      ))
      .orderBy(desc(acceptanceEvents.occurredAt), desc(acceptanceEvents.id))),
    database(() => db
      .select({
        id: acceptanceEvents.id,
        submissionId: acceptanceEvents.submissionId,
        type: acceptanceEvents.type,
      })
      .from(acceptanceEvents)
      .where(and(
        eq(acceptanceEvents.eventId, eventId),
        eq(acceptanceEvents.primarySpeakerId, speakerId),
      ))
      .orderBy(desc(acceptanceEvents.occurredAt), desc(acceptanceEvents.id))),
  ]);
  const latestBySubmission = new Map<string, (typeof acceptanceHistory)[number]>();
  for (const acceptance of acceptanceHistory) {
    if (!latestBySubmission.has(acceptance.submissionId)) {
      latestBySubmission.set(acceptance.submissionId, acceptance);
    }
  }
  const current = candidates.find((row) =>
    latestBySubmission.get(row.acceptance.submissionId)?.id === row.acceptance.id
  );
  if (!current) {
    return yield* Effect.fail(new Forbidden({ reason: "A current accepted and provisioned speaker record is required" }));
  }
  return current;
});

const selfSpeaker = (eventId: string) => Effect.gen(function* () {
  const actor = yield* selfPrincipal();
  const { db } = yield* Db;
  const [speaker] = yield* database(() => db.select().from(speakers).where(and(
    eq(speakers.eventId, eventId),
    eq(speakers.userId, actor.userId),
  )).limit(1));
  if (!speaker) return yield* Effect.fail(new Forbidden({ reason: "This browser session is not linked to a speaker for this event" }));
  const acceptance = yield* loadCurrentProvisioning(eventId, speaker.id);
  return { actor, speaker, acceptance };
});

const taskView = (
  task: typeof tasks.$inferSelect,
  completion: typeof taskCompletions.$inferSelect | undefined,
  prerequisite: PortalTask["prerequisite"],
): PortalTask => ({
  ...taskDefinitionView(task),
  completed: completion !== undefined,
  completedAt: completion ? millis(completion.completedAt) : null,
  completionData: (completion?.data as PortalTask["completionData"]) ?? null,
  completionVersion: completion?.version ?? 0,
  prerequisite: completion
    ? { satisfied: true, message: null }
    : prerequisite,
});

const readiness = (
  definitions: readonly (typeof tasks.$inferSelect)[],
  completions: readonly (typeof taskCompletions.$inferSelect)[],
): ReadinessSummary => {
  const completedTaskIds = new Set(completions.map((completion) => completion.taskId));
  const outstandingTaskIds = definitions
    .filter((task) => !completedTaskIds.has(task.id))
    .map((task) => task.id);
  const tasksTotal = definitions.length;
  const tasksDone = tasksTotal - outstandingTaskIds.length;
  return {
    tasksTotal,
    tasksDone,
    outstandingTaskIds,
    nextTaskId: outstandingTaskIds[0] ?? null,
    state: tasksTotal === 0 || tasksDone === tasksTotal ? "ready" : tasksDone === 0 ? "not_started" : "in_progress",
  };
};

const currentTasks = (eventId: string, speakerId: string) => Effect.gen(function* () {
  const { db } = yield* Db;
  const [definitions, completions, speaker, pendingBio] = yield* Effect.all([
    database(() => db.select().from(tasks).where(eq(tasks.eventId, eventId)).orderBy(asc(tasks.order), asc(tasks.id))),
    database(() => db.select().from(taskCompletions).where(and(
      eq(taskCompletions.eventId, eventId),
      eq(taskCompletions.speakerId, speakerId),
    ))),
    database(() => db.select().from(speakers).where(and(
      eq(speakers.eventId, eventId),
      eq(speakers.id, speakerId),
    )).limit(1).then((rows) => rows[0])),
    database(() => db
      .select({ intendedValue: airtablePendingEdits.intendedValue })
      .from(airtablePendingEdits)
      .where(and(
        eq(airtablePendingEdits.eventId, eventId),
        eq(airtablePendingEdits.entityType, "speaker"),
        eq(airtablePendingEdits.entityId, speakerId),
        eq(airtablePendingEdits.fieldKey, "bio"),
        eq(airtablePendingEdits.status, "pending"),
      ))
      .limit(1)
      .then((rows) => rows[0])),
  ], { concurrency: 1 });
  if (!speaker) {
    return yield* Effect.fail(
      new External({ service: "database", detail: "Speaker disappeared while loading tasks" }),
    );
  }
  const formIds = definitions.flatMap((task) => task.formId ? [task.formId] : []);
  const submittedFormIds = formIds.length === 0
    ? []
    : yield* database(() => db
      .select({ formId: submissions.formId })
      .from(submissions)
      .innerJoin(submissionSpeakers, and(
        eq(submissionSpeakers.eventId, submissions.eventId),
        eq(submissionSpeakers.submissionId, submissions.id),
      ))
      .where(and(
        eq(submissions.eventId, eventId),
        eq(submissions.status, "submitted"),
        eq(submissionSpeakers.speakerId, speakerId),
        inArray(submissions.formId, formIds),
      )));
  const completedForms = new Set(submittedFormIds.map(({ formId }) => formId));
  const byTask = new Map(completions.map((completion) => [completion.taskId, completion]));
  const prerequisites = new Map<string, PortalTask["prerequisite"]>();
  const taskViews = definitions.map((task) => {
    const profileSatisfied = Boolean(
      speaker.bio?.trim() ||
      (typeof pendingBio?.intendedValue === "string" && pendingBio.intendedValue.trim()),
    );
    const prerequisite = task.kind === "profile"
      ? {
        satisfied: profileSatisfied,
        message: profileSatisfied ? null : "Add your bio before completing this task.",
      }
      : task.kind === "link"
        ? {
          satisfied: (speaker.links?.length ?? 0) > 0,
          message: (speaker.links?.length ?? 0) > 0
            ? null
            : "Add at least one public link before completing this task.",
        }
        : task.kind === "form"
          ? {
            satisfied: task.formId !== null && completedForms.has(task.formId),
            message: task.formId !== null && completedForms.has(task.formId)
              ? null
              : "Submit the linked form before completing this task.",
          }
          : task.kind === "upload"
            ? {
              satisfied: false,
              message: "Upload the requested file to complete this task.",
            }
            : { satisfied: true, message: null };
    prerequisites.set(task.id, prerequisite);
    return taskView(task, byTask.get(task.id), prerequisite);
  });
  return {
    definitions,
    completions,
    taskViews,
    prerequisites,
    readiness: readiness(definitions, completions),
  };
});

interface PortalChange {
  readonly id: string;
  readonly eventId: string;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly aggregateVersion: number;
  readonly eventType: string;
  readonly audiences: readonly { readonly kind: "admins" }[];
  readonly payload: Record<string, unknown>;
  readonly actorUserId: string | null;
  readonly actorApiKeyId: string | null;
  readonly requestId: string;
  readonly idempotencyRecordId: string | null;
  readonly occurredAt: Date;
}

const writeChange = (
  eventId: string,
  aggregateType: string,
  aggregateId: string,
  aggregateVersion: number,
  eventType: string,
  payload: Record<string, unknown>,
  actor: PrincipalActor,
  occurredAt: Date,
  requestId = id("portal_request"),
  idempotencyRecordId: string | null = null,
): PortalChange => ({
  id: id("change"),
  eventId,
  aggregateType,
  aggregateId,
  aggregateVersion,
  eventType,
  audiences: [{ kind: "admins" }],
  payload,
  actorUserId: actor.actorUserId,
  actorApiKeyId: actor.actorApiKeyId,
  requestId,
  idempotencyRecordId,
  occurredAt,
});

const changeSelection = (change: PortalChange) => ({
  sequence: sql<number | null>`null`.as("sequence"),
  id: sql<string>`${change.id}`.as("id"),
  eventId: sql<string>`${change.eventId}`.as("event_id"),
  aggregateType: sql<string>`${change.aggregateType}`.as("aggregate_type"),
  aggregateId: sql<string>`${change.aggregateId}`.as("aggregate_id"),
  aggregateVersion: sql<number>`${change.aggregateVersion}`.as("aggregate_version"),
  eventType: sql<string>`${change.eventType}`.as("event_type"),
  audiences: sql<PortalChange["audiences"]>`${JSON.stringify(change.audiences)}`.as("audiences"),
  payload: sql<PortalChange["payload"]>`${JSON.stringify(change.payload)}`.as("payload"),
  actorUserId: sql<string | null>`${change.actorUserId}`.as("actor_user_id"),
  actorApiKeyId: sql<string | null>`${change.actorApiKeyId}`.as("actor_api_key_id"),
  requestId: sql<string>`${change.requestId}`.as("request_id"),
  idempotencyRecordId: sql<string | null>`${change.idempotencyRecordId}`.as("idempotency_record_id"),
  occurredAt: sql<Date>`${change.occurredAt.getTime()}`.as("occurred_at"),
});

const validEmbedUrl = (value: string | null): boolean => {
  if (value === null) return true;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && [
      "docs.google.com",
      "player.vimeo.com",
      "www.youtube-nocookie.com",
      "www.youtube.com",
      "youtube-nocookie.com",
      "youtube.com",
    ].includes(url.hostname);
  } catch {
    return false;
  }
};

const safeHttpUrl = (value: string): boolean => {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
};

const uploadPolicy = (
  purpose: UploadPortalAssetInput["purpose"],
  contentType: string,
  filename: string,
  size: number,
) => {
  const extension = filename.toLowerCase().split(".").pop() ?? "";
  const allowed: Readonly<Record<string, readonly string[]>> = purpose === "headshot"
    ? {
      "image/jpeg": ["jpg", "jpeg"],
      "image/png": ["png"],
      "image/webp": ["webp"],
    }
    : purpose === "slides"
      ? {
        "application/pdf": ["pdf"],
        "application/vnd.ms-powerpoint": ["ppt"],
        "application/vnd.openxmlformats-officedocument.presentationml.presentation": ["pptx"],
      }
      : {
        "application/msword": ["doc"],
        "application/pdf": ["pdf"],
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ["docx"],
      };
  const maxSize = PORTAL_UPLOAD_MAX_BYTES;
  if (!allowed[contentType as keyof typeof allowed]?.includes(extension) || size === 0 || size > maxSize) {
    return new Validation({ message: `Invalid ${purpose} file type, extension, or size` });
  }
  return null;
};

const decodeBase64 = (value: string): Effect.Effect<Uint8Array, Validation> => Effect.try({
  try: () => {
    if (value.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
      throw new Error("invalid base64");
    }
    const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
    const decodedSize = value.length / 4 * 3 - padding;
    if (decodedSize === 0 || decodedSize > PORTAL_UPLOAD_MAX_BYTES) {
      throw new Error("decoded asset exceeds transport limit");
    }
    const decoded = atob(value);
    const bytes = new Uint8Array(decoded.length);
    for (let index = 0; index < decoded.length; index += 1) {
      bytes[index] = decoded.charCodeAt(index);
    }
    return bytes;
  },
  catch: (error) =>
    new Validation({
      message: error instanceof Error && error.message === "decoded asset exceeds transport limit"
        ? "Asset must be between 1 byte and 10 MiB with the current upload transport"
        : "Asset content is not valid base64",
    }),
});

export const getSpeakerDirectory = (input: { readonly eventId: string }): Effect.Effect<SpeakerDirectory, AppError, Db | CurrentUser | Authorizer> => Effect.gen(function* () {
  yield* organizer(input.eventId, "speakers:read");
  const { db } = yield* Db;
  const event = yield* requireEvent(input.eventId);
  const rows = yield* database(() => db
    .select({ acceptance: acceptanceEvents, provisioning: speakerProvisioning, speaker: speakers, submission: submissions })
    .from(acceptanceEvents)
    .innerJoin(speakerProvisioning, and(eq(speakerProvisioning.eventId, acceptanceEvents.eventId), eq(speakerProvisioning.acceptanceEventId, acceptanceEvents.id)))
    .innerJoin(speakers, and(eq(speakers.eventId, acceptanceEvents.eventId), eq(speakers.id, acceptanceEvents.primarySpeakerId)))
    .leftJoin(submissions, and(eq(submissions.eventId, acceptanceEvents.eventId), eq(submissions.id, acceptanceEvents.submissionId)))
    .where(and(eq(acceptanceEvents.eventId, input.eventId), eq(acceptanceEvents.type, "accepted")))
    .orderBy(asc(speakers.displayName), desc(acceptanceEvents.occurredAt), desc(acceptanceEvents.id)));
  const acceptanceHistory = yield* database(() => db
    .select({
      id: acceptanceEvents.id,
      submissionId: acceptanceEvents.submissionId,
      type: acceptanceEvents.type,
    })
    .from(acceptanceEvents)
    .where(eq(acceptanceEvents.eventId, input.eventId))
    .orderBy(desc(acceptanceEvents.occurredAt), desc(acceptanceEvents.id)));
  const latestBySubmission = new Map<string, (typeof acceptanceHistory)[number]>();
  for (const acceptance of acceptanceHistory) {
    if (!latestBySubmission.has(acceptance.submissionId)) {
      latestBySubmission.set(acceptance.submissionId, acceptance);
    }
  }
  const currentBySpeaker = new Map<string, (typeof rows)[number]>();
  for (const row of rows) {
    const latest = latestBySubmission.get(row.acceptance.submissionId);
    if (latest?.type === "accepted" && latest.id === row.acceptance.id && !currentBySpeaker.has(row.speaker.id)) {
      currentBySpeaker.set(row.speaker.id, row);
    }
  }
  const currentRows = [...currentBySpeaker.values()];
  const speakerIds = [...new Set(currentRows.map((row) => row.speaker.id))];
  const [definitions, completions] = yield* Effect.all([
    database(() => db.select().from(tasks).where(eq(tasks.eventId, input.eventId)).orderBy(asc(tasks.order), asc(tasks.id))),
    speakerIds.length === 0 ? Effect.succeed([] as readonly (typeof taskCompletions.$inferSelect)[]) : database(() => db.select().from(taskCompletions).where(and(eq(taskCompletions.eventId, input.eventId), inArray(taskCompletions.speakerId, speakerIds)))),
  ]);
  const bySpeaker = new Map<string, (typeof taskCompletions.$inferSelect)[]>();
  for (const completion of completions) bySpeaker.set(completion.speakerId, [...(bySpeaker.get(completion.speakerId) ?? []), completion]);
  return {
    event: eventView(event),
    speakers: currentRows.map((row): SpeakerDirectoryItem => ({
      speaker: speakerView(row.speaker),
      submission: row.submission ? { id: row.submission.id, title: row.submission.title, category: row.submission.category, version: row.submission.version } : null,
      acceptanceEventId: row.acceptance.id,
      provisioningId: row.provisioning.id,
      provisioningVersion: row.provisioning.version,
      provisioningStatus: row.provisioning.status,
      provisionedAt: millis(row.provisioning.provisionedAt),
      readiness: readiness(definitions, bySpeaker.get(row.speaker.id) ?? []),
    })),
  };
});

export const getPortalDashboard = (input: { readonly eventId: string }): Effect.Effect<PortalDashboard, AppError, Db | CurrentUser | Authorizer> => Effect.gen(function* () {
  const directory = yield* getSpeakerDirectory(input);
  const totals = directory.speakers.reduce((total, item) => ({
    speakers: total.speakers + 1,
    ready: total.ready + (item.readiness.state === "ready" ? 1 : 0),
    tasksDone: total.tasksDone + item.readiness.tasksDone,
    tasksTotal: total.tasksTotal + item.readiness.tasksTotal,
  }), { speakers: 0, ready: 0, tasksDone: 0, tasksTotal: 0 });
  return { event: directory.event, speakers: directory.speakers, totals };
});

export const getPortalSnapshot = (input: { readonly eventId: string }): Effect.Effect<PortalSnapshot, AppError, Db | CurrentUser | Files> => Effect.gen(function* () {
  const event = yield* resolveEvent(input.eventId);
  const { speaker, acceptance, actor } = yield* selfSpeaker(event.id);
  const { db } = yield* Db;
  const progress = yield* currentTasks(event.id, speaker.id);
  const [resources, uploaded, pendingRows] = yield* Effect.all([
    database(() => db.select().from(pages).where(and(eq(pages.eventId, event.id), inArray(pages.audience, ["speakers", "public"]))).orderBy(asc(pages.order), asc(pages.id))),
    database(() => db.select().from(assets).where(and(eq(assets.eventId, event.id), eq(assets.uploaderUserId, actor.userId))).orderBy(desc(assets.createdAt))),
    database(() => db
      .select({
        fieldKey: airtablePendingEdits.fieldKey,
        intendedValue: airtablePendingEdits.intendedValue,
      })
      .from(airtablePendingEdits)
      .where(and(
        eq(airtablePendingEdits.eventId, event.id),
        eq(airtablePendingEdits.entityType, "speaker"),
        eq(airtablePendingEdits.entityId, speaker.id),
        eq(airtablePendingEdits.status, "pending"),
      ))),
  ], { concurrency: 1 });
  const { head } = yield* Files;
  const uploadedAssets = yield* Effect.forEach(uploaded, (asset) => Effect.gen(function* () {
    if (asset.id === speaker.headshotAssetId) return assetView(asset, "headshot");
    const object = yield* head(assetKey(event.id, asset.id));
    const storedPurpose = object?.customMetadata?.portalPurpose;
    const purpose = storedPurpose === "headshot" || storedPurpose === "slides" || storedPurpose === "document"
      ? storedPurpose
      : asset.contentType.includes("presentation")
        ? "slides"
        : "document";
    return assetView(asset, purpose);
  }));
  const pending = new Map(
    pendingRows.flatMap(({ fieldKey, intendedValue }) =>
      PROFILE_SYNC_FIELDS.includes(fieldKey as PortalProfileSyncField)
        ? [[fieldKey as PortalProfileSyncField, intendedValue] as const]
        : []),
  );
  return {
    event: eventView(event),
    speaker: speakerView(speaker, pending),
    submission: { id: acceptance.submission.id, title: acceptance.submission.title, category: acceptance.submission.category, version: acceptance.submission.version },
    provisioningStatus: "provisioned",
    tasks: progress.taskViews,
    resources: resources.map(resourceView),
    assets: uploadedAssets,
    readiness: progress.readiness,
  };
});

export const updateSpeakerProfile = (input: UpdateProfileInput): Effect.Effect<SpeakerProfile, AppError, Db | CurrentUser> => Effect.gen(function* () {
  const event = yield* resolveEvent(input.eventId);
  const { speaker, actor } = yield* selfSpeaker(event.id);
  const { db } = yield* Db;
  const { keyHash, requestHash } = yield* commandHashes(input.idempotencyKey, input);
  const replay = yield* findReplay(
    event.id,
    "portal.updateProfile",
    actor.userId,
    keyHash,
    requestHash,
  );
  if (replay !== null) return yield* decodeReplay(SpeakerProfileSchema, replay);
  if (speaker.version !== input.expectedVersion) {
    return yield* Effect.fail(
      new Conflict({ message: "Speaker profile changed; reload before saving" }),
    );
  }

  const [airtableIntegration] = yield* database(() =>
    db
      .select({ id: integrations.id })
      .from(integrations)
      .where(and(
        eq(integrations.eventId, event.id),
        eq(integrations.kind, "airtable"),
      ))
      .limit(1),
  );
  const changedSyncFields = PROFILE_SYNC_FIELDS.filter(
    (field) => input[field] !== speaker[field],
  );
  const pending = new Map<PortalProfileSyncField, unknown>();
  const syncStatements: BatchItem<"sqlite">[] = [];
  if (airtableIntegration) {
    const existingPending = yield* database(() =>
      db
        .select({
          fieldKey: airtablePendingEdits.fieldKey,
          intendedValue: airtablePendingEdits.intendedValue,
        })
        .from(airtablePendingEdits)
        .where(and(
          eq(airtablePendingEdits.eventId, event.id),
          eq(airtablePendingEdits.integrationId, airtableIntegration.id),
          eq(airtablePendingEdits.entityType, "speaker"),
          eq(airtablePendingEdits.entityId, speaker.id),
          eq(airtablePendingEdits.status, "pending"),
        )),
    );
    for (const row of existingPending) {
      if (PROFILE_SYNC_FIELDS.includes(row.fieldKey as PortalProfileSyncField)) {
        pending.set(row.fieldKey as PortalProfileSyncField, row.intendedValue);
      }
    }
    if (changedSyncFields.some((field) => pending.has(field))) {
      return yield* Effect.fail(
        new Conflict({ message: "Profile changes are already pending organizer sync" }),
      );
    }

    const [[recordLink], [latestOutbox]] = yield* Effect.all([
      database(() => db
        .select({
          outboundRevision: airtableRecordLinks.outboundRevision,
          inboundRevision: airtableRecordLinks.inboundRevision,
          inboundHash: airtableRecordLinks.inboundHash,
        })
        .from(airtableRecordLinks)
        .where(and(
          eq(airtableRecordLinks.eventId, event.id),
          eq(airtableRecordLinks.integrationId, airtableIntegration.id),
          eq(airtableRecordLinks.entityType, "speaker"),
          eq(airtableRecordLinks.entityId, speaker.id),
        ))
        .limit(1)),
      database(() => db
        .select({ outboundRevision: airtableOutbox.outboundRevision })
        .from(airtableOutbox)
        .where(and(
          eq(airtableOutbox.eventId, event.id),
          eq(airtableOutbox.integrationId, airtableIntegration.id),
          eq(airtableOutbox.entityType, "speaker"),
          eq(airtableOutbox.entityId, speaker.id),
        ))
        .orderBy(desc(airtableOutbox.outboundRevision))
        .limit(1)),
    ], { concurrency: 1 });
    let outboundRevision = Math.max(
      recordLink?.outboundRevision ?? 0,
      latestOutbox?.outboundRevision ?? 0,
    );
    const createdAt = now();
    for (const field of changedSyncFields) {
      outboundRevision += 1;
      const pendingEditId = id("airtable_pending");
      const changedFields: Record<string, unknown> = { [field]: input[field] };
      const outboundHash = yield* sha256(JSON.stringify(changedFields));
      pending.set(field, input[field]);
      syncStatements.push(
        db.insert(airtablePendingEdits).values({
          id: pendingEditId,
          eventId: event.id,
          integrationId: airtableIntegration.id,
          entityType: "speaker",
          entityId: speaker.id,
          speakerId: speaker.id,
          submissionId: null,
          talkId: null,
          fieldKey: field,
          intendedValue: input[field],
          baseInboundRevision: recordLink?.inboundRevision ?? null,
          baseInboundHash: recordLink?.inboundHash ?? null,
          status: "pending",
          version: 1,
          createdAt,
          updatedAt: createdAt,
        }),
        db.insert(airtableOutbox).values({
          id: id("airtable_outbox"),
          eventId: event.id,
          integrationId: airtableIntegration.id,
          pendingEditId,
          entityType: "speaker",
          entityId: speaker.id,
          speakerId: speaker.id,
          submissionId: null,
          talkId: null,
          sessionPartyId: speaker.id,
          operation: "upsert",
          changedFields,
          outboundRevision,
          outboundHash,
          origin: "speaker-portal",
          idempotencyKey: `${input.idempotencyKey}:${field}`,
          status: "pending",
          availableAt: createdAt,
          attemptCount: 0,
          createdAt,
        }),
      );
    }
  }

  const updatedAt = now();
  const version = input.expectedVersion + 1;
  const idempotency = idempotencyInsert(
    event.id,
    "portal.updateProfile",
    actor.userId,
    keyHash,
    requestHash,
    updatedAt,
  );
  const requestId = id("portal_request");
  const result = speakerView({
    ...speaker,
    ...(airtableIntegration
      ? { links: input.links }
      : {
        displayName: input.displayName,
        title: input.title,
        company: input.company,
        bio: input.bio,
        links: input.links,
      }),
    version,
    updatedAt,
  }, pending);
  const guard = and(
    eq(speakers.eventId, event.id),
    eq(speakers.id, speaker.id),
    eq(speakers.version, input.expectedVersion),
  );
  const statements: [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]] = [
    db.insert(idempotencyRecords).values(idempotency),
    ...syncStatements,
    db.insert(domainChanges).values(writeChange(
      event.id,
      "speaker",
      speaker.id,
      version,
      "speaker.versionClaim",
      { version },
      actor,
      updatedAt,
      requestId,
      idempotency.id,
    )),
    db.insert(domainChanges).select(
      db
        .select(changeSelection(writeChange(
          event.id,
          "speaker",
          speaker.id,
          version,
          "portal.profile.updated",
          { speakerId: speaker.id, pendingSyncFields: result.pendingSyncFields },
          actor,
          updatedAt,
          requestId,
          idempotency.id,
        )))
        .from(speakers)
        .where(guard),
    ),
    db.insert(auditLog).values({
      id: id("audit"),
      eventId: event.id,
      requestId,
      actorUserId: actor.actorUserId,
      actorApiKeyId: actor.actorApiKeyId,
      action: "portal.profile.updated",
      resourceType: "speaker",
      resourceId: speaker.id,
      before: speakerView(speaker),
      after: result,
      metadata: null,
      occurredAt: updatedAt,
    }),
    db.update(speakers)
      .set(airtableIntegration
        ? { links: input.links, version, updatedAt }
        : {
          displayName: input.displayName,
          title: input.title,
          company: input.company,
          bio: input.bio,
          links: input.links,
          version,
          updatedAt,
        })
      .where(guard),
    db.update(idempotencyRecords)
      .set({
        status: "completed",
        responseStatus: 200,
        responseBody: result,
        completedAt: updatedAt,
      })
      .where(eq(idempotencyRecords.id, idempotency.id)),
  ];
  yield* database(() => db.batch(statements)).pipe(
    Effect.catchIf(
      (error) =>
        error.detail?.includes("domain_changes_aggregate_version_unique") === true ||
        error.detail?.includes("UNIQUE constraint failed: domain_changes.event_id") === true,
      () =>
        Effect.fail(
          new Conflict({ message: "Speaker profile changed; reload before saving" }),
        ),
    ),
  );
  return result;
});

export const setTaskCompletion = (input: SetTaskCompletionInput): Effect.Effect<PortalTask, AppError, Db | CurrentUser | Rooms> => Effect.gen(function* () {
  const event = yield* resolveEvent(input.eventId);
  const { speaker, actor } = yield* selfSpeaker(event.id);
  const { db } = yield* Db;
  const [task] = yield* database(() =>
    db
      .select()
      .from(tasks)
      .where(and(eq(tasks.eventId, event.id), eq(tasks.id, input.taskId)))
      .limit(1),
  );
  if (!task) return yield* Effect.fail(new NotFound({ entity: "task", id: input.taskId }));
  if (task.kind === "upload" && input.completed) {
    return yield* Effect.fail(
      new Validation({ message: "Upload tasks complete only after a validated asset upload" }),
    );
  }
  const { keyHash, requestHash } = yield* commandHashes(input.idempotencyKey, input);
  const replay = yield* findReplay(
    event.id,
    "portal.setTaskCompletion",
    actor.userId,
    keyHash,
    requestHash,
  );
  if (replay !== null) return yield* decodeReplay(PortalTaskSchema, replay);

  const before = yield* currentTasks(event.id, speaker.id);
  const prerequisite = before.prerequisites.get(task.id) ?? {
    satisfied: false,
    message: "Task prerequisite is unavailable.",
  };
  if (input.completed && !prerequisite.satisfied) {
    return yield* Effect.fail(
      new Conflict({
        message: prerequisite.message ?? "Complete the task prerequisite first",
      }),
    );
  }
  const existing = before.completions.find((completion) => completion.taskId === task.id);
  const aggregateId = `${task.id}:${speaker.id}`;
  const [lastChange] = yield* database(() => db
    .select({ aggregateVersion: domainChanges.aggregateVersion })
    .from(domainChanges)
    .where(and(
      eq(domainChanges.eventId, event.id),
      eq(domainChanges.aggregateType, "taskCompletion"),
      eq(domainChanges.aggregateId, aggregateId),
      eq(domainChanges.eventType, "portal.task.completion.changed"),
    ))
    .orderBy(desc(domainChanges.aggregateVersion))
    .limit(1));
  const completedAt = now();
  const completionVersion = (lastChange?.aggregateVersion ?? 0) + 1;
  const completionId = existing?.id ?? id("task_completion");
  const completion = input.completed
    ? {
      id: completionId,
      eventId: event.id,
      taskId: task.id,
      speakerId: speaker.id,
      completedAt,
      data: input.data ?? null,
      version: completionVersion,
      createdAt: existing?.createdAt ?? completedAt,
      updatedAt: completedAt,
    }
    : undefined;
  const result = taskView(task, completion, prerequisite);
  const idempotency = idempotencyInsert(
    event.id,
    "portal.setTaskCompletion",
    actor.userId,
    keyHash,
    requestHash,
    completedAt,
  );
  const requestId = id("portal_request");
  const command = input.completed
    ? db
      .insert(taskCompletions)
      .values(completion!)
      .onConflictDoUpdate({
        target: [
          taskCompletions.eventId,
          taskCompletions.taskId,
          taskCompletions.speakerId,
        ],
        set: {
          completedAt,
          data: input.data ?? null,
          version: completionVersion,
          updatedAt: completedAt,
        },
      })
    : db
      .delete(taskCompletions)
      .where(and(
        eq(taskCompletions.eventId, event.id),
        eq(taskCompletions.taskId, task.id),
        eq(taskCompletions.speakerId, speaker.id),
      ));
  yield* database(() => db.batch([
    db.insert(idempotencyRecords).values(idempotency),
    command,
    db.insert(domainChanges).values(writeChange(
      event.id,
      "taskCompletion",
      aggregateId,
      completionVersion,
      "taskCompletion.versionClaim",
      { version: completionVersion },
      actor,
      completedAt,
      requestId,
      idempotency.id,
    )),
    db.insert(domainChanges).values(writeChange(
      event.id,
      "taskCompletion",
      aggregateId,
      completionVersion,
      "portal.task.completion.changed",
      { speakerId: speaker.id, taskId: task.id, completed: input.completed },
      actor,
      completedAt,
      requestId,
      idempotency.id,
    )),
    db.insert(auditLog).values({
      id: id("audit"),
      eventId: event.id,
      requestId,
      actorUserId: actor.actorUserId,
      actorApiKeyId: actor.actorApiKeyId,
      action: "portal.task.completion.changed",
      resourceType: "taskCompletion",
      resourceId: aggregateId,
      before: existing ?? null,
      after: completion ?? null,
      metadata: null,
      occurredAt: completedAt,
    }),
    db.update(idempotencyRecords)
      .set({
        status: "completed",
        responseStatus: 200,
        responseBody: result,
        completedAt,
      })
      .where(eq(idempotencyRecords.id, idempotency.id)),
  ]));
  const progress = yield* currentTasks(event.id, speaker.id);
  const { broadcast } = yield* Rooms;
  yield* broadcast(event.id, {
    t: "dashboard/progress",
    speakerId: speaker.id,
    taskId: task.id,
    completed: input.completed,
    tasksDone: progress.readiness.tasksDone,
    tasksTotal: progress.readiness.tasksTotal,
  }).pipe(Effect.catchAll(() => Effect.void));
  return result;
});

export const uploadPortalAsset = (input: UploadPortalAssetInput): Effect.Effect<UploadPortalAssetOutput, AppError, Db | CurrentUser | Files | Rooms> => Effect.gen(function* () {
  const event = yield* resolveEvent(input.eventId);
  const { speaker, actor } = yield* selfSpeaker(event.id);
  const data = yield* decodeBase64(input.contentBase64);
  const policyError = uploadPolicy(
    input.purpose,
    input.contentType,
    input.filename,
    data.byteLength,
  );
  if (policyError) return yield* Effect.fail(policyError);

  const { db } = yield* Db;
  let task: typeof tasks.$inferSelect | undefined;
  if (input.taskId) {
    const [found] = yield* database(() =>
      db
        .select()
        .from(tasks)
        .where(and(eq(tasks.eventId, event.id), eq(tasks.id, input.taskId!)))
        .limit(1),
    );
    if (!found) return yield* Effect.fail(new NotFound({ entity: "task", id: input.taskId }));
    if (found.kind !== "upload") {
      return yield* Effect.fail(
        new Validation({ message: "Asset uploads can complete only upload tasks" }),
      );
    }
    task = found;
  }
  const before = yield* currentTasks(event.id, speaker.id);
  const existingCompletion = task
    ? before.completions.find((completion) => completion.taskId === task!.id)
    : undefined;
  const currentVersion = input.purpose === "headshot"
    ? speaker.version
    : existingCompletion?.version ?? 0;

  const contentHash = yield* sha256(input.contentBase64);
  const { keyHash, requestHash } = yield* commandHashes(input.idempotencyKey, {
    ...input,
    contentBase64: contentHash,
  });
  const replay = yield* findReplay(
    event.id,
    "portal.uploadAsset",
    actor.userId,
    keyHash,
    requestHash,
  );
  if (replay !== null) return yield* decodeReplay(UploadPortalAssetOutputSchema, replay);
  if (currentVersion !== input.expectedVersion) {
    return yield* Effect.fail(
      new Conflict({ message: "Asset changed; reload before uploading" }),
    );
  }

  const uploadedAt = now();
  const idempotency = idempotencyInsert(
    event.id,
    "portal.uploadAsset",
    actor.userId,
    keyHash,
    requestHash,
    uploadedAt,
  );
  const reservation = yield* database(() =>
    db.insert(idempotencyRecords).values(idempotency),
  ).pipe(Effect.either);
  if (reservation._tag === "Left") {
    if (
      reservation.left.detail?.includes("idempotency_key_unique") === true ||
      reservation.left.detail?.includes("UNIQUE constraint failed: idempotency_records") === true
    ) {
      const racedReplay = yield* findReplay(
        event.id,
        "portal.uploadAsset",
        actor.userId,
        keyHash,
        requestHash,
      );
      if (racedReplay !== null) {
        return yield* decodeReplay(UploadPortalAssetOutputSchema, racedReplay);
      }
      return yield* Effect.fail(
        new Conflict({ message: "This upload is already in progress; retry shortly" }),
      );
    }
    return yield* Effect.fail(reservation.left);
  }

  const assetId = id("portal_asset");
  const key = assetKey(event.id, assetId);
  const filename = input.filename.trim();
  const dispositionFilename = filename.replace(/["\\\r\n]/g, "_");
  const { delete: deleteFile, put } = yield* Files;
  yield* put(key, data, {
    httpMetadata: {
      contentType: input.contentType,
      contentDisposition: input.purpose === "headshot"
        ? "inline"
        : `attachment; filename="${dispositionFilename}"`,
    },
    customMetadata: { portalPurpose: input.purpose, speakerId: speaker.id },
  }).pipe(
    Effect.catchAll((error) =>
      database(() =>
        db.delete(idempotencyRecords).where(eq(idempotencyRecords.id, idempotency.id)),
      ).pipe(
        Effect.catchAll(() => Effect.void),
        Effect.flatMap(() => Effect.fail(error)),
      )),
  );

  const completionAggregateId = task ? `${task.id}:${speaker.id}` : null;
  const [lastCompletionChange] = completionAggregateId
    ? yield* database(() => db
      .select({ aggregateVersion: domainChanges.aggregateVersion })
      .from(domainChanges)
      .where(and(
        eq(domainChanges.eventId, event.id),
        eq(domainChanges.aggregateType, "taskCompletion"),
        eq(domainChanges.aggregateId, completionAggregateId),
        eq(domainChanges.eventType, "portal.task.completion.changed"),
      ))
      .orderBy(desc(domainChanges.aggregateVersion))
      .limit(1))
    : [undefined];
  const completionVersion = (lastCompletionChange?.aggregateVersion ?? 0) + 1;
  const nextSpeakerVersion = input.purpose === "headshot"
    ? speaker.version + 1
    : speaker.version;
  const assetRecord = {
    id: assetId,
    eventId: event.id,
    uploaderUserId: actor.userId,
    filename,
    contentType: input.contentType,
    size: data.byteLength,
    version: 1,
    createdAt: uploadedAt,
    updatedAt: uploadedAt,
  };
  const completion = task
    ? {
      id: existingCompletion?.id ?? id("task_completion"),
      eventId: event.id,
      taskId: task.id,
      speakerId: speaker.id,
      completedAt: uploadedAt,
      data: { assetId, purpose: input.purpose },
      version: completionVersion,
      createdAt: existingCompletion?.createdAt ?? uploadedAt,
      updatedAt: uploadedAt,
    }
    : undefined;
  const taskResult = task && completion
    ? taskView(
      task,
      completion,
      before.prerequisites.get(task.id) ?? {
        satisfied: false,
        message: "Upload the requested file to complete this task.",
      },
    )
    : null;
  const outstandingTaskIds = before.definitions
    .filter((definition) =>
      definition.id !== task?.id &&
      !before.completions.some((candidate) => candidate.taskId === definition.id))
    .map((definition) => definition.id);
  const tasksTotal = before.definitions.length;
  const tasksDone = tasksTotal - outstandingTaskIds.length;
  const result: UploadPortalAssetOutput = {
    asset: assetView(assetRecord, input.purpose),
    task: taskResult,
    speaker: speakerView(input.purpose === "headshot"
      ? {
        ...speaker,
        headshotAssetId: assetId,
        version: nextSpeakerVersion,
        updatedAt: uploadedAt,
      }
      : speaker),
    readiness: {
      tasksTotal,
      tasksDone,
      outstandingTaskIds,
      nextTaskId: outstandingTaskIds[0] ?? null,
      state: tasksTotal === 0 || tasksDone === tasksTotal
        ? "ready"
        : tasksDone === 0
          ? "not_started"
          : "in_progress",
    },
  };

  const requestId = id("portal_request");
  const statements: [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]] = [
    db.insert(assets).values(assetRecord),
  ];
  if (input.purpose === "headshot") {
    statements.push(
      db.update(speakers)
        .set({
          headshotAssetId: assetId,
          version: nextSpeakerVersion,
          updatedAt: uploadedAt,
        })
        .where(and(
          eq(speakers.eventId, event.id),
          eq(speakers.id, speaker.id),
          eq(speakers.version, input.expectedVersion),
        )),
      db.insert(domainChanges).values(writeChange(
        event.id,
        "speaker",
        speaker.id,
        nextSpeakerVersion,
        "speaker.versionClaim",
        { version: nextSpeakerVersion },
        actor,
        uploadedAt,
        requestId,
        idempotency.id,
      )),
      db.insert(domainChanges).values(writeChange(
        event.id,
        "speaker",
        speaker.id,
        nextSpeakerVersion,
        "portal.headshot.replaced",
        { speakerId: speaker.id, assetId },
        actor,
        uploadedAt,
        requestId,
        idempotency.id,
      )),
    );
  }
  if (task && completion && completionAggregateId) {
    statements.push(
      db.insert(taskCompletions)
        .values(completion)
        .onConflictDoUpdate({
          target: [
            taskCompletions.eventId,
            taskCompletions.taskId,
            taskCompletions.speakerId,
          ],
          set: {
            completedAt: uploadedAt,
            data: completion.data,
            version: completionVersion,
            updatedAt: uploadedAt,
          },
        }),
      db.insert(domainChanges).values(writeChange(
        event.id,
        "taskCompletion",
        completionAggregateId,
        completionVersion,
        "taskCompletion.versionClaim",
        { version: completionVersion },
        actor,
        uploadedAt,
        requestId,
        idempotency.id,
      )),
      db.insert(domainChanges).values(writeChange(
        event.id,
        "taskCompletion",
        completionAggregateId,
        completionVersion,
        "portal.task.completion.changed",
        { speakerId: speaker.id, taskId: task.id, completed: true, assetId },
        actor,
        uploadedAt,
        requestId,
        idempotency.id,
      )),
    );
  }
  statements.push(
    db.insert(domainChanges).values(writeChange(
      event.id,
      "asset",
      assetId,
      1,
      "portal.asset.uploaded",
      { speakerId: speaker.id, taskId: task?.id ?? null, purpose: input.purpose },
      actor,
      uploadedAt,
      requestId,
      idempotency.id,
    )),
    db.insert(auditLog).values({
      id: id("audit"),
      eventId: event.id,
      requestId,
      actorUserId: actor.actorUserId,
      actorApiKeyId: actor.actorApiKeyId,
      action: "portal.asset.uploaded",
      resourceType: "asset",
      resourceId: assetId,
      before: null,
      after: result,
      metadata: null,
      occurredAt: uploadedAt,
    }),
    db.update(idempotencyRecords)
      .set({
        status: "completed",
        responseStatus: 201,
        responseBody: result,
        completedAt: uploadedAt,
      })
      .where(eq(idempotencyRecords.id, idempotency.id)),
  );
  yield* database(() => db.batch(statements)).pipe(
    Effect.catchAll((error) =>
      Effect.all([
        deleteFile(key).pipe(Effect.catchAll(() => Effect.void)),
        database(() =>
          db.delete(idempotencyRecords).where(eq(idempotencyRecords.id, idempotency.id)),
        ).pipe(Effect.catchAll(() => Effect.void)),
      ], { concurrency: 1 }).pipe(
        Effect.flatMap(() => Effect.fail(error)),
      )),
  );

  const completionData = existingCompletion?.data;
  const oldTaskAssetId = typeof completionData === "object" &&
      completionData !== null &&
      !Array.isArray(completionData) &&
      typeof Reflect.get(completionData, "assetId") === "string"
    ? Reflect.get(completionData, "assetId") as string
    : null;
  const oldAssetId = input.purpose === "headshot"
    ? speaker.headshotAssetId
    : oldTaskAssetId;
  if (oldAssetId && oldAssetId !== assetId) {
    const [[currentSpeaker], completionReferences] = yield* Effect.all([
      database(() => db
        .select({ headshotAssetId: speakers.headshotAssetId })
        .from(speakers)
        .where(and(eq(speakers.eventId, event.id), eq(speakers.id, speaker.id)))
        .limit(1)),
      database(() => db
        .select({ data: taskCompletions.data })
        .from(taskCompletions)
        .where(and(
          eq(taskCompletions.eventId, event.id),
          eq(taskCompletions.speakerId, speaker.id),
        ))),
    ], { concurrency: 1 });
    const referencedByCompletion = completionReferences.some(({ data: value }) =>
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value) &&
      Reflect.get(value, "assetId") === oldAssetId);
    if (currentSpeaker?.headshotAssetId !== oldAssetId && !referencedByCompletion) {
      yield* deleteFile(assetKey(event.id, oldAssetId)).pipe(
        Effect.tap(() =>
          database(() =>
            db.delete(assets).where(and(
              eq(assets.eventId, event.id),
              eq(assets.id, oldAssetId),
            )),
          )),
        Effect.catchAll((error) =>
          Effect.logWarning("Replaced portal asset cleanup failed", {
            assetId: oldAssetId,
            error,
          })),
      );
    }
  }
  if (taskResult) {
    const { broadcast } = yield* Rooms;
    yield* broadcast(event.id, {
      t: "dashboard/progress",
      speakerId: speaker.id,
      taskId: taskResult.id,
      completed: true,
      tasksDone: result.readiness.tasksDone,
      tasksTotal: result.readiness.tasksTotal,
    }).pipe(Effect.catchAll(() => Effect.void));
  }
  return result;
});

export const listPortalTasks = (input: { readonly eventId: string }): Effect.Effect<readonly PortalTaskDefinition[], AppError, Db | CurrentUser | Authorizer> => Effect.gen(function* () {
  yield* organizer(input.eventId, "speakers:read");
  const { db } = yield* Db;
  const rows = yield* database(() => db.select().from(tasks).where(eq(tasks.eventId, input.eventId)).orderBy(asc(tasks.order), asc(tasks.id)));
  return rows.map(taskDefinitionView);
});

export const listPortalResources = (input: { readonly eventId: string }): Effect.Effect<readonly PortalResource[], AppError, Db | CurrentUser | Authorizer> => Effect.gen(function* () {
  yield* organizer(input.eventId, "content:read");
  const { db } = yield* Db;
  const rows = yield* database(() => db.select().from(pages).where(eq(pages.eventId, input.eventId)).orderBy(asc(pages.order), asc(pages.id)));
  return rows.map(resourceView);
});

export const createPortalTask = (input: CreateTaskInput): Effect.Effect<PortalTaskDefinition, AppError, Db | CurrentUser | Authorizer> => Effect.gen(function* () {
  const actor = yield* organizer(input.eventId, "speakers:write");
  if ((input.kind === "form") !== (input.formId !== null)) return yield* Effect.fail(new Validation({ message: "Form tasks require a formId and other task types must not include one" }));
  yield* requireEvent(input.eventId);
  const { db } = yield* Db;
  const createdAt = now();
  const task = { id: id("task"), eventId: input.eventId, name: input.name, description: input.description, kind: input.kind, formId: input.formId, dueAt: input.dueAt === null ? null : new Date(input.dueAt), order: input.order, version: 1, createdAt, updatedAt: createdAt } as const;
  yield* database(() => db.batch([db.insert(tasks).values(task), db.insert(domainChanges).values(writeChange(input.eventId, "task", task.id, 1, "portal.task.created", { taskId: task.id }, actor, createdAt))]));
  return taskDefinitionView(task);
});

export const updatePortalTask = (input: UpdateTaskInput): Effect.Effect<PortalTaskDefinition, AppError, Db | CurrentUser | Authorizer> => Effect.gen(function* () {
  const actor = yield* organizer(input.eventId, "speakers:write");
  if ((input.kind === "form") !== (input.formId !== null)) {
    return yield* Effect.fail(
      new Validation({ message: "Form tasks require a formId and other task types must not include one" }),
    );
  }
  const { db } = yield* Db;
  const updatedAt = now();
  const version = input.expectedVersion + 1;
  const guard = and(
    eq(tasks.eventId, input.eventId),
    eq(tasks.id, input.taskId),
    eq(tasks.version, input.expectedVersion),
  );
  const change = writeChange(
    input.eventId,
    "task",
    input.taskId,
    version,
    "portal.task.updated",
    { taskId: input.taskId },
    actor,
    updatedAt,
  );
  const [, updatedRows] = yield* database(() => db.batch([
    db.insert(domainChanges).select(
      db.select(changeSelection(change)).from(tasks).where(guard),
    ),
    db.update(tasks)
      .set({
        name: input.name,
        description: input.description,
        kind: input.kind,
        formId: input.formId,
        dueAt: input.dueAt === null ? null : new Date(input.dueAt),
        order: input.order,
        version,
        updatedAt,
      })
      .where(guard)
      .returning(),
  ]));
  const updated = updatedRows[0];
  if (!updated) {
    return yield* Effect.fail(new Conflict({ message: "Task changed; reload before saving" }));
  }
  return taskDefinitionView(updated);
});

export const deletePortalTask = (input: DeleteTaskInput): Effect.Effect<DeletePortalEntityOutput, AppError, Db | CurrentUser | Authorizer> => Effect.gen(function* () {
  const actor = yield* organizer(input.eventId, "speakers:write");
  const { db } = yield* Db;
  const deletedAt = now();
  const guard = and(
    eq(tasks.eventId, input.eventId),
    eq(tasks.id, input.taskId),
    eq(tasks.version, input.expectedVersion),
  );
  const change = writeChange(
    input.eventId,
    "task",
    input.taskId,
    input.expectedVersion,
    "portal.task.deleted",
    { taskId: input.taskId },
    actor,
    deletedAt,
  );
  const [, deletedRows] = yield* database(() => db.batch([
    db.insert(domainChanges).select(
      db.select(changeSelection(change)).from(tasks).where(guard),
    ),
    db.delete(tasks)
      .where(guard)
      .returning({ id: tasks.id }),
  ]));
  const deleted = deletedRows[0];
  if (!deleted) {
    return yield* Effect.fail(new Conflict({ message: "Task changed; reload before deleting" }));
  }
  return { id: deleted.id };
});

const validateResource = (input: Pick<CreateResourceInput, "embedUrl">) => validEmbedUrl(input.embedUrl)
  ? Effect.void
  : Effect.fail(new Validation({ message: "Embed URL must use an allowlisted HTTPS provider" }));

export const createPortalResource = (input: CreateResourceInput): Effect.Effect<PortalResource, AppError, Db | CurrentUser | Authorizer> => Effect.gen(function* () {
  const actor = yield* organizer(input.eventId, "content:write");
  yield* validateResource(input);
  yield* requireEvent(input.eventId);
  const { db } = yield* Db;
  const createdAt = now();
  const page = { id: id("page"), eventId: input.eventId, slug: input.slug, title: input.title, body: input.body, htmlEmbed: input.embedUrl, audience: input.audience, order: input.order, version: 1, createdAt, updatedAt: createdAt } as const;
  yield* database(() => db.batch([db.insert(pages).values(page), db.insert(domainChanges).values(writeChange(input.eventId, "page", page.id, 1, "portal.resource.created", { pageId: page.id }, actor, createdAt))]));
  return resourceView(page);
});

export const updatePortalResource = (input: UpdateResourceInput): Effect.Effect<PortalResource, AppError, Db | CurrentUser | Authorizer> => Effect.gen(function* () {
  const actor = yield* organizer(input.eventId, "content:write");
  yield* validateResource(input);
  const { db } = yield* Db;
  const updatedAt = now();
  const version = input.expectedVersion + 1;
  const guard = and(
    eq(pages.eventId, input.eventId),
    eq(pages.id, input.resourceId),
    eq(pages.version, input.expectedVersion),
  );
  const change = writeChange(
    input.eventId,
    "page",
    input.resourceId,
    version,
    "portal.resource.updated",
    { pageId: input.resourceId },
    actor,
    updatedAt,
  );
  const [, updatedRows] = yield* database(() => db.batch([
    db.insert(domainChanges).select(
      db.select(changeSelection(change)).from(pages).where(guard),
    ),
    db.update(pages)
      .set({
        slug: input.slug,
        title: input.title,
        body: input.body,
        htmlEmbed: input.embedUrl,
        audience: input.audience,
        order: input.order,
        version,
        updatedAt,
      })
      .where(guard)
      .returning(),
  ]));
  const updated = updatedRows[0];
  if (!updated) {
    return yield* Effect.fail(
      new Conflict({ message: "Resource changed; reload before saving" }),
    );
  }
  return resourceView(updated);
});

export const deletePortalResource = (input: DeleteResourceInput): Effect.Effect<DeletePortalEntityOutput, AppError, Db | CurrentUser | Authorizer> => Effect.gen(function* () {
  const actor = yield* organizer(input.eventId, "content:write");
  const { db } = yield* Db;
  const deletedAt = now();
  const guard = and(
    eq(pages.eventId, input.eventId),
    eq(pages.id, input.resourceId),
    eq(pages.version, input.expectedVersion),
  );
  const change = writeChange(
    input.eventId,
    "page",
    input.resourceId,
    input.expectedVersion,
    "portal.resource.deleted",
    { pageId: input.resourceId },
    actor,
    deletedAt,
  );
  const [, deletedRows] = yield* database(() => db.batch([
    db.insert(domainChanges).select(
      db.select(changeSelection(change)).from(pages).where(guard),
    ),
    db.delete(pages)
      .where(guard)
      .returning({ id: pages.id }),
  ]));
  const deleted = deletedRows[0];
  if (!deleted) {
    return yield* Effect.fail(
      new Conflict({ message: "Resource changed; reload before deleting" }),
    );
  }
  return { id: deleted.id };
});

export const provisionSpeaker = (input: ProvisionSpeakerInput): Effect.Effect<SpeakerDirectoryItem, AppError, Db | CurrentUser | Authorizer> => Effect.gen(function* () {
  const actor = yield* organizer(input.eventId, "speakers:write");
  const { db } = yield* Db;
  const [row] = yield* database(() => db
    .select({
      acceptance: acceptanceEvents,
      provisioning: speakerProvisioning,
      speaker: speakers,
      submission: submissions,
    })
    .from(acceptanceEvents)
    .innerJoin(
      speakerProvisioning,
      and(
        eq(speakerProvisioning.eventId, acceptanceEvents.eventId),
        eq(speakerProvisioning.acceptanceEventId, acceptanceEvents.id),
      ),
    )
    .innerJoin(
      speakers,
      and(
        eq(speakers.eventId, acceptanceEvents.eventId),
        eq(speakers.id, acceptanceEvents.primarySpeakerId),
      ),
    )
    .leftJoin(
      submissions,
      and(
        eq(submissions.eventId, acceptanceEvents.eventId),
        eq(submissions.id, acceptanceEvents.submissionId),
      ),
    )
    .where(and(
      eq(acceptanceEvents.eventId, input.eventId),
      eq(acceptanceEvents.primarySpeakerId, input.speakerId),
      eq(speakerProvisioning.id, input.provisioningId),
    ))
    .limit(1));
  if (!row) return yield* Effect.fail(new NotFound({ entity: "accepted speaker provisioning", id: input.provisioningId }));
  const [latestAcceptance] = yield* database(() => db
    .select({ id: acceptanceEvents.id, type: acceptanceEvents.type })
    .from(acceptanceEvents)
    .where(and(
      eq(acceptanceEvents.eventId, input.eventId),
      eq(acceptanceEvents.submissionId, row.acceptance.submissionId),
    ))
    .orderBy(desc(acceptanceEvents.occurredAt), desc(acceptanceEvents.id))
    .limit(1));
  if (!latestAcceptance || latestAcceptance.type !== "accepted" || latestAcceptance.id !== row.acceptance.id) {
    return yield* Effect.fail(new NotFound({ entity: "currently accepted speaker", id: input.speakerId }));
  }
  if (row.speaker.userId === null) return yield* Effect.fail(new Validation({ message: "Speaker must be linked to a user before provisioning" }));
  if (row.provisioning.version !== input.expectedVersion) return yield* Effect.fail(new Conflict({ message: "Provisioning changed; reload before transitioning" }));
  if (row.provisioning.status === "provisioned") return yield* Effect.fail(new Conflict({ message: "Speaker is already provisioned" }));
  if (["revoked", "failed"].includes(row.provisioning.status)) return yield* Effect.fail(new Conflict({ message: "This provisioning record cannot transition to provisioned" }));
  const provisionedAt = now();
  const version = input.expectedVersion + 1;
  const guard = and(
    eq(speakerProvisioning.eventId, input.eventId),
    eq(speakerProvisioning.id, row.provisioning.id),
    eq(speakerProvisioning.version, input.expectedVersion),
  );
  const change = writeChange(
    input.eventId,
    "speakerProvisioning",
    row.provisioning.id,
    version,
    "portal.speaker.provisioned",
    { speakerId: row.speaker.id },
    actor,
    provisionedAt,
  );
  const [, updatedRows] = yield* database(() => db.batch([
    db.insert(domainChanges).select(
      db.select(changeSelection(change)).from(speakerProvisioning).where(guard),
    ),
    db.update(speakerProvisioning)
      .set({
        status: "provisioned",
        provisionedAt,
        leaseOwner: null,
        leaseExpiresAt: null,
        version,
        updatedAt: provisionedAt,
      })
      .where(guard)
      .returning(),
  ]));
  if (!updatedRows[0]) {
    return yield* Effect.fail(
      new Conflict({ message: "Provisioning changed; reload before transitioning" }),
    );
  }
  const progress = yield* currentTasks(input.eventId, row.speaker.id);
  return {
    speaker: speakerView(row.speaker),
    submission: row.submission ? {
      id: row.submission.id,
      title: row.submission.title,
      category: row.submission.category,
      version: row.submission.version,
    } : null,
    acceptanceEventId: row.acceptance.id,
    provisioningId: row.provisioning.id,
    provisioningVersion: version,
    provisioningStatus: "provisioned",
    provisionedAt: provisionedAt.getTime(),
    readiness: progress.readiness,
  };
});

export const updateSpeakerPublication = (input: UpdateSpeakerPublicationInput): Effect.Effect<SpeakerProfile, AppError, Db | CurrentUser | Authorizer> => Effect.gen(function* () {
  const actor = yield* organizer(input.eventId, "speakers:write");
  const { db } = yield* Db;
  const updatedAt = now();
  const version = input.expectedVersion + 1;
  const guard = and(
    eq(speakers.eventId, input.eventId),
    eq(speakers.id, input.speakerId),
    eq(speakers.version, input.expectedVersion),
  );
  const change = writeChange(
    input.eventId,
    "speaker",
    input.speakerId,
    version,
    "portal.speaker.publication.updated",
    { speakerId: input.speakerId, visible: input.visible },
    actor,
    updatedAt,
  );
  const versionClaim = writeChange(
    input.eventId,
    "speaker",
    input.speakerId,
    version,
    "speaker.versionClaim",
    { version },
    actor,
    updatedAt,
  );
  const [, , updatedRows] = yield* database(() => db.batch([
    db.insert(domainChanges).select(
      db.select(changeSelection(versionClaim)).from(speakers).where(guard),
    ),
    db.insert(domainChanges).select(
      db.select(changeSelection(change)).from(speakers).where(guard),
    ),
    db.update(speakers)
      .set({ visible: input.visible, version, updatedAt })
      .where(guard)
      .returning(),
  ]));
  const updated = updatedRows[0];
  if (!updated) {
    return yield* Effect.fail(
      new Conflict({ message: "Speaker changed; reload before changing publication" }),
    );
  }
  return speakerView(updated);
});

export const getPublicSpeakers = (input: PublicSpeakersInput): Effect.Effect<PublicSpeakerGallery, AppError, Db | Files> => Effect.gen(function* () {
  const { db } = yield* Db;
  const [event] = yield* database(() => db.select().from(events).where(eq(events.slug, input.eventSlug)).limit(1));
  if (!event) return yield* Effect.fail(new NotFound({ entity: "event", id: input.eventSlug }));
  const [rows, acceptanceRows] = yield* Effect.all([
    database(() => db.select({ speaker: speakers, asset: assets, acceptance: acceptanceEvents }).from(speakers).innerJoin(acceptanceEvents, and(eq(acceptanceEvents.eventId, speakers.eventId), eq(acceptanceEvents.primarySpeakerId, speakers.id), eq(acceptanceEvents.type, "accepted"))).innerJoin(speakerProvisioning, and(eq(speakerProvisioning.eventId, acceptanceEvents.eventId), eq(speakerProvisioning.acceptanceEventId, acceptanceEvents.id), eq(speakerProvisioning.status, "provisioned"))).leftJoin(assets, and(eq(assets.eventId, speakers.eventId), eq(assets.id, speakers.headshotAssetId))).where(and(eq(speakers.eventId, event.id), eq(speakers.visible, true))).orderBy(asc(speakers.displayName), asc(speakers.id))),
    database(() => db.select({ id: acceptanceEvents.id, submissionId: acceptanceEvents.submissionId, type: acceptanceEvents.type }).from(acceptanceEvents).where(eq(acceptanceEvents.eventId, event.id)).orderBy(desc(acceptanceEvents.occurredAt), desc(acceptanceEvents.id))),
  ]);
  const latestBySubmission = new Map<string, (typeof acceptanceRows)[number]>();
  for (const acceptance of acceptanceRows) {
    if (!latestBySubmission.has(acceptance.submissionId)) {
      latestBySubmission.set(acceptance.submissionId, acceptance);
    }
  }
  const { get } = yield* Files;
  const publicSpeakers = yield* Effect.forEach(rows.filter((row) =>
    latestBySubmission.get(row.acceptance.submissionId)?.id === row.acceptance.id
  ), (row) => Effect.gen(function* () {
    let headshotUrl: string | null = null;
    if (row.asset && ["image/jpeg", "image/png", "image/webp"].includes(row.asset.contentType)) {
      const object = yield* get(assetKey(event.id, row.asset.id));
      if (object) {
        const bytes = new Uint8Array(yield* fileEffect(() => object.arrayBuffer()));
        let binary = "";
        for (let offset = 0; offset < bytes.length; offset += 32_768) {
          binary += String.fromCharCode(...bytes.subarray(offset, offset + 32_768));
        }
        headshotUrl = `data:${row.asset.contentType};base64,${btoa(binary)}`;
      }
    }
    return { id: row.speaker.id, displayName: row.speaker.displayName, title: row.speaker.title, company: row.speaker.company, bio: row.speaker.bio, headshotUrl, links: (row.speaker.links ?? []).filter((link) => safeHttpUrl(link.url)) };
  }));
  const unique = new Map(publicSpeakers.map((speaker) => [speaker.id, speaker]));
  return { event: eventView(event), speakers: [...unique.values()] };
});
