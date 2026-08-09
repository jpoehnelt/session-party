import assert from "node:assert/strict";
import test from "node:test";
import { renderConfig } from "./render-config.mjs";

const env = {
  REG_S3_BUCKET_NAME: "visuals",
  REG_S3_CUSTOM_DOMAIN: "https://visuals.example.test",
  REG_S3_ENDPOINT: "https://r2.example.test",
  REG_S3_REGION: "auto",
};

test("renderConfig replaces storage placeholders", () => {
  assert.equal(renderConfig('${REG_S3_BUCKET_NAME}:${REG_S3_REGION}', env), "visuals:auto");
});

test("renderConfig rejects incomplete storage configuration", () => {
  assert.throws(() => renderConfig("{}", {}), /REG_S3_BUCKET_NAME/);
});
