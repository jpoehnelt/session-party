import { ApiScopes, type ApiScope, type EventRole, type Principal } from "contracts/principal";
import {
  decodeServerMessage,
  type AgendaPreviewTarget,
  type ClientMessage,
  type EventAudience,
  type EventRoomBroadcast,
  type PresenceUser,
  type ServerMessage,
  type ShowCue,
  type ShowCueKind,
  type ShowCueTarget,
  type ShowRunState,
} from "contracts/protocol";
import { apiKeys, authTokens, talks } from "contracts/schema";
import * as dbSchema from "contracts/schema";
import { Server, type Connection, type ConnectionContext, type WSMessage } from "partyserver";
import { and, eq, gt, isNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { Schema } from "effect";
import { runTransportOperation } from "../adapt";
import { userFromRequest } from "../auth";
import { operationById, partyIntents } from "../registry.gen";
import { loadEffectiveEventRole, internalServiceToken } from "../services";

const MAX_MESSAGE_BYTES = 32 * 1024;
const MAX_MESSAGES_PER_MINUTE = 120;
const MAX_SURFACE_LENGTH = 120;
const MAX_CORRELATION_LENGTH = 128;
const MAX_CUE_MESSAGE_LENGTH = 500;
const SHOW_STATE_KEY = "show-state-v1";

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
  readonly agendaCollaboration: {
    readonly talkId: string;
    readonly preview: AgendaPreviewTarget | null;
  } | null;
}

const isBoundedString = (value: unknown, maxLength: number): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= maxLength;
const isPositiveInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value > 0;
const isOptionalId = (value: unknown): value is string | null =>
  value === null || isBoundedString(value, 255);
const isAgendaPreviewTarget = (value: unknown): value is AgendaPreviewTarget => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const input = value as { readonly [field: string]: unknown };
  return isOptionalId(input.trackId) &&
    isOptionalId(input.roomId) &&
    ((typeof input.startsAt === "number" && Number.isFinite(input.startsAt)) || input.startsAt === null) &&
    isPositiveInteger(input.durationMin);
};
const showActions = ["select", "start", "hold", "resume", "complete", "reset"] as const;
const showCueKinds = ["on_deck", "five_minutes", "start", "hold", "room_change", "custom"] as const;
const isShowAction = (value: unknown): value is typeof showActions[number] =>
  typeof value === "string" && showActions.some((action) => action === value);
const isShowCueKind = (value: unknown): value is ShowCueKind =>
  typeof value === "string" && showCueKinds.some((kind) => kind === value);
const isShowCueTarget = (value: unknown): value is ShowCueTarget => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const input = value as { readonly [field: string]: unknown };
  if (input.kind === "crew") return true;
  return (input.kind === "surface" || input.kind === "room") &&
    isBoundedString(input.value, MAX_SURFACE_LENGTH);
};

const decodeClientMessage = (value: unknown): ClientMessage | null => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const input = value as { readonly [field: string]: unknown };
  switch (input.t) {
    case "room/hello":
      return typeof input.surface === "string" && input.surface.length <= MAX_SURFACE_LENGTH
        ? { t: input.t, surface: input.surface }
        : null;
    case "events/get":
      return isBoundedString(input.requestId, MAX_CORRELATION_LENGTH)
        ? { t: input.t, requestId: input.requestId }
        : null;
    case "agenda/focus":
      return isOptionalId(input.talkId) ? { t: input.t, talkId: input.talkId } : null;
    case "agenda/preview":
      return isBoundedString(input.talkId, 255) && isAgendaPreviewTarget(input.target)
        ? { t: input.t, talkId: input.talkId, target: input.target }
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
    case "show/control":
      return isBoundedString(input.requestId, MAX_CORRELATION_LENGTH) &&
        isShowAction(input.action) &&
        (input.talkId === undefined || isBoundedString(input.talkId, 255))
        ? {
            t: input.t,
            requestId: input.requestId,
            action: input.action,
            ...(typeof input.talkId === "string" ? { talkId: input.talkId } : {}),
          }
        : null;
    case "show/cue":
      return isBoundedString(input.requestId, MAX_CORRELATION_LENGTH) &&
        isShowCueKind(input.kind) &&
        isShowCueTarget(input.target) &&
        isBoundedString(input.message, MAX_CUE_MESSAGE_LENGTH)
        ? {
            t: input.t,
            requestId: input.requestId,
            kind: input.kind,
            target: input.target,
            message: input.message,
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
    case "room/result":
      return null;
    case "agenda/talk_upserted":
    case "agenda/talk_deleted":
    case "agenda/conflicts":
    case "agenda/collaboration":
      return ["role:owner", "role:admin", "role:reviewer", "scope:agenda:read"];
    case "show/state":
    case "show/cue":
      return ["role:owner", "role:admin", "scope:agenda:read"];
    case "show/cue_sent":
      return null;
    case "dashboard/progress":
      return ["role:owner", "role:admin", "scope:speakers:read", "scope:content:read"];
    case "review/scored":
      return ["role:owner", "role:admin", "role:reviewer", "scope:reviews:read"];
    case "submissions/new":
      return ["role:owner", "role:admin", "role:reviewer", "scope:submissions:read"];
    case "integrations/airtable_sync":
      return ["role:owner", "role:admin", "scope:integrations:read"];
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
  const message = decodeServerMessage(input.message);
  return message && audiencesForServerMessage(message) ? { message } : null;
};
const PublicFailureWire = Schema.Struct({
  error: Schema.Literal(
    "NotFound",
    "Unauthenticated",
    "Forbidden",
    "OpenRegistrationStaffUnavailable",
    "Validation",
    "Conflict",
    "External",
  ),
  message: Schema.String,
  requestId: Schema.String,
});

const publicFailureFrom = (
  error: unknown,
): Omit<Extract<ServerMessage, { t: "room/error" }>, "t" | "replyTo"> | null => {
  if (!(error instanceof Error)) return null;
  try {
    const decoded = Schema.decodeUnknownEither(PublicFailureWire)(JSON.parse(error.message));
    return decoded._tag === "Right" ? decoded.right : null;
  } catch {
    return null;
  }
};

const principalFromState = (
  state: EventRoomConnectionState,
  eventId: string,
): Principal =>
  state.authorization.kind === "browser-session"
    ? {
        kind: "browser-session",
        userId: state.user.userId,
        email: "",
        name: state.user.name,
        sessionId: state.authorization.credentialId,
        expiresAt: state.authorization.expiresAt,
      }
    : {
        kind: "api-key",
        userId: state.user.userId as `api-key:${string}`,
        apiKeyId: state.authorization.credentialId,
        eventId,
        name: state.user.name,
        scopes: state.authorization.capabilities,
        expiresAt: state.authorization.expiresAt,
      };

const operationInput = (
  message: Exclude<ClientMessage, { t: "room/hello" }>,
  eventId: string,
): Readonly<Record<string, unknown>> => {
  if (message.t === "events/get") return { eventId, idOrSlug: eventId };
  if (!("requestId" in message)) return { eventId };
  const { t: _type, requestId: _requestId, ...input } = message;
  return { ...input, eventId };
};

const sendServerMessage = (
  connection: Connection<EventRoomConnectionState>,
  value: unknown,
): void => {
  const message = decodeServerMessage(value);
  if (!message) {
    console.error(JSON.stringify({ message: "invalid outbound room message" }));
    return;
  }
  if (connection.readyState !== WebSocket.OPEN) return;
  try {
    connection.send(JSON.stringify(message));
  } catch (error) {
    if (
      connection.readyState === WebSocket.CLOSING
      || connection.readyState === WebSocket.CLOSED
    ) return;
    console.error(JSON.stringify({
      message: "event room delivery failed",
      connectionId: connection.id,
      type: message.t,
      error: error instanceof Error ? error.message : String(error),
    }));
  }
};

const initialShowState = (): ShowRunState => ({
  revision: 0,
  status: "idle",
  currentTalkId: null,
  startedAt: null,
  holdStartedAt: null,
  accumulatedHoldMs: 0,
  updatedAt: 0,
  updatedBy: null,
});

const decodeStoredShowState = (value: unknown): ShowRunState | null => {
  const message = decodeServerMessage({ t: "show/state", state: value });
  return message?.t === "show/state" ? message.state : null;
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
        agendaCollaboration: null,
      });
      await this.broadcastPresence();
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
      sendServerMessage(connection, { t: "room/error", message: "Message too large" });
      return;
    }

    let message: ClientMessage | null = null;
    try {
      message = decodeClientMessage(parseMessage(rawMessage));
    } catch {
      // The common invalid-message response below is intentionally non-specific.
    }

    if (!message) {
      sendServerMessage(connection, { t: "room/error", message: "Invalid message" });
      return;
    }

    const refreshed = await this.refreshConnectionAuthorization(connection, state);
    if (!refreshed) return;

    if (message.t === "room/hello") {
      connection.setState({ ...refreshed, surface: message.surface });
      await this.broadcastPresence();
      await this.broadcastAgendaCollaboration();
      if (this.canReceiveShowState(refreshed)) {
        sendServerMessage(connection, { t: "show/state", state: await this.getShowState() });
      }
      return;
    }

    if (message.t === "agenda/focus" || message.t === "agenda/preview") {
      if (!refreshed.authorization.capabilities.includes("agenda:write")) {
        sendServerMessage(connection, { t: "room/error", message: "Access denied" });
        return;
      }
      await this.runRealtimeHandler(
        connection,
        message,
        () => this.handleAgendaCollaboration(connection, refreshed, message),
      );
      return;
    }

    if (message.t === "show/control" || message.t === "show/cue") {
      if (!refreshed.authorization.capabilities.includes("agenda:write")) {
        sendServerMessage(connection, {
          t: "room/error",
          message: "Access denied",
          replyTo: message.requestId,
        });
        return;
      }
      await this.runRealtimeHandler(
        connection,
        message,
        () => message.t === "show/control"
          ? this.handleShowControl(connection, refreshed, message)
          : this.handleShowCue(connection, refreshed, message),
      );
      return;
    }
    const operationIntent = partyIntents.find(({ intentType }) => intentType === message.t);
    if (operationIntent) {
      const operation = operationById[operationIntent.operationId];
      if (!operation) {
        sendServerMessage(connection, {
          t: "room/error",
          message: `No operation for ${message.t}`,
          replyTo: replyToFor(message),
        });
        return;
      }
      try {
        const result = await runTransportOperation(
          this.env,
          principalFromState(refreshed, this.name),
          operation,
          operationInput(message, this.name),
        );
        sendServerMessage(connection, {
          t: "room/result",
          operationId: operation.id,
          result,
          replyTo: message.requestId,
        });
      } catch (error) {
        const failure = publicFailureFrom(error);
        console.error(JSON.stringify({
          message: "party operation failed",
          room: this.name,
          type: message.t,
          error: failure?.error ?? (error instanceof Error ? error.message : String(error)),
        }));
        sendServerMessage(connection, {
          t: "room/error",
          message: failure?.message ?? "Message could not be applied",
          error: failure?.error,
          requestId: failure?.requestId,
          replyTo: message.requestId,
        });
      }
      return;
    }

    sendServerMessage(connection, {
      t: "room/error",
      message: `No operation for ${message.t}`,
      replyTo: replyToFor(message),
    });
  }

  override async onClose(connection: Connection<EventRoomConnectionState>): Promise<void> {
    await this.broadcastPresence();
    if (connection.state?.agendaCollaboration) {
      await this.broadcastAgendaCollaboration();
    }
  }

  override async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== "POST" || url.pathname !== "/broadcast") {
      return new Response("Not found", { status: 404 });
    }

    let secret: string;
    try {
      secret = await internalServiceToken(this.env);
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

    await this.broadcastAuthorized(broadcast.message);
    return Response.json({ ok: true });
  }

  private async initialAuthorization(principal: Principal): Promise<RoomAuthorization | null> {
    if (principal.kind === "api-key") {
      return principal.eventId === this.name ? apiKeyAuthorization(principal) : null;
    }

    const db = drizzle(this.env.DB, { schema: dbSchema });
    const role = await loadEffectiveEventRole(db, principal.userId, this.name);
    return role ? browserAuthorization(principal, role) : null;
  }

  private async revalidateAuthorization(
    state: EventRoomConnectionState,
  ): Promise<EventRoomConnectionState | null> {
    const db = drizzle(this.env.DB, { schema: dbSchema });
    const now = new Date();
    if (state.authorization.kind === "browser-session") {
      const [row] = await db
        .select({ expiresAt: authTokens.expiresAt })
        .from(authTokens)
        .where(and(
          eq(authTokens.id, state.authorization.credentialId),
          eq(authTokens.userId, state.user.userId),
          eq(authTokens.kind, "session"),
          gt(authTokens.expiresAt, now),
          isNull(authTokens.consumedAt),
        ))
        .limit(1);
      if (!row) return null;
      const role = await loadEffectiveEventRole(db, state.user.userId, this.name);
      if (!role) return null;
      const principal: Extract<Principal, { kind: "browser-session" }> = {
        kind: "browser-session",
        userId: state.user.userId,
        email: "",
        name: state.user.name,
        sessionId: state.authorization.credentialId,
        expiresAt: row.expiresAt.getTime(),
      };
      return { ...state, authorization: browserAuthorization(principal, role) };
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
  private async refreshConnectionAuthorization(
    connection: Connection<EventRoomConnectionState>,
    state: EventRoomConnectionState | null | undefined = connection.state,
  ): Promise<EventRoomConnectionState | null> {
    if (!state) {
      connection.close(4401, "Authentication required");
      return null;
    }
    try {
      const refreshed = await this.revalidateAuthorization(state);
      if (!refreshed) {
        connection.close(4403, "Event access expired");
        return null;
      }
      connection.setState(refreshed);
      return refreshed;
    } catch (error) {
      console.error(JSON.stringify({
        message: "event room authorization refresh failed",
        room: this.name,
        error: error instanceof Error ? error.message : String(error),
      }));
      connection.close(1011, "Authorization unavailable");
      return null;
    }
  }

  private async refreshConnectionsAuthorization(
    connections: readonly Connection<EventRoomConnectionState>[] = [
      ...this.getConnections<EventRoomConnectionState>(),
    ],
  ): Promise<readonly {
    readonly connection: Connection<EventRoomConnectionState>;
    readonly state: EventRoomConnectionState;
  }[]> {
    const refreshed = await Promise.all(connections.map(async (connection) => ({
      connection,
      state: await this.refreshConnectionAuthorization(connection),
    })));
    return refreshed.filter((entry): entry is {
      readonly connection: Connection<EventRoomConnectionState>;
      readonly state: EventRoomConnectionState;
    } => entry.state !== null);
  }

  private async runRealtimeHandler(
    connection: Connection<EventRoomConnectionState>,
    message: Extract<ClientMessage, { t: "agenda/focus" | "agenda/preview" | "show/control" | "show/cue" }>,
    handler: () => Promise<void>,
  ): Promise<void> {
    try {
      await handler();
    } catch (error) {
      console.error(JSON.stringify({
        message: "event room realtime handler failed",
        room: this.name,
        type: message.t,
        error: error instanceof Error ? error.message : String(error),
      }));
      sendServerMessage(connection, {
        t: "room/error",
        message: "Message could not be applied",
        replyTo: replyToFor(message),
      });
    }
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

  private async handleAgendaCollaboration(
    connection: Connection<EventRoomConnectionState>,
    state: EventRoomConnectionState,
    message: Extract<ClientMessage, { t: "agenda/focus" | "agenda/preview" }>,
  ): Promise<void> {
    if (message.t === "agenda/focus" && message.talkId === null) {
      await this.ctx.blockConcurrencyWhile(async () => {
        connection.setState({ ...(connection.state ?? state), agendaCollaboration: null });
      });
      await this.broadcastAgendaCollaboration();
      return;
    }

    const talkId = message.talkId;
    if (talkId === null) return;
    const holder = await this.ctx.blockConcurrencyWhile(async () => {
      const candidates = [...this.getConnections<EventRoomConnectionState>()]
        .filter((candidate) => candidate.id !== connection.id);
      const authorized = await this.refreshConnectionsAuthorization(candidates);
      const conflict = authorized.find(({ state: candidateState }) =>
        candidateState.agendaCollaboration?.talkId === talkId);
      if (conflict) return conflict.state;
      connection.setState({
        ...(connection.state ?? state),
        agendaCollaboration: {
          talkId,
          preview: message.t === "agenda/preview" ? message.target : null,
        },
      });
      return null;
    });
    if (holder) {
      sendServerMessage(connection, {
        t: "room/error",
        error: "Conflict",
        message: `${holder.user.name} is already moving this talk`,
      });
      return;
    }
    await this.broadcastAgendaCollaboration();
  }

  private async getShowState(): Promise<ShowRunState> {
    const stored = await this.ctx.storage.get<unknown>(SHOW_STATE_KEY);
    return decodeStoredShowState(stored) ?? initialShowState();
  }

  private async isCurrentEventTalk(talkId: string): Promise<boolean> {
    const db = drizzle(this.env.DB);
    const [talk] = await db
      .select({ id: talks.id })
      .from(talks)
      .where(and(eq(talks.eventId, this.name), eq(talks.id, talkId)))
      .limit(1);
    return Boolean(talk);
  }

  private async handleShowControl(
    connection: Connection<EventRoomConnectionState>,
    state: EventRoomConnectionState,
    message: Extract<ClientMessage, { t: "show/control" }>,
  ): Promise<void> {
    const actor = { userId: state.user.userId, name: state.user.name };
    const transition = await this.ctx.blockConcurrencyWhile(async () => {
      const current = await this.getShowState();
      const now = Date.now();
      const talkId = message.talkId ?? current.currentTalkId;
      let next: ShowRunState | null = null;

      if ((message.action === "select" || message.action === "start") &&
        (!talkId || !(await this.isCurrentEventTalk(talkId)))) {
        return { kind: "not-found" as const };
      }

      switch (message.action) {
        case "select":
          next = {
            revision: current.revision + 1,
            status: "ready",
            currentTalkId: talkId!,
            startedAt: null,
            holdStartedAt: null,
            accumulatedHoldMs: 0,
            updatedAt: now,
            updatedBy: actor,
          };
          break;
        case "start":
          next = {
            revision: current.revision + 1,
            status: "running",
            currentTalkId: talkId!,
            startedAt: now,
            holdStartedAt: null,
            accumulatedHoldMs: 0,
            updatedAt: now,
            updatedBy: actor,
          };
          break;
        case "hold":
          if (current.status === "running") {
            next = { ...current, revision: current.revision + 1, status: "held", holdStartedAt: now, updatedAt: now, updatedBy: actor };
          }
          break;
        case "resume":
          if (current.status === "held" && current.holdStartedAt !== null) {
            next = {
              ...current,
              revision: current.revision + 1,
              status: "running",
              holdStartedAt: null,
              accumulatedHoldMs: current.accumulatedHoldMs + Math.max(0, now - current.holdStartedAt),
              updatedAt: now,
              updatedBy: actor,
            };
          }
          break;
        case "complete":
          if (current.currentTalkId !== null && (current.status === "running" || current.status === "held")) {
            next = {
              ...current,
              revision: current.revision + 1,
              status: "completed",
              holdStartedAt: null,
              accumulatedHoldMs: current.accumulatedHoldMs +
                (current.holdStartedAt === null ? 0 : Math.max(0, now - current.holdStartedAt)),
              updatedAt: now,
              updatedBy: actor,
            };
          }
          break;
        case "reset":
          next = { ...initialShowState(), revision: current.revision + 1, updatedAt: now, updatedBy: actor };
          break;
      }

      if (!next) return { kind: "conflict" as const, status: current.status };
      await this.ctx.storage.put(SHOW_STATE_KEY, next);
      return { kind: "success" as const, state: next };
    });

    if (transition.kind === "not-found") {
      sendServerMessage(connection, {
        t: "room/error",
        error: "NotFound",
        message: "Choose a current event talk first",
        replyTo: message.requestId,
      });
      return;
    }
    if (transition.kind === "conflict") {
      sendServerMessage(connection, {
        t: "room/error",
        error: "Conflict",
        message: `Cannot ${message.action} while show state is ${transition.status}`,
        replyTo: message.requestId,
      });
      return;
    }

    const next = transition.state;
    await this.broadcastAuthorized({ t: "show/state", state: next });
    sendServerMessage(connection, {
      t: "room/result",
      operationId: "show.control",
      result: next,
      replyTo: message.requestId,
    });
  }

  private cueMatchesConnection(
    target: ShowCueTarget,
    state: EventRoomConnectionState,
  ): boolean {
    if (!this.canReceiveShowState(state)) return false;
    if (target.kind === "crew") return true;
    if (target.kind === "surface") return state.surface === target.value;
    return state.surface === `show:room:${target.value}` || state.surface === "show:control";
  }

  private canReceiveShowState(state: EventRoomConnectionState): boolean {
    return state.authorization.role === "owner" ||
      state.authorization.role === "admin" ||
      state.authorization.capabilities.includes("agenda:read") ||
      state.authorization.capabilities.includes("agenda:write");
  }

  private async handleShowCue(
    connection: Connection<EventRoomConnectionState>,
    state: EventRoomConnectionState,
    message: Extract<ClientMessage, { t: "show/cue" }>,
  ): Promise<void> {
    const sentAt = Date.now();
    const cue: ShowCue = {
      id: crypto.randomUUID(),
      kind: message.kind,
      target: message.target,
      message: message.message,
      sentAt,
      expiresAt: sentAt + 60_000,
      by: { userId: state.user.userId, name: state.user.name },
    };
    let recipients = 0;
    for (const { connection: candidate, state: candidateState } of await this.refreshConnectionsAuthorization()) {
      if (!this.cueMatchesConnection(message.target, candidateState)) continue;
      sendServerMessage(candidate, { t: "show/cue", cue });
      recipients += 1;
    }
    sendServerMessage(connection, {
      t: "show/cue_sent",
      cueId: cue.id,
      recipients,
      replyTo: message.requestId,
    });
  }

  private async broadcastAuthorized(input: ServerMessage): Promise<void> {
    const message = decodeServerMessage(input);
    if (!message) {
      console.error(JSON.stringify({ message: "invalid outbound room broadcast" }));
      return;
    }
    const audiences = audiencesForServerMessage(message);
    if (!audiences) return;
    for (const { connection, state } of await this.refreshConnectionsAuthorization()) {
      if (!audiences.some((audience) => state.authorization.audiences.includes(audience))) {
        continue;
      }
      sendServerMessage(connection, message);
    }
  }

  private async broadcastAgendaCollaboration(): Promise<void> {
    const collaborators: Extract<ServerMessage, { t: "agenda/collaboration" }>["collaborators"] = [];
    const recipients: Connection<EventRoomConnectionState>[] = [];
    for (const { connection, state } of await this.refreshConnectionsAuthorization()) {
      if (
        state.authorization.role === "owner" ||
        state.authorization.role === "admin" ||
        state.authorization.role === "reviewer" ||
        state.authorization.capabilities.includes("agenda:read")
      ) {
        recipients.push(connection);
      }
      if (state.agendaCollaboration && state.authorization.capabilities.includes("agenda:write")) {
        collaborators.push({
          userId: state.user.userId,
          name: state.user.name,
          talkId: state.agendaCollaboration.talkId,
          preview: state.agendaCollaboration.preview,
        });
      }
    }
    const message = { t: "agenda/collaboration", collaborators } satisfies ServerMessage;
    for (const connection of recipients) sendServerMessage(connection, message);
  }

  private async broadcastPresence(): Promise<void> {
    const usersById = new Map<string, PresenceUser>();
    const recipients: Connection<EventRoomConnectionState>[] = [];
    for (const { connection, state } of await this.refreshConnectionsAuthorization()) {
      if (state.authorization.kind !== "browser-session") continue;
      recipients.push(connection);
      usersById.set(state.user.userId, {
        userId: state.user.userId,
        name: state.user.name,
        surface: state.surface,
      });
    }
    const presence = {
      t: "room/presence",
      users: [...usersById.values()],
    } satisfies ServerMessage;
    for (const connection of recipients) sendServerMessage(connection, presence);
  }
}

export default EventRoom;
