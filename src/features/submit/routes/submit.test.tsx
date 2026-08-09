import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server.edge";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import PublicSubmitPage, {
  fetchPublicSubmissionForm,
  layout,
  path as publicPath,
  postPublicSubmission,
  visibleFields,
} from "./public-submit";
import SubmissionsPage, { fetchSubmissionQueue, path as organizerPath } from "./submissions";
import type { PublicSubmissionForm, SubmissionPage } from "../schema";
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
    expect(markup).toContain("Submit proposal");
    expect(markup).not.toContain("AppShell");
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
      { "field-title": "Effect at the edge" },
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
          answers: [{ fieldId: "field-title", value: "Effect at the edge" }],
          turnstileToken: "test-turnstile-token",
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
    expect(markup).toContain("Apply");
    expect(markup).not.toContain("AppShell");
  });
});
