import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server.edge";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/client/api";
import EventSettingsPage, {
  ApiAccessPanel,
  apiKeyPresets,
  buildEventPatch,
  createEventApiKey,
  EventSettingsForm,
  fetchEventMetadata,
  fetchEventApiKeys,
  formatDateTimeForTimezone,
  parseDateTimeInTimezone,
  path,
  revokeEventApiKey,
  updateEventMetadata,
} from "./event-settings";
import type { EventApiKey, EventOutput, UpdateEventInput } from "../schema";

const eventPayload = {
  id: "event_123",
  slug: "production-summit",
  name: "Production Summit",
  description: "Two days of production engineering.",
  location: "Portland, OR",
  timezone: "America/Los_Angeles",
  startsAt: "2026-09-14T16:00:00.000Z",
  endsAt: "2026-09-15T23:00:00.000Z",
  bannerAssetId: null,
  accentColor: "#2255aa",
  version: 4,
  createdAt: "2026-07-01T12:00:00.000Z",
  updatedAt: "2026-08-08T12:00:00.000Z",
};

const event: EventOutput = {
  ...eventPayload,
  startsAt: new Date(eventPayload.startsAt),
  endsAt: new Date(eventPayload.endsAt),
  createdAt: new Date(eventPayload.createdAt),
  updatedAt: new Date(eventPayload.updatedAt),
};

function renderRoute(children: ReactElement): string {
  return renderToStaticMarkup(
    createElement(MemoryRouter, { initialEntries: ["/e/production-summit/settings"] }, children),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("event metadata settings route", () => {
  it("exports the feature-discovered settings path", () => {
    expect(path).toBe("/e/:eventSlug/settings");
  });

  it("resolves the URL slug through events.get and decodes the canonical event", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(eventPayload), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchEventMetadata("production-summit")).resolves.toEqual(event);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/events/production-summit",
      expect.objectContaining({ method: "GET", credentials: "include" }),
    );
  });

  it("keeps 401 and 404 event resolution distinct and renders retry only for recoverable failures", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ message: "Sign in" }), { status: 401 })),
    );
    const unauthorized = await fetchEventMetadata(event.slug).catch((error: unknown) => error);
    expect(unauthorized).toBeInstanceOf(ApiError);
    expect((unauthorized as ApiError).status).toBe(401);

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ message: "Missing" }), { status: 404 })),
    );
    const missing = await fetchEventMetadata("missing").catch((error: unknown) => error);
    expect(missing).toBeInstanceOf(ApiError);
    expect((missing as ApiError).status).toBe(404);

    const signedOut = renderRoute(
      createElement(EventSettingsPage, { initialEvent: null, initialLoadError: { kind: "unauthenticated" } }),
    );
    expect(signedOut).toContain("Sign in to manage this event");
    expect(signedOut).not.toContain("Try again");

    const notFound = renderRoute(
      createElement(EventSettingsPage, { initialEvent: null, initialLoadError: { kind: "not-found" } }),
    );
    expect(notFound).toContain("Event not found");
    expect(notFound).not.toContain("Try again");

    const recoverable = renderRoute(
      createElement(EventSettingsPage, {
        initialEvent: null,
        initialLoadError: { kind: "failed", message: "Network unavailable" },
      }),
    );
    expect(recoverable).toContain("Could not load event settings");
    expect(recoverable).toContain("Network unavailable");
    expect(recoverable).toContain("Try again");
  });

  it("renders every persisted editable metadata field with populated canonical values", () => {
    const markup = renderToStaticMarkup(createElement(EventSettingsForm, { event }));

    expect(markup).toContain('value="Production Summit"');
    expect(markup).toContain('value="production-summit"');
    expect(markup).toContain("Two days of production engineering.");
    expect(markup).toContain('value="Portland, OR"');
    expect(markup).toContain('value="America/Los_Angeles"');
    expect(markup).toContain('type="datetime-local"');
    expect(markup).toContain('value="#2255aa"');
    expect(markup).not.toContain("Status");
    expect(markup).not.toContain("Team");
    expect(markup).not.toContain("Security");
  });

  it("round-trips wall time in the event timezone without using the browser timezone", () => {
    const instant = new Date("2026-01-15T17:45:12.345Z");
    const wallTime = formatDateTimeForTimezone(instant, "America/New_York");

    expect(wallTime).toBe("2026-01-15T12:45:12.345");
    expect(parseDateTimeInTimezone(wallTime, "America/New_York", "Start")).toBe(instant.getTime());

    const patch = buildEventPatch(
      {
        name: event.name,
        slug: event.slug,
        description: event.description ?? "",
        location: event.location ?? "",
        timezone: event.timezone,
        startsAt: formatDateTimeForTimezone(event.startsAt, event.timezone),
        endsAt: formatDateTimeForTimezone(event.endsAt, event.timezone),
        accentColor: event.accentColor ?? "",
      },
      event,
    );
    expect(patch.startsAt).toBe(event.startsAt?.getTime());
    expect(patch.endsAt).toBe(event.endsAt?.getTime());
  });

  it("sends only the documented events.update PATCH fields to the resolved event id", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(eventPayload), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const patch: UpdateEventInput = {
      name: "Production Summit",
      slug: "production-summit-2026",
      description: "Canonical description",
      location: null,
      timezone: "America/Los_Angeles",
      startsAt: 1_789_400_000_000,
      endsAt: 1_789_486_400_000,
      accentColor: "#114488",
    };

    await updateEventMetadata(event.id, patch);

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, request] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`/api/v1/events/${event.id}`);
    expect(request.method).toBe("PATCH");
    expect(JSON.parse(String(request.body))).toEqual(patch);
    expect(Object.keys(JSON.parse(String(request.body))).sort()).toEqual(
      ["accentColor", "description", "endsAt", "location", "name", "slug", "startsAt", "timezone"].sort(),
    );
  });

  it("decodes a successful update and renders the returned canonical state", async () => {
    const canonicalPayload = {
      ...eventPayload,
      slug: "production-summit-2026",
      name: "Production Summit 2026",
      description: null,
      location: "Convention Center",
      version: 5,
      updatedAt: "2026-08-08T13:00:00.000Z",
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(canonicalPayload), { status: 200 })),
    );

    const updated = await updateEventMetadata(event.id, {
      name: canonicalPayload.name,
      slug: canonicalPayload.slug,
    });
    const markup = renderToStaticMarkup(createElement(EventSettingsForm, { event: updated }));

    expect(updated.version).toBe(5);
    expect(updated.updatedAt).toEqual(new Date(canonicalPayload.updatedAt));
    expect(markup).toContain('value="Production Summit 2026"');
    expect(markup).toContain('value="production-summit-2026"');
    expect(markup).toContain('value="Convention Center"');
    expect(markup).not.toContain("Two days of production engineering.");
  });

  it("renders save failures as an accessible alert without clearing populated fields", () => {
    const markup = renderToStaticMarkup(
      createElement(EventSettingsForm, { event, initialSaveError: "The slug is already in use." }),
    );

    expect(markup).toContain('role="alert"');
    expect(markup).toContain("The slug is already in use.");
    expect(markup).toContain('value="Production Summit"');
    expect(markup).toContain("Save settings");
  });

  it("validates the editable contract before a save request", () => {
    expect(() =>
      buildEventPatch({
        name: "Production Summit",
        slug: "Not Valid",
        description: "",
        location: "",
        timezone: "America/Los_Angeles",
        startsAt: "",
        endsAt: "",
        accentColor: "",
      }),
    ).toThrow("Enter a name, a valid lowercase slug, and a timezone before saving.");
  });

  it("renders organizer-facing MCP discovery, least-privilege presets, and key management", () => {
    const key: EventApiKey = {
      id: "api_key_123", name: "Agenda automation", scopes: ["event:read", "agenda:read", "agenda:write"],
      expiresAt: new Date("2100-01-01T00:00:00.000Z"), revokedAt: null, version: 1,
      createdAt: new Date("2026-08-09T00:00:00.000Z"),
    };
    const markup = renderToStaticMarkup(createElement(ApiAccessPanel, { eventId: event.id, initialApiKeys: [key] }));

    expect(markup).toContain("MCP &amp; API access");
    expect(markup).toContain("speaker self-service stays in the browser portal");
    expect(markup).toContain("https://sessionparty.example/mcp");
    expect(markup).toContain("Read-only assistant");
    expect(markup).toContain("Agenda automation");
    expect(markup).toContain("Speaker onboarding");
    expect(markup).toContain("Full organizer automation");
    expect(markup).toContain("event:read");
    expect(markup).toContain("agenda:write");
    expect(markup).toContain("Revoke");
    expect(markup).not.toContain("spk_");
    expect(apiKeyPresets.read.scopes.every((scope) => scope.endsWith(":read"))).toBe(true);
  });

  it("uses browser-session REST endpoints for list, one-time creation, and revocation", async () => {
    const keyPayload = {
      id: "api_key_456", name: "Read access", scopes: ["event:read"],
      expiresAt: "2100-01-01T00:00:00.000Z", revokedAt: null, version: 1,
      createdAt: "2026-08-09T00:00:00.000Z",
    };
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "POST") return new Response(JSON.stringify({ apiKey: keyPayload, secret: `spk_${"a".repeat(64)}` }), { status: 201 });
      if (method === "DELETE") return new Response(JSON.stringify({ ...keyPayload, revokedAt: "2026-08-10T00:00:00.000Z", version: 2 }), { status: 200 });
      return new Response(JSON.stringify([keyPayload]), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const listed = await fetchEventApiKeys(event.id);
    const issued = await createEventApiKey(event.id, {
      name: "Read access", scopes: ["event:read"], expiresAt: Date.UTC(2100, 0, 1),
    });
    const revoked = await revokeEventApiKey(event.id, listed[0]!);

    expect(listed[0]?.expiresAt).toBeInstanceOf(Date);
    expect(issued.secret).toMatch(/^spk_/);
    expect(revoked.revokedAt).toBeInstanceOf(Date);
    expect(fetchMock).toHaveBeenNthCalledWith(1, `/api/v1/events/${event.id}/api-keys`, expect.objectContaining({ method: "GET", credentials: "include" }));
    expect(fetchMock).toHaveBeenNthCalledWith(2, `/api/v1/events/${event.id}/api-keys`, expect.objectContaining({ method: "POST", credentials: "include" }));
    const [, revokeRequest] = fetchMock.mock.calls[2] as unknown as [string, RequestInit];
    expect(JSON.parse(String(revokeRequest.body))).toEqual({ expectedVersion: 1 });
  });
});
