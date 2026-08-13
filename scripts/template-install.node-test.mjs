import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { assertTemplateIndependent, parseJsonc, renderTemplateConfig } from "./template-install.mjs";

test("renders a fresh installation without owner resources or defaults", async () => {
  const source = parseJsonc(await readFile("wrangler.jsonc", "utf8"));
  const rendered = assertTemplateIndependent(renderTemplateConfig(source));
  assert.equal(rendered.name, "session-party-template");
  assert.deepEqual(rendered.d1_databases, [{
    binding: "DB",
    database_name: "session-party-template",
    database_id: "11111111-1111-4111-8111-111111111111",
    migrations_dir: "migrations",
  }]);
  assert.equal(rendered.r2_buckets[0].bucket_name, "session-party-template-files");
  assert.equal(rendered.vars.APP_URL, "https://events.example.com");
  assert.equal(rendered.env, undefined);
});

test("parses comment-like text inside JSON strings without stripping it", () => {
  assert.deepEqual(parseJsonc('{"url":"https://example.com/a/*b*/" // comment\n}'), {
    url: "https://example.com/a/*b*/",
  });
});
