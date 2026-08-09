import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server.edge";
import { describe, expect, it, vi } from "vitest";
import {
  buildEnqueueRequest,
  ScheduleControl,
} from "./comms";

const baseRequest = {
  templateId: "template-1",
  recipientSpeakerIds: ["speaker-1"],
  replyToEmail: "team@example.com",
  idempotencyKey: "comms-enqueue-schedule-001",
} as const;

describe("communications scheduling control", () => {
  it("renders explicit send-now and event-timezone scheduling controls", () => {
    const markup = renderToStaticMarkup(createElement(ScheduleControl, {
      mode: "scheduled",
      scheduledWallTime: "2026-08-12T10:30",
      timezone: "America/Los_Angeles",
      onModeChange: vi.fn(),
      onScheduledWallTimeChange: vi.fn(),
    }));

    expect(markup).toContain("Send now");
    expect(markup).toContain("Schedule for later");
    expect(markup).toContain('type="datetime-local"');
    expect(markup).toContain('value="2026-08-12T10:30"');
    expect(markup).toContain("America/Los_Angeles");
  });

  it("wires send-now to null and scheduled event wall time to a validated epoch", () => {
    const now = Date.parse("2026-08-12T16:00:00.000Z");
    expect(buildEnqueueRequest(baseRequest, "now", "", "America/Los_Angeles", now)).toEqual({
      ...baseRequest,
      scheduledFor: null,
    });
    expect(buildEnqueueRequest(
      baseRequest,
      "scheduled",
      "2026-08-12T10:30",
      "America/Los_Angeles",
      now,
    )).toEqual({
      ...baseRequest,
      scheduledFor: Date.parse("2026-08-12T17:30:00.000Z"),
    });
  });

  it("rejects empty, past, and nonexistent scheduled wall times", () => {
    const now = Date.parse("2026-08-12T18:00:00.000Z");
    expect(() => buildEnqueueRequest(baseRequest, "scheduled", "", "America/Los_Angeles", now))
      .toThrow("Choose a delivery date and time.");
    expect(() => buildEnqueueRequest(
      baseRequest,
      "scheduled",
      "2026-08-12T10:30",
      "America/Los_Angeles",
      now,
    )).toThrow("Scheduled delivery must be in the future.");
    expect(() => buildEnqueueRequest(
      baseRequest,
      "scheduled",
      "2026-03-08T02:30",
      "America/Los_Angeles",
      Date.parse("2026-03-08T08:00:00.000Z"),
    )).toThrow("does not exist in America/Los_Angeles because of a timezone transition.");
  });
});
