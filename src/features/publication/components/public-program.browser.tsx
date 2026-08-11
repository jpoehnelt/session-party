import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { userEvent } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PublishedAgenda } from "@/features/agenda/schema";
import type { PublicSpeakerGallery } from "@/features/portal/schema";
import { PublicProgram, embedDefinitionStorageKey, type PublicProgramSurface } from "./PublicProgram";

const START = Date.UTC(2027, 4, 12, 16);
const agenda: PublishedAgenda = {
  eventId: "public-browser-event",
  eventName: "DevFlow Conf 2027",
  eventSlug: "devflow-conf-2027",
  timezone: "America/Los_Angeles",
  location: "Moscone West",
  revision: 4,
  publishedAt: Date.UTC(2027, 4, 1),
  talks: [
    {
      id: "talk-ci",
      title: "Taming 40-Minute CI",
      description: "A detailed account of incremental builds, remote caching, and evidence from a large monorepo. Attendees leave with an adoption plan and practical benchmarks that can be applied immediately.",
      track: "Platform & Infra",
      room: "Main Stage",
      startsAt: START,
      durationMin: 30,
      speakerNames: ["Priya Raman"],
    },
    {
      id: "talk-cache",
      title: "Cache Invalidation Without Folklore",
      description: "Practical cache invalidation patterns.",
      track: "Platform & Infra",
      room: "Room 2A",
      startsAt: START + 3_600_000,
      durationMin: 45,
      speakerNames: ["Jamie Chen"],
    },
    {
      id: "talk-docs",
      title: "Docs That Answer Back",
      description: "Retrieval-grounded documentation patterns.",
      track: "Developer Experience",
      room: "Room 2A",
      startsAt: START + 86_400_000,
      durationMin: 45,
      speakerNames: ["Marcus Okafor"],
    },
  ],
};

const gallery: PublicSpeakerGallery = {
  event: {
    id: agenda.eventId,
    slug: agenda.eventSlug,
    name: agenda.eventName,
    description: null,
    location: agenda.location,
    timezone: agenda.timezone,
    startsAt: START,
    endsAt: START + 2 * 86_400_000,
    bannerAssetId: null,
    accentColor: "#635BFF",
  },
  speakers: [
    {
      id: "speaker-priya",
      displayName: "Priya Raman",
      title: "Principal Engineer",
      company: "Latticework Systems",
      bio: "Priya builds high-scale developer infrastructure. ".repeat(8),
      headshotUrl: null,
      links: [],
    },
    {
      id: "speaker-marcus",
      displayName: "Marcus Okafor",
      title: "Staff Engineer",
      company: "Northstar",
      bio: null,
      headshotUrl: null,
      links: [],
    },
    {
      id: "speaker-jamie",
      displayName: "Jamie Chen",
      title: "Engineering Manager",
      company: "Switchyard",
      bio: "Jamie operates large build systems.",
      headshotUrl: null,
      links: [],
    },
  ],
};

const byButton = (name: string): HTMLButtonElement => {
  const button = [...document.querySelectorAll<HTMLButtonElement>("button")]
    .find((candidate) => candidate.textContent?.includes(name));
  if (!button) throw new Error(`Missing button: ${name}`);
  return button;
};

const fieldNamed = <T extends HTMLInputElement | HTMLSelectElement>(name: string): T => {
  const label = [...document.querySelectorAll<HTMLLabelElement>("label")]
    .find((candidate) => candidate.textContent?.includes(name));
  const field = label?.htmlFor ? document.getElementById(label.htmlFor) as T | null : null;
  if (!field) throw new Error(`Missing field: ${name}`);
  return field;
};

describe("public program rendered interactions", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    window.localStorage.clear();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    window.localStorage.clear();
  });

  const renderSurface = async (surface: PublicProgramSurface) => {
    await act(async () => {
      root.render(
        <MemoryRouter>
          <PublicProgram agenda={agenda} gallery={gallery} surface={surface} />
        </MemoryRouter>,
      );
    });
  };

  it("searches and facets session cards while expanding the complete description", async () => {
    await renderSurface("sessions");
    expect(container.textContent).toContain("03 sessions on the board");
    await act(async () => userEvent.fill(fieldNamed<HTMLInputElement>("Search sessions or speakers"), "Priya"));
    expect(container.textContent).toContain("01 session on the board");
    expect(container.textContent).toContain("Taming 40-Minute CI");
    expect(container.textContent).not.toContain("Docs That Answer Back");
    await act(async () => userEvent.clear(fieldNamed<HTMLInputElement>("Search sessions or speakers")));
    await act(async () => userEvent.selectOptions(fieldNamed<HTMLSelectElement>("Track"), "Developer Experience"));
    expect(container.textContent).toContain("01 session on the board");
    expect(container.textContent).toContain("Docs That Answer Back");
    await act(async () => userEvent.selectOptions(fieldNamed<HTMLSelectElement>("Track"), ""));
    await act(async () => userEvent.click(byButton("Show more")));
    expect(byButton("Show less").getAttribute("aria-expanded")).toBe("true");
  });

  it("opens and closes complete speaker list and gallery profiles with a long biography", async () => {
    await renderSurface("speakers");
    await act(async () => userEvent.fill(fieldNamed<HTMLInputElement>("Search speakers"), "Priya Raman"));
    expect(container.textContent).toContain("01 speaker published");
    await act(async () => userEvent.click(byButton("Priya Raman")));
    expect(document.body.textContent).toContain("Biography");
    expect(document.body.textContent).toContain("Taming 40-Minute CI");
    expect(document.body.textContent).toContain("Main Stage");
    await act(async () => userEvent.click(document.querySelector<HTMLButtonElement>('button[aria-label="Close"]')!));
    expect(container.textContent).toContain("01 speaker published");

    await act(async () => root.unmount());
    root = createRoot(container);
    await renderSurface("gallery");
    await act(async () => userEvent.fill(fieldNamed<HTMLInputElement>("Search speakers"), "Priya"));
    await act(async () => userEvent.click(byButton("Priya Raman")));
    expect(document.body.textContent).toContain("Show more biography");
    await act(async () => userEvent.click(byButton("Show more biography")));
    expect(byButton("Show less biography").getAttribute("aria-expanded")).toBe("true");
  });

  it("switches agenda days and restores the agenda after closing complete session detail", async () => {
    await renderSurface("agenda");
    expect(container.textContent).toContain("Taming 40-Minute CI");
    expect(container.textContent).not.toContain("Docs That Answer Back");
    const tabs = [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
    expect(tabs).toHaveLength(2);
    await act(async () => userEvent.click(tabs[1]!));
    expect(container.textContent).toContain("Docs That Answer Back");
    expect(container.textContent).not.toContain("Taming 40-Minute CI");
    await act(async () => userEvent.click(byButton("Docs That Answer Back")));
    expect(document.body.textContent).toContain("Retrieval-grounded documentation patterns");
    expect(document.body.textContent).toContain("Format · 45 minutes");
    expect(document.body.textContent).toContain("Track · Developer Experience");
    expect(document.body.textContent).toContain("Room · Room 2A");
    await act(async () => userEvent.click(document.querySelector<HTMLButtonElement>('button[aria-label="Close"]')!));
    expect(container.textContent).toContain("Docs That Answer Back");
  });

  it("builds an exact personal schedule and restores it across a full remount", async () => {
    await renderSurface("schedule");
    await act(async () => userEvent.click(byButton("Add to my schedule")));
    const tabs = [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
    await act(async () => userEvent.click(tabs[1]!));
    await act(async () => userEvent.click(byButton("Add to my schedule")));
    await act(async () => userEvent.click(byButton("My schedule (2)")));
    expect(container.textContent).toContain("Taming 40-Minute CI");
    expect(container.textContent).toContain("Docs That Answer Back");
    expect(container.textContent).not.toContain("Cache Invalidation Without Folklore");
    expect(container.textContent).toContain("Add to calendar (.ics)");

    await act(async () => root.unmount());
    root = createRoot(container);
    await renderSurface("schedule");
    await act(async () => userEvent.click(byButton("My schedule (2)")));
    expect(container.textContent).toContain("Taming 40-Minute CI");
    expect(container.textContent).toContain("Docs That Answer Back");
    await act(async () => userEvent.click(byButton("Remove")));
    expect(container.textContent).toContain("My schedule (1)");
  });

  it("saves, retrieves, disables, and restores an organizer embed definition", async () => {
    await renderSurface("widgets");
    const widgetSelect = fieldNamed<HTMLSelectElement>("Widget type");
    const formatSelect = fieldNamed<HTMLSelectElement>("Output format");
    await act(async () => userEvent.selectOptions(formatSelect, "ical"));
    expect(document.querySelector<HTMLTextAreaElement>("#generated-widget-code")?.value).toContain("data:text/calendar");
    await act(async () => userEvent.selectOptions(widgetSelect, "gallery"));
    expect(formatSelect.value).toBe("json");
    expect(formatSelect.querySelector<HTMLOptionElement>('option[value="ical"]')?.disabled).toBe(true);
    expect(document.querySelector<HTMLTextAreaElement>("#generated-widget-code")?.value).toContain(
      "/api/v1/public/events/devflow-conf-2027/speakers",
    );
    await act(async () => userEvent.fill(fieldNamed<HTMLInputElement>("Embed name"), "Platform schedule"));
    await act(async () => userEvent.selectOptions(widgetSelect, "schedule"));
    await act(async () => userEvent.selectOptions(formatSelect, "styled-html"));
    await act(async () => userEvent.selectOptions(fieldNamed<HTMLSelectElement>("Track filter"), "Platform & Infra"));
    await act(async () => userEvent.click(byButton("Save embed definition")));
    expect(container.textContent).toContain("Saved embeds (1)");
    expect(container.textContent).toContain("Platform schedule");
    expect(window.localStorage.getItem(embedDefinitionStorageKey(agenda.eventSlug))).toContain("Platform schedule");
    await act(async () => userEvent.click(byButton("Disable")));
    expect(container.textContent).toContain("Disabled");

    await act(async () => root.unmount());
    root = createRoot(container);
    await renderSurface("widgets");
    await vi.waitFor(() => expect(container.textContent).toContain("Saved embeds (1)"));
    expect(container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Platform schedule code"]')?.value).toContain("<iframe");
    expect(container.textContent).toContain("Get code");
  });
});
