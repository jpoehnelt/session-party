import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server.edge";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/client/api";
import type { PortalSnapshot } from "../schema";
import SpeakerPortalRoute, { loadSpeakerPortal, path, portalLoadError } from "./speaker-portal";

const portal: PortalSnapshot = {
  event: {
    id: "event-1",
    slug: "systems-summit",
    name: "Practical Systems Summit",
    timezone: "America/Los_Angeles",
    startsAt: Date.UTC(2026, 8, 8, 16),
    endsAt: Date.UTC(2026, 8, 9, 23),
    location: "Oakland, CA",
  },
  profile: {
    id: "speaker-1",
    displayName: "Ada Rivera",
    title: "Staff Engineer",
    company: "Harbor Labs",
    bio: "Ada builds reliable systems.",
    links: [{ label: "Website", url: "https://ada.example.com" }],
    headshot: null,
    version: 3,
    pendingSyncFields: [],
  },
  submissions: [{
    id: "submission-1",
    title: "Effects without ceremony",
    category: "Architecture",
    acceptedAt: Date.UTC(2026, 7, 1),
    version: 2,
    coSpeakers: [
      { id: "speaker-1", displayName: "Ada Rivera", isPrimary: true },
      { id: "speaker-2", displayName: "Lin Okafor", isPrimary: false },
    ],
    talks: [{
      id: "talk-1",
      title: "Effects without ceremony",
      description: "A practical session.",
      trackName: "Systems",
      roomName: "Harbor stage",
      startsAt: Date.UTC(2026, 8, 8, 18),
      durationMin: 45,
      status: "confirmed",
      version: 2,
    }],
  }],
  tasks: [{
    id: "task-1",
    name: "Upload slides",
    description: "Send the final deck.",
    kind: "upload",
    formId: null,
    formPath: null,
    dueAt: Date.UTC(2026, 8, 1),
    order: 1,
    version: 1,
    completion: null,
    prerequisite: { satisfied: false, message: "Upload the requested file to complete this task." },
  }],
  pages: [{
    id: "page-1",
    slug: "venue",
    title: "Venue guide",
    body: "Use the speaker entrance on 10th Street.",
    embed: { src: "https://docs.google.com/presentation/d/abc/preview", title: "Venue guide" },
    order: 1,
    version: 1,
  }],
  progress: { completed: 0, total: 1 },
};

const renderRoute = (element: React.ReactNode) => renderToStaticMarkup(
  createElement(MemoryRouter, { initialEntries: ["/e/systems-summit/portal"] }, element),
);

afterEach(() => vi.unstubAllGlobals());

describe("speaker portal route", () => {
  it("exports the required discovered path and decodes the coherent portal response", async () => {
    expect(path).toBe("/e/:eventSlug/portal");
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(portal), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(loadSpeakerPortal("systems-summit")).resolves.toEqual(portal);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/events/systems-summit/portal",
      expect.objectContaining({ method: "GET", credentials: "include" }),
    );
  });

  it("renders submissions, profile, tasks, and resources together", () => {
    const markup = renderRoute(createElement(SpeakerPortalRoute, { initialPortal: portal }));
    expect(markup).toContain("Welcome, Ada Rivera");
    expect(markup).toContain("Submissions");
    expect(markup).toContain("Effects without ceremony");
    expect(markup).toContain("Lin Okafor");
    expect(markup).toContain("Profile");
    expect(markup).toContain("Tasks");
    expect(markup).toContain("Upload slides");
    expect(markup).toContain("Resources");
    expect(markup).toContain("Venue guide");
    expect(markup).toContain("sandbox=\"allow-scripts allow-same-origin allow-presentation\"");
    expect(markup).not.toContain("dangerouslySetInnerHTML");
  });

  it("keeps sign-in, unavailable, and retryable failures truthful", () => {
    expect(portalLoadError(new ApiError(401, "Sign in"))).toEqual({ kind: "unauthenticated" });
    expect(portalLoadError(new ApiError(403, "Denied"))).toEqual({ kind: "unavailable" });
    expect(portalLoadError(new Error("Network offline"))).toEqual({ kind: "failed", message: "Network offline" });

    const signedOut = renderRoute(createElement(SpeakerPortalRoute, { initialLoadError: { kind: "unauthenticated" } }));
    expect(signedOut).toContain("Sign in to open your speaker portal");
    expect(signedOut).not.toContain("Try again");
    const unavailable = renderRoute(createElement(SpeakerPortalRoute, { initialLoadError: { kind: "unavailable" } }));
    expect(unavailable).toContain("available only to the account linked to an active accepted proposal");
    const failed = renderRoute(createElement(SpeakerPortalRoute, { initialLoadError: { kind: "failed", message: "Network offline" } }));
    expect(failed).toContain("Network offline");
    expect(failed).toContain("Try again");
  });
});
