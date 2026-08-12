export type PublicRuntimeConfig = {
  readonly analytics: null | {
    readonly provider: "posthog";
    readonly key: string;
    readonly host: string;
  };
};

type AnalyticsBindings = {
  readonly POSTHOG_KEY?: string;
  readonly POSTHOG_HOST?: string;
};

const configuredValue = (value: unknown): string | null =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : null;

const httpsOrigin = (value: string): string | null => {
  try {
    const parsed = new URL(value);
    if (
      parsed.protocol !== "https:"
      || parsed.username
      || parsed.password
      || parsed.pathname !== "/"
      || parsed.search
      || parsed.hash
    ) return null;
    return parsed.origin;
  } catch {
    return null;
  }
};

export const publicRuntimeConfig = (env: AnalyticsBindings): PublicRuntimeConfig => {
  const key = configuredValue(env.POSTHOG_KEY);
  const configuredHost = configuredValue(env.POSTHOG_HOST);
  const host = configuredHost ? httpsOrigin(configuredHost) : null;
  return {
    analytics: key && host
      ? { provider: "posthog", key, host }
      : null,
  };
};
