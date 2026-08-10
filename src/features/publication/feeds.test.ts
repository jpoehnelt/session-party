import { describe, expect, it } from "vitest";
import type { PublishedAgenda } from "@/features/agenda/schema";
import {
  publishedScheduleIcsPath,
  publishedScheduleJsonPath,
  publishedSessionIcsPath,
  renderPublishedCalendar,
} from "./feeds";

const agenda: PublishedAgenda = {
  eventId: "event-feeds",
  eventName: "Systems, Scale & Reliability",
  eventSlug: "systems-summit",
  timezone: "America/Los_Angeles",
  location: "Harbor Hall",
  revision: 4,
  publishedAt: Date.UTC(2026, 7, 10, 15),
  talks: [
    {
      id: "talk-effects",
      title: "Effects, queues; and durable workflows",
      description: "A production case study.\nBring difficult questions.",
      track: "Systems; Reliability",
      room: "Main, Stage",
      startsAt: Date.UTC(2026, 7, 11, 16),
      durationMin: 45,
      speakerNames: ["Ada Rivera", "Renée 山田"],
    },
    {
      id: "talk-closing",
      title: "Closing notes",
      description: null,
      track: null,
      room: null,
      startsAt: Date.UTC(2026, 7, 11, 17),
      durationMin: 15,
      speakerNames: [],
    },
  ],
};

describe("published schedule feeds", () => {
  it("renders standards-shaped calendar events with stable identities and revision sequences", () => {
    const calendar = renderPublishedCalendar(agenda);
    const unfolded = calendar.replace(/\r\n[ \t]/g, "");

    expect(unfolded).toContain("UID:talk-effects@event-feeds.session-party");
    expect(unfolded).toContain("SEQUENCE:4");
    expect(unfolded).toContain("DTSTART:20260811T160000Z");
    expect(unfolded).toContain("DTEND:20260811T164500Z");
    expect(unfolded).toContain("SUMMARY:Effects\\, queues\\; and durable workflows");
    expect(unfolded).toContain("DESCRIPTION:A production case study.\\nBring difficult questions.\\n\\nSpeakers: Ada Rivera\\, Renée 山田");
    expect(unfolded).toContain("LOCATION:Main\\, Stage\\, Harbor Hall");
    expect(unfolded).toContain("CATEGORIES:Systems\\; Reliability");
    expect(unfolded.match(/BEGIN:VEVENT/g)).toHaveLength(2);
    expect(calendar.endsWith("END:VCALENDAR\r\n")).toBe(true);
    for (const line of calendar.split("\r\n")) {
      expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75);
    }
  });

  it("can render one published session without changing its calendar identity", () => {
    const calendar = renderPublishedCalendar(agenda, [agenda.talks[1]!]);

    expect(calendar).toContain("UID:talk-closing@event-feeds.session-party");
    expect(calendar).not.toContain("UID:talk-effects@event-feeds.session-party");
    expect(calendar).toContain("LOCATION:Harbor Hall");
  });

  it("builds encoded stable feed paths", () => {
    expect(publishedScheduleIcsPath("systems-summit")).toBe("/events/systems-summit/schedule.ics");
    expect(publishedScheduleJsonPath("systems-summit")).toBe("/events/systems-summit/schedule.json");
    expect(publishedSessionIcsPath("systems-summit", "talk_1"))
      .toBe("/events/systems-summit/sessions/talk_1.ics");
  });
});
