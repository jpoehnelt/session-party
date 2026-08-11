import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server.edge";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import LoginPage, { requestDemoLogin } from "./auth";

afterEach(() => {
  vi.useRealTimers();
});

describe("hackathon demo login", () => {
  it("offers deterministic organizer, speaker, and reviewer identities", () => {
    const markup = renderToStaticMarkup(
      createElement(MemoryRouter, { initialEntries: ["/login?returnTo=%2Fevents"] }, createElement(LoginPage)),
    );

    expect(markup).toContain("Hackathon demo access");
    expect(markup).toContain("Continue as Organizer — Jordan Alvarez");
    expect(markup).toContain("Continue as Speaker — Priya Raman");
    expect(markup).toContain("Continue as Reviewer — Sam Whitfield");
    expect(markup).toContain("sbek-organizer@example.com");
    expect(markup).toContain("Email me a sign-in link");
    expect(markup).toContain("Account access");
    expect(markup).toContain("Back to Session Party.");
    expect(markup).not.toContain("Organizer access");
  });

  it("bounds a stalled demo authentication request", async () => {
    vi.useFakeTimers();
    const request = vi.fn((_path, options: { readonly signal: AbortSignal }) =>
      new Promise<never>((_resolve, reject) => {
        options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
      }));

    const pending = requestDemoLogin("organizer", "/events", request, 1_000);
    const rejection = expect(pending).rejects.toThrow("Demo sign-in took too long. Try again.");
    await vi.advanceTimersByTimeAsync(1_000);

    await rejection;
    expect(request).toHaveBeenCalledWith("/api/v1/auth/demo", expect.objectContaining({
      method: "POST",
      body: { persona: "organizer", returnTo: "/events" },
      signal: expect.any(AbortSignal),
    }));
  });

  it("clears the deadline after a successful demo authentication request", async () => {
    vi.useFakeTimers();
    let requestSignal: AbortSignal | undefined;
    const request = vi.fn(async (_path, options: { readonly signal: AbortSignal }) => {
      requestSignal = options.signal;
      return { returnTo: "/e/ai-engineer-sandbox/dashboard" };
    });

    await expect(requestDemoLogin("organizer", undefined, request, 1_000)).resolves.toEqual({
      returnTo: "/e/ai-engineer-sandbox/dashboard",
    });
    await vi.advanceTimersByTimeAsync(1_000);

    expect(requestSignal?.aborted).toBe(false);
  });
});
