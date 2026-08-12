import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router";
import { userEvent } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PublicSubmissionForm } from "../schema";
import PublicSubmitPage, { draftStorageKey } from "./public-submit";

const fixture: PublicSubmissionForm = {
  event: {
    name: "Architecture Summit",
    slug: "architecture-summit",
    description: null,
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
    description: null,
    availability: "open",
    opensAt: null,
    closesAt: null,
    fields: [{
      id: "field-title",
      order: 1,
      type: "text",
      label: "Proposal title",
      helpText: null,
      required: true,
      options: [],
      logic: null,
    }],
  },
  turnstileSiteKey: null,
};

const route = "/submit/architecture-summit/form-public";

describe("public submission draft lifecycle", () => {
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
    delete window.turnstile;
    vi.unstubAllGlobals();
  });

  const renderForm = async (initialForm: PublicSubmissionForm = fixture) => {
    await act(async () => {
      root.render(
        <MemoryRouter initialEntries={[route]}>
          <Routes>
            <Route path="/submit/:eventSlug/:formId" element={<PublicSubmitPage initialForm={initialForm} />} />
          </Routes>
        </MemoryRouter>,
      );
    });
  };

  it("saves a title-only draft and restores it after a real remount", async () => {
    await renderForm();
    const title = document.querySelector<HTMLInputElement>("#public-submit-field-title");
    expect(title).not.toBeNull();
    await act(async () => userEvent.fill(title!, "A resilient draft"));
    const save = [...document.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.trim() === "Save draft");
    expect(save).not.toBeUndefined();
    await act(async () => userEvent.click(save!));
    expect(window.localStorage.getItem(draftStorageKey(
      fixture.event.slug,
      fixture.form.id,
      fixture.form.versionId,
    ))).toContain("A resilient draft");

    await act(async () => root.unmount());
    root = createRoot(container);
    await renderForm();

    expect(document.querySelector<HTMLInputElement>("#public-submit-field-title")?.value).toBe("A resilient draft");
    expect(container.textContent).toContain("Draft restored");
  });

  it("shows durable required-field feedback even before human verification completes", async () => {
    await renderForm();
    const submit = [...document.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.includes("Submit proposal"));
    expect(submit).not.toBeUndefined();

    await act(async () => userEvent.click(submit!));

    expect(container.textContent).toContain("Proposal title is required.");
    expect(container.textContent).toContain("Complete the required fields highlighted above before submitting.");
    expect(document.querySelector("#public-submit-field-title")?.getAttribute("aria-invalid")).toBe("true");
  });

  it("bypasses Turnstile only for a deterministic demo round-trip", async () => {
    const turnstileRender = vi.fn(() => "unexpected-widget");
    window.turnstile = {
      render: turnstileRender,
      reset: vi.fn(),
      remove: vi.fn(),
    };
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      submissionId: "submission-demo-created",
      status: "submitted",
      submittedAt: Date.UTC(2026, 7, 11, 18),
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await renderForm({ ...fixture, turnstileSiteKey: "session-party-demo-disabled" });

    expect(container.textContent).toContain("Demo verification disabled");
    expect(container.textContent).toContain("does not require a verification challenge");
    expect(turnstileRender).not.toHaveBeenCalled();
    const title = document.querySelector<HTMLInputElement>("#public-submit-field-title");
    await act(async () => userEvent.fill(title!, "Automation without a bypass"));
    const submit = [...document.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.includes("Submit proposal"));
    await act(async () => userEvent.click(submit!));

    await vi.waitFor(() => expect(container.textContent).toContain("Submission received"));
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/public/events/architecture-summit/forms/form-public/submissions",
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining('"turnstileToken":"demo-verification-disabled"'),
      }),
    );
  });

  it("keeps the live widget and hides demo labeling for another event", async () => {
    const turnstileRender = vi.fn(() => "live-widget");
    window.turnstile = {
      render: turnstileRender,
      reset: vi.fn(),
      remove: vi.fn(),
    };

    await renderForm({ ...fixture, turnstileSiteKey: "live-site-key" });

    expect(container.textContent).not.toContain("Demo verification");
    expect(turnstileRender).toHaveBeenCalledWith(
      expect.any(HTMLElement),
      expect.objectContaining({
        sitekey: "live-site-key",
        action: "cfp-submit",
      }),
    );
    expect(document.querySelector('[aria-label="Human verification"]')).not.toBeNull();
  });
});
