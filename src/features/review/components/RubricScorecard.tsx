import { Badge, Button } from "@/ui";
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
  const complete = rubric.criteria.every((criterion) => byCriterion.has(criterion.key));
  const average = complete
    ? rubric.criteria.reduce((total, criterion) => total + (byCriterion.get(criterion.key) ?? 0), 0) /
      rubric.criteria.length
    : null;

  const update = (criterionKey: string, score: 1 | 2 | 3 | 4 | 5) => {
    const next = rubric.criteria.flatMap((criterion) => {
      const value = criterion.key === criterionKey ? score : byCriterion.get(criterion.key);
      return value === undefined ? [] : [{ criterionKey: criterion.key, score: value }];
    });
    onChange(next);
  };

  return (
    <section aria-labelledby="rubric-heading" className="space-y-4">
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-line pb-3">
        <div>
          <div className="flex items-center gap-2">
            <h3 id="rubric-heading" className="text-sm font-semibold text-ink">Rubric scorecard</h3>
            <Badge tone={sourceLabel === "AI draft" ? "warning" : "neutral"}>{sourceLabel}</Badge>
          </div>
          <p className="mt-1 text-xs text-ink-faint">Every criterion requires a whole-number score from 1 to 5.</p>
        </div>
        <div className="text-right" aria-live="polite">
          <div className="font-mono text-lg font-semibold tabular-nums text-ink">
            {average === null ? "—" : average.toFixed(1)}
            <span className="text-xs font-normal text-ink-faint"> / 5</span>
          </div>
          <div className="text-[11px] font-medium uppercase tracking-wide text-ink-faint">
            {complete ? "Complete" : `${scores.length} of ${rubric.criteria.length} scored`}
          </div>
        </div>
      </header>

      <div className="divide-y divide-line">
        {rubric.criteria.map((criterion) => {
          const selected = byCriterion.get(criterion.key);
          return (
            <fieldset key={criterion.key} className="grid gap-3 py-4 first:pt-0 sm:grid-cols-[minmax(11rem,1fr)_auto] sm:items-center">
              <legend className="contents">
                <span>
                  <span className="block text-sm font-medium text-ink">{criterion.label}</span>
                  {criterion.description && (
                    <span className="mt-0.5 block max-w-xl text-xs leading-relaxed text-ink-faint">
                      {criterion.description}
                    </span>
                  )}
                </span>
              </legend>
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
              {selected !== undefined && (
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
