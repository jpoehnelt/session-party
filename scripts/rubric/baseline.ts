import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { RubricReport } from "./model.ts";

export interface RubricBaseline {
  readonly schemaVersion: 2;
  readonly rubricRevision: string;
  readonly overallScorePct: number;
  readonly overallEvidenceCoveragePct: number;
  readonly overallImplementationGapPct: number;
  readonly areas: Readonly<Record<string, number>>;
}

const roundPct = (value: number): number => Math.round(value * 10) / 10;

function assertPct(value: unknown, label: string): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 100) {
    throw new Error(`${label} must be a number from 0 through 100`);
  }
}

export function baselineFromReport(report: RubricReport): RubricBaseline {
  if (report.overallScorePct === null) throw new Error("Cannot persist a rubric baseline without a required score");
  return {
    schemaVersion: 2,
    rubricRevision: report.rubricRevision,
    overallScorePct: roundPct(report.overallScorePct),
    overallEvidenceCoveragePct: roundPct(report.overallEvidenceCoveragePct),
    overallImplementationGapPct: roundPct(report.overallImplementationGapPct),
    areas: Object.fromEntries(
      report.required.map(({ area, scorePct }) => {
        if (scorePct === null) throw new Error(`Cannot persist rubric area ${area} without a score`);
        return [area, roundPct(scorePct)];
      }),
    ),
  };
}

export function parseBaseline(value: unknown, expectedRevision: string): RubricBaseline {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Rubric baseline must be a JSON object");
  }
  const candidate = value as Partial<RubricBaseline>;
  if (candidate.schemaVersion !== 2) throw new Error("Rubric baseline schemaVersion must be 2");
  if (candidate.rubricRevision !== expectedRevision) {
    throw new Error(`Rubric baseline revision ${String(candidate.rubricRevision)} does not match ${expectedRevision}`);
  }
  assertPct(candidate.overallScorePct, "Rubric baseline overallScorePct");
  assertPct(candidate.overallEvidenceCoveragePct, "Rubric baseline overallEvidenceCoveragePct");
  assertPct(candidate.overallImplementationGapPct, "Rubric baseline overallImplementationGapPct");
  if (typeof candidate.areas !== "object" || candidate.areas === null || Array.isArray(candidate.areas)) {
    throw new Error("Rubric baseline areas must be an object");
  }
  for (const [area, score] of Object.entries(candidate.areas)) {
    assertPct(score, `Rubric baseline area ${area}`);
  }
  return candidate as RubricBaseline;
}

export function readBaseline(path: string, expectedRevision: string): RubricBaseline {
  return parseBaseline(JSON.parse(readFileSync(path, "utf8")) as unknown, expectedRevision);
}

export function assertNonDecreasing(previous: RubricBaseline, next: RubricBaseline): void {
  if (next.overallScorePct < previous.overallScorePct) {
    throw new Error(
      `Refusing to lower the persisted rubric baseline from ${previous.overallScorePct.toFixed(1)}% to ${next.overallScorePct.toFixed(1)}%`,
    );
  }
  if (next.overallEvidenceCoveragePct < previous.overallEvidenceCoveragePct) {
    throw new Error(
      `Refusing to lower persisted rubric evidence coverage from ${previous.overallEvidenceCoveragePct.toFixed(1)}% to ${next.overallEvidenceCoveragePct.toFixed(1)}%`,
    );
  }
  if (next.overallImplementationGapPct > previous.overallImplementationGapPct) {
    throw new Error(
      `Refusing to raise persisted rubric implementation-gap weight from ${previous.overallImplementationGapPct.toFixed(1)}% to ${next.overallImplementationGapPct.toFixed(1)}%`,
    );
  }
}

export function writeBaseline(path: string, report: RubricReport): RubricBaseline {
  const next = baselineFromReport(report);
  if (existsSync(path)) assertNonDecreasing(readBaseline(path, report.rubricRevision), next);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`);
  return next;
}
