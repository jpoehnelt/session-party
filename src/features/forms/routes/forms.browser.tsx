import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, useLocation, useNavigate } from "react-router";
import { userEvent } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { routedFormsFixture } from "../fixtures";
import type { FormDetail, FormSummary } from "../schema";
import { formSelectionSearch, selectedFormIdFromSearch } from "../links";
import { FormsWorkspace, type EventIdentity } from "./forms";

const event: EventIdentity = {
  id: routedFormsFixture.eventId,
  name: "AI Engineer Sandbox",
  slug: routedFormsFixture.eventSlug,
};

const details = new Map(routedFormsFixture.forms.map((form) => [form.id, form] as const));
const summaries: readonly FormSummary[] = routedFormsFixture.forms.map((form) => ({
  id: form.id,
  eventId: form.eventId,
  purpose: form.purpose,
  name: form.name,
  description: form.description,
  status: form.status,
  opensAt: form.opensAt,
  closesAt: form.closesAt,
  version: form.version,
  publishedVersionNumber: form.publishedVersion?.versionNumber ?? null,
  updatedAt: form.updatedAt,
}));

function RoutedFormsWorkspace() {
  const location = useLocation();
  const navigate = useNavigate();
  const routeSelectedId = selectedFormIdFromSearch(location.search);
  return (
    <>
      <button type="button" onClick={() => void navigate(-1)}>Browser back</button>
      <output data-testid="forms-location">{location.search}</output>
      <FormsWorkspace
        event={event}
        routeSelectedId={routeSelectedId}
        enableRealtime={false}
        onSelectedFormChange={(formId, options) => {
          void navigate({
            pathname: location.pathname,
            search: formSelectionSearch(location.search, formId),
          }, { replace: options?.replace ?? false });
        }}
      />
    </>
  );
}

const control = (label: string): HTMLButtonElement => {
  const candidate = [...document.querySelectorAll<HTMLButtonElement>("button")]
    .find((button) => button.textContent?.includes(label));
  if (!candidate) throw new Error(`Missing button: ${label}`);
  return candidate;
};

const field = (label: string): HTMLInputElement => {
  const candidate = [...document.querySelectorAll<HTMLLabelElement>("label")]
    .find((item) => item.textContent?.includes(label));
  const input = candidate?.htmlFor ? document.getElementById(candidate.htmlFor) : null;
  if (!(input instanceof HTMLInputElement)) throw new Error(`Missing input: ${label}`);
  return input;
};

const selectedQueueLabel = () => document.querySelector<HTMLButtonElement>('button[aria-current="page"]')?.textContent ?? "";
const locationSearch = () => document.querySelector<HTMLOutputElement>('[data-testid="forms-location"]')?.textContent ?? "";

describe("form deep-link navigation", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === `/api/v1/events/${event.id}/forms`) {
        return new Response(JSON.stringify(summaries), { status: 200 });
      }
      const prefix = `/api/v1/events/${event.id}/forms/`;
      if (url.startsWith(prefix)) {
        const detail = details.get(decodeURIComponent(url.slice(prefix.length)));
        return detail
          ? new Response(JSON.stringify(detail), { status: 200 })
          : new Response(JSON.stringify({ message: "Form not found" }), { status: 404 });
      }
      throw new Error(`Unexpected request: ${url}`);
    }));
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it("canonicalizes invalid IDs, supports push/back, and guards unsaved history changes", async () => {
    const [primary, logistics] = routedFormsFixture.forms as readonly [FormDetail, FormDetail];
    await act(async () => {
      root.render(
        <MemoryRouter initialEntries={[`/e/${event.slug}/forms?formId=missing-form`]}>
          <RoutedFormsWorkspace />
        </MemoryRouter>,
      );
    });

    await vi.waitFor(() => expect(selectedQueueLabel()).toContain(primary.name));
    expect(locationSearch()).toBe(`?formId=${primary.id}`);

    await act(async () => userEvent.click(control(logistics.name)));
    await vi.waitFor(() => expect(locationSearch()).toBe(`?formId=${logistics.id}`));
    expect(selectedQueueLabel()).toContain(logistics.name);

    await act(async () => userEvent.click(control("Browser back")));
    await vi.waitFor(() => expect(selectedQueueLabel()).toContain(primary.name));
    expect(locationSearch()).toBe(`?formId=${primary.id}`);

    await vi.waitFor(() => expect(field("Form name").value).toBe(primary.name));
    await act(async () => userEvent.fill(field("Form name"), "Unsaved primary form"));
    await act(async () => userEvent.click(control(logistics.name)));
    expect(document.body.textContent).toContain("Discard unsaved form changes?");
    expect(locationSearch()).toBe(`?formId=${primary.id}`);
    await act(async () => userEvent.click(control("Keep editing")));
    expect(locationSearch()).toBe(`?formId=${primary.id}`);

    await act(async () => userEvent.click(control(logistics.name)));
    await act(async () => userEvent.click(control("Discard changes")));
    await vi.waitFor(() => expect(locationSearch()).toBe(`?formId=${logistics.id}`));

    await vi.waitFor(() => expect(field("Form name").value).toBe(logistics.name));
    await act(async () => userEvent.fill(field("Form name"), "Unsaved logistics form"));
    await act(async () => userEvent.click(control("Browser back")));
    await vi.waitFor(() => expect(document.body.textContent).toContain("Discard unsaved form changes?"));
    expect(locationSearch()).toBe(`?formId=${primary.id}`);
    await act(async () => userEvent.click(control("Keep editing")));
    await vi.waitFor(() => expect(locationSearch()).toBe(`?formId=${logistics.id}`));
    expect(selectedQueueLabel()).toContain(logistics.name);
  });
});
