import { expect, test, type APIRequestContext, type TestInfo } from "@playwright/test";

const EVENT_ID = "demo-event";
const OWNER_SESSION = "demo-owner-session";
const ADMIN_SESSION = "demo-admin-session";
const REVIEWER_SESSION = "demo-reviewer-session";
const ADMIN_EMAIL = "admin@sessionparty.local";

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

test("member commands enforce escalation, last-owner safety, concurrency, immediate revocation, replay, and cleanup", async ({ request }, testInfo) => {
  desktopOnly(testInfo);
  const collectionPath = `/api/v1/events/${EVENT_ID}/members`;
  const ownerHeaders = headers(OWNER_SESSION);
  const listMembers = async () => {
    const response = await request.get(collectionPath, { headers: ownerHeaders });
    expect(response.status()).toBe(200);
    return responseBody(response) as Promise<readonly {
      readonly id: string;
      readonly email: string;
      readonly role: "owner" | "admin" | "reviewer";
      readonly version: number;
    }[]>;
  };
  const ensureAdminBaseline = async () => {
    const members = await listMembers();
    const admin = members.find(({ email }) => email === ADMIN_EMAIL);
    if (!admin) {
      const restored = await request.post(collectionPath, {
        headers: ownerHeaders,
        data: { email: ADMIN_EMAIL, role: "admin", idempotencyKey: "qa-member-finally-add-admin" },
      });
      expect([200, 201]).toContain(restored.status());
      return;
    }
    if (admin.role !== "admin") {
      const restored = await request.patch(`${collectionPath}/${admin.id}`, {
        headers: ownerHeaders,
        data: { role: "admin", expectedVersion: admin.version, idempotencyKey: "qa-member-finally-restore-admin" },
      });
      expect(restored.status()).toBe(200);
    }
  };

  try {
    const initial = await listMembers();
    const owner = initial.find(({ role }) => role === "owner");
    const admin = initial.find(({ email }) => email === ADMIN_EMAIL);
    const reviewer = initial.find(({ role }) => role === "reviewer");
    expect(owner).toBeDefined();
    expect(admin).toBeDefined();
    expect(reviewer).toBeDefined();

    const reviewerDenied = await request.post(collectionPath, {
      headers: headers(REVIEWER_SESSION),
      data: { email: ADMIN_EMAIL, role: "reviewer", idempotencyKey: "qa-reviewer-member-denied" },
    });
    expect(reviewerDenied.status()).toBe(403);

    const adminEscalationDenied = await request.patch(`${collectionPath}/${reviewer!.id}`, {
      headers: headers(ADMIN_SESSION),
      data: { role: "admin", expectedVersion: reviewer!.version, idempotencyKey: "qa-admin-escalation-denied" },
    });
    expect(adminEscalationDenied.status()).toBe(403);

    const adminSelfDemotionDenied = await request.patch(`${collectionPath}/${admin!.id}`, {
      headers: headers(ADMIN_SESSION),
      data: { role: "reviewer", expectedVersion: admin!.version, idempotencyKey: "qa-admin-self-demotion-denied" },
    });
    expect(adminSelfDemotionDenied.status()).toBe(403);

    const lastOwnerRemoval = await request.delete(`${collectionPath}/${owner!.id}`, {
      headers: ownerHeaders,
      data: { expectedVersion: owner!.version, idempotencyKey: "qa-last-owner-removal-denied" },
    });
    expect(lastOwnerRemoval.status()).toBe(409);

    const update = (role: "owner" | "reviewer", key: string) => request.patch(`${collectionPath}/${admin!.id}`, {
      headers: ownerHeaders,
      data: { role, expectedVersion: admin!.version, idempotencyKey: key },
    });
    const competing = await Promise.all([
      update("owner", "qa-member-competing-owner"),
      update("reviewer", "qa-member-competing-reviewer"),
    ]);
    expect(competing.map((response) => response.status()).sort()).toEqual([200, 409]);

    let currentAdmin = (await listMembers()).find(({ email }) => email === ADMIN_EMAIL)!;
    expect(currentAdmin.version).toBe(admin!.version + 1);
    expect(["owner", "reviewer"]).toContain(currentAdmin.role);

    const staleOverwrite = await request.patch(`${collectionPath}/${currentAdmin.id}`, {
      headers: ownerHeaders,
      data: { role: "admin", expectedVersion: admin!.version, idempotencyKey: "qa-member-stale-overwrite" },
    });
    expect(staleOverwrite.status()).toBe(409);
    expect(JSON.stringify(await responseBody(staleOverwrite))).not.toMatch(/stack|cause|sql|database/i);

    const restore = await request.patch(`${collectionPath}/${currentAdmin.id}`, {
      headers: ownerHeaders,
      data: { role: "admin", expectedVersion: currentAdmin.version, idempotencyKey: "qa-member-restore-before-delete" },
    });
    expect(restore.status()).toBe(200);
    currentAdmin = (await responseBody(restore) as { readonly member: typeof currentAdmin }).member;

    const deleteKey = "qa-member-delete-replay";
    const remove = () => request.delete(`${collectionPath}/${currentAdmin.id}`, {
      headers: ownerHeaders,
      data: { expectedVersion: currentAdmin.version, idempotencyKey: deleteKey },
    });
    const removed = await remove();
    expect(removed.status()).toBe(200);
    expect(await responseBody(removed)).toMatchObject({ memberId: currentAdmin.id, deleted: true, idempotent: false });
    const replayedRemoval = await remove();
    expect(replayedRemoval.status()).toBe(200);
    expect(await responseBody(replayedRemoval)).toMatchObject({ memberId: currentAdmin.id, deleted: true, idempotent: true });

    const revokedSession = await request.get(`/api/v1/events/${EVENT_ID}`, { headers: headers(ADMIN_SESSION) });
    expect(revokedSession.status()).toBe(403);

    const addKey = "qa-member-add-replay";
    const add = () => request.post(collectionPath, {
      headers: ownerHeaders,
      data: { email: ADMIN_EMAIL, role: "admin", idempotencyKey: addKey },
    });
    const added = await add();
    expect(added.status()).toBe(201);
    const addedBody = await responseBody(added) as { readonly member: { readonly id: string }; readonly created: boolean; readonly idempotent: boolean };
    expect(addedBody).toMatchObject({ created: true, idempotent: false });
    const replayedAdd = await add();
    expect(replayedAdd.status()).toBe(201);
    expect(await responseBody(replayedAdd)).toMatchObject({ member: { id: addedBody.member.id }, created: true, idempotent: true });

    const restoredSession = await request.get(collectionPath, { headers: headers(ADMIN_SESSION) });
    expect(restoredSession.status()).toBe(200);
  } finally {
    await ensureAdminBaseline();
  }
});

test("task and resource commands enforce validation, role boundaries, stale writes, and cleanup", async ({ request }, testInfo) => {
  desktopOnly(testInfo);
  const taskPath = `/api/v1/events/${EVENT_ID}/portal/tasks`;
  const resourcePath = `/api/v1/events/${EVENT_ID}/portal/resources`;
  const ownerHeaders = headers(OWNER_SESSION);
  const createdTaskIds = new Set<string>();
  const createdResourceIds = new Set<string>();

  const formsResponse = await request.get(`/api/v1/events/${EVENT_ID}/forms`, { headers: ownerHeaders });
  expect(formsResponse.status()).toBe(200);
  const forms = await responseBody(formsResponse) as readonly { readonly id: string; readonly purpose: string }[];
  const primaryForm = forms.find(({ purpose }) => purpose === "primary-cfp");
  expect(primaryForm).toBeDefined();

  const taskBody = (kind: "profile" | "upload" | "form" | "link" | "confirm", order: number) => ({
    name: `QA disposable ${kind} task`,
    description: "Created and removed by the controlled Playwright mutation suite.",
    kind,
    formId: kind === "form" ? primaryForm!.id : null,
    dueAt: Date.parse("2026-08-12T18:00:00.000Z"),
    order,
    speakerIds: [],
  });

  try {
    const forbiddenTask = await request.post(taskPath, {
      headers: headers(REVIEWER_SESSION),
      data: taskBody("confirm", 900),
    });
    expect(forbiddenTask.status()).toBe(403);

    const invalidFormTask = await request.post(taskPath, {
      headers: ownerHeaders,
      data: { ...taskBody("form", 901), formId: null },
    });
    expect(invalidFormTask.status()).toBe(400);
    expect(JSON.stringify(await responseBody(invalidFormTask))).not.toMatch(/stack|cause|sql|database/i);

    const tasks: { readonly id: string; readonly version: number; readonly kind: string }[] = [];
    for (const [index, kind] of (["profile", "upload", "form", "link", "confirm"] as const).entries()) {
      const response = await request.post(taskPath, {
        headers: ownerHeaders,
        data: taskBody(kind, 910 + index),
      });
      expect(response.status(), `create ${kind} task`).toBe(201);
      const task = await responseBody(response) as { readonly id: string; readonly version: number; readonly kind: string };
      expect(task.kind).toBe(kind);
      createdTaskIds.add(task.id);
      tasks.push(task);
    }

    const contested = tasks.at(-1)!;
    const update = (name: string) => request.put(`${taskPath}/${contested.id}`, {
      headers: ownerHeaders,
      data: { ...taskBody("confirm", 914), name, expectedVersion: contested.version },
    });
    const competingUpdates = await Promise.all([
      update("QA task writer A"),
      update("QA task writer B"),
    ]);
    expect(competingUpdates.map((response) => response.status()).sort()).toEqual([200, 409]);

    const staleTaskDelete = await request.delete(`${taskPath}/${contested.id}`, {
      headers: ownerHeaders,
      data: { expectedVersion: contested.version },
    });
    expect(staleTaskDelete.status()).toBe(409);

    const forbiddenResource = await request.post(resourcePath, {
      headers: headers(REVIEWER_SESSION),
      data: { slug: "qa-forbidden-resource", title: "Forbidden", body: null, embedUrl: null, audience: "speakers", order: 900 },
    });
    expect(forbiddenResource.status()).toBe(403);

    for (const [index, embedUrl] of [
      "http://www.youtube.com/embed/unsafe",
      "https://youtube.com.evil.example/embed/unsafe",
      "javascript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
    ].entries()) {
      const unsafe = await request.post(resourcePath, {
        headers: ownerHeaders,
        data: { slug: `qa-unsafe-resource-${index}`, title: "Unsafe", body: null, embedUrl, audience: "public", order: 910 + index },
      });
      expect(unsafe.status(), embedUrl).toBe(400);
    }

    const resourceCreate = await request.post(resourcePath, {
      headers: ownerHeaders,
      data: {
        slug: "qa-disposable-resource",
        title: "QA disposable resource — 東京",
        body: "Controlled lifecycle fixture.",
        embedUrl: "https://www.youtube-nocookie.com/embed/aqz-KE-bpKQ",
        audience: "speakers",
        order: 920,
      },
    });
    expect(resourceCreate.status()).toBe(201);
    const resource = await responseBody(resourceCreate) as { readonly id: string; readonly version: number };
    createdResourceIds.add(resource.id);

    const updateResource = (title: string) => request.put(`${resourcePath}/${resource.id}`, {
      headers: ownerHeaders,
      data: {
        expectedVersion: resource.version,
        slug: "qa-disposable-resource",
        title,
        body: "Controlled lifecycle fixture.",
        embedUrl: "https://www.youtube-nocookie.com/embed/aqz-KE-bpKQ",
        audience: "public",
        order: 920,
      },
    });
    const competingResources = await Promise.all([
      updateResource("QA resource writer A"),
      updateResource("QA resource writer B"),
    ]);
    expect(competingResources.map((response) => response.status()).sort()).toEqual([200, 409]);
    const staleResourceDelete = await request.delete(`${resourcePath}/${resource.id}`, {
      headers: ownerHeaders,
      data: { expectedVersion: resource.version },
    });
    expect(staleResourceDelete.status()).toBe(409);
  } finally {
    const currentTasks = await request.get(taskPath, { headers: ownerHeaders });
    if (currentTasks.ok()) {
      for (const task of await responseBody(currentTasks) as readonly { readonly id: string; readonly version: number }[]) {
        if (!createdTaskIds.has(task.id)) continue;
        await request.delete(`${taskPath}/${task.id}`, { headers: ownerHeaders, data: { expectedVersion: task.version } });
      }
    }
    const currentResources = await request.get(resourcePath, { headers: ownerHeaders });
    if (currentResources.ok()) {
      for (const resource of await responseBody(currentResources) as readonly { readonly id: string; readonly version: number }[]) {
        if (!createdResourceIds.has(resource.id)) continue;
        await request.delete(`${resourcePath}/${resource.id}`, { headers: ownerHeaders, data: { expectedVersion: resource.version } });
      }
    }
  }

  const finalTasks = await request.get(taskPath, { headers: ownerHeaders });
  expect((await responseBody(finalTasks) as readonly { readonly id: string }[]).some(({ id }) => createdTaskIds.has(id))).toBe(false);
  const finalResources = await request.get(resourcePath, { headers: ownerHeaders });
  expect((await responseBody(finalResources) as readonly { readonly id: string }[]).some(({ id }) => createdResourceIds.has(id))).toBe(false);
});
