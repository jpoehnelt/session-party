import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, useLocation, useNavigate } from "react-router";
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
import { communicationRouteSelection, communicationSelectionSearch } from "../links";

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

const followUpTemplate = {
  ...template,
  id: "template-2",
  name: "Attendee follow-up",
  subject: "Thanks for joining us",
  textBody: "Thank you {{speakerName}}",
  htmlBody: "<p>Thank you {{speakerName}}</p>",
  version: 1,
};

const audience = {
  eventId: "event-1",
  recipients: [
    {
      recipientKey: "speaker-1:accepted",
      speakerId: "speaker-1",
      userId: "user-1",
      name: "Ada Speaker",
      email: "ada@example.com",
      decision: "accepted" as const,
      sessionTitles: ["Reliable systems"],
      eligibility: "eligible" as const,
    },
    {
      recipientKey: "speaker-2:rejected",
      speakerId: "speaker-2",
      userId: "user-2",
      name: "Lin Applicant",
      email: "lin@example.com",
      decision: "rejected" as const,
      sessionTitles: ["Practical queues"],
      eligibility: "eligible" as const,
    },
  ],
  eligibleCount: 2,
  dependency: "decidedApplicants" as const,
  pagination: { page: 1, pageSize: 100, total: 2, pageCount: 1 },
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

const buttonContaining = (name: string): HTMLButtonElement => {
  const button = [...document.querySelectorAll<HTMLButtonElement>("button")]
    .find((candidate) => candidate.textContent?.includes(name));
  if (!button) throw new Error(`Missing button containing: ${name}`);
  return button;
};

const inputNamed = (name: string): HTMLInputElement => {
  const label = [...document.querySelectorAll<HTMLLabelElement>("label")]
    .find((candidate) => candidate.textContent?.includes(name));
  const input = label?.htmlFor ? document.getElementById(label.htmlFor) : null;
  if (!(input instanceof HTMLInputElement)) throw new Error(`Missing input: ${name}`);
  return input;
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

function RoutedCommunicationsWorkspace() {
  const location = useLocation();
  const navigate = useNavigate();
  const route = communicationRouteSelection(location.search);
  return (
    <>
      <button type="button" onClick={() => void navigate(-1)}>Browser back</button>
      <output data-testid="comms-location">{location.search}</output>
      <CommunicationsWorkspace
        event={{ id: "event-1", name: "Summit", slug: "summit", timezone: "America/Los_Angeles" }}
        routeTab={route.tab}
        routeTemplateId={route.templateId}
        routeNeedsCanonicalization={route.needsCanonicalization}
        onRouteSelectionChange={(tab, templateId, options) => {
          void navigate({
            pathname: location.pathname,
            search: communicationSelectionSearch(location.search, tab, templateId),
          }, { replace: options?.replace ?? false });
        }}
      />
    </>
  );
}

const locationSearch = () => document.querySelector<HTMLOutputElement>('[data-testid="comms-location"]')?.textContent ?? "";
const selectedTemplateLabel = () => document.querySelector<HTMLButtonElement>('button[aria-current="page"]')?.textContent ?? "";

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
      if (path.includes("/audience")) return Promise.resolve(audience);
      if (path.includes("/deliveries")) {
        return Promise.resolve({ eventId: "event-1", deliveries: [], localCaptureCount: 0, pagination: { page: 1, pageSize: 100, total: 0, pageCount: 0 } });
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

  it("selects a rejection cohort and visibly confirms the persisted dispatch", async () => {
    apiMocks.apiFetch.mockImplementation((path: string, options?: { method?: string; body?: unknown }) => {
      if (options?.method === "POST" && path.endsWith("/deliveries")) return Promise.resolve(enqueueResult);
      if (path.endsWith("/templates")) return Promise.resolve([template]);
      if (path.includes("/audience")) return Promise.resolve(audience);
      if (path.includes("/deliveries")) return Promise.resolve({ eventId: "event-1", deliveries: [], localCaptureCount: 0, pagination: { page: 1, pageSize: 100, total: 0, pageCount: 0 } });
      throw new Error(`Unexpected API request: ${path}`);
    });
    await act(async () => {
      root.render(
        <CommunicationsWorkspace
          event={{ id: "event-1", name: "Summit", slug: "summit", timezone: "America/Los_Angeles" }}
        />,
      );
    });
    await vi.waitFor(() => expect(buttonNamed("02 / Audience & queue")).toBeTruthy());
    await act(async () => userEvent.click(buttonNamed("02 / Audience & queue")));
    await vi.waitFor(() => expect(buttonNamed("Select rejected")).toBeTruthy());
    expect(document.body.textContent).toContain("Accepted");
    expect(document.body.textContent).toContain("Rejected");
    await act(async () => userEvent.click(buttonNamed("Select rejected")));
    await act(async () => userEvent.click(checkboxNamed("Authorize Session Party to send")));
    await act(async () => userEvent.click(buttonNamed("Queue immutable deliveries")));
    await vi.waitFor(() => expect(buttonNamed("Queue deliveries")).toBeTruthy());
    await act(async () => userEvent.click(buttonNamed("Queue deliveries")));
    await vi.waitFor(() => expect(document.body.textContent).toContain("1 deliveries persisted"));
    const enqueueCall = apiMocks.apiFetch.mock.calls.find(
      ([path, options]) => options?.method === "POST" && path.endsWith("/deliveries"),
    );
    expect(enqueueCall?.[1].body).toMatchObject({ recipientKeys: ["speaker-2:rejected"] });
  });

  it("deep links tabs and templates while guarding internal and history navigation", async () => {
    apiMocks.apiFetch.mockImplementation((path: string) => {
      if (path.endsWith("/templates")) return Promise.resolve([template, followUpTemplate]);
      if (path.includes("/audience")) return Promise.resolve(audience);
      if (path.includes("/deliveries")) return Promise.resolve({ eventId: "event-1", deliveries: [], localCaptureCount: 0, pagination: { page: 1, pageSize: 100, total: 0, pageCount: 0 } });
      throw new Error(`Unexpected API request: ${path}`);
    });
    await act(async () => {
      root.render(
        <MemoryRouter initialEntries={["/e/summit/comms?tab=unknown&templateId=missing-template"]}>
          <RoutedCommunicationsWorkspace />
        </MemoryRouter>,
      );
    });

    await vi.waitFor(() => expect(selectedTemplateLabel()).toContain(template.name));
    expect(locationSearch()).toBe("?tab=templates&templateId=template-1");

    await act(async () => userEvent.click(buttonContaining(followUpTemplate.name)));
    await vi.waitFor(() => expect(locationSearch()).toBe("?tab=templates&templateId=template-2"));
    expect(selectedTemplateLabel()).toContain(followUpTemplate.name);

    await act(async () => userEvent.click(buttonNamed("Browser back")));
    await vi.waitFor(() => expect(selectedTemplateLabel()).toContain(template.name));
    expect(locationSearch()).toBe("?tab=templates&templateId=template-1");

    await vi.waitFor(() => expect(inputNamed("Template name").value).toBe(template.name));
    await act(async () => userEvent.fill(inputNamed("Template name"), "Unsaved speaker briefing"));
    await act(async () => userEvent.click(buttonNamed("02 / Audience & queue")));
    expect(document.body.textContent).toContain("Discard unsaved template changes?");
    expect(locationSearch()).toBe("?tab=templates&templateId=template-1");
    await act(async () => userEvent.click(buttonNamed("Keep editing")));
    expect(locationSearch()).toBe("?tab=templates&templateId=template-1");

    await act(async () => userEvent.click(buttonNamed("02 / Audience & queue")));
    await act(async () => userEvent.click(buttonNamed("Discard changes")));
    await vi.waitFor(() => expect(locationSearch()).toBe("?tab=send&templateId=template-1"));
    await vi.waitFor(() => expect(buttonNamed("Select ready")).toBeTruthy());

    await act(async () => userEvent.click(buttonNamed("01 / Templates")));
    await vi.waitFor(() => expect(locationSearch()).toBe("?tab=templates&templateId=template-1"));
    await vi.waitFor(() => expect(inputNamed("Template name").value).toBe(template.name));
    await act(async () => userEvent.fill(inputNamed("Template name"), "Another unsaved briefing"));
    await act(async () => userEvent.click(buttonNamed("Browser back")));
    await vi.waitFor(() => expect(document.body.textContent).toContain("Discard unsaved template changes?"));
    expect(locationSearch()).toBe("?tab=send&templateId=template-1");
    await act(async () => userEvent.click(buttonNamed("Keep editing")));
    await vi.waitFor(() => expect(locationSearch()).toBe("?tab=templates&templateId=template-1"));
    expect(selectedTemplateLabel()).toContain(template.name);
  });
});
