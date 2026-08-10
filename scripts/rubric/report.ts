import type { AreaResult, RubricReport } from "./model.ts";

const percent = (value: number | null): string => value === null ? "—" : `${value.toFixed(1)}%`;

const counts = (area: AreaResult): string => {
  const values = { pass: 0, partial: 0, fail: 0, cannot_judge: 0 };
  for (const item of area.items) values[item.verdict] += 1;
  return `${values.pass}/${values.partial}/${values.fail}/${values.cannot_judge}`;
};

export function renderMarkdown(report: RubricReport): string {
  const lines = [
    "# Deterministic rubric report",
    "",
    `Rubric revision: \`${report.rubricRevision}\``,
    "",
    `Required score: **${percent(report.overallScorePct)}** at **${percent(report.overallCoveragePct)} coverage**.`,
    "",
    "| Area | Earned | Score | Coverage | Pass/Partial/Fail/Pending |",
    "|---|---:|---:|---:|---:|",
  ];
  for (const area of report.required) {
    lines.push(
      `| ${area.title} | ${area.earned}/${area.judgeable} | ${percent(area.scorePct)} | ${percent(area.coveragePct)} | ${counts(area)} |`,
    );
  }
  if (report.optional.length > 0) {
    lines.push("", "## Optional areas", "");
    for (const area of report.optional) {
      lines.push(`- ${area.title}: ${percent(area.scorePct)} at ${percent(area.coveragePct)} coverage.`);
    }
  }

  const incomplete = [...report.required, ...report.optional]
    .flatMap(({ title, items }) => items
      .filter(({ verdict }) => verdict !== "pass")
      .map((item) => ({ area: title, item })));
  lines.push("", "## Non-passing criteria", "");
  for (const { area, item } of incomplete) {
    lines.push(`- **${item.id} · ${item.verdict} · ${area}:** ${item.criterion}`);
    for (const check of item.checks.filter(({ outcome }) => outcome !== "pass")) {
      lines.push(`  - ${check.outcome}: ${check.detail}`);
    }
  }
  return `${lines.join("\n")}\n`;
}
