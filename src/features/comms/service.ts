import {
  Conflict,
  External,
  NotFound,
  Validation,
  type AppError,
} from "contracts/errors";
import type { JsonValue } from "contracts/domain";
import { eventAuthorization, type AuthorizationPolicy, type Principal } from "contracts/principal";
import {
  acceptanceEvents,
  auditLog,
  domainChanges,
  emailTemplates,
  events,
  idempotencyRecords,
  mailDeliveries,
  mailDeliveryAttempts,
  mailDeliverySnapshots,
  speakers,
  submissions,
  submissionSpeakers,
  users,
} from "contracts/schema";
import type { MergeContext } from "contracts/types";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { Effect, Schema } from "effect";
import { nanoid } from "nanoid";
import { Authorizer, CurrentUser, Db, MailQueue, type AppDatabase } from "@/server/services";
import {
  type AgendaDeliveryProjection,
  type PublishedAgenda,
} from "@/features/agenda/schema";
import {
  getAgendaDeliveryProjection,
  getPublishedAgenda,
} from "@/features/agenda/service";

import {
  AudienceSnapshot,
  CommunicationPreview,
  CommunicationTemplate,
  DeliveryHistory,
  EnqueueCommunicationResult,
  RetryDeliveryResult,
  type AudienceRecipient,
  type CommunicationTemplate as CommunicationTemplateValue,
  type CreateTemplateInput,
  type DeliveryAttempt,
  type DeliveryHistoryItem,
  type EnqueueCommunicationInput,
  type ListAudienceInput,
  type ListDeliveriesInput,
  type ListTemplatesInput,
  type PreviewCommunicationInput,
  type RetryDeliveryInput,
  type RetryDeliveryResult as RetryDeliveryResultValue,
  type TemplateVariableKey,
  type UpdateTemplateInput,
} from "./schema";


export const communicationsReadAuthorization = eventAuthorization(
  { kind: "event-member", roles: ["owner", "admin"] },
  { kind: "api-key", scopes: ["communications:read"] },
);

export const communicationsWriteAuthorization = eventAuthorization(
  { kind: "event-member", roles: ["owner", "admin"] },
  { kind: "api-key", scopes: ["communications:write"] },
);

const authorizeCurrent = (policy: AuthorizationPolicy, eventId: string) =>
  Effect.gen(function* () {
    const principal = yield* CurrentUser;
    const authorizer = yield* Authorizer;
    yield* authorizer.authorize({ principal, policy, eventId });
    return principal;
  });

const database = <A>(run: () => Promise<A>): Effect.Effect<A, External> =>
  Effect.tryPromise({
    try: run,
    catch: (error) =>
      new External({
        service: "database",
        detail: error instanceof Error ? error.message : String(error),
      }),
  });

const toMillis = (value: Date | null): number | null => value === null ? null : value.getTime();
const commandExpiry = (now: Date) => new Date(now.getTime() + 24 * 60 * 60 * 1_000);
const id = (prefix: string) => `${prefix}_${nanoid()}`;

const stableValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, stableValue(child)]),
    );
  }
  return value;
};

const stableStringify = (value: unknown): string => JSON.stringify(stableValue(value));

const sha256 = (value: string): Effect.Effect<string> =>
  Effect.promise(async () => {
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
    return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
  });

interface PreparedCommand<A> {
  readonly principal: Principal;
  readonly idempotencyId: string;
  readonly keyHash: string;
  readonly requestHash: string;
  readonly replay: A | null;
  readonly now: Date;
  readonly requestId: string;
}

const decodeReplay = <A, I>(
  schema: Schema.Schema<A, I, never>,
  value: unknown,
): Effect.Effect<A, External> =>
  Schema.decodeUnknown(schema)(value).pipe(
    Effect.mapError((error) => new External({ service: "database", detail: `Invalid communications idempotency response: ${String(error)}` })),
  );

const prepareCommand = <A, I>(
  operationId: string,
  eventId: string,
  idempotencyKey: string,
  request: unknown,
  output: Schema.Schema<A, I, never>,
  markReplayed: (value: A) => A = (value) => value,
): Effect.Effect<PreparedCommand<A>, AppError, Authorizer | CurrentUser | Db> =>
  Effect.gen(function* () {
    const principal = yield* authorizeCurrent(communicationsWriteAuthorization, eventId);
    const { db } = yield* Db;
    const [keyHash, requestHash] = yield* Effect.all([
      sha256(idempotencyKey),
      sha256(stableStringify(request)),
    ]);
    const [existing] = yield* database(() =>
      db.select().from(idempotencyRecords).where(and(
        eq(idempotencyRecords.eventId, eventId),
        eq(idempotencyRecords.operationId, operationId),
        eq(idempotencyRecords.principalId, principal.userId),
        eq(idempotencyRecords.keyHash, keyHash),
      )).limit(1),
    );
    if (existing) {
      if (existing.requestHash !== requestHash) {
        return yield* Effect.fail(new Conflict({ message: "This idempotency key was already used for a different communications request" }));
      }
      if (existing.status !== "completed" || existing.responseBody === null) {
        return yield* Effect.fail(new Conflict({ message: "This communications request is still in progress" }));
      }
      const replay = markReplayed(yield* decodeReplay(output, existing.responseBody));
      return {
        principal,
        idempotencyId: existing.id,
        keyHash,
        requestHash,
        replay,
        now: existing.completedAt ?? existing.createdAt,
        requestId: id("request"),
      };
    }
    return {
      principal,
      idempotencyId: id("idempotency"),
      keyHash,
      requestHash,
      replay: null,
      now: new Date(),
      requestId: id("request"),
    };
  });

const idempotencyStart = (prepared: PreparedCommand<unknown>, eventId: string, operationId: string) => ({
  id: prepared.idempotencyId,
  eventId,
  operationId,
  principalId: prepared.principal.userId,
  keyHash: prepared.keyHash,
  requestHash: prepared.requestHash,
  status: "in_progress" as const,
  expiresAt: commandExpiry(prepared.now),
  createdAt: prepared.now,
});

const idempotencyComplete = (prepared: PreparedCommand<unknown>, response: JsonValue) => ({
  status: "completed" as const,
  responseStatus: 200,
  responseBody: response,
  completedAt: prepared.now,
});

const actor = (principal: Principal) => ({
  actorUserId: principal.kind === "browser-session" ? principal.userId : null,
  actorApiKeyId: principal.kind === "api-key" ? principal.apiKeyId : null,
});

const escapeHtml = (value: string): string => value
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;")
  .replaceAll("'", "&#39;");

const textToHtml = (text: string): string => text
  .split(/\n{2,}/)
  .map((paragraph) => `<p>${escapeHtml(paragraph).replaceAll("\n", "<br>")}</p>`)
  .join("");

interface TemplateContent {
  readonly textBody: string;
  readonly htmlBody: string;
}

const decodeTemplateContent = (body: string): TemplateContent => {
  try {
    const parsed: unknown = JSON.parse(body);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "__sessionPartyCommsTemplate" in parsed &&
      parsed.__sessionPartyCommsTemplate === 1 &&
      "textBody" in parsed &&
      typeof parsed.textBody === "string" &&
      "htmlBody" in parsed &&
      typeof parsed.htmlBody === "string"
    ) {
      return { textBody: parsed.textBody, htmlBody: parsed.htmlBody };
    }
  } catch {
    // Legacy templates stored plain text directly in this frozen column.
  }
  return { textBody: body, htmlBody: textToHtml(body) };
};

const encodeTemplateContent = ({ textBody, htmlBody }: TemplateContent): string =>
  JSON.stringify({ __sessionPartyCommsTemplate: 1, textBody, htmlBody });

const templateValue = (row: typeof emailTemplates.$inferSelect): CommunicationTemplateValue => ({
  id: row.id,
  eventId: row.eventId,
  name: row.name,
  subject: row.subject,
  ...decodeTemplateContent(row.body),
  attachIcs: row.attachIcs,
  version: row.version,
  createdAt: row.createdAt.getTime(),
  updatedAt: row.updatedAt.getTime(),
});

const mailboxPattern = /^(?:[^<>\r\n]{1,100}\s*)?<[^@\s<>]+@[^@\s<>]+\.[^@\s<>]+>$|^[^@\s<>]+@[^@\s<>]+\.[^@\s<>]+$/;
const templateTokenPattern = /{{\s*([A-Za-z][A-Za-z0-9]*(?:\.[A-Za-z][A-Za-z0-9]*)*)\s*}}/g;
const allowedVariables: Record<keyof MergeContext, true> = {
  "speaker.name": true,
  "speaker.email": true,
  "event.name": true,
  "event.location": true,
  "event.dates": true,
  "talk.title": true,
  "talk.time": true,
  "talk.room": true,
  "portal.url": true,
};
const templateVariableWireKeys: Record<keyof MergeContext, TemplateVariableKey> = {
  "speaker.name": "speakerName",
  "speaker.email": "speakerEmail",
  "event.name": "eventName",
  "event.location": "eventLocation",
  "event.dates": "eventDates",
  "talk.title": "talkTitle",
  "talk.time": "talkTime",
  "talk.room": "talkRoom",
  "portal.url": "portalUrl",
};

const templateTokens = (...values: readonly string[]): readonly (keyof MergeContext)[] =>
  [...new Set(
    Array.from(values.join("\n").matchAll(templateTokenPattern), (match) => match[1] as keyof MergeContext),
  )];

export const validateTemplate = (
  name: string,
  subject: string,
  textBody: string,
  htmlBody: string,
): Effect.Effect<{
  readonly name: string;
  readonly subject: string;
  readonly textBody: string;
  readonly htmlBody: string;
}, Validation> =>
  Effect.gen(function* () {
    const normalized = {
      name: name.trim(),
      subject: subject.trim(),
      textBody: textBody.trim(),
      htmlBody: htmlBody.trim(),
    };
    if (!normalized.name) return yield* Effect.fail(new Validation({ message: "Template name is required" }));
    if (!normalized.subject) return yield* Effect.fail(new Validation({ message: "Template subject is required" }));
    if (!normalized.textBody) return yield* Effect.fail(new Validation({ message: "Template text body is required" }));
    if (!normalized.htmlBody) return yield* Effect.fail(new Validation({ message: "Template HTML body is required" }));
    if (/\r|\n/.test(normalized.subject)) {
      return yield* Effect.fail(new Validation({ message: "Template subject must be a single line" }));
    }
    for (const value of [normalized.subject, normalized.textBody, normalized.htmlBody]) {
      const tokens = Array.from(value.matchAll(templateTokenPattern), (match) => match[1]!);
      const unknown = tokens.find((token) => !(token in allowedVariables));
      if (unknown) {
        return yield* Effect.fail(new Validation({ message: `Unknown template variable '{{${unknown}}}'` }));
      }
      const withoutTokens = value.replace(templateTokenPattern, "");
      if (withoutTokens.includes("{{") || withoutTokens.includes("}}")) {
        return yield* Effect.fail(new Validation({ message: "Template contains a malformed variable" }));
      }
    }
    return normalized;
  });

const validateMailbox = (value: string, label: string): Effect.Effect<string, Validation> => {
  const normalized = value.trim();
  return mailboxPattern.test(normalized)
    ? Effect.succeed(normalized)
    : Effect.fail(new Validation({ message: `${label} must be a valid email mailbox` }));
};

export const listTemplates = (
  input: ListTemplatesInput,
): Effect.Effect<readonly CommunicationTemplateValue[], AppError, Authorizer | CurrentUser | Db> =>
  Effect.gen(function* () {
    yield* authorizeCurrent(communicationsReadAuthorization, input.eventId);
    const { db } = yield* Db;
    const rows = yield* database(() =>
      db.select().from(emailTemplates).where(eq(emailTemplates.eventId, input.eventId)).orderBy(asc(emailTemplates.name), asc(emailTemplates.id)),
    );
    return rows.map(templateValue);
  });

export const createTemplate = (
  input: CreateTemplateInput,
): Effect.Effect<CommunicationTemplateValue, AppError, Authorizer | CurrentUser | Db> =>
  Effect.gen(function* () {
    const prepared = yield* prepareCommand("comms.createTemplate", input.eventId, input.idempotencyKey, input, CommunicationTemplate);
    if (prepared.replay) return prepared.replay;
    const { db } = yield* Db;
    const normalized = yield* validateTemplate(input.name, input.subject, input.textBody, input.htmlBody);
    const templateId = id("template");
    const output: CommunicationTemplateValue = {
      id: templateId,
      eventId: input.eventId,
      ...normalized,
      attachIcs: input.attachIcs,
      version: 1,
      createdAt: prepared.now.getTime(),
      updatedAt: prepared.now.getTime(),
    };
    const principalActor = actor(prepared.principal);
    yield* database(() => db.batch([
      db.insert(idempotencyRecords).values(idempotencyStart(prepared, input.eventId, "comms.createTemplate")),
      db.insert(emailTemplates).values({
        id: output.id,
        eventId: output.eventId,
        name: output.name,
        subject: output.subject,
        body: encodeTemplateContent(output),
        attachIcs: output.attachIcs,
        version: output.version,
        createdAt: prepared.now,
        updatedAt: prepared.now,
      }),
      db.insert(domainChanges).values({
        id: id("change"), eventId: input.eventId, aggregateType: "communicationTemplate", aggregateId: templateId,
        aggregateVersion: 1, eventType: "comms.template.created", audiences: [{ kind: "admins" }],
        payload: { templateId, name: output.name, attachIcs: output.attachIcs }, ...principalActor,
        requestId: prepared.requestId, idempotencyRecordId: prepared.idempotencyId, occurredAt: prepared.now,
      }),
      db.insert(auditLog).values({
        id: id("audit"), eventId: input.eventId, requestId: prepared.requestId, ...principalActor,
        action: "comms.template.create", resourceType: "communicationTemplate", resourceId: templateId,
        before: null, after: output, metadata: { idempotencyRecordId: prepared.idempotencyId }, occurredAt: prepared.now,
      }),
      db.update(idempotencyRecords).set(idempotencyComplete(prepared, output as unknown as JsonValue)).where(eq(idempotencyRecords.id, prepared.idempotencyId)),
    ])).pipe(
      Effect.catchIf(
        (error) => error.detail?.includes("email_templates_event_name_unique") === true || error.detail?.includes("UNIQUE constraint failed: email_templates.event_id") === true,
        () => Effect.fail(new Conflict({ message: `A template named '${output.name}' already exists` })),
      ),
    );
    return output;
  });

export const updateTemplate = (
  input: UpdateTemplateInput,
): Effect.Effect<CommunicationTemplateValue, AppError, Authorizer | CurrentUser | Db> =>
  Effect.gen(function* () {
    const prepared = yield* prepareCommand("comms.updateTemplate", input.eventId, input.idempotencyKey, input, CommunicationTemplate);
    if (prepared.replay) return prepared.replay;
    const { db } = yield* Db;
    const normalized = yield* validateTemplate(input.name, input.subject, input.textBody, input.htmlBody);
    const [current] = yield* database(() =>
      db.select().from(emailTemplates).where(and(eq(emailTemplates.eventId, input.eventId), eq(emailTemplates.id, input.templateId))).limit(1),
    );
    if (!current) return yield* Effect.fail(new NotFound({ entity: "communicationTemplate", id: input.templateId }));
    if (current.version !== input.expectedVersion) {
      return yield* Effect.fail(new Conflict({ message: `Template version is ${current.version}; expected ${input.expectedVersion}` }));
    }
    const output: CommunicationTemplateValue = {
      id: current.id,
      eventId: current.eventId,
      ...normalized,
      attachIcs: input.attachIcs,
      version: current.version + 1,
      createdAt: current.createdAt.getTime(),
      updatedAt: prepared.now.getTime(),
    };
    const principalActor = actor(prepared.principal);
    yield* database(() => db.batch([
      db.insert(idempotencyRecords).values(idempotencyStart(prepared, input.eventId, "comms.updateTemplate")),
      db.update(emailTemplates).set({
        name: normalized.name,
        subject: normalized.subject,
        body: encodeTemplateContent(normalized),
        attachIcs: input.attachIcs,
        version: output.version,
        updatedAt: prepared.now,
      }).where(and(
        eq(emailTemplates.eventId, input.eventId),
        eq(emailTemplates.id, input.templateId),
        eq(emailTemplates.version, input.expectedVersion),
      )),
      db.insert(domainChanges).values({
        id: id("change"), eventId: input.eventId, aggregateType: "communicationTemplate", aggregateId: input.templateId,
        aggregateVersion: output.version, eventType: "comms.template.updated", audiences: [{ kind: "admins" }],
        payload: { templateId: input.templateId, name: output.name, attachIcs: output.attachIcs }, ...principalActor,
        requestId: prepared.requestId, idempotencyRecordId: prepared.idempotencyId, occurredAt: prepared.now,
      }),
      db.insert(auditLog).values({
        id: id("audit"), eventId: input.eventId, requestId: prepared.requestId, ...principalActor,
        action: "comms.template.update", resourceType: "communicationTemplate", resourceId: input.templateId,
        before: templateValue(current), after: output, metadata: { idempotencyRecordId: prepared.idempotencyId }, occurredAt: prepared.now,
      }),
      db.update(idempotencyRecords).set(idempotencyComplete(prepared, output as unknown as JsonValue)).where(eq(idempotencyRecords.id, prepared.idempotencyId)),
    ])).pipe(
      Effect.catchIf(
        (error) => error.detail?.includes("UNIQUE constraint failed") === true,
        () => Effect.fail(new Conflict({ message: "Template changed concurrently or its name is already in use" })),
      ),
    );
    return output;
  });

interface AudienceRow {
  readonly acceptanceId: string;
  readonly acceptanceType: "accepted" | "revoked";
  readonly occurredAt: Date;
  readonly submissionId: string;
  readonly submissionStatus: string;
  readonly sessionTitle: string;
  readonly speakerId: string;
  readonly speakerName: string;
  readonly userId: string | null;
  readonly email: string | null;
}

const loadAudience = (eventId: string): Effect.Effect<AudienceSnapshot, AppError, Db> =>
  Effect.gen(function* () {
    const { db } = yield* Db;
    const rows: readonly AudienceRow[] = yield* database(() =>
      db.select({
        acceptanceId: acceptanceEvents.id,
        acceptanceType: acceptanceEvents.type,
        occurredAt: acceptanceEvents.occurredAt,
        submissionId: acceptanceEvents.submissionId,
        submissionStatus: submissions.status,
        sessionTitle: submissions.title,
        speakerId: speakers.id,
        speakerName: speakers.displayName,
        userId: speakers.userId,
        email: sql<string | null>`coalesce(${users.email}, ${speakers.contactEmail})`,
      })
        .from(acceptanceEvents)
        .innerJoin(submissions, and(eq(submissions.eventId, acceptanceEvents.eventId), eq(submissions.id, acceptanceEvents.submissionId)))
        .innerJoin(submissionSpeakers, and(
          eq(submissionSpeakers.eventId, acceptanceEvents.eventId),
          eq(submissionSpeakers.submissionId, acceptanceEvents.submissionId),
        ))
        .innerJoin(speakers, and(eq(speakers.eventId, submissionSpeakers.eventId), eq(speakers.id, submissionSpeakers.speakerId)))
        .leftJoin(users, eq(users.id, speakers.userId))
        .where(eq(acceptanceEvents.eventId, eventId))
        .orderBy(asc(acceptanceEvents.occurredAt), asc(acceptanceEvents.id), asc(speakers.id)),
    );
    const latestBySubmission = new Map<string, AudienceRow>();
    for (const row of rows) latestBySubmission.set(row.submissionId, row);
    const bySpeaker = new Map<string, AudienceRecipient>();
    for (const row of rows) {
      if (latestBySubmission.get(row.submissionId)?.acceptanceId !== row.acceptanceId) continue;
      if (row.acceptanceType !== "accepted" || row.submissionStatus !== "accepted") continue;
      const existing = bySpeaker.get(row.speakerId);
      if (existing) {
        bySpeaker.set(row.speakerId, { ...existing, sessionTitles: [...existing.sessionTitles, row.sessionTitle].sort() });
      } else {
        bySpeaker.set(row.speakerId, {
          speakerId: row.speakerId,
          userId: row.userId,
          name: row.speakerName,
          email: row.email,
          sessionTitles: [row.sessionTitle],
          eligibility: row.email === null ? "missingEmail" : "eligible",
        });
      }
    }
    const recipients = [...bySpeaker.values()].sort((left, right) => left.name.localeCompare(right.name) || left.speakerId.localeCompare(right.speakerId));
    return {
      eventId,
      recipients,
      eligibleCount: recipients.filter((recipient) => recipient.eligibility === "eligible").length,
      dependency: "acceptedSpeakers",
    };
  });

export const listAudience = (
  input: ListAudienceInput,
): Effect.Effect<AudienceSnapshot, AppError, Authorizer | CurrentUser | Db> =>
  Effect.gen(function* () {
    yield* authorizeCurrent(communicationsReadAuthorization, input.eventId);
    return yield* loadAudience(input.eventId);
  });

type RenderContext = MergeContext;

interface EventMergeData {
  readonly name: string;
  readonly slug: string;
  readonly location: string | null;
  readonly timezone: string;
  readonly startsAt: Date | null;
  readonly endsAt: Date | null;
}

interface ConfirmedTalkData {
  readonly id: string;
  readonly title: string;
  readonly startsAt: Date;
  readonly durationMin: number;
  readonly roomName: string;
  readonly version: number;
  readonly updatedAt: Date;
}

interface PersonalizedContext {
  readonly context: RenderContext;
  readonly unavailable: readonly (keyof MergeContext)[];
  readonly talks: readonly ConfirmedTalkData[];
}

const renderText = (source: string, context: RenderContext): string =>
  source.replace(templateTokenPattern, (_match, token: keyof RenderContext) => context[token]);

const unavailableEventVariables = (event: EventMergeData): readonly (keyof MergeContext)[] => {
  const unavailable: (keyof MergeContext)[] = [];
  if (!event.location?.trim()) unavailable.push("event.location");
  if (event.startsAt === null && event.endsAt === null) unavailable.push("event.dates");
  return unavailable;
};


const eventIdentity = (eventId: string): Effect.Effect<EventMergeData, AppError, Db> =>
  Effect.gen(function* () {
    const { db } = yield* Db;
    const [event] = yield* database(() => db.select({
      name: events.name,
      slug: events.slug,
      location: events.location,
      timezone: events.timezone,
      startsAt: events.startsAt,
      endsAt: events.endsAt,
    }).from(events).where(eq(events.id, eventId)).limit(1));
    if (!event) return yield* Effect.fail(new NotFound({ entity: "event", id: eventId }));
    return event;
  });

const eventDates = (event: EventMergeData): string => {
  if (event.startsAt === null && event.endsAt === null) return "Dates to be announced";
  const formatter = new Intl.DateTimeFormat("en", { dateStyle: "medium", timeZone: event.timezone });
  if (event.startsAt === null) return `Through ${formatter.format(event.endsAt!)}`;
  if (event.endsAt === null) return formatter.format(event.startsAt);
  return `${formatter.format(event.startsAt)} – ${formatter.format(event.endsAt)}`;
};

interface PublishedTalksBySpeaker {
  readonly publication: PublishedAgenda | null;
  readonly delivery: AgendaDeliveryProjection | null;
  readonly talks: ReadonlyMap<string, readonly ConfirmedTalkData[]>;
}

const loadPublishedTalks = (
  eventId: string,
  eventSlug: string,
  speakerIds: readonly string[],
): Effect.Effect<PublishedTalksBySpeaker, AppError, Db> =>
  Effect.gen(function* () {
    const publication = yield* getPublishedAgenda({ eventSlug }).pipe(
      Effect.catchTag("NotFound", (error) =>
        error.entity === "published agenda" ? Effect.succeed(null) : Effect.fail(error)),
    );
    if (publication === null) return { publication: null, delivery: null, talks: new Map() };
    if (publication.eventId !== eventId) {
      return yield* Effect.fail(new External({
        service: "agenda-publication",
        detail: `Publication key does not match event '${eventId}'`,
      }));
    }
    const delivery = yield* getAgendaDeliveryProjection({
      eventId,
      revision: publication.revision,
    });
    if (speakerIds.length === 0 || publication.talks.length === 0) {
      return { publication, delivery, talks: new Map() };
    }
    const requestedSpeakerIds = new Set(speakerIds);
    const publishedById = new Map(publication.talks.map((talk) => [talk.id, talk] as const));
    const bySpeaker = new Map<string, ConfirmedTalkData[]>();
    for (const deliveryTalk of delivery.talks) {
      const talk = publishedById.get(deliveryTalk.talkId);
      if (!talk) {
        return yield* Effect.fail(new External({
          service: "agenda-delivery-projection",
          detail: `Projection talk '${deliveryTalk.talkId}' is absent from agenda publication ${publication.revision}`,
        }));
      }
      if (talk.room === null) continue;
      for (const speakerId of deliveryTalk.speakerIds) {
        if (!requestedSpeakerIds.has(speakerId)) continue;
        const values = bySpeaker.get(speakerId) ?? [];
        values.push({
          id: talk.id,
          title: talk.title,
          startsAt: new Date(deliveryTalk.startsAt),
          durationMin: deliveryTalk.durationMin,
          roomName: talk.room,
          version: publication.revision,
          updatedAt: new Date(publication.publishedAt),
        });
        bySpeaker.set(speakerId, values);
      }
    }
    for (const values of bySpeaker.values()) {
      values.sort((left, right) =>
        left.startsAt.getTime() - right.startsAt.getTime() ||
        left.title.localeCompare(right.title) ||
        left.id.localeCompare(right.id));
    }
    return { publication, delivery, talks: bySpeaker };
  });

const publicationEventIdentity = (
  current: EventMergeData,
  publication: PublishedAgenda | null,
  delivery: AgendaDeliveryProjection | null,
): EventMergeData => publication === null || delivery === null
  ? current
  : {
      name: publication.eventName,
      slug: publication.eventSlug,
      location: publication.location,
      timezone: publication.timezone,
      startsAt: new Date(delivery.eventStartsAt),
      endsAt: new Date(delivery.eventEndsAt),
    };

const talkTime = (talk: ConfirmedTalkData, timezone: string): string =>
  new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: timezone,
  }).format(talk.startsAt);

const speakerPortalUrl = (appOrigin: string, eventSlug: string): string =>
  new URL(`/e/${encodeURIComponent(eventSlug)}/portal`, new URL(appOrigin).origin).href;

const personalizedContext = (
  recipient: AudienceRecipient,
  event: EventMergeData,
  portalUrl: string,
  confirmedTalks: readonly ConfirmedTalkData[],
): PersonalizedContext => ({
  context: {
    "speaker.name": recipient.name,
    "speaker.email": recipient.email!,
    "event.name": event.name,
    "event.location": event.location?.trim() || "Location to be announced",
    "event.dates": eventDates(event),
    "talk.title": confirmedTalks.length > 0
      ? confirmedTalks.map(({ title }) => title).join(", ")
      : recipient.sessionTitles.join(", "),
    "talk.time": confirmedTalks.length > 0
      ? confirmedTalks.map((talk) => talkTime(talk, event.timezone)).join("; ")
      : "Unavailable: no confirmed agenda time",
    "talk.room": confirmedTalks.length > 0
      ? confirmedTalks.map(({ roomName }) => roomName).join(", ")
      : "Unavailable: no confirmed agenda room",
    "portal.url": portalUrl,
  },
  unavailable: [
    ...unavailableEventVariables(event),
    ...(confirmedTalks.length > 0 ? [] : ["talk.time" as const, "talk.room" as const]),
  ],
  talks: confirmedTalks,
});

const sampleContext = (event: EventMergeData, portalUrl: string): PersonalizedContext => ({
  context: {
    "speaker.name": "Sample Speaker",
    "speaker.email": "speaker@example.com",
    "event.name": event.name,
    "event.location": event.location?.trim() || "Location to be announced",
    "event.dates": eventDates(event),
    "talk.title": "Sample accepted session",
    "talk.time": "Unavailable: select a speaker with a confirmed agenda time",
    "talk.room": "Unavailable: select a speaker with a confirmed agenda room",
    "portal.url": portalUrl,
  },
  unavailable: [...unavailableEventVariables(event), "talk.time", "talk.room"],
  talks: [],
});

const unavailableTokens = (
  unavailable: readonly (keyof MergeContext)[],
  ...values: readonly string[]
): readonly (keyof MergeContext)[] => {
  const unavailableLookup = new Set(unavailable);
  return templateTokens(...values).filter((token) => unavailableLookup.has(token));
};

const wireVariables = (context: RenderContext) =>
  (Object.keys(templateVariableWireKeys) as (keyof MergeContext)[]).map((key) => ({
    key: templateVariableWireKeys[key],
    value: context[key],
  }));

const renderCommunication = (
  subject: string,
  textBody: string,
  htmlBody: string,
  context: RenderContext,
): { readonly subject: string; readonly text: string; readonly html: string } => ({
  subject: renderText(subject, context),
  text: renderText(textBody, context),
  html: htmlBody.replace(
    templateTokenPattern,
    (_match, token: keyof RenderContext) => escapeHtml(context[token]),
  ),
});

const validateRenderedSubject = (
  subject: string,
  recipientName: string,
): Effect.Effect<string, Validation> => {
  if (/\r|\n/.test(subject)) {
    return Effect.fail(new Validation({
      message: `Rendered subject for '${recipientName}' must be a single line`,
    }));
  }
  if (subject.length === 0 || subject.length > 240) {
    return Effect.fail(new Validation({
      message: `Rendered subject for '${recipientName}' must contain between 1 and 240 characters`,
    }));
  }
  return Effect.succeed(subject);
};

const calendarTimestamp = (date: Date): string =>
  date.toISOString().replaceAll("-", "").replaceAll(":", "").replace(/\.\d{3}Z$/, "Z");

const escapeCalendarText = (value: string): string => value
  .replaceAll("\\", "\\\\")
  .replaceAll("\r\n", "\\n")
  .replaceAll("\n", "\\n")
  .replaceAll(",", "\\,")
  .replaceAll(";", "\\;");

const mailboxAddress = (mailbox: string): string => {
  const bracketed = /<([^<>]+)>$/.exec(mailbox);
  return bracketed?.[1] ?? mailbox;
};

const escapeCalendarParameter = (value: string): string => value
  .replaceAll("^", "^^")
  .replaceAll("\r\n", "^n")
  .replaceAll("\n", "^n")
  .replaceAll('"', "^'");

const foldCalendarLine = (line: string): string => {
  let folded = "";
  let physicalLine = "";
  let octets = 0;
  for (const character of line) {
    const codePoint = character.codePointAt(0)!;
    const characterOctets = codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4;
    if (octets + characterOctets > 75 && physicalLine.length > 0) {
      folded += `${physicalLine}\r\n`;
      physicalLine = ` ${character}`;
      octets = 1 + characterOctets;
    } else {
      physicalLine += character;
      octets += characterOctets;
    }
  }
  return folded + physicalLine;
};

const calendarFilename = (event: EventMergeData, recipient: AudienceRecipient): string => {
  const speaker = recipient.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "speaker";
  return `${event.slug}-${speaker}-agenda.ics`;
};

const calendarContent = (
  event: EventMergeData,
  recipient: AudienceRecipient & { readonly email: string },
  confirmedTalks: readonly ConfirmedTalkData[],
  createdAt: Date,
  organizerMailbox: string,
): string => {
  const organizerAddress = mailboxAddress(organizerMailbox);
  const attendee = `ATTENDEE;CN="${escapeCalendarParameter(recipient.name)}";ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:${recipient.email}`;
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Session Party//Speaker Agenda//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:REQUEST",
    ...confirmedTalks.flatMap((talk) => [
      "BEGIN:VEVENT",
      `UID:${escapeCalendarText(`${talk.id}@${event.slug}.session-party`)}`,
      `DTSTAMP:${calendarTimestamp(createdAt)}`,
      `LAST-MODIFIED:${calendarTimestamp(talk.updatedAt)}`,
      `SEQUENCE:${talk.version}`,
      `DTSTART:${calendarTimestamp(talk.startsAt)}`,
      `DTEND:${calendarTimestamp(new Date(talk.startsAt.getTime() + talk.durationMin * 60_000))}`,
      `ORGANIZER:mailto:${organizerAddress}`,
      attendee,
      `SUMMARY:${escapeCalendarText(talk.title)}`,
      `LOCATION:${escapeCalendarText(talk.roomName)}`,
      `DESCRIPTION:${escapeCalendarText(`${recipient.name} — ${event.name}`)}`,
      "END:VEVENT",
    ]),
    "END:VCALENDAR",
    "",
  ];
  return lines.map(foldCalendarLine).join("\r\n");
};

const requestMailQueueWake = (wake: () => Effect.Effect<void>): Effect.Effect<void> =>
  wake().pipe(
    Effect.catchAllCause((cause) =>
      Effect.logWarning("Mail outbox committed but scheduler wake request failed", { cause: String(cause) })),
  );

export const previewCommunication = (
  input: PreviewCommunicationInput,
): Effect.Effect<CommunicationPreview, AppError, Authorizer | CurrentUser | Db | MailQueue> =>
  Effect.gen(function* () {
    yield* authorizeCurrent(communicationsReadAuthorization, input.eventId);
    yield* validateTemplate("Preview", input.subject, input.textBody, input.htmlBody);
    const queue = yield* MailQueue;
    const event = yield* eventIdentity(input.eventId);
    const audience = yield* loadAudience(input.eventId);
    const selected = input.speakerId === null
      ? null
      : audience.recipients.find((recipient) => recipient.speakerId === input.speakerId) ?? null;
    if (input.speakerId !== null && (!selected || selected.email === null)) {
      return yield* Effect.fail(new Validation({ message: "Preview speaker must be an accepted speaker with an email address" }));
    }
    const published = yield* loadPublishedTalks(
      input.eventId,
      event.slug,
      selected ? [selected.speakerId] : [],
    );
    const eventAtPublication = publicationEventIdentity(event, published.publication, published.delivery);
    const portalUrl = speakerPortalUrl(queue.appOrigin, eventAtPublication.slug);
    const personalized = selected
      ? personalizedContext(selected, eventAtPublication, portalUrl, published.talks.get(selected.speakerId) ?? [])
      : sampleContext(eventAtPublication, portalUrl);
    const rendered = renderCommunication(
      input.subject.trim(),
      input.textBody.trim(),
      input.htmlBody.trim(),
      personalized.context,
    );
    const unavailable = unavailableTokens(
      personalized.unavailable,
      input.subject,
      input.textBody,
      input.htmlBody,
    );
    return {
      mode: selected ? "acceptedSpeaker" : "sample",
      ...rendered,
      recipientName: personalized.context["speaker.name"],
      recipientEmail: personalized.context["speaker.email"],
      variables: wireVariables(personalized.context),
      delivery: "notSent",
      icsStatus: input.attachIcs
        ? personalized.talks.length > 0 ? "available" : "unavailableAgenda"
        : "notRequested",
      unavailableVariables: unavailable.map((key) => templateVariableWireKeys[key]),
      note: unavailable.length > 0
        ? "Rendered locally; unavailable values are labeled and no delivery was attempted."
        : selected
          ? "Rendered locally with accepted-speaker and confirmed-agenda data. No delivery was attempted."
          : "Rendered locally with clearly labeled sample data. No delivery was attempted.",
    };
  });

export const enqueueCommunication = (
  input: EnqueueCommunicationInput,
): Effect.Effect<EnqueueCommunicationResult, AppError, Authorizer | CurrentUser | Db | MailQueue> =>
  Effect.gen(function* () {
    const normalizedRequest = { ...input, recipientSpeakerIds: [...input.recipientSpeakerIds].sort() };
    const prepared = yield* prepareCommand(
      "comms.enqueueCommunication",
      input.eventId,
      input.idempotencyKey,
      normalizedRequest,
      EnqueueCommunicationResult,
      (value) => ({ ...value, replayed: true }),
    );
    const queue = yield* MailQueue;
    if (prepared.replay) {
      yield* requestMailQueueWake(queue.wake);
      return prepared.replay;
    }
    const { db } = yield* Db;
    const uniqueSpeakerIds = [...new Set(input.recipientSpeakerIds)];
    if (uniqueSpeakerIds.length !== input.recipientSpeakerIds.length) {
      return yield* Effect.fail(new Validation({ message: "Each audience speaker may be selected only once" }));
    }
    if (uniqueSpeakerIds.length > 500) {
      return yield* Effect.fail(new Validation({
        message: "At most 500 recipients may be queued in one request; Scheduler dispatch budgets govern sending",
      }));
    }
    const replyToEmail = input.replyToEmail === null
      ? null
      : yield* validateMailbox(input.replyToEmail, "Reply-to address");
    const [template] = yield* database(() => db.select().from(emailTemplates).where(and(
      eq(emailTemplates.eventId, input.eventId),
      eq(emailTemplates.id, input.templateId),
    )).limit(1));
    if (!template) return yield* Effect.fail(new NotFound({ entity: "communicationTemplate", id: input.templateId }));
    if (template.version !== input.expectedTemplateVersion) {
      return yield* Effect.fail(new Conflict({
        message: `Template version is ${template.version}; expected ${input.expectedTemplateVersion}`,
      }));
    }
    const templateContent = decodeTemplateContent(template.body);
    const normalizedTemplate = yield* validateTemplate(
      template.name,
      template.subject,
      templateContent.textBody,
      templateContent.htmlBody,
    );
    const event = yield* eventIdentity(input.eventId);
    const audience = yield* loadAudience(input.eventId);
    const audienceBySpeaker = new Map(audience.recipients.map((recipient) => [recipient.speakerId, recipient]));
    const selected = uniqueSpeakerIds.map((speakerId) => audienceBySpeaker.get(speakerId));
    if (selected.some((recipient) => !recipient || recipient.email === null)) {
      return yield* Effect.fail(new Validation({ message: "Audience must contain only accepted speakers with email addresses" }));
    }
    const recipients = selected as readonly (AudienceRecipient & { readonly email: string })[];
    const published = yield* loadPublishedTalks(input.eventId, event.slug, uniqueSpeakerIds);
    const eventAtPublication = publicationEventIdentity(event, published.publication, published.delivery);
    const portalUrl = speakerPortalUrl(queue.appOrigin, eventAtPublication.slug);
    const personalized = recipients.map((recipient) => ({
      recipient,
      prepared: personalizedContext(
        recipient,
        eventAtPublication,
        portalUrl,
        published.talks.get(recipient.speakerId) ?? [],
      ),
    }));
    for (const item of personalized) {
      const unavailable = unavailableTokens(
        item.prepared.unavailable,
        normalizedTemplate.subject,
        normalizedTemplate.textBody,
        normalizedTemplate.htmlBody,
      );
      if (unavailable.includes("event.location") || unavailable.includes("event.dates")) {
        return yield* Effect.fail(new Conflict({
          message: "Delivery cannot resolve event.location or event.dates because event metadata is unavailable",
        }));
      }
      if (unavailable.includes("talk.time") || unavailable.includes("talk.room")) {
        return yield* Effect.fail(new Conflict({
          message: `Accepted speaker '${item.recipient.name}' has no confirmed agenda talk with a start time and room`,
        }));
      }
      if (template.attachIcs && item.prepared.talks.length === 0) {
        return yield* Effect.fail(new Conflict({
          message: `Calendar attachment requires a confirmed agenda talk with a start time and room for '${item.recipient.name}'`,
        }));
      }
      const renderedSubject = renderText(normalizedTemplate.subject, item.prepared.context);
      yield* validateRenderedSubject(renderedSubject, item.recipient.name);
    }
    const scheduledFor = new Date(input.scheduledFor ?? prepared.now.getTime());
    const rows = personalized.map(({ recipient, prepared: personalizedData }, index) => {
      const snapshotId = id("mail_snapshot");
      const deliveryId = id("mail_delivery");
      const rendered = renderCommunication(
        normalizedTemplate.subject,
        normalizedTemplate.textBody,
        normalizedTemplate.htmlBody,
        personalizedData.context,
      );
      return {
        speakerId: recipient.speakerId,
        snapshot: {
          id: snapshotId,
          eventId: input.eventId,
          templateId: template.id,
          recipientUserId: recipient.userId,
          recipientEmail: recipient.email,
          recipientName: recipient.name,
          fromEmail: queue.fromEmail,
          replyToEmail,
          subject: rendered.subject,
          renderedHtml: rendered.html,
          renderedText: rendered.text,
          icsFilename: template.attachIcs ? calendarFilename(eventAtPublication, recipient) : null,
          icsContent: template.attachIcs
            ? calendarContent(eventAtPublication, recipient, personalizedData.talks, prepared.now, queue.fromEmail)
            : null,
          createdAt: prepared.now,
        },
        delivery: {
          id: deliveryId,
          snapshotId,
          idempotencyKey: `comms:${prepared.idempotencyId}:${index}`,
          status: "pending" as const,
          scheduledFor,
          availableAt: scheduledFor,
          attemptCount: 0,
          maxAttempts: 8,
          createdAt: prepared.now,
        },
      };
    });
    const queued = rows.map((row) => ({
      deliveryId: row.delivery.id,
      snapshotId: row.snapshot.id,
      speakerId: row.speakerId,
      recipientEmail: row.snapshot.recipientEmail,
      status: "pending" as const,
      scheduledFor: scheduledFor.getTime(),
    }));
    const output: EnqueueCommunicationResult = {
      eventId: input.eventId,
      templateId: input.templateId,
      queuedAt: prepared.now.getTime(),
      queueState: "persisted",
      dispatchState: "deferred",
      schedulerWake: "requested",
      deliveries: queued as [typeof queued[number], ...typeof queued[number][]],
      replayed: false,
    };
    const principalActor = actor(prepared.principal);
    yield* database(() => db.batch([
      db.insert(idempotencyRecords).values(idempotencyStart(prepared, input.eventId, "comms.enqueueCommunication")),
      ...rows.flatMap((row) => [
        db.insert(mailDeliverySnapshots).values(row.snapshot),
        db.insert(mailDeliveries).values(row.delivery),
      ]),
      db.insert(domainChanges).values({
        id: id("change"), eventId: input.eventId, aggregateType: "communicationsCampaign", aggregateId: prepared.idempotencyId,
        aggregateVersion: 1, eventType: "comms.deliveries.enqueued", audiences: [{ kind: "admins" }],
        payload: {
          templateId: input.templateId,
          deliveryIds: queued.map((delivery) => delivery.deliveryId),
          recipientCount: queued.length,
          dispatchState: "deferred",
          schedulerWake: "deferred",
        },
        ...principalActor, requestId: prepared.requestId, idempotencyRecordId: prepared.idempotencyId, occurredAt: prepared.now,
      }),
      db.insert(auditLog).values({
        id: id("audit"), eventId: input.eventId, requestId: prepared.requestId, ...principalActor,
        action: "comms.deliveries.enqueue", resourceType: "communicationsCampaign", resourceId: prepared.idempotencyId,
        before: null,
        after: {
          templateId: input.templateId,
          deliveryIds: queued.map((delivery) => delivery.deliveryId),
          recipientCount: queued.length,
          dispatchState: "deferred",
        },
        metadata: { idempotencyRecordId: prepared.idempotencyId, schedulerWake: "deferred" },
        occurredAt: prepared.now,
      }),
      db.update(idempotencyRecords).set(idempotencyComplete(prepared, output as unknown as JsonValue)).where(eq(idempotencyRecords.id, prepared.idempotencyId)),
    ])).pipe(
      Effect.catchIf(
        (error) => error.detail?.includes("UNIQUE constraint failed") === true,
        () => Effect.fail(new Conflict({ message: "This communications enqueue was committed concurrently; retry with the same idempotency key" })),
      ),
    );
    yield* requestMailQueueWake(queue.wake);
    return output;
  });

const retryClaimKey = (sourceDeliveryId: string): string => `comms-retry:${sourceDeliveryId}`;

const retrySourceId = (idempotencyKey: string): string | null => {
  const match = /^comms-retry:([^:]+)(?::|$)/.exec(idempotencyKey);
  return match?.[1] ?? null;
};

const loadRetryClaim = (
  db: AppDatabase,
  eventId: string,
  sourceDeliveryId: string,
): Effect.Effect<RetryDeliveryResultValue | null, External> =>
  database(async () => {
    const [claim] = await db.select({
      deliveryId: mailDeliveries.id,
      snapshotId: mailDeliveries.snapshotId,
      queuedAt: mailDeliveries.createdAt,
    })
      .from(mailDeliveries)
      .innerJoin(mailDeliverySnapshots, eq(mailDeliverySnapshots.id, mailDeliveries.snapshotId))
      .where(and(
        eq(mailDeliveries.idempotencyKey, retryClaimKey(sourceDeliveryId)),
        eq(mailDeliverySnapshots.eventId, eventId),
      ))
      .limit(1);
    return claim
      ? {
          eventId,
          sourceDeliveryId,
          deliveryId: claim.deliveryId,
          snapshotId: claim.snapshotId,
          queuedAt: claim.queuedAt.getTime(),
          status: "pending",
          dispatchState: "deferred",
          schedulerWake: "requested",
          replayed: true,
        }
      : null;
  });

export const listDeliveries = (
  input: ListDeliveriesInput,
): Effect.Effect<DeliveryHistory, AppError, Authorizer | CurrentUser | Db> =>
  Effect.gen(function* () {
    yield* authorizeCurrent(communicationsReadAuthorization, input.eventId);
    const { db } = yield* Db;
    const rows = yield* database(() =>
      db.select({
        id: mailDeliveries.id,
        snapshotId: mailDeliveries.snapshotId,
        idempotencyKey: mailDeliveries.idempotencyKey,
        templateId: mailDeliverySnapshots.templateId,
        templateName: emailTemplates.name,
        recipientName: mailDeliverySnapshots.recipientName,
        recipientEmail: mailDeliverySnapshots.recipientEmail,
        subject: mailDeliverySnapshots.subject,
        status: mailDeliveries.status,
        provider: mailDeliveries.provider,
        scheduledFor: mailDeliveries.scheduledFor,
        availableAt: mailDeliveries.availableAt,
        attemptCount: mailDeliveries.attemptCount,
        maxAttempts: mailDeliveries.maxAttempts,
        providerMessageId: mailDeliveries.providerMessageId,
        lastError: mailDeliveries.lastError,
        sentAt: mailDeliveries.sentAt,
        deadLetteredAt: mailDeliveries.deadLetteredAt,
        createdAt: mailDeliveries.createdAt,
      })
        .from(mailDeliveries)
        .innerJoin(mailDeliverySnapshots, eq(mailDeliverySnapshots.id, mailDeliveries.snapshotId))
        .leftJoin(emailTemplates, and(eq(emailTemplates.eventId, mailDeliverySnapshots.eventId), eq(emailTemplates.id, mailDeliverySnapshots.templateId)))
        .where(eq(mailDeliverySnapshots.eventId, input.eventId))
        .orderBy(desc(mailDeliveries.createdAt), desc(mailDeliveries.id)),
    );
    if (rows.length === 0) {
      return { eventId: input.eventId, deliveries: [], localCaptureCount: 0 };
    }
    const attempts = yield* database(() =>
      db.select().from(mailDeliveryAttempts)
        .where(inArray(mailDeliveryAttempts.deliveryId, rows.map((row) => row.id)))
        .orderBy(asc(mailDeliveryAttempts.deliveryId), asc(mailDeliveryAttempts.attemptNumber)),
    );
    const attemptsByDelivery = new Map<string, DeliveryAttempt[]>();
    for (const attempt of attempts) {
      const values = attemptsByDelivery.get(attempt.deliveryId) ?? [];
      values.push({
        id: attempt.id,
        attemptNumber: attempt.attemptNumber,
        status: attempt.status,
        providerMessageId: attempt.providerMessageId,
        error: attempt.error,
        startedAt: attempt.startedAt.getTime(),
        completedAt: toMillis(attempt.completedAt),
      });
      attemptsByDelivery.set(attempt.deliveryId, values);
    }
    const deliveries: DeliveryHistoryItem[] = rows.map((row) => ({
      id: row.id,
      snapshotId: row.snapshotId,
      templateId: row.templateId,
      templateName: row.templateName,
      recipientName: row.recipientName,
      recipientEmail: row.recipientEmail,
      subject: row.subject,
      status: row.status,
      provider: row.provider,
      mode: row.provider === "local-fake" ? "localCapture" : row.status === "sent" ? "live" : "awaitingWorker",
      scheduledFor: row.scheduledFor.getTime(),
      availableAt: row.availableAt.getTime(),
      attemptCount: row.attemptCount,
      maxAttempts: row.maxAttempts,
      providerMessageId: row.providerMessageId,
      lastError: row.lastError,
      sentAt: toMillis(row.sentAt),
      deadLetteredAt: toMillis(row.deadLetteredAt),
      createdAt: row.createdAt.getTime(),
      canRetry: row.status === "dead_letter",
      retryOfDeliveryId: retrySourceId(row.idempotencyKey),
      attempts: attemptsByDelivery.get(row.id) ?? [],
    }));
    return {
      eventId: input.eventId,
      deliveries,
      localCaptureCount: deliveries.filter((delivery) => delivery.mode === "localCapture").length,
    };
  });

export const retryDelivery = (
  input: RetryDeliveryInput,
): Effect.Effect<RetryDeliveryResultValue, AppError, Authorizer | CurrentUser | Db | MailQueue> =>
  Effect.gen(function* () {
    const prepared = yield* prepareCommand(
      "comms.retryDelivery",
      input.eventId,
      input.idempotencyKey,
      input,
      RetryDeliveryResult,
      (value) => ({ ...value, replayed: true }),
    );
    const queue = yield* MailQueue;
    if (prepared.replay) {
      yield* requestMailQueueWake(queue.wake);
      return prepared.replay;
    }
    const { db } = yield* Db;
    const existingClaim = yield* loadRetryClaim(db, input.eventId, input.deliveryId);
    if (existingClaim) {
      yield* requestMailQueueWake(queue.wake);
      return existingClaim;
    }
    const [source] = yield* database(() =>
      db.select({ delivery: mailDeliveries, snapshot: mailDeliverySnapshots })
        .from(mailDeliveries)
        .innerJoin(mailDeliverySnapshots, eq(mailDeliverySnapshots.id, mailDeliveries.snapshotId))
        .where(and(eq(mailDeliveries.id, input.deliveryId), eq(mailDeliverySnapshots.eventId, input.eventId)))
        .limit(1),
    );
    if (!source) return yield* Effect.fail(new NotFound({ entity: "mailDelivery", id: input.deliveryId }));
    if (source.delivery.status !== "dead_letter") {
      return yield* Effect.fail(new Conflict({ message: "Only dead-letter deliveries can be retried manually" }));
    }
    if (source.snapshot.redactedAt !== null || source.snapshot.renderedHtml === null) {
      return yield* Effect.fail(new Conflict({ message: "This delivery snapshot has been redacted and cannot be retried" }));
    }
    const snapshotId = id("mail_snapshot");
    const deliveryId = id("mail_delivery");
    const output: RetryDeliveryResultValue = {
      eventId: input.eventId,
      sourceDeliveryId: input.deliveryId,
      deliveryId,
      snapshotId,
      queuedAt: prepared.now.getTime(),
      status: "pending",
      dispatchState: "deferred",
      schedulerWake: "requested",
      replayed: false,
    };
    const principalActor = actor(prepared.principal);
    const commit = yield* Effect.either(database(() => db.batch([
      db.insert(idempotencyRecords).values(idempotencyStart(prepared, input.eventId, "comms.retryDelivery")),
      db.insert(mailDeliverySnapshots).values({
        id: snapshotId,
        eventId: source.snapshot.eventId,
        templateId: source.snapshot.templateId,
        recipientUserId: source.snapshot.recipientUserId,
        recipientEmail: source.snapshot.recipientEmail,
        recipientName: source.snapshot.recipientName,
        fromEmail: queue.fromEmail,
        replyToEmail: source.snapshot.replyToEmail,
        subject: source.snapshot.subject,
        renderedHtml: source.snapshot.renderedHtml,
        renderedText: source.snapshot.renderedText,
        icsFilename: source.snapshot.icsFilename,
        icsContent: source.snapshot.icsContent,
        createdAt: prepared.now,
      }),
      db.insert(mailDeliveries).values({
        id: deliveryId,
        snapshotId,
        idempotencyKey: retryClaimKey(input.deliveryId),
        status: "pending",
        scheduledFor: prepared.now,
        availableAt: prepared.now,
        attemptCount: 0,
        maxAttempts: 8,
        createdAt: prepared.now,
      }),
      db.insert(domainChanges).values({
        id: id("change"), eventId: input.eventId, aggregateType: "mailDelivery", aggregateId: deliveryId,
        aggregateVersion: 1, eventType: "comms.delivery.retryQueued", audiences: [{ kind: "admins" }],
        payload: {
          sourceDeliveryId: input.deliveryId,
          deliveryId,
          dispatchState: "deferred",
          schedulerWake: "deferred",
        },
        ...principalActor,
        requestId: prepared.requestId,
        idempotencyRecordId: prepared.idempotencyId,
        occurredAt: prepared.now,
      }),
      db.insert(auditLog).values({
        id: id("audit"), eventId: input.eventId, requestId: prepared.requestId, ...principalActor,
        action: "comms.delivery.retry", resourceType: "mailDelivery", resourceId: deliveryId,
        before: { sourceDeliveryId: input.deliveryId, status: source.delivery.status },
        after: output,
        metadata: { idempotencyRecordId: prepared.idempotencyId, schedulerWake: "deferred" },
        occurredAt: prepared.now,
      }),
      db.update(idempotencyRecords).set(idempotencyComplete(prepared, output as unknown as JsonValue)).where(eq(idempotencyRecords.id, prepared.idempotencyId)),
    ])));
    if (commit._tag === "Left") {
      if (!commit.left.detail?.includes("UNIQUE constraint failed")) {
        return yield* Effect.fail(commit.left);
      }
      const concurrentClaim = yield* loadRetryClaim(db, input.eventId, input.deliveryId);
      if (!concurrentClaim) {
        return yield* Effect.fail(new Conflict({
          message: "This delivery retry was committed concurrently but its durable claim could not be loaded",
        }));
      }
      yield* requestMailQueueWake(queue.wake);
      return concurrentClaim;
    }
    yield* requestMailQueueWake(queue.wake);
    return output;
  });
