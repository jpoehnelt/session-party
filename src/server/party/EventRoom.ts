import { ApiScope, ApiScopes, type EventRole, type Principal } from "contracts/principal";
import type {
  ClientMessage,
  EventAudience,
  EventRoomBroadcast,
  PresenceUser,
  ServerMessage,
} from "contracts/protocol";
import { apiKeys, authTokens, eventMembers } from "contracts/schema";
import { Server, type Connection, type ConnectionContext, type WSMessage } from "partyserver";
import { and, eq, gt, isNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { Schema } from "effect";
import { userFromRequest } from "../auth";
import { partyHandlers } from "../registry.gen";
import { sessionSecret } from "../services";

const MAX_MESSAGE_BYTES = 32 * 1024;
const MAX_MESSAGES_PER_MINUTE = 120;
const MAX_SURFACE_LENGTH = 120;
const MAX_CORRELATION_LENGTH = 128;

type RoomAuthorization = {
  readonly kind: "browser-session" | "api-key";
  readonly credentialId: string;
  readonly expiresAt: number;
  readonly role?: EventRole;
  readonly audiences: readonly EventAudience[];
  readonly capabilities: readonly ApiScope[];
};

export interface EventRoomConnectionState {
  readonly user: {
    readonly userId: string;
    readonly name: string;
  };
  readonly surface: string;
  readonly authorization: RoomAuthorization;
  readonly rateWindowStartedAt: number;
  readonly messagesInWindow: number;
}

const isBoundedString = (value: unknown, maxLength: number): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= maxLength;
const isPositiveInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value > 0;
const isOptionalId = (value: unknown): value is string | null =>
  value === null || isBoundedString(value, 255);

const decodeClientMessage = (value: unknown): ClientMessage | null => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const input = value as { readonly [field: string]: unknown };
  switch (input.t) {
    case "room/hello":
      return typeof input.surface === "string" && input.surface.length <= MAX_SURFACE_LENGTH
        ? { t: input.t, surface: input.surface }
        : null;
    case "agenda/move":
      return isBoundedString(input.requestId, MAX_CORRELATION_LENGTH) &&
        isBoundedString(input.idempotencyKey, 255) &&
        isBoundedString(input.talkId, 255) &&
        isOptionalId(input.trackId) &&
        isOptionalId(input.roomId) &&
        ((typeof input.startsAt === "number" && Number.isFinite(input.startsAt)) || input.startsAt === null) &&
        isPositiveInteger(input.durationMin) &&
        isPositiveInteger(input.expectedVersion)
        ? {
            t: input.t,
            requestId: input.requestId,
            idempotencyKey: input.idempotencyKey,
            talkId: input.talkId,
            trackId: input.trackId,
            roomId: input.roomId,
            startsAt: input.startsAt,
            durationMin: input.durationMin,
            expectedVersion: input.expectedVersion,
          }
        : null;
    case "agenda/resize":
      return isBoundedString(input.requestId, MAX_CORRELATION_LENGTH) &&
        isBoundedString(input.idempotencyKey, 255) &&
        isBoundedString(input.talkId, 255) &&
        isPositiveInteger(input.durationMin) &&
        isPositiveInteger(input.expectedVersion)
        ? {
            t: input.t,
            requestId: input.requestId,
            idempotencyKey: input.idempotencyKey,
            talkId: input.talkId,
            durationMin: input.durationMin,
            expectedVersion: input.expectedVersion,
          }
        : null;
    default:
      return null;
  }
};

const messageBytes = (message: WSMessage): number => {
  if (typeof message === "string") {
    if (message.length > MAX_MESSAGE_BYTES) return message.length;
    return new TextEncoder().encode(message).byteLength;
  }
  return message instanceof ArrayBuffer ? message.byteLength : message.byteLength;
};

const parseMessage = (message: WSMessage): unknown => {
  if (typeof message === "string") return JSON.parse(message);
  if (message instanceof ArrayBuffer) return JSON.parse(new TextDecoder().decode(message));
  return JSON.parse(
    new TextDecoder().decode(
      new Uint8Array(message.buffer, message.byteOffset, message.byteLength),
    ),
  );
};

const browserCapabilities = (role: EventRole): readonly ApiScope[] =>
  role === "owner" || role === "admin" ? ["agenda:write"] : [];

const browserAuthorization = (
  principal: Extract<Principal, { kind: "browser-session" }>,
  role: EventRole,
): RoomAuthorization => ({
  kind: principal.kind,
  credentialId: principal.sessionId,
  expiresAt: principal.expiresAt,
  role,
  audiences: ["members", `role:${role}`],
  capabilities: browserCapabilities(role),
});

const apiKeyAuthorization = (
  principal: Extract<Principal, { kind: "api-key" }>,
  scopes: readonly ApiScope[] = principal.scopes,
): RoomAuthorization => ({
  kind: principal.kind,
  credentialId: principal.apiKeyId,
  expiresAt: principal.expiresAt,
  audiences: scopes.map((scope): EventAudience => `scope:${scope}`),
  capabilities: scopes,
});

const replyToFor = (message: ClientMessage): string | undefined =>
  "requestId" in message ? message.requestId : undefined;

export const audiencesForServerMessage = (
  message: ServerMessage,
): readonly EventAudience[] | null => {
  switch (message.t) {
    case "room/presence":
      return ["members"];
    case "room/error":
      return null;
    case "agenda/talk_upserted":
    case "agenda/talk_deleted":
    case "agenda/conflicts":
      return ["role:owner", "role:admin", "role:reviewer", "scope:agenda:read"];
    case "dashboard/progress":
      return ["role:owner", "role:admin", "scope:speakers:read", "scope:content:read"];
    case "review/scored":
      return ["role:owner", "role:admin", "role:reviewer", "scope:reviews:read"];
    case "submissions/new":
      return ["role:owner", "role:admin", "role:reviewer", "scope:submissions:read"];
  }
};

const decodeBroadcast = (value: unknown): EventRoomBroadcast | null => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const input = value as { readonly [field: string]: unknown };
  if (
    typeof input.message !== "object" ||
    input.message === null ||
    Array.isArray(input.message)
  ) {
    return null;
  }
  const message = input.message as ServerMessage;
  return typeof message.t === "string" && audiencesForServerMessage(message)
    ? { message }
    : null;
};

export class EventRoom extends Server<Env> {
  static override options = { hibernate: true };

  override async onConnect(
    connection: Connection<EventRoomConnectionState>,
    context: ConnectionContext,
  ): Promise<void> {
    try {
      const principal = await userFromRequest(context.request, this.env);
      if (!principal) {
        connection.close(4401, "Authentication required");
        return;
      }

      const authorization = await this.initialAuthorization(principal);
      if (!authorization) {
        connection.close(4403, "Event access denied");
        return;
      }

      connection.setState({
        user: { userId: principal.userId, name: principal.name },
        surface: "",
        authorization,
        rateWindowStartedAt: Date.now(),
        messagesInWindow: 0,
      });
      this.broadcastPresence();
    } catch (error) {
      console.error(JSON.stringify({
        message: "event room connection authorization failed",
        room: this.name,
        error: error instanceof Error ? error.message : String(error),
      }));
      connection.close(1011, "Authorization unavailable");
    }
  }

  override async onMessage(
    connection: Connection<EventRoomConnectionState>,
    rawMessage: WSMessage,
  ): Promise<void> {
    const state = this.consumeMessageBudget(connection);
    if (!state) return;
    if (messageBytes(rawMessage) > MAX_MESSAGE_BYTES) {
      connection.send(JSON.stringify({ t: "room/error", message: "Message too large" } satisfies ServerMessage));
      return;
    }

    let message: ClientMessage | null = null;
    try {
      message = decodeClientMessage(parseMessage(rawMessage));
    } catch {
      // The common invalid-message response below is intentionally non-specific.
    }

    if (!message) {
      connection.send(JSON.stringify({ t: "room/error", message: "Invalid message" } satisfies ServerMessage));
      return;
    }

    if (message.t === "room/hello") {
      connection.setState({ ...state, surface: message.surface });
      this.broadcastPresence();
      return;
    }

    const refreshed = await this.revalidateAuthorization(state);
    if (!refreshed) {
      connection.close(4403, "Event access expired");
      return;
    }
    connection.setState(refreshed);

    const requiredCapability = await this.requiredCapability(message);
    if (!requiredCapability || !refreshed.authorization.capabilities.includes(requiredCapability)) {
      connection.send(JSON.stringify({
        t: "room/error",
        message: "Access denied",
        replyTo: replyToFor(message),
      } satisfies ServerMessage));
      return;
    }

    const prefix = message.t.split("/", 1)[0];
    const handler = prefix ? partyHandlers[prefix] : undefined;
    if (!handler) {
      connection.send(
        JSON.stringify({
          t: "room/error",
          message: `No handler for ${message.t}`,
          replyTo: replyToFor(message),
        } satisfies ServerMessage),
      );
      return;
    }

    try {
      await handler(this, connection, message);
    } catch (error) {
      console.error(
        JSON.stringify({
          message: "party handler failed",
          room: this.name,
          type: message.t,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
      connection.send(
        JSON.stringify({
          t: "room/error",
          message: "Message could not be applied",
          replyTo: replyToFor(message),
        } satisfies ServerMessage),
      );
    }
  }

  override onClose(): void {
    this.broadcastPresence();
  }

  override async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== "POST" || url.pathname !== "/broadcast") {
      return new Response("Not found", { status: 404 });
    }

    let secret: string;
    try {
      secret = sessionSecret(this.env);
    } catch {
      return new Response("Internal broadcast unavailable", { status: 503 });
    }
    if (request.headers.get("x-session-party-internal") !== secret) {
      return new Response("Forbidden", { status: 403 });
    }

    let broadcast: EventRoomBroadcast | null = null;
    try {
      broadcast = decodeBroadcast(await request.json());
    } catch {
      // The common invalid-request response below is intentionally non-specific.
    }
    if (!broadcast) return new Response("Invalid broadcast", { status: 400 });

    this.broadcastAuthorized(broadcast.message);
    return Response.json({ ok: true });
  }

  private async initialAuthorization(principal: Principal): Promise<RoomAuthorization | null> {
    if (principal.kind === "api-key") {
      return principal.eventId === this.name ? apiKeyAuthorization(principal) : null;
    }

    const db = drizzle(this.env.DB);
    const [membership] = await db
      .select({ role: eventMembers.role })
      .from(eventMembers)
      .where(and(eq(eventMembers.eventId, this.name), eq(eventMembers.userId, principal.userId)))
      .limit(1);
    return membership ? browserAuthorization(principal, membership.role) : null;
  }

  private async revalidateAuthorization(
    state: EventRoomConnectionState,
  ): Promise<EventRoomConnectionState | null> {
    const db = drizzle(this.env.DB);
    const now = new Date();
    if (state.authorization.kind === "browser-session") {
      const [row] = await db
        .select({ role: eventMembers.role, expiresAt: authTokens.expiresAt })
        .from(authTokens)
        .innerJoin(
          eventMembers,
          and(
            eq(eventMembers.eventId, this.name),
            eq(eventMembers.userId, authTokens.userId),
          ),
        )
        .where(and(
          eq(authTokens.id, state.authorization.credentialId),
          eq(authTokens.userId, state.user.userId),
          eq(authTokens.kind, "session"),
          gt(authTokens.expiresAt, now),
          isNull(authTokens.consumedAt),
        ))
        .limit(1);
      if (!row) return null;
      const principal: Extract<Principal, { kind: "browser-session" }> = {
        kind: "browser-session",
        userId: state.user.userId,
        email: "",
        name: state.user.name,
        sessionId: state.authorization.credentialId,
        expiresAt: row.expiresAt.getTime(),
      };
      return { ...state, authorization: browserAuthorization(principal, row.role) };
    }

    const [row] = await db
      .select({ scopes: apiKeys.scopes, expiresAt: apiKeys.expiresAt })
      .from(apiKeys)
      .where(and(
        eq(apiKeys.id, state.authorization.credentialId),
        eq(apiKeys.eventId, this.name),
        gt(apiKeys.expiresAt, now),
        isNull(apiKeys.revokedAt),
      ))
      .limit(1);
    if (!row) return null;
    const scopes = await Schema.decodeUnknownPromise(ApiScopes)(row.scopes).catch(() => null);
    if (!scopes) return null;
    const principal: Extract<Principal, { kind: "api-key" }> = {
      kind: "api-key",
      userId: state.user.userId as `api-key:${string}`,
      apiKeyId: state.authorization.credentialId,
      eventId: this.name,
      name: state.user.name,
      scopes,
      expiresAt: row.expiresAt.getTime(),
    };
    return { ...state, authorization: apiKeyAuthorization(principal, scopes) };
  }

  private consumeMessageBudget(
    connection: Connection<EventRoomConnectionState>,
  ): EventRoomConnectionState | null {
    const state = connection.state;
    if (!state) {
      connection.close(4401, "Authentication required");
      return null;
    }
    const now = Date.now();
    const next = now - state.rateWindowStartedAt >= 60_000
      ? { ...state, rateWindowStartedAt: now, messagesInWindow: 1 }
      : { ...state, messagesInWindow: state.messagesInWindow + 1 };
    if (next.messagesInWindow > MAX_MESSAGES_PER_MINUTE) {
      connection.close(4408, "Message rate exceeded");
      return null;
    }
    connection.setState(next);
    return next;
  }

  private async requiredCapability(message: Exclude<ClientMessage, { t: "room/hello" }>): Promise<ApiScope | null> {
    const prefix = message.t.split("/", 1)[0];
    return Schema.decodeUnknownPromise(ApiScope)(`${prefix}:write`).catch(() => null);
  }

  private broadcastAuthorized(message: ServerMessage): void {
    const audiences = audiencesForServerMessage(message);
    if (!audiences) return;
    for (const connection of this.getConnections<EventRoomConnectionState>()) {
      const state = connection.state;
      if (!state || !audiences.some((audience) => state.authorization.audiences.includes(audience))) continue;
      connection.send(JSON.stringify(message));
    }
  }

  private broadcastPresence(): void {
    const usersById = new Map<string, PresenceUser>();
    for (const connection of this.getConnections<EventRoomConnectionState>()) {
      const state = connection.state;
      if (!state || state.authorization.kind !== "browser-session") continue;
      usersById.set(state.user.userId, {
        userId: state.user.userId,
        name: state.user.name,
        surface: state.surface,
      });
    }
    this.broadcastAuthorized({ t: "room/presence", users: [...usersById.values()] });
  }
}

export default EventRoom;
