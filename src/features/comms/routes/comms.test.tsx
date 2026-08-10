import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server.edge";
import { describe, expect, it, vi } from "vitest";
import {
  buildEnqueueRequest,
  buildMailtoDraft,
  campaignConfirmationIdentity,
  createCampaignEnqueueCoordinator,
  ScheduleControl,
} from "./comms";
const baseRequest = {
  templateId: "template-1",
  expectedTemplateVersion: 3,
  recipientSpeakerIds: ["speaker-1"],
  replyToEmail: "team@example.com",
  idempotencyKey: "comms-enqueue-schedule-001",
} as const;

const campaignIdentity = (recipientSpeakerIds: readonly string[] = ["speaker-1"]) =>
  campaignConfirmationIdentity({
    eventId: "event-1",
    templateId: "template-1",
    templateVersion: 3,
    recipientSpeakerIds,
    replyToEmail: "team@example.com",
    sendMode: "now",
    scheduledWallTime: "",
    timezone: "America/Los_Angeles",
  });

describe("communications scheduling control", () => {
  it("builds a human-controlled mail draft without dispatching it", () => {
    expect(buildMailtoDraft({
      recipientEmail: "speaker@example.com",
      subject: "Slides & employer approval",
      text: "Hi Ada,\n\nCould you confirm both items?",
    })).toBe(
      "mailto:speaker%40example.com?subject=Slides%20%26%20employer%20approval&body=Hi%20Ada%2C%0A%0ACould%20you%20confirm%20both%20items%3F",
    );
  });

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

  it("single-flights activation, keeps an ambiguous retry key, and rotates the key after success", async () => {
    const createKey = vi.fn()
      .mockReturnValueOnce("enqueue-key-1")
      .mockReturnValueOnce("enqueue-key-2");
    const coordinator = createCampaignEnqueueCoordinator(createKey);
    const request = buildEnqueueRequest({
      templateId: "template-1",
      expectedTemplateVersion: 3,
      recipientSpeakerIds: ["speaker-1"],
      replyToEmail: "team@example.com",
    }, "now", "", "America/Los_Angeles");
    let rejectFirst!: (error: Error) => void;
    const ambiguous = new Promise<{ deliveries: readonly unknown[] }>((_resolve, reject) => {
      rejectFirst = reject;
    });
    const submit = vi.fn()
      .mockReturnValueOnce(ambiguous)
      .mockResolvedValue({ deliveries: [] });

    const firstActivation = coordinator.run(campaignIdentity(), request, submit);
    const doubleActivation = coordinator.run(campaignIdentity(), request, submit);

    expect(doubleActivation).toBe(firstActivation);
    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit.mock.calls[0]?.[0]).toMatchObject({ idempotencyKey: "enqueue-key-1" });

    rejectFirst(new Error("Response was lost after commit"));
    await expect(firstActivation).rejects.toThrow("Response was lost after commit");

    await coordinator.run(campaignIdentity(), request, submit);
    expect(submit).toHaveBeenCalledTimes(2);
    expect(submit.mock.calls[1]?.[0]).toEqual(submit.mock.calls[0]?.[0]);
    expect(createKey).toHaveBeenCalledTimes(1);

    await coordinator.run(campaignIdentity(), request, submit);
    expect(submit).toHaveBeenCalledTimes(3);
    expect(submit.mock.calls[2]?.[0]).toMatchObject({
      ...request,
      idempotencyKey: "enqueue-key-2",
    });
    expect(submit.mock.calls[2]?.[0].idempotencyKey).not.toBe(
      submit.mock.calls[1]?.[0].idempotencyKey,
    );
    expect(createKey).toHaveBeenCalledTimes(2);
  });

  it("treats recipient order as one confirmation and campaign changes as new confirmation identities", () => {
    const original = campaignIdentity(["speaker-2", "speaker-1"]);

    expect(campaignIdentity(["speaker-1", "speaker-2"])).toBe(original);
    expect(campaignConfirmationIdentity({
      eventId: "event-1",
      templateId: "template-1",
      templateVersion: 3,
      recipientSpeakerIds: ["speaker-1", "speaker-2"],
      replyToEmail: "other@example.com",
      sendMode: "now",
      scheduledWallTime: "",
      timezone: "America/Los_Angeles",
    })).not.toBe(original);
  });
});
