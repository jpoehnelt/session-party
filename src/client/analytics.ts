import type { PublicRuntimeConfig } from "@/server/runtime-config";

type AnalyticsClient = {
  readonly init: (
    key: string,
    options: { readonly api_host: string; readonly defaults: "2026-05-30" },
  ) => unknown;
};

type AnalyticsDependencies = {
  readonly fetchConfig?: () => Promise<Response>;
  readonly loadPosthog?: () => Promise<{ readonly default: AnalyticsClient }>;
};

const runtimeConfig = async (fetchConfig: () => Promise<Response>): Promise<PublicRuntimeConfig | null> => {
  const response = await fetchConfig();
  if (!response.ok) return null;
  const value: unknown = await response.json();
  if (!value || typeof value !== "object" || !("analytics" in value)) return null;
  const analytics = value.analytics;
  if (analytics === null) return { analytics: null };
  if (
    !analytics
    || typeof analytics !== "object"
    || !("provider" in analytics)
    || analytics.provider !== "posthog"
    || !("key" in analytics)
    || typeof analytics.key !== "string"
    || analytics.key.length === 0
    || !("host" in analytics)
    || typeof analytics.host !== "string"
  ) return null;
  return { analytics: { provider: "posthog", key: analytics.key, host: analytics.host } };
};

export const initializeAnalytics = async ({
  fetchConfig = () => fetch("/api/v1/runtime-config", { credentials: "same-origin" }),
  loadPosthog = () => import("posthog-js"),
}: AnalyticsDependencies = {}): Promise<boolean> => {
  try {
    const config = await runtimeConfig(fetchConfig);
    if (!config?.analytics) return false;
    const { default: posthog } = await loadPosthog();
    posthog.init(config.analytics.key, {
      api_host: config.analytics.host,
      defaults: "2026-05-30",
    });
    return true;
  } catch {
    // Analytics must never delay or prevent the application from starting.
    return false;
  }
};
