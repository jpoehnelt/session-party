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

  it("passes abort signals through and keeps cancellable GET requests independent", async () => {
    const fetchMock = vi.fn().mockImplementation(
      () => Promise.resolve(new Response(JSON.stringify({ id: "event-a" }), { status: 200 })),
    );
    vi.stubGlobal("fetch", fetchMock);
    const firstController = new AbortController();
    const secondController = new AbortController();

    await Promise.all([
      apiFetch("/api/v1/events/event-a", { signal: firstController.signal }),
      apiFetch("/api/v1/events/event-a", { signal: secondController.signal }),
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]![1]).toEqual(expect.objectContaining({ signal: firstController.signal }));
    expect(fetchMock.mock.calls[1]![1]).toEqual(expect.objectContaining({ signal: secondController.signal }));
  });

  it("surfaces request cancellation as an abort instead of an API failure", async () => {
    const fetchMock = vi.fn().mockImplementation((_path: string, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
      }));
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();

    const request = apiFetch("/api/v1/events/event-a", { signal: controller.signal });
    controller.abort();

    await expect(request).rejects.toEqual(expect.objectContaining({ name: "AbortError" }));
  });
});
