import { applyD1Migrations, env, SELF, type D1Migration } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { hashBearerMaterial } from "./auth";

type TestEnv = Cloudflare.Env & { readonly TEST_MIGRATIONS: readonly D1Migration[] };

type RpcResponse = {
  readonly jsonrpc: "2.0";
  readonly id: number;
  readonly result?: Record<string, unknown>;
  readonly error?: { readonly code: number; readonly message: string };
};

const EVENT_ID = "mcp-transport-event";
const expiresAt = Date.UTC(2100, 0, 1);

const request = async (
  bearer: string,
  body: Record<string, unknown>,
  sessionId?: string,
): Promise<{ readonly response: Response; readonly rpc: RpcResponse }> => {
  const headers = new Headers({
    Authorization: `Bearer ${bearer}`,
    Accept: "application/json, text/event-stream",
    "Content-Type": "application/json",
  });
  if (sessionId) {
    headers.set("mcp-session-id", sessionId);
    headers.set("mcp-protocol-version", "2025-06-18");
  }
  const response = await SELF.fetch("https://example.test/mcp", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const payload = (await response.text())
    .split("\n")
    .find((line) => line.startsWith("data: "))
    ?.slice(6);
  if (!payload) throw new Error("MCP response did not contain an SSE data event");
  return { response, rpc: JSON.parse(payload) as RpcResponse };
};

const initialize = async (bearer: string): Promise<string> => {
  const { response, rpc } = await request(bearer, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "mcp-transport-test", version: "1.0.0" },
    },
  });
  expect(response.status).toBe(200);
  expect(rpc.result).toMatchObject({
    protocolVersion: "2025-06-18",
    serverInfo: { name: "session-party" },
  });
  const sessionId = response.headers.get("mcp-session-id");
  if (!sessionId) throw new Error("MCP initialize did not return a session ID");
  return sessionId;
};

beforeAll(async () => {
  if (!("TEST_MIGRATIONS" in env)) throw new Error("TEST_MIGRATIONS binding is unavailable");
  await applyD1Migrations(env.DB, [...(env as TestEnv).TEST_MIGRATIONS]);
  const now = Date.now();
  const [eventReadHash, agendaReadHash, speakersWriteHash] = await Promise.all([
    hashBearerMaterial(env, "mcp-event-read-key"),
    hashBearerMaterial(env, "mcp-agenda-read-key"),
    hashBearerMaterial(env, "mcp-speakers-write-key"),
  ]);
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO users (id, email, name, version, created_at, updated_at) VALUES ('mcp-owner', 'mcp-owner@example.com', 'MCP Owner', 1, ?, ?)",
    ).bind(now, now),
    env.DB.prepare(
      "INSERT INTO events (id, slug, name, timezone, version, created_at, updated_at) VALUES (?, 'mcp-transport', 'MCP Transport', 'UTC', 1, ?, ?)",
    ).bind(EVENT_ID, now, now),
    env.DB.prepare(
      "INSERT INTO api_keys (id, event_id, name, key_hash, scopes, expires_at, revoked_at, created_by, version, created_at, updated_at) VALUES ('mcp-event-read', ?, 'Event reader', ?, '[\"event:read\"]', ?, NULL, 'mcp-owner', 1, ?, ?)",
    ).bind(EVENT_ID, eventReadHash, expiresAt, now, now),
    env.DB.prepare(
      "INSERT INTO api_keys (id, event_id, name, key_hash, scopes, expires_at, revoked_at, created_by, version, created_at, updated_at) VALUES ('mcp-agenda-read', ?, 'Agenda reader', ?, '[\"agenda:read\"]', ?, NULL, 'mcp-owner', 1, ?, ?)",
    ).bind(EVENT_ID, agendaReadHash, expiresAt, now, now),
    env.DB.prepare(
      "INSERT INTO api_keys (id, event_id, name, key_hash, scopes, expires_at, revoked_at, created_by, version, created_at, updated_at) VALUES ('mcp-speakers-write', ?, 'Speaker writer', ?, '[\"speakers:write\"]', ?, NULL, 'mcp-owner', 1, ?, ?)",
    ).bind(EVENT_ID, speakersWriteHash, expiresAt, now, now),
  ]);
});

describe("MCP transport", () => {
  it("discovers and executes only tools allowed by the key scopes", async () => {
    const sessionId = await initialize("mcp-agenda-read-key");
    const listed = await request("mcp-agenda-read-key", {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {},
    }, sessionId);
    const tools = listed.rpc.result?.tools as readonly { readonly name: string }[];
    expect(tools.map(({ name }) => name)).toEqual([
      "agenda_list",
      "agenda_list_talk_content_history",
      "get_event",
      "list_events",
    ]);

    const called = await request("mcp-agenda-read-key", {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "agenda_list", arguments: { eventId: EVENT_ID, view: "list" } },
    }, sessionId);
    expect(called.rpc.error).toBeUndefined();
    expect(called.rpc.result?.content).toBeDefined();

    const crossEvent = await request("mcp-agenda-read-key", {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "agenda_list", arguments: { eventId: "another-event", view: "list" } },
    }, sessionId);
    expect(crossEvent.rpc.error?.message).toContain('"error":"Forbidden"');
    expect(crossEvent.rpc.error?.message).not.toContain("another-event");

    const hidden = await request("mcp-agenda-read-key", {
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: { name: "agenda_publish", arguments: { eventId: EVENT_ID } },
    }, sessionId);
    expect(hidden.rpc.error).toMatchObject({ code: -32603, message: "Unknown tool: agenda_publish" });

    const switchedCredential = await SELF.fetch("https://example.test/mcp", {
      method: "POST",
      headers: {
        Authorization: "Bearer mcp-speakers-write-key",
        Accept: "application/json, text/event-stream",
        "Content-Type": "application/json",
        "mcp-session-id": sessionId,
        "mcp-protocol-version": "2025-06-18",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 6, method: "tools/list", params: {} }),
    });
    expect(switchedCredential.status).toBe(200);
    expect(await switchedCredential.text()).toBe("");

    const originalCredential = await request("mcp-agenda-read-key", {
      jsonrpc: "2.0",
      id: 7,
      method: "tools/list",
      params: {},
    }, sessionId);
    expect((originalCredential.rpc.result?.tools as readonly { readonly name: string }[])
      .map(({ name }) => name))
      .toContain("agenda_list");
  });

  it("executes the consolidated speaker-onboarding workflow", async () => {
    const sessionId = await initialize("mcp-speakers-write-key");
    const called = await request("mcp-speakers-write-key", {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "manage_speaker_onboarding",
        arguments: {
          eventId: EVENT_ID,
          action: {
            type: "createTask",
            name: "Upload slides",
            description: null,
            kind: "upload",
            formId: null,
            dueAt: null,
            order: 1,
          },
        },
      },
    }, sessionId);
    expect(called.rpc.error).toBeUndefined();
    const content = called.rpc.result?.content as readonly { readonly text: string }[];
    expect(JSON.parse(content[0]!.text)).toMatchObject({
      action: "createTask",
      result: { eventId: EVENT_ID, name: "Upload slides", kind: "upload" },
    });
  });
});
