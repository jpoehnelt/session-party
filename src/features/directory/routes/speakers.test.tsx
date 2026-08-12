import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server.edge";
import { describe, expect, it } from "vitest";
import SpeakerDirectoryPageRoute, { path, speakerDirectoryUrl } from "./speakers";

describe("speaker directory route", () => {
  it("builds stable paginated filter URLs", () => {
    expect(speakerDirectoryUrl({
      query: "  Analytical Engines  ",
      eventId: "event-two",
      status: "spoke",
      page: 3,
      pageSize: 50,
    })).toBe("/api/v1/install/speakers?query=Analytical+Engines&eventId=event-two&status=spoke&page=3&pageSize=50");
  });

  it("exports the installation route and explains the non-merging identity model", () => {
    expect(path).toBe("/speaker-directory");
    const markup = renderToStaticMarkup(createElement(SpeakerDirectoryPageRoute));
    expect(markup).toContain("Speaker directory");
    expect(markup).toContain("grouped only by normalized email");
    expect(markup).toContain("unmerged");
  });
});
