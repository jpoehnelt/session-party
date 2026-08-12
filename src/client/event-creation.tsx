import { useEffect, useState } from "react";
import { apiFetch } from "./api";

export type EventCreationConfig = {
  readonly eventCreation: {
    readonly configured: boolean;
    readonly mode: "closed" | "open";
    readonly open: boolean;
    readonly initialAdminConfigured: boolean;
  };
};

export const eventCreationNotice = (
  config: EventCreationConfig | null,
): string | null => {
  if (!config) return null;
  if (!config.eventCreation.configured) {
    return "Event creation is locked because EVENT_CREATION_MODE is not configured. An operator must explicitly choose closed or open.";
  }
  if (config.eventCreation.open) {
    return "Open event creation is enabled. Any signed-in account can create an event on this installation.";
  }
  return null;
};

export function EventCreationWarning() {
  const [config, setConfig] = useState<EventCreationConfig | null>(null);
  useEffect(() => {
    let current = true;
    void apiFetch<EventCreationConfig>("/api/v1/auth/config")
      .then((value) => { if (current) setConfig(value); })
      .catch(() => { /* A warning must not block account access. */ });
    return () => { current = false; };
  }, []);
  const notice = eventCreationNotice(config);
  return notice ? (
    <aside className="mb-5 border-2 border-danger bg-danger-soft p-4 text-sm font-bold text-danger" role="status">
      {notice} <a className="underline" href="/setup">Review setup</a>
    </aside>
  ) : null;
}
