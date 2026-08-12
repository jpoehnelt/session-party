export type EventCreationMode = "closed" | "open";

type EventCreationBindings = {
  readonly EVENT_CREATION_MODE?: string;
  readonly INITIAL_ADMIN_EMAIL?: string;
};

export type EventCreationPolicy = {
  readonly configured: boolean;
  readonly mode: EventCreationMode;
  readonly initialAdminEmail: string | null;
};

const normalizedEmail = (value: unknown): string | null =>
  typeof value === "string" && value.trim().length > 0
    ? value.trim().toLowerCase()
    : null;

export const eventCreationPolicy = (env: EventCreationBindings): EventCreationPolicy => {
  const configuredMode = typeof env.EVENT_CREATION_MODE === "string"
    ? env.EVENT_CREATION_MODE.trim().toLowerCase()
    : "";
  return {
    configured: configuredMode === "closed" || configuredMode === "open",
    mode: configuredMode === "open" ? "open" : "closed",
    initialAdminEmail: normalizedEmail(env.INITIAL_ADMIN_EMAIL),
  };
};

export const mayCreateEvent = (
  policy: EventCreationPolicy,
  normalizedCandidateEmail: string,
  ownsEvent: boolean,
): boolean => policy.configured && (
  policy.mode === "open"
  || policy.initialAdminEmail === normalizedCandidateEmail
  || ownsEvent
);
