#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

export const REQUIRED_STORAGE_ENV = [
  "REG_S3_BUCKET_NAME",
  "REG_S3_CUSTOM_DOMAIN",
  "REG_S3_ENDPOINT",
  "REG_S3_REGION",
];

export function renderConfig(source, env = process.env) {
  const missing = REQUIRED_STORAGE_ENV.filter((name) => !env[name]?.trim());
  if (missing.length > 0) {
    throw new Error(`Missing visual-regression configuration: ${missing.join(", ")}`);
  }
  return source.replace(/\$\{([A-Z0-9_]+)\}/g, (_match, name) => {
    const value = env[name];
    if (!value) throw new Error(`Missing visual-regression configuration: ${name}`);
    return value;
  });
}

function main() {
  const surface = process.argv[2];
  if (surface !== "storybook" && surface !== "pages") {
    throw new Error("Usage: render-config.mjs <storybook|pages>");
  }
  const input = resolve(`regconfig.${surface}.template.json`);
  const output = resolve(`.regconfig.${surface}.json`);
  const rendered = renderConfig(readFileSync(input, "utf8"));
  JSON.parse(rendered);
  writeFileSync(output, rendered);
  console.log(`Rendered ${output}`);
}

if (process.argv[1] && resolve(process.argv[1]) === new URL(import.meta.url).pathname) main();
