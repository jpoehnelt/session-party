import { setTimeout as delay } from "node:timers/promises";
import { resolveLocalRuntime } from "./local-runtime";

const { origin } = resolveLocalRuntime();
const session = "local-smoke-session";
const apiKey = "local-smoke-api-key";
const localSecret = "explicit-local-only-session-secret-v1";

const deadline = Date.now() + 30_000;
while (true) {
  try {
    const response = await fetch(`${origin}/api/v1/events`, {
      headers: { Cookie: `sp_session=${encodeURIComponent(session)}` },
    });
    if (response.ok) break;
  } catch {
    // The single local service is still starting.
  }
  if (Date.now() >= deadline) throw new Error("Local worker did not become ready");
  await delay(250);
}

const headers = {
  "Content-Type": "application/json",
  Cookie: `sp_session=${encodeURIComponent(session)}`,
};
const existing = await fetch(`${origin}/api/v1/events/local-smoke-event`, { headers });
let event: { id?: unknown };
let eventMode: "created" | "reused";
if (existing.ok) {
  event = await existing.json() as { id?: unknown };
  eventMode = "reused";
} else if (existing.status === 404) {
  const created = await fetch(`${origin}/api/v1/events`, {
    method: "POST",
    headers,
    body: JSON.stringify({ name: "Local Smoke Event", slug: "local-smoke-event" }),
  });
  if (!created.ok) throw new Error(`Authenticated event POST failed: ${created.status}`);
  event = await created.json() as { id?: unknown };
  eventMode = "created";
} else {
  throw new Error(`Authenticated event lookup failed: ${existing.status}`);
}
if (typeof event.id !== "string") throw new Error("Authenticated event lookup returned no id");

const fetched = await fetch(`${origin}/api/v1/events/${event.id}`, { headers });
if (!fetched.ok) throw new Error(`Authenticated event GET failed: ${fetched.status}`);

const mcp = await fetch(`${origin}/mcp`, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${apiKey}`,
    Accept: "application/json, text/event-stream",
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "local-smoke", version: "1.0.0" },
    },
  }),
});
if (!mcp.ok) throw new Error(`Authenticated MCP initialize failed: ${mcp.status}`);
const mcpSessionId = mcp.headers.get("mcp-session-id");
if (!mcpSessionId) throw new Error("Authenticated MCP initialize returned no session ID");
await mcp.text();

const mcpRequest = async (id: number, method: string, params: Record<string, unknown>) => {
  const response = await fetch(`${origin}/mcp`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
      "mcp-session-id": mcpSessionId,
      "mcp-protocol-version": "2025-06-18",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  if (!response.ok) throw new Error(`Authenticated MCP ${method} failed: ${response.status}`);
  const payload = (await response.text()).split("\n")
    .find((line) => line.startsWith("data: "))
    ?.slice(6);
  if (!payload) throw new Error(`Authenticated MCP ${method} returned no SSE data event`);
  return JSON.parse(payload) as {
    readonly result?: { readonly tools?: readonly { readonly name: string }[]; readonly content?: readonly { readonly text: string }[] };
    readonly error?: unknown;
  };
};

const listedTools = await mcpRequest(2, "tools/list", {});
const toolNames = listedTools.result?.tools?.map(({ name }) => name);
if (listedTools.error || JSON.stringify(toolNames) !== JSON.stringify(["get_event", "list_events"])) {
  throw new Error("Authenticated MCP tools/list did not match the event:read key");
}
const calledTool = await mcpRequest(3, "tools/call", { name: "list_events", arguments: {} });
const calledText = calledTool.result?.content?.[0]?.text;
const calledEvents = typeof calledText === "string"
  ? JSON.parse(calledText) as readonly { readonly id?: unknown }[]
  : [];
if (
  calledTool.error
  || calledEvents.length !== 1
  || calledEvents[0]?.id !== "demo-event"
) {
  throw new Error("Authenticated MCP list_events returned an invalid result");
}

const bindings = await fetch(`${origin}/__local/smoke`, {
  method: "POST",
  headers: { "x-local-smoke-secret": localSecret },
});
if (!bindings.ok) throw new Error(`Local binding smoke failed: ${bindings.status}`);
const result = await bindings.json() as {
  mode?: unknown;
  d1?: unknown;
  r2?: unknown;
  durableObject?: unknown;
};
if (
  result.mode !== "local-fake"
  || result.d1 !== true
  || result.r2 !== true
  || result.durableObject !== true
) {
  throw new Error("Local binding smoke returned an invalid result");
}

console.log(JSON.stringify({
  mode: "local-fake",
  rest: { event: eventMode, get: fetched.status },
  mcp: { initialize: mcp.status, tools: toolNames, call: "list_events" },
  bindings: { d1: true, r2: true, durableObject: true },
}));
