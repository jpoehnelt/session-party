import { renderToStaticMarkup } from "react-dom/server.edge";
import { describe, expect, it, vi } from "vitest";
import { deterministicAgendaIds, FIXED_NOW, scheduledAgendaFixture } from "../fixtures";
import { AgendaBoard } from "./AgendaBoard";
import { LiveShowControl } from "./LiveShowControl";

describe("agenda realtime controls", () => {
  it("renders collaborator presence and a remote ghost preview", () => {
    const html = renderToStaticMarkup(
      <AgendaBoard
        agenda={scheduledAgendaFixture.snapshot}
        view="room"
        intent={{
          clientIntentId: null,
          connection: "connected",
          acknowledgement: "idle",
          sentAt: null,
          message: null,
        }}
        collaborators={[{
          userId: "producer-jamie",
          name: "Jamie",
          talkId: deterministicAgendaIds.talkA,
          preview: {
            trackId: deterministicAgendaIds.trackSystems,
            roomId: deterministicAgendaIds.roomSummit,
            startsAt: FIXED_NOW,
            durationMin: 45,
          },
        }]}
        presence={[{ userId: "producer-jamie", name: "Jamie", surface: "agenda" }]}
        onCreateTalk={vi.fn()}
        onSelectTalk={vi.fn()}
        onMoveTalk={vi.fn()}
      />,
    );

    expect(html).toContain("Jamie · agenda");
    expect(html).toContain("Live move · Jamie");
    expect(html).toContain("Effects at scale");
  });

  it("renders synchronized show state, next-up context, and the cue bus", () => {
    const html = renderToStaticMarkup(
      <LiveShowControl
        agenda={scheduledAgendaFixture.snapshot}
        state={{
          revision: 4,
          status: "running",
          currentTalkId: deterministicAgendaIds.talkA,
          startedAt: FIXED_NOW,
          holdStartedAt: null,
          accumulatedHoldMs: 0,
          updatedAt: FIXED_NOW,
          updatedBy: { userId: "producer-jamie", name: "Jamie" },
        }}
        cues={[{
          id: "cue-five-minutes",
          kind: "five_minutes",
          target: { kind: "crew" },
          message: "Five minutes remaining.",
          sentAt: FIXED_NOW,
          expiresAt: FIXED_NOW + 60_000,
          by: { userId: "producer-jamie", name: "Jamie" },
        }]}
        onControl={vi.fn()}
        onCue={vi.fn()}
        onSurfaceChange={vi.fn()}
      />,
    );

    expect(html).toContain("Live show control");
    expect(html).toContain("Effects at scale");
    expect(html).toContain("Durable workflows without folklore");
    expect(html).toContain("Cue bus");
    expect(html).toContain("Five minutes remaining.");
  });
});
