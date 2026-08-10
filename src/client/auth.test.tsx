import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server.edge";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import LoginPage from "./auth";

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
  });
});
