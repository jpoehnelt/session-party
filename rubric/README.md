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
pnpm rubric:run -- --min-score 70
pnpm rubric:gate
```

`rubric:run` executes the exact Vitest assertions named in `evidence.ts`. Each
rubric item is composed from one or more checks:

- a passing Vitest assertion is positive behavioral evidence;
- a known product or test gap is a failed check;
- all checks passing derives `pass`;
- a mix of passing and failing checks derives `partial`;
- all checks failing derives `fail`;
- an unresolved real-world/manual check derives `cannot_judge` and is excluded
  from the judgeable denominator.

The generated `.rubric/report.json` and `.rubric/report.md` contain every
criterion, check, verdict, area score, and coverage figure. Product gaps do not
make the runner itself fail. Use `--min-score` when a regression gate is desired.
`rubric:gate` locks the current deterministic baseline at 64.3%; replacing gaps
with evidence raises that floor intentionally.

## Adding a capability

Add or strengthen a focused behavioral test, then replace the relevant `gap()`
entry in `scripts/rubric/evidence.ts` with an exact `test(file, title)` reference.
`rubric:validate` fails if the rubric and evidence plan stop covering the same
IDs, while `rubric:run` fails if a referenced assertion is renamed or removed.

The harness deliberately does not use source-code grep, screenshots judged by a
model, or a hand-entered pass/partial score. Browser interactions that are not
yet deterministic remain explicit gaps until a Playwright or component-level
interaction probe is added.
