import { Conflict, External, Forbidden, NotFound, Validation, type AppError } from "contracts/errors";
import { eventAuthorization, type ApiScope } from "contracts/principal";
import { clientRoutes } from "contracts/routes";
import {
  acceptanceEvents,
  assetComments,
  airtableOutbox,
  airtablePendingEdits,
  airtableRecordLinks,
  assets,
  auditLog,
  domainChanges,
  events,
  forms,
  formVersionFields,
  idempotencyRecords,
  integrations,
  managedSpeakerEmails,
  mailDeliveries,
  mailDeliverySnapshots,
  pages,
  speakerProvisioning,
  speakerProfiles,
  speakerContacts,
  speakers,
  submissionAnswers,
  submissionSpeakers,
  submissions,
  talkSpeakers,
  talks,
  taskAssignments,
  taskCompletions,
  tasks,
  users,
} from "contracts/schema";
import { and, asc, desc, eq, inArray, isNotNull, isNull, lte, ne, or, sql } from "drizzle-orm";
import { Effect, Schema } from "effect";
import type { BatchItem } from "drizzle-orm/batch";
import { nanoid } from "nanoid";
import { AirtableSync, Authorizer, CurrentUser, Db, Files, MailQueue, Rooms } from "@/server/services";
import { prepareAirtableProjection } from "@/server/sync/airtable-outbox";
import {
  PortalTask as PortalTaskSchema,
  SpeakerContact as SpeakerContactSchema,
  SpeakerProfile as SpeakerProfileSchema,
  UploadPortalAssetOutput as UploadPortalAssetOutputSchema,
  type CreateResourceInput,
  type CreateManagedSpeakerInput,
  type CreateTaskInput,
  ClaimSpeakerOutput as ClaimSpeakerOutputSchema,
  type ClaimSpeakerInput,
  type ClaimSpeakerOutput,
  type DeletePortalEntityOutput,
  type DeleteResourceInput,
  type DeleteTaskInput,
  type PortalAsset,
  ContentAsset as ContentAssetSchema,
  type ContentAsset,
  type ContentLibrary,
  ContentComment as ContentCommentSchema,
  type ContentComment,
  type AddContentCommentInput,
  type RestoreContentVersionInput,
  type DownloadContentInput,
  type DownloadContentOutput,
  type ImportSpeakersCsvInput,
  type ImportReusableProfileInput,
  ImportSpeakersCsvOutput as ImportSpeakersCsvOutputSchema,
  type ImportSpeakersCsvOutput,
  type PortalDashboard,
  type PortalEvent,
  type PortalProfileSyncField,
  type PortalResource,
  type PortalSnapshot,
  type PortalTask,
  type PortalTaskDefinition,
  type ProvisionSpeakerInput,
  PublishedSpeakerGallerySnapshot as PublishedSpeakerGallerySnapshotSchema,
  type PublicSpeakerGallery,
  type PublicSpeakersInput,
  type ReadinessSummary,
  type ReviewSpeakerProfileInput,
  type LogSpeakerContactInput,
  type SpeakerContact,
  type SetTaskCompletionInput,
  type SpeakerDirectory,
  type SpeakerDirectoryItem,
  SpeakerPrivateFieldValue as SpeakerPrivateFieldValueSchema,
  type SpeakerProfile,
  type SubmitProfileReviewInput,
  type UpdateProfileInput,
  type UpdateManagedSpeakerInput,
  type UpdateResourceInput,
  type UpdateSpeakerPublicationInput,
  type UpdateTaskInput,
  type UploadPortalAssetInput,
  type UploadPortalAssetOutput,
  type UploadManagedSpeakerHeadshotInput,
  inferUploadTaskPurpose,
  type SendSpeakerMessagesInput,
  SendSpeakerMessagesOutput as SendSpeakerMessagesOutputSchema,
  type SendSpeakerMessagesOutput,
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
export const PORTAL_UPLOAD_MAX_BYTES = {
  headshot: 10 * 1_024 * 1_024,
  slides: 100 * 1_024 * 1_024,
  document: 25 * 1_024 * 1_024,
} as const;
const PROFILE_SYNC_FIELDS = ["displayName", "title", "company", "bio"] as const satisfies readonly PortalProfileSyncField[];
const normalizedEmail = (value: string): string => value.trim().toLowerCase();

const escapeHtml = (value: string): string => value
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;")
  .replaceAll("'", "&#39;");

const encodeBase64 = (bytes: Uint8Array): string => {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 32_768) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 32_768));
  }
  return btoa(binary);
};

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
  contactEmail: speaker.contactEmail,
  displayName: typeof pending.get("displayName") === "string"
    ? pending.get("displayName") as string
    : speaker.displayName,
  title: pending.has("title") ? pending.get("title") as string | null : speaker.title,
  company: pending.has("company") ? pending.get("company") as string | null : speaker.company,
  bio: pending.has("bio") ? pending.get("bio") as string | null : speaker.bio,
  workflowStatus: speaker.workflowStatus,
  headshotAssetId: speaker.headshotAssetId,
  headshotUrl: speaker.headshotUrl,
  links: speaker.links ?? [],
  visible: speaker.visible,
  profileSourceId: speaker.profileSourceId,
  profileSourceVersion: speaker.profileSourceVersion,
  profileReviewStatus: speaker.profileReviewStatus,
  profileReviewNote: speaker.profileReviewNote,
  profileSubmittedAt: millis(speaker.profileSubmittedAt),
  profileReviewedAt: millis(speaker.profileReviewedAt),
  version: speaker.version,
  pendingSyncFields: PROFILE_SYNC_FIELDS.filter((field) => pending.has(field)),
});

export const eligiblePublicSpeakerIds = (
  eventIds: readonly string[],
): Effect.Effect<ReadonlySet<string>, External, Db> => Effect.gen(function* () {
  if (eventIds.length === 0) return new Set<string>();
  const { db } = yield* Db;
  const [acceptances, provisioning, managed] = yield* Effect.all([
    database(() => db.select({
      id: acceptanceEvents.id,
      eventId: acceptanceEvents.eventId,
      submissionId: acceptanceEvents.submissionId,
      type: acceptanceEvents.type,
      primarySpeakerId: acceptanceEvents.primarySpeakerId,
    }).from(acceptanceEvents).where(inArray(acceptanceEvents.eventId, eventIds))
      .orderBy(desc(acceptanceEvents.occurredAt), desc(acceptanceEvents.id))),
    database(() => db.select({
      acceptanceEventId: speakerProvisioning.acceptanceEventId,
      status: speakerProvisioning.status,
    }).from(speakerProvisioning).where(inArray(speakerProvisioning.eventId, eventIds))),
    database(() => db.select({ speakerId: managedSpeakerEmails.speakerId })
      .from(managedSpeakerEmails)
      .where(inArray(managedSpeakerEmails.eventId, eventIds))),
  ]);
  const latestBySubmission = new Map<string, (typeof acceptances)[number]>();
  for (const acceptance of acceptances) {
    const key = `${acceptance.eventId}\u0000${acceptance.submissionId}`;
    if (!latestBySubmission.has(key)) latestBySubmission.set(key, acceptance);
  }
  const provisioned = new Set(provisioning
    .filter((row) => row.status === "provisioned")
    .map((row) => row.acceptanceEventId));
  return new Set([
    ...managed.map((row) => row.speakerId),
    ...[...latestBySubmission.values()].flatMap((acceptance) =>
    acceptance.type === "accepted" && acceptance.primarySpeakerId && provisioned.has(acceptance.id)
      ? [acceptance.primarySpeakerId]
      : []
    ),
  ]);
});

const taskDefinitionView = (
  task: typeof tasks.$inferSelect,
  speakerIds: readonly string[] = [],
): PortalTaskDefinition => ({
  id: task.id,
  eventId: task.eventId,
  name: task.name,
  description: task.description,
  kind: task.kind,
  formId: task.formId,
  dueAt: millis(task.dueAt),
  order: task.order,
  targetMode: task.targetMode,
  speakerIds,
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
  purpose: asset.purpose ?? purpose,
  version: asset.version,
});

const contactView = (contact: typeof speakerContacts.$inferSelect): SpeakerContact => ({
  id: contact.id,
  medium: contact.medium,
  note: contact.note,
  contactedAt: contact.contactedAt.getTime(),
});

const withContactEscalation = (summary: ReadinessSummary, latestContact: SpeakerContact | null): ReadinessSummary => {
  const missing = summary.missingItems[0];
  if (!missing) return summary;
  const action = latestContact === null
    ? `Send a tool email about ${missing.name}`
    : latestContact.medium === "toolEmail"
      ? `Send a personal email about ${missing.name}`
      : latestContact.medium === "personalEmail"
        ? `Send a text about ${missing.name}`
        : latestContact.medium === "text"
          ? `Call about ${missing.name}`
          : `Follow up by phone or coordinate manually about ${missing.name}`;
  return { ...summary, recommendedNextAction: action };
};

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

const organizerBrowser = (eventId: string): Effect.Effect<PrincipalActor, AppError, Db | CurrentUser | Authorizer> =>
  Effect.gen(function* () {
    const principal = yield* CurrentUser;
    if (principal.kind !== "browser-session") {
      return yield* Effect.fail(new Forbidden({ reason: "Organizer contact logging requires a browser session" }));
    }
    const { authorize } = yield* Authorizer;
    yield* authorize({
      principal,
      eventId,
      policy: eventAuthorization(
        { kind: "event-member", roles: ["owner", "admin"] },
        { kind: "api-key", scopes: ["speakers:write"] },
      ),
    });
    return { userId: principal.userId, actorUserId: principal.userId, actorApiKeyId: null };
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

const loadLatestAcceptedByEmail = (eventId: string, email: string) => Effect.gen(function* () {
  const { db } = yield* Db;
  const candidates = yield* database(() => db
    .select({
      acceptance: acceptanceEvents,
      provisioning: speakerProvisioning,
      submission: submissions,
      answer: submissionAnswers,
    })
    .from(acceptanceEvents)
    .innerJoin(speakerProvisioning, and(
      eq(speakerProvisioning.eventId, acceptanceEvents.eventId),
      eq(speakerProvisioning.acceptanceEventId, acceptanceEvents.id),
    ))
    .innerJoin(submissions, and(
      eq(submissions.eventId, acceptanceEvents.eventId),
      eq(submissions.id, acceptanceEvents.submissionId),
      eq(submissions.status, "accepted"),
    ))
    .innerJoin(submissionAnswers, and(
      eq(submissionAnswers.eventId, submissions.eventId),
      eq(submissionAnswers.submissionId, submissions.id),
      eq(submissionAnswers.formVersionId, submissions.formVersionId),
    ))
    .innerJoin(formVersionFields, and(
      eq(formVersionFields.eventId, submissionAnswers.eventId),
      eq(formVersionFields.formVersionId, submissionAnswers.formVersionId),
      eq(formVersionFields.id, submissionAnswers.formVersionFieldId),
      eq(formVersionFields.semanticKey, "speakerEmail"),
    ))
    .where(and(
      eq(acceptanceEvents.eventId, eventId),
      eq(acceptanceEvents.type, "accepted"),
      sql`not exists (
        select 1
        from acceptance_events as newer_portal_acceptance
        where newer_portal_acceptance.event_id = ${acceptanceEvents.eventId}
          and newer_portal_acceptance.submission_id = ${acceptanceEvents.submissionId}
          and (
            newer_portal_acceptance.occurred_at > ${acceptanceEvents.occurredAt}
            or (
              newer_portal_acceptance.occurred_at = ${acceptanceEvents.occurredAt}
              and newer_portal_acceptance.id > ${acceptanceEvents.id}
            )
          )
      )`,
    ))
    .orderBy(desc(acceptanceEvents.occurredAt), desc(acceptanceEvents.id)));
  return candidates.find(({ answer }) =>
    typeof answer.value === "string" && normalizedEmail(answer.value) === email
  ) ?? null;
});

const selfSpeaker = (eventId: string) => Effect.gen(function* () {
  const actor = yield* selfPrincipal();
  const { db } = yield* Db;
  const [account] = yield* database(() => db.select({ email: users.email }).from(users)
    .where(eq(users.id, actor.userId)).limit(1));
  const latestAccountAcceptance = account?.email
    ? yield* loadLatestAcceptedByEmail(eventId, normalizedEmail(account.email))
    : null;
  const speakerRows = yield* database(() => db.select().from(speakers).where(and(
    eq(speakers.eventId, eventId),
    eq(speakers.userId, actor.userId),
  )).orderBy(asc(speakers.id)));
  if (speakerRows.length === 0) return yield* Effect.fail(new Forbidden({ reason: "This browser session is not linked to a speaker for this event" }));
  const managedRows = yield* database(() => db.select({ speakerId: managedSpeakerEmails.speakerId }).from(managedSpeakerEmails).where(and(
    eq(managedSpeakerEmails.eventId, eventId),
    inArray(managedSpeakerEmails.speakerId, speakerRows.map((speaker) => speaker.id)),
  )));
  const managedIds = new Set(managedRows.map(({ speakerId }) => speakerId));
  const accepted = yield* Effect.forEach(
    speakerRows.filter((speaker) => !managedIds.has(speaker.id)),
    (speaker) => loadCurrentProvisioning(eventId, speaker.id).pipe(
      Effect.map((acceptance) => ({ speaker, acceptance })),
      Effect.option,
    ),
    { concurrency: 1 },
  );
  const currentAccepted = accepted.flatMap((candidate) => candidate._tag === "Some" ? [candidate.value] : [])
    .sort((left, right) => right.acceptance.acceptance.occurredAt.getTime() - left.acceptance.acceptance.occurredAt.getTime()
      || left.speaker.id.localeCompare(right.speaker.id))[0];
  if (currentAccepted) return {
    actor,
    speaker: currentAccepted.speaker,
    acceptance: latestAccountAcceptance ?? currentAccepted.acceptance,
  };
  const managed = speakerRows.find((speaker) => managedIds.has(speaker.id));
  if (managed) return { actor, speaker: managed, acceptance: latestAccountAcceptance };
  return yield* Effect.fail(new Forbidden({ reason: "A current accepted and provisioned speaker record is required" }));
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
  const taskOrder = new Map(definitions.map((task) => [task.id, task.order]));
  const currentTime = Date.now();
  const outstandingDefinitions = definitions.filter((task) => !completedTaskIds.has(task.id));
  const outstandingTaskIds = outstandingDefinitions.map((task) => task.id);
  const tasksTotal = definitions.length;
  const tasksDone = tasksTotal - outstandingTaskIds.length;
  const completionByTask = new Map(completions.map((completion) => [completion.taskId, completion]));
  const missingItems = outstandingDefinitions.map((task) => {
    const dueAt = millis(task.dueAt);
    const overdue = dueAt !== null && dueAt < currentTime;
    const recommendedAction = task.kind === "profile"
      ? "Complete the speaker profile"
      : task.kind === "upload"
        ? `Upload the requested file for ${task.name}`
        : task.kind === "form"
          ? `Submit ${task.name}`
          : task.kind === "link"
            ? "Add the requested speaker link"
            : `Confirm ${task.name}`;
    const blocker = overdue
      ? `Overdue: ${task.name}`
      : dueAt !== null
        ? `Due: ${task.name}`
        : `Missing: ${task.name}`;
    return { id: task.id, name: task.name, kind: task.kind, dueAt, overdue, blocker, recommendedAction };
  });
  missingItems.sort((left, right) => Number(right.overdue) - Number(left.overdue)
    || (left.dueAt ?? Number.MAX_SAFE_INTEGER) - (right.dueAt ?? Number.MAX_SAFE_INTEGER)
    || (taskOrder.get(left.id) ?? Number.MAX_SAFE_INTEGER) - (taskOrder.get(right.id) ?? Number.MAX_SAFE_INTEGER)
    || left.id.localeCompare(right.id));
  return {
    tasksTotal,
    tasksDone,
    outstandingTaskIds: missingItems.map((item) => item.id),
    nextTaskId: missingItems[0]?.id ?? null,
    state: tasksTotal === 0 || tasksDone === tasksTotal ? "ready" : tasksDone === 0 ? "not_started" : "in_progress",
    missingItems,
    overdueCount: missingItems.filter((item) => item.overdue).length,
    clearestBlocker: missingItems[0]?.blocker ?? null,
    recommendedNextAction: missingItems[0]?.recommendedAction ?? null,
    taskItems: definitions.map((task) => {
      const completion = completionByTask.get(task.id);
      const dueAt = millis(task.dueAt);
      return {
        id: task.id,
        name: task.name,
        kind: task.kind,
        dueAt,
        completed: completion !== undefined,
        completedAt: completion ? millis(completion.completedAt) : null,
        overdue: completion === undefined && dueAt !== null && dueAt < currentTime,
      };
    }),
  };
};

const currentTasks = (eventId: string, speakerId: string) => Effect.gen(function* () {
  const { db } = yield* Db;
  const [allDefinitions, assignments, completions, speaker, pendingBio] = yield* Effect.all([
    database(() => db.select().from(tasks).where(eq(tasks.eventId, eventId)).orderBy(asc(tasks.order), asc(tasks.id))),
    database(() => db.select().from(taskAssignments).where(and(
      eq(taskAssignments.eventId, eventId),
      eq(taskAssignments.speakerId, speakerId),
    ))),
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
  const assignedTaskIds = new Set(assignments.map((assignment) => assignment.taskId));
  const definitions = allDefinitions.filter((task) => task.targetMode === "all" || assignedTaskIds.has(task.id));
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
  data: Uint8Array,
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
  const maxSize = PORTAL_UPLOAD_MAX_BYTES[purpose];
  const startsWith = (signature: readonly number[]) =>
    data.length >= signature.length && signature.every((byte, index) => data[index] === byte);
  const endsWith = (signature: readonly number[]) => {
    const offset = data.length - signature.length;
    return offset >= 0 && signature.every((byte, index) => data[offset + index] === byte);
  };
  const containsAscii = (value: string) => {
    const signature = [...value].map((character) => character.charCodeAt(0));
    outer: for (let offset = 0; offset <= data.length - signature.length; offset += 1) {
      for (let index = 0; index < signature.length; index += 1) {
        if (data[offset + index] !== signature[index]) continue outer;
      }
      return true;
    }
    return false;
  };
  const contentMatches = contentType === "image/png"
    ? startsWith([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) && containsAscii("IEND")
    : contentType === "image/jpeg"
      ? startsWith([0xff, 0xd8, 0xff]) && endsWith([0xff, 0xd9])
      : contentType === "image/webp"
        ? startsWith([0x52, 0x49, 0x46, 0x46]) && data.length >= 12 && data.slice(8, 12).every((byte, index) => byte === [0x57, 0x45, 0x42, 0x50][index])
        : contentType === "application/pdf"
          ? startsWith([0x25, 0x50, 0x44, 0x46, 0x2d]) && containsAscii("%%EOF")
          : contentType === "application/vnd.ms-powerpoint" || contentType === "application/msword"
            ? data.length >= 512 && startsWith([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])
            : contentType === "application/vnd.openxmlformats-officedocument.presentationml.presentation"
              ? startsWith([0x50, 0x4b, 0x03, 0x04]) && containsAscii("ppt/") && containsAscii("PK\u0005\u0006")
              : contentType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                ? startsWith([0x50, 0x4b, 0x03, 0x04]) && containsAscii("word/") && containsAscii("PK\u0005\u0006")
                : false;
  if (!allowed[contentType as keyof typeof allowed]?.includes(extension) || data.byteLength === 0 || data.byteLength > maxSize || !contentMatches) {
    return new Validation({ message: `Invalid ${purpose} file content, type, extension, or size` });
  }
  return null;
};

const decodeBase64 = (value: string, purpose: UploadPortalAssetInput["purpose"]): Effect.Effect<Uint8Array, Validation> => Effect.try({
  try: () => {
    if (value.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
      throw new Error("invalid base64");
    }
    const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
    const decodedSize = value.length / 4 * 3 - padding;
    if (decodedSize === 0 || decodedSize > PORTAL_UPLOAD_MAX_BYTES[purpose]) {
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
        ? `Asset must be between 1 byte and ${PORTAL_UPLOAD_MAX_BYTES[purpose] / 1_024 / 1_024} MiB for ${purpose}`
        : "Asset content is not valid base64",
    }),
});

const parseCsv = (source: string): Effect.Effect<readonly (readonly string[])[], Validation> => Effect.try({
  try: () => {
    const rows: string[][] = [];
    let row: string[] = [];
    let field = "";
    let quoted = false;
    for (let index = 0; index < source.length; index += 1) {
      const character = source[index]!;
      if (quoted) {
        if (character === '"' && source[index + 1] === '"') {
          field += '"';
          index += 1;
        } else if (character === '"') {
          quoted = false;
        } else {
          field += character;
        }
      } else if (character === '"') {
        quoted = true;
      } else if (character === ",") {
        row.push(field.trim());
        field = "";
      } else if (character === "\n") {
        row.push(field.trim());
        rows.push(row);
        row = [];
        field = "";
      } else if (character !== "\r") {
        field += character;
      }
    }
    if (quoted) throw new Error("CSV contains an unterminated quoted field");
    row.push(field.trim());
    if (row.some((value) => value.length > 0)) rows.push(row);
    return rows;
  },
  catch: (error) => new Validation({ message: error instanceof Error ? error.message : "CSV could not be parsed" }),
});

export const getSpeakerDirectory = (input: { readonly eventId: string }): Effect.Effect<SpeakerDirectory, AppError, Db | CurrentUser | Authorizer> => Effect.gen(function* () {
  yield* organizer(input.eventId, "speakers:read");
  const { db } = yield* Db;
  const event = yield* requireEvent(input.eventId);
  const [speakerRows, acceptedRows, acceptanceHistory] = yield* Effect.all([
    database(() => db.select().from(speakers).where(eq(speakers.eventId, input.eventId)).orderBy(asc(speakers.displayName), asc(speakers.id))),
    database(() => db
    .select({ acceptance: acceptanceEvents, provisioning: speakerProvisioning, speaker: speakers, submission: submissions })
    .from(acceptanceEvents)
    .innerJoin(speakerProvisioning, and(eq(speakerProvisioning.eventId, acceptanceEvents.eventId), eq(speakerProvisioning.acceptanceEventId, acceptanceEvents.id)))
    .innerJoin(speakers, and(eq(speakers.eventId, acceptanceEvents.eventId), eq(speakers.id, acceptanceEvents.primarySpeakerId)))
    .leftJoin(submissions, and(eq(submissions.eventId, acceptanceEvents.eventId), eq(submissions.id, acceptanceEvents.submissionId)))
    .where(and(eq(acceptanceEvents.eventId, input.eventId), eq(acceptanceEvents.type, "accepted")))
    .orderBy(asc(speakers.displayName), desc(acceptanceEvents.occurredAt), desc(acceptanceEvents.id))),
    database(() => db
    .select({
      id: acceptanceEvents.id,
      submissionId: acceptanceEvents.submissionId,
      type: acceptanceEvents.type,
    })
    .from(acceptanceEvents)
    .where(eq(acceptanceEvents.eventId, input.eventId))
    .orderBy(desc(acceptanceEvents.occurredAt), desc(acceptanceEvents.id))),
  ]);
  const latestBySubmission = new Map<string, (typeof acceptanceHistory)[number]>();
  for (const acceptance of acceptanceHistory) {
    if (!latestBySubmission.has(acceptance.submissionId)) {
      latestBySubmission.set(acceptance.submissionId, acceptance);
    }
  }
  const currentBySpeaker = new Map<string, (typeof acceptedRows)[number]>();
  for (const row of acceptedRows) {
    const latest = latestBySubmission.get(row.acceptance.submissionId);
    if (latest?.type === "accepted" && latest.id === row.acceptance.id && !currentBySpeaker.has(row.speaker.id)) {
      currentBySpeaker.set(row.speaker.id, row);
    }
  }
  const speakerIds = speakerRows.map((speaker) => speaker.id);
  const [definitions, assignments, completions, contacts, sessionRows] = yield* Effect.all([
    database(() => db.select().from(tasks).where(eq(tasks.eventId, input.eventId)).orderBy(asc(tasks.order), asc(tasks.id))),
    database(() => db.select().from(taskAssignments).where(eq(taskAssignments.eventId, input.eventId))),
    speakerIds.length === 0 ? Effect.succeed([] as readonly (typeof taskCompletions.$inferSelect)[]) : database(() => db.select().from(taskCompletions).where(and(eq(taskCompletions.eventId, input.eventId), inArray(taskCompletions.speakerId, speakerIds)))),
    speakerIds.length === 0 ? Effect.succeed([] as readonly (typeof speakerContacts.$inferSelect)[]) : database(() => db
      .select()
      .from(speakerContacts)
      .where(and(eq(speakerContacts.eventId, input.eventId), inArray(speakerContacts.speakerId, speakerIds)))
      .orderBy(desc(speakerContacts.contactedAt), desc(speakerContacts.id))),
    speakerIds.length === 0 ? Effect.succeed([] as readonly {
      readonly speakerId: string;
      readonly id: string;
      readonly title: string;
      readonly startsAt: Date | null;
      readonly durationMin: number;
      readonly status: "draft" | "confirmed" | "cancelled";
    }[]) : database(() => db.select({
      speakerId: talkSpeakers.speakerId,
      id: talks.id,
      title: talks.title,
      startsAt: talks.startsAt,
      durationMin: talks.durationMin,
      status: talks.status,
    }).from(talkSpeakers).innerJoin(talks, and(
      eq(talks.eventId, talkSpeakers.eventId),
      eq(talks.id, talkSpeakers.talkId),
    )).where(and(eq(talkSpeakers.eventId, input.eventId), inArray(talkSpeakers.speakerId, speakerIds)))
      .orderBy(asc(talks.startsAt), asc(talks.title))),
  ]);
  const onboardingFormIds = definitions.flatMap((task) => task.kind === "form" && task.formId !== null ? [task.formId] : []);
  const storedPrivateFieldRows = speakerIds.length === 0 || onboardingFormIds.length === 0
    ? []
    : yield* database(() => db.select({
      speakerId: submissionSpeakers.speakerId,
      submissionId: submissions.id,
      formId: submissions.formId,
      formName: forms.name,
      fieldId: formVersionFields.id,
      fieldOrder: formVersionFields.order,
      label: formVersionFields.label,
      value: submissionAnswers.value,
      submittedAt: submissions.submittedAt,
    })
      .from(submissionSpeakers)
      .innerJoin(submissions, and(
        eq(submissions.eventId, submissionSpeakers.eventId),
        eq(submissions.id, submissionSpeakers.submissionId),
      ))
      .innerJoin(forms, and(
        eq(forms.eventId, submissions.eventId),
        eq(forms.id, submissions.formId),
      ))
      .innerJoin(submissionAnswers, and(
        eq(submissionAnswers.eventId, submissions.eventId),
        eq(submissionAnswers.submissionId, submissions.id),
        eq(submissionAnswers.formVersionId, submissions.formVersionId),
      ))
      .innerJoin(formVersionFields, and(
        eq(formVersionFields.eventId, submissionAnswers.eventId),
        eq(formVersionFields.formVersionId, submissionAnswers.formVersionId),
        eq(formVersionFields.id, submissionAnswers.formVersionFieldId),
      ))
      .where(and(
        eq(submissionSpeakers.eventId, input.eventId),
        inArray(submissionSpeakers.speakerId, speakerIds),
        inArray(submissions.formId, onboardingFormIds),
        eq(forms.kind, "task"),
      ))
      .orderBy(desc(submissions.submittedAt), desc(submissions.id), asc(formVersionFields.order)));
  const privateFieldRows = yield* Effect.forEach(storedPrivateFieldRows, (row) =>
    Schema.decodeUnknown(SpeakerPrivateFieldValueSchema)(row.value).pipe(
      Effect.map((value) => ({ ...row, value })),
      Effect.mapError((error) => new External({
        service: "database",
        detail: `Invalid private speaker field ${row.fieldId}: ${String(error)}`,
      })),
    ),
  );
  const latestPrivateSubmissionBySpeakerForm = new Map<string, string>();
  for (const row of privateFieldRows) {
    const key = `${row.speakerId}\0${row.formId}`;
    if (!latestPrivateSubmissionBySpeakerForm.has(key)) latestPrivateSubmissionBySpeakerForm.set(key, row.submissionId);
  }
  const bySpeaker = new Map<string, (typeof taskCompletions.$inferSelect)[]>();
  for (const completion of completions) bySpeaker.set(completion.speakerId, [...(bySpeaker.get(completion.speakerId) ?? []), completion]);
  const latestContactBySpeaker = new Map<string, typeof speakerContacts.$inferSelect>();
  for (const contact of contacts) {
    if (!latestContactBySpeaker.has(contact.speakerId)) latestContactBySpeaker.set(contact.speakerId, contact);
  }
  const assignedTaskIdsBySpeaker = new Map<string, Set<string>>();
  for (const assignment of assignments) {
    const taskIds = assignedTaskIdsBySpeaker.get(assignment.speakerId) ?? new Set<string>();
    taskIds.add(assignment.taskId);
    assignedTaskIdsBySpeaker.set(assignment.speakerId, taskIds);
  }
  const directoryItems = speakerRows.map((speaker): SpeakerDirectoryItem => {
    const accepted = currentBySpeaker.get(speaker.id);
    const latestContact = latestContactBySpeaker.has(speaker.id)
      ? contactView(latestContactBySpeaker.get(speaker.id)!)
      : null;
    const assignedTaskIds = assignedTaskIdsBySpeaker.get(speaker.id) ?? new Set<string>();
    const speakerDefinitions = definitions.filter((task) => task.targetMode === "all" || assignedTaskIds.has(task.id));
    return {
      speaker: speakerView(speaker),
      submission: accepted?.submission ? { id: accepted.submission.id, title: accepted.submission.title, category: accepted.submission.category, version: accepted.submission.version } : null,
      source: accepted ? "accepted" : "manual",
      acceptanceEventId: accepted?.acceptance.id ?? null,
      provisioningId: accepted?.provisioning.id ?? null,
      provisioningVersion: accepted?.provisioning.version ?? 0,
      provisioningStatus: accepted?.provisioning.status ?? "manual",
      provisionedAt: accepted ? millis(accepted.provisioning.provisionedAt) : null,
      sessions: sessionRows.filter((session) => session.speakerId === speaker.id).map((session) => ({
        id: session.id,
        title: session.title,
        startsAt: millis(session.startsAt),
        durationMin: session.durationMin,
        status: session.status,
      })),
      privateFields: privateFieldRows
        .filter((field) => {
          const taskApplies = speakerDefinitions.some((task) => task.kind === "form" && task.formId === field.formId);
          const latestSubmissionId = latestPrivateSubmissionBySpeakerForm.get(`${speaker.id}\0${field.formId}`);
          return field.speakerId === speaker.id && taskApplies && latestSubmissionId === field.submissionId;
        })
        .map((field) => ({
          submissionId: field.submissionId,
          formId: field.formId,
          formName: field.formName,
          fieldId: field.fieldId,
          label: field.label,
          value: field.value,
          submittedAt: field.submittedAt.getTime(),
        })),
      readiness: withContactEscalation(readiness(speakerDefinitions, bySpeaker.get(speaker.id) ?? []), latestContact),
      latestContact,
    };
  });
  directoryItems.sort((left, right) => {
    const attention = (item: SpeakerDirectoryItem) => item.readiness.missingItems.length > 0 ? 1 : 0;
    const due = (item: SpeakerDirectoryItem) => item.readiness.missingItems.find((missing) => missing.overdue)?.dueAt ?? Number.MAX_SAFE_INTEGER;
    return attention(right) - attention(left)
      || right.readiness.overdueCount - left.readiness.overdueCount
      || due(left) - due(right)
      || right.readiness.missingItems.length - left.readiness.missingItems.length
      || left.speaker.displayName.localeCompare(right.speaker.displayName)
      || left.speaker.id.localeCompare(right.speaker.id);
  });
  return {
    event: eventView(event),
    speakers: directoryItems,
  };
});

export const getPortalDashboard = (input: { readonly eventId: string }): Effect.Effect<PortalDashboard, AppError, Db | CurrentUser | Authorizer> => Effect.gen(function* () {
  const directory = yield* getSpeakerDirectory(input);
  const totals = directory.speakers.reduce((total, item) => ({
    speakers: total.speakers + 1,
    ready: total.ready + (item.readiness.state === "ready" ? 1 : 0),
    needsAttention: total.needsAttention + (item.readiness.missingItems.length > 0 ? 1 : 0),
    overdue: total.overdue + item.readiness.overdueCount,
    tasksDone: total.tasksDone + item.readiness.tasksDone,
    tasksTotal: total.tasksTotal + item.readiness.tasksTotal,
  }), { speakers: 0, ready: 0, needsAttention: 0, overdue: 0, tasksDone: 0, tasksTotal: 0 });
  return { event: directory.event, speakers: directory.speakers, totals };
});

/** Records only an organizer's completed outreach; creating a draft is deliberately not an operation. */
export const logSpeakerContact = (input: LogSpeakerContactInput): Effect.Effect<SpeakerContact, AppError, Db | CurrentUser | Authorizer | Rooms> => Effect.gen(function* () {
  const event = yield* resolveEvent(input.eventId);
  const actor = yield* organizerBrowser(event.id);
  const { db } = yield* Db;
  const { keyHash, requestHash } = yield* commandHashes(input.idempotencyKey, input);
  const replay = yield* findReplay(event.id, "portal.logSpeakerContact", actor.userId, keyHash, requestHash);
  if (replay !== null) return yield* decodeReplay(SpeakerContactSchema, replay);

  const directory = yield* getSpeakerDirectory({ eventId: event.id });
  const speaker = directory.speakers.find((item) => item.speaker.id === input.speakerId);
  if (!speaker) {
    return yield* Effect.fail(new NotFound({ entity: "speaker", id: input.speakerId }));
  }
  const contactedAt = new Date(Math.max(now().getTime(), (speaker.latestContact?.contactedAt ?? 0) + 1));
  const contact: SpeakerContact = {
    id: id("speaker_contact"),
    medium: input.medium,
    note: input.note?.trim() || null,
    contactedAt: contactedAt.getTime(),
  };
  const idempotency = idempotencyInsert(
    event.id,
    "portal.logSpeakerContact",
    actor.userId,
    keyHash,
    requestHash,
    contactedAt,
  );
  const requestId = id("portal_request");
  yield* database(() => db.batch([
    db.insert(idempotencyRecords).values(idempotency),
    db.insert(speakerContacts).values({
      id: contact.id,
      eventId: event.id,
      speakerId: input.speakerId,
      actorUserId: actor.userId,
      medium: contact.medium,
      note: contact.note,
      contactedAt,
      createdAt: contactedAt,
    }),
    db.insert(domainChanges).values(writeChange(
      event.id,
      "speakerContact",
      contact.id,
      1,
      "portal.speaker.contact.logged",
      { speakerId: input.speakerId, medium: contact.medium, contactedAt: contact.contactedAt },
      actor,
      contactedAt,
      requestId,
      idempotency.id,
    )),
    db.insert(auditLog).values({
      id: id("audit"),
      eventId: event.id,
      requestId,
      actorUserId: actor.userId,
      actorApiKeyId: null,
      action: "portal.speaker.contact.logged",
      resourceType: "speakerContact",
      resourceId: contact.id,
      before: null,
      after: contact,
      metadata: { speakerId: input.speakerId },
      occurredAt: contactedAt,
    }),
    db.update(idempotencyRecords)
      .set({ status: "completed", responseStatus: 201, responseBody: contact, completedAt: contactedAt })
      .where(eq(idempotencyRecords.id, idempotency.id)),
  ]));
  const { broadcast } = yield* Rooms;
  yield* broadcast(event.id, {
    t: "dashboard/progress",
    speakerId: input.speakerId,
    taskId: "contact",
    completed: false,
    tasksDone: speaker.readiness.tasksDone,
    tasksTotal: speaker.readiness.tasksTotal,
  }).pipe(Effect.catchAll(() => Effect.void));
  return contact;
});

export interface ClaimSpeakerTestHooks {
  readonly beforeCommit?: () => Promise<void>;
}

export const claimSpeaker = (
  input: ClaimSpeakerInput,
  testHooks?: ClaimSpeakerTestHooks,
): Effect.Effect<ClaimSpeakerOutput, AppError, Db | CurrentUser> => Effect.gen(function* () {
  const event = yield* resolveEvent(input.eventId);
  const principal = yield* CurrentUser;
  if (principal.kind !== "browser-session") {
    return yield* Effect.fail(
      new Forbidden({ reason: "Speaker account claims require a browser session" }),
    );
  }
  const email = normalizedEmail(principal.email);
  if (email.length === 0) {
    return yield* Effect.fail(new Forbidden({ reason: "The signed-in account has no email" }));
  }
  const actor: PrincipalActor = {
    userId: principal.userId,
    actorUserId: principal.userId,
    actorApiKeyId: null,
  };
  const { db } = yield* Db;
  const { keyHash, requestHash } = yield* commandHashes(input.idempotencyKey, input);
  const replay = yield* findReplay(
    event.id,
    "portal.claimSpeaker",
    actor.userId,
    keyHash,
    requestHash,
  );
  if (replay !== null) return yield* decodeReplay(ClaimSpeakerOutputSchema, replay);

  const acceptedRows = yield* database(() => db
    .select({
      acceptance: acceptanceEvents,
      provisioning: speakerProvisioning,
      speaker: speakers,
      answer: submissionAnswers,
    })
    .from(acceptanceEvents)
    .innerJoin(speakerProvisioning, and(
      eq(speakerProvisioning.eventId, acceptanceEvents.eventId),
      eq(speakerProvisioning.acceptanceEventId, acceptanceEvents.id),
    ))
    .innerJoin(speakers, and(
      eq(speakers.eventId, acceptanceEvents.eventId),
      eq(speakers.id, acceptanceEvents.primarySpeakerId),
    ))
    .innerJoin(submissions, and(
      eq(submissions.eventId, acceptanceEvents.eventId),
      eq(submissions.id, acceptanceEvents.submissionId),
      eq(submissions.status, "accepted"),
    ))
    .innerJoin(submissionAnswers, and(
      eq(submissionAnswers.eventId, submissions.eventId),
      eq(submissionAnswers.submissionId, submissions.id),
      eq(submissionAnswers.formVersionId, submissions.formVersionId),
    ))
    .innerJoin(formVersionFields, and(
      eq(formVersionFields.eventId, submissionAnswers.eventId),
      eq(formVersionFields.formVersionId, submissionAnswers.formVersionId),
      eq(formVersionFields.id, submissionAnswers.formVersionFieldId),
      eq(formVersionFields.semanticKey, "speakerEmail"),
    ))
    .where(and(
      eq(acceptanceEvents.eventId, event.id),
      eq(acceptanceEvents.type, "accepted"),
      sql`not exists (
        select 1
        from acceptance_events as newer_acceptance
        where newer_acceptance.event_id = ${acceptanceEvents.eventId}
          and newer_acceptance.submission_id = ${acceptanceEvents.submissionId}
          and (
            newer_acceptance.occurred_at > ${acceptanceEvents.occurredAt}
            or (
              newer_acceptance.occurred_at = ${acceptanceEvents.occurredAt}
              and newer_acceptance.id > ${acceptanceEvents.id}
            )
          )
      )`,
    ))
    .orderBy(desc(acceptanceEvents.occurredAt), desc(acceptanceEvents.id)));

  const latestBySpeaker = new Map<string, (typeof acceptedRows)[number]>();
  for (const candidate of acceptedRows) {
    if (!latestBySpeaker.has(candidate.speaker.id)) {
      latestBySpeaker.set(candidate.speaker.id, candidate);
    }
  }
  const matches = [...latestBySpeaker.values()].filter(({ answer }) =>
    typeof answer.value === "string" && normalizedEmail(answer.value) === email
  );
  if (matches.length === 0) {
    const [managed] = yield* database(() => db.select({ speaker: speakers }).from(managedSpeakerEmails)
      .innerJoin(speakers, and(
        eq(speakers.eventId, managedSpeakerEmails.eventId),
        eq(speakers.id, managedSpeakerEmails.speakerId),
      ))
      .where(and(
        eq(managedSpeakerEmails.eventId, event.id),
        eq(managedSpeakerEmails.normalizedEmail, email),
      ))
      .limit(1));
    if (!managed) {
      return yield* Effect.fail(
        new Forbidden({ reason: "No current accepted or directly managed speaker matches this account email" }),
      );
    }
    if (managed.speaker.userId !== null && managed.speaker.userId !== actor.userId) {
      return yield* Effect.fail(new Conflict({ message: "This managed speaker is already linked to another account" }));
    }
    const managedResult = (speakerVersion: number): ClaimSpeakerOutput => ({
      eventId: event.id,
      speakerId: managed.speaker.id,
      acceptanceEventId: null,
      provisioningId: null,
      speakerVersion,
      provisioningVersion: 0,
      provisioningStatus: "provisioned",
    });
    if (managed.speaker.userId === actor.userId) return managedResult(managed.speaker.version);

    const claimedAt = now();
    const nextVersion = managed.speaker.version + 1;
    const result = managedResult(nextVersion);
    const idempotency = idempotencyInsert(
      event.id, "portal.claimSpeaker", actor.userId, keyHash, requestHash, claimedAt,
    );
    const requestId = id("portal_request");
    const change = writeChange(
      event.id, "speaker", managed.speaker.id, nextVersion, "portal.speaker.claimed",
      { speakerId: managed.speaker.id, userId: actor.userId, source: "manual" },
      actor, claimedAt, requestId, idempotency.id,
    );
    const committed = yield* database(() => db.batch([
      db.insert(idempotencyRecords).values(idempotency),
      db.update(speakers).set({
        userId: actor.userId, version: nextVersion, updatedAt: claimedAt,
      }).where(and(
        eq(speakers.eventId, event.id),
        eq(speakers.id, managed.speaker.id),
        eq(speakers.version, managed.speaker.version),
        isNull(speakers.userId),
        sql`exists (
          select 1 from managed_speaker_emails as managed_claim
          where managed_claim.event_id = ${event.id}
            and managed_claim.speaker_id = ${managed.speaker.id}
            and managed_claim.normalized_email = ${email}
        )`,
      )).returning({ id: speakers.id }),
      db.insert(domainChanges).values(change),
      db.insert(auditLog).values({
        id: id("audit"), eventId: event.id, requestId,
        actorUserId: actor.actorUserId, actorApiKeyId: null,
        action: "portal.speaker.claimed", resourceType: "speaker", resourceId: managed.speaker.id,
        before: { userId: null, speakerVersion: managed.speaker.version, source: "manual" },
        after: { userId: actor.userId, speakerVersion: nextVersion, source: "manual" },
        metadata: null, occurredAt: claimedAt,
      }),
      db.update(idempotencyRecords).set({
        status: "completed", responseStatus: 200, responseBody: result,
        completedAt: claimedAt,
      }).where(eq(idempotencyRecords.id, idempotency.id)),
    ])).pipe(Effect.either);
    if (committed._tag === "Right" && (committed.right[1] as { id: string }[])[0]) return result;
    const [currentManaged] = yield* database(() => db.select({ userId: speakers.userId, version: speakers.version })
      .from(speakers).where(and(
        eq(speakers.eventId, event.id), eq(speakers.id, managed.speaker.id),
      )).limit(1));
    if (currentManaged?.userId === actor.userId) return managedResult(currentManaged.version);
    if (committed._tag === "Left") return yield* Effect.fail(committed.left);
    return yield* Effect.fail(new Conflict({ message: "The managed speaker claim changed; retry from the latest event state" }));
  }
  // A speaker can submit more than one proposal with the same verified account
  // email. Preserve the already-linked active event identity so profile,
  // headshot, participant, readiness, and in-flight provisioning history stay
  // on one canonical speaker.
  // For a first-time account, `acceptedRows` is newest-first and the latest
  // current acceptance becomes that canonical identity.
  const canonical = matches.find(({ speaker, provisioning }) =>
    speaker.userId === actor.userId &&
    ["pending", "retry", "claimed", "provisioned"].includes(provisioning.status)
  );
  if (!canonical) {
    const [existingLink] = yield* database(() => db.select({ id: speakers.id }).from(speakers).where(and(
      eq(speakers.eventId, event.id),
      eq(speakers.userId, actor.userId),
    )).limit(1));
    if (existingLink) {
      return yield* Effect.fail(new Conflict({ message: "This account already has a canonical event speaker identity" }));
    }
  }
  const row = canonical ?? matches[0]!;
  if (row.speaker.userId !== null && row.speaker.userId !== actor.userId) {
    return yield* Effect.fail(
      new Conflict({ message: "This accepted speaker is already linked to another account" }),
    );
  }
  if (
    row.speaker.userId === actor.userId &&
    row.provisioning.status === "provisioned"
  ) {
    return {
      eventId: event.id,
      speakerId: row.speaker.id,
      acceptanceEventId: row.acceptance.id,
      provisioningId: row.provisioning.id,
      speakerVersion: row.speaker.version,
      provisioningVersion: row.provisioning.version,
      provisioningStatus: row.provisioning.status,
    };
  }
  if (
    row.provisioning.status !== "pending" &&
    row.provisioning.status !== "retry" &&
    row.provisioning.status !== "claimed"
  ) {
    return yield* Effect.fail(
      new Conflict({ message: "This accepted speaker claim is not available" }),
    );
  }

  const claimedAt = now();
  const nextSpeakerVersion = row.speaker.userId === null
    ? row.speaker.version + 1
    : row.speaker.version;
  const nextProvisioningVersion = row.provisioning.version + 1;
  const result: ClaimSpeakerOutput = {
    eventId: event.id,
    speakerId: row.speaker.id,
    acceptanceEventId: row.acceptance.id,
    provisioningId: row.provisioning.id,
    speakerVersion: nextSpeakerVersion,
    provisioningVersion: nextProvisioningVersion,
    provisioningStatus: "provisioned",
  };
  const idempotency = idempotencyInsert(
    event.id,
    "portal.claimSpeaker",
    actor.userId,
    keyHash,
    requestHash,
    claimedAt,
  );
  const requestId = id("portal_request");
  const change = writeChange(
    event.id,
    "speakerProvisioning",
    row.provisioning.id,
    nextProvisioningVersion,
    "portal.speaker.claimed",
    {
      acceptanceEventId: row.acceptance.id,
      provisioningId: row.provisioning.id,
      speakerId: row.speaker.id,
      userId: actor.userId,
    },
    actor,
    claimedAt,
    requestId,
    idempotency.id,
  );
  const currentAcceptanceGuard = sql`exists (
    select 1
    from acceptance_events as claim_acceptance
    inner join submissions as claim_submission
      on claim_submission.event_id = claim_acceptance.event_id
      and claim_submission.id = claim_acceptance.submission_id
    inner join submission_answers as claim_answer
      on claim_answer.event_id = claim_submission.event_id
      and claim_answer.submission_id = claim_submission.id
      and claim_answer.form_version_id = claim_submission.form_version_id
    inner join form_version_fields as claim_field
      on claim_field.event_id = claim_answer.event_id
      and claim_field.form_version_id = claim_answer.form_version_id
      and claim_field.id = claim_answer.form_version_field_id
    where claim_acceptance.event_id = ${event.id}
      and claim_acceptance.id = ${row.acceptance.id}
      and claim_acceptance.submission_id = ${row.acceptance.submissionId}
      and claim_acceptance.primary_speaker_id = ${row.speaker.id}
      and claim_acceptance.type = 'accepted'
      and claim_submission.status = 'accepted'
      and claim_answer.id = ${row.answer.id}
      and claim_answer.version = ${row.answer.version}
      and claim_field.semantic_key = 'speakerEmail'
      and json_type(claim_answer.value) = 'text'
      and lower(trim(json_extract(claim_answer.value, '$'))) = ${email}
      and not exists (
        select 1
        from acceptance_events as newer_acceptance
        where newer_acceptance.event_id = claim_acceptance.event_id
          and newer_acceptance.submission_id = claim_acceptance.submission_id
          and (
            newer_acceptance.occurred_at > claim_acceptance.occurred_at
            or (
              newer_acceptance.occurred_at = claim_acceptance.occurred_at
              and newer_acceptance.id > claim_acceptance.id
            )
          )
      )
      and not exists (
        select 1
        from acceptance_events as later_current_acceptance
        inner join submissions as later_current_submission
          on later_current_submission.event_id = later_current_acceptance.event_id
          and later_current_submission.id = later_current_acceptance.submission_id
          and later_current_submission.status = 'accepted'
        where later_current_acceptance.event_id = claim_acceptance.event_id
          and later_current_acceptance.primary_speaker_id = claim_acceptance.primary_speaker_id
          and later_current_acceptance.type = 'accepted'
          and (
            later_current_acceptance.occurred_at > claim_acceptance.occurred_at
            or (
              later_current_acceptance.occurred_at = claim_acceptance.occurred_at
              and later_current_acceptance.id > claim_acceptance.id
            )
          )
          and not exists (
            select 1
            from acceptance_events as superseding_later_acceptance
            where superseding_later_acceptance.event_id = later_current_acceptance.event_id
              and superseding_later_acceptance.submission_id = later_current_acceptance.submission_id
              and (
                superseding_later_acceptance.occurred_at > later_current_acceptance.occurred_at
                or (
                  superseding_later_acceptance.occurred_at = later_current_acceptance.occurred_at
                  and superseding_later_acceptance.id > later_current_acceptance.id
                )
              )
          )
      )
  )`;
  const provisioningGuard = and(
    eq(speakerProvisioning.eventId, event.id),
    eq(speakerProvisioning.id, row.provisioning.id),
    eq(speakerProvisioning.acceptanceEventId, row.acceptance.id),
    eq(speakerProvisioning.primarySpeakerId, row.speaker.id),
    eq(speakerProvisioning.version, row.provisioning.version),
    inArray(speakerProvisioning.status, ["pending", "retry", "claimed"]),
    currentAcceptanceGuard,
    sql`exists (
      select 1 from speakers as claimed_speaker
      where claimed_speaker.event_id = ${event.id}
        and claimed_speaker.id = ${row.speaker.id}
        and claimed_speaker.user_id = ${actor.userId}
        and claimed_speaker.version = ${nextSpeakerVersion}
    )`,
  );
  const committedGuard = and(
    eq(speakerProvisioning.eventId, event.id),
    eq(speakerProvisioning.id, row.provisioning.id),
    eq(speakerProvisioning.acceptanceEventId, row.acceptance.id),
    eq(speakerProvisioning.primarySpeakerId, row.speaker.id),
    eq(speakerProvisioning.version, nextProvisioningVersion),
    eq(speakerProvisioning.status, "provisioned"),
    eq(speakers.eventId, event.id),
    eq(speakers.id, row.speaker.id),
    eq(speakers.userId, actor.userId),
    eq(speakers.version, nextSpeakerVersion),
    currentAcceptanceGuard,
  );
  const completedIdempotency = db.insert(idempotencyRecords).select(
    db.select({
      id: sql<string>`${idempotency.id}`.as("id"),
      eventId: sql<string>`${idempotency.eventId}`.as("event_id"),
      operationId: sql<string>`${idempotency.operationId}`.as("operation_id"),
      principalId: sql<string>`${idempotency.principalId}`.as("principal_id"),
      keyHash: sql<string>`${idempotency.keyHash}`.as("key_hash"),
      requestHash: sql<string>`${idempotency.requestHash}`.as("request_hash"),
      status: sql<"completed">`'completed'`.as("status"),
      responseStatus: sql<number>`200`.as("response_status"),
      responseBody: sql<ClaimSpeakerOutput>`${JSON.stringify(result)}`.as("response_body"),
      expiresAt: sql<Date>`${idempotency.expiresAt.getTime()}`.as("expires_at"),
      completedAt: sql<Date>`${claimedAt.getTime()}`.as("completed_at"),
      createdAt: sql<Date>`${claimedAt.getTime()}`.as("created_at"),
    })
      .from(speakerProvisioning)
      .innerJoin(speakers, and(
        eq(speakers.eventId, speakerProvisioning.eventId),
        eq(speakers.id, speakerProvisioning.primarySpeakerId),
      ))
      .where(committedGuard),
  );
  const claimChange = db.insert(domainChanges).select(
    db.select(changeSelection(change))
      .from(speakerProvisioning)
      .innerJoin(speakers, and(
        eq(speakers.eventId, speakerProvisioning.eventId),
        eq(speakers.id, speakerProvisioning.primarySpeakerId),
      ))
      .where(committedGuard),
  );
  const claimAudit = db.insert(auditLog).select(
    db.select({
      id: sql<string>`${id("audit")}`.as("id"),
      eventId: sql<string>`${event.id}`.as("event_id"),
      requestId: sql<string>`${requestId}`.as("request_id"),
      actorUserId: sql<string | null>`${actor.actorUserId}`.as("actor_user_id"),
      actorApiKeyId: sql<string | null>`null`.as("actor_api_key_id"),
      action: sql<string>`'portal.speaker.claimed'`.as("action"),
      resourceType: sql<string>`'speaker'`.as("resource_type"),
      resourceId: sql<string>`${row.speaker.id}`.as("resource_id"),
      before: sql<Record<string, unknown>>`${JSON.stringify({
        userId: row.speaker.userId,
        speakerVersion: row.speaker.version,
        provisioningStatus: row.provisioning.status,
        provisioningVersion: row.provisioning.version,
      })}`.as("before"),
      after: sql<Record<string, unknown>>`${JSON.stringify({
        userId: actor.userId,
        speakerVersion: nextSpeakerVersion,
        provisioningStatus: "provisioned",
        provisioningVersion: nextProvisioningVersion,
      })}`.as("after"),
      metadata: sql<null>`null`.as("metadata"),
      occurredAt: sql<Date>`${claimedAt.getTime()}`.as("occurred_at"),
    })
      .from(speakerProvisioning)
      .innerJoin(speakers, and(
        eq(speakers.eventId, speakerProvisioning.eventId),
        eq(speakers.id, speakerProvisioning.primarySpeakerId),
      ))
      .where(committedGuard),
  );
  const transitionProvisioning = db.update(speakerProvisioning)
    .set({
      status: "provisioned",
      provisionedAt: claimedAt,
      leaseOwner: null,
      leaseExpiresAt: null,
      lastError: null,
      version: nextProvisioningVersion,
      updatedAt: claimedAt,
    })
    .where(provisioningGuard)
    .returning({ id: speakerProvisioning.id });

  if (testHooks?.beforeCommit) yield* Effect.promise(testHooks.beforeCommit);
  const commit = row.speaker.userId === null
    ? yield* database(() => db.batch([
      db.update(speakers)
        .set({
          userId: actor.userId,
          version: nextSpeakerVersion,
          updatedAt: claimedAt,
        })
        .where(and(
          eq(speakers.eventId, event.id),
          eq(speakers.id, row.speaker.id),
          eq(speakers.version, row.speaker.version),
          isNull(speakers.userId),
          sql`exists (
            select 1 from speaker_provisioning as claim_provisioning
            where claim_provisioning.event_id = ${event.id}
              and claim_provisioning.id = ${row.provisioning.id}
              and claim_provisioning.acceptance_event_id = ${row.acceptance.id}
              and claim_provisioning.primary_speaker_id = ${row.speaker.id}
              and claim_provisioning.version = ${row.provisioning.version}
              and claim_provisioning.status in ('pending', 'retry', 'claimed')
          )`,
          currentAcceptanceGuard,
        ))
        .returning({ id: speakers.id }),
      transitionProvisioning,
      completedIdempotency,
      claimChange,
      claimAudit,
    ])).pipe(Effect.either)
    : yield* database(() => db.batch([
      transitionProvisioning,
      completedIdempotency,
      claimChange,
      claimAudit,
    ])).pipe(Effect.either);

  if (commit._tag === "Left") {
    if (
      commit.left.detail?.includes("idempotency_key_unique") === true ||
      commit.left.detail?.includes("UNIQUE constraint failed: idempotency_records") === true
    ) {
      const racedReplay = yield* findReplay(
        event.id,
        "portal.claimSpeaker",
        actor.userId,
        keyHash,
        requestHash,
      );
      if (racedReplay !== null) {
        return yield* decodeReplay(ClaimSpeakerOutputSchema, racedReplay);
      }
    }
  }

  const [current] = yield* database(() => db
    .select({ speaker: speakers, provisioning: speakerProvisioning })
    .from(speakers)
    .innerJoin(speakerProvisioning, and(
      eq(speakerProvisioning.eventId, speakers.eventId),
      eq(speakerProvisioning.primarySpeakerId, speakers.id),
      eq(speakerProvisioning.id, row.provisioning.id),
    ))
    .where(and(
      eq(speakers.eventId, event.id),
      eq(speakers.id, row.speaker.id),
    ))
    .limit(1));
  if (current?.speaker.userId !== null && current?.speaker.userId !== actor.userId) {
    return yield* Effect.fail(
      new Conflict({ message: "This accepted speaker is already linked to another account" }),
    );
  }
  if (
    current?.speaker.userId === actor.userId &&
    current.provisioning.status === "provisioned"
  ) {
    return {
      eventId: event.id,
      speakerId: current.speaker.id,
      acceptanceEventId: current.provisioning.acceptanceEventId,
      provisioningId: current.provisioning.id,
      speakerVersion: current.speaker.version,
      provisioningVersion: current.provisioning.version,
      provisioningStatus: current.provisioning.status,
    };
  }
  if (commit._tag === "Left") return yield* Effect.fail(commit.left);
  return yield* Effect.fail(
    new Conflict({ message: "The accepted speaker claim changed; retry from the latest event state" }),
  );
});

export const getPortalSnapshot = (input: { readonly eventId: string }): Effect.Effect<PortalSnapshot, AppError, Db | CurrentUser | Files> => Effect.gen(function* () {
  const event = yield* resolveEvent(input.eventId);
  const { speaker, acceptance } = yield* selfSpeaker(event.id);
  const { db } = yield* Db;
  const progress = yield* currentTasks(event.id, speaker.id);
  const [resources, uploaded, pendingRows] = yield* Effect.all([
    database(() => db.select().from(pages).where(and(eq(pages.eventId, event.id), inArray(pages.audience, ["speakers", "public"]))).orderBy(asc(pages.order), asc(pages.id))),
    database(() => db.select().from(assets).where(and(
      eq(assets.eventId, event.id), eq(assets.speakerId, speaker.id), eq(assets.current, true),
    )).orderBy(desc(assets.createdAt))),
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
  const commentRows = uploaded.length === 0 ? [] : yield* database(() => db.select({ comment: assetComments, authorName: users.name }).from(assetComments)
    .innerJoin(users, eq(users.id, assetComments.actorUserId))
    .where(and(eq(assetComments.eventId, event.id), inArray(assetComments.assetId, uploaded.map((asset) => asset.id))))
    .orderBy(asc(assetComments.createdAt), asc(assetComments.id)));
  const uploadedAssets = yield* Effect.forEach(uploaded, (asset) => Effect.gen(function* () {
    const comments = commentRows.filter((row) => row.comment.assetId === asset.id).map((row) => ({
      id: row.comment.id,
      authorName: row.authorName ?? "Speaker",
      body: row.comment.body,
      createdAt: row.comment.createdAt.getTime(),
    }));
    if (asset.id === speaker.headshotAssetId) return { ...assetView(asset, "headshot"), comments };
    const object = yield* head(assetKey(event.id, asset.id));
    const storedPurpose = object?.customMetadata?.portalPurpose;
    const purpose = storedPurpose === "headshot" || storedPurpose === "slides" || storedPurpose === "document"
      ? storedPurpose
      : asset.contentType.includes("presentation")
        ? "slides"
        : "document";
    return { ...assetView(asset, purpose), comments };
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
    submission: acceptance
      ? { id: acceptance.submission.id, title: acceptance.submission.title, category: acceptance.submission.category, version: acceptance.submission.version }
      : null,
    provisioningStatus: "provisioned",
    tasks: progress.taskViews,
    resources: resources.map(resourceView),
    assets: uploadedAssets,
    readiness: progress.readiness,
  };
});

export const updateSpeakerProfile = (input: UpdateProfileInput): Effect.Effect<SpeakerProfile, AppError, AirtableSync | Db | CurrentUser | Rooms> => Effect.gen(function* () {
  const event = yield* resolveEvent(input.eventId);
  const { speaker, actor } = yield* selfSpeaker(event.id);
  const { db } = yield* Db;
  if (speaker.profileReviewStatus === "in_review" || (speaker.profileReviewStatus === "approved" && speaker.profileSubmittedAt !== null)) {
    return yield* Effect.fail(new Conflict({ message: "This event profile is locked while it is in review or approved" }));
  }
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
      const outboundHash = yield* sha256(JSON.stringify({ visible: speaker.visible }));
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
  if (airtableIntegration && changedSyncFields.length > 0) {
    const { broadcast } = yield* Rooms;
    yield* broadcast(event.id, {
      t: "integrations/airtable_sync",
      entityType: "speaker",
      entityId: speaker.id,
      state: "pending",
      fields: changedSyncFields,
    }).pipe(Effect.catchAll(() => Effect.void));
    const sync = yield* AirtableSync;
    yield* sync.wakeEvent(event.id);
  }
  return result;
});

export const importReusableProfile = (input: ImportReusableProfileInput): Effect.Effect<SpeakerProfile, AppError, Db | CurrentUser> => Effect.gen(function* () {
  const event = yield* resolveEvent(input.eventId);
  const { speaker, actor } = yield* selfSpeaker(event.id);
  const { db } = yield* Db;
  if (speaker.version !== input.expectedVersion) {
    return yield* Effect.fail(new Conflict({ message: "Event profile changed; reload before importing" }));
  }
  if (speaker.profileReviewStatus === "in_review" || (speaker.profileReviewStatus === "approved" && speaker.profileSubmittedAt !== null)) {
    return yield* Effect.fail(new Conflict({ message: "This event profile is locked while it is in review or approved" }));
  }
  const [[profile], [airtable]] = yield* Effect.all([
    database(() => db.select().from(speakerProfiles).where(eq(speakerProfiles.userId, actor.userId)).limit(1)),
    database(() => db.select({ id: integrations.id }).from(integrations).where(and(
      eq(integrations.eventId, event.id),
      eq(integrations.kind, "airtable"),
    )).limit(1)),
  ], { concurrency: 1 });
  if (!profile) return yield* Effect.fail(new NotFound({ entity: "reusable speaker profile", id: actor.userId }));
  if (airtable) {
    return yield* Effect.fail(new Conflict({ message: "Reusable profile import is unavailable while Airtable owns event profile fields" }));
  }
  const updatedAt = now();
  const version = speaker.version + 1;
  const values = {
    displayName: profile.displayName,
    title: profile.title,
    company: profile.company,
    bio: profile.bio,
    headshotUrl: profile.headshotUrl,
    links: profile.links ?? [],
    profileSourceId: profile.id,
    profileSourceVersion: profile.version,
    profileReviewStatus: "draft" as const,
    profileReviewNote: null,
    profileSubmittedAt: null,
    profileReviewedAt: null,
    profileReviewedBy: null,
    version,
    updatedAt,
  };
  const result = speakerView({ ...speaker, ...values });
  const guard = and(eq(speakers.eventId, event.id), eq(speakers.id, speaker.id), eq(speakers.version, input.expectedVersion));
  const requestId = id("portal_request");
  const change = writeChange(event.id, "speaker", speaker.id, version, "portal.profile.reusable-imported", {
    speakerId: speaker.id,
    profileId: profile.id,
    profileVersion: profile.version,
  }, actor, updatedAt, requestId);
  const committed = yield* database(() => db.batch([
    db.insert(domainChanges).select(db.select(changeSelection(change)).from(speakers).where(guard)),
    db.insert(auditLog).select(db.select({
      id: sql<string>`${id("audit")}`.as("id"),
      eventId: speakers.eventId,
      requestId: sql<string>`${requestId}`.as("request_id"),
      actorUserId: sql<string | null>`${actor.actorUserId}`.as("actor_user_id"),
      actorApiKeyId: sql<string | null>`${actor.actorApiKeyId}`.as("actor_api_key_id"),
      action: sql<string>`${"portal.profile.reusable-imported"}`.as("action"),
      resourceType: sql<string>`${"speaker"}`.as("resource_type"),
      resourceId: speakers.id,
      before: sql<unknown>`${JSON.stringify(speakerView(speaker))}`.as("before"),
      after: sql<unknown>`${JSON.stringify(result)}`.as("after"),
      metadata: sql<unknown>`${JSON.stringify({ profileId: profile.id, profileVersion: profile.version })}`.as("metadata"),
      occurredAt: sql<Date>`${updatedAt.getTime()}`.as("occurred_at"),
    }).from(speakers).where(guard)),
    db.update(speakers).set(values).where(guard).returning(),
  ]));
  if ((committed[2] as (typeof speakers.$inferSelect)[]).length === 0) {
    return yield* Effect.fail(new Conflict({ message: "Event profile changed; reload before importing" }));
  }
  return result;
});

export const submitProfileReview = (input: SubmitProfileReviewInput): Effect.Effect<SpeakerProfile, AppError, Db | CurrentUser> => Effect.gen(function* () {
  const event = yield* resolveEvent(input.eventId);
  const { speaker, actor } = yield* selfSpeaker(event.id);
  const { db } = yield* Db;
  if (speaker.version !== input.expectedVersion) return yield* Effect.fail(new Conflict({ message: "Event profile changed; reload before submitting" }));
  if (speaker.profileReviewStatus !== "draft" && speaker.profileReviewStatus !== "changes_requested") {
    return yield* Effect.fail(new Conflict({ message: "Only a draft or changes-requested profile can be submitted" }));
  }
  if (!speaker.bio?.trim()) return yield* Effect.fail(new Validation({ message: "Add a biography before submitting this profile" }));
  const submittedAt = now();
  const version = speaker.version + 1;
  const values = {
    profileReviewStatus: "in_review" as const,
    profileSubmittedAt: submittedAt,
    profileReviewNote: null,
    profileReviewedAt: null,
    profileReviewedBy: null,
    version,
    updatedAt: submittedAt,
  };
  const result = speakerView({ ...speaker, ...values });
  const guard = and(eq(speakers.eventId, event.id), eq(speakers.id, speaker.id), eq(speakers.version, input.expectedVersion));
  const requestId = id("portal_request");
  const change = writeChange(event.id, "speaker", speaker.id, version, "portal.profile.submitted", { speakerId: speaker.id }, actor, submittedAt, requestId);
  const committed = yield* database(() => db.batch([
    db.insert(domainChanges).select(db.select(changeSelection(change)).from(speakers).where(guard)),
    db.insert(auditLog).select(db.select({
      id: sql<string>`${id("audit")}`.as("id"), eventId: speakers.eventId,
      requestId: sql<string>`${requestId}`.as("request_id"),
      actorUserId: sql<string | null>`${actor.actorUserId}`.as("actor_user_id"),
      actorApiKeyId: sql<string | null>`${actor.actorApiKeyId}`.as("actor_api_key_id"),
      action: sql<string>`${"portal.profile.submitted"}`.as("action"), resourceType: sql<string>`${"speaker"}`.as("resource_type"),
      resourceId: speakers.id, before: sql<unknown>`${JSON.stringify(speakerView(speaker))}`.as("before"),
      after: sql<unknown>`${JSON.stringify(result)}`.as("after"), metadata: sql<unknown>`null`.as("metadata"),
      occurredAt: sql<Date>`${submittedAt.getTime()}`.as("occurred_at"),
    }).from(speakers).where(guard)),
    db.update(speakers).set(values).where(guard).returning(),
  ]));
  if ((committed[2] as (typeof speakers.$inferSelect)[]).length === 0) return yield* Effect.fail(new Conflict({ message: "Event profile changed; reload before submitting" }));
  return result;
});

export const reviewSpeakerProfile = (input: ReviewSpeakerProfileInput): Effect.Effect<SpeakerProfile, AppError, Authorizer | CurrentUser | Db> => Effect.gen(function* () {
  const actor = yield* organizerBrowser(input.eventId);
  if (input.decision === "changes_requested" && !input.note?.trim()) {
    return yield* Effect.fail(new Validation({ message: "Explain the changes the speaker needs to make" }));
  }
  const { db } = yield* Db;
  const [speaker] = yield* database(() => db.select().from(speakers).where(and(
    eq(speakers.eventId, input.eventId), eq(speakers.id, input.speakerId),
  )).limit(1));
  if (!speaker) return yield* Effect.fail(new NotFound({ entity: "speaker", id: input.speakerId }));
  if (speaker.version !== input.expectedVersion) return yield* Effect.fail(new Conflict({ message: "Speaker profile changed; reload before reviewing" }));
  if (speaker.profileReviewStatus !== "in_review") return yield* Effect.fail(new Conflict({ message: "Only a submitted profile can be reviewed" }));
  const reviewedAt = now();
  const version = speaker.version + 1;
  const values = {
    profileReviewStatus: input.decision,
    profileReviewNote: input.note?.trim() || null,
    profileReviewedAt: reviewedAt,
    profileReviewedBy: actor.userId,
    version,
    updatedAt: reviewedAt,
  };
  const result = speakerView({ ...speaker, ...values });
  const guard = and(eq(speakers.eventId, input.eventId), eq(speakers.id, input.speakerId), eq(speakers.version, input.expectedVersion));
  const requestId = id("portal_request");
  const eventType = input.decision === "approved" ? "portal.profile.approved" : "portal.profile.changes-requested";
  const change = writeChange(input.eventId, "speaker", speaker.id, version, eventType, { speakerId: speaker.id, note: values.profileReviewNote }, actor, reviewedAt, requestId);
  const committed = yield* database(() => db.batch([
    db.insert(domainChanges).select(db.select(changeSelection(change)).from(speakers).where(guard)),
    db.insert(auditLog).select(db.select({
      id: sql<string>`${id("audit")}`.as("id"), eventId: speakers.eventId,
      requestId: sql<string>`${requestId}`.as("request_id"), actorUserId: sql<string>`${actor.userId}`.as("actor_user_id"),
      actorApiKeyId: sql<string | null>`null`.as("actor_api_key_id"), action: sql<string>`${eventType}`.as("action"),
      resourceType: sql<string>`${"speaker"}`.as("resource_type"), resourceId: speakers.id,
      before: sql<unknown>`${JSON.stringify(speakerView(speaker))}`.as("before"), after: sql<unknown>`${JSON.stringify(result)}`.as("after"),
      metadata: sql<unknown>`${JSON.stringify({ note: values.profileReviewNote })}`.as("metadata"),
      occurredAt: sql<Date>`${reviewedAt.getTime()}`.as("occurred_at"),
    }).from(speakers).where(guard)),
    db.update(speakers).set(values).where(guard).returning(),
  ]));
  if ((committed[2] as (typeof speakers.$inferSelect)[]).length === 0) return yield* Effect.fail(new Conflict({ message: "Speaker profile changed; reload before reviewing" }));
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
  const data = yield* decodeBase64(input.contentBase64, input.purpose);
  const policyError = uploadPolicy(
    input.purpose,
    input.contentType,
    input.filename,
    data,
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
    const taskPurpose = inferUploadTaskPurpose(found);
    if (taskPurpose !== null && taskPurpose !== input.purpose) {
      return yield* Effect.fail(
        new Validation({ message: `The ${found.name} task cannot be completed by a ${input.purpose} upload` }),
      );
    }
    if (found.targetMode === "selected") {
      const [assignment] = yield* database(() => db.select({ id: taskAssignments.id }).from(taskAssignments).where(and(
        eq(taskAssignments.eventId, event.id),
        eq(taskAssignments.taskId, found.id),
        eq(taskAssignments.speakerId, speaker.id),
      )).limit(1));
      if (!assignment) {
        return yield* Effect.fail(new Forbidden({ reason: "This upload task is not assigned to the current speaker" }));
      }
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
  const [oldAsset] = yield* database(() => db.select({ id: assets.id, version: assets.version }).from(assets).where(and(
    eq(assets.eventId, event.id), eq(assets.speakerId, speaker.id),
    eq(assets.purpose, input.purpose), eq(assets.current, true),
  )).orderBy(desc(assets.version), desc(assets.createdAt)).limit(1));
  const oldAssetId = oldAsset?.id ?? null;
  const assetRecord = {
    id: assetId,
    eventId: event.id,
    uploaderUserId: actor.userId,
    speakerId: speaker.id,
    purpose: input.purpose,
    supersedesAssetId: oldAssetId,
    restoredFromAssetId: null,
    current: true,
    filename,
    contentType: input.contentType,
    size: data.byteLength,
    version: (oldAsset?.version ?? 0) + 1,
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
  const updatedReadiness = readiness(
    before.definitions,
    completion ? [...before.completions.filter((candidate) => candidate.taskId !== completion.taskId), completion] : before.completions,
  );
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
    readiness: updatedReadiness,
  };

  const requestId = id("portal_request");
  const statements = [
    ...(oldAssetId ? [db.update(assets).set({ current: false, updatedAt: uploadedAt }).where(and(
      eq(assets.eventId, event.id), eq(assets.id, oldAssetId), eq(assets.current, true),
    ))] : []),
    db.insert(assets).values(assetRecord),
  ] as unknown as [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]];
  if (input.purpose === "headshot") {
    const headshotChange = writeChange(
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
    );
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
      db.insert(domainChanges).values(headshotChange),
      db.insert(domainChanges).select(db.select(changeSelection(headshotChange)).from(speakers).where(and(
        eq(speakers.eventId, event.id),
        eq(speakers.id, speaker.id),
        or(ne(speakers.version, nextSpeakerVersion), ne(speakers.headshotAssetId, assetId)),
      ))),
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
  const [rows, assignments] = yield* Effect.all([
    database(() => db.select().from(tasks).where(eq(tasks.eventId, input.eventId)).orderBy(asc(tasks.order), asc(tasks.id))),
    database(() => db.select().from(taskAssignments).where(eq(taskAssignments.eventId, input.eventId))),
  ]);
  return rows.map((task) => taskDefinitionView(
    task,
    assignments.filter((assignment) => assignment.taskId === task.id).map((assignment) => assignment.speakerId),
  ));
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
  const requestedSpeakerIds = input.speakerIds ?? [];
  const speakerIds = [...new Set(requestedSpeakerIds)];
  if (speakerIds.length !== requestedSpeakerIds.length) return yield* Effect.fail(new Validation({ message: "Task speaker selection contains duplicates" }));
  if (speakerIds.length > 0) {
    const selected = yield* database(() => db.select({ id: speakers.id }).from(speakers).where(and(
      eq(speakers.eventId, input.eventId),
      inArray(speakers.id, speakerIds),
    )));
    if (selected.length !== speakerIds.length) return yield* Effect.fail(new Validation({ message: "Every task assignee must be an event speaker" }));
  }
  const createdAt = now();
  const task = { id: id("task"), eventId: input.eventId, name: input.name, description: input.description, kind: input.kind, formId: input.formId, dueAt: input.dueAt === null ? null : new Date(input.dueAt), order: input.order, targetMode: speakerIds.length === 0 ? "all" as const : "selected" as const, version: 1, createdAt, updatedAt: createdAt };
  yield* database(() => db.batch([
    db.insert(tasks).values(task),
    ...(speakerIds.length > 0 ? [db.insert(taskAssignments).values(speakerIds.map((speakerId) => ({
      id: id("task_assignment"), eventId: input.eventId, taskId: task.id, speakerId, createdAt,
    })))] : []),
    db.insert(domainChanges).values(writeChange(input.eventId, "task", task.id, 1, "portal.task.created", { taskId: task.id, speakerIds }, actor, createdAt)),
  ]));
  return taskDefinitionView(task, speakerIds);
});

export const updatePortalTask = (input: UpdateTaskInput): Effect.Effect<PortalTaskDefinition, AppError, Db | CurrentUser | Authorizer> => Effect.gen(function* () {
  const actor = yield* organizer(input.eventId, "speakers:write");
  if ((input.kind === "form") !== (input.formId !== null)) {
    return yield* Effect.fail(
      new Validation({ message: "Form tasks require a formId and other task types must not include one" }),
    );
  }
  const { db } = yield* Db;
  const requestedSpeakerIds = input.speakerIds ?? [];
  const speakerIds = [...new Set(requestedSpeakerIds)];
  if (speakerIds.length !== requestedSpeakerIds.length) return yield* Effect.fail(new Validation({ message: "Task speaker selection contains duplicates" }));
  const [existing] = yield* database(() => db.select({ version: tasks.version }).from(tasks).where(and(
    eq(tasks.eventId, input.eventId), eq(tasks.id, input.taskId),
  )).limit(1));
  if (!existing || existing.version !== input.expectedVersion) return yield* Effect.fail(new Conflict({ message: "Task changed; reload before saving" }));
  if (speakerIds.length > 0) {
    const selected = yield* database(() => db.select({ id: speakers.id }).from(speakers).where(and(
      eq(speakers.eventId, input.eventId), inArray(speakers.id, speakerIds),
    )));
    if (selected.length !== speakerIds.length) return yield* Effect.fail(new Validation({ message: "Every task assignee must be an event speaker" }));
  }
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
  const assignmentCommitMarker = and(
    eq(domainChanges.eventId, input.eventId),
    eq(domainChanges.id, change.id),
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
        targetMode: speakerIds.length === 0 ? "all" : "selected",
        version,
        updatedAt,
      })
      .where(guard)
      .returning(),
    db.delete(taskAssignments).where(and(
      eq(taskAssignments.eventId, input.eventId),
      eq(taskAssignments.taskId, input.taskId),
      sql`exists (select 1 from domain_changes where event_id = ${input.eventId} and id = ${change.id})`,
    )),
    ...speakerIds.map((speakerId) => db.insert(taskAssignments).select(
      db.select({
        id: sql<string>`${id("task_assignment")}`.as("id"),
        eventId: domainChanges.eventId,
        taskId: sql<string>`${input.taskId}`.as("task_id"),
        speakerId: sql<string>`${speakerId}`.as("speaker_id"),
        createdAt: sql<Date>`${updatedAt.getTime()}`.as("created_at"),
      }).from(domainChanges).where(assignmentCommitMarker),
    )),
  ]));
  const updated = updatedRows[0];
  if (!updated) {
    return yield* Effect.fail(new Conflict({ message: "Task changed; reload before saving" }));
  }
  return taskDefinitionView(updated, speakerIds);
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
  const directory = yield* getSpeakerDirectory({ eventId: input.eventId });
  const provisioned = directory.speakers.find((item) => item.speaker.id === row.speaker.id);
  if (!provisioned) {
    return yield* Effect.fail(new NotFound({ entity: "speaker", id: row.speaker.id }));
  }
  return provisioned;
});

export const updateSpeakerPublication = (input: UpdateSpeakerPublicationInput): Effect.Effect<SpeakerProfile, AppError, Db | CurrentUser | Authorizer> => Effect.gen(function* () {
  const actor = yield* organizer(input.eventId, "speakers:write");
  const { db } = yield* Db;
  const [current] = yield* database(() => db.select({
    version: speakers.version,
    profileReviewStatus: speakers.profileReviewStatus,
  }).from(speakers).where(and(eq(speakers.eventId, input.eventId), eq(speakers.id, input.speakerId))).limit(1));
  if (!current) return yield* Effect.fail(new NotFound({ entity: "speaker", id: input.speakerId }));
  if (current.version !== input.expectedVersion) return yield* Effect.fail(new Conflict({ message: "Speaker changed; reload before changing publication" }));
  if (input.visible && current.profileReviewStatus !== "approved") {
    return yield* Effect.fail(new Validation({ message: "Approve the event profile before making this speaker publicly visible" }));
  }
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
  const airtableProjection = yield* database(() => prepareAirtableProjection(db, {
    eventId: input.eventId,
    entityType: "speaker",
    entityId: input.speakerId,
    entityVersion: version,
    changedFields: { visible: input.visible },
    d1Projection: { visible: input.visible },
    origin: "portal.updateSpeakerPublication",
    idempotencyKey: `portal.updateSpeakerPublication:${input.speakerId}:${version}`,
    now: updatedAt,
  }));
  const results = yield* database(() => db.batch([
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
    ...(airtableProjection ? [airtableProjection.statement] : []),
  ] as never));
  const updatedRows = results[2] as (typeof speakers.$inferSelect)[];
  const updated = updatedRows[0];
  if (!updated) {
    return yield* Effect.fail(
      new Conflict({ message: "Speaker changed; reload before changing publication" }),
    );
  }
  return speakerView(updated);
});

export const createManagedSpeaker = (input: CreateManagedSpeakerInput): Effect.Effect<SpeakerProfile, AppError, Db | CurrentUser | Authorizer> => Effect.gen(function* () {
  const actor = yield* organizer(input.eventId, "speakers:write");
  yield* requireEvent(input.eventId);
  const { db } = yield* Db;
  const principalId = actor.actorApiKeyId ?? actor.userId;
  const { keyHash, requestHash } = yield* commandHashes(input.idempotencyKey, input);
  const replay = yield* findReplay(input.eventId, "portal.createManagedSpeaker", principalId, keyHash, requestHash);
  if (replay !== null) return yield* decodeReplay(SpeakerProfileSchema, replay);
  const contactEmail = input.contactEmail.trim().toLowerCase();
  const [duplicate] = yield* database(() => db.select({ id: speakers.id }).from(speakers).where(and(
    eq(speakers.eventId, input.eventId),
    sql`lower(${speakers.contactEmail}) = ${contactEmail}`,
  )).limit(1));
  if (duplicate) return yield* Effect.fail(new Conflict({ message: "A speaker with this contact email already exists" }));
  const createdAt = now();
  const record: typeof speakers.$inferInsert = {
    id: id("speaker"),
    eventId: input.eventId,
    userId: null,
    contactEmail,
    displayName: input.displayName.trim(),
    title: input.title?.trim() || null,
    company: input.company?.trim() || null,
    bio: input.bio?.trim() || null,
    workflowStatus: input.workflowStatus.trim(),
    headshotAssetId: null,
    headshotUrl: null,
    links: [],
    visible: input.visible,
    profileSourceId: null,
    profileSourceVersion: null,
    profileReviewStatus: "in_review",
    profileReviewNote: null,
    profileSubmittedAt: createdAt,
    profileReviewedAt: null,
    profileReviewedBy: null,
    version: 1,
    createdAt,
    updatedAt: createdAt,
  };
  const result = speakerView(record as typeof speakers.$inferSelect);
  const idempotency = idempotencyInsert(input.eventId, "portal.createManagedSpeaker", principalId, keyHash, requestHash, createdAt);
  const requestId = id("portal_request");
  const committed = yield* database(() => db.batch([
    db.insert(idempotencyRecords).values(idempotency),
    db.insert(speakers).values(record),
    db.insert(managedSpeakerEmails).values({
      id: id("managed_email"), eventId: input.eventId, normalizedEmail: contactEmail,
      speakerId: record.id, createdAt, updatedAt: createdAt,
    }),
    db.insert(domainChanges).values(writeChange(
      input.eventId, "speaker", record.id, 1, "portal.speaker.managed.created",
      { speakerId: record.id, source: "manual" }, actor, createdAt, requestId, idempotency.id,
    )),
    db.insert(auditLog).values({
      id: id("audit"), eventId: input.eventId, requestId,
      actorUserId: actor.actorUserId, actorApiKeyId: actor.actorApiKeyId,
      action: "portal.speaker.managed.created", resourceType: "speaker", resourceId: record.id,
      before: null, after: result, metadata: { source: "manual" }, occurredAt: createdAt,
    }),
    db.update(idempotencyRecords).set({
      status: "completed", responseStatus: 201, responseBody: result, completedAt: createdAt,
    }).where(eq(idempotencyRecords.id, idempotency.id)),
  ])).pipe(Effect.either);
  if (committed._tag === "Left") {
    const racedReplay = yield* findReplay(input.eventId, "portal.createManagedSpeaker", principalId, keyHash, requestHash);
    if (racedReplay !== null) return yield* decodeReplay(SpeakerProfileSchema, racedReplay);
    const [racedDuplicate] = yield* database(() => db.select({ id: speakers.id }).from(speakers).where(and(
      eq(speakers.eventId, input.eventId), sql`lower(${speakers.contactEmail}) = ${contactEmail}`,
    )).limit(1));
    if (racedDuplicate) return yield* Effect.fail(new Conflict({ message: "A speaker with this contact email already exists" }));
    return yield* Effect.fail(committed.left);
  }
  return result;
});

export const updateManagedSpeaker = (input: UpdateManagedSpeakerInput): Effect.Effect<SpeakerProfile, AppError, Db | CurrentUser | Authorizer> => Effect.gen(function* () {
  const actor = yield* organizer(input.eventId, "speakers:write");
  const { db } = yield* Db;
  const [existingRows, managedRows, airtableRows] = yield* Effect.all([
    database(() => db.select().from(speakers).where(and(
      eq(speakers.eventId, input.eventId), eq(speakers.id, input.speakerId),
    )).limit(1)),
    database(() => db.select({ id: managedSpeakerEmails.id }).from(managedSpeakerEmails).where(and(
      eq(managedSpeakerEmails.eventId, input.eventId), eq(managedSpeakerEmails.speakerId, input.speakerId),
    )).limit(1)),
    database(() => db.select({ id: airtableRecordLinks.id }).from(airtableRecordLinks).where(and(
      eq(airtableRecordLinks.eventId, input.eventId),
      eq(airtableRecordLinks.entityType, "speaker"),
      eq(airtableRecordLinks.entityId, input.speakerId),
    )).limit(1)),
  ]);
  const existing = existingRows[0];
  if (!existing) return yield* Effect.fail(new NotFound({ entity: "speaker", id: input.speakerId }));
  if (!managedRows[0] || airtableRows[0]) {
    return yield* Effect.fail(new Conflict({
      message: "Only directly managed, non-Airtable speaker profiles can be edited here",
    }));
  }
  if (existing.version !== input.expectedVersion) return yield* Effect.fail(new Conflict({ message: "Speaker changed; reload before saving" }));
  const contactEmail = input.contactEmail.trim().toLowerCase();
  const duplicate = yield* database(() => db.select({ id: speakers.id }).from(speakers).where(and(
    eq(speakers.eventId, input.eventId),
    sql`lower(${speakers.contactEmail}) = ${contactEmail}`,
  )).limit(2).then((rows) => rows.find((row) => row.id !== input.speakerId)));
  if (duplicate) return yield* Effect.fail(new Conflict({ message: "A speaker with this contact email already exists" }));
  const [claimedEmail] = yield* database(() => db.select({ speakerId: managedSpeakerEmails.speakerId }).from(managedSpeakerEmails).where(and(
    eq(managedSpeakerEmails.eventId, input.eventId), eq(managedSpeakerEmails.normalizedEmail, contactEmail),
  )).limit(1));
  if (claimedEmail && claimedEmail.speakerId !== input.speakerId) {
    return yield* Effect.fail(new Conflict({ message: "A speaker with this contact email already exists" }));
  }
  const updatedAt = now();
  const version = input.expectedVersion + 1;
  const guard = and(eq(speakers.eventId, input.eventId), eq(speakers.id, input.speakerId), eq(speakers.version, input.expectedVersion));
  const values = {
    contactEmail,
    displayName: input.displayName.trim(),
    title: input.title?.trim() || null,
    company: input.company?.trim() || null,
    bio: input.bio?.trim() || null,
    workflowStatus: input.workflowStatus.trim(),
    visible: input.visible,
    profileReviewStatus: "in_review" as const,
    profileReviewNote: null,
    profileSubmittedAt: updatedAt,
    profileReviewedAt: null,
    profileReviewedBy: null,
    version,
    updatedAt,
  };
  const requestId = id("portal_request");
  const change = writeChange(
    input.eventId, "speaker", input.speakerId, version, "portal.speaker.managed.updated",
    { speakerId: input.speakerId, workflowStatus: values.workflowStatus }, actor, updatedAt, requestId,
  );
  const audit = {
    id: id("audit"), eventId: input.eventId, requestId,
    actorUserId: actor.actorUserId, actorApiKeyId: actor.actorApiKeyId,
    action: "portal.speaker.managed.updated", resourceType: "speaker", resourceId: input.speakerId,
    before: speakerView(existing), after: speakerView({ ...existing, ...values }), metadata: null, occurredAt: updatedAt,
  };
  const committed = yield* database(() => db.batch([
    db.insert(domainChanges).values(change),
    db.update(speakers).set(values).where(guard).returning(),
    db.delete(managedSpeakerEmails).where(and(
      eq(managedSpeakerEmails.eventId, input.eventId), eq(managedSpeakerEmails.speakerId, input.speakerId),
    )),
    db.insert(managedSpeakerEmails).values({
      id: id("managed_email"), eventId: input.eventId, normalizedEmail: contactEmail,
      speakerId: input.speakerId, createdAt: updatedAt, updatedAt,
    }),
    db.insert(domainChanges).select(db.select(changeSelection(change)).from(speakers).where(and(
      eq(speakers.eventId, input.eventId), eq(speakers.id, input.speakerId),
      or(
        ne(speakers.version, version),
        ne(speakers.contactEmail, contactEmail),
        ne(speakers.displayName, values.displayName),
        sql`${speakers.title} is not ${values.title}`,
        sql`${speakers.company} is not ${values.company}`,
        sql`${speakers.bio} is not ${values.bio}`,
        ne(speakers.workflowStatus, values.workflowStatus),
        ne(speakers.visible, values.visible),
        ne(speakers.updatedAt, updatedAt),
      ),
    ))),
    db.insert(auditLog).select(db.select({
      id: sql<string>`${audit.id}`.as("id"),
      eventId: speakers.eventId,
      requestId: sql<string>`${audit.requestId}`.as("request_id"),
      actorUserId: sql<string | null>`${audit.actorUserId}`.as("actor_user_id"),
      actorApiKeyId: sql<string | null>`${audit.actorApiKeyId}`.as("actor_api_key_id"),
      action: sql<string>`${audit.action}`.as("action"),
      resourceType: sql<string>`${audit.resourceType}`.as("resource_type"),
      resourceId: speakers.id,
      before: sql<unknown>`${JSON.stringify(audit.before)}`.as("before"),
      after: sql<unknown>`${JSON.stringify(audit.after)}`.as("after"),
      metadata: sql<null>`null`.as("metadata"),
      occurredAt: sql<Date>`${updatedAt.getTime()}`.as("occurred_at"),
    }).from(speakers).where(and(
      eq(speakers.eventId, input.eventId), eq(speakers.id, input.speakerId),
      eq(speakers.version, version), eq(speakers.updatedAt, updatedAt),
    ))),
  ])).pipe(Effect.either);
  if (committed._tag === "Left") {
    const [emailOwner, currentRows] = yield* Effect.all([
      database(() => db.select({ id: speakers.id }).from(speakers).where(and(
      eq(speakers.eventId, input.eventId), sql`lower(${speakers.contactEmail}) = ${contactEmail}`,
      )).limit(1).then((rows) => rows[0])),
      database(() => db.select({ version: speakers.version }).from(speakers).where(and(
        eq(speakers.eventId, input.eventId), eq(speakers.id, input.speakerId),
      )).limit(1)),
    ]);
    if (emailOwner && emailOwner.id !== input.speakerId) {
      return yield* Effect.fail(new Conflict({ message: "A speaker with this contact email already exists" }));
    }
    if (currentRows[0]?.version !== input.expectedVersion) {
      return yield* Effect.fail(new Conflict({ message: "Speaker changed; reload before saving" }));
    }
    return yield* Effect.fail(committed.left);
  }
  const updatedRows = committed.right[1] as (typeof speakers.$inferSelect)[];
  const updated = updatedRows[0];
  if (!updated) return yield* Effect.fail(new Conflict({ message: "Speaker changed; reload before saving" }));
  return speakerView(updated);
});

export const uploadManagedSpeakerHeadshot = (input: UploadManagedSpeakerHeadshotInput): Effect.Effect<ContentAsset, AppError, Db | CurrentUser | Authorizer | Files> => Effect.gen(function* () {
  const actor = yield* organizer(input.eventId, "content:write");
  const data = yield* decodeBase64(input.contentBase64, "headshot");
  const policyError = uploadPolicy("headshot", input.contentType, input.filename, data);
  if (policyError) return yield* Effect.fail(policyError);
  const { db } = yield* Db;
  const contentHash = yield* sha256(input.contentBase64);
  const { keyHash, requestHash } = yield* commandHashes(input.idempotencyKey, { ...input, contentBase64: contentHash });
  const principalId = actor.actorApiKeyId ?? actor.userId;
  const replay = yield* findReplay(input.eventId, "portal.uploadManagedSpeakerHeadshot", principalId, keyHash, requestHash);
  if (replay !== null) return yield* decodeReplay(ContentAssetSchema, replay);
  const [speaker] = yield* database(() => db.select().from(speakers).where(and(
    eq(speakers.eventId, input.eventId), eq(speakers.id, input.speakerId),
  )).limit(1));
  if (!speaker) return yield* Effect.fail(new NotFound({ entity: "speaker", id: input.speakerId }));
  if (speaker.version !== input.expectedVersion) return yield* Effect.fail(new Conflict({ message: "Speaker changed; reload before uploading the headshot" }));
  const [oldAsset] = yield* database(() => db.select().from(assets).where(and(
    eq(assets.eventId, input.eventId), eq(assets.speakerId, speaker.id),
    eq(assets.purpose, "headshot"), eq(assets.current, true),
  )).orderBy(desc(assets.version), desc(assets.createdAt)).limit(1));
  const uploadedAt = now();
  const assetId = id("portal_asset");
  const nextAssetVersion = (oldAsset?.version ?? 0) + 1;
  const key = assetKey(input.eventId, assetId);
  const { put, delete: deleteFile } = yield* Files;
  yield* put(key, data, {
    httpMetadata: { contentType: input.contentType, contentDisposition: "inline" },
    customMetadata: { portalPurpose: "headshot", speakerId: speaker.id, organizerManaged: "true" },
  });
  const record = idempotencyInsert(input.eventId, "portal.uploadManagedSpeakerHeadshot", principalId, keyHash, requestHash, uploadedAt);
  const assetRecord: typeof assets.$inferInsert = {
    id: assetId, eventId: input.eventId, uploaderUserId: actor.userId, speakerId: speaker.id,
    purpose: "headshot", supersedesAssetId: oldAsset?.id ?? null, restoredFromAssetId: null, current: true,
    filename: input.filename.trim(), contentType: input.contentType, size: data.byteLength,
    version: nextAssetVersion, createdAt: uploadedAt, updatedAt: uploadedAt,
  };
  const sessionLinks = (yield* loadSpeakerSessions(input.eventId, [speaker.id])).get(speaker.id) ?? [];
  const result: ContentAsset = {
    ...assetView(assetRecord as typeof assets.$inferSelect, "headshot"),
    speakerId: speaker.id, speakerName: speaker.displayName, current: true,
    speakerVersion: speaker.version + 1,
    sessionTitles: sessionLinks.map(({ title }) => title), sessionLinks, versionCount: nextAssetVersion,
    supersedesAssetId: oldAsset?.id ?? null, restoredFromAssetId: null,
    uploadedAt: uploadedAt.getTime(), comments: [],
  };
  const requestId = id("portal_request");
  const change = writeChange(
    input.eventId, "speaker", speaker.id, speaker.version + 1, "portal.speaker.headshot.managed.updated",
    { speakerId: speaker.id, assetId }, actor, uploadedAt, requestId, record.id,
  );
  const statements = [
    db.insert(idempotencyRecords).values(record),
    ...(oldAsset ? [db.update(assets).set({ current: false, updatedAt: uploadedAt }).where(and(
      eq(assets.eventId, input.eventId), eq(assets.id, oldAsset.id), eq(assets.current, true),
    ))] : []),
    db.insert(assets).values(assetRecord),
  ] as unknown as [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]];
  statements.push(
    db.update(speakers).set({ headshotAssetId: assetId, version: speaker.version + 1, updatedAt: uploadedAt }).where(and(
      eq(speakers.eventId, input.eventId), eq(speakers.id, speaker.id), eq(speakers.version, input.expectedVersion),
    )),
    db.insert(domainChanges).values(change),
    db.insert(domainChanges).select(db.select(changeSelection(change)).from(speakers).where(and(
      eq(speakers.eventId, input.eventId), eq(speakers.id, speaker.id),
      or(ne(speakers.version, speaker.version + 1), ne(speakers.headshotAssetId, assetId)),
    ))),
    db.insert(auditLog).values({
      id: id("audit"), eventId: input.eventId, requestId,
      actorUserId: actor.actorUserId, actorApiKeyId: actor.actorApiKeyId,
      action: "portal.speaker.headshot.managed.updated", resourceType: "speaker", resourceId: speaker.id,
      before: { headshotAssetId: speaker.headshotAssetId }, after: result, metadata: null, occurredAt: uploadedAt,
    }),
    db.update(idempotencyRecords).set({ status: "completed", responseStatus: 201, responseBody: result, completedAt: uploadedAt }).where(eq(idempotencyRecords.id, record.id)),
  );
  const committed = yield* database(() => db.batch(statements)).pipe(Effect.either);
  if (committed._tag === "Left") {
    yield* deleteFile(key).pipe(Effect.catchAll(() => Effect.void));
    const [racedSpeaker] = yield* database(() => db.select({ version: speakers.version, headshotAssetId: speakers.headshotAssetId }).from(speakers).where(and(
      eq(speakers.eventId, input.eventId), eq(speakers.id, input.speakerId),
    )).limit(1));
    if (!racedSpeaker || racedSpeaker.version !== input.expectedVersion || racedSpeaker.headshotAssetId !== speaker.headshotAssetId) {
      return yield* Effect.fail(new Conflict({ message: "Speaker changed; reload before uploading the headshot" }));
    }
    return yield* Effect.fail(committed.left);
  }
  return result;
});

export const importSpeakersCsv = (input: ImportSpeakersCsvInput): Effect.Effect<ImportSpeakersCsvOutput, AppError, Db | CurrentUser | Authorizer> => Effect.gen(function* () {
  const actor = yield* organizer(input.eventId, "speakers:write");
  yield* requireEvent(input.eventId);
  const { db } = yield* Db;
  const { keyHash, requestHash } = yield* commandHashes(input.idempotencyKey, input);
  const principalId = actor.actorApiKeyId ?? actor.userId;
  const replay = yield* findReplay(input.eventId, "portal.importSpeakersCsv", principalId, keyHash, requestHash);
  if (replay !== null) return { ...(yield* decodeReplay(ImportSpeakersCsvOutputSchema, replay)), idempotent: true };
  const rows = yield* parseCsv(input.csv);
  if (rows.length < 2) return yield* Effect.fail(new Validation({ message: "CSV must include a header and at least one speaker row" }));
  const headers = rows[0]!.map((header) => header.trim().toLowerCase().replaceAll(/[^a-z0-9]+/g, ""));
  const indexOf = (...names: readonly string[]) => headers.findIndex((header) => names.includes(header));
  const nameIndex = indexOf("displayname", "name", "speakername");
  const emailIndex = indexOf("contactemail", "email", "speakeremail");
  if (nameIndex < 0 || emailIndex < 0) return yield* Effect.fail(new Validation({ message: "CSV requires displayName (or name) and contactEmail (or email) columns" }));
  const titleIndex = indexOf("title", "jobtitle");
  const companyIndex = indexOf("company", "organization");
  const bioIndex = indexOf("bio", "biography");
  const statusIndex = indexOf("workflowstatus", "status");
  const visibleIndex = indexOf("visible", "published");
  const [existing, managedClaims, airtableLinks] = yield* Effect.all([
    database(() => db.select().from(speakers).where(eq(speakers.eventId, input.eventId))),
    database(() => db.select({ speakerId: managedSpeakerEmails.speakerId }).from(managedSpeakerEmails)
      .where(eq(managedSpeakerEmails.eventId, input.eventId))),
    database(() => db.select({ entityId: airtableRecordLinks.entityId }).from(airtableRecordLinks).where(and(
      eq(airtableRecordLinks.eventId, input.eventId), eq(airtableRecordLinks.entityType, "speaker"),
    ))),
  ]);
  const directlyManaged = new Set(managedClaims.map((claim) => claim.speakerId));
  const airtableOwned = new Set(airtableLinks.map((link) => link.entityId));
  const byEmail = new Map(existing.flatMap((speaker) => speaker.contactEmail ? [[speaker.contactEmail.toLowerCase(), speaker] as const] : []));
  const seen = new Set<string>();
  const createdAt = now();
  const inserts: (typeof speakers.$inferInsert)[] = [];
  const updates: { readonly existing: typeof speakers.$inferSelect; readonly values: Partial<typeof speakers.$inferInsert> }[] = [];
  let skippedCount = 0;
  const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  for (const row of rows.slice(1)) {
    const displayName = (row[nameIndex] ?? "").trim();
    const contactEmail = (row[emailIndex] ?? "").trim().toLowerCase();
    if (!displayName || !emailPattern.test(contactEmail) || seen.has(contactEmail)) {
      skippedCount += 1;
      continue;
    }
    seen.add(contactEmail);
    const nullableAt = (index: number) => index < 0 ? null : (row[index] ?? "").trim() || null;
    const workflowStatus = statusIndex < 0 ? "Invited" : (row[statusIndex] ?? "").trim() || "Invited";
    const visibleValue = visibleIndex < 0 ? "true" : (row[visibleIndex] ?? "true").trim().toLowerCase();
    const visible = !["false", "0", "no", "hidden"].includes(visibleValue);
    const prior = byEmail.get(contactEmail);
    if (prior) {
      if (!directlyManaged.has(prior.id) || airtableOwned.has(prior.id)) {
        skippedCount += 1;
        continue;
      }
      updates.push({ existing: prior, values: {
        displayName, title: nullableAt(titleIndex), company: nullableAt(companyIndex), bio: nullableAt(bioIndex),
        workflowStatus, visible, version: prior.version + 1, updatedAt: createdAt,
        profileReviewStatus: "in_review" as const, profileReviewNote: null,
        profileSubmittedAt: createdAt, profileReviewedAt: null, profileReviewedBy: null,
      } });
    } else {
      inserts.push({
        id: id("speaker"), eventId: input.eventId, userId: null, contactEmail, displayName,
        title: nullableAt(titleIndex), company: nullableAt(companyIndex), bio: nullableAt(bioIndex),
        workflowStatus, headshotAssetId: null, headshotUrl: null, links: [], visible, version: 1, createdAt, updatedAt: createdAt,
        profileSourceId: null, profileSourceVersion: null, profileReviewStatus: "in_review" as const,
        profileReviewNote: null, profileSubmittedAt: createdAt, profileReviewedAt: null, profileReviewedBy: null,
      });
    }
  }
  const affected = [
    ...inserts.map((speaker) => speakerView(speaker as typeof speakers.$inferSelect)),
    ...updates.map(({ existing: prior, values }) => speakerView({ ...prior, ...values } as typeof speakers.$inferSelect)),
  ];
  const output: ImportSpeakersCsvOutput = {
    createdCount: inserts.length, updatedCount: updates.length, skippedCount, speakers: affected, idempotent: false,
  };
  const record = idempotencyInsert(input.eventId, "portal.importSpeakersCsv", principalId, keyHash, requestHash, createdAt);
  const requestId = id("portal_request");
  const changes = new Map(affected.map((profile) => [profile.id, writeChange(
    input.eventId, "speaker", profile.id, profile.version, "portal.speaker.csv.imported",
    { speakerId: profile.id }, actor, createdAt, requestId, record.id,
  )]));
  const reservation = yield* database(() => db.insert(idempotencyRecords).values(record)).pipe(Effect.either);
  if (reservation._tag === "Left") {
    const racedReplay = yield* findReplay(input.eventId, "portal.importSpeakersCsv", principalId, keyHash, requestHash);
    if (racedReplay !== null) return { ...(yield* decodeReplay(ImportSpeakersCsvOutputSchema, racedReplay)), idempotent: true };
    return yield* Effect.fail(reservation.left);
  }
  const statements: BatchItem<"sqlite">[] = [];
  if (inserts.length > 0) {
    statements.push(db.insert(speakers).values(inserts));
    statements.push(db.insert(managedSpeakerEmails).values(inserts.map((speaker) => ({
      id: id("managed_email"), eventId: input.eventId,
      normalizedEmail: speaker.contactEmail!, speakerId: speaker.id,
      createdAt, updatedAt: createdAt,
    }))));
    for (const inserted of inserts) statements.push(db.insert(domainChanges).values(changes.get(inserted.id)!));
  }
  for (const update of updates) {
    const change = changes.get(update.existing.id)!;
    const nextVersion = update.existing.version + 1;
    statements.push(db.update(speakers).set(update.values).where(and(
      eq(speakers.eventId, input.eventId), eq(speakers.id, update.existing.id), eq(speakers.version, update.existing.version),
    )), db.delete(managedSpeakerEmails).where(and(
      eq(managedSpeakerEmails.eventId, input.eventId), eq(managedSpeakerEmails.speakerId, update.existing.id),
    )), db.insert(managedSpeakerEmails).values({
      id: id("managed_email"), eventId: input.eventId,
      normalizedEmail: update.existing.contactEmail!.toLowerCase(), speakerId: update.existing.id,
      createdAt, updatedAt: createdAt,
    }), db.insert(domainChanges).values(change), db.insert(domainChanges).select(
      db.select(changeSelection(change)).from(speakers).where(and(
        eq(speakers.eventId, input.eventId), eq(speakers.id, update.existing.id), or(
          ne(speakers.version, nextVersion),
          ne(speakers.displayName, update.values.displayName!),
          sql`${speakers.title} is not ${update.values.title ?? null}`,
          sql`${speakers.company} is not ${update.values.company ?? null}`,
          sql`${speakers.bio} is not ${update.values.bio ?? null}`,
          ne(speakers.workflowStatus, update.values.workflowStatus!),
          ne(speakers.visible, update.values.visible!),
          ne(speakers.updatedAt, createdAt),
        ),
      )),
    ));
  }
  statements.push(
    db.insert(auditLog).values({
      id: id("audit"), eventId: input.eventId, requestId,
      actorUserId: actor.actorUserId, actorApiKeyId: actor.actorApiKeyId,
      action: "portal.speakers.csv.imported", resourceType: "event", resourceId: input.eventId,
      before: null, after: output, metadata: null, occurredAt: createdAt,
    }),
    db.update(idempotencyRecords).set({ status: "completed", responseStatus: 200, responseBody: output, completedAt: createdAt }).where(eq(idempotencyRecords.id, record.id)),
  );
  const committed = yield* database(() => db.batch(statements as [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]])).pipe(Effect.either);
  if (committed._tag === "Left") {
    const racedReplay = yield* findReplay(input.eventId, "portal.importSpeakersCsv", principalId, keyHash, requestHash);
    if (racedReplay !== null) return { ...(yield* decodeReplay(ImportSpeakersCsvOutputSchema, racedReplay)), idempotent: true };
    const currentRows = yield* database(() => db.select({ id: speakers.id, contactEmail: speakers.contactEmail, version: speakers.version })
      .from(speakers).where(eq(speakers.eventId, input.eventId)));
    const currentById = new Map(currentRows.map((row) => [row.id, row]));
    const currentEmails = new Map(currentRows.flatMap((row) => row.contactEmail ? [[row.contactEmail.toLowerCase(), row.id] as const] : []));
    const staleUpdate = updates.some((update) => currentById.get(update.existing.id)?.version !== update.existing.version);
    const racedInsert = inserts.some((inserted) => currentEmails.has(inserted.contactEmail!.toLowerCase()));
    if (staleUpdate || racedInsert) {
      return yield* Effect.fail(new Conflict({ message: "Speaker records changed during import; reload and retry" }));
    }
    return yield* Effect.fail(committed.left);
  }
  return output;
});

export const sendSpeakerMessages = (input: SendSpeakerMessagesInput): Effect.Effect<SendSpeakerMessagesOutput, AppError, Db | CurrentUser | Authorizer | MailQueue> => Effect.gen(function* () {
  const actor = yield* organizer(input.eventId, "speakers:write");
  const { db } = yield* Db;
  const queue = yield* MailQueue;
  const requestedIds = [...new Set(input.speakerIds)];
  if (requestedIds.length !== input.speakerIds.length) return yield* Effect.fail(new Validation({ message: "Message recipients cannot contain duplicates" }));
  const { keyHash, requestHash } = yield* commandHashes(input.idempotencyKey, input);
  const principalId = actor.actorApiKeyId ?? actor.userId;
  const replay = yield* findReplay(input.eventId, "portal.sendSpeakerMessages", principalId, keyHash, requestHash);
  if (replay !== null) {
    yield* queue.wake().pipe(Effect.catchAll(() => Effect.void));
    return { ...(yield* decodeReplay(SendSpeakerMessagesOutputSchema, replay)), idempotent: true };
  }
  const [eventRows, speakerRows, definitions, assignments, completions] = yield* Effect.all([
    database(() => db.select({ name: events.name, slug: events.slug }).from(events).where(eq(events.id, input.eventId)).limit(1)),
    database(() => db.select({ speaker: speakers, userEmail: users.email, userName: users.name }).from(speakers)
      .leftJoin(users, eq(users.id, speakers.userId))
      .where(and(eq(speakers.eventId, input.eventId), inArray(speakers.id, requestedIds)))),
    database(() => db.select().from(tasks).where(eq(tasks.eventId, input.eventId))),
    database(() => db.select().from(taskAssignments).where(and(eq(taskAssignments.eventId, input.eventId), inArray(taskAssignments.speakerId, requestedIds)))),
    database(() => db.select({ speakerId: taskCompletions.speakerId, taskId: taskCompletions.taskId }).from(taskCompletions).where(and(
      eq(taskCompletions.eventId, input.eventId), inArray(taskCompletions.speakerId, requestedIds),
    ))),
  ]);
  const event = eventRows[0];
  if (!event) return yield* Effect.fail(new NotFound({ entity: "event", id: input.eventId }));
  const eligibleSpeakerIds = yield* eligiblePublicSpeakerIds([input.eventId]);
  const assignmentSet = new Set(assignments.map((assignment) => `${assignment.speakerId}\u0000${assignment.taskId}`));
  const completionSet = new Set(completions.map((completion) => `${completion.speakerId}\u0000${completion.taskId}`));
  const recipients = speakerRows.flatMap(({ speaker, userEmail, userName }) => {
    if (!eligibleSpeakerIds.has(speaker.id)) return [];
    const outstanding = definitions.filter((task) =>
      (task.targetMode === "all" || assignmentSet.has(`${speaker.id}\u0000${task.id}`)) &&
      !completionSet.has(`${speaker.id}\u0000${task.id}`)
    );
    const email = speaker.contactEmail ?? userEmail;
    if (!email || (input.kind === "reminder" && outstanding.length === 0)) return [];
    const next = [...outstanding].sort((left, right) => (left.dueAt?.getTime() ?? Number.MAX_SAFE_INTEGER) - (right.dueAt?.getTime() ?? Number.MAX_SAFE_INTEGER) || left.order - right.order)[0];
    return [{ speaker, email, recipientName: userName ?? speaker.displayName, outstanding, next }];
  });
  const createdAt = now();
  const portalUrl = `${queue.appOrigin}${clientRoutes.portal(encodeURIComponent(event.slug))}`;
  const deliveries = recipients.map((recipient, index) => {
    const snapshotId = id("mail_snapshot");
    const invite = input.kind === "invite";
    const subject = invite
      ? `Your ${event.name} speaker portal`
      : `${recipient.outstanding.length} ${event.name} speaker task${recipient.outstanding.length === 1 ? "" : "s"} outstanding`;
    const detail = recipient.next
      ? ` Your next task is “${recipient.next.name}”${recipient.next.dueAt ? `, due ${recipient.next.dueAt.toISOString().slice(0, 10)}` : ""}.`
      : "";
    const text = invite
      ? `Hi ${recipient.recipientName},\n\nUse your speaker portal to manage your ${event.name} profile, tasks, and files:\n${portalUrl}`
      : `Hi ${recipient.recipientName},\n\nYou have ${recipient.outstanding.length} outstanding speaker task${recipient.outstanding.length === 1 ? "" : "s"} for ${event.name}.${detail}\n\nOpen your speaker portal: ${portalUrl}`;
    const html = invite
      ? `<p>Hi ${escapeHtml(recipient.recipientName)},</p><p>Use your speaker portal to manage your ${escapeHtml(event.name)} profile, tasks, and files.</p><p><a href="${escapeHtml(portalUrl)}">Open your speaker portal</a></p>`
      : `<p>Hi ${escapeHtml(recipient.recipientName)},</p><p>You have <strong>${recipient.outstanding.length}</strong> outstanding speaker task${recipient.outstanding.length === 1 ? "" : "s"} for ${escapeHtml(event.name)}.${escapeHtml(detail)}</p><p><a href="${escapeHtml(portalUrl)}">Open your speaker portal</a></p>`;
    return {
      snapshot: {
        id: snapshotId, eventId: input.eventId, templateId: null, recipientUserId: recipient.speaker.userId,
        recipientEmail: recipient.email, recipientName: recipient.recipientName, fromEmail: queue.fromEmail,
        replyToEmail: null, subject, renderedHtml: html, renderedText: text,
        icsFilename: null, icsContent: null, createdAt,
      },
      delivery: {
        id: id("mail_delivery"), snapshotId, idempotencyKey: `portal-${input.kind}:${keyHash}:${index}`,
        status: "pending" as const, scheduledFor: createdAt, availableAt: createdAt,
        attemptCount: 0, maxAttempts: 8, createdAt,
      },
    };
  });
  const output: SendSpeakerMessagesOutput = {
    queuedCount: deliveries.length,
    skippedCount: requestedIds.length - deliveries.length,
    idempotent: false,
  };
  const record = idempotencyInsert(input.eventId, "portal.sendSpeakerMessages", principalId, keyHash, requestHash, createdAt);
  const requestId = id("portal_request");
  const statements: [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]] = [db.insert(idempotencyRecords).values(record)];
  if (deliveries.length > 0) {
    statements.push(
      db.insert(mailDeliverySnapshots).values(deliveries.map((delivery) => delivery.snapshot)),
      db.insert(mailDeliveries).values(deliveries.map((delivery) => delivery.delivery)),
    );
  }
  statements.push(
    db.insert(domainChanges).values(writeChange(
      input.eventId, "speakerMessageBatch", record.id, 1, "portal.speaker.messages.enqueued",
      { kind: input.kind, ...output }, actor, createdAt, requestId, record.id,
    )),
    db.insert(auditLog).values({
      id: id("audit"), eventId: input.eventId, requestId,
      actorUserId: actor.actorUserId, actorApiKeyId: actor.actorApiKeyId,
      action: "portal.speaker.messages.enqueued", resourceType: "event", resourceId: input.eventId,
      before: null, after: output, metadata: { kind: input.kind, speakerIds: requestedIds }, occurredAt: createdAt,
    }),
    db.update(idempotencyRecords).set({ status: "completed", responseStatus: 202, responseBody: output, completedAt: createdAt }).where(eq(idempotencyRecords.id, record.id)),
  );
  yield* database(() => db.batch(statements));
  yield* queue.wake().pipe(Effect.catchAll(() => Effect.void));
  return output;
});

/** Daily cron producer for incomplete speaker tasks due within 48 hours or overdue. */
export const enqueueAutomatedDueTaskReminders = (runAt = now()): Effect.Effect<{ readonly queuedCount: number; readonly runDate: string }, AppError, Db | MailQueue> => Effect.gen(function* () {
  const { db } = yield* Db;
  const queue = yield* MailQueue;
  const runDate = runAt.toISOString().slice(0, 10);
  const horizon = new Date(runAt.getTime() + 48 * 60 * 60 * 1_000);
  const dueTasks = yield* database(() => db.select().from(tasks).where(and(isNotNull(tasks.dueAt), lte(tasks.dueAt, horizon))).orderBy(asc(tasks.eventId), asc(tasks.dueAt), asc(tasks.order)));
  if (dueTasks.length === 0) return { queuedCount: 0, runDate };
  const eventIds = [...new Set(dueTasks.map((task) => task.eventId))];
  const taskIds = dueTasks.map((task) => task.id);
  const [eventRows, speakerRows, assignments, completions, eligibleSpeakerIds] = yield* Effect.all([
    database(() => db.select({ id: events.id, name: events.name, slug: events.slug }).from(events).where(inArray(events.id, eventIds))),
    database(() => db.select({ speaker: speakers, userEmail: users.email, userName: users.name }).from(speakers)
      .leftJoin(users, eq(users.id, speakers.userId)).where(inArray(speakers.eventId, eventIds))),
    database(() => db.select().from(taskAssignments).where(inArray(taskAssignments.taskId, taskIds))),
    database(() => db.select({ speakerId: taskCompletions.speakerId, taskId: taskCompletions.taskId }).from(taskCompletions).where(inArray(taskCompletions.taskId, taskIds))),
    eligiblePublicSpeakerIds(eventIds),
  ]);
  const eventById = new Map(eventRows.map((event) => [event.id, event]));
  const assignmentSet = new Set(assignments.map((assignment) => `${assignment.speakerId}\u0000${assignment.taskId}`));
  const completionSet = new Set(completions.map((completion) => `${completion.speakerId}\u0000${completion.taskId}`));
  const candidates = speakerRows.flatMap(({ speaker, userEmail, userName }) => {
    if (!eligibleSpeakerIds.has(speaker.id)) return [];
    const event = eventById.get(speaker.eventId);
    const email = speaker.contactEmail ?? userEmail;
    if (!event || !email) return [];
    const outstanding = dueTasks.filter((task) => task.eventId === speaker.eventId
      && (task.targetMode === "all" || assignmentSet.has(`${speaker.id}\u0000${task.id}`))
      && !completionSet.has(`${speaker.id}\u0000${task.id}`));
    if (outstanding.length === 0) return [];
    return [{ event, speaker, email, recipientName: userName ?? speaker.displayName, outstanding }];
  });
  const keys = candidates.map(({ event, speaker }) => `portal-due:${runDate}:${event.id}:${speaker.id}`);
  const existing = keys.length === 0 ? [] : yield* database(() => db.select({ key: mailDeliveries.idempotencyKey }).from(mailDeliveries).where(inArray(mailDeliveries.idempotencyKey, keys)));
  const existingKeys = new Set(existing.map((row) => row.key));
  const rows = candidates.flatMap((candidate) => {
    const deliveryKey = `portal-due:${runDate}:${candidate.event.id}:${candidate.speaker.id}`;
    if (existingKeys.has(deliveryKey)) return [];
    const snapshotId = id("mail_snapshot");
    const next = candidate.outstanding[0]!;
    const portalUrl = `${queue.appOrigin}${clientRoutes.portal(encodeURIComponent(candidate.event.slug))}`;
    const subject = `${candidate.outstanding.length} ${candidate.event.name} task${candidate.outstanding.length === 1 ? "" : "s"} due`;
    const dueText = next.dueAt && next.dueAt <= runAt ? "is overdue" : `is due ${next.dueAt?.toISOString().slice(0, 10) ?? "soon"}`;
    const text = `Hi ${candidate.recipientName},\n\nYour next speaker task, “${next.name}”, ${dueText}. You have ${candidate.outstanding.length} due or overdue task${candidate.outstanding.length === 1 ? "" : "s"}.\n\nOpen your speaker portal: ${portalUrl}`;
    const html = `<p>Hi ${escapeHtml(candidate.recipientName)},</p><p>Your next speaker task, <strong>${escapeHtml(next.name)}</strong>, ${escapeHtml(dueText)}. You have ${candidate.outstanding.length} due or overdue task${candidate.outstanding.length === 1 ? "" : "s"}.</p><p><a href="${escapeHtml(portalUrl)}">Open your speaker portal</a></p>`;
    return [{
      snapshot: {
        id: snapshotId, eventId: candidate.event.id, templateId: null, recipientUserId: candidate.speaker.userId,
        recipientEmail: candidate.email, recipientName: candidate.recipientName, fromEmail: queue.fromEmail,
        replyToEmail: null, subject, renderedHtml: html, renderedText: text,
        icsFilename: null, icsContent: null, createdAt: runAt,
      },
      delivery: {
        id: id("mail_delivery"), snapshotId, idempotencyKey: deliveryKey, status: "pending" as const,
        scheduledFor: runAt, availableAt: runAt, attemptCount: 0, maxAttempts: 8, createdAt: runAt,
      },
    }];
  });
  if (rows.length > 0) {
    yield* database(() => db.batch([
      db.insert(mailDeliverySnapshots).values(rows.map((row) => row.snapshot)),
      db.insert(mailDeliveries).values(rows.map((row) => row.delivery)),
    ]));
    yield* queue.wake().pipe(Effect.catchAll(() => Effect.void));
  }
  return { queuedCount: rows.length, runDate };
});

const loadSpeakerSessions = (
  eventId: string,
  speakerIds: readonly string[],
): Effect.Effect<ReadonlyMap<string, readonly { readonly id: string; readonly title: string }[]>, AppError, Db> => Effect.gen(function* () {
  if (speakerIds.length === 0) return new Map();
  const { db } = yield* Db;
  const rows = yield* database(() => db.select({ speakerId: talkSpeakers.speakerId, id: talks.id, title: talks.title })
    .from(talkSpeakers)
    .innerJoin(talks, and(eq(talks.eventId, talkSpeakers.eventId), eq(talks.id, talkSpeakers.talkId)))
    .where(and(
      eq(talkSpeakers.eventId, eventId),
      inArray(talkSpeakers.speakerId, [...speakerIds]),
      ne(talks.status, "cancelled"),
    ))
    .orderBy(asc(talks.startsAt), asc(talks.title), asc(talks.id)));
  const sessions = new Map<string, { id: string; title: string }[]>();
  for (const row of rows) {
    const current = sessions.get(row.speakerId) ?? [];
    if (!current.some(({ id }) => id === row.id)) current.push({ id: row.id, title: row.title });
    sessions.set(row.speakerId, current);
  }
  return sessions;
});

const loadContentAssets = (eventId: string, onlyAssetId?: string): Effect.Effect<readonly ContentAsset[], AppError, Db> => Effect.gen(function* () {
  const { db } = yield* Db;
  const assetRows = yield* database(() => db.select({ asset: assets, speaker: speakers }).from(assets)
    .innerJoin(speakers, and(eq(speakers.eventId, assets.eventId), eq(speakers.id, assets.speakerId)))
    .where(and(
      eq(assets.eventId, eventId),
      isNotNull(assets.speakerId),
      ...(onlyAssetId ? [eq(assets.id, onlyAssetId)] : []),
    ))
    .orderBy(desc(assets.current), asc(speakers.displayName), asc(assets.purpose), desc(assets.version), desc(assets.createdAt)));
  const speakerIds = [...new Set(assetRows.map((row) => row.speaker.id))];
  const speakerSessions = yield* loadSpeakerSessions(eventId, speakerIds);
  const versionCounts = new Map<string, number>();
  for (const { asset, speaker } of assetRows) {
    const lineage = `${speaker.id}\u0000${asset.purpose ?? "document"}`;
    versionCounts.set(lineage, (versionCounts.get(lineage) ?? 0) + 1);
  }
  const assetIds = assetRows.map((row) => row.asset.id);
  const commentRows = assetIds.length === 0 ? [] : yield* database(() => db.select({ comment: assetComments, authorName: users.name }).from(assetComments)
    .innerJoin(users, eq(users.id, assetComments.actorUserId))
    .where(and(eq(assetComments.eventId, eventId), inArray(assetComments.assetId, assetIds)))
    .orderBy(asc(assetComments.createdAt), asc(assetComments.id)));
  return assetRows.map(({ asset, speaker }) => ({
    ...assetView(asset, asset.purpose ?? "document"),
    speakerId: speaker.id,
    speakerName: speaker.displayName,
    speakerVersion: speaker.version,
    sessionTitles: (speakerSessions.get(speaker.id) ?? []).map(({ title }) => title),
    sessionLinks: speakerSessions.get(speaker.id) ?? [],
    versionCount: versionCounts.get(`${speaker.id}\u0000${asset.purpose ?? "document"}`) ?? 1,
    current: asset.current,
    supersedesAssetId: asset.supersedesAssetId,
    restoredFromAssetId: asset.restoredFromAssetId,
    uploadedAt: asset.createdAt.getTime(),
    comments: commentRows.filter((row) => row.comment.assetId === asset.id).map((row) => ({
      id: row.comment.id,
      authorName: row.authorName ?? "Organizer",
      body: row.comment.body,
      createdAt: row.comment.createdAt.getTime(),
    })),
  }));
});

const authorizeAssetActor = (eventId: string, assetId: string, scope: "content:read" | "content:write") => Effect.gen(function* () {
  const { db } = yield* Db;
  const [row] = yield* database(() => db.select({ asset: assets, speaker: speakers }).from(assets)
    .innerJoin(speakers, and(eq(speakers.eventId, assets.eventId), eq(speakers.id, assets.speakerId)))
    .where(and(eq(assets.eventId, eventId), eq(assets.id, assetId)))
    .limit(1));
  if (!row) return yield* Effect.fail(new NotFound({ entity: "content asset", id: assetId }));
  const principal = yield* CurrentUser;
  if (principal.kind === "browser-session" && row.speaker.userId === principal.userId) {
    return { actor: { userId: principal.userId, actorUserId: principal.userId, actorApiKeyId: null } satisfies PrincipalActor, row };
  }
  return { actor: yield* organizer(eventId, scope), row };
});

export const getContentLibrary = (input: { readonly eventId: string }): Effect.Effect<ContentLibrary, AppError, Db | CurrentUser | Authorizer> => Effect.gen(function* () {
  yield* organizer(input.eventId, "content:read");
  const event = yield* requireEvent(input.eventId);
  return { event: eventView(event), assets: yield* loadContentAssets(input.eventId) };
});

export const addContentComment = (input: AddContentCommentInput): Effect.Effect<ContentComment, AppError, Db | CurrentUser | Authorizer> => Effect.gen(function* () {
  const { actor } = yield* authorizeAssetActor(input.eventId, input.assetId, "content:write");
  const { db } = yield* Db;
  const body = input.body.trim();
  if (!body) return yield* Effect.fail(new Validation({ message: "Comment body cannot be blank" }));
  const normalizedInput = { ...input, body };
  const { keyHash, requestHash } = yield* commandHashes(input.idempotencyKey, normalizedInput);
  const principalId = actor.actorApiKeyId ?? actor.userId;
  const replay = yield* findReplay(input.eventId, "portal.addContentComment", principalId, keyHash, requestHash);
  if (replay !== null) return yield* decodeReplay(ContentCommentSchema, replay);
  const [author] = yield* database(() => db.select({ name: users.name }).from(users).where(eq(users.id, actor.userId)).limit(1));
  const createdAt = now();
  const comment: ContentComment = {
    id: id("asset_comment"),
    authorName: author?.name ?? "Organizer",
    body,
    createdAt: createdAt.getTime(),
  };
  const record = idempotencyInsert(input.eventId, "portal.addContentComment", principalId, keyHash, requestHash, createdAt);
  const requestId = id("portal_request");
  yield* database(() => db.batch([
    db.insert(idempotencyRecords).values(record),
    db.insert(assetComments).values({
      id: comment.id, eventId: input.eventId, assetId: input.assetId,
      actorUserId: actor.userId, body: comment.body, createdAt,
    }),
    db.insert(domainChanges).values(writeChange(
      input.eventId, "assetComment", comment.id, 1, "portal.asset.comment.added",
      { assetId: input.assetId }, actor, createdAt, requestId, record.id,
    )),
    db.insert(auditLog).values({
      id: id("audit"), eventId: input.eventId, requestId,
      actorUserId: actor.actorUserId, actorApiKeyId: actor.actorApiKeyId,
      action: "portal.asset.comment.added", resourceType: "asset", resourceId: input.assetId,
      before: null, after: comment, metadata: null, occurredAt: createdAt,
    }),
    db.update(idempotencyRecords).set({ status: "completed", responseStatus: 201, responseBody: comment, completedAt: createdAt }).where(eq(idempotencyRecords.id, record.id)),
  ]));
  return comment;
});

export interface RestoreContentVersionTestHooks {
  readonly beforeCommit?: () => Promise<void>;
}

export const restoreContentVersion = (
  input: RestoreContentVersionInput,
  testHooks?: RestoreContentVersionTestHooks,
): Effect.Effect<ContentAsset, AppError, Db | CurrentUser | Authorizer | Files> => Effect.gen(function* () {
  const actor = yield* organizer(input.eventId, "content:write");
  const { db } = yield* Db;
  const { keyHash, requestHash } = yield* commandHashes(input.idempotencyKey, input);
  const principalId = actor.actorApiKeyId ?? actor.userId;
  const replay = yield* findReplay(input.eventId, "portal.restoreContentVersion", principalId, keyHash, requestHash);
  if (replay !== null) return yield* decodeReplay(ContentAssetSchema, replay);
  const [source] = yield* database(() => db.select({ asset: assets, speaker: speakers }).from(assets)
    .innerJoin(speakers, and(eq(speakers.eventId, assets.eventId), eq(speakers.id, assets.speakerId)))
    .where(and(eq(assets.eventId, input.eventId), eq(assets.id, input.assetId)))
    .limit(1));
  if (!source || source.asset.purpose === null || source.asset.speakerId === null) {
    return yield* Effect.fail(new NotFound({ entity: "portal content version", id: input.assetId }));
  }
  const sourceSpeakerId = source.asset.speakerId;
  const sourcePurpose = source.asset.purpose;
  const [current] = yield* database(() => db.select().from(assets).where(and(
    eq(assets.eventId, input.eventId), eq(assets.speakerId, sourceSpeakerId),
    eq(assets.purpose, sourcePurpose), eq(assets.current, true),
  )).orderBy(desc(assets.version), desc(assets.createdAt)).limit(1));
  if (!current) return yield* Effect.fail(new Conflict({ message: "This content lineage has no current version" }));
  if (
    current.id !== input.expectedCurrentAssetId ||
    current.version !== input.expectedCurrentVersion ||
    source.speaker.version !== input.expectedSpeakerVersion
  ) {
    return yield* Effect.fail(new Conflict({ message: "Content changed; reload before restoring this version" }));
  }
  const { get, put, delete: deleteFile } = yield* Files;
  const sourceObject = yield* get(assetKey(input.eventId, source.asset.id));
  if (!sourceObject) return yield* Effect.fail(new NotFound({ entity: "content object", id: source.asset.id }));
  const bytes = new Uint8Array(yield* fileEffect(() => sourceObject.arrayBuffer()));
  const restoredAt = now();
  const restoredId = id("portal_asset");
  const restoredVersion = current.version + 1;
  const key = assetKey(input.eventId, restoredId);
  const dispositionFilename = source.asset.filename.replace(/["\\\r\n]/g, "_");
  yield* put(key, bytes, {
    httpMetadata: {
      contentType: source.asset.contentType,
      contentDisposition: source.asset.purpose === "headshot" ? "inline" : `attachment; filename="${dispositionFilename}"`,
    },
    customMetadata: { portalPurpose: source.asset.purpose, speakerId: source.asset.speakerId, restoredFrom: source.asset.id },
  });
  const record = idempotencyInsert(input.eventId, "portal.restoreContentVersion", principalId, keyHash, requestHash, restoredAt);
  const restoredRecord: typeof assets.$inferInsert = {
    id: restoredId, eventId: input.eventId, uploaderUserId: actor.userId,
    speakerId: sourceSpeakerId, purpose: sourcePurpose,
    supersedesAssetId: current.id, restoredFromAssetId: source.asset.id, current: true,
    filename: source.asset.filename, contentType: source.asset.contentType, size: source.asset.size,
    version: restoredVersion, createdAt: restoredAt, updatedAt: restoredAt,
  };
  const sessionLinks = (yield* loadSpeakerSessions(input.eventId, [sourceSpeakerId])).get(sourceSpeakerId) ?? [];
  const result: ContentAsset = {
    ...assetView(restoredRecord as typeof assets.$inferSelect, sourcePurpose),
    speakerId: source.speaker.id, speakerName: source.speaker.displayName, current: true,
    speakerVersion: sourcePurpose === "headshot" ? source.speaker.version + 1 : source.speaker.version,
    sessionTitles: sessionLinks.map(({ title }) => title), sessionLinks, versionCount: restoredVersion,
    supersedesAssetId: current.id, restoredFromAssetId: source.asset.id,
    uploadedAt: restoredAt.getTime(), comments: [],
  };
  const completionRows = yield* database(() => db.select().from(taskCompletions).where(and(
    eq(taskCompletions.eventId, input.eventId), eq(taskCompletions.speakerId, sourceSpeakerId),
  )));
  const linkedCompletions = completionRows.filter((completion) =>
    typeof completion.data === "object" && completion.data !== null && !Array.isArray(completion.data) && Reflect.get(completion.data, "assetId") === current.id
  );
  const requestId = id("portal_request");
  const restoreChange = writeChange(
    input.eventId, "asset", restoredId, 1, "portal.asset.version.restored",
    { speakerId: source.speaker.id, restoredFromAssetId: source.asset.id, supersedesAssetId: current.id },
    actor, restoredAt, requestId, record.id,
  );
  const statements: [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]] = [
    db.insert(idempotencyRecords).values(record),
    db.update(assets).set({ current: false, updatedAt: restoredAt }).where(and(
      eq(assets.eventId, input.eventId), eq(assets.id, input.expectedCurrentAssetId),
      eq(assets.version, input.expectedCurrentVersion), eq(assets.current, true),
    )),
    db.insert(assets).values(restoredRecord),
  ];
  if (sourcePurpose === "headshot") {
    const change = writeChange(
      input.eventId, "speaker", source.speaker.id, source.speaker.version + 1,
      "portal.speaker.headshot.restored", { speakerId: source.speaker.id, assetId: restoredId },
      actor, restoredAt, requestId, record.id,
    );
    statements.push(
      db.update(speakers).set({
        headshotAssetId: restoredId, version: source.speaker.version + 1, updatedAt: restoredAt,
      }).where(and(
        eq(speakers.eventId, input.eventId), eq(speakers.id, source.speaker.id),
        eq(speakers.version, input.expectedSpeakerVersion),
      )),
      db.insert(domainChanges).values(change),
      db.insert(domainChanges).select(db.select(changeSelection(change)).from(speakers).where(and(
        eq(speakers.eventId, input.eventId), eq(speakers.id, source.speaker.id),
        or(ne(speakers.version, source.speaker.version + 1), ne(speakers.headshotAssetId, restoredId)),
      ))),
    );
  }
  for (const completion of linkedCompletions) {
    statements.push(db.update(taskCompletions).set({
      data: { ...(completion.data as Record<string, unknown>), assetId: restoredId },
      version: completion.version + 1, updatedAt: restoredAt,
    }).where(and(eq(taskCompletions.eventId, input.eventId), eq(taskCompletions.id, completion.id), eq(taskCompletions.version, completion.version))),
    db.insert(domainChanges).select(db.select(changeSelection(restoreChange)).from(events).where(and(
      eq(events.id, input.eventId),
      sql`not exists (
        select 1 from task_completions as restored_completion
        where restored_completion.event_id = ${input.eventId}
          and restored_completion.id = ${completion.id}
          and restored_completion.version = ${completion.version + 1}
          and json_extract(restored_completion.data, '$.assetId') = ${restoredId}
      )`,
    ))));
  }
  statements.push(
    db.insert(domainChanges).values(restoreChange),
    db.insert(auditLog).values({
      id: id("audit"), eventId: input.eventId, requestId,
      actorUserId: actor.actorUserId, actorApiKeyId: actor.actorApiKeyId,
      action: "portal.asset.version.restored", resourceType: "asset", resourceId: restoredId,
      before: { assetId: current.id, version: current.version }, after: result,
      metadata: { restoredFromAssetId: source.asset.id }, occurredAt: restoredAt,
    }),
    db.update(idempotencyRecords).set({ status: "completed", responseStatus: 201, responseBody: result, completedAt: restoredAt }).where(eq(idempotencyRecords.id, record.id)),
  );
  if (testHooks?.beforeCommit) yield* Effect.promise(testHooks.beforeCommit);
  const committed = yield* database(() => db.batch(statements)).pipe(Effect.either);
  if (committed._tag === "Left") {
    yield* deleteFile(key).pipe(Effect.catchAll(() => Effect.void));
    const [currentRows, currentCompletionRows, currentSpeakerRows] = yield* Effect.all([
      database(() => db.select({ id: assets.id, version: assets.version }).from(assets).where(and(
        eq(assets.eventId, input.eventId), eq(assets.speakerId, sourceSpeakerId),
        eq(assets.purpose, sourcePurpose), eq(assets.current, true),
      )).limit(1)),
      linkedCompletions.length === 0
        ? Effect.succeed([] as readonly (typeof taskCompletions.$inferSelect)[])
        : database(() => db.select().from(taskCompletions).where(and(
          eq(taskCompletions.eventId, input.eventId),
          inArray(taskCompletions.id, linkedCompletions.map((completion) => completion.id)),
        ))),
      database(() => db.select({ version: speakers.version }).from(speakers).where(and(
        eq(speakers.eventId, input.eventId), eq(speakers.id, sourceSpeakerId),
      )).limit(1)),
    ]);
    const racedCurrent = currentRows[0];
    if (!racedCurrent || racedCurrent.id !== input.expectedCurrentAssetId || racedCurrent.version !== input.expectedCurrentVersion) {
      return yield* Effect.fail(new Conflict({ message: "Content changed; reload before restoring this version" }));
    }
    const currentCompletionById = new Map(currentCompletionRows.map((completion) => [completion.id, completion]));
    const completionChanged = linkedCompletions.some((completion) => {
      const latest = currentCompletionById.get(completion.id);
      return !latest || latest.version !== completion.version
        || typeof latest.data !== "object" || latest.data === null || Array.isArray(latest.data)
        || Reflect.get(latest.data, "assetId") !== current.id;
    });
    if (completionChanged) {
      return yield* Effect.fail(new Conflict({ message: "A linked task completion changed; reload before restoring this version" }));
    }
    if (sourcePurpose === "headshot" && currentSpeakerRows[0]?.version !== input.expectedSpeakerVersion) {
      return yield* Effect.fail(new Conflict({ message: "Speaker profile changed; reload before restoring this headshot" }));
    }
    return yield* Effect.fail(committed.left);
  }
  return result;
});

export const downloadContent = (input: DownloadContentInput): Effect.Effect<DownloadContentOutput, AppError, Db | CurrentUser | Authorizer | Files> => Effect.gen(function* () {
  yield* authorizeAssetActor(input.eventId, input.assetId, "content:read");
  const [asset] = yield* loadContentAssets(input.eventId, input.assetId);
  if (!asset) return yield* Effect.fail(new NotFound({ entity: "content asset", id: input.assetId }));
  const { get } = yield* Files;
  const object = yield* get(assetKey(input.eventId, input.assetId));
  if (!object) return yield* Effect.fail(new NotFound({ entity: "content object", id: input.assetId }));
  const bytes = new Uint8Array(yield* fileEffect(() => object.arrayBuffer()));
  return { asset, contentBase64: encodeBase64(bytes) };
});

export const getPublicSpeakers = (input: PublicSpeakersInput): Effect.Effect<PublicSpeakerGallery, AppError, Db | Files> => Effect.gen(function* () {
  const { db } = yield* Db;
  const [event] = yield* database(() => db.select().from(events).where(eq(events.slug, input.eventSlug)).limit(1));
  if (!event) return yield* Effect.fail(new NotFound({ entity: "event", id: input.eventSlug }));
  const [publication] = yield* database(() => db.select({ payload: domainChanges.payload }).from(domainChanges).where(and(
    eq(domainChanges.eventId, event.id),
    eq(domainChanges.aggregateType, "speaker-publication"),
    eq(domainChanges.aggregateId, event.id),
  )).orderBy(desc(domainChanges.aggregateVersion)).limit(1));
  if (!publication) return yield* Effect.fail(new NotFound({ entity: "published speaker gallery", id: event.id }));
  const snapshot = yield* Schema.decodeUnknown(PublishedSpeakerGallerySnapshotSchema)(publication.payload).pipe(
    Effect.mapError(() => new External({ service: "database", detail: "Published speaker gallery is invalid" })),
  );
  const assetIds = snapshot.speakers.flatMap(({ headshotAssetId }) => headshotAssetId === null ? [] : [headshotAssetId]);
  const assetRows = assetIds.length === 0 ? [] : yield* database(() => db.select().from(assets).where(and(
    eq(assets.eventId, event.id),
    inArray(assets.id, assetIds),
  )));
  const assetById = new Map(assetRows.map((asset) => [asset.id, asset] as const));
  const { get } = yield* Files;
  const publicSpeakers = yield* Effect.forEach(snapshot.speakers, (speaker) => Effect.gen(function* () {
    let headshotUrl: string | null = speaker.headshotUrl && safeHttpUrl(speaker.headshotUrl) && speaker.headshotUrl.startsWith("https://")
      ? speaker.headshotUrl
      : null;
    const asset = speaker.headshotAssetId === null ? undefined : assetById.get(speaker.headshotAssetId);
    if (asset && ["image/jpeg", "image/png", "image/webp"].includes(asset.contentType)) {
      const object = yield* get(assetKey(event.id, asset.id));
      if (object) {
        const bytes = new Uint8Array(yield* fileEffect(() => object.arrayBuffer()));
        let binary = "";
        for (let offset = 0; offset < bytes.length; offset += 32_768) {
          binary += String.fromCharCode(...bytes.subarray(offset, offset + 32_768));
        }
        headshotUrl = `data:${asset.contentType};base64,${btoa(binary)}`;
      }
    }
    return { id: speaker.id, displayName: speaker.displayName, title: speaker.title, company: speaker.company, bio: speaker.bio, headshotUrl, publicProfileSlug: speaker.publicProfileSlug, links: speaker.links.filter((link) => safeHttpUrl(link.url)) };
  }));
  return { event: snapshot.event, speakers: publicSpeakers };
});
