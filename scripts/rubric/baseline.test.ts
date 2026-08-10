import assert from "node:assert/strict";
import test from "node:test";
import { assertNonDecreasing, baselineFromReport } from "./baseline.ts";
import type { RubricReport } from "./model.ts";

const report: RubricReport = {
  schemaVersion: 1,
  rubricRevision: "locked",
  overallScorePct: 64.3107,
  overallCoveragePct: 100,
  required: [
    {
      area: "required",
      title: "Required",
      optional: false,
      areaWeight: 100,
      earned: 1,
      judgeable: 3,
      totalWeight: 3,
      scorePct: 33.3333,
      coveragePct: 100,
      items: [],
    },
  ],
  optional: [],
};

test("persists stable one-decimal rubric scores", () => {
  assert.deepEqual(baselineFromReport(report), {
    schemaVersion: 1,
    rubricRevision: "locked",
    overallScorePct: 64.3,
    overallCoveragePct: 100,
    areas: { required: 33.3 },
  });
});

test("refuses to lower a persisted rubric baseline", () => {
  const current = baselineFromReport(report);
  assert.doesNotThrow(() => assertNonDecreasing(current, { ...current, overallScorePct: 64.4 }));
  assert.throws(
    () => assertNonDecreasing(current, { ...current, overallScorePct: 64.2 }),
    /Refusing to lower/,
  );
});
