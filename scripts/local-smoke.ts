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
const created = await fetch(`${origin}/api/v1/events`, {
  method: "POST",
  headers,
  body: JSON.stringify({ name: "Local Smoke Event", slug: "local-smoke-event" }),
});
if (!created.ok) throw new Error(`Authenticated event POST failed: ${created.status}`);
const event = await created.json() as { id?: unknown };
if (typeof event.id !== "string") throw new Error("Authenticated event POST returned no id");

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
  rest: { post: created.status, get: fetched.status },
  mcp: mcp.status,
  bindings: { d1: true, r2: true, durableObject: true },
}));
