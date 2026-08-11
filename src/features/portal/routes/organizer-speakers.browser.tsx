import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router";
import { userEvent } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SpeakerDirectory } from "../schema";

const apiMocks = vi.hoisted(() => ({
  getSpeakerDirectory: vi.fn(),
  sendSpeakerMessages: vi.fn(),
}));

vi.mock("./api", () => ({
  createManagedSpeaker: vi.fn(),
  getSpeakerDirectory: apiMocks.getSpeakerDirectory,
  importSpeakersCsv: vi.fn(),
  provisionSpeaker: vi.fn(),
  sendSpeakerMessages: apiMocks.sendSpeakerMessages,
  updateManagedSpeaker: vi.fn(),
  updateSpeakerPublication: vi.fn(),
  uploadManagedSpeakerHeadshot: vi.fn(),
}));

import OrganizerSpeakersRoute from "./organizer-speakers";

const event = {
  id: "event-reminders",
  slug: "reminder-summit",
  name: "Reminder Summit",
  description: null,
  location: "Main Hall",
  timezone: "America/Denver",
  startsAt: Date.UTC(2027, 4, 12),
  endsAt: Date.UTC(2027, 4, 14),
  bannerAssetId: null,
  accentColor: null,
} as const;

const speakerItem = (id: string, displayName: string, taskId: string): SpeakerDirectory["speakers"][number] => ({
  speaker: {
    id,
    eventId: event.id,
    displayName,
    contactEmail: `${id}@example.com`,
    title: "Engineer",
    company: "Example Co",
    bio: null,
    workflowStatus: "Invited",
    headshotAssetId: null,
    headshotUrl: null,
    links: [],
    visible: true,
    profileSourceId: null,
    profileSourceVersion: null,
    profileReviewStatus: "approved",
    profileReviewNote: null,
    profileSubmittedAt: null,
    profileReviewedAt: null,
    version: 1,
    pendingSyncFields: [],
  },
  submission: { id: `submission-${id}`, title: `${displayName}'s session`, category: "systems", version: 2 },
  source: "accepted",
  acceptanceEventId: `acceptance-${id}`,
  provisioningId: `provisioning-${id}`,
  provisioningVersion: 1,
  provisioningStatus: "provisioned",
  provisionedAt: Date.UTC(2027, 3, 1),
  sessions: [],
  readiness: {
    tasksTotal: 1,
    tasksDone: 0,
    outstandingTaskIds: [taskId],
    nextTaskId: taskId,
    state: "not_started",
    missingItems: [{
      id: taskId,
      name: "Upload slides",
      kind: "upload",
      dueAt: Date.UTC(2027, 4, 1),
      overdue: true,
      blocker: "Slides are missing",
      recommendedAction: "Upload the current deck",
    }],
    overdueCount: 1,
    clearestBlocker: "Slides are missing",
    recommendedNextAction: "Upload the current deck",
  },
  latestContact: null,
});

const directory: SpeakerDirectory = {
  event,
  speakers: [
    speakerItem("ada", "Ada Rivera", "task-ada"),
    speakerItem("lin", "Lin Chen", "task-lin"),
  ],
};

const buttonNamed = (name: string): HTMLButtonElement => {
  const button = [...document.querySelectorAll<HTMLButtonElement>("button")]
    .find((candidate) => candidate.textContent?.trim() === name);
  if (!button) throw new Error(`Missing button: ${name}`);
  return button;
};

const checkboxNamed = (name: string): HTMLInputElement => {
  const label = [...document.querySelectorAll<HTMLLabelElement>("label")]
    .find((candidate) => candidate.textContent?.includes(name));
  const checkbox = label?.htmlFor ? document.getElementById(label.htmlFor) as HTMLInputElement | null : null;
  if (!checkbox) throw new Error(`Missing checkbox: ${name}`);
  return checkbox;
};

describe("organizer bulk speaker reminders", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    apiMocks.getSpeakerDirectory.mockReset().mockResolvedValue(directory);
    apiMocks.sendSpeakerMessages.mockReset().mockResolvedValue({ queuedCount: 2, skippedCount: 0, idempotent: false });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await act(async () => root.unmount());
    container.remove();
  });

  it("selects speakers with outstanding tasks, confirms the exact audience, and shows queue success", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    await act(async () => root.render(
      <MemoryRouter initialEntries={["/e/reminder-summit/speakers"]}>
        <Routes>
          <Route path="/e/:eventSlug/speakers" element={<OrganizerSpeakersRoute />} />
        </Routes>
      </MemoryRouter>,
    ));
    await vi.waitFor(() => expect(buttonNamed("Remind outstanding")).toBeTruthy());
    expect(container.textContent).toContain("Outstanding task 1");

    await act(async () => userEvent.click(checkboxNamed("Select Ada Rivera")));
    await act(async () => userEvent.click(checkboxNamed("Select Lin Chen")));
    expect(container.textContent).toContain("2 selected");
    await act(async () => userEvent.click(buttonNamed("Remind outstanding")));

    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("Audience: Ada Rivera, Lin Chen"));
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("task count, next due task, and portal link"));
    await vi.waitFor(() => expect(apiMocks.sendSpeakerMessages).toHaveBeenCalledOnce());
    expect(apiMocks.sendSpeakerMessages.mock.calls[0]?.[1]).toMatchObject({
      eventId: event.id,
      speakerIds: ["ada", "lin"],
      kind: "reminder",
    });
    await vi.waitFor(() => expect(document.body.textContent).toContain("Reminders queued"));
  });
});
