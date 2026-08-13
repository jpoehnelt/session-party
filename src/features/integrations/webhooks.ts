import { Conflict, NotFound, Validation, type AppError } from "contracts/errors";
import { eventAuthorization } from "contracts/principal";
import {
  auditLog,
  domainChanges,
  idempotencyRecords,
  webhookDeliveries,
  webhookEndpoints,
} from "contracts/schema";
import type { JsonValue } from "contracts/domain";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { Effect } from "effect";
import { nanoid } from "nanoid";
import { Authorizer, CurrentUser, Db } from "@/server/services";
import {
  actorColumns,
  authorizeCurrent,
  database,
  resolveEventId,
  sha256,
} from "./service";
import type {
  CreateWebhookInput,
  CreateWebhookResult,
  DeleteWebhookInput,
  DeleteWebhookResult,
  ListWebhookDeliveriesInput,
  ListWebhookDeliveriesResult,
  ListWebhooksResult,
  RedeliverWebhookInput,
  RedeliverWebhookResult,
  UpdateWebhookInput,
  UpdateWebhookResult,
  WebhookEndpointView,
} from "./schema";

export const webhooksReadAuthorization = eventAuthorization(
  { kind: "event-member", roles: ["owner", "admin"] },
  { kind: "api-key", scopes: ["integrations:read"] },
);

export const webhooksWriteAuthorization = eventAuthorization(
  { kind: "event-member", roles: ["owner", "admin"] },
  { kind: "api-key", scopes: ["integrations:write"] },
);

const MAX_URL_LENGTH = 2_048;

const PRIVATE_HOST_SUFFIXES = [".local", ".internal", ".localhost", ".home.arpa"] as const;

const isPrivateIpv4 = (hostname: string): boolean => {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname);
  if (!match) return false;
  const octets = match.slice(1).map(Number);
  if (octets.some((octet) => octet > 255)) return true;
  const [a, b] = octets as [number, number, number, number];
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
};

const isPrivateIpv6 = (hostname: string): boolean => {
  if (!hostname.startsWith("[") || !hostname.endsWith("]")) return false;
  const address = hostname.slice(1, -1).toLowerCase();
  return address === "::1" || address === "::" || address.startsWith("fc")
    || address.startsWith("fd") || address.startsWith("fe8") || address.startsWith("fe9")
    || address.startsWith("fea") || address.startsWith("feb");
};

/**
 * Webhook targets must be public HTTPS origins. The Worker only ever makes
 * this request itself, so the checks are a courtesy fence against obviously
 * internal destinations rather than a substitute for network policy.
 */
export const validateWebhookUrl = (raw: string): URL | null => {
  if (raw.length > MAX_URL_LENGTH) return null;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:") return null;
  if (parsed.username || parsed.password) return null;
  const hostname = parsed.hostname.toLowerCase();
  if (hostname === "localhost" || hostname.length === 0) return null;
  if (PRIVATE_HOST_SUFFIXES.some((suffix) => hostname.endsWith(suffix))) return null;
  if (isPrivateIpv4(hostname) || isPrivateIpv6(hostname)) return null;
  return parsed;
};

const generateSigningSecret = (): string => {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return `whsec_${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
};

const endpointView = (row: typeof webhookEndpoints.$inferSelect): WebhookEndpointView => ({
  id: row.id,
  eventId: row.eventId,
  url: row.url,
  description: row.description,
  kinds: row.kinds,
  status: row.status,
  cursorSequence: row.cursorSequence,
  version: row.version,
  createdAt: row.createdAt.getTime(),
  updatedAt: row.updatedAt.getTime(),
});

interface CommandContext {
  readonly eventId: string;
  readonly principalId: string;
  readonly keyHash: string;
  readonly requestHash: string;
}

/**
 * The slice's replay contract: an idempotency key replays its completed
 * response, conflicts when reused for a different request, and conflicts
 * while an equivalent command is still in flight.
 */
const replayOrPrepare = <Result>(
  operationId: string,
  idOrSlug: string,
  policyEventId: string | null,
  idempotencyKey: string,
  request: JsonValue,
): Effect.Effect<
  { readonly replay: Result & { replayed: true } } | { readonly context: CommandContext },
  AppError,
  Authorizer | CurrentUser | Db
> =>
  Effect.gen(function* () {
    const { db } = yield* Db;
    const eventId = policyEventId ?? (yield* resolveEventId(idOrSlug));
    const principal = yield* authorizeCurrent(webhooksWriteAuthorization, eventId);
    const [keyHash, requestHash] = yield* Effect.all([
      sha256(idempotencyKey),
      sha256(JSON.stringify(request)),
    ]);
    const principalId = principal.kind === "api-key" ? `api-key:${principal.apiKeyId}` : `user:${principal.userId}`;
    const [existing] = yield* database(() => db.select().from(idempotencyRecords).where(and(
      eq(idempotencyRecords.eventId, eventId),
      eq(idempotencyRecords.operationId, operationId),
      eq(idempotencyRecords.principalId, principalId),
      eq(idempotencyRecords.keyHash, keyHash),
    )).limit(1));
    if (existing) {
      if (existing.requestHash !== requestHash) {
        return yield* Effect.fail(new Conflict({ message: "Idempotency key was already used for a different request" }));
      }
      if (existing.status !== "completed" || existing.responseBody === null) {
        return yield* Effect.fail(new Conflict({ message: "An equivalent webhook command is in progress" }));
      }
      return { replay: { ...(existing.responseBody as Result), replayed: true as const } };
    }
    return { context: { eventId, principalId, keyHash, requestHash } };
  });

const completedIdempotencyRow = (
  context: CommandContext,
  operationId: string,
  result: JsonValue,
  now: Date,
  responseStatus: number,
) => ({
  id: `idempotency_${nanoid()}`,
  eventId: context.eventId,
  operationId,
  principalId: context.principalId,
  keyHash: context.keyHash,
  requestHash: context.requestHash,
  status: "completed" as const,
  responseStatus,
  responseBody: result,
  expiresAt: new Date(now.getTime() + 86_400_000),
  completedAt: now,
  createdAt: now,
});

export const createWebhook = (
  input: CreateWebhookInput,
): Effect.Effect<CreateWebhookResult, AppError, Authorizer | CurrentUser | Db> =>
  Effect.gen(function* () {
    if (!validateWebhookUrl(input.url)) {
      return yield* Effect.fail(new Validation({
        message: "Webhook URL must be a public https origin without credentials",
      }));
    }
    const { db } = yield* Db;
    const prepared = yield* replayOrPrepare<CreateWebhookResult>(
      "integrations.createWebhook",
      input.idOrSlug,
      null,
      input.idempotencyKey,
      { url: input.url, description: input.description ?? null, kinds: input.kinds } as unknown as JsonValue,
    );
    if ("replay" in prepared) return prepared.replay;
    const { context } = prepared;
    const principal = yield* CurrentUser;
    const now = new Date();
    // New endpoints start at the head of the change log: webhooks announce
    // what happens next, never backfill history the subscriber predates.
    const [head] = yield* database(() => db
      .select({ sequence: sql<number>`coalesce(max(${domainChanges.sequence}), 0)` })
      .from(domainChanges));
    const signingSecret = generateSigningSecret();
    const webhookId = `webhook_${nanoid()}`;
    const row = {
      id: webhookId,
      eventId: context.eventId,
      url: input.url,
      description: input.description ?? null,
      kinds: input.kinds,
      signingSecret,
      status: "active" as const,
      cursorSequence: head?.sequence ?? 0,
      createdBy: principal.kind === "api-key" ? principal.apiKeyId : principal.userId,
      version: 1,
      createdAt: now,
      updatedAt: now,
    };
    const result: CreateWebhookResult = {
      webhook: endpointView({ ...row, createdAt: now, updatedAt: now }),
      signingSecret,
      replayed: false,
    };
    const persistedResult = { ...result, signingSecret: "" };
    const actor = actorColumns(principal);
    const commit = yield* Effect.either(database(() => db.batch([
      db.insert(webhookEndpoints).values(row),
      db.insert(idempotencyRecords).values(completedIdempotencyRow(
        context,
        "integrations.createWebhook",
        persistedResult as unknown as JsonValue,
        now,
        201,
      )),
      db.insert(domainChanges).values({
        id: `change_${nanoid()}`,
        eventId: context.eventId,
        aggregateType: "webhookEndpoint",
        aggregateId: webhookId,
        aggregateVersion: 1,
        eventType: "integrations.webhook.created",
        audiences: [{ kind: "admins" }],
        payload: { webhookId, url: input.url, kinds: input.kinds },
        ...actor,
        requestId: `webhooks-${context.keyHash.slice(0, 24)}`,
        occurredAt: now,
      }),
      db.insert(auditLog).values({
        id: `audit_${nanoid()}`,
        eventId: context.eventId,
        requestId: `webhooks-${context.keyHash.slice(0, 24)}`,
        ...actor,
        action: "integrations.webhook.create",
        resourceType: "webhookEndpoint",
        resourceId: webhookId,
        before: null,
        after: { url: input.url, kinds: input.kinds, status: "active" },
        metadata: null,
        occurredAt: now,
      }),
    ])));
    if (commit._tag === "Left") {
      if (commit.left.detail?.includes("UNIQUE constraint failed")) {
        return yield* Effect.fail(new Conflict({ message: "A webhook for this URL already exists on this event" }));
      }
      return yield* Effect.fail(commit.left);
    }
    return result;
  });

export const listWebhooks = (
  idOrSlug: string,
): Effect.Effect<ListWebhooksResult, AppError, Authorizer | CurrentUser | Db> =>
  Effect.gen(function* () {
    const { db } = yield* Db;
    const eventId = yield* resolveEventId(idOrSlug);
    yield* authorizeCurrent(webhooksReadAuthorization, eventId);
    const rows = yield* database(() => db.select().from(webhookEndpoints)
      .where(eq(webhookEndpoints.eventId, eventId))
      .orderBy(asc(webhookEndpoints.createdAt), asc(webhookEndpoints.id)));
    const stats = yield* database(() => db
      .select({
        endpointId: webhookDeliveries.endpointId,
        deadLetterCount: sql<number>`sum(case when ${webhookDeliveries.status} = 'dead_letter' then 1 else 0 end)`,
        pendingCount: sql<number>`sum(case when ${webhookDeliveries.status} in ('pending', 'retry') then 1 else 0 end)`,
        lastDeliveredAt: sql<number | null>`max(${webhookDeliveries.deliveredAt})`,
      })
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.eventId, eventId))
      .groupBy(webhookDeliveries.endpointId));
    const statsByEndpoint = new Map(stats.map((row) => [row.endpointId, row]));
    return {
      eventId,
      webhooks: rows.map((row) => {
        const stat = statsByEndpoint.get(row.id);
        return {
          ...endpointView(row),
          deadLetterCount: stat?.deadLetterCount ?? 0,
          pendingCount: stat?.pendingCount ?? 0,
          lastDeliveredAt: stat?.lastDeliveredAt ?? null,
        };
      }),
    };
  });

export const updateWebhook = (
  input: UpdateWebhookInput,
): Effect.Effect<UpdateWebhookResult, AppError, Authorizer | CurrentUser | Db> =>
  Effect.gen(function* () {
    if (input.url !== undefined && !validateWebhookUrl(input.url)) {
      return yield* Effect.fail(new Validation({
        message: "Webhook URL must be a public https origin without credentials",
      }));
    }
    const { db } = yield* Db;
    const prepared = yield* replayOrPrepare<UpdateWebhookResult>(
      "integrations.updateWebhook",
      input.idOrSlug,
      null,
      input.idempotencyKey,
      {
        webhookId: input.webhookId,
        expectedVersion: input.expectedVersion,
        url: input.url ?? null,
        description: input.description === undefined ? "__unchanged__" : input.description,
        kinds: input.kinds ?? null,
        status: input.status ?? null,
        rotateSecret: input.rotateSecret ?? false,
      } as unknown as JsonValue,
    );
    if ("replay" in prepared) return prepared.replay;
    const { context } = prepared;
    const principal = yield* CurrentUser;
    const [stored] = yield* database(() => db.select().from(webhookEndpoints).where(and(
      eq(webhookEndpoints.eventId, context.eventId),
      eq(webhookEndpoints.id, input.webhookId),
    )).limit(1));
    if (!stored) return yield* Effect.fail(new NotFound({ entity: "webhookEndpoint", id: input.webhookId }));
    if (stored.version !== input.expectedVersion) {
      return yield* Effect.fail(new Conflict({
        message: `Webhook version is ${stored.version}; expected ${input.expectedVersion}`,
      }));
    }
    const now = new Date();
    const nextSecret = input.rotateSecret ? generateSigningSecret() : null;
    const next = {
      url: input.url ?? stored.url,
      description: input.description === undefined ? stored.description : input.description,
      kinds: input.kinds ?? stored.kinds,
      status: input.status ?? stored.status,
      signingSecret: nextSecret ?? stored.signingSecret,
      version: stored.version + 1,
      updatedAt: now,
    };
    const result: UpdateWebhookResult = {
      webhook: endpointView({ ...stored, ...next }),
      signingSecret: nextSecret,
      replayed: false,
    };
    const persistedResult = { ...result, signingSecret: null };
    const actor = actorColumns(principal);
    const commit = yield* Effect.either(database(() => db.batch([
      db.update(webhookEndpoints).set(next).where(and(
        eq(webhookEndpoints.eventId, context.eventId),
        eq(webhookEndpoints.id, input.webhookId),
        eq(webhookEndpoints.version, input.expectedVersion),
      )),
      db.insert(idempotencyRecords).values(completedIdempotencyRow(
        context,
        "integrations.updateWebhook",
        persistedResult as unknown as JsonValue,
        now,
        200,
      )),
      db.insert(domainChanges).values({
        id: `change_${nanoid()}`,
        eventId: context.eventId,
        aggregateType: "webhookEndpoint",
        aggregateId: input.webhookId,
        aggregateVersion: stored.version + 1,
        eventType: "integrations.webhook.updated",
        audiences: [{ kind: "admins" }],
        payload: {
          webhookId: input.webhookId,
          status: next.status,
          kinds: next.kinds,
          rotatedSecret: input.rotateSecret === true,
        },
        ...actor,
        requestId: `webhooks-${context.keyHash.slice(0, 24)}`,
        occurredAt: now,
      }),
      db.insert(auditLog).values({
        id: `audit_${nanoid()}`,
        eventId: context.eventId,
        requestId: `webhooks-${context.keyHash.slice(0, 24)}`,
        ...actor,
        action: "integrations.webhook.update",
        resourceType: "webhookEndpoint",
        resourceId: input.webhookId,
        before: { url: stored.url, kinds: stored.kinds, status: stored.status, version: stored.version },
        after: { url: next.url, kinds: next.kinds, status: next.status, version: next.version },
        metadata: { rotatedSecret: input.rotateSecret === true },
        occurredAt: now,
      }),
    ])));
    if (commit._tag === "Left") {
      if (commit.left.detail?.includes("UNIQUE constraint failed")) {
        return yield* Effect.fail(new Conflict({ message: "A webhook for this URL already exists on this event" }));
      }
      return yield* Effect.fail(commit.left);
    }
    return result;
  });

export const deleteWebhook = (
  input: DeleteWebhookInput,
): Effect.Effect<DeleteWebhookResult, AppError, Authorizer | CurrentUser | Db> =>
  Effect.gen(function* () {
    const { db } = yield* Db;
    const prepared = yield* replayOrPrepare<DeleteWebhookResult>(
      "integrations.deleteWebhook",
      input.idOrSlug,
      null,
      input.idempotencyKey,
      { webhookId: input.webhookId, expectedVersion: input.expectedVersion } as unknown as JsonValue,
    );
    if ("replay" in prepared) return prepared.replay;
    const { context } = prepared;
    const principal = yield* CurrentUser;
    const [stored] = yield* database(() => db.select().from(webhookEndpoints).where(and(
      eq(webhookEndpoints.eventId, context.eventId),
      eq(webhookEndpoints.id, input.webhookId),
    )).limit(1));
    if (!stored) return yield* Effect.fail(new NotFound({ entity: "webhookEndpoint", id: input.webhookId }));
    if (stored.version !== input.expectedVersion) {
      return yield* Effect.fail(new Conflict({
        message: `Webhook version is ${stored.version}; expected ${input.expectedVersion}`,
      }));
    }
    const now = new Date();
    const result: DeleteWebhookResult = { webhookId: input.webhookId, deleted: true, replayed: false };
    const actor = actorColumns(principal);
    yield* database(() => db.batch([
      db.delete(webhookEndpoints).where(and(
        eq(webhookEndpoints.eventId, context.eventId),
        eq(webhookEndpoints.id, input.webhookId),
        eq(webhookEndpoints.version, input.expectedVersion),
      )),
      db.insert(idempotencyRecords).values(completedIdempotencyRow(
        context,
        "integrations.deleteWebhook",
        result as unknown as JsonValue,
        now,
        200,
      )),
      db.insert(domainChanges).values({
        id: `change_${nanoid()}`,
        eventId: context.eventId,
        aggregateType: "webhookEndpoint",
        aggregateId: input.webhookId,
        aggregateVersion: stored.version + 1,
        eventType: "integrations.webhook.deleted",
        audiences: [{ kind: "admins" }],
        payload: { webhookId: input.webhookId },
        ...actor,
        requestId: `webhooks-${context.keyHash.slice(0, 24)}`,
        occurredAt: now,
      }),
      db.insert(auditLog).values({
        id: `audit_${nanoid()}`,
        eventId: context.eventId,
        requestId: `webhooks-${context.keyHash.slice(0, 24)}`,
        ...actor,
        action: "integrations.webhook.delete",
        resourceType: "webhookEndpoint",
        resourceId: input.webhookId,
        before: { url: stored.url, kinds: stored.kinds, status: stored.status, version: stored.version },
        after: null,
        metadata: null,
        occurredAt: now,
      }),
    ]));
    return result;
  });

export const listWebhookDeliveries = (
  input: ListWebhookDeliveriesInput,
): Effect.Effect<ListWebhookDeliveriesResult, AppError, Authorizer | CurrentUser | Db> =>
  Effect.gen(function* () {
    const { db } = yield* Db;
    const eventId = yield* resolveEventId(input.idOrSlug);
    yield* authorizeCurrent(webhooksReadAuthorization, eventId);
    const [endpoint] = yield* database(() => db.select({ id: webhookEndpoints.id }).from(webhookEndpoints).where(and(
      eq(webhookEndpoints.eventId, eventId),
      eq(webhookEndpoints.id, input.webhookId),
    )).limit(1));
    if (!endpoint) return yield* Effect.fail(new NotFound({ entity: "webhookEndpoint", id: input.webhookId }));
    const pageSize = input.pageSize ?? 25;
    const page = input.page ?? 1;
    const rows = yield* database(() => db.select().from(webhookDeliveries)
      .where(and(
        eq(webhookDeliveries.eventId, eventId),
        eq(webhookDeliveries.endpointId, input.webhookId),
      ))
      .orderBy(desc(webhookDeliveries.createdAt), desc(webhookDeliveries.id))
      .limit(pageSize + 1)
      .offset((page - 1) * pageSize));
    return {
      eventId,
      webhookId: input.webhookId,
      page,
      pageSize,
      hasMore: rows.length > pageSize,
      deliveries: rows.slice(0, pageSize).map((row) => ({
        id: row.id,
        changeSequence: row.changeSequence,
        eventType: row.eventType,
        status: row.status,
        attemptCount: row.attemptCount,
        maxAttempts: row.maxAttempts,
        availableAt: row.availableAt.getTime(),
        responseStatus: row.responseStatus,
        lastError: row.lastError,
        deliveredAt: row.deliveredAt?.getTime() ?? null,
        deadLetteredAt: row.deadLetteredAt?.getTime() ?? null,
        createdAt: row.createdAt.getTime(),
        canRedeliver: row.status === "dead_letter" || row.status === "retry",
      })),
    };
  });

export const redeliverWebhook = (
  input: RedeliverWebhookInput,
): Effect.Effect<RedeliverWebhookResult, AppError, Authorizer | CurrentUser | Db> =>
  Effect.gen(function* () {
    const { db } = yield* Db;
    const prepared = yield* replayOrPrepare<RedeliverWebhookResult>(
      "integrations.redeliverWebhook",
      input.idOrSlug,
      null,
      input.idempotencyKey,
      { deliveryId: input.deliveryId } as unknown as JsonValue,
    );
    if ("replay" in prepared) return prepared.replay;
    const { context } = prepared;
    const principal = yield* CurrentUser;
    const [stored] = yield* database(() => db.select().from(webhookDeliveries).where(and(
      eq(webhookDeliveries.eventId, context.eventId),
      eq(webhookDeliveries.id, input.deliveryId),
    )).limit(1));
    if (!stored) return yield* Effect.fail(new NotFound({ entity: "webhookDelivery", id: input.deliveryId }));
    if (stored.status !== "dead_letter" && stored.status !== "retry") {
      return yield* Effect.fail(new Conflict({
        message: "Only scheduled retries and dead-letter webhook deliveries can be redelivered manually",
      }));
    }
    const now = new Date();
    const result: RedeliverWebhookResult = { deliveryId: input.deliveryId, status: "pending", replayed: false };
    const actor = actorColumns(principal);
    yield* database(() => db.batch([
      // Compare-and-swap on the observed status: a delivery the dispatcher
      // claimed in the meantime is already being sent and is left alone.
      db.update(webhookDeliveries).set({
        status: "pending",
        availableAt: now,
        attemptCount: 0,
        deadLetteredAt: null,
        updatedAt: now,
      }).where(and(
        eq(webhookDeliveries.id, input.deliveryId),
        eq(webhookDeliveries.status, stored.status),
      )),
      db.insert(idempotencyRecords).values(completedIdempotencyRow(
        context,
        "integrations.redeliverWebhook",
        result as unknown as JsonValue,
        now,
        200,
      )),
      db.insert(auditLog).values({
        id: `audit_${nanoid()}`,
        eventId: context.eventId,
        requestId: `webhooks-${context.keyHash.slice(0, 24)}`,
        ...actor,
        action: "integrations.webhook.redeliver",
        resourceType: "webhookDelivery",
        resourceId: input.deliveryId,
        before: { status: stored.status, attemptCount: stored.attemptCount },
        after: result,
        metadata: null,
        occurredAt: now,
      }),
    ]));
    return result;
  });
