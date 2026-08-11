import assert from "node:assert/strict";
import test from "node:test";
import { assertNonDecreasing, baselineFromReport } from "./baseline.ts";
import type { RubricReport } from "./model.ts";

const report: RubricReport = {
  schemaVersion: 2,
  rubricRevision: "locked",
  overallScorePct: 64.3107,
  overallEvidenceCoveragePct: 50,
  overallImplementationGapPct: 50,
  required: [
    {
      area: "required",
      title: "Required",
      optional: false,
      areaWeight: 100,
      earned: 1,
      judgeable: 3,
      evidenceWeight: 1,
      implementationGapWeight: 2,
      totalWeight: 3,
      scorePct: 33.3333,
      evidenceCoveragePct: 33.3333,
      implementationGapPct: 66.6667,
      items: [],
    },
  ],
  optional: [],
};

test("persists stable one-decimal rubric scores", () => {
  assert.deepEqual(baselineFromReport(report), {
    schemaVersion: 2,
    rubricRevision: "locked",
    overallScorePct: 64.3,
    overallEvidenceCoveragePct: 50,
    overallImplementationGapPct: 50,
    areas: { required: 33.3 },
  });
});

test("refuses to lower a persisted rubric baseline", () => {
  const current = baselineFromReport(report);
  assert.doesNotThrow(() => assertNonDecreasing(current, {
    ...current,
    overallScorePct: 64.4,
    overallEvidenceCoveragePct: 50.1,
    overallImplementationGapPct: 49.9,
  }));
  assert.throws(
    () => assertNonDecreasing(current, { ...current, overallScorePct: 64.2 }),
    /Refusing to lower/,
  );
  assert.throws(
    () => assertNonDecreasing(current, { ...current, overallEvidenceCoveragePct: 49.9 }),
    /evidence coverage/,
  );
  assert.throws(
    () => assertNonDecreasing(current, { ...current, overallImplementationGapPct: 50.1 }),
    /implementation-gap weight/,
  );
});
