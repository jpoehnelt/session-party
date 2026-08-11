import { expect, test, type APIRequestContext, type TestInfo } from "@playwright/test";

const EVENT_ID = "demo-event";
const OWNER_SESSION = "demo-owner-session";
const REVIEWER_SESSION = "demo-reviewer-session";

function desktopOnly(testInfo: TestInfo): void {
  test.skip(testInfo.project.name !== "desktop-chromium", "Mutation transport behavior is browser-independent");
}

function headers(session: string, extra: Record<string, string> = {}): Record<string, string> {
  return { Cookie: `sp_session=${session}`, ...extra };
}

const fields = [{
  type: "text",
  label: "QA recovery note",
  semanticKey: null,
  helpText: "Disposable mutation fixture",
  required: true,
  options: [],
  logic: null,
  routing: {},
}] as const;

const createBody = {
  purpose: "additional",
  name: "QA controlled mutation form",
  description: "Created and removed by the disposable Playwright sandbox.",
  opensAt: null,
  closesAt: null,
  fields,
} as const;

async function responseBody(response: Awaited<ReturnType<APIRequestContext["get"]>>): Promise<unknown> {
  return response.json().catch(() => response.text());
}

test("form commands enforce role, idempotency, optimistic concurrency, and replay-safe cleanup", async ({ request }, testInfo) => {
  desktopOnly(testInfo);
  const path = `/api/v1/events/${EVENT_ID}/forms`;

  const forbidden = await request.post(path, {
    headers: headers(REVIEWER_SESSION, { "Idempotency-Key": "qa-reviewer-form-create" }),
    data: createBody,
  });
  expect(forbidden.status()).toBe(403);

  const createKey = "qa-form-create-replay";
  const [firstCreate, replayCreate] = await Promise.all([
    request.post(path, { headers: headers(OWNER_SESSION, { "Idempotency-Key": createKey }), data: createBody }),
    request.post(path, { headers: headers(OWNER_SESSION, { "Idempotency-Key": createKey }), data: createBody }),
  ]);
  expect(firstCreate.status()).toBe(201);
  expect(replayCreate.status()).toBe(201);
  const created = await responseBody(firstCreate) as { readonly id: string; readonly version: number };
  expect(await responseBody(replayCreate)).toMatchObject({ id: created.id, version: created.version });

  const mismatchedReplay = await request.post(path, {
    headers: headers(OWNER_SESSION, { "Idempotency-Key": createKey }),
    data: { ...createBody, name: "QA mismatched replay" },
  });
  expect(mismatchedReplay.status()).toBe(409);

  const updatePath = `${path}/${created.id}`;
  const update = (name: string, key: string) => request.put(updatePath, {
    headers: headers(OWNER_SESSION, {
      "Idempotency-Key": key,
      "If-Match": String(created.version),
    }),
    data: { ...createBody, name },
  });
  const competing = await Promise.all([
    update("QA concurrency winner A", "qa-form-update-a"),
    update("QA concurrency winner B", "qa-form-update-b"),
  ]);
  expect(competing.map((response) => response.status()).sort()).toEqual([200, 409]);

  const currentResponse = await request.get(updatePath, { headers: headers(OWNER_SESSION) });
  expect(currentResponse.status()).toBe(200);
  const current = await responseBody(currentResponse) as { readonly name: string; readonly version: number };
  expect(["QA concurrency winner A", "QA concurrency winner B"]).toContain(current.name);
  expect(current.version).toBe(created.version + 1);

  const staleUpdate = await update("QA stale overwrite", "qa-form-update-stale");
  expect(staleUpdate.status()).toBe(409);
  expect(JSON.stringify(await responseBody(staleUpdate))).not.toMatch(/stack|cause|sql|database/i);

  const deleteKey = "qa-form-delete-replay";
  const remove = () => request.delete(updatePath, {
    headers: headers(OWNER_SESSION, {
      "Idempotency-Key": deleteKey,
      "If-Match": String(current.version),
    }),
  });
  const removed = await remove();
  expect(removed.status()).toBe(200);
  expect(await responseBody(removed)).toMatchObject({ formId: created.id, deleted: true, idempotent: false });
  const replayedRemoval = await remove();
  expect(replayedRemoval.status()).toBe(200);
  expect(await responseBody(replayedRemoval)).toMatchObject({ formId: created.id, deleted: true, idempotent: true });

  const missing = await request.get(updatePath, { headers: headers(OWNER_SESSION) });
  expect(missing.status()).toBe(404);
});

test("event API keys expose their secret once, honor scope and event boundaries, and stop working after revocation", async ({ request }, testInfo) => {
  desktopOnly(testInfo);
  const collectionPath = `/api/v1/events/${EVENT_ID}/api-keys`;
  const createdResponse = await request.post(collectionPath, {
    headers: headers(OWNER_SESSION),
    data: {
      name: "QA disposable read key",
      scopes: ["forms:read"],
      expiresAt: Date.now() + 2 * 60 * 60 * 1_000,
    },
  });
  expect(createdResponse.status()).toBe(201);
  const created = await responseBody(createdResponse) as {
    readonly apiKey: { readonly id: string; readonly version: number };
    readonly secret: string;
  };
  expect(created.secret.length).toBeGreaterThan(20);

  const bearer = { Authorization: `Bearer ${created.secret}` };
  const allowedRead = await request.get(`/api/v1/events/${EVENT_ID}/forms`, { headers: bearer });
  expect(allowedRead.status()).toBe(200);
  const deniedWrite = await request.post(`/api/v1/events/${EVENT_ID}/forms`, {
    headers: { ...bearer, "Idempotency-Key": "qa-api-key-write-denied" },
    data: createBody,
  });
  expect(deniedWrite.status()).toBe(403);
  const crossEventRead = await request.get("/api/v1/events/demo-other-event/forms", { headers: bearer });
  expect([403, 404]).toContain(crossEventRead.status());

  const metadataResponse = await request.get(collectionPath, { headers: headers(OWNER_SESSION) });
  expect(metadataResponse.status()).toBe(200);
  const metadata = await responseBody(metadataResponse);
  expect(JSON.stringify(metadata)).not.toContain(created.secret);
  expect(JSON.stringify(metadata)).not.toMatch(/"secret"\s*:/i);

  const revokeResponse = await request.delete(`${collectionPath}/${created.apiKey.id}`, {
    headers: headers(OWNER_SESSION),
    data: { expectedVersion: created.apiKey.version },
  });
  expect(revokeResponse.status()).toBe(200);
  expect(await responseBody(revokeResponse)).toMatchObject({
    id: created.apiKey.id,
    revokedAt: expect.any(String),
    version: created.apiKey.version + 1,
  });

  const revokedRead = await request.get(`/api/v1/events/${EVENT_ID}/forms`, { headers: bearer });
  expect(revokedRead.status()).toBe(401);
  expect(JSON.stringify(await responseBody(revokedRead))).not.toMatch(/stack|cause|hash|secret/i);
});
