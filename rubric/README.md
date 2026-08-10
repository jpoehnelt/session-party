# Deterministic rubric harness

This directory vendors the SessionBoard evaluation rubric at the exact upstream
revision recorded in `manifest.json`. The executable harness lives in
`scripts/rubric/`.

The locked spec files contain 86 required items totaling 183 item-weight points.
The upstream README says 182 because its Public Widgets summary says 34 while
the 16 actual widget item weights sum to 35; this harness treats executable spec
data as authoritative and makes that drift visible.

```bash
pnpm rubric:validate
pnpm rubric:run
pnpm rubric:run --min-score 70
pnpm rubric:gate
pnpm rubric:baseline
```

`rubric:run` executes the exact Vitest assertions named in `evidence.ts`. Each
rubric item is composed from one or more checks:

- a passing Vitest assertion is positive behavioral evidence;
- a known product or test gap is a failed capability check but does not count as deterministic evidence coverage;
- all checks passing derives `pass`;
- a mix of passing and failing checks derives `partial`;
- all checks failing derives `fail`;
- an unresolved real-world/manual check derives `cannot_judge`, is excluded from
  the judgeable denominator, and never becomes an implementation failure.

The generated `.rubric/report.json` and `.rubric/report.md` contain every
criterion, check, verdict, capability score, deterministic evidence-coverage
figure, and implementation-gap weight. An item contributes evidence coverage
only when all its checks are exact executed tests; `gap()` entries remain visible
in the score without pretending they were exercised. Product gaps do not make
the runner itself fail. Use `--min-score` when a regression gate is desired.
`rubric/baseline.json` persists the current grade in Git. `rubric:gate` reads that
floor, while `rubric:baseline` recomputes the report and advances the file; it
refuses to write a lower score.

Pull-request CI compares the computed head grade with the base commit's persisted
grade, requires the head's baseline file to equal its computed grade, and fails
the required `Rubric grade` check on any decrease. The job summary shows the
base-to-head change and the generated report is retained as a workflow artifact.
The first rubric PR uses 64.3% as its bootstrap base because `main` does not yet
contain the baseline file.

## Adding a capability

Add or strengthen a focused behavioral test, then replace the relevant `gap()`
entry in `scripts/rubric/evidence.ts` with an exact `test(file, title)` reference.
`rubric:validate` fails if the rubric and evidence plan stop covering the same
IDs, while `rubric:run` fails if a referenced assertion is renamed or removed.

The harness deliberately does not use source-code grep, screenshots judged by a
model, or a hand-entered pass/partial score. Browser interactions that are not
yet deterministic remain explicit gaps until a Playwright or component-level
interaction probe is added.
