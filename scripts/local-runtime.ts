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

const LOOPBACK_HOST = "127.0.0.1";
const SUPERVISOR_HOST = "0.0.0.0";

const parseOrigin = (value: string, expected: string): string => {
  const origin = new URL(value).origin;
  if (origin !== expected || value !== origin) {
    throw new Error(`PASEO_BASE_URL must be exactly ${expected}`);
  }
  return origin;
};

export const resolveLocalRuntime = (
  env: NodeJS.ProcessEnv = process.env,
): LocalRuntime => {
  const configuredHost = env.HOST?.trim() || LOOPBACK_HOST;
  const assignedPort = env.PASEO_PORT?.trim();
  if (
    configuredHost !== LOOPBACK_HOST
    && (configuredHost !== SUPERVISOR_HOST || !assignedPort)
  ) {
    throw new Error(
      `HOST must be ${LOOPBACK_HOST}, or ${SUPERVISOR_HOST} with an assigned PASEO_PORT`,
    );
  }
  const host = configuredHost;
  const port = parsePort(assignedPort || "5173");
  const expectedOrigin = `http://${LOOPBACK_HOST}:${port}`;
  const origin = env.PASEO_BASE_URL?.trim()
    ? parseOrigin(env.PASEO_BASE_URL.trim(), expectedOrigin)
    : expectedOrigin;
  return { host, port, origin };
};
