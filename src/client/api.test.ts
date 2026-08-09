import { afterEach, describe, expect, it, vi } from "vitest";
import { apiFetch } from "./api";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("apiFetch", () => {
  it("prefers a public top-level message over a tagged error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ message: "You need to sign in", error: "Unauthenticated" }), {
          status: 401,
          statusText: "Unauthorized",
        }),
      ),
    );

    await expect(apiFetch("/api/v1/events")).rejects.toEqual(
      expect.objectContaining({ name: "ApiError", message: "You need to sign in", status: 401 }),
    );
  });

  it("coalesces only overlapping identical GET requests", async () => {
    let resolveResponse: (response: Response) => void;
    const pendingResponse = new Promise<Response>((resolve) => {
      resolveResponse = resolve;
    });
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(() => pendingResponse)
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "event-a" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const first = apiFetch<{ id: string }>("/api/v1/events/event-a");
    const second = apiFetch<{ id: string }>("/api/v1/events/event-a");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    resolveResponse!(new Response(JSON.stringify({ id: "event-a" }), { status: 200 }));
    await expect(Promise.all([first, second])).resolves.toEqual([{ id: "event-a" }, { id: "event-a" }]);

    await apiFetch("/api/v1/events/event-a");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not coalesce mutations", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await Promise.all([
      apiFetch("/api/v1/events", { method: "POST", body: { name: "One" } }),
      apiFetch("/api/v1/events", { method: "POST", body: { name: "Two" } }),
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
