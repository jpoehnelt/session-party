import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiMocks = vi.hoisted(() => ({ apiFetch: vi.fn() }));

vi.mock("./api", () => ({ apiFetch: apiMocks.apiFetch }));

import { RouteAccessBoundary } from "./route-access";

const renderRoute = async (root: Root, initialEntry: string, access: "event-organizer" | "install-staff") => {
  await act(async () => root.render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <Routes>
        <Route
          path={access === "install-staff" ? "/staff" : "/e/:eventSlug/settings"}
          element={<RouteAccessBoundary access={access}><button type="button">Active organizer control</button></RouteAccessBoundary>}
        />
        <Route path="/login" element={<p>Sign in</p>} />
      </Routes>
    </MemoryRouter>,
  ));
};

describe("route access boundary", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    apiMocks.apiFetch.mockReset();
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it("does not mount organizer controls for an event reviewer", async () => {
    apiMocks.apiFetch.mockImplementation((path: string) => path === "/api/v1/auth/me"
      ? Promise.resolve({ user: { email: "reviewer@example.com" } })
      : Promise.resolve([{ event: { slug: "summit" }, memberRole: "reviewer", staff: false }]));

    await renderRoute(root, "/e/summit/settings", "event-organizer");

    await vi.waitFor(() => expect(container.textContent).toContain("Access denied"));
    expect(container.textContent).not.toContain("Active organizer control");
  });

  it("does not mount install controls for a signed-in non-staff user", async () => {
    apiMocks.apiFetch.mockResolvedValue({ user: { email: "speaker@example.com" } });

    await renderRoute(root, "/staff", "install-staff");

    await vi.waitFor(() => expect(container.textContent).toContain("Access denied"));
    expect(container.textContent).not.toContain("Active organizer control");
    expect(apiMocks.apiFetch).toHaveBeenCalledTimes(1);
  });

  it("mounts organizer controls for an event owner", async () => {
    apiMocks.apiFetch.mockImplementation((path: string) => path === "/api/v1/auth/me"
      ? Promise.resolve({ user: { email: "owner@example.com" } })
      : Promise.resolve([{ event: { slug: "summit" }, memberRole: "owner", staff: false }]));

    await renderRoute(root, "/e/summit/settings", "event-organizer");

    await vi.waitFor(() => expect(container.textContent).toContain("Active organizer control"));
    expect(container.textContent).not.toContain("Access denied");
  });
});
