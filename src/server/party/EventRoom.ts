import type { ClientMessage, PresenceUser, ServerMessage } from "contracts/protocol";
import { Server, type Connection, type ConnectionContext, type WSMessage } from "partyserver";
import { userFromRequest } from "../auth";
import { partyHandlers } from "../registry.gen";
import { sessionSecret } from "../services";

export interface EventRoomConnectionState {
  readonly user: {
    readonly userId: string;
    readonly name: string;
  };
  readonly surface: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const decodeClientMessage = (value: unknown): ClientMessage | null => {
  if (!isRecord(value) || typeof value.t !== "string") return null;
  switch (value.t) {
    case "room/hello":
      return typeof value.surface === "string" ? { t: value.t, surface: value.surface } : null;
    case "agenda/move":
      return typeof value.talkId === "string" &&
        (typeof value.roomId === "string" || value.roomId === null) &&
        (typeof value.startsAt === "number" || value.startsAt === null)
        ? {
            t: value.t,
            talkId: value.talkId,
            roomId: value.roomId,
            startsAt: value.startsAt,
          }
        : null;
    case "agenda/resize":
      return typeof value.talkId === "string" &&
        typeof value.durationMin === "number" &&
        Number.isInteger(value.durationMin)
        ? { t: value.t, talkId: value.talkId, durationMin: value.durationMin }
        : null;
    default:
      return null;
  }
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

export class EventRoom extends Server<Env> {
  static override options = { hibernate: true };

  override async onConnect(
    connection: Connection<EventRoomConnectionState>,
    context: ConnectionContext,
  ): Promise<void> {
    const user = await userFromRequest(context.request, this.env);
    if (!user || user.eventId && user.eventId !== this.name) {
      connection.close(4401, "Authentication required");
      return;
    }

    connection.setState({
      user: { userId: user.userId, name: user.name },
      surface: "",
    });
    this.broadcastPresence();
  }

  override async onMessage(
    connection: Connection<EventRoomConnectionState>,
    rawMessage: WSMessage,
  ): Promise<void> {
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
      const state = connection.state;
      if (!state) {
        connection.close(4401, "Authentication required");
        return;
      }
      connection.setState({ ...state, surface: message.surface.slice(0, 120) });
      this.broadcastPresence();
      return;
    }

    const prefix = message.t.split("/", 1)[0];
    const handler = prefix ? partyHandlers[prefix] : undefined;
    if (!handler) {
      connection.send(
        JSON.stringify({ t: "room/error", message: `No handler for ${message.t}` } satisfies ServerMessage),
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
        JSON.stringify({ t: "room/error", message: "Message could not be applied" } satisfies ServerMessage),
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

    const secret = sessionSecret(this.env);
    if (secret && request.headers.get("x-session-party-internal") !== secret) {
      return new Response("Forbidden", { status: 403 });
    }

    let message: unknown;
    try {
      message = await request.json();
    } catch {
      return new Response("Invalid JSON", { status: 400 });
    }
    if (!isRecord(message) || typeof message.t !== "string") {
      return new Response("Invalid server message", { status: 400 });
    }

    this.broadcast(JSON.stringify(message));
    return Response.json({ ok: true });
  }

  private broadcastPresence(): void {
    const usersById = new Map<string, PresenceUser>();
    for (const connection of this.getConnections<EventRoomConnectionState>()) {
      const state = connection.state;
      if (!state) continue;
      usersById.set(state.user.userId, {
        userId: state.user.userId,
        name: state.user.name,
        surface: state.surface,
      });
    }
    this.broadcast(
      JSON.stringify({ t: "room/presence", users: [...usersById.values()] } satisfies ServerMessage),
    );
  }
}

export default EventRoom;

