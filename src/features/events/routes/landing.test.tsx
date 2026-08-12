import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server.edge";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import EventsHome, { path as eventsPath } from "./events-home";
import LandingPage, { layout, path } from "./landing";

describe("public landing route", () => {
  it("owns the bare root route while the authenticated workspace lives at /events", () => {
    expect(path).toBe("/");
    expect(layout).toBe("bare");
    expect(eventsPath).toBe("/events");
    expect(EventsHome).toBeTypeOf("function");
  });

  it("renders a public product story with explicit workspace and sign-in paths", () => {
    const markup = renderToStaticMarkup(
      createElement(MemoryRouter, null, createElement(LandingPage)),
    );

    expect(markup).toContain("ready on cue.");
    expect(markup).toContain("One connected workflow");
    expect(markup).toContain("Production, not busywork");
    expect(markup).toContain("Explore the live demo.");
    expect(markup).toContain('href="/event/ai-engineer-sandbox"');
    expect(markup).toContain('href="/embed/ai-engineer-sandbox/speakers"');
    expect(markup).toContain('href="/login?returnTo=%2Fe%2Fai-engineer-sandbox%2Fdashboard"');
    expect(markup).toContain('href="/login?returnTo=%2Fe%2Fai-engineer-sandbox%2Fintegrations"');
    expect(markup).toContain("Speaker portal resources");
    expect(markup).toContain("Guide + video embed");
    expect(markup).toContain('href="/login?returnTo=%2Fe%2Fai-engineer-sandbox%2Fportal"');
    expect(markup).not.toContain('returnTo=%2Fe%2Fai-engineer-sandbox%2Fresources');
    expect(markup).toContain('href="/events"');
    expect(markup).toContain('href="/login?returnTo=%2Fevents"');
    expect(markup).not.toContain("Create event");
  });
});
