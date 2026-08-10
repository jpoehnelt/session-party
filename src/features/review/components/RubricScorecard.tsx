import { Badge, Button, Select, Textarea } from "@/ui";
import type { CriterionScore, ReviewRubric } from "../schema";

const scoreMeaning = ["", "Weak", "Limited", "Solid", "Strong", "Exceptional"] as const;

export interface RubricScorecardProps {
  rubric: ReviewRubric;
  scores: readonly CriterionScore[];
  onChange: (scores: readonly CriterionScore[]) => void;
  disabled?: boolean;
  sourceLabel?: "Human review" | "AI draft";
}

export function RubricScorecard({
  rubric,
  scores,
  onChange,
  disabled = false,
  sourceLabel = "Human review",
}: RubricScorecardProps) {
  const byCriterion = new Map(scores.map((entry) => [entry.criterionKey, entry.score]));
  const complete = rubric.criteria.every((criterion) => !criterion.required || byCriterion.has(criterion.key));
  const aggregate = rubric.criteria.reduce((result, criterion) => {
    if (criterion.type === "text" || criterion.weight <= 0) return result;
    const response = byCriterion.get(criterion.key);
    const value = criterion.type === "numeric"
      ? typeof response === "number" ? response : null
      : criterion.options?.find((option) => option.value === response)?.score ?? null;
    return value === null
      ? result
      : { weightedTotal: result.weightedTotal + value * criterion.weight, weightTotal: result.weightTotal + criterion.weight };
  }, { weightedTotal: 0, weightTotal: 0 });
  const average = complete && aggregate.weightTotal > 0 ? aggregate.weightedTotal / aggregate.weightTotal : null;

  const update = (criterionKey: string, score: number | string | undefined) => {
    const next = rubric.criteria.flatMap((criterion) => {
      const value = criterion.key === criterionKey ? score : byCriterion.get(criterion.key);
      return value === undefined ? [] : [{ criterionKey: criterion.key, score: value }];
    });
    onChange(next);
  };

  return (
    <section aria-labelledby="rubric-heading" className="space-y-4">
      <header className="flex flex-wrap items-start justify-between gap-3 border-b-2 border-line-strong pb-3">
        <div>
          <div className="flex items-center gap-2">
            <h3 id="rubric-heading" className="text-sm font-black uppercase tracking-[0.08em] text-ink">Rubric scorecard</h3>
            <Badge tone={sourceLabel === "AI draft" ? "warning" : "neutral"}>{sourceLabel}</Badge>
          </div>
          <p className="mt-1 text-xs text-ink-faint">Numeric and dropdown criteria contribute by weight; written rationale remains qualitative.</p>
        </div>
        <div className="border-2 border-line-strong bg-production-lime px-3 py-2 text-right shadow-[3px_3px_0_#171714]" aria-live="polite">
          <div className="font-mono text-xl font-black tabular-nums text-ink">
            {average === null ? "—" : average.toFixed(1)}
            <span className="text-xs font-normal text-ink-faint"> / 5</span>
          </div>
          <div className="text-[11px] font-medium uppercase tracking-wide text-ink-faint">
            {complete ? "Complete" : `${scores.length} of ${rubric.criteria.length} scored`}
          </div>
        </div>
      </header>

      <div className="divide-y-2 divide-line-strong">
        {rubric.criteria.map((criterion) => {
          const selected = byCriterion.get(criterion.key);
          return (
            <fieldset key={criterion.key} className="grid gap-3 py-4 first:pt-0 sm:grid-cols-[minmax(11rem,1fr)_minmax(16rem,auto)] sm:items-center">
              <legend className="contents">
                <span>
                  <span className="block text-sm font-black text-ink">{criterion.label}</span>
                  <span className="mt-1 block text-[10px] font-black uppercase tracking-[0.08em] text-accent-deep">
                    {criterion.type}{criterion.type === "text" ? "" : ` · weight ${criterion.weight}`}{criterion.required ? " · required" : " · optional"}
                  </span>
                  {criterion.description && (
                    <span className="mt-0.5 block max-w-xl text-xs leading-relaxed text-ink-faint">
                      {criterion.description}
                    </span>
                  )}
                </span>
              </legend>
              {criterion.type === "numeric" ? (
                <div className="flex gap-1" aria-label={`${criterion.label} score`}>
                  {([1, 2, 3, 4, 5] as const).map((score) => (
                    <Button
                      key={score}
                      size="md"
                      variant={selected === score ? "primary" : "secondary"}
                      className="min-h-11 min-w-11 px-3 font-mono tabular-nums"
                      aria-pressed={selected === score}
                      aria-label={`${score} — ${scoreMeaning[score]}`}
                      title={scoreMeaning[score]}
                      disabled={disabled}
                      onClick={() => update(criterion.key, score)}
                    >
                      {selected === score && <span aria-hidden="true">✓</span>}
                      {score}
                    </Button>
                  ))}
                </div>
              ) : criterion.type === "dropdown" ? (
                <Select
                  label={`${criterion.label} response`}
                  value={typeof selected === "string" ? selected : ""}
                  disabled={disabled}
                  onChange={(event) => update(criterion.key, event.target.value || undefined)}
                >
                  <option value="">Select an option</option>
                  {(criterion.options ?? []).map((option) => <option key={option.value} value={option.value}>{option.label} · {option.score}/5</option>)}
                </Select>
              ) : (
                <Textarea
                  label={`${criterion.label} response`}
                  value={typeof selected === "string" ? selected : ""}
                  maxLength={2_000}
                  rows={4}
                  disabled={disabled}
                  onChange={(event) => update(criterion.key, event.target.value.trim() ? event.target.value : undefined)}
                />
              )}
              {typeof selected === "number" && (
                <p className="text-xs font-medium text-ink-secondary sm:col-start-2 sm:text-right">
                  {selected}: {scoreMeaning[selected]}
                </p>
              )}
            </fieldset>
          );
        })}
      </div>
    </section>
  );
}
