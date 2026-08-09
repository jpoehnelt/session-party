import { createElement, type ReactElement } from "react";
import { MemoryRouter } from "react-router";
import { renderToStaticMarkup } from "react-dom/server.edge";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/client/api";
import FormsPage, {
  fetchEventIdentity,
  fetchFormDetail,
  fetchFormSummaries,
  FormsWorkspace,
  path,
  type EventIdentity,
} from "./forms";
import type { FormDetail, FormSummary } from "../schema";

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
      helpText: null,
      required: true,
      options: ["General"],
      logic: null,
      routing: { General: "general" },
      version: 2,
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

  it("renders authoritative loader data with no fixture selector and a disabled builder", () => {
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
    expect(markup).not.toContain("Deterministic view");
    expect(markup).not.toContain("formsFixtures");
    expect(markup).toContain("read-only");
    expect(markup).toMatch(/<button[^>]*disabled/);
  });

  it("renders an explicit empty state when the event has no forms yet", () => {
    const markup = renderToStaticMarkup(
      createElement(FormsWorkspace, { event, initialSummaries: [], initialSelectedId: null, initialSelectedForm: null }),
    );
    expect(markup).toContain("No forms yet");
    expect(markup).not.toContain("Create primary CFP");
  });

  it("renders an explicit error state distinct from empty when the forms list fails to load", () => {
    const markup = renderToStaticMarkup(createElement(FormsWorkspace, { event, initialSummaries: null }));
    expect(markup).toContain("Forms could not be loaded");
    expect(markup).toContain("Retry");
  });
});
