import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

export const parseJsonc = (source) => {
  let output = "";
  let inString = false;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let index = 0; index < source.length; index += 1) {
    const current = source[index];
    const next = source[index + 1];
    if (lineComment) {
      if (current === "\n") {
        lineComment = false;
        output += current;
      }
      continue;
    }
    if (blockComment) {
      if (current === "*" && next === "/") {
        blockComment = false;
        index += 1;
      } else if (current === "\n") output += current;
      continue;
    }
    if (inString) {
      output += current;
      if (escaped) escaped = false;
      else if (current === "\\") escaped = true;
      else if (current === '"') inString = false;
      continue;
    }
    if (current === '"') {
      inString = true;
      output += current;
    } else if (current === "/" && next === "/") {
      lineComment = true;
      index += 1;
    } else if (current === "/" && next === "*") {
      blockComment = true;
      index += 1;
    } else output += current;
  }
  return JSON.parse(output);
};

export const renderTemplateConfig = (source) => {
  const config = structuredClone(source);
  config.name = "session-party-template";
  const database = config.d1_databases?.find(({ binding }) => binding === "DB");
  if (!database) throw new Error("Template requires a DB binding");
  database.database_name = "session-party-template";
  database.database_id = "11111111-1111-4111-8111-111111111111";
  const files = config.r2_buckets?.find(({ binding }) => binding === "FILES");
  if (!files) throw new Error("Template requires a FILES binding");
  files.bucket_name = "session-party-template-files";
  config.vars = {
    ...config.vars,
    APP_URL: "https://events.example.com",
    INITIAL_ADMIN_EMAIL: "owner@example.com",
    MAIL_FROM: "Session Party <welcome@example.com>",
    TURNSTILE_SITE_KEY: "replace-with-turnstile-site-key",
    TURNSTILE_HOSTNAMES: "events.example.com",
    ...(Object.hasOwn(config.vars ?? {}, "REGISTRATION_MODE") ? { REGISTRATION_MODE: "closed" } : {}),
    ...(Object.hasOwn(config.vars ?? {}, "POSTHOG_KEY") ? { POSTHOG_KEY: "" } : {}),
    ...(Object.hasOwn(config.vars ?? {}, "POSTHOG_HOST") ? { POSTHOG_HOST: "" } : {}),
  };
  delete config.env;
  return config;
};

export const assertTemplateIndependent = (config) => {
  const serialized = JSON.stringify(config).toLowerCase();
  const forbidden = [
    "sessionparty.com",
    "2cb93013-05e8-48bc-865d-f99a0a0096da",
    "9cfedefc6185f3dad8ab91241b401135",
    "jpoehnelt",
  ];
  for (const value of forbidden) {
    if (serialized.includes(value)) throw new Error(`Template retained owner-specific value: ${value}`);
  }
  if (config.secrets?.required?.some((name) => typeof config.vars?.[name] === "string" && config.vars[name])) {
    throw new Error("Template rendered a required secret into vars");
  }
  return config;
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [, , input = "wrangler.jsonc", output] = process.argv;
  if (!output) throw new Error("Usage: node scripts/template-install.mjs <input> <output>");
  const rendered = assertTemplateIndependent(renderTemplateConfig(parseJsonc(await readFile(input, "utf8"))));
  await writeFile(output, `${JSON.stringify(rendered, null, 2)}\n`, { flag: "wx" });
  console.log(`Rendered independent template configuration at ${output}`);
}
