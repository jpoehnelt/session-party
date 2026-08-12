import { useEffect, useState } from "react";
import { apiFetch } from "./api";

export type RegistrationConfig = {
  readonly registration: {
    readonly configured: boolean;
    readonly mode: "closed" | "open";
    readonly open: boolean;
    readonly initialAdminConfigured: boolean;
  };
};

export const registrationNotice = (
  config: RegistrationConfig | null,
): string | null => {
  if (!config) return null;
  if (!config.registration.configured) {
    return "Registration is locked because REGISTRATION_MODE is not configured. An operator must explicitly choose closed or open.";
  }
  if (config.registration.open) {
    return "Open registration is enabled. Anyone can create an account on this installation.";
  }
  return null;
};

export function RegistrationWarning() {
  const [config, setConfig] = useState<RegistrationConfig | null>(null);
  useEffect(() => {
    let current = true;
    void apiFetch<RegistrationConfig>("/api/v1/auth/config")
      .then((value) => { if (current) setConfig(value); })
      .catch(() => { /* A warning must not block account access. */ });
    return () => { current = false; };
  }, []);
  const notice = registrationNotice(config);
  return notice ? (
    <aside className="mb-5 border-2 border-danger bg-danger-soft p-4 text-sm font-bold text-danger" role="status">
      {notice} <a className="underline" href="/setup">Review setup</a>
    </aside>
  ) : null;
}
