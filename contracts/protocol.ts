/**
 * FROZEN CONTRACT — integrator-only after spine-v1.
 * Realtime protocol for the per-event PartyServer room (`EventRoom:<eventId>`).
 *
 * Envelope: every message is JSON with a `t` discriminator namespaced
 * "<slice>/<type>". EventRoom dispatches client->server messages to the slice
 * handler registered for the prefix; server->client messages are broadcast.
 * The server is authoritative: clients send intents, the room persists via the
 * slice service and broadcasts resulting state.
 */
import type { Conflict } from "./types";
import type { ApiScope, EventRole } from "./principal";
import { Schema } from "effect";

// ---------- presence (handled by EventRoom itself) ----------

export interface PresenceUser {
  userId: string;
  name: string;
  /** Client route the user is looking at, e.g. "agenda". */
  surface: string;
}

export type EventAudience =
  | "members"
  | `role:${EventRole}`
  | `scope:${ApiScope}`;

/** Internal-only envelope. Recipient audiences are derived from the message type. */
export interface EventRoomBroadcast {
  readonly message: ServerMessage;
}

// ---------- client -> server ----------

export type ClientMessage =
  | { t: "room/hello"; surface: string }
  | { t: "events/get"; requestId: string }
  | {
      t: "agenda/move";
      requestId: string;
      idempotencyKey: string;
      talkId: string;
      trackId: string | null;
      roomId: string | null;
      startsAt: number | null;
      durationMin: number;
      expectedVersion: number;
    }
  | {
      t: "agenda/resize";
      requestId: string;
      idempotencyKey: string;
      talkId: string;
      durationMin: number;
      expectedVersion: number;
    };

// ---------- server -> client ----------

export type ServerMessage =
  | { t: "room/presence"; users: PresenceUser[] }
  | {
      t: "room/error";
      message: string;
      error?: "NotFound" | "Unauthenticated" | "Forbidden" | "Validation" | "Conflict" | "External";
      requestId?: string;
      replyTo?: string;
    }
  | { t: "room/result"; operationId: string; result: unknown; replyTo: string }
  // agenda (flagship realtime demo)
  | { t: "agenda/talk_upserted"; talk: TalkSnapshot; by: string; replyTo: string }
  | { t: "agenda/talk_deleted"; talkId: string }
  | { t: "agenda/conflicts"; conflicts: Conflict[] }
  // dashboard
  | { t: "dashboard/progress"; speakerId: string; taskId: string; completed: boolean; tasksDone: number; tasksTotal: number }
  // review
  | { t: "review/scored"; submissionId: string; roundId: string; score: number; reviewerName: string }
  // submissions
  | { t: "submissions/new"; submissionId: string; title: string };

/** Denormalized talk for wire transfer (matches talks table + speaker names). */
export interface TalkSnapshot {
  id: string;
  title: string;
  trackId: string | null;
  roomId: string | null;
  startsAt: number | null;
  durationMin: number;
  status: "draft" | "confirmed" | "cancelled";
  speakerNames: string[];
}

export type SlicePrefix = "room" | "events" | "agenda" | "dashboard" | "review" | "submissions";

const PresenceUserWire = Schema.Struct({
  userId: Schema.String,
  name: Schema.String,
  surface: Schema.String,
});
const PublicErrorTag = Schema.Literal(
  "NotFound",
  "Unauthenticated",
  "Forbidden",
  "Validation",
  "Conflict",
  "External",
);
const ConflictWire = Schema.Struct({
  kind: Schema.Literal("room_overlap", "speaker_overlap"),
  talkIds: Schema.Tuple(Schema.String, Schema.String),
  roomId: Schema.optional(Schema.String),
  speakerId: Schema.optional(Schema.String),
});
const TalkSnapshotWire = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  trackId: Schema.NullOr(Schema.String),
  roomId: Schema.NullOr(Schema.String),
  startsAt: Schema.NullOr(Schema.Number),
  durationMin: Schema.Int.pipe(Schema.nonNegative()),
  status: Schema.Literal("draft", "confirmed", "cancelled"),
  speakerNames: Schema.Array(Schema.String),
});
const ServerMessageWire = Schema.Union(
  Schema.Struct({
    t: Schema.Literal("room/presence"),
    users: Schema.Array(PresenceUserWire),
  }),
  Schema.Struct({
    t: Schema.Literal("room/error"),
    message: Schema.String,
    error: Schema.optional(PublicErrorTag),
    requestId: Schema.optional(Schema.String),
    replyTo: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    t: Schema.Literal("room/result"),
    operationId: Schema.String,
    result: Schema.Unknown,
    replyTo: Schema.String,
  }),
  Schema.Struct({
    t: Schema.Literal("agenda/talk_upserted"),
    talk: TalkSnapshotWire,
    by: Schema.String,
    replyTo: Schema.String,
  }),
  Schema.Struct({
    t: Schema.Literal("agenda/talk_deleted"),
    talkId: Schema.String,
  }),
  Schema.Struct({
    t: Schema.Literal("agenda/conflicts"),
    conflicts: Schema.Array(ConflictWire),
  }),
  Schema.Struct({
    t: Schema.Literal("dashboard/progress"),
    speakerId: Schema.String,
    taskId: Schema.String,
    completed: Schema.Boolean,
    tasksDone: Schema.Int.pipe(Schema.nonNegative()),
    tasksTotal: Schema.Int.pipe(Schema.nonNegative()),
  }),
  Schema.Struct({
    t: Schema.Literal("review/scored"),
    submissionId: Schema.String,
    roundId: Schema.String,
    score: Schema.Number,
    reviewerName: Schema.String,
  }),
  Schema.Struct({
    t: Schema.Literal("submissions/new"),
    submissionId: Schema.String,
    title: Schema.String,
  }),
);

/** Validate unknown JSON before it crosses the server-to-client socket boundary. */
export const decodeServerMessage = (value: unknown): ServerMessage | null => {
  const decoded = Schema.decodeUnknownEither(ServerMessageWire)(value);
  return decoded._tag === "Right" ? decoded.right as ServerMessage : null;
};
