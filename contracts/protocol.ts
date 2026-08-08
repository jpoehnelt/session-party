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

// ---------- presence (handled by EventRoom itself) ----------

export interface PresenceUser {
  userId: string;
  name: string;
  /** Client route the user is looking at, e.g. "agenda". */
  surface: string;
}

// ---------- client -> server ----------

export type ClientMessage =
  | { t: "room/hello"; surface: string }
  | { t: "agenda/move"; talkId: string; roomId: string | null; startsAt: number | null }
  | { t: "agenda/resize"; talkId: string; durationMin: number };

// ---------- server -> client ----------

export type ServerMessage =
  | { t: "room/presence"; users: PresenceUser[] }
  | { t: "room/error"; message: string; replyTo?: string }
  // agenda (flagship realtime demo)
  | { t: "agenda/talk_upserted"; talk: TalkSnapshot; by: string }
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

export type SlicePrefix = "room" | "agenda" | "dashboard" | "review" | "submissions";
