import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

for (const configPath of ["wrangler.jsonc", "wrangler.local.jsonc"]) {
  test(`${configPath} sends public schedule feeds through the Worker`, () => {
    const config = readFileSync(configPath, "utf8");
    const runWorkerFirst = /"run_worker_first"\s*:\s*\[([^\]]+)]/.exec(config)?.[1];

    assert.ok(runWorkerFirst, `${configPath} must define assets.run_worker_first`);
    assert.match(runWorkerFirst, /"\/events\/\*"/);
  });
}
