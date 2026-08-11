import { readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import type { VitestBrowserCheck, VitestCheck } from "./model.ts";
import { testKey, type TestOutcomes } from "./score.ts";

type RubricVitestCheck = VitestCheck | VitestBrowserCheck;

interface VitestAssertion {
  readonly title?: unknown;
  readonly status?: unknown;
}

interface VitestFileResult {
  readonly name?: unknown;
  readonly assertionResults?: unknown;
}

interface VitestReport {
  readonly success?: unknown;
  readonly testResults?: unknown;
  readonly errors?: unknown;
  readonly unhandledErrors?: unknown;
}

export interface VitestExecution {
  readonly status: number | null;
  readonly signal: string | null;
  readonly error?: Error;
  readonly stdout: string | Buffer | null;
  readonly stderr: string | Buffer | null;
}

const normalizeFile = (value: string): string =>
  relative(process.cwd(), resolve(value)).split("\\").join("/");

const outputText = (value: string | Buffer | null): string =>
  typeof value === "string" ? value : value?.toString("utf8") ?? "";

export function assertVitestExecution(result: VitestExecution): void {
  if (result.error) throw new Error(`Vitest failed to start: ${result.error.message}`);
  if (result.status === null) {
    throw new Error(`Vitest did not exit normally${result.signal ? ` (signal ${result.signal})` : ""}`);
  }
  if (result.status !== 0 && result.status !== 1) {
    throw new Error(`Vitest exited with infrastructure status ${result.status}`);
  }

  const diagnostics = `${outputText(result.stdout)}\n${outputText(result.stderr)}`;
  if (/Unhandled Error|EnvironmentTeardownError|Unhandled Rejection|Uncaught Exception/i.test(diagnostics)) {
    throw new Error("Vitest reported an unhandled runtime or teardown error");
  }
}

export function readVitestOutcomes(path: string, checks: readonly RubricVitestCheck[]): TestOutcomes {
  const report = JSON.parse(readFileSync(path, "utf8")) as VitestReport;
  if (typeof report.success !== "boolean") {
    throw new Error("Vitest JSON report has no completion status");
  }
  if (Array.isArray(report.errors) && report.errors.length > 0) {
    throw new Error("Vitest JSON report contains errors");
  }
  if (Array.isArray(report.unhandledErrors) && report.unhandledErrors.length > 0) {
    throw new Error("Vitest JSON report contains unhandled errors");
  }
  if (!Array.isArray(report.testResults)) throw new Error("Vitest JSON report has no testResults array");

  const outcomes = new Map<string, "passed" | "failed" | "pending">();
  for (const candidate of report.testResults) {
    const file = candidate as VitestFileResult;
    if (typeof file.name !== "string" || !Array.isArray(file.assertionResults)) continue;
    const normalized = normalizeFile(file.name);
    for (const assertionCandidate of file.assertionResults) {
      const assertion = assertionCandidate as VitestAssertion;
      if (typeof assertion.title !== "string" || typeof assertion.status !== "string") continue;
      const status = assertion.status === "passed"
        ? "passed"
        : assertion.status === "failed"
          ? "failed"
          : "pending";
      const key = testKey(normalized, assertion.title);
      const previous = outcomes.get(key);
      if (previous === "failed" || status === "failed") outcomes.set(key, "failed");
      else if (previous === "pending" || status === "pending") outcomes.set(key, "pending");
      else outcomes.set(key, "passed");
    }
  }

  const missing = [...new Set(
    checks
      .map(({ file, title }) => testKey(normalizeFile(file), title))
      .filter((key) => !outcomes.has(key)),
  )];
  if (missing.length > 0) throw new Error(`Rubric evidence assertions were not found: ${missing.join(", ")}`);
  return outcomes;
}
