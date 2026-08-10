import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { userEvent } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiMocks = vi.hoisted(() => ({ apiFetch: vi.fn() }));

vi.mock("@/client/api", () => ({
  ApiError: class ApiError extends Error {
    constructor(readonly status: number, message: string) {
      super(message);
    }
  },
  apiFetch: apiMocks.apiFetch,
}));

import { CommunicationsWorkspace } from "./comms";

const template = {
  id: "template-1",
  eventId: "event-1",
  name: "Speaker briefing",
  subject: "Your session",
  textBody: "Hello {{speakerName}}",
  htmlBody: "<p>Hello {{speakerName}}</p>",
  attachIcs: false,
  version: 3,
  createdAt: 1_786_291_200_000,
  updatedAt: 1_786_291_200_000,
};

const audience = {
  eventId: "event-1",
  recipients: [{
    speakerId: "speaker-1",
    userId: "user-1",
    name: "Ada Speaker",
    email: "ada@example.com",
    sessionTitles: ["Reliable systems"],
    eligibility: "eligible" as const,
  }],
  eligibleCount: 1,
  dependency: "acceptedSpeakers" as const,
};

const enqueueResult = {
  eventId: "event-1",
  templateId: "template-1",
  queuedAt: 1_786_291_200_000,
  queueState: "persisted" as const,
  dispatchState: "deferred" as const,
  schedulerWake: "requested" as const,
  deliveries: [{
    deliveryId: "delivery-1",
    snapshotId: "snapshot-1",
    speakerId: "speaker-1",
    recipientEmail: "ada@example.com",
    status: "pending" as const,
    scheduledFor: 1_786_291_200_000,
  }],
  replayed: false,
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
  const checkbox = label?.htmlFor
    ? document.getElementById(label.htmlFor) as HTMLInputElement | null
    : null;
  if (!checkbox) throw new Error(`Missing checkbox: ${name}`);
  return checkbox;
};

describe("rendered campaign confirmation lifecycle", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    let postCount = 0;
    apiMocks.apiFetch.mockReset();
    apiMocks.apiFetch.mockImplementation((path: string, options?: { method?: string; body?: unknown }) => {
      if (options?.method === "POST" && path.endsWith("/deliveries")) {
        postCount += 1;
        return postCount === 1
          ? Promise.reject(new Error("Response lost after commit"))
          : Promise.resolve(enqueueResult);
      }
      if (path.endsWith("/templates")) return Promise.resolve([template]);
      if (path.endsWith("/audience")) return Promise.resolve(audience);
      if (path.endsWith("/deliveries")) {
        return Promise.resolve({ eventId: "event-1", deliveries: [], localCaptureCount: 0 });
      }
      throw new Error(`Unexpected API request: ${path}`);
    });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it("enqueues once on double activation and reuses the confirmed request after an ambiguous retry", async () => {
    await act(async () => {
      root.render(
        <CommunicationsWorkspace
          event={{ id: "event-1", name: "Summit", slug: "summit", timezone: "America/Los_Angeles" }}
        />,
      );
    });
    await vi.waitFor(() => expect(buttonNamed("02 / Audience & queue")).toBeTruthy());

    await act(async () => userEvent.click(buttonNamed("02 / Audience & queue")));
    await vi.waitFor(() => expect(buttonNamed("Select ready")).toBeTruthy());
    await act(async () => userEvent.click(buttonNamed("Select ready")));
    await act(async () => userEvent.click(checkboxNamed("Authorize Session Party to send")));
    await act(async () => userEvent.click(buttonNamed("Queue immutable deliveries")));
    await vi.waitFor(() => expect(buttonNamed("Queue deliveries")).toBeTruthy());

    const confirm = buttonNamed("Queue deliveries");
    await act(async () => {
      confirm.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      confirm.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const enqueueCalls = () => apiMocks.apiFetch.mock.calls.filter(
      ([path, options]) => options?.method === "POST" && path.endsWith("/deliveries"),
    );
    await vi.waitFor(() => expect(enqueueCalls()).toHaveLength(1));
    const firstRequest = enqueueCalls()[0]?.[1].body;
    expect(firstRequest).toMatchObject({ expectedTemplateVersion: 3 });

    await vi.waitFor(() => expect(buttonNamed("Queue immutable deliveries").disabled).toBe(false));

    await act(async () => userEvent.click(buttonNamed("Queue immutable deliveries")));
    await vi.waitFor(() => expect(buttonNamed("Queue deliveries")).toBeTruthy());
    await act(async () => userEvent.click(buttonNamed("Queue deliveries")));
    await vi.waitFor(() => expect(enqueueCalls()).toHaveLength(2));

    expect(enqueueCalls()[1]?.[1].body).toEqual(firstRequest);
  });
});
