import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { testKey } from "./score.ts";
import { assertVitestExecution, readVitestOutcomes, type VitestExecution } from "./vitest.ts";

const successfulExecution: VitestExecution = {
  status: 0,
  signal: null,
  stdout: "",
  stderr: "",
};

test("accepts assertion failures but rejects infrastructure and unhandled Vitest executions", () => {
  assert.doesNotThrow(() => assertVitestExecution(successfulExecution));
  assert.doesNotThrow(() => assertVitestExecution({ ...successfulExecution, status: 1 }));
  assert.throws(() => assertVitestExecution({ ...successfulExecution, status: 2 }), /infrastructure status 2/);
  assert.throws(() => assertVitestExecution({ ...successfulExecution, status: null }), /did not exit normally/);
  assert.throws(
    () => assertVitestExecution({ ...successfulExecution, stderr: "EnvironmentTeardownError: pending RPC" }),
    /unhandled runtime or teardown error/,
  );
});

test("scores complete failed assertions but rejects incomplete JSON reports", () => {
  const directory = mkdtempSync(join(tmpdir(), "session-party-rubric-test-"));
  const path = join(directory, "vitest.json");
  const check = { kind: "vitest" as const, file: "example.test.ts", title: "proves behavior" };
  try {
    writeFileSync(path, JSON.stringify({
      success: true,
      testResults: [{
        name: resolve(check.file),
        assertionResults: [{ title: check.title, status: "passed" }],
      }],
    }));
    assert.equal(readVitestOutcomes(path, [check]).get(testKey(check.file, check.title)), "passed");

    writeFileSync(path, JSON.stringify({
      success: false,
      testResults: [{
        name: resolve(check.file),
        assertionResults: [{ title: check.title, status: "failed" }],
      }],
    }));
    assert.equal(readVitestOutcomes(path, [check]).get(testKey(check.file, check.title)), "failed");

    writeFileSync(path, JSON.stringify({ testResults: [] }));
    assert.throws(() => readVitestOutcomes(path, [check]), /no completion status/);

    writeFileSync(path, JSON.stringify({ success: false, testResults: [] }));
    assert.throws(() => readVitestOutcomes(path, [check]), /assertions were not found/);

    writeFileSync(path, JSON.stringify({ success: true, unhandledErrors: [{}], testResults: [] }));
    assert.throws(() => readVitestOutcomes(path, [check]), /unhandled errors/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
