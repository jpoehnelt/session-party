import { useRef, useState } from "react";
import { Badge, Button, Card, Checkbox, Input, Select, Textarea } from "@/ui";
import type { ReviewCriterionType, ReviewRound, ReviewRubric, RubricCriterion } from "../schema";
import {
  advanceReviewRoundRequest,
  createReviewRoundRequest,
  updateReviewRoundRequest,
} from "../routes/mutations";

const starterRubric = {
  criteria: [
    { key: "relevance", label: "Relevance", description: "Fit for this event and audience.", type: "numeric", weight: 1, required: true, max: 5 },
    { key: "clarity", label: "Clarity", description: "A specific, understandable proposal.", type: "numeric", weight: 1, required: true, max: 5 },
    { key: "impact", label: "Audience impact", description: "Likely value for attendees.", type: "numeric", weight: 1, required: true, max: 5 },
  ],
} as const satisfies ReviewRubric;

const requestId = (operation: string) => `${operation}-${crypto.randomUUID()}`;
const criterionKey = () => `criterion_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;

const statusTone = {
  pending: "neutral",
  active: "accent",
  complete: "success",
} as const;

const localDateTime = (timestamp: number | null): string => {
  if (timestamp === null) return "";
  const date = new Date(timestamp);
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(timestamp - offset).toISOString().slice(0, 16);
};

const timestamp = (value: string): number | null => value ? new Date(value).getTime() : null;

const newCriterion = (type: ReviewCriterionType): RubricCriterion => ({
  key: criterionKey(),
  label: type === "numeric" ? "Numeric criterion" : type === "dropdown" ? "Dropdown criterion" : "Written rationale",
  type,
  weight: type === "text" ? 0 : 1,
  required: true,
  max: 5,
  ...(type === "dropdown" ? {
    options: [
      { value: "weak", label: "Weak", score: 1 },
      { value: "solid", label: "Solid", score: 3 },
      { value: "exceptional", label: "Exceptional", score: 5 },
    ],
  } : {}),
});

export function ReviewRoundSetup({
  eventId,
  rounds,
  onMutationCommitted,
}: {
  readonly eventId: string;
  readonly rounds: readonly ReviewRound[];
  readonly onMutationCommitted: () => Promise<void>;
}) {
  const [editingRoundId, setEditingRoundId] = useState<string>();
  const [name, setName] = useState("");
  const [startsAt, setStartsAt] = useState("");
  const [endsAt, setEndsAt] = useState("");
  const [blind, setBlind] = useState(false);
  const [criteria, setCriteria] = useState<readonly RubricCriterion[]>(starterRubric.criteria);
  const [initialStatus, setInitialStatus] = useState<"pending" | "active">("pending");
  const [pending, setPending] = useState<"save" | string>();
  const [error, setError] = useState<string>();
  const createKey = useRef(`review-round-create-${crypto.randomUUID()}`);
  const updateKeys = useRef(new Map<string, string>());
  const transitionKeys = useRef(new Map<string, string>());
  const ordered = [...rounds].sort((left, right) => left.order - right.order);
  const activeRound = ordered.find((round) => round.status === "active");
  const firstPending = ordered.find((round) => round.status === "pending");
  const canCreateActive = !activeRound && ordered.every((round) => round.status === "complete");
  const editingRound = ordered.find((round) => round.id === editingRoundId);

  const resetDraft = () => {
    setEditingRoundId(undefined);
    setName("");
    setStartsAt("");
    setEndsAt("");
    setBlind(false);
    setCriteria(starterRubric.criteria);
    setInitialStatus("pending");
  };

  const editRound = (round: ReviewRound) => {
    setEditingRoundId(round.id);
    setName(round.name);
    setStartsAt(localDateTime(round.startsAt));
    setEndsAt(localDateTime(round.endsAt));
    setBlind(round.blind);
    setCriteria(round.rubric.criteria);
    setError(undefined);
  };

  const commit = async (key: "save" | string, run: () => Promise<unknown>) => {
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

  const saveRound = () => {
    const trimmedName = name.trim();
    if (!trimmedName || criteria.length === 0 || (initialStatus === "active" && !canCreateActive && !editingRound)) return;
    const rubric = { criteria: criteria as [RubricCriterion, ...RubricCriterion[]] };
    const start = timestamp(startsAt);
    const end = timestamp(endsAt);
    if (start !== null && end !== null && end <= start) {
      setError("Round end must be after its start.");
      return;
    }
    void commit("save", async () => {
      if (editingRound) {
        const identity = `${editingRound.id}:${editingRound.version}`;
        const idempotencyKey = updateKeys.current.get(identity) ?? `review-round-update-${crypto.randomUUID()}`;
        updateKeys.current.set(identity, idempotencyKey);
        await updateReviewRoundRequest({
          eventId,
          roundId: editingRound.id,
          name: trimmedName,
          startsAt: start,
          endsAt: end,
          blind,
          rubric,
          expectedVersion: editingRound.version,
          idempotencyKey,
          requestId: requestId("review-round-update"),
        });
      } else {
        await createReviewRoundRequest({
          eventId,
          name: trimmedName,
          initialStatus,
          startsAt: start,
          endsAt: end,
          blind,
          rubric,
          expectedRoundCount: ordered.length,
          idempotencyKey: createKey.current,
          requestId: requestId("review-round-create"),
        });
        createKey.current = `review-round-create-${crypto.randomUUID()}`;
      }
      resetDraft();
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

  const updateCriterion = (key: string, update: (criterion: RubricCriterion) => RubricCriterion) =>
    setCriteria((current) => current.map((criterion) => criterion.key === key ? update(criterion) : criterion));

  return (
    <Card className="[&>header]:bg-surface-muted [&>header]:text-ink [&>header_h3]:text-ink" title="Review rounds / scorecard studio">
      <div className="grid gap-5 xl:grid-cols-[minmax(0,0.8fr)_minmax(24rem,1.2fr)]">
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
                  <li key={round.id} className="border-2 border-line-strong bg-surface-muted px-3 py-3 shadow-[3px_3px_0_#171714]">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-black text-ink"><span className="mr-2 bg-ink px-1.5 py-1 font-mono text-[10px] text-production-lime">{String(round.order).padStart(2, "0")}</span>{round.name}</p>
                        <p className="mt-2 flex flex-wrap items-center gap-1.5 text-xs text-ink-faint">
                          <Badge tone={statusTone[round.status]}>{round.status}</Badge>
                          {round.blind && <Badge tone="warning">Blind</Badge>}
                          <span>{round.rubric.criteria.length} criteria</span>
                          <span>{round.rubric.criteria.reduce((total, criterion) => total + criterion.weight, 0)} total weight</span>
                        </p>
                        <p className="mt-2 text-xs text-ink-faint">
                          {round.startsAt === null ? "Start open" : new Date(round.startsAt).toLocaleString()} → {round.endsAt === null ? "No deadline" : new Date(round.endsAt).toLocaleString()}
                        </p>
                      </div>
                      <Button size="sm" variant="secondary" disabled={pending !== undefined} onClick={() => editRound(round)}>Edit</Button>
                    </div>
                    {(canActivate || canAdvance) && (
                      <Button className="mt-3" variant={canAdvance ? "primary" : "secondary"} disabled={pending !== undefined} onClick={() => transition(round)}>
                        {pending === round.id ? "Saving…" : canActivate ? "Activate round" : nextRound ? `Complete & activate ${nextRound.name}` : "Complete round"}
                      </Button>
                    )}
                  </li>
                );
              })}
            </ol>
          )}
        </div>

        <div className="space-y-4 border-t-2 border-line-strong bg-production-sky/30 p-4 xl:border-l-2 xl:border-t-0">
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-sm font-black uppercase tracking-[0.08em] text-ink">{editingRound ? `Edit ${editingRound.name}` : "New review round"}</h3>
            {editingRound && <Button size="sm" variant="ghost" onClick={resetDraft}>Cancel edit</Button>}
          </div>
          <Input label="Round name" value={name} maxLength={120} placeholder="Final program review" onChange={(event) => setName(event.target.value)} />
          <div className="grid gap-3 sm:grid-cols-2">
            <Input label="Starts" type="datetime-local" value={startsAt} onChange={(event) => setStartsAt(event.target.value)} />
            <Input label="Ends" type="datetime-local" value={endsAt} onChange={(event) => setEndsAt(event.target.value)} />
          </div>
          {!editingRound && (
            <Select label="Initial state" value={initialStatus} onChange={(event) => setInitialStatus(event.target.value as "pending" | "active")}>
              <option value="pending">Pending (configure first)</option>
              <option value="active" disabled={!canCreateActive}>Active now</option>
            </Select>
          )}
          <Checkbox checked={blind} onChange={(event) => setBlind(event.target.checked)} label="Blind review" description="Hide presenter names and identities from reviewers in this round." />

          <div className="space-y-3 border-t-2 border-line-strong pt-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h4 className="text-xs font-black uppercase tracking-[0.08em]">Scorecard criteria</h4>
              <div className="flex flex-wrap gap-2">
                {(["numeric", "dropdown", "text"] as const).map((type) => (
                  <Button key={type} size="sm" variant="secondary" onClick={() => setCriteria((current) => [...current, newCriterion(type)])}>+ {type}</Button>
                ))}
              </div>
            </div>
            {criteria.map((criterion, index) => (
              <fieldset key={criterion.key} className="space-y-3 border-2 border-line-strong bg-surface p-3 shadow-[3px_3px_0_#171714]">
                <legend className="px-2 text-[10px] font-black uppercase tracking-[0.1em]">{String(index + 1).padStart(2, "0")} · {criterion.type}</legend>
                <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_8rem]">
                  <Input label="Label" value={criterion.label} maxLength={120} onChange={(event) => updateCriterion(criterion.key, (value) => ({ ...value, label: event.target.value }))} />
                  <Input label="Weight" type="number" min={0} max={100} step="0.5" disabled={criterion.type === "text"} value={criterion.weight} onChange={(event) => updateCriterion(criterion.key, (value) => ({ ...value, weight: Number(event.target.value) }))} />
                </div>
                <Textarea label="Guidance" rows={2} maxLength={500} value={criterion.description ?? ""} onChange={(event) => updateCriterion(criterion.key, (value) => ({ ...value, description: event.target.value }))} />
                {criterion.type === "dropdown" && (
                  <div className="space-y-2">
                    {(criterion.options ?? []).map((option, optionIndex) => (
                      <div key={`${criterion.key}:${optionIndex}`} className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_6rem_auto] sm:items-end">
                        <Input label={`Option ${optionIndex + 1}`} value={option.label} onChange={(event) => updateCriterion(criterion.key, (value) => ({
                          ...value,
                          options: value.options?.map((candidate, candidateIndex) => candidateIndex === optionIndex ? { ...candidate, label: event.target.value, value: `option_${optionIndex + 1}` } : candidate),
                        }))} />
                        <Input label="Score" type="number" min={1} max={5} value={option.score} onChange={(event) => updateCriterion(criterion.key, (value) => ({
                          ...value,
                          options: value.options?.map((candidate, candidateIndex) => candidateIndex === optionIndex ? { ...candidate, score: Math.max(1, Math.min(5, Number(event.target.value))) as 1 | 2 | 3 | 4 | 5 } : candidate),
                        }))} />
                        <Button size="sm" variant="ghost" disabled={(criterion.options?.length ?? 0) <= 2} onClick={() => updateCriterion(criterion.key, (value) => ({ ...value, options: value.options?.filter((_, candidateIndex) => candidateIndex !== optionIndex) }))}>Remove</Button>
                      </div>
                    ))}
                    <Button size="sm" variant="secondary" onClick={() => updateCriterion(criterion.key, (value) => ({
                      ...value,
                      options: [...(value.options ?? []), { value: `option_${(value.options?.length ?? 0) + 1}`, label: "New option", score: 3 }],
                    }))}>+ option</Button>
                  </div>
                )}
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <Checkbox checked={criterion.required} onChange={(event) => updateCriterion(criterion.key, (value) => ({ ...value, required: event.target.checked }))} label="Required response" />
                  <Button size="sm" variant="ghost" disabled={criteria.length === 1} onClick={() => setCriteria((current) => current.filter((candidate) => candidate.key !== criterion.key))}>Remove criterion</Button>
                </div>
              </fieldset>
            ))}
          </div>
          <Button disabled={!name.trim() || criteria.length === 0 || pending !== undefined || (!editingRound && initialStatus === "active" && !canCreateActive)} onClick={saveRound}>
            {pending === "save" ? "Saving…" : editingRound ? "Save round configuration" : "Create round"}
          </Button>
        </div>
      </div>
      {error && <p role="alert" className="mt-4 border-2 border-line-strong bg-danger-soft p-3 text-sm font-bold text-danger shadow-[3px_3px_0_#171714]">{error}</p>}
    </Card>
  );
}
