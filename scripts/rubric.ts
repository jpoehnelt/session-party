import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { readBaseline, writeBaseline } from "./rubric/baseline.ts";
import { evidencePlan } from "./rubric/evidence.ts";
import { loadManifest, validateEvidencePlan } from "./rubric/manifest.ts";
import type { EvidencePlan, RubricReport, VitestBrowserCheck, VitestCheck } from "./rubric/model.ts";
import { renderMarkdown } from "./rubric/report.ts";
import { scoreRubric, type TestOutcomes } from "./rubric/score.ts";
import { assertVitestExecution, readVitestOutcomes } from "./rubric/vitest.ts";

const usage = `Usage:
  pnpm rubric:validate
  pnpm rubric:run [--output <directory>] [--min-score <0-100>]
    [--min-evidence-coverage <0-100>] [--max-implementation-gap <0-100>]
  pnpm rubric:gate [--output <directory>]
  pnpm rubric:baseline [--output <directory>]

The run command executes every exact Vitest assertion referenced by the evidence
plan, derives pass/partial/fail from its sub-checks, and writes stable JSON and
Markdown reports. Known product gaps are failed checks, not skipped criteria.
The gate reads the committed monotonic baseline; the baseline command advances it.`;

const asVitestChecks = (plan: EvidencePlan): readonly VitestCheck[] =>
  Object.values(plan).flatMap((checks) => checks.filter((check): check is VitestCheck => check.kind === "vitest"));

const asBrowserChecks = (plan: EvidencePlan): readonly VitestBrowserCheck[] =>
  Object.values(plan).flatMap((checks) => checks.filter((check): check is VitestBrowserCheck => check.kind === "vitest-browser"));

function validateFiles(plan: EvidencePlan): void {
  for (const check of [...asVitestChecks(plan), ...asBrowserChecks(plan)]) {
    if (!existsSync(resolve(check.file))) throw new Error(`Rubric evidence file does not exist: ${check.file}`);
    if (check.title.trim().length === 0) throw new Error(`Rubric evidence title is empty: ${check.file}`);
  }
}

function parseArgs(args: readonly string[]): {
  command: string;
  output: string;
  minScore: number | null;
  minEvidenceCoverage: number | null;
  maxImplementationGap: number | null;
} {
  const [command = "", ...rest] = args;
  let output = ".rubric";
  let minScore: number | null = null;
  let minEvidenceCoverage: number | null = null;
  let maxImplementationGap: number | null = null;
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === "--") {
      continue;
    } else if (arg === "--output") {
      output = rest[index + 1] ?? "";
      index += 1;
      if (!output) throw new Error("--output requires a directory");
    } else if (arg === "--min-score") {
      const value = Number(rest[index + 1]);
      index += 1;
      if (!Number.isFinite(value) || value < 0 || value > 100) {
        throw new Error("--min-score must be a number from 0 through 100");
      }
      minScore = value;
    } else if (arg === "--min-evidence-coverage") {
      const value = Number(rest[index + 1]);
      index += 1;
      if (!Number.isFinite(value) || value < 0 || value > 100) {
        throw new Error("--min-evidence-coverage must be a number from 0 through 100");
      }
      minEvidenceCoverage = value;
    } else if (arg === "--max-implementation-gap") {
      const value = Number(rest[index + 1]);
      index += 1;
      if (!Number.isFinite(value) || value < 0 || value > 100) {
        throw new Error("--max-implementation-gap must be a number from 0 through 100");
      }
      maxImplementationGap = value;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return { command, output, minScore, minEvidenceCoverage, maxImplementationGap };
}

function runVitestChecks(
  checks: readonly (VitestCheck | VitestBrowserCheck)[],
  config?: string,
): TestOutcomes {
  if (checks.length === 0) return new Map();
  const files = [...new Set(checks.map(({ file }) => file))].sort();
  const temporary = mkdtempSync(join(tmpdir(), "session-party-rubric-"));
  const reportPath = join(temporary, "vitest.json");
  try {
    const result = spawnSync(
      "pnpm",
      [
        "exec",
        "vitest",
        "run",
        ...(config ? ["--config", config] : []),
        ...files,
        "--reporter=json",
        `--outputFile=${reportPath}`,
      ],
      { cwd: process.cwd(), env: process.env, encoding: "utf8", stdio: ["inherit", "pipe", "pipe"] },
    );
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    assertVitestExecution(result);
    if (!existsSync(reportPath)) {
      throw new Error(`Vitest produced no JSON report (exit ${String(result.status)})`);
    }
    return readVitestOutcomes(reportPath, checks);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

function runVitest(plan: EvidencePlan): TestOutcomes {
  const worker = runVitestChecks(asVitestChecks(plan));
  const browser = runVitestChecks(asBrowserChecks(plan), "src/client/vitest.audit-browser.config.ts");
  return new Map([...worker, ...browser]);
}

function writeReport(report: RubricReport, outputDirectory: string): void {
  const directory = resolve(outputDirectory);
  mkdirSync(directory, { recursive: true });
  const jsonPath = join(directory, "report.json");
  const markdownPath = join(directory, "report.md");
  writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(markdownPath, renderMarkdown(report));
  console.log(`Rubric report written to ${relative(process.cwd(), markdownPath)}`);
}

function printSummary(report: RubricReport): void {
  console.log("");
  console.log(`Required capability score: ${report.overallScorePct?.toFixed(1) ?? "n/a"}%`);
  console.log(`Deterministic evidence coverage: ${report.overallEvidenceCoveragePct.toFixed(1)}%`);
  console.log(`Implementation-gap weight: ${report.overallImplementationGapPct.toFixed(1)}%`);
  for (const area of report.required) {
    console.log(`${area.title}: ${area.scorePct?.toFixed(1) ?? "n/a"}% (${area.earned}/${area.judgeable})`);
  }
  for (const area of report.optional) {
    console.log(`${area.title} (optional): ${area.scorePct?.toFixed(1) ?? "n/a"}% (${area.earned}/${area.judgeable})`);
  }
}

const gatePct = (value: number): number => Math.round(value * 10) / 10;

function main(): void {
  const parsed = parseArgs(process.argv.slice(2));
  const { command, output } = parsed;
  let { minScore, minEvidenceCoverage, maxImplementationGap } = parsed;
  if (command !== "validate" && command !== "run" && command !== "gate" && command !== "baseline") {
    console.log(usage);
    process.exitCode = 2;
    return;
  }
  const manifest = loadManifest();
  validateEvidencePlan(manifest, evidencePlan);
  validateFiles(evidencePlan);
  const baselinePath = resolve("rubric/baseline.json");
  if (command === "validate") {
    readBaseline(baselinePath, manifest.source.revision);
    const itemCount = manifest.areas.reduce((sum, { items }) => sum + items.length, 0);
    const checkCount = Object.values(evidencePlan).reduce((sum, checks) => sum + checks.length, 0);
    console.log(`Rubric manifest and evidence plan valid: ${itemCount} items, ${checkCount} checks.`);
    return;
  }
  if (command === "gate") {
    const baseline = readBaseline(baselinePath, manifest.source.revision);
    minScore = baseline.overallScorePct;
    minEvidenceCoverage = baseline.overallEvidenceCoveragePct;
    maxImplementationGap = baseline.overallImplementationGapPct;
  }

  const outcomes = runVitest(evidencePlan);
  const report = scoreRubric(manifest, evidencePlan, outcomes);
  writeReport(report, output);
  printSummary(report);
  if (command === "baseline") {
    const baseline = writeBaseline(baselinePath, report);
    console.log(`Rubric baseline advanced to ${baseline.overallScorePct.toFixed(1)}%.`);
  }
  if (minScore !== null && (report.overallScorePct === null || gatePct(report.overallScorePct) < minScore)) {
    console.error(`Required score is below the ${minScore.toFixed(1)}% gate.`);
    process.exitCode = 1;
  }
  if (minEvidenceCoverage !== null && gatePct(report.overallEvidenceCoveragePct) < minEvidenceCoverage) {
    console.error(`Evidence coverage is below the ${minEvidenceCoverage.toFixed(1)}% gate.`);
    process.exitCode = 1;
  }
  if (maxImplementationGap !== null && gatePct(report.overallImplementationGapPct) > maxImplementationGap) {
    console.error(`Implementation-gap weight exceeds the ${maxImplementationGap.toFixed(1)}% gate.`);
    process.exitCode = 1;
  }
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
