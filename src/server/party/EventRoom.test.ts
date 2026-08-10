import {
  abortAllDurableObjects,
  applyD1Migrations,
  env,
  SELF,
  type D1Migration,
} from "cloudflare:test";
import type { ServerMessage } from "contracts/protocol";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { hashBearerMaterial } from "../auth";
import { sessionSecret } from "../services";
import { audiencesForServerMessage } from "./EventRoom";

type TestEnv = Cloudflare.Env & {
  readonly TEST_MIGRATIONS: readonly D1Migration[];
};

const EVENT_ID = "room-authority-event";
const OPERATION_EVENT_ID = "room-operation-event";
const expiresAt = 4_102_444_800_000;

const waitForType = (
  socket: WebSocket,
  type: ServerMessage["t"],
): Promise<ServerMessage> =>
  waitForMessage(socket, (message) => message.t === type);

const waitForMessage = (
  socket: WebSocket,
  predicate: (message: ServerMessage) => boolean,
): Promise<ServerMessage> =>
  new Promise((resolve) => {
    const onMessage = (event: MessageEvent) => {
      if (typeof event.data !== "string") return;
      const message = JSON.parse(event.data) as ServerMessage;
      if (!predicate(message)) return;
      socket.removeEventListener("message", onMessage);
      resolve(message);
    };
    socket.addEventListener("message", onMessage);
  });

const connect = async (
  credential: { cookie: string } | { bearer: string },
  eventId = EVENT_ID,
): Promise<WebSocket> => {
  const headers = new Headers({ Upgrade: "websocket" });
  if ("cookie" in credential) headers.set("Cookie", `sp_session=${credential.cookie}`);
  else headers.set("Authorization", `Bearer ${credential.bearer}`);
  const response = await SELF.fetch(
    `https://example.test/parties/event-room/${eventId}`,
    { headers },
  );
  expect(response.status).toBe(101);
  const socket = response.webSocket;
  if (!socket) throw new Error("EventRoom upgrade did not return a WebSocket");
  const ready = "cookie" in credential ? waitForType(socket, "room/presence") : undefined;
  socket.accept();
  await ready;
  return socket;
};

const broadcast = async (message: ServerMessage): Promise<void> => {
  const id = env.EVENT_ROOM.idFromName(EVENT_ID);
  const response = await env.EVENT_ROOM.get(id).fetch("https://event-room/broadcast", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-session-party-internal": sessionSecret(env),
      "x-partykit-room": EVENT_ID,
    },
    body: JSON.stringify({ message }),
  });
  expect(response.status, await response.clone().text()).toBe(200);
};

beforeAll(async () => {
  if (!("TEST_MIGRATIONS" in env)) {
    throw new Error("TEST_MIGRATIONS test binding is unavailable");
  }
  await applyD1Migrations(env.DB, [...(env as TestEnv).TEST_MIGRATIONS]);
  const now = 1_700_000_000_000;
  const ownerSession = await hashBearerMaterial(env, "room-owner-session");
  const reviewerSession = await hashBearerMaterial(env, "room-reviewer-session");
  const agendaKey = await hashBearerMaterial(env, "room-agenda-key");
  const demotedSession = await hashBearerMaterial(env, "room-demoted-session");
  const expiredSession = await hashBearerMaterial(env, "room-expired-session");
  const revokedReaderKey = await hashBearerMaterial(env, "room-revoked-reader-key");
  const submissionsKey = await hashBearerMaterial(env, "room-submissions-key");
  const writerKey = await hashBearerMaterial(env, "room-writer-key");
  await env.DB.batch([
    env.DB.prepare("INSERT INTO users (id, email, name, version, created_at, updated_at) VALUES ('room-owner', 'room-owner@example.com', 'Room Owner', 1, ?, ?)").bind(now, now),
    env.DB.prepare("INSERT INTO users (id, email, name, version, created_at, updated_at) VALUES ('room-reviewer', 'room-reviewer@example.com', 'Room Reviewer', 1, ?, ?)").bind(now, now),
    env.DB.prepare("INSERT INTO users (id, email, name, version, created_at, updated_at) VALUES ('room-demoted', 'room-demoted@example.com', 'Room Demoted', 1, ?, ?)").bind(now, now),
    env.DB.prepare("INSERT INTO users (id, email, name, version, created_at, updated_at) VALUES ('room-expired', 'room-expired@example.com', 'Room Expired', 1, ?, ?)").bind(now, now),
    env.DB.prepare("INSERT INTO events (id, slug, name, timezone, version, created_at, updated_at) VALUES (?, 'room-authority', 'Room Authority', 'UTC', 1, ?, ?)").bind(EVENT_ID, now, now),
    env.DB.prepare("INSERT INTO events (id, slug, name, timezone, version, created_at, updated_at) VALUES (?, 'room-operation', 'Room Operation', 'UTC', 1, ?, ?)").bind(OPERATION_EVENT_ID, now, now),
    env.DB.prepare("INSERT INTO talks (id, event_id, submission_id, title, description, track_id, room_id, starts_at, duration_min, status, version, created_at, updated_at) VALUES ('room-live-talk', ?, NULL, 'Realtime keynote', NULL, NULL, NULL, ?, 30, 'confirmed', 1, ?, ?)").bind(EVENT_ID, now + 3_600_000, now, now),
    env.DB.prepare("INSERT INTO event_members (id, event_id, user_id, role, version, created_at, updated_at) VALUES ('room-owner-member', ?, 'room-owner', 'owner', 1, ?, ?)").bind(EVENT_ID, now, now),
    env.DB.prepare("INSERT INTO event_members (id, event_id, user_id, role, version, created_at, updated_at) VALUES ('room-operation-owner-member', ?, 'room-owner', 'owner', 1, ?, ?)").bind(OPERATION_EVENT_ID, now, now),
    env.DB.prepare("INSERT INTO event_members (id, event_id, user_id, role, version, created_at, updated_at) VALUES ('room-reviewer-member', ?, 'room-reviewer', 'reviewer', 1, ?, ?)").bind(EVENT_ID, now, now),
    env.DB.prepare("INSERT INTO event_members (id, event_id, user_id, role, version, created_at, updated_at) VALUES ('room-demoted-member', ?, 'room-demoted', 'owner', 1, ?, ?)").bind(EVENT_ID, now, now),
    env.DB.prepare("INSERT INTO event_members (id, event_id, user_id, role, version, created_at, updated_at) VALUES ('room-expired-member', ?, 'room-expired', 'reviewer', 1, ?, ?)").bind(EVENT_ID, now, now),
    env.DB.prepare("INSERT INTO auth_tokens (id, token_hash, user_id, kind, expires_at, consumed_at, created_at) VALUES ('room-owner-session-id', ?, 'room-owner', 'session', ?, NULL, ?)").bind(ownerSession, expiresAt, now),
    env.DB.prepare("INSERT INTO auth_tokens (id, token_hash, user_id, kind, expires_at, consumed_at, created_at) VALUES ('room-reviewer-session-id', ?, 'room-reviewer', 'session', ?, NULL, ?)").bind(reviewerSession, expiresAt, now),
    env.DB.prepare("INSERT INTO auth_tokens (id, token_hash, user_id, kind, expires_at, consumed_at, created_at) VALUES ('room-demoted-session-id', ?, 'room-demoted', 'session', ?, NULL, ?)").bind(demotedSession, expiresAt, now),
    env.DB.prepare("INSERT INTO auth_tokens (id, token_hash, user_id, kind, expires_at, consumed_at, created_at) VALUES ('room-expired-session-id', ?, 'room-expired', 'session', ?, NULL, ?)").bind(expiredSession, expiresAt, now),
    env.DB.prepare("INSERT INTO api_keys (id, event_id, name, key_hash, scopes, expires_at, revoked_at, created_by, version, created_at, updated_at) VALUES ('room-agenda-key-id', ?, 'Agenda Reader', ?, '[\"agenda:read\"]', ?, NULL, 'room-owner', 1, ?, ?)").bind(EVENT_ID, agendaKey, expiresAt, now, now),
    env.DB.prepare("INSERT INTO api_keys (id, event_id, name, key_hash, scopes, expires_at, revoked_at, created_by, version, created_at, updated_at) VALUES ('room-submissions-key-id', ?, 'Submissions Reader', ?, '[\"submissions:read\"]', ?, NULL, 'room-owner', 1, ?, ?)").bind(EVENT_ID, submissionsKey, expiresAt, now, now),
    env.DB.prepare("INSERT INTO api_keys (id, event_id, name, key_hash, scopes, expires_at, revoked_at, created_by, version, created_at, updated_at) VALUES ('room-writer-key-id', ?, 'Agenda Writer', ?, '[\"agenda:write\"]', ?, NULL, 'room-owner', 1, ?, ?)").bind(EVENT_ID, writerKey, expiresAt, now, now),
    env.DB.prepare("INSERT INTO api_keys (id, event_id, name, key_hash, scopes, expires_at, revoked_at, created_by, version, created_at, updated_at) VALUES ('room-revoked-reader-key-id', ?, 'Revoked Agenda Reader', ?, '[\"agenda:read\"]', ?, NULL, 'room-owner', 1, ?, ?)").bind(EVENT_ID, revokedReaderKey, expiresAt, now, now),
  ]);
});

afterEach(async () => {
  await abortAllDurableObjects();
});

describe("EventRoom live authorization", () => {
  it("derives the fixed audience matrix from server-owned message types", () => {
    expect(audiencesForServerMessage({ t: "room/presence", users: [] })).toEqual(["members"]);
    expect(audiencesForServerMessage({ t: "room/error", message: "direct" })).toBeNull();
    expect(audiencesForServerMessage({ t: "agenda/conflicts", conflicts: [] })).toEqual([
      "role:owner", "role:admin", "role:reviewer", "scope:agenda:read",
    ]);
    expect(audiencesForServerMessage({ t: "agenda/collaboration", collaborators: [] })).toEqual([
      "role:owner", "role:admin", "role:reviewer", "scope:agenda:read",
    ]);
    expect(audiencesForServerMessage({
      t: "show/state",
      state: {
        revision: 0,
        status: "idle",
        currentTalkId: null,
        startedAt: null,
        holdStartedAt: null,
        accumulatedHoldMs: 0,
        updatedAt: 0,
        updatedBy: null,
      },
    })).toEqual(["role:owner", "role:admin", "scope:agenda:read"]);
    expect(audiencesForServerMessage({
      t: "dashboard/progress",
      speakerId: "speaker",
      taskId: "task",
      completed: true,
      tasksDone: 1,
      tasksTotal: 1,
    })).toEqual([
      "role:owner", "role:admin", "scope:speakers:read", "scope:content:read",
    ]);
    expect(audiencesForServerMessage({
      t: "review/scored",
      submissionId: "submission",
      roundId: "round",
      score: 1,
      reviewerName: "Reviewer",
    })).toEqual([
      "role:owner", "role:admin", "role:reviewer", "scope:reviews:read",
    ]);
    expect(audiencesForServerMessage({
      t: "integrations/airtable_sync",
      entityType: "speaker",
      entityId: "speaker",
      state: "confirmed",
      fields: ["title"],
    })).toEqual(["role:owner", "role:admin", "scope:integrations:read"]);
    expect(audiencesForServerMessage({
      t: "submissions/new",
      submissionId: "submission",
      title: "Submission",
    })).toEqual([
      "role:owner", "role:admin", "role:reviewer", "scope:submissions:read",
    ]);
  });

  it("delivers live hints to matching roles/scopes without API-key presence identity", async () => {
    const owner = await connect({ cookie: "room-owner-session" });
    const reviewer = await connect({ cookie: "room-reviewer-session" });
    const presenceAfterApiConnect = waitForType(owner, "room/presence");
    const agenda = await connect({ bearer: "room-agenda-key" });
    const presence = await presenceAfterApiConnect;
    expect(presence).toMatchObject({
      t: "room/presence",
      users: expect.arrayContaining([
        expect.objectContaining({ userId: "room-owner" }),
        expect.objectContaining({ userId: "room-reviewer" }),
      ]),
    });
    if (presence.t !== "room/presence") throw new Error("Expected presence");
    expect(presence.users).toHaveLength(2);

    const agendaReceipts = [
      waitForType(owner, "agenda/conflicts"),
      waitForType(reviewer, "agenda/conflicts"),
      waitForType(agenda, "agenda/conflicts"),
    ];
    await broadcast({ t: "agenda/conflicts", conflicts: [] });
    expect((await Promise.all(agendaReceipts)).every(Boolean)).toBe(true);
  });

  it("executes the canonical event operation without trusting a client event id", async () => {
    const owner = await connect({ cookie: "room-owner-session" }, OPERATION_EVENT_ID);
    const result = waitForType(owner, "room/result");
    owner.send(JSON.stringify({
      t: "events/get",
      requestId: "event-from-room",
      idOrSlug: "a-client-supplied-event-id-is-ignored",
    }));
    expect(await result).toMatchObject({
      t: "room/result",
      operationId: "events.get",
      replyTo: "event-from-room",
      result: {
        id: OPERATION_EVENT_ID,
        slug: "room-operation",
      },
    });
  }, 30_000);

  it("coordinates agenda soft locks and ghost previews across clients", async () => {
    const owner = await connect({ cookie: "room-owner-session" });
    const peer = await connect({ cookie: "room-demoted-session" });
    owner.send(JSON.stringify({ t: "room/hello", surface: "agenda" }));
    peer.send(JSON.stringify({ t: "room/hello", surface: "agenda" }));

    const preview = waitForMessage(peer, (message) =>
      message.t === "agenda/collaboration" && message.collaborators.some(({ preview }) => preview !== null));
    owner.send(JSON.stringify({
      t: "agenda/preview",
      talkId: "room-live-talk",
      target: {
        trackId: null,
        roomId: "room-a",
        startsAt: 1_700_003_600_000,
        durationMin: 45,
      },
    }));
    expect(await preview).toMatchObject({
      t: "agenda/collaboration",
      collaborators: [{
        userId: "room-owner",
        name: "Room Owner",
        talkId: "room-live-talk",
        preview: expect.objectContaining({ roomId: "room-a", durationMin: 45 }),
      }],
    });

    const conflict = waitForType(peer, "room/error");
    peer.send(JSON.stringify({ t: "agenda/focus", talkId: "room-live-talk" }));
    expect(await conflict).toMatchObject({
      t: "room/error",
      error: "Conflict",
      message: "Room Owner is already moving this talk",
    });

    const released = waitForMessage(peer, (message) =>
      message.t === "agenda/collaboration" && message.collaborators.length === 0);
    owner.close();
    expect(await released).toEqual({ t: "agenda/collaboration", collaborators: [] });
  });

  it("persists synchronized show state and routes room cues to matching surfaces", async () => {
    const control = await connect({ cookie: "room-owner-session" });
    const roomDisplay = await connect({ cookie: "room-demoted-session" });
    control.send(JSON.stringify({ t: "room/hello", surface: "show:control" }));
    roomDisplay.send(JSON.stringify({ t: "room/hello", surface: "show:room:room-a" }));

    const controlState = waitForMessage(control, (message) =>
      message.t === "show/state" && message.state.status === "running");
    const displayState = waitForMessage(roomDisplay, (message) =>
      message.t === "show/state" && message.state.status === "running");
    const result = waitForType(control, "room/result");
    control.send(JSON.stringify({
      t: "show/control",
      requestId: "start-show",
      action: "start",
      talkId: "room-live-talk",
    }));
    expect(await controlState).toMatchObject({
      t: "show/state",
      state: { status: "running", currentTalkId: "room-live-talk", revision: 1 },
    });
    expect(await displayState).toMatchObject({
      t: "show/state",
      state: { status: "running", currentTalkId: "room-live-talk", revision: 1 },
    });
    expect(await result).toMatchObject({
      t: "room/result",
      operationId: "show.control",
      replyTo: "start-show",
    });

    const lateControl = await connect({ cookie: "room-owner-session" });
    const restored = waitForMessage(lateControl, (message) =>
      message.t === "show/state" && message.state.status === "running");
    lateControl.send(JSON.stringify({ t: "room/hello", surface: "show:control" }));
    expect(await restored).toMatchObject({
      t: "show/state",
      state: { status: "running", currentTalkId: "room-live-talk", revision: 1 },
    });

    const cueAtDisplay = waitForType(roomDisplay, "show/cue");
    const cueAtControl = waitForType(control, "show/cue");
    const cueAck = waitForType(control, "show/cue_sent");
    control.send(JSON.stringify({
      t: "show/cue",
      requestId: "cue-room-a",
      kind: "five_minutes",
      target: { kind: "room", value: "room-a" },
      message: "Five minutes remaining in Room A.",
    }));
    expect(await cueAtDisplay).toMatchObject({
      t: "show/cue",
      cue: { kind: "five_minutes", message: "Five minutes remaining in Room A." },
    });
    expect(await cueAtControl).toMatchObject({ t: "show/cue" });
    expect(await cueAck).toMatchObject({
      t: "show/cue_sent",
      recipients: 3,
      replyTo: "cue-room-a",
    });

    const reset = waitForMessage(control, (message) =>
      message.t === "show/state" && message.state.status === "idle" && message.state.revision === 2);
    control.send(JSON.stringify({ t: "show/control", requestId: "reset-show", action: "reset" }));
    expect(await reset).toMatchObject({ t: "show/state", state: { status: "idle", revision: 2 } });
  });

  it("denies show control to reviewers", async () => {
    const reviewer = await connect({ cookie: "room-reviewer-session" });
    const denied = waitForType(reviewer, "room/error");
    reviewer.send(JSON.stringify({
      t: "show/cue",
      requestId: "reviewer-cue",
      kind: "hold",
      target: { kind: "crew" },
      message: "Forged hold cue",
    }));
    expect(await denied).toMatchObject({
      t: "room/error",
      message: "Access denied",
      replyTo: "reviewer-cue",
    });
  });

  it("rejects malformed internal broadcasts before delivery", async () => {
    const id = env.EVENT_ROOM.idFromName(EVENT_ID);
    const response = await env.EVENT_ROOM.get(id).fetch("https://event-room/broadcast", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-session-party-internal": sessionSecret(env),
        "x-partykit-room": EVENT_ID,
      },
      body: JSON.stringify({
        message: {
          t: "agenda/conflicts",
          conflicts: [{ kind: "room_overlap", talkIds: ["only-one"] }],
        },
      }),
    });
    expect(response.status).toBe(400);
  });

  it("revalidates API-key revocation before a privileged mutation", async () => {
    const writer = await connect({ bearer: "room-writer-key" });
    await env.DB.prepare(
      "UPDATE api_keys SET revoked_at = ? WHERE id = 'room-writer-key-id'",
    ).bind(Date.now()).run();
    const closed = new Promise<CloseEvent>((resolve) => {
      writer.addEventListener("close", resolve, { once: true });
    });
    writer.send(JSON.stringify({
      t: "agenda/resize",
      requestId: "revoked-write",
      idempotencyKey: "revoked-write",
      talkId: "talk",
      durationMin: 30,
      expectedVersion: 1,
    }));
    expect((await closed).code).toBe(4403);
  });
  it("closes a revoked recipient before privileged delivery", async () => {
    const revoked = await connect({ bearer: "room-revoked-reader-key" });
    const revokedMessages: ServerMessage[] = [];
    revoked.addEventListener("message", (event) => {
      if (typeof event.data === "string") revokedMessages.push(JSON.parse(event.data) as ServerMessage);
    });
    await env.DB.prepare(
      "UPDATE api_keys SET revoked_at = ? WHERE id = 'room-revoked-reader-key-id'",
    ).bind(Date.now()).run();
    const revokedClosed = new Promise<CloseEvent>((resolve) => {
      revoked.addEventListener("close", resolve, { once: true });
    });
    await broadcast({ t: "agenda/conflicts", conflicts: [] });
    expect((await revokedClosed).code).toBe(4403);
    expect(revokedMessages.some(({ t }) => t === "agenda/conflicts")).toBe(false);
  });

  it("rejects expired hello before publishing presence", async () => {

    const observer = await connect({ cookie: "room-owner-session" });
    const expired = await connect({ cookie: "room-expired-session" });
    await env.DB.prepare(
      "UPDATE auth_tokens SET expires_at = ? WHERE id = 'room-expired-session-id'",
    ).bind(Date.now() - 1).run();
    const expiredClosed = new Promise<CloseEvent>((resolve) => {
      expired.addEventListener("close", resolve, { once: true });
    });
    expired.send(JSON.stringify({ t: "room/hello", surface: "forged-expired-presence" }));
    expect((await expiredClosed).code).toBe(4403);
    const presence = waitForType(observer, "room/presence");
    observer.send(JSON.stringify({ t: "room/hello", surface: "observer" }));
    expect(await presence).toMatchObject({
      t: "room/presence",
      users: expect.not.arrayContaining([
        expect.objectContaining({ userId: "room-expired" }),
      ]),
    });
  });

  it("refreshes a demoted role before privileged broadcast", async () => {
    const demoted = await connect({ cookie: "room-demoted-session" });
    const messages: ServerMessage[] = [];
    demoted.addEventListener("message", (event) => {
      if (typeof event.data === "string") messages.push(JSON.parse(event.data) as ServerMessage);
    });
    await env.DB.prepare(
      "UPDATE event_members SET role = 'reviewer' WHERE id = 'room-demoted-member'",
    ).run();
    await broadcast({
      t: "dashboard/progress",
      speakerId: "speaker",
      taskId: "task",
      completed: true,
      tasksDone: 1,
      tasksTotal: 1,
    });
    const refreshedPresence = waitForType(demoted, "room/presence");
    demoted.send(JSON.stringify({ t: "room/hello", surface: "reviewer-surface" }));
    expect(await refreshedPresence).toMatchObject({
      t: "room/presence",
      users: expect.arrayContaining([
        expect.objectContaining({ userId: "room-demoted", surface: "reviewer-surface" }),
      ]),
    });
    expect(messages.some(({ t }) => t === "dashboard/progress")).toBe(false);
  });
});
