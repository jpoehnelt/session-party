export interface LocalRuntime {
  readonly host: string;
  readonly port: number;
  readonly origin: string;
}

const parsePort = (value: string): number => {
  if (!/^\d+$/.test(value)) throw new Error(`Invalid PASEO_PORT: ${value}`);
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`Invalid PASEO_PORT: ${value}`);
  }
  return port;
};

const parseOrigin = (value: string): string => {
  const url = new URL(value);
  if (
    (url.protocol !== "http:" && url.protocol !== "https:")
    || url.username
    || url.password
    || url.pathname !== "/"
    || url.search
    || url.hash
  ) {
    throw new Error("PASEO_BASE_URL must be an HTTP(S) origin");
  }
  return url.origin;
};

export const resolveLocalRuntime = (
  env: NodeJS.ProcessEnv = process.env,
): LocalRuntime => {
  const host = env.HOST?.trim() || "127.0.0.1";
  const port = parsePort(env.PASEO_PORT?.trim() || "5173");
  const origin = env.PASEO_BASE_URL?.trim()
    ? parseOrigin(env.PASEO_BASE_URL.trim())
    : `http://${host.includes(":") ? `[${host}]` : host}:${port}`;
  return { host, port, origin };
};
