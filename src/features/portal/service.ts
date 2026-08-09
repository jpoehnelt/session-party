import { Conflict, External, Forbidden, NotFound, Validation, type AppError } from "contracts/errors";
import { eventAuthorization, type ApiScope } from "contracts/principal";
import {
  acceptanceEvents,
  assets,
  domainChanges,
  events,
  pages,
  speakerProvisioning,
  speakers,
  submissions,
  taskCompletions,
  tasks,
} from "contracts/schema";
import { and, asc, desc, eq, inArray, or, sql } from "drizzle-orm";
import { Effect } from "effect";
import { nanoid } from "nanoid";
import { Authorizer, CurrentUser, Db, Files, Rooms } from "@/server/services";
import type {
  CreateResourceInput,
  CreateTaskInput,
  DeletePortalEntityOutput,
  DeleteResourceInput,
  DeleteTaskInput,
  PortalAsset,
  PortalDashboard,
  PortalEvent,
  PortalResource,
  PortalSnapshot,
  PortalTask,
  PortalTaskDefinition,
  ProvisionSpeakerInput,
  PublicSpeakerGallery,
  PublicSpeakersInput,
  ReadinessSummary,
  SetTaskCompletionInput,
  SpeakerDirectory,
  SpeakerDirectoryItem,
  SpeakerProfile,
  UpdateProfileInput,
  UpdateResourceInput,
  UpdateSpeakerPublicationInput,
  UpdateTaskInput,
  UploadPortalAssetInput,
  UploadPortalAssetOutput,
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

const speakerView = (speaker: typeof speakers.$inferSelect): SpeakerProfile => ({
  id: speaker.id,
  eventId: speaker.eventId,
  displayName: speaker.displayName,
  title: speaker.title,
  company: speaker.company,
  bio: speaker.bio,
  headshotAssetId: speaker.headshotAssetId,
  links: speaker.links ?? [],
  visible: speaker.visible,
  version: speaker.version,
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
): PortalTask => ({
  ...taskDefinitionView(task),
  completed: completion !== undefined,
  completedAt: completion ? millis(completion.completedAt) : null,
  completionData: (completion?.data as PortalTask["completionData"]) ?? null,
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
  const [definitions, completions] = yield* Effect.all([
    database(() => db.select().from(tasks).where(eq(tasks.eventId, eventId)).orderBy(asc(tasks.order), asc(tasks.id))),
    database(() => db.select().from(taskCompletions).where(and(
      eq(taskCompletions.eventId, eventId),
      eq(taskCompletions.speakerId, speakerId),
    ))),
  ]);
  const byTask = new Map(completions.map((completion) => [completion.taskId, completion]));
  return {
    definitions,
    completions,
    taskViews: definitions.map((task) => taskView(task, byTask.get(task.id))),
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
  requestId: id("portal_request"),
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
  idempotencyRecordId: sql<string | null>`null`.as("idempotency_record_id"),
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
  const maxSize = purpose === "slides"
    ? 100 * 1024 * 1024
    : purpose === "document"
      ? 25 * 1024 * 1024
      : 10 * 1024 * 1024;
  if (!allowed[contentType as keyof typeof allowed]?.includes(extension) || size === 0 || size > maxSize) {
    return new Validation({ message: `Invalid ${purpose} file type, extension, or size` });
  }
  return null;
};

const decodeBase64 = (value: string): Effect.Effect<Uint8Array, Validation> => Effect.try({
  try: () => {
    if (value.length % 4 !== 0) throw new Error("invalid base64 length");
    const decoded = atob(value);
    return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
  },
  catch: () => new Validation({ message: "Asset content is not valid base64" }),
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
  const [resources, uploaded] = yield* Effect.all([
    database(() => db.select().from(pages).where(and(eq(pages.eventId, event.id), inArray(pages.audience, ["speakers", "public"]))).orderBy(asc(pages.order), asc(pages.id))),
    database(() => db.select().from(assets).where(and(eq(assets.eventId, event.id), eq(assets.uploaderUserId, actor.userId))).orderBy(desc(assets.createdAt))),
  ]);
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
  return {
    event: eventView(event),
    speaker: speakerView(speaker),
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
  const updatedAt = now();
  const version = input.expectedVersion + 1;
  const guard = and(
    eq(speakers.eventId, event.id),
    eq(speakers.id, speaker.id),
    eq(speakers.version, input.expectedVersion),
  );
  const change = writeChange(
    event.id,
    "speaker",
    speaker.id,
    version,
    "portal.profile.updated",
    { speakerId: speaker.id },
    actor,
    updatedAt,
  );
  const [, updatedRows] = yield* database(() => db.batch([
    db.insert(domainChanges).select(
      db.select(changeSelection(change)).from(speakers).where(guard),
    ),
    db.update(speakers)
      .set({
        displayName: input.displayName,
        title: input.title,
        company: input.company,
        bio: input.bio,
        links: input.links,
        version,
        updatedAt,
      })
      .where(guard)
      .returning(),
  ]));
  const updated = updatedRows[0];
  if (!updated) {
    return yield* Effect.fail(
      new Conflict({ message: "Speaker profile changed; reload before saving" }),
    );
  }
  return speakerView(updated);
});

export const setTaskCompletion = (input: SetTaskCompletionInput): Effect.Effect<PortalTask, AppError, Db | CurrentUser | Rooms> => Effect.gen(function* () {
  const event = yield* resolveEvent(input.eventId);
  const { speaker, actor } = yield* selfSpeaker(event.id);
  const { db } = yield* Db;
  const [task] = yield* database(() => db.select().from(tasks).where(and(eq(tasks.eventId, event.id), eq(tasks.id, input.taskId))).limit(1));
  if (!task) return yield* Effect.fail(new NotFound({ entity: "task", id: input.taskId }));
  if (task.kind === "upload" && input.completed) {
    return yield* Effect.fail(
      new Validation({ message: "Upload tasks complete only after a validated asset upload" }),
    );
  }
  const [existing] = yield* database(() => db.select().from(taskCompletions).where(and(eq(taskCompletions.eventId, event.id), eq(taskCompletions.taskId, input.taskId), eq(taskCompletions.speakerId, speaker.id))).limit(1));
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
  const command = input.completed
    ? db.insert(taskCompletions).values({ id: existing?.id ?? id("task_completion"), eventId: event.id, taskId: task.id, speakerId: speaker.id, completedAt, data: input.data ?? null, version: completionVersion, createdAt: existing?.createdAt ?? completedAt, updatedAt: completedAt }).onConflictDoUpdate({ target: [taskCompletions.eventId, taskCompletions.taskId, taskCompletions.speakerId], set: { completedAt, data: input.data ?? null, version: completionVersion, updatedAt: completedAt } })
    : db.delete(taskCompletions).where(and(eq(taskCompletions.eventId, event.id), eq(taskCompletions.taskId, task.id), eq(taskCompletions.speakerId, speaker.id)));
  yield* database(() => db.batch([
    command,
    db.insert(domainChanges).values(writeChange(event.id, "taskCompletion", aggregateId, completionVersion, "portal.task.completion.changed", { speakerId: speaker.id, taskId: task.id, completed: input.completed }, actor, completedAt)),
  ]));
  const progress = yield* currentTasks(event.id, speaker.id);
  const result = progress.taskViews.find((candidate) => candidate.id === task.id);
  if (!result) return yield* Effect.fail(new External({ service: "database", detail: "Task disappeared after completion write" }));
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
  const policyError = uploadPolicy(input.purpose, input.contentType, input.filename, data.byteLength);
  if (policyError) return yield* Effect.fail(policyError);
  const { db } = yield* Db;
  let task: typeof tasks.$inferSelect | undefined;
  if (input.taskId) {
    const [found] = yield* database(() => db.select().from(tasks).where(and(eq(tasks.eventId, event.id), eq(tasks.id, input.taskId!))).limit(1));
    if (!found) return yield* Effect.fail(new NotFound({ entity: "task", id: input.taskId }));
    if (found.kind !== "upload") {
      return yield* Effect.fail(
        new Validation({ message: "Asset uploads can complete only upload tasks" }),
      );
    }
    task = found;
  }
  const uploadedAt = now();
  const assetId = id("portal_asset");
  const { delete: deleteFile, put } = yield* Files;
  const key = assetKey(event.id, assetId);
  yield* put(key, data, {
    httpMetadata: { contentType: input.contentType },
    customMetadata: { portalPurpose: input.purpose, speakerId: speaker.id },
  });
  const [existingCompletion] = task
    ? yield* database(() => db.select().from(taskCompletions).where(and(eq(taskCompletions.eventId, event.id), eq(taskCompletions.taskId, task!.id), eq(taskCompletions.speakerId, speaker.id))).limit(1))
    : [undefined];
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
  const assetInsert = db.insert(assets).values({ id: assetId, eventId: event.id, uploaderUserId: actor.userId, filename: input.filename, contentType: input.contentType, size: data.byteLength, version: 1, createdAt: uploadedAt, updatedAt: uploadedAt });
  const speakerUpdate = db
    .update(speakers)
    .set({
      headshotAssetId: assetId,
      version: sql`${speakers.version} + 1`,
      updatedAt: uploadedAt,
    })
    .where(and(eq(speakers.eventId, event.id), eq(speakers.id, speaker.id)));
  const completionWrite = task
    ? db.insert(taskCompletions).values({ id: existingCompletion?.id ?? id("task_completion"), eventId: event.id, taskId: task.id, speakerId: speaker.id, completedAt: uploadedAt, data: { assetId, purpose: input.purpose }, version: completionVersion, createdAt: existingCompletion?.createdAt ?? uploadedAt, updatedAt: uploadedAt }).onConflictDoUpdate({ target: [taskCompletions.eventId, taskCompletions.taskId, taskCompletions.speakerId], set: { completedAt: uploadedAt, data: { assetId, purpose: input.purpose }, version: completionVersion, updatedAt: uploadedAt } })
    : undefined;
  const completionChangeInsert = task && completionAggregateId
    ? db.insert(domainChanges).values(writeChange(event.id, "taskCompletion", completionAggregateId, completionVersion, "portal.task.completion.changed", { speakerId: speaker.id, taskId: task.id, completed: true, assetId }, actor, uploadedAt))
    : undefined;
  const changeInsert = db.insert(domainChanges).values(writeChange(event.id, "asset", assetId, 1, "portal.asset.uploaded", { speakerId: speaker.id, taskId: task?.id ?? null, purpose: input.purpose }, actor, uploadedAt));
  const persist = (run: () => Promise<unknown>) =>
    database(run).pipe(Effect.tapError(() => deleteFile(key)));
  if (input.purpose === "headshot" && completionWrite && completionChangeInsert) {
    yield* persist(() => db.batch([assetInsert, speakerUpdate, completionWrite, completionChangeInsert, changeInsert]));
  } else if (input.purpose === "headshot") {
    yield* persist(() => db.batch([assetInsert, speakerUpdate, changeInsert]));
  } else if (completionWrite && completionChangeInsert) {
    yield* persist(() => db.batch([assetInsert, completionWrite, completionChangeInsert, changeInsert]));
  } else {
    yield* persist(() => db.batch([assetInsert, changeInsert]));
  }
  const progress = yield* currentTasks(event.id, speaker.id);
  const taskResult = task ? progress.taskViews.find((candidate) => candidate.id === task!.id) ?? null : null;
  const [persistedSpeaker] = input.purpose === "headshot"
    ? yield* database(() => db.select().from(speakers).where(and(
      eq(speakers.eventId, event.id),
      eq(speakers.id, speaker.id),
    )).limit(1))
    : [speaker];
  if (!persistedSpeaker) {
    return yield* Effect.fail(
      new External({ service: "database", detail: "Speaker disappeared after asset upload" }),
    );
  }
  const outputSpeaker = speakerView(persistedSpeaker);
  if (taskResult) {
    const { broadcast } = yield* Rooms;
    yield* broadcast(event.id, {
      t: "dashboard/progress",
      speakerId: speaker.id,
      taskId: taskResult.id,
      completed: true,
      tasksDone: progress.readiness.tasksDone,
      tasksTotal: progress.readiness.tasksTotal,
    }).pipe(Effect.catchAll(() => Effect.void));
  }
  return { asset: assetView({ id: assetId, eventId: event.id, uploaderUserId: actor.userId, filename: input.filename, contentType: input.contentType, size: data.byteLength, version: 1, createdAt: uploadedAt, updatedAt: uploadedAt }, input.purpose), task: taskResult, speaker: outputSpeaker, readiness: progress.readiness };
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
  const [, updatedRows] = yield* database(() => db.batch([
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
