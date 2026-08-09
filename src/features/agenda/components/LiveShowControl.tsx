import { useEffect, useMemo, useState } from "react";
import type {
  ShowCue,
  ShowCueKind,
  ShowCueTarget,
  ShowRunState,
} from "contracts/protocol";
import { Badge, Button, Card, Input, Select } from "@/ui";
import type { AgendaSnapshot } from "../schema";

type ShowAction = "select" | "start" | "hold" | "resume" | "complete" | "reset";

interface LiveShowControlProps {
  readonly agenda: AgendaSnapshot;
  readonly state: ShowRunState;
  readonly cues: readonly ShowCue[];
  readonly disabled?: boolean;
  readonly onControl: (action: ShowAction, talkId?: string) => void;
  readonly onCue: (kind: ShowCueKind, target: ShowCueTarget, message: string) => void;
  readonly onSurfaceChange: (surface: string) => void;
}

const cueLabels: Record<ShowCueKind, string> = {
  on_deck: "On deck",
  five_minutes: "Five minutes",
  start: "Start",
  hold: "Hold",
  room_change: "Room change",
  custom: "Custom",
};

const formatDuration = (milliseconds: number) => {
  const totalSeconds = Math.max(0, Math.floor(Math.abs(milliseconds) / 1_000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${milliseconds < 0 ? "+" : ""}${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
};

export function LiveShowControl({
  agenda,
  state,
  cues,
  disabled = false,
  onControl,
  onCue,
  onSurfaceChange,
}: LiveShowControlProps) {
  const [now, setNow] = useState(Date.now());
  const [selectedTalkId, setSelectedTalkId] = useState(state.currentTalkId ?? "");
  const [screen, setScreen] = useState("control");
  const [target, setTarget] = useState("crew");
  const [customCue, setCustomCue] = useState("");

  useEffect(() => {
    const interval = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(interval);
  }, []);
  useEffect(() => {
    if (state.currentTalkId) setSelectedTalkId(state.currentTalkId);
  }, [state.currentTalkId]);
  useEffect(() => {
    onSurfaceChange(screen === "control" ? "show:control" : `show:room:${screen}`);
    return () => onSurfaceChange("agenda");
  }, [onSurfaceChange, screen]);

  const talks = useMemo(
    () => [...agenda.talks]
      .filter(({ status, startsAt }) => status !== "cancelled" && startsAt !== null)
      .sort((left, right) => left.startsAt! - right.startsAt! || left.title.localeCompare(right.title)),
    [agenda.talks],
  );
  const currentIndex = talks.findIndex(({ id }) => id === state.currentTalkId);
  const currentTalk = currentIndex < 0 ? null : talks[currentIndex]!;
  const nextTalk = currentIndex < 0
    ? talks.find(({ startsAt }) => startsAt !== null && startsAt >= now) ?? talks[0] ?? null
    : talks[currentIndex + 1] ?? null;
  const heldFor = state.holdStartedAt === null ? 0 : Math.max(0, now - state.holdStartedAt);
  const elapsed = state.startedAt === null
    ? 0
    : Math.max(0, now - state.startedAt - state.accumulatedHoldMs - heldFor);
  const remaining = currentTalk ? currentTalk.durationMin * 60_000 - elapsed : 0;
  const cueTarget: ShowCueTarget = target === "crew"
    ? { kind: "crew" }
    : { kind: "room", value: target };

  const sendPresetCue = (kind: ShowCueKind) => {
    const subject = kind === "on_deck" ? nextTalk : currentTalk;
    const message = kind === "on_deck"
      ? `${subject?.title ?? "Next session"} is on deck.`
      : kind === "five_minutes"
        ? `${subject?.title ?? "Current session"} has five minutes remaining.`
        : kind === "start"
          ? `Start ${subject?.title ?? "the current session"}.`
          : kind === "hold"
            ? `Hold ${subject?.title ?? "the current session"}. Stand by for the next cue.`
            : `Move ${subject?.title ?? "the current session"} to the selected room.`;
    onCue(kind, cueTarget, message);
  };

  const statusTone = state.status === "running"
    ? "success"
    : state.status === "held"
      ? "warning"
      : state.status === "completed"
        ? "accent"
        : "neutral";

  return (
    <div className="space-y-6">
      <section className="border-2 border-line-strong bg-ink p-5 text-on-accent shadow-[7px_7px_0_#7857ff]">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-[10px] font-black uppercase tracking-[0.2em] text-production-lime">Live show control</p>
            <h2 className="mt-2 text-3xl font-black tracking-[-0.05em]">{agenda.eventName}</h2>
          </div>
          <div className="flex items-center gap-2">
            <Badge tone={statusTone}>{state.status}</Badge>
            <span className="text-xs font-bold text-on-accent/60">Cue r{state.revision}</span>
          </div>
        </div>
        <div className="mt-6 grid gap-4 lg:grid-cols-[minmax(0,1fr)_14rem]">
          <div className="border-2 border-on-accent bg-production-lime p-5 text-ink shadow-[4px_4px_0_#7857ff]">
            <p className="text-[10px] font-black uppercase tracking-[0.16em]">Now on stage</p>
            <p className="mt-2 text-2xl font-black tracking-[-0.04em]">{currentTalk?.title ?? "Select the first session"}</p>
            <p className="mt-1 text-sm font-bold text-ink/70">{currentTalk?.speakerNames.join(", ") || "The run of show is standing by."}</p>
          </div>
          <div className={`grid place-items-center border-2 border-on-accent p-4 text-center ${remaining < 0 ? "bg-production-coral text-ink" : "bg-surface text-ink"}`}>
            <p className="text-[10px] font-black uppercase tracking-[0.14em]">{remaining < 0 ? "Over" : "Remaining"}</p>
            <p className="mt-1 font-mono text-4xl font-black tracking-[-0.06em]">{formatDuration(remaining)}</p>
          </div>
        </div>
      </section>

      <section className="grid gap-5 xl:grid-cols-[minmax(0,1.2fr)_minmax(20rem,0.8fr)]">
        <Card title="Showcaller controls">
          <div className="space-y-4">
            <Select
              label="Current session"
              value={selectedTalkId}
              onChange={(event) => setSelectedTalkId(event.target.value)}
            >
              <option value="">Choose a scheduled session</option>
              {talks.map((talk) => <option key={talk.id} value={talk.id}>{talk.title}</option>)}
            </Select>
            <div className="flex flex-wrap gap-2">
              <Button disabled={disabled || !selectedTalkId || state.status === "running" || state.status === "held"} variant="secondary" onClick={() => onControl("select", selectedTalkId)}>Set ready</Button>
              <Button disabled={disabled || !selectedTalkId || state.status === "running" || state.status === "held"} onClick={() => onControl("start", selectedTalkId)}>Start</Button>
              {state.status === "held" ? (
                <Button disabled={disabled} variant="secondary" onClick={() => onControl("resume")}>Resume</Button>
              ) : (
                <Button disabled={disabled || state.status !== "running"} variant="secondary" onClick={() => onControl("hold")}>Hold</Button>
              )}
              <Button disabled={disabled || (state.status !== "running" && state.status !== "held")} variant="secondary" onClick={() => onControl("complete")}>Complete</Button>
              <Button disabled={disabled || state.status === "idle"} variant="danger" onClick={() => onControl("reset")}>Reset</Button>
            </div>
            <div className="border-l-4 border-production-sky bg-surface-muted px-4 py-3">
              <p className="text-[10px] font-black uppercase tracking-[0.12em] text-ink-secondary">Next on deck</p>
              <p className="mt-1 font-black text-ink">{nextTalk?.title ?? "End of run"}</p>
              <p className="text-xs font-semibold text-ink-secondary">{nextTalk?.speakerNames.join(", ")}</p>
            </div>
            <Select
              label="This screen"
              value={screen}
              onChange={(event) => setScreen(event.target.value)}
              hint="Room mode receives only cues for that room plus synchronized show state."
            >
              <option value="control">Show control desk</option>
              {agenda.rooms.map((room) => <option key={room.id} value={room.id}>{room.name} display</option>)}
            </Select>
          </div>
        </Card>

        <Card title="Cue bus">
          <div className="space-y-4">
            <Select label="Cue target" value={target} onChange={(event) => setTarget(event.target.value)}>
              <option value="crew">All connected crew</option>
              {agenda.rooms.map((room) => <option key={room.id} value={room.id}>{room.name}</option>)}
            </Select>
            <div className="grid grid-cols-2 gap-2">
              {(["on_deck", "five_minutes", "start", "hold"] as const).map((kind) => (
                <Button key={kind} disabled={disabled} variant="secondary" onClick={() => sendPresetCue(kind)}>
                  {cueLabels[kind]}
                </Button>
              ))}
            </div>
            <Input
              label="Custom cue"
              maxLength={500}
              value={customCue}
              onChange={(event) => setCustomCue(event.target.value)}
              placeholder="Stand by in Room B…"
            />
            <Button
              className="w-full"
              disabled={disabled || customCue.trim().length === 0}
              onClick={() => {
                onCue("custom", cueTarget, customCue.trim());
                setCustomCue("");
              }}
            >
              Send cue
            </Button>
          </div>
        </Card>
      </section>

      {cues.length > 0 && (
        <section aria-live="assertive" className="space-y-2">
          <p className="text-[10px] font-black uppercase tracking-[0.14em] text-ink-secondary">Latest cues</p>
          {cues.slice(0, 4).map((cue) => (
            <div key={cue.id} className="border-2 border-line-strong bg-production-yellow p-4 shadow-[3px_3px_0_#171714]">
              <div className="flex items-center justify-between gap-3">
                <Badge tone="warning">{cueLabels[cue.kind]}</Badge>
                <span className="text-[10px] font-black uppercase tracking-[0.08em] text-ink-secondary">{cue.by.name}</span>
              </div>
              <p className="mt-2 text-lg font-black text-ink">{cue.message}</p>
            </div>
          ))}
        </section>
      )}
    </div>
  );
}
