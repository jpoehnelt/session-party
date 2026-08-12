import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server.edge";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ClaimSpeakerOutput,
  ContentLibrary,
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
import type { FormSummary } from "@/features/forms/schema";
import {
  claimSpeakerAccount,
  createResource,
  createTask,
  deleteResource,
  deleteTask,
  getPublicSpeakerGallery,
  getOrganizerFormSummaries,
  getSpeakerDirectory,
  getSpeakerPortal,
  getSpeakerTaskForm,
  logSpeakerContact,
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
import { filterSpeakerDirectory, path as speakersPath, OrganizerSpeakersContent } from "./organizer-speakers";
import { path as tasksPath, OrganizerTasksContent } from "./organizer-tasks";
import { buildStoredZip, path as contentPath, OrganizerContentLibrary } from "./organizer-content";
import { layout as embedLayout, path as embedPath, PublicSpeakerEmbedContent } from "./public-speakers";
import {
  allowlistedEmbedUrl,
  fileAsBase64,
  layout as portalLayout,
  path as portalPath,
  PORTAL_UPLOAD_MAX_BYTES,
  SpeakerClaimPrompt,
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
  targetMode: "all",
  speakerIds: [],
};

const taskFormSummary: FormSummary = {
  id: "form-travel",
  eventId: event.id,
  purpose: "additional",
  name: "Travel details",
  description: null,
  status: "open",
  opensAt: null,
  closesAt: null,
  version: 2,
  publishedVersionNumber: 1,
  updatedAt: 1_784_000_000_000,
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
  headshotUrl: null,
  links: [{ label: "Website", url: "https://example.com/river" }],
  visible: true,
  contactEmail: "river@example.com",
  workflowStatus: "Invited",
  profileSourceId: null,
  profileSourceVersion: null,
  profileReviewStatus: "approved",
  profileReviewNote: null,
  profileSubmittedAt: null,
  profileReviewedAt: null,
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
  readiness: {
    tasksTotal: 1,
    tasksDone: 0,
    outstandingTaskIds: [task.id],
    nextTaskId: task.id,
    state: "not_started",
    missingItems: [{
      id: task.id,
      name: task.name,
      kind: task.kind,
      dueAt: task.dueAt,
      overdue: true,
      blocker: "Overdue: Review speaker profile",
      recommendedAction: "Complete the speaker profile",
    }],
    overdueCount: 1,
    clearestBlocker: "Overdue: Review speaker profile",
    recommendedNextAction: "Complete the speaker profile",
  },
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
    source: "accepted",
    acceptanceEventId: "acceptance-1",
    provisioningId: "provisioning-1",
    provisioningStatus: "pending",
    provisioningVersion: 2,
    provisionedAt: null,
    sessions: [],
    privateFields: [],
    readiness: snapshot.readiness,
    latestContact: null,
  }],
};

const contentLibrary: ContentLibrary = {
  event,
  assets: [{
    id: "asset-current",
    eventId: event.id,
    filename: "slides.pdf",
    contentType: "application/pdf",
    size: 4096,
    purpose: "slides",
    version: 2,
    speakerId: profile.id,
    speakerName: profile.displayName,
    speakerVersion: profile.version,
    sessionTitles: ["The calm show call"],
    sessionLinks: [{ id: "talk-calm-show-call", title: "The calm show call" }],
    versionCount: 2,
    current: true,
    supersedesAssetId: "asset-history",
    restoredFromAssetId: null,
    uploadedAt: 1_785_000_000_000,
    comments: [{ id: "comment-1", authorName: "Organizer", body: "Please add sources.", createdAt: 1_785_000_001_000 }],
  }, {
    id: "asset-history",
    eventId: event.id,
    filename: "slides-draft.pdf",
    contentType: "application/pdf",
    size: 2048,
    purpose: "slides",
    version: 1,
    speakerId: profile.id,
    speakerName: profile.displayName,
    speakerVersion: profile.version,
    sessionTitles: ["The calm show call"],
    sessionLinks: [{ id: "talk-calm-show-call", title: "The calm show call" }],
    versionCount: 2,
    current: false,
    supersedesAssetId: null,
    restoredFromAssetId: null,
    uploadedAt: 1_784_000_000_000,
    comments: [],
  }],
};

const dashboard: PortalDashboard = {
  event,
  speakers: directory.speakers,
  totals: { speakers: 1, ready: 0, needsAttention: 1, overdue: 1, tasksDone: 0, tasksTotal: 1 },
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
    expect(contentPath).toBe("/e/:eventSlug/content");
    expect(embedPath).toBe("/embed/:eventSlug/speakers");
    expect(embedLayout).toBe("bare");
  });
});

describe("portal API loading", () => {
  it("syncs the newest accepted speaker identity before loading the portal by slug", async () => {
    const claimed: ClaimSpeakerOutput = {
      eventId: event.id,
      speakerId: profile.id,
      acceptanceEventId: "acceptance-current",
      provisioningId: "provisioning-current",
      speakerVersion: 6,
      provisioningVersion: 3,
      provisioningStatus: "provisioned",
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === `/api/v1/events/${event.slug}/portal/claim` && init?.method === "POST") return ok(claimed);
      if (url === `/api/v1/events/${event.slug}/portal` && init?.method === "GET") return ok(snapshot);
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(getSpeakerPortal(event.slug)).resolves.toEqual(snapshot);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenNthCalledWith(1, `/api/v1/events/${event.slug}/portal/claim`, expect.objectContaining({
      method: "POST",
      credentials: "include",
    }));
    expect(fetchMock).toHaveBeenCalledWith(`/api/v1/events/${event.slug}/portal`, expect.objectContaining({ method: "GET", credentials: "include" }));
  });

  it("claims speaker access through the browser-session slug endpoint", async () => {
    const claimed: ClaimSpeakerOutput = {
      eventId: event.id,
      speakerId: profile.id,
      acceptanceEventId: "acceptance-1",
      provisioningId: "provisioning-1",
      speakerVersion: 6,
      provisioningVersion: 3,
      provisioningStatus: "claimed",
    };
    const fetchMock = vi.fn(async () => ok(claimed));
    vi.stubGlobal("fetch", fetchMock);
    await expect(claimSpeakerAccount(event.slug, {
      eventId: event.id,
      idempotencyKey: "claim-browser-session",
    })).resolves.toEqual(claimed);
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/v1/events/${event.slug}/portal/claim`,
      expect.objectContaining({
        method: "POST",
        credentials: "include",
        body: JSON.stringify({ idempotencyKey: "claim-browser-session" }),
      }),
    );
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

  it("loads organizer form summaries for task selection", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === `/api/v1/events/${event.slug}`) return ok({ id: event.id });
      if (url === `/api/v1/events/${event.id}/forms`) return ok([taskFormSummary]);
      throw new Error(`Unexpected URL: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(getOrganizerFormSummaries(event.slug)).resolves.toEqual([taskFormSummary]);
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/v1/events/${event.id}/forms`,
      expect.objectContaining({ method: "GET", credentials: "include" }),
    );
  });

  it("decodes only the public gallery endpoint for embeds", async () => {
    const fetchMock = vi.fn(async () => ok(gallery));
    vi.stubGlobal("fetch", fetchMock);
    await expect(getPublicSpeakerGallery(event.slug)).resolves.toEqual(gallery);
    expect(fetchMock).toHaveBeenCalledWith(`/api/v1/public/events/${event.slug}/speakers`, expect.objectContaining({ method: "GET" }));
  });

  it("posts explicit organizer contact evidence without a draft endpoint", async () => {
    const fetchMock = vi.fn(async () => ok({ id: "contact-1", medium: "phone", note: null, contactedAt: 1 }));
    vi.stubGlobal("fetch", fetchMock);
    await logSpeakerContact(event.id, {
      eventId: event.id,
      speakerId: profile.id,
      medium: "phone",
      note: null,
      idempotencyKey: "explicit-contact-only",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/v1/events/${event.id}/portal/speakers/${profile.id}/contacts`,
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ medium: "phone", note: null, idempotencyKey: "explicit-contact-only" }),
      }),
    );
  });

  it("loads linked fields publicly but submits answers through the speaker-session endpoint", async () => {
    const created = {
      submissionId: "submission-travel",
      status: "submitted" as const,
      submittedAt: Date.UTC(2026, 7, 9, 12),
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === `/api/v1/events/${event.id}/portal/forms/${formTask.formId}`) return ok(linkedForm);
      if (url === `/api/v1/events/${event.id}/portal/forms/${formTask.formId}/submissions`) return ok(created, 201);
      throw new Error(`Unexpected request: ${url} ${init?.method ?? "GET"}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(getSpeakerTaskForm(event.id, formTask.formId!)).resolves.toEqual(linkedForm);
    await expect(submitSpeakerTaskForm({
      eventId: event.id,
      formId: formTask.formId!,
      idempotencyKey: "task-form-route-submit",
      answers: [{ fieldId: "field-arrival", value: "Tuesday afternoon" }],
    })).resolves.toEqual(created);

    expect(fetchMock.mock.calls[0]).toEqual([
      `/api/v1/events/${event.id}/portal/forms/${formTask.formId}`,
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
  it("offers secure claim and post-claim retry states", () => {
    const unlinked = renderToStaticMarkup(createElement(SpeakerClaimPrompt, {
      claim: null,
      busy: false,
      error: null,
      onClaim: noop,
      onRetry: noop,
    }));
    expect(unlinked).toContain("Claim your speaker access");
    expect(unlinked).toContain("Claim speaker access");

    const linked = renderToStaticMarkup(createElement(SpeakerClaimPrompt, {
      claim: {
        eventId: event.id,
        speakerId: profile.id,
        acceptanceEventId: "acceptance-1",
        provisioningId: "provisioning-1",
        speakerVersion: 6,
        provisioningVersion: 3,
        provisioningStatus: "claimed",
      },
      busy: false,
      error: null,
      onClaim: noop,
      onRetry: noop,
    }));
    expect(linked).toContain("Speaker account linked");
    expect(linked).toContain("Open portal workspace");
    expect(linked).toContain("linked and provisioned");
    expect(linked).not.toContain("speaker@example.com");
  });

  it("renders profile editing, accepted submission, one task checklist, files, and resources", () => {
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
    expect(markup).not.toContain("Production thread");
    expect(markup.match(/Review speaker profile/g)).toHaveLength(1);
    expect(markup).toContain("final-slides.pdf");
    expect(markup).toContain("Speaker production guide");
    expect(markup).toContain("sandbox=");
    expect(markup).toContain("Save profile");
    expect(markup).toContain('<fieldset class="space-y-5">');
    expect(markup).toContain("headshots up to 10 MiB, slides up to 100 MiB, and documents up to 25 MiB");
  });

  it("offers an explicit checklist-task selector when multiple upload requests share a purpose", () => {
    const uploadTask = {
      ...snapshot.tasks[0]!,
      id: "task-slides-final",
      name: "Upload Session Presentation",
      kind: "upload" as const,
      description: "Upload slides as PDF or 16:9 deck.",
      prerequisite: { satisfied: true, message: null },
    };
    const markup = renderToStaticMarkup(createElement(SpeakerPortalContent, {
      snapshot: {
        ...snapshot,
        tasks: [uploadTask, { ...uploadTask, id: "task-slides-revised", name: "Upload revised presentation" }],
      },
      onSaveProfile: noop,
      onToggleTask: noop,
      onUpload: noop,
      onSubmitTaskForm: succeeds,
    }));

    expect(markup).toContain("Checklist task");
    expect(markup).toContain("Choose the request this file completes");
    expect(markup).toContain("Upload Session Presentation");
    expect(markup).toContain("Upload revised presentation");
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
        missingItems: [{
          id: formTask.id,
          name: formTask.name,
          kind: formTask.kind,
          dueAt: formTask.dueAt,
          overdue: true,
          blocker: "Overdue: Travel details",
          recommendedAction: "Submit Travel details",
        }],
        overdueCount: 1,
        clearestBlocker: "Overdue: Travel details",
        recommendedNextAction: "Submit Travel details",
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
      eventId: event.id,
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
  it("applies purpose-specific upload limits before reading or encoding files", async () => {
    const arrayBuffer = vi.fn();
    const file = {
      size: PORTAL_UPLOAD_MAX_BYTES.headshot + 1,
      arrayBuffer,
    } as unknown as File;
    await expect(fileAsBase64(file, "headshot")).rejects.toThrow(
      "File exceeds 10 MiB for headshot",
    );
    expect(arrayBuffer).not.toHaveBeenCalled();
    const slide = {
      size: PORTAL_UPLOAD_MAX_BYTES.headshot + 1,
      arrayBuffer: vi.fn().mockResolvedValue(new Uint8Array([65]).buffer),
    } as unknown as File;
    await expect(fileAsBase64(slide, "slides")).resolves.toBe("QQ==");
  });

});

describe("organizer content and workflows", () => {
  it("renders a dense speaker directory and readiness matrix from returned state", () => {
    const speakersMarkup = renderToStaticMarkup(createElement(MemoryRouter, null,
      createElement(OrganizerSpeakersContent, {
        directory,
        onProvision: noop,
        onVisibility: noop,
      }),
    ));
    expect(speakersMarkup).toContain("River Okafor");
    expect(speakersMarkup).toContain("The calm show call");
    expect(speakersMarkup).toContain("Public gallery");
    expect(speakersMarkup).toContain("0/1");
    expect(speakersMarkup).toContain('aria-label="Speaker readiness"');
    expect(speakersMarkup).toContain("Outstanding task 1");
    expect(speakersMarkup).toContain("Provision");
    expect(speakersMarkup).toContain("Search speakers");
    expect(speakersMarkup).toContain(`/e/${event.slug}/speakers/${profile.id}`);
    expect(speakersMarkup).toContain(`/e/${event.slug}/review?selectedSubmissionId=${snapshot.submission!.id}`);

    const dashboardMarkup = renderToStaticMarkup(createElement(OrganizerDashboardContent, { dashboard }));
    expect(dashboardMarkup).toContain("Speaker readiness");
    expect(dashboardMarkup).toContain("0 / 1");
    expect(dashboardMarkup).toContain("Needs attention only");
    expect(dashboardMarkup).toContain("Overdue: Review speaker profile");
    expect(dashboardMarkup).toContain("Complete the speaker profile");
    expect(dashboardMarkup).toContain("Last contact");
    expect(dashboardMarkup).toContain("Log contact");
    expect(dashboardMarkup).toContain(`/e/${event.slug}/speakers/${profile.id}`);
  });

  it("renders direct speaker creation, CSV import, workflow editing, messaging, and headshot controls", () => {
    const managedDirectory: SpeakerDirectory = {
      ...directory,
      speakers: [
        ...directory.speakers,
        {
          ...directory.speakers[0]!,
          speaker: {
            ...directory.speakers[0]!.speaker,
            id: "speaker-managed",
            displayName: "Dana Operations",
            contactEmail: "dana@example.com",
          },
          submission: null,
          source: "manual",
          acceptanceEventId: null,
          provisioningId: null,
          provisioningStatus: "manual",
          provisioningVersion: 0,
          provisionedAt: null,
        },
      ],
    };
    const markup = renderToStaticMarkup(createElement(MemoryRouter, null,
      createElement(OrganizerSpeakersContent, {
        directory: managedDirectory,
        onProvision: noop,
        onVisibility: noop,
        onCreate: () => true,
        onUpdate: noop,
        onImportCsv: noop,
        onMessage: noop,
        onUploadHeadshot: noop,
      }),
    ));
    expect(markup).toContain("Add speaker directly");
    expect(markup).toContain("CSV import");
    expect(markup).toContain("Workflow status");
    expect(markup).toContain("Send invites");
    expect(markup).toContain("Remind outstanding");
    expect(markup).toContain("Replace headshot");
    expect(markup).toContain("Edit profile");
    expect(markup).toContain("Profile details are managed by this accepted speaker in their portal.");
  });

  it("filters a large speaker directory by search text and operational state", () => {
    const readySpeaker = {
      ...directory.speakers[0]!,
      speaker: { ...directory.speakers[0]!.speaker, id: "speaker-ready", displayName: "Ada Ready", visible: false },
      provisioningStatus: "provisioned" as const,
      readiness: { ...directory.speakers[0]!.readiness, state: "ready" as const },
    };
    const speakers = [directory.speakers[0]!, readySpeaker];
    expect(filterSpeakerDirectory(speakers, "calm show", "all")).toHaveLength(2);
    expect(filterSpeakerDirectory(speakers, "ada", "all")).toEqual([readySpeaker]);
    expect(filterSpeakerDirectory(speakers, "", "needs_attention")).toEqual([directory.speakers[0]]);
    expect(filterSpeakerDirectory(speakers, "", "ready")).toEqual([readySpeaker]);
    expect(filterSpeakerDirectory(speakers, "", "unprovisioned")).toEqual([directory.speakers[0]]);
    expect(filterSpeakerDirectory(speakers, "", "hidden")).toEqual([readySpeaker]);
    expect(filterSpeakerDirectory(speakers, "", "all", "Invited")).toHaveLength(2);
    expect(filterSpeakerDirectory(speakers, "", "all", "Ready")).toHaveLength(0);
  });

  it("caps the rendered speaker table at 25 rows and exposes pagination", () => {
    const manySpeakers = Array.from({ length: 26 }, (_, index) => ({
      ...directory.speakers[0]!,
      speaker: {
        ...directory.speakers[0]!.speaker,
        id: `speaker-${index + 1}`,
        displayName: `Speaker ${index + 1}`,
      },
    }));
    const markup = renderToStaticMarkup(createElement(MemoryRouter, null,
      createElement(OrganizerSpeakersContent, {
        directory: { ...directory, speakers: manySpeakers },
        onProvision: noop,
        onVisibility: noop,
      }),
    ));
    expect(markup).toContain("Speaker 25");
    expect(markup).not.toContain("Speaker 26");
    expect(markup).toContain("1–25 of 26 matching speakers");
    expect(markup).toContain("Page 1 of 2");
  });

  it("uses provisioning concurrency separately from speaker publication concurrency", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => ok({}));
    vi.stubGlobal("fetch", fetchMock);
    await provisionSpeaker(event.id, {
      eventId: event.id,
      speakerId: profile.id,
      provisioningId: directory.speakers[0]!.provisioningId!,
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
      speakers: directory.speakers,
      eventSlug: event.slug,
      onCreate: noop,
      onUpdate: noop,
      onDelete: noop,
    }));
    expect(taskMarkup).toContain("Create task");
    expect(taskMarkup).toContain("Save changes");
    expect(taskMarkup).toContain("Delete task");
    expect(taskMarkup).toContain("Review speaker profile");
    expect(taskMarkup).not.toContain('name="formId"');
    expect(taskMarkup).toContain(`href="/e/${event.slug}/speakers/${profile.id}"`);
    expect(taskMarkup).toMatch(new RegExp(`href="/e/${event.slug}/speakers/${profile.id}"[^>]*>${profile.displayName}</a>`));
    expect(taskMarkup).toContain(`aria-label="Assign task to ${profile.displayName}"`);
    expect(taskMarkup).not.toContain(">Profile</a>");

    const formTaskMarkup = renderToStaticMarkup(createElement(OrganizerTasksContent, {
      tasks: [{ ...task, id: "task-form", kind: "form", formId: "form-travel", name: "Travel details" }],
      forms: [taskFormSummary],
      eventSlug: event.slug,
      onCreate: noop,
      onUpdate: noop,
      onDelete: noop,
    }));
    expect(formTaskMarkup).toMatch(/<select[^>]*required=""[^>]*name="formId"|<select[^>]*name="formId"[^>]*required=""/);
    expect(formTaskMarkup).toContain("Travel details · open");
    expect(formTaskMarkup).toContain(`/e/${event.slug}/forms?formId=form-travel`);
    expect(formTaskMarkup).toContain("Open form");

    const unavailableFormTaskMarkup = renderToStaticMarkup(createElement(OrganizerTasksContent, {
      tasks: [{ ...task, id: "task-form-missing", kind: "form", formId: "form-retired", name: "Retired form task" }],
      forms: [taskFormSummary],
      eventSlug: event.slug,
      onCreate: noop,
      onUpdate: noop,
      onDelete: noop,
    }));
    expect(unavailableFormTaskMarkup).toContain("Unavailable form · form-retired");
    expect(unavailableFormTaskMarkup).toContain("formId=form-retired");

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

  it("renders content metadata, selection controls, history, comments, and a ZIP affordance", () => {
    const markup = renderToStaticMarkup(createElement(OrganizerContentLibrary, {
      library: contentLibrary,
      onComment: noop,
      onRestore: noop,
      onDownload: noop,
      onDownloadZip: noop,
    }));
    expect(markup).toContain("Speaker content");
    expect(markup).toContain("River Okafor");
    expect(markup).toContain("slides.pdf");
    expect(markup).toContain("application/pdf");
    expect(markup).toContain("The calm show call");
    expect(markup).toContain(`/e/${event.slug}/agenda?talk=talk-calm-show-call`);
    expect(markup).toContain("v2 of 2");
    expect(markup).toContain(new Date(contentLibrary.assets[0]!.uploadedAt).toLocaleString());
    expect(markup).toContain("Please add sources.");
    expect(markup).toContain("Download selected ZIP");
    expect(markup).toContain("Select current results");
    expect(markup).toContain("Select slides.pdf");
    expect(markup).toContain("All history");
  });

  it("builds standards-compliant stored ZIP archives", () => {
    const archive = buildStoredZip([
      { name: "one.txt", bytes: new TextEncoder().encode("one") },
      { name: "two.txt", bytes: new TextEncoder().encode("two") },
    ]);
    expect([...archive.slice(0, 4)]).toEqual([0x50, 0x4b, 0x03, 0x04]);
    expect([...archive.slice(-22, -18)]).toEqual([0x50, 0x4b, 0x05, 0x06]);
    expect(new TextDecoder().decode(archive)).toContain("one.txt");
    expect(new TextDecoder().decode(archive)).toContain("two.txt");
  });

  it("uses versioned organizer task and resource request bodies", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => ok({}));
    vi.stubGlobal("fetch", fetchMock);
    const taskCreate = { eventId: event.id, name: task.name, description: task.description, kind: task.kind, formId: task.formId, dueAt: task.dueAt, order: task.order, speakerIds: [] };
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
  it("projects the public speaker lineup without private portal fields", () => {
    const markup = renderToStaticMarkup(createElement(PublicSpeakerEmbedContent, {
      gallery,
      design: { aesthetic: "minimal", accent: "#0057B8" },
    }));
    expect(markup).toContain("Production Summit speakers");
    expect(markup).toContain("River Okafor");
    expect(markup).toContain('data-embed-aesthetic="minimal"');
    expect(markup).toContain("--color-accent:#0057B8");
    expect(markup).not.toContain("userId");
    expect(markup).not.toContain("email");
    expect(markup).not.toContain("acceptanceEventId");
    expect(markup).not.toContain("provisioningStatus");
    expect(markup).not.toContain("task-profile");
    expect(markup).not.toContain("final-slides.pdf");
  });
});
