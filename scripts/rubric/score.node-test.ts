import assert from "node:assert/strict";
import test from "node:test";
import type { EvidencePlan, RubricManifest } from "./model.ts";
import { scoreRubric, testKey } from "./score.ts";

const manifest: RubricManifest = {
  schemaVersion: 1,
  source: { repository: "test", revision: "locked" },
  areas: [
    {
      area: "required",
      title: "Required",
      prefix: "REQ",
      areaWeight: 100,
      optional: false,
      items: [
        { id: "REQ-01", criterion: "pass", weight: 3, type: "crud", testability: "auto", passCriteria: "pass" },
        { id: "REQ-02", criterion: "partial", weight: 2, type: "depth", testability: "auto", passCriteria: "partial" },
        { id: "REQ-03", criterion: "fail", weight: 1, type: "rule", testability: "auto", passCriteria: "fail" },
      ],
    },
  ],
};

const plan: EvidencePlan = {
  "REQ-01": [{ kind: "vitest", file: "pass.test.ts", title: "passes" }],
  "REQ-02": [
    { kind: "vitest", file: "pass.test.ts", title: "passes" },
    { kind: "gap", reason: "missing half" },
  ],
  "REQ-03": [{ kind: "gap", reason: "missing" }],
};

test("derives verdicts and weighted area scores from check outcomes", () => {
  const report = scoreRubric(
    manifest,
    plan,
    new Map([[testKey("pass.test.ts", "passes"), "passed"]]),
  );
  assert.equal(report.overallScorePct, (4 / 6) * 100);
  assert.equal(report.overallEvidenceCoveragePct, 50);
  assert.equal(report.overallImplementationGapPct, 50);
  assert.deepEqual(report.required[0]?.items.map(({ verdict }) => verdict), ["pass", "partial", "fail"]);
});

test("withholds pending manual checks from the judgeable denominator", () => {
  const manualPlan: EvidencePlan = {
    ...plan,
    "REQ-03": [{ kind: "manual", instructions: "verify delivery" }],
  };
  const report = scoreRubric(
    manifest,
    manualPlan,
    new Map([[testKey("pass.test.ts", "passes"), "passed"]]),
  );
  assert.equal(report.required[0]?.judgeable, 5);
  assert.equal(report.required[0]?.evidenceCoveragePct, 50);
  assert.equal(report.required[0]?.implementationGapPct, (2 / 6) * 100);
  assert.equal(report.required[0]?.items[2]?.verdict, "cannot_judge");
});
