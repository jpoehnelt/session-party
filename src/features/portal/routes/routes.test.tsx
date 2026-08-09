import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server.edge";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  PortalDashboard,
  PortalEvent,
  PortalResource,
  PortalSnapshot,
  PortalTask,
  PortalTaskDefinition,
  PublicSpeakerGallery,
  SpeakerDirectory,
} from "../schema";
import type { PublicSubmissionForm } from "@/features/submit/schema";
import {
  createResource,
  createTask,
  deleteResource,
  deleteTask,
  getPublicSpeakerGallery,
  getSpeakerDirectory,
  getSpeakerPortal,
  getSpeakerTaskForm,
  getTaskDefinitions,
  provisionSpeaker,
  setSpeakerTaskCompletion,
  submitSpeakerTaskForm,
  updateResource,
  updateSpeakerProfile,
  updateTask,
  updateSpeakerPublication,
  uploadSpeakerAsset,
} from "./api";
import { path as dashboardPath, OrganizerDashboardContent } from "./organizer-dashboard";
import { path as resourcesPath, OrganizerResourcesContent } from "./organizer-resources";
import { path as speakersPath, OrganizerSpeakersContent } from "./organizer-speakers";
import { path as tasksPath, OrganizerTasksContent } from "./organizer-tasks";
import { layout as embedLayout, path as embedPath, PublicSpeakerEmbedContent } from "./public-speakers";
import {
  allowlistedEmbedUrl,
  fileAsBase64,
  layout as portalLayout,
  path as portalPath,
  PORTAL_UPLOAD_MAX_BYTES,
  SpeakerPortalContent,
  SpeakerTaskFormPanel,
} from "./speaker-portal";

const event: PortalEvent = {
  id: "event-production",
  slug: "production-summit",
  name: "Production Summit",
  description: "A practical event for live-production teams.",
  location: "Portland",
  timezone: "America/Los_Angeles",
  startsAt: 1_786_000_000_000,
  endsAt: 1_786_086_400_000,
  bannerAssetId: null,
  accentColor: null,
};

const task: PortalTaskDefinition = {
  id: "task-profile",
  eventId: event.id,
  name: "Review speaker profile",
  description: "Confirm the details used by the event team.",
  kind: "profile",
  formId: null,
  dueAt: 1_785_000_000_000,
  order: 1,
  version: 3,
};

const resource: PortalResource = {
  id: "resource-guide",
  eventId: event.id,
  slug: "speaker-guide",
  title: "Speaker production guide",
  body: "Arrive 20 minutes before your session.",
  embedUrl: "https://docs.google.com/presentation/d/approved/embed",
  audience: "speakers",
  order: 1,
  version: 4,
};

const profile = {
  id: "speaker-river",
  eventId: event.id,
  displayName: "River Okafor",
  title: "Production director",
  company: "Signal House",
  bio: "River builds resilient live event systems.",
  headshotAssetId: null,
  links: [{ label: "Website", url: "https://example.com/river" }],
  visible: true,
  version: 5,
  pendingSyncFields: [],
} as const;

const snapshot: PortalSnapshot = {
  event,
  speaker: profile,
  submission: { id: "submission-stage", title: "The calm show call", category: "Operations", version: 2 },
  provisioningStatus: "provisioned",
  tasks: [{
    ...task,
    completed: false,
    completedAt: null,
    completionData: null,
    completionVersion: 0,
    prerequisite: { satisfied: false, message: "Add your bio before completing this task." },
  }],
  resources: [resource],
  assets: [{ id: "asset-slides", eventId: event.id, filename: "final-slides.pdf", contentType: "application/pdf", size: 2048, purpose: "slides", version: 1 }],
  readiness: { tasksTotal: 1, tasksDone: 0, outstandingTaskIds: [task.id], nextTaskId: task.id, state: "not_started" },
};

const formTask: PortalTask = {
  ...task,
  id: "task-travel-form",
  name: "Travel details",
  description: "Share your arrival and accessibility details.",
  kind: "form",
  formId: "form-travel",
  completed: false,
  completedAt: null,
  completionData: null,
  completionVersion: 0,
  prerequisite: { satisfied: false, message: "Submit the linked form before completing this task." },
};

const linkedForm: PublicSubmissionForm = {
  event: {
    name: event.name,
    slug: event.slug,
    description: event.description,
    timezone: event.timezone,
    startsAt: event.startsAt,
    endsAt: event.endsAt,
    location: event.location,
    accentColor: event.accentColor,
  },
  form: {
    id: formTask.formId!,
    versionId: "form-travel-v1",
    versionNumber: 1,
    name: "Speaker travel details",
    description: "Help production plan your arrival.",
    availability: "open",
    opensAt: null,
    closesAt: null,
    fields: [{
      id: "field-arrival",
      order: 1,
      type: "text",
      label: "Arrival details",
      helpText: null,
      required: true,
      options: [],
      logic: null,
    }],
  },
};

const directory: SpeakerDirectory = {
  event,
  speakers: [{
    speaker: profile,
    submission: snapshot.submission,
    acceptanceEventId: "acceptance-1",
    provisioningId: "provisioning-1",
    provisioningStatus: "pending",
    provisioningVersion: 2,
    provisionedAt: null,
    readiness: snapshot.readiness,
  }],
};

const dashboard: PortalDashboard = {
  event,
  speakers: directory.speakers,
  totals: { speakers: 1, ready: 0, tasksDone: 0, tasksTotal: 1 },
};

const gallery: PublicSpeakerGallery = {
  event,
  speakers: [{
    id: profile.id,
    displayName: profile.displayName,
    title: profile.title,
    company: profile.company,
    bio: profile.bio,
    headshotUrl: null,
    links: profile.links,
  }],
};

function ok(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });
}

function noop() {}
async function succeeds() { return true; }

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("portal route registration", () => {
  it("exports every frozen portal path without nesting an application shell", () => {
    expect(portalPath).toBe("/e/:eventSlug/portal/*");
    expect(portalLayout).toBe("bare");
    expect(speakersPath).toBe("/e/:eventSlug/speakers");
    expect(dashboardPath).toBe("/e/:eventSlug/dashboard");
    expect(tasksPath).toBe("/e/:eventSlug/tasks");
    expect(resourcesPath).toBe("/e/:eventSlug/resources");
    expect(embedPath).toBe("/embed/:eventSlug/speakers");
    expect(embedLayout).toBe("bare");
  });
});

describe("portal API loading", () => {
  it("calls the browser-session speaker endpoint directly by slug", async () => {
    const fetchMock = vi.fn(async () => ok(snapshot));
    vi.stubGlobal("fetch", fetchMock);
    await expect(getSpeakerPortal(event.slug)).resolves.toEqual(snapshot);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(`/api/v1/events/${event.slug}/portal`, expect.objectContaining({ method: "GET", credentials: "include" }));
  });

  it("resolves organizer event slug before loading authoritative directory and task DTOs", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === `/api/v1/events/${event.slug}`) return ok({ id: event.id });
      if (url === `/api/v1/events/${event.id}/portal/speakers`) return ok(directory);
      if (url === `/api/v1/events/${event.id}/portal/tasks`) return ok([task]);
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(getSpeakerDirectory(event.slug)).resolves.toEqual(directory);
    await expect(getTaskDefinitions(event.slug)).resolves.toEqual([task]);
    expect(fetchMock.mock.calls.map(([input]) => String(input))).toEqual([
      `/api/v1/events/${event.slug}`,
      `/api/v1/events/${event.id}/portal/speakers`,
      `/api/v1/events/${event.slug}`,
      `/api/v1/events/${event.id}/portal/tasks`,
    ]);
  });

  it("decodes only the public gallery endpoint for embeds", async () => {
    const fetchMock = vi.fn(async () => ok(gallery));
    vi.stubGlobal("fetch", fetchMock);
    await expect(getPublicSpeakerGallery(event.slug)).resolves.toEqual(gallery);
    expect(fetchMock).toHaveBeenCalledWith(`/api/v1/public/events/${event.slug}/speakers`, expect.objectContaining({ method: "GET" }));
  });

  it("loads linked fields publicly but submits answers through the speaker-session endpoint", async () => {
    const created = {
      submissionId: "submission-travel",
      status: "submitted" as const,
      submittedAt: Date.UTC(2026, 7, 9, 12),
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === `/api/v1/public/events/${event.slug}/forms/${formTask.formId}`) return ok(linkedForm);
      if (url === `/api/v1/events/${event.id}/portal/forms/${formTask.formId}/submissions`) return ok(created, 201);
      throw new Error(`Unexpected request: ${url} ${init?.method ?? "GET"}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(getSpeakerTaskForm(event.slug, formTask.formId!)).resolves.toEqual(linkedForm);
    await expect(submitSpeakerTaskForm({
      eventId: event.id,
      formId: formTask.formId!,
      idempotencyKey: "task-form-route-submit",
      answers: [{ fieldId: "field-arrival", value: "Tuesday afternoon" }],
    })).resolves.toEqual(created);

    expect(fetchMock.mock.calls[0]).toEqual([
      `/api/v1/public/events/${event.slug}/forms/${formTask.formId}`,
      expect.objectContaining({ method: "GET", credentials: "include" }),
    ]);
    const [request, init] = fetchMock.mock.calls[1]!;
    expect(request).toBe(`/api/v1/events/${event.id}/portal/forms/${formTask.formId}/submissions`);
    expect(init).toMatchObject({
      method: "POST",
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": "task-form-route-submit",
      },
    });
    expect(JSON.parse(String(init?.body))).toEqual({
      answers: [{ fieldId: "field-arrival", value: "Tuesday afternoon" }],
    });
  });
});

describe("speaker portal content", () => {
  it("renders profile editing, accepted submission, readiness, persisted tasks, files, and resources", () => {
    const markup = renderToStaticMarkup(createElement(SpeakerPortalContent, {
      snapshot,
      onSaveProfile: noop,
      onToggleTask: noop,
      onUpload: noop,
      onSubmitTaskForm: succeeds,
    }));
    expect(markup).toContain("The calm show call");
    expect(markup).toContain("River Okafor");
    expect(markup).toContain("Review speaker profile");
    expect(markup).toContain("Production thread");
    expect(markup).toContain("final-slides.pdf");
    expect(markup).toContain("Speaker production guide");
    expect(markup).toContain("sandbox=");
    expect(markup).toContain("Save profile");
    expect(markup).toContain("Up to 10 MiB with the current upload transport");
  });

  it("offers incomplete linked forms without bypassing their completion prerequisite", () => {
    const formSnapshot: PortalSnapshot = {
      ...snapshot,
      tasks: [formTask],
      readiness: {
        tasksTotal: 1,
        tasksDone: 0,
        outstandingTaskIds: [formTask.id],
        nextTaskId: formTask.id,
        state: "not_started",
      },
    };
    const markup = renderToStaticMarkup(createElement(SpeakerPortalContent, {
      snapshot: formSnapshot,
      onSaveProfile: noop,
      onToggleTask: noop,
      onUpload: noop,
      onSubmitTaskForm: succeeds,
    }));
    expect(markup).toContain("Forms to complete");
    expect(markup).toContain("Open Travel details");
    expect(markup).toContain("Submit the linked form before completing this task.");
    expect(markup).toMatch(/<input[^>]+disabled=""[^>]+type="checkbox"/);
  });

  it("renders the linked published form in the authenticated portal experience", () => {
    const markup = renderToStaticMarkup(createElement(SpeakerTaskFormPanel, {
      eventSlug: event.slug,
      task: formTask,
      busy: false,
      initialForm: linkedForm,
      onClose: noop,
      onSubmit: succeeds,
    }));
    expect(markup).toContain("Linked speaker form");
    expect(markup).toContain("Speaker travel details");
    expect(markup).toContain("Arrival details");
    expect(markup).toContain("Submit form");
  });

  it("allows only approved HTTPS resource embeds", () => {
    expect(allowlistedEmbedUrl("https://www.youtube-nocookie.com/embed/abc")).toContain("youtube-nocookie.com");
    expect(allowlistedEmbedUrl("http://docs.google.com/presentation/d/x/embed")).toBeNull();
    expect(allowlistedEmbedUrl("https://attacker.example/embed")).toBeNull();
    expect(allowlistedEmbedUrl("javascript:alert(1)")).toBeNull();
  });

  it("sends profile fields to the slug endpoint without trusting a body event id", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => ok(profile));
    vi.stubGlobal("fetch", fetchMock);
    await updateSpeakerProfile(event.slug, {
      eventId: event.id,
      expectedVersion: profile.version,
      idempotencyKey: "profile-route-save",
      displayName: profile.displayName,
      title: profile.title,
      company: profile.company,
      bio: profile.bio,
      links: profile.links,
    });
    const [request, init] = fetchMock.mock.calls[0]!;
    expect(request).toBe(`/api/v1/events/${event.slug}/portal/profile`);
    expect(JSON.parse(String(init?.body))).toEqual({
      expectedVersion: profile.version,
      idempotencyKey: "profile-route-save",
      displayName: profile.displayName,
      title: profile.title,
      company: profile.company,
      bio: profile.bio,
      links: profile.links,
    });
  });

  it("persists task toggles and real uploads against the speaker slug endpoint", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => ok({}));
    vi.stubGlobal("fetch", fetchMock);
    await setSpeakerTaskCompletion(event.slug, {
      eventId: event.id,
      taskId: task.id,
      completed: true,
      idempotencyKey: "task-route-toggle",
    });
    await uploadSpeakerAsset(event.slug, {
      eventId: event.id,
      taskId: task.id,
      purpose: "slides",
      filename: "final.pdf",
      contentType: "application/pdf",
      contentBase64: "QQ==",
      expectedVersion: 0,
      idempotencyKey: "asset-route-upload",
    });
    expect(fetchMock.mock.calls.map(([url, init]) => [url, init?.method])).toEqual([
      [`/api/v1/events/${event.slug}/portal/tasks/${task.id}/completion`, "PUT"],
      [`/api/v1/events/${event.slug}/portal/assets`, "POST"],
    ]);
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      completed: true,
      idempotencyKey: "task-route-toggle",
    });
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({
      taskId: task.id,
      expectedVersion: 0,
      idempotencyKey: "asset-route-upload",
      purpose: "slides",
      filename: "final.pdf",
      contentType: "application/pdf",
      contentBase64: "QQ==",
    });
  });
  it("rejects files over 10 MiB before reading or encoding them", async () => {
    const arrayBuffer = vi.fn();
    const file = {
      size: PORTAL_UPLOAD_MAX_BYTES + 1,
      arrayBuffer,
    } as unknown as File;
    await expect(fileAsBase64(file)).rejects.toThrow(
      "File exceeds 10 MiB with the current upload transport",
    );
    expect(arrayBuffer).not.toHaveBeenCalled();
  });

});

describe("organizer content and workflows", () => {
  it("renders a dense speaker directory and readiness matrix from returned state", () => {
    const speakersMarkup = renderToStaticMarkup(createElement(OrganizerSpeakersContent, {
      directory,
      onProvision: noop,
      onVisibility: noop,
    }));
    expect(speakersMarkup).toContain("River Okafor");
    expect(speakersMarkup).toContain("The calm show call");
    expect(speakersMarkup).toContain("Public gallery");
    expect(speakersMarkup).toContain("0/1");
    expect(speakersMarkup).toContain("Provision");

    const dashboardMarkup = renderToStaticMarkup(createElement(OrganizerDashboardContent, { dashboard }));
    expect(dashboardMarkup).toContain("Speaker readiness");
    expect(dashboardMarkup).toContain("0 / 1");
    expect(dashboardMarkup).toContain("1 remaining");
  });

  it("uses provisioning concurrency separately from speaker publication concurrency", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => ok({}));
    vi.stubGlobal("fetch", fetchMock);
    await provisionSpeaker(event.id, {
      eventId: event.id,
      speakerId: profile.id,
      provisioningId: directory.speakers[0]!.provisioningId,
      expectedVersion: directory.speakers[0]!.provisioningVersion,
    });
    await updateSpeakerPublication(event.id, {
      eventId: event.id,
      speakerId: profile.id,
      expectedVersion: profile.version,
      visible: false,
    });
    expect(fetchMock.mock.calls.map(([url, init]) => [url, init?.method, JSON.parse(String(init?.body))])).toEqual([
      [
        `/api/v1/events/${event.id}/portal/speakers/${profile.id}/provision`,
        "POST",
        {
          provisioningId: directory.speakers[0]!.provisioningId,
          expectedVersion: directory.speakers[0]!.provisioningVersion,
        },
      ],
      [
        `/api/v1/events/${event.id}/portal/speakers/${profile.id}/publication`,
        "PUT",
        { expectedVersion: profile.version, visible: false },
      ],
    ]);
  });

  it("renders complete create, edit, and versioned delete controls for tasks and resources", () => {
    const taskMarkup = renderToStaticMarkup(createElement(OrganizerTasksContent, {
      tasks: [task],
      onCreate: noop,
      onUpdate: noop,
      onDelete: noop,
    }));
    expect(taskMarkup).toContain("Create task");
    expect(taskMarkup).toContain("Save changes");
    expect(taskMarkup).toContain("Delete task");
    expect(taskMarkup).toContain("Review speaker profile");

    const resourceMarkup = renderToStaticMarkup(createElement(OrganizerResourcesContent, {
      resources: [resource],
      onCreate: noop,
      onUpdate: noop,
      onDelete: noop,
    }));
    expect(resourceMarkup).toContain("Create resource");
    expect(resourceMarkup).toContain("Save changes");
    expect(resourceMarkup).toContain("Delete resource");
    expect(resourceMarkup).toContain("Speaker production guide");
  });

  it("uses versioned organizer task and resource request bodies", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => ok({}));
    vi.stubGlobal("fetch", fetchMock);
    const taskCreate = { eventId: event.id, name: task.name, description: task.description, kind: task.kind, formId: task.formId, dueAt: task.dueAt, order: task.order };
    await createTask(event.id, taskCreate);
    await updateTask(event.id, { ...taskCreate, taskId: task.id, expectedVersion: task.version });
    await deleteTask(event.id, { eventId: event.id, taskId: task.id, expectedVersion: task.version });
    const resourceCreate = { eventId: event.id, slug: resource.slug, title: resource.title, body: resource.body, embedUrl: resource.embedUrl, audience: resource.audience, order: resource.order };
    await createResource(event.id, resourceCreate);
    await updateResource(event.id, { ...resourceCreate, resourceId: resource.id, expectedVersion: resource.version });
    await deleteResource(event.id, { eventId: event.id, resourceId: resource.id, expectedVersion: resource.version });

    const calls = fetchMock.mock.calls;
    expect(calls.map(([url, init]) => [url, init?.method])).toEqual([
      [`/api/v1/events/${event.id}/portal/tasks`, "POST"],
      [`/api/v1/events/${event.id}/portal/tasks/${task.id}`, "PUT"],
      [`/api/v1/events/${event.id}/portal/tasks/${task.id}`, "DELETE"],
      [`/api/v1/events/${event.id}/portal/resources`, "POST"],
      [`/api/v1/events/${event.id}/portal/resources/${resource.id}`, "PUT"],
      [`/api/v1/events/${event.id}/portal/resources/${resource.id}`, "DELETE"],
    ]);
    expect(JSON.parse(String(calls[1]?.[1]?.body))).toMatchObject({ expectedVersion: task.version });
    expect(JSON.parse(String(calls[2]?.[1]?.body))).toEqual({ expectedVersion: task.version });
    expect(JSON.parse(String(calls[4]?.[1]?.body))).toMatchObject({ expectedVersion: resource.version });
    expect(JSON.parse(String(calls[5]?.[1]?.body))).toEqual({ expectedVersion: resource.version });
  });
});

describe("public embed privacy", () => {
  it("projects PublicSpeakerGallery through SpeakerGallery without private portal fields", () => {
    const markup = renderToStaticMarkup(createElement(PublicSpeakerEmbedContent, { gallery }));
    expect(markup).toContain("Production Summit speakers");
    expect(markup).toContain("River Okafor");
    expect(markup).not.toContain("userId");
    expect(markup).not.toContain("email");
    expect(markup).not.toContain("acceptanceEventId");
    expect(markup).not.toContain("provisioningStatus");
    expect(markup).not.toContain("task-profile");
    expect(markup).not.toContain("final-slides.pdf");
  });
});
