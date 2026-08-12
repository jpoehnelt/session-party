import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { userEvent } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FIXED_DAY_START, scheduledAgendaFixture } from "../fixtures";
import { AgendaBoard } from "./AgendaBoard";
import { LiveShowControl } from "./LiveShowControl";

describe("multi-day agenda builder", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it("renders room lanes and switches the active day to a different session set", async () => {
    const [first, second] = scheduledAgendaFixture.snapshot.talks;
    const snapshot = {
      ...scheduledAgendaFixture.snapshot,
      talks: [first!, { ...second!, startsAt: FIXED_DAY_START + 86_400_000 }],
    };
    await act(async () => {
      root.render(
        <AgendaBoard
          agenda={snapshot}
          view="day"
          intent={{
            clientIntentId: null,
            connection: "connected",
            acknowledgement: "idle",
            sentAt: null,
            message: null,
          }}
          onCreateTalk={vi.fn()}
          onSelectTalk={vi.fn()}
          onMoveTalk={vi.fn()}
        />,
      );
    });

    await vi.waitFor(() => expect(container.textContent).toContain("Effects at scale"));
    expect(container.textContent).not.toContain("Durable workflows without folklore");
    expect(container.querySelectorAll('section[aria-label*="Harbor"]').length).toBeGreaterThan(0);
    const dayButtons = [...container.querySelectorAll<HTMLButtonElement>('fieldset button')];
    expect(dayButtons).toHaveLength(2);
    await act(async () => userEvent.click(dayButtons[1]!));
    expect(container.textContent).toContain("Durable workflows without folklore");
    expect(container.textContent).not.toContain("Effects at scale");
  });

  it("exposes accepted-session auto-scheduling directly from the backlog", async () => {
    const onAutoScheduleProposal = vi.fn();
    const proposal = scheduledAgendaFixture.snapshot.backlog[0]!;
    await act(async () => {
      root.render(
        <AgendaBoard
          agenda={scheduledAgendaFixture.snapshot}
          view="list"
          intent={{
            clientIntentId: null,
            connection: "connected",
            acknowledgement: "idle",
            sentAt: null,
            message: null,
          }}
          onCreateTalk={vi.fn()}
          onAutoScheduleProposal={onAutoScheduleProposal}
          onSelectTalk={vi.fn()}
          onMoveTalk={vi.fn()}
        />,
      );
    });

    const action = container.querySelector<HTMLButtonElement>(
      `button[aria-label="Auto-schedule accepted session ${proposal.title}"]`,
    );
    expect(action).not.toBeNull();
    await act(async () => userEvent.click(action!));
    expect(onAutoScheduleProposal).toHaveBeenCalledWith(proposal);
  });

  it("clears the show-control selection after a reset", async () => {
    const state = {
      revision: 2,
      status: "ready" as const,
      currentTalkId: scheduledAgendaFixture.snapshot.talks[0]!.id,
      startedAt: null,
      holdStartedAt: null,
      accumulatedHoldMs: 0,
      updatedAt: FIXED_DAY_START,
      updatedBy: null,
    };
    const renderControl = (currentState: typeof state | { readonly currentTalkId: null; readonly revision: number; readonly status: "idle" }) => (
      <LiveShowControl
        agenda={scheduledAgendaFixture.snapshot}
        state={{ ...state, ...currentState }}
        cues={[]}
        onControl={vi.fn()}
        onCue={vi.fn()}
        onSurfaceChange={vi.fn()}
      />
    );
    await act(async () => root.render(renderControl(state)));
    const selection = container.querySelector<HTMLSelectElement>("select");
    expect(selection?.value).toBe(state.currentTalkId);

    await act(async () => root.render(renderControl({ currentTalkId: null, revision: 3, status: "idle" })));
    expect(selection?.value).toBe("");
  });
});
