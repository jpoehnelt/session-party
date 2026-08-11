import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router";
import { userEvent } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
  });

  const renderForm = async () => {
    await act(async () => {
      root.render(
        <MemoryRouter initialEntries={[route]}>
          <Routes>
            <Route path="/submit/:eventSlug/:formId" element={<PublicSubmitPage initialForm={fixture} />} />
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
});
