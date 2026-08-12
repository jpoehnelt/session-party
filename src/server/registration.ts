export type RegistrationMode = "closed" | "open";

type RegistrationBindings = {
  readonly REGISTRATION_MODE?: string;
  readonly INITIAL_ADMIN_EMAIL?: string;
};

export type RegistrationPolicy = {
  readonly configured: boolean;
  readonly mode: RegistrationMode;
  readonly initialAdminEmail: string | null;
};

const normalizedEmail = (value: unknown): string | null =>
  typeof value === "string" && value.trim().length > 0
    ? value.trim().toLowerCase()
    : null;

export const registrationPolicy = (env: RegistrationBindings): RegistrationPolicy => {
  const configuredMode = typeof env.REGISTRATION_MODE === "string"
    ? env.REGISTRATION_MODE.trim().toLowerCase()
    : "";
  return {
    configured: configuredMode === "closed" || configuredMode === "open",
    mode: configuredMode === "open" ? "open" : "closed",
    initialAdminEmail: normalizedEmail(env.INITIAL_ADMIN_EMAIL),
  };
};

export const mayCreateAccount = (
  policy: RegistrationPolicy,
  normalizedCandidateEmail: string,
): boolean => policy.configured && (
  policy.mode === "open"
  || policy.initialAdminEmail === normalizedCandidateEmail
);
