import assert from "node:assert/strict";
import test from "node:test";
import { smokeOrigin } from "./post-deploy-smoke.mjs";

test("production smoke is read-only and verifies the public and auth boundaries", async () => {
  const requests = [];
  const result = await smokeOrigin("https://events.example.com", async (input, init) => {
    requests.push({ url: String(input), method: init?.method ?? "GET" });
    return String(input).endsWith("/api/v1/auth/me")
      ? Response.json({ error: "Unauthenticated" }, { status: 401 })
      : new Response("<!doctype html>", { headers: { "content-type": "text/html" } });
  });
  assert.equal(result.ok, true);
  assert.deepEqual(requests, [
    { url: "https://events.example.com/", method: "GET" },
    { url: "https://events.example.com/api/v1/auth/me", method: "GET" },
  ]);
});

test("production smoke rejects insecure remote targets and paths", async () => {
  await assert.rejects(() => smokeOrigin("http://events.example.com"), /HTTPS/);
  await assert.rejects(() => smokeOrigin("https://events.example.com/admin"), /origin only/);
});
