import { createElement, type ReactElement } from "react";
import { MemoryRouter } from "react-router";
import { renderToStaticMarkup } from "react-dom/server.edge";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/client/api";
import FormsPage, {
  createFormDraft,
  deleteFormDraft,
  fetchEventIdentity,
  fetchFormDetail,
  fetchFormSummaries,
  FormPresenceNotice,
  FormsWorkspace,
  path,
  publishFormDraft,
  setFormLifecycle,
  type EventIdentity,
  updateFormDraft,
} from "./forms";
import type { FormDetail, FormSummary } from "../schema";
import { FormPreview } from "../components/FormPreview";

afterEach(() => {
  vi.unstubAllGlobals();
});

const event: EventIdentity = { id: "event_ai_sandbox", name: "AI Engineer Sandbox", slug: "ai-engineer-sandbox" };

const formSummary: FormSummary = {
  id: "form_primary_cfp",
  eventId: event.id,
  purpose: "primary-cfp",
  name: "Call for proposals",
  description: null,
  status: "open",
  opensAt: null,
  closesAt: null,
  version: 3,
  publishedVersionNumber: 2,
  updatedAt: 1_754_000_000_000,
};

const formDetail: FormDetail = {
  id: "form_primary_cfp",
  eventId: event.id,
  purpose: "primary-cfp",
  name: "Call for proposals",
  description: "Tell us about your talk.",
  status: "open",
  opensAt: null,
  closesAt: null,
  version: 3,
  createdAt: 1_753_000_000_000,
  updatedAt: 1_754_000_000_000,
  fields: [
    {
      id: "field_track",
      order: 1,
      type: "radio",
      label: "Best-fit track",
      semanticKey: null,
      helpText: null,
      required: true,
      options: ["General"],
      logic: null,
      routing: { General: "general" },
      version: 2,
    },
    {
      id: "field_details",
      order: 2,
      type: "text",
      label: "Workshop details",
      semanticKey: null,
      helpText: null,
      required: false,
      options: [],
      logic: {
        action: "show",
        mode: "all",
        conditions: [
          { fieldId: "field_track", op: "eq", value: "General" },
          { fieldId: "field_track", op: "in", value: ["General"] },
        ],
      },
      routing: {},
      version: 1,
    },
  ],
  publishedVersion: null,
};

function renderRoute(children: ReactElement): string {
  return renderToStaticMarkup(
    createElement(MemoryRouter, { initialEntries: ["/e/ai-engineer-sandbox/forms"] }, children),
  );
}

describe("forms organizer route", () => {
  it("exports the forms navigation route", () => {
    expect(path).toBe("/e/:eventSlug/forms");
  });

  it("loads the event by slug, then forms and the selected form by authoritative id", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/v1/events/ai-engineer-sandbox") {
        return new Response(JSON.stringify(event), { status: 200 });
      }
      if (url === `/api/v1/events/${event.id}/forms`) {
        return new Response(JSON.stringify([formSummary]), { status: 200 });
      }
      if (url === `/api/v1/events/${event.id}/forms/${formSummary.id}`) {
        return new Response(JSON.stringify(formDetail), { status: 200 });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const loadedEvent = await fetchEventIdentity("ai-engineer-sandbox");
    expect(loadedEvent).toEqual(event);

    const summaries = await fetchFormSummaries(event.id);
    expect(summaries).toEqual([formSummary]);

    const detail = await fetchFormDetail(event.id, formSummary.id);
    expect(detail.fields[0]?.semanticKey).toBeNull();
    expect(detail).toEqual(formDetail);

    expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/v1/events/ai-engineer-sandbox", expect.objectContaining({ method: "GET" }));
    expect(fetchMock).toHaveBeenNthCalledWith(2, `/api/v1/events/${event.id}/forms`, expect.objectContaining({ method: "GET" }));
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      `/api/v1/events/${event.id}/forms/${formSummary.id}`,
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("maps a 401 event lookup to ApiError so the route can render sign-in", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ message: "You need to sign in" }), { status: 401 })));
    await expect(fetchEventIdentity("ai-engineer-sandbox")).rejects.toEqual(
      expect.objectContaining({ name: "ApiError", status: 401 }),
    );
  });

  it("rejects malformed successful forms responses before they reach the workspace", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input).endsWith("/forms")) {
          return new Response(JSON.stringify([{ id: formSummary.id }]), { status: 200 });
        }
        return new Response(JSON.stringify({ id: formDetail.id }), { status: 200 });
      }),
    );

    await expect(fetchFormSummaries(event.id)).rejects.toThrow();
    await expect(fetchFormDetail(event.id, formDetail.id)).rejects.toThrow();
  });

  it("treats forms-list and detail 401s after event resolution as an unauthenticated route", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input) === "/api/v1/events/ai-engineer-sandbox") {
          return new Response(JSON.stringify(event), { status: 200 });
        }
        return new Response(JSON.stringify({ message: "You need to sign in" }), { status: 401 });
      }),
    );

    await expect(fetchEventIdentity(event.slug)).resolves.toEqual(event);
    await expect(fetchFormSummaries(event.id)).rejects.toEqual(expect.objectContaining({ status: 401 }));
    await expect(fetchFormDetail(event.id, formDetail.id)).rejects.toEqual(expect.objectContaining({ status: 401 }));

    const markup = renderRoute(createElement(FormsPage, { initialEvent: null, initialEventError: "unauthenticated" }));
    expect(markup).toContain("Sign in to view this event");
    expect(markup).toContain("Sign in");
    expect(markup).not.toContain("Retry");
  });

  it("maps a 404 event lookup to ApiError distinctly from unauthenticated", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ message: "Not found" }), { status: 404 })));
    const error = await fetchEventIdentity("missing-event").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(404);
  });

  it("renders a sign-in CTA for a signed-out request without any fixture or admin controls", () => {
    const markup = renderRoute(createElement(FormsPage, { initialEvent: null, initialEventError: "unauthenticated" }));
    expect(markup).toContain("Sign in to view this event");
    expect(markup).toContain("Sign in");
    expect(markup).not.toContain("Deterministic view");
    expect(markup).not.toContain("Save draft");
    expect(markup).not.toContain("Publish form");
    expect(markup).not.toContain("New additional form");
  });

  it("renders event-not-found distinctly from a recoverable load error", () => {
    const notFound = renderRoute(createElement(FormsPage, { initialEvent: null, initialEventError: null }));
    expect(notFound).toContain("Event not found");
    expect(notFound).not.toContain("Try again");

    const recoverable = renderRoute(createElement(FormsPage, { initialEvent: null, initialEventError: "Network unreachable" }));
    expect(recoverable).toContain("Could not load event");
    expect(recoverable).toContain("Try again");
  });

  it("renders authoritative loader data with an enabled organizer builder", () => {
    const markup = renderToStaticMarkup(
      createElement(FormsWorkspace, {
        event,
        initialSummaries: [formSummary],
        initialSelectedId: formSummary.id,
        initialSelectedForm: formDetail,
      }),
    );
    expect(markup).toContain("Call for proposals");
    expect(markup).toContain("Best-fit track");
    expect(markup).toContain("Use this answer as");
    expect(markup).toContain("Submission title");
    expect(markup).toContain("Assign proposal title, proposal abstract, and speaker name once each before publishing.");
    expect(markup).not.toContain("Submission/review meaning");
    expect(markup).not.toContain("File upload (unavailable)");
    expect(markup).toMatch(/<select[^>]*id="builder-field-field_details-condition-0-value"/);
    expect(markup).toMatch(/<select[^>]*multiple=""[^>]*id="builder-field-field_details-condition-1-value"/);
    expect(markup).toContain("Choose an answer");
    expect(markup).toContain("Select one or more answers.");
    expect(markup).not.toContain("Deterministic view");
    expect(markup).not.toContain("formsFixtures");
    expect(markup).not.toContain("read-only");
    expect(markup).toContain("Save draft");
    expect(markup).toContain("Publish form");
    expect(markup).toContain("Review category");
    expect(markup).toContain("existing submissions keep their original category");
    expect(markup).not.toContain("Internal category key");
    expect(markup).toContain("Close form");
    expect(markup).not.toContain("Delete draft");
    expect(markup).toContain("[&amp;&gt;header]:bg-[#ece8dc]");
    expect(markup).toContain("bg-[#896aff] p-5 text-[#171714]");
    expect(markup).not.toContain("[&amp;&gt;header]:bg-[#caff4a]");
    expect(markup).not.toContain("[&amp;&gt;header]:bg-[#8fdcff]");
    expect(markup).not.toContain("[&amp;&gt;header]:bg-[#ff714f]");
  });

  it("shows presence only for people viewing the selected form", () => {
    const markup = renderToStaticMarkup(createElement(FormPresenceNotice, {
      formId: formDetail.id,
      users: [
        { userId: "user-jamie", name: "Jamie", surface: `forms:${formDetail.id}` },
        { userId: "user-pat", name: "Pat", surface: "agenda" },
      ],
    }));

    expect(markup).toContain("1 person viewing this form");
    expect(markup).toContain("Jamie is here now");
    expect(markup).toContain("changes are not merged live");
    expect(markup).not.toContain("Pat");
  });

  it("marks legacy file fields unavailable instead of previewing a working upload", () => {
    const fileForm: FormDetail = {
      ...formDetail,
      fields: [{
        ...formDetail.fields[0]!,
        type: "file",
        label: "Upload a sample",
        options: [],
        routing: {},
      }],
    };
    const markup = renderToStaticMarkup(
      createElement(FormsWorkspace, {
        event,
        initialSummaries: [formSummary],
        initialSelectedId: formSummary.id,
        initialSelectedForm: fileForm,
      }),
    );

    expect(markup).toContain("File upload (unavailable)");
    expect(markup).toContain("File uploads are unavailable on public forms");
    expect(markup).not.toContain('type="file"');
  });

  it("renders editable draft content in the live preview instead of the last published snapshot", () => {
    const markup = renderToStaticMarkup(
      createElement(FormPreview, {
        form: {
          ...formDetail,
          name: "Edited draft name",
          description: "Edited draft description",
          fields: [{ ...formDetail.fields[0]!, label: "Edited draft field" }],
          publishedVersion: {
            id: "form_version_2",
            versionNumber: 2,
            name: "Published name",
            description: "Published description",
            publishedAt: 1_753_500_000_000,
            retiredAt: null,
            fields: [{
              id: "form_version_field_track",
              sourceFieldId: formDetail.fields[0]!.id,
              order: 1,
              type: "radio",
              label: "Published field",
              semanticKey: null,
              helpText: null,
              required: true,
              options: ["General"],
              logic: null,
              routing: { General: "general" },
            }],
          },
        },
        now: 1_754_000_000_000,
      }),
    );

    expect(markup).toContain("Edited draft name");
    expect(markup).toContain("Edited draft description");
    expect(markup).toContain("Edited draft field");
    expect(markup).not.toContain("Published name");
    expect(markup).not.toContain("Published description");
    expect(markup).not.toContain("Published field");
  });

  it("offers deletion only for an unpublished additional-form draft", () => {
    const additional = {
      ...formDetail,
      id: "form-speaker-logistics",
      purpose: "additional" as const,
      name: "Speaker logistics",
      status: "draft" as const,
      publishedVersion: null,
    };
    const markup = renderToStaticMarkup(
      createElement(FormsWorkspace, {
        event,
        initialSummaries: [
          formSummary,
          {
            ...formSummary,
            id: additional.id,
            purpose: "additional",
            name: additional.name,
            status: "draft",
            publishedVersionNumber: null,
          },
        ],
        initialSelectedId: additional.id,
        initialSelectedForm: additional,
      }),
    );

    expect(markup).toContain("New additional form");
    expect(markup).toContain("Delete draft");
  });

  it("renders a zero-form create path for the primary CFP", () => {
    const markup = renderToStaticMarkup(
      createElement(FormsWorkspace, { event, initialSummaries: [], initialSelectedId: null, initialSelectedForm: null }),
    );
    expect(markup).toContain("No forms yet");
    expect(markup).toContain("Create primary CFP");
    expect(markup).toContain("start collecting routed proposals");
    expect(markup).not.toContain("read-only");
  });

  it("renders an explicit error state distinct from empty when the forms list fails to load", () => {
    const markup = renderToStaticMarkup(createElement(FormsWorkspace, { event, initialSummaries: null }));
    expect(markup).toContain("Forms could not be loaded");
    expect(markup).toContain("Retry");
  });
});

describe("forms organizer mutations", () => {
  it("sends the registered create, update, publish, and lifecycle requests with command metadata", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/forms") && init?.method === "POST") {
        return new Response(JSON.stringify({ ...formDetail, status: "draft", version: 1 }), { status: 201 });
      }
      if (url === `/api/v1/events/${event.id}/forms/${formDetail.id}` && init?.method === "PUT") {
        return new Response(JSON.stringify({ ...formDetail, version: 4 }), { status: 200 });
      }
      if (url.endsWith("/publish")) {
        return new Response(JSON.stringify({ ...formDetail, version: 5 }), { status: 200 });
      }
      if (url.endsWith("/status")) {
        return new Response(JSON.stringify({ ...formDetail, status: "closed", version: 6 }), { status: 200 });
      }
      if (url === `/api/v1/events/${event.id}/forms/${formDetail.id}` && init?.method === "DELETE") {
        return new Response(JSON.stringify({ formId: formDetail.id, deleted: true, idempotent: false }), { status: 200 });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await createFormDraft(event.id, "primary-cfp", "forms-create-test-001");
    await updateFormDraft(event.id, formDetail, "forms-update-test-001");
    await publishFormDraft(event.id, formDetail.id, 4, "forms-publish-test-001");
    await setFormLifecycle(event.id, formDetail.id, 5, "closed", "forms-close-test-001");
    await deleteFormDraft(event.id, formDetail.id, 3, "forms-delete-test-001");

    const create = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(fetchMock.mock.calls[0]![0]).toBe(`/api/v1/events/${event.id}/forms`);
    expect(create).toMatchObject({
      method: "POST",
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": "forms-create-test-001",
      },
    });
    const createBody = JSON.parse(String(create.body));
    expect(createBody).toMatchObject({
      purpose: "primary-cfp",
      name: "Call for proposals",
      opensAt: null,
      closesAt: null,
    });
    expect(createBody.fields).toHaveLength(5);
    expect(createBody.fields.map((field: { semanticKey: string | null }) => field.semanticKey)).toEqual([
      "submissionTitle",
      "submissionAbstract",
      "speakerName",
      "speakerEmail",
      null,
    ]);
    expect(createBody.fields[4]).toMatchObject({
      type: "radio",
      options: ["General"],
      routing: { General: "general" },
    });

    const update = fetchMock.mock.calls[1]![1] as RequestInit;
    expect(fetchMock.mock.calls[1]![0]).toBe(`/api/v1/events/${event.id}/forms/${formDetail.id}`);
    expect(update).toMatchObject({
      method: "PUT",
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": "forms-update-test-001",
        "If-Match": "3",
      },
    });
    const updateBody = JSON.parse(String(update.body));
    expect(updateBody.fields[0]).toMatchObject({ id: "field_track", label: "Best-fit track" });
    expect(updateBody.fields[0]).not.toHaveProperty("order");
    expect(updateBody.fields[0]).not.toHaveProperty("version");

    const publish = fetchMock.mock.calls[2]![1] as RequestInit;
    expect(fetchMock.mock.calls[2]![0]).toBe(
      `/api/v1/events/${event.id}/forms/${formDetail.id}/publish`,
    );
    expect(publish).toMatchObject({
      method: "POST",
      credentials: "include",
      headers: {
        "Idempotency-Key": "forms-publish-test-001",
        "If-Match": "4",
      },
    });
    expect(publish).not.toHaveProperty("body");

    const status = fetchMock.mock.calls[3]![1] as RequestInit;
    expect(fetchMock.mock.calls[3]![0]).toBe(
      `/api/v1/events/${event.id}/forms/${formDetail.id}/status`,
    );
    expect(status).toMatchObject({
      method: "POST",
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": "forms-close-test-001",
        "If-Match": "5",
      },
    });
    expect(JSON.parse(String(status.body))).toEqual({ status: "closed" });

    const deleted = fetchMock.mock.calls[4]![1] as RequestInit;
    expect(fetchMock.mock.calls[4]![0]).toBe(`/api/v1/events/${event.id}/forms/${formDetail.id}`);
    expect(deleted).toMatchObject({
      method: "DELETE",
      credentials: "include",
      headers: {
        "Idempotency-Key": "forms-delete-test-001",
        "If-Match": "3",
      },
    });
    expect(deleted).not.toHaveProperty("body");
  });

  it("uses an organizer-provided name when creating an additional form", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({
      ...formDetail,
      id: "form-speaker-logistics",
      purpose: "additional",
      name: "Speaker logistics",
      description: "Travel and accessibility details",
      status: "draft",
      version: 1,
    }), { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);

    await createFormDraft(event.id, "additional", "forms-create-additional-001", {
      name: "Speaker logistics",
      description: "Travel and accessibility details",
    });

    const request = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(JSON.parse(String(request.body))).toMatchObject({
      purpose: "additional",
      name: "Speaker logistics",
      description: "Travel and accessibility details",
    });
  });

  it("surfaces a failed mutation as an ApiError with the server message", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      JSON.stringify({ message: "Expected form version 3, found 4" }),
      { status: 409 },
    )));

    await expect(updateFormDraft(event.id, formDetail, "forms-conflict-test-001")).rejects.toEqual(
      expect.objectContaining({
        name: "ApiError",
        status: 409,
        message: "Expected form version 3, found 4",
      }),
    );
  });
});
