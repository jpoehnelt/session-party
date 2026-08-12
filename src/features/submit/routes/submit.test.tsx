import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server.edge";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import PublicSubmitPage, {
  fetchPublicSubmissionForm,
  layout,
  path as publicPath,
  postPublicSubmission,
  draftStorageKey,
  requiredAnswerErrors,
  restoreDraftAnswers,
  visibleFields,
} from "./public-submit";
import MySubmissionsPage, { path as mySubmissionsPath } from "./my-submissions";
import SubmissionsPage, { fetchSubmissionQueue, path as organizerPath } from "./submissions";
import type { OwnSubmissions, PublicSubmissionForm, SubmissionPage } from "../schema";
afterEach(() => {
  vi.unstubAllGlobals();
});


const publicForm: PublicSubmissionForm = {
  event: {
    name: "Architecture Summit",
    slug: "architecture-summit",
    description: "A calm public submission experience.",
    timezone: "UTC",
    startsAt: null,
    endsAt: null,
    location: null,
    accentColor: null,
  },
  form: {
    id: "form-public",
    versionId: "form-public-v1",
    versionNumber: 1,
    name: "Call for proposals",
    description: "Share a practical session.",
    availability: "open",
    opensAt: null,
    closesAt: null,
    fields: [
      {
        id: "field-title",
        order: 1,
        type: "text",
        label: "Proposal title",
        helpText: null,
        required: true,
        options: [],
        logic: null,
      },
      {
        id: "field-format",
        order: 2,
        type: "select",
        label: "Session format",
        helpText: null,
        required: true,
        options: ["Talk", "Workshop"],
        logic: null,
      },
    ],
  },
  turnstileSiteKey: "1x00000000000000000000AA",
};

const organizerPage: SubmissionPage = {
  results: [
    {
      id: "submission-public",
      formId: "form-public",
      formName: "Call for proposals",
      title: "Effect at the edge",
      category: "architecture",
      status: "in_review",
      primarySpeakerName: "Sam Rivera",
      submittedAt: Date.UTC(2026, 7, 8, 12),
      version: 2,
    },
  ],
  categories: ["architecture", "community"],
  pagination: { page: 1, pageSize: 25, total: 1, pageCount: 1 },
};

function renderRoute(pathname: string, child: ReactElement): string {
  return renderToStaticMarkup(createElement(MemoryRouter, { initialEntries: [pathname] }, child));
}

describe("public submit route", () => {
  it("uses the bare public route and renders the immutable published form", () => {
    expect(publicPath).toBe("/submit/:eventSlug/:formId");
    expect(layout).toBe("bare");
    const markup = renderRoute(
      "/submit/architecture-summit/form-public",
      <PublicSubmitPage initialForm={publicForm} />,
    );
    expect(markup).toContain("Architecture Summit");
    expect(markup).toContain("Call for proposals");
    expect(markup).toContain("Proposal title");
    expect(markup).toContain("Session format");
    expect(markup).toContain("Submit proposal");
    expect(markup).toContain("Save draft");
    expect(markup).toContain("Speaker details");
    expect(markup).toContain("Accounts are not required");
    expect(markup).toContain("Add co-speaker");
    expect(markup).toContain("Demo verification");
    expect(markup).toContain("Verification is still checked by Cloudflare");
    expect(markup).not.toContain("AppShell");
  });

  it("names drafts by immutable form version and renders the deadline", () => {
    expect(draftStorageKey("architecture-summit", "form-public", "form-public-v1")).toBe(
      "session-party:cfp-draft:architecture-summit:form-public:form-public-v1",
    );
    const markup = renderRoute(
      "/submit/architecture-summit/form-public",
      <PublicSubmitPage initialForm={{
        ...publicForm,
        form: { ...publicForm.form, closesAt: Date.UTC(2026, 7, 31, 23, 59) },
      }} />,
    );
    expect(markup).toContain("Deadline");
    expect(markup).toContain("August 31, 2026");
  });

  it("restores a partially completed draft after the public form reloads", () => {
    const stored = JSON.stringify({
      "field-title": "A resilient draft",
      "field-from-another-version": "must not leak",
    });
    const restored = restoreDraftAnswers(stored, publicForm.form.fields);
    expect(restored).toEqual({ "field-title": "A resilient draft" });
    expect(draftStorageKey(
      publicForm.event.slug,
      publicForm.form.id,
      publicForm.form.versionId,
    )).toContain(publicForm.form.versionId);
  });

  it("reports visible required fields without treating hidden conditional fields as missing", () => {
    const fields: PublicSubmissionForm["form"]["fields"] = [
      ...publicForm.form.fields,
      {
        id: "field-workshop-plan",
        order: 3,
        type: "textarea",
        label: "Workshop plan",
        helpText: null,
        required: true,
        options: [],
        logic: {
          action: "show",
          mode: "all",
          conditions: [{ fieldId: "field-format", op: "eq", value: "Workshop" }],
        },
      },
    ];

    const talkAnswers = { "field-title": "A real proposal", "field-format": "Talk" };
    expect(requiredAnswerErrors(visibleFields(fields, talkAnswers), talkAnswers)).toEqual({});
    expect(requiredAnswerErrors(visibleFields(fields, {}), {})).toEqual({
      "field-title": "Proposal title is required.",
      "field-format": "Session format is required.",
    });
  });
  it("uses the frozen public REST read and create endpoints", async () => {
    const created = {
      submissionId: "submission-created",
      status: "submitted" as const,
      submittedAt: Date.UTC(2026, 7, 8, 12),
    };
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) =>
      new Response(JSON.stringify(init?.method === "POST" ? created : publicForm), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await fetchPublicSubmissionForm("architecture-summit", "form-public");
    await postPublicSubmission(
      "architecture-summit",
      "form-public",
      "submit-route-test-001",
      { "field-title": "Effect at the edge", "field-format": "Talk" },
      "test-turnstile-token",
    );

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "/api/v1/public/events/architecture-summit/forms/form-public",
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/v1/public/events/architecture-summit/forms/form-public/submissions",
      expect.objectContaining({
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": "submit-route-test-001",
        },
        body: JSON.stringify({
          answers: [
            { fieldId: "field-title", value: "Effect at the edge" },
            { fieldId: "field-format", value: "Talk" },
          ],
          turnstileToken: "test-turnstile-token",
        }),
      }),
    );
  });

  it("includes optional primary details and repeatable co-speakers in the public create payload", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      submissionId: "submission-created",
      status: "submitted",
      submittedAt: Date.UTC(2026, 7, 8, 12),
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await postPublicSubmission(
      "architecture-summit",
      "form-public",
      "submit-route-speakers-001",
      { "field-title": "Effect at the edge" },
      "test-turnstile-token",
      {
        primarySpeakerTitle: "Staff Engineer",
        primarySpeakerOrganization: "Open Systems",
        coSpeakers: [{ name: "Alex Chen", email: "alex@example.com", roleLabel: "Panel moderator", title: "Principal", organization: "Acme Labs" }],
      },
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/public/events/architecture-summit/forms/form-public/submissions",
      expect.objectContaining({
        body: JSON.stringify({
          answers: [{ fieldId: "field-title", value: "Effect at the edge" }],
          turnstileToken: "test-turnstile-token",
          primarySpeakerTitle: "Staff Engineer",
          primarySpeakerOrganization: "Open Systems",
          coSpeakers: [{ name: "Alex Chen", email: "alex@example.com", roleLabel: "Panel moderator", title: "Principal", organization: "Acme Labs" }],
        }),
      }),
    );
  });

  it("surfaces the CFP-only validation response from the public producer", async () => {
    const message = "Public submissions are only available for CFP forms.";
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({
        error: "Validation",
        message,
        requestId: "request-cfp-only",
      }), { status: 400 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(postPublicSubmission(
      "architecture-summit",
      "form-task",
      "submit-route-task-001",
      { "field-task": "Portal follow-up details" },
      "test-turnstile-token",
    )).rejects.toThrow(message);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/public/events/architecture-summit/forms/form-task/submissions",
      expect.objectContaining({ method: "POST" }),
    );
  });


  it("renders closed published content without an active submit control", () => {
    const markup = renderRoute(
      "/submit/architecture-summit/form-public",
      <PublicSubmitPage initialForm={{ ...publicForm, form: { ...publicForm.form, availability: "closed" } }} />,
    );
    expect(markup).toContain("Submissions are closed");
    expect(markup).toContain("Proposal title");
    expect(markup).not.toContain("Submit proposal");
  });

  it("exposes a durable success state with the real submission reference", () => {
    const markup = renderRoute(
      "/submit/architecture-summit/form-public",
      <PublicSubmitPage
        initialForm={publicForm}
        initialSuccess={{ submissionId: "submission-created", status: "submitted", submittedAt: Date.UTC(2026, 7, 8, 12) }}
      />,
    );
    expect(markup).toContain("Submission received");
    expect(markup).toContain("submission-created");
    expect(markup).not.toContain("Submit proposal");
  });

  it("hides checkbox-dependent fields until the box is actually checked", () => {
    const fields: PublicSubmissionForm["form"]["fields"] = [
      {
        id: "field-consent",
        order: 1,
        type: "checkbox",
        label: "Needs follow-up",
        helpText: null,
        required: false,
        options: [],
        logic: null,
      },
      {
        id: "field-details",
        order: 2,
        type: "textarea",
        label: "Follow-up details",
        helpText: null,
        required: true,
        options: [],
        logic: {
          action: "show",
          mode: "all",
          conditions: [{ fieldId: "field-consent", op: "not_empty" }],
        },
      },
    ];

    expect(visibleFields(fields, { "field-consent": "false" }).map((field) => field.id)).toEqual(["field-consent"]);
    expect(visibleFields(fields, { "field-consent": "true" }).map((field) => field.id)).toEqual([
      "field-consent",
      "field-details",
    ]);
    expect(visibleFields(fields, {}).map((field) => field.id)).toEqual(["field-consent"]);
  });
});

describe("speaker submission dashboard route", () => {
  const ownSubmissions: OwnSubmissions = {
    event: { name: "Architecture Summit", slug: "architecture-summit" },
    submissions: [
      {
        id: "submission-editable",
        formId: "form-public",
        formName: "Call for proposals",
        title: "Effect at the edge",
        abstract: "A practical proposal.",
        category: "architecture",
        status: "in_review",
        submittedAt: Date.UTC(2026, 7, 8, 12),
        version: 2,
        editable: true,
      },
      {
        id: "submission-rejected",
        formId: "form-public",
        formName: "Call for proposals",
        title: "A second proposal",
        abstract: "Another proposal.",
        category: null,
        status: "rejected",
        submittedAt: Date.UTC(2026, 7, 7, 12),
        version: 3,
        editable: false,
      },
    ],
  };

  it("uses a dedicated speaker route with editable and decided proposal states", () => {
    expect(mySubmissionsPath).toBe("/portal/events/:eventSlug/submissions");
    const markup = renderRoute(
      "/portal/events/architecture-summit/submissions",
      <MySubmissionsPage initialData={ownSubmissions} />,
    );
    expect(markup).toContain("Your proposals");
    expect(markup).toContain("In review");
    expect(markup).toContain("Save proposal changes");
    expect(markup).toContain("Proposal not selected");
    expect(markup).toContain("The organizer decision is now reflected here.");
  });
});

describe("organizer submissions route", () => {
  it("keeps reviewer submissions when the owner-only forms list returns 403", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/v1/events/event-public/submissions?page=1&pageSize=25") {
        return new Response(JSON.stringify(organizerPage), { status: 200 });
      }
      if (url === "/api/v1/events/event-public/forms") {
        return new Response(JSON.stringify({ message: "Access denied" }), { status: 403 });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const loaded = await fetchSubmissionQueue("event-public", { page: 1 });

    expect(loaded.page).toEqual(organizerPage);
    expect(loaded.forms).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("renders real queue state and live filter controls without a nested shell", () => {
    expect(organizerPath).toBe("/e/:eventSlug/submissions");
    const markup = renderRoute(
      "/e/architecture-summit/submissions",
      <SubmissionsPage
        initialEvent={{ id: "event-public", name: "Architecture Summit", slug: "architecture-summit" }}
        initialPage={organizerPage}
        initialForms={[
          {
            id: "form-public",
            eventId: "event-public",
            purpose: "primary-cfp",
            name: "Call for proposals",
            description: null,
            status: "open",
            opensAt: null,
            closesAt: null,
            version: 1,
            publishedVersionNumber: 1,
            updatedAt: Date.UTC(2026, 7, 8, 12),
          },
        ]}
      />,
    );
    expect(markup).toContain("Effect at the edge");
    expect(markup).toContain("Sam Rivera");
    expect(markup).toContain("in review");
    expect(markup).toContain("Category");
    expect(markup).toContain("All categories");
    expect(markup).toContain("community");
    expect(markup).not.toContain("Exact routed category");
    expect(markup).not.toContain("AppShell");
  });
});
