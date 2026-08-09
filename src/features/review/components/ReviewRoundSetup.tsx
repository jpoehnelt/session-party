import { useRef, useState } from "react";
import { Badge, Button, Card, Input, Select } from "@/ui";
import type { ReviewRound, ReviewRubric } from "../schema";
import { advanceReviewRoundRequest, createReviewRoundRequest } from "../routes/mutations";

const starterRubric = {
  criteria: [
    { key: "relevance", label: "Relevance", description: "Fit for this event and audience.", max: 5 },
    { key: "clarity", label: "Clarity", description: "A specific, understandable proposal.", max: 5 },
    { key: "impact", label: "Audience impact", description: "Likely value for attendees.", max: 5 },
  ],
} as const satisfies ReviewRubric;

const requestId = (operation: string) => `${operation}-${crypto.randomUUID()}`;

const statusTone = {
  pending: "neutral",
  active: "accent",
  complete: "success",
} as const;

export function ReviewRoundSetup({
  eventId,
  rounds,
  onMutationCommitted,
}: {
  readonly eventId: string;
  readonly rounds: readonly ReviewRound[];
  readonly onMutationCommitted: () => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [initialStatus, setInitialStatus] = useState<"pending" | "active">("pending");
  const [pending, setPending] = useState<"create" | string>();
  const [error, setError] = useState<string>();
  const createKey = useRef(`review-round-create-${crypto.randomUUID()}`);
  const transitionKeys = useRef(new Map<string, string>());
  const ordered = [...rounds].sort((left, right) => left.order - right.order);
  const activeRound = ordered.find((round) => round.status === "active");
  const firstPending = ordered.find((round) => round.status === "pending");
  const canCreateActive = !activeRound && ordered.every((round) => round.status === "complete");

  const commit = async (key: "create" | string, run: () => Promise<unknown>) => {
    setPending(key);
    setError(undefined);
    let saved = false;
    try {
      await run();
      saved = true;
      await onMutationCommitted();
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "The review-round change could not be completed.";
      setError(saved ? `The change was saved, but current rounds could not reload: ${message}` : message);
    } finally {
      setPending(undefined);
    }
  };

  const createRound = () => {
    const trimmedName = name.trim();
    if (!trimmedName || (initialStatus === "active" && !canCreateActive)) return;
    void commit("create", async () => {
      await createReviewRoundRequest({
        eventId,
        name: trimmedName,
        initialStatus,
        rubric: starterRubric,
        expectedRoundCount: ordered.length,
        idempotencyKey: createKey.current,
        requestId: requestId("review-round-create"),
      });
      createKey.current = `review-round-create-${crypto.randomUUID()}`;
      setName("");
      setInitialStatus("pending");
    });
  };

  const transition = (round: ReviewRound) => {
    const nextRound = round.status === "active"
      ? ordered.find((candidate) => candidate.status === "pending" && candidate.order > round.order)
      : undefined;
    const transitionKeyId = `${round.id}:${round.version}:${nextRound?.id ?? "none"}:${nextRound?.version ?? 0}`;
    let idempotencyKey = transitionKeys.current.get(transitionKeyId);
    if (!idempotencyKey) {
      idempotencyKey = `review-round-advance-${crypto.randomUUID()}`;
      transitionKeys.current.set(transitionKeyId, idempotencyKey);
    }
    void commit(round.id, () => advanceReviewRoundRequest({
      eventId,
      roundId: round.id,
      expectedVersion: round.version,
      nextRoundId: nextRound?.id ?? null,
      expectedNextVersion: nextRound?.version ?? 0,
      idempotencyKey,
      requestId: requestId("review-round-advance"),
    }));
  };

  return (
    <Card className="[&>header]:bg-surface-muted [&>header]:text-ink [&>header_h3]:text-ink" title="Review rounds / handoff sequence">
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.5fr)_minmax(18rem,0.8fr)]">
        <div>
          {ordered.length === 0 ? (
            <p className="text-sm text-ink-secondary">No rounds yet. Create the first round to begin organizer review.</p>
          ) : (
            <ol className="space-y-2" aria-label="Authoritative review rounds">
              {ordered.map((round) => {
                const canActivate = round.status === "pending" && !activeRound && firstPending?.id === round.id;
                const canAdvance = round.status === "active";
                const nextRound = canAdvance
                  ? ordered.find((candidate) => candidate.status === "pending" && candidate.order > round.order)
                  : undefined;
                return (
                  <li key={round.id} className="flex flex-wrap items-center justify-between gap-3 rounded-control border-2 border-line-strong bg-surface-muted px-3 py-3 shadow-[3px_3px_0_#171714]">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-black text-ink"><span className="mr-2 bg-ink px-1.5 py-1 font-mono text-[10px] text-production-lime">{String(round.order).padStart(2, "0")}</span>{round.name}</p>
                      <p className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-ink-faint">
                        <Badge tone={statusTone[round.status]}>{round.status}</Badge>
                        <span>version {round.version}</span>
                        <span aria-hidden="true">·</span>
                        <span>{round.rubric.criteria.length} criteria</span>
                      </p>
                    </div>
                    {(canActivate || canAdvance) && (
                      <Button
                        variant={canAdvance ? "primary" : "secondary"}
                        disabled={pending !== undefined}
                        onClick={() => transition(round)}
                      >
                        {pending === round.id
                          ? "Saving…"
                          : canActivate
                            ? "Activate round"
                            : nextRound
                              ? `Complete & activate ${nextRound.name}`
                              : "Complete round"}
                      </Button>
                    )}
                  </li>
                );
              })}
            </ol>
          )}
        </div>

        <div className="space-y-3 border-t-2 border-line-strong bg-production-sky/30 p-4 xl:border-l-2 xl:border-t-0 xl:pt-4">
          <Input
            label="New round name"
            value={name}
            maxLength={120}
            placeholder="Final program review"
            onChange={(event) => setName(event.target.value)}
          />
          <Select
            label="Initial state"
            value={initialStatus}
            onChange={(event) => setInitialStatus(event.target.value as "pending" | "active")}
          >
            <option value="pending">Pending (configure first)</option>
            <option value="active" disabled={!canCreateActive}>Active now</option>
          </Select>
          <p className="text-xs leading-5 text-ink-faint">Starter rubric: Relevance, Clarity, and Audience impact. Scores are bounded from 1–5.</p>
          <Button disabled={!name.trim() || pending !== undefined || (initialStatus === "active" && !canCreateActive)} onClick={createRound}>
            {pending === "create" ? "Creating…" : "Create round"}
          </Button>
        </div>
      </div>
      {error && <p role="alert" className="mt-4 border-2 border-line-strong bg-danger-soft p-3 text-sm font-bold text-danger shadow-[3px_3px_0_#171714]">{error}</p>}
    </Card>
  );
}
