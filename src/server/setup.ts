import { Hono } from "hono";
import { sessionUser } from "./auth";
import { eventCreationPolicy } from "./event-creation";
import { isExplicitLocalEnvironment, isExplicitPreviewEnvironment, sessionSecret } from "./services";

type AppHono = { Bindings: Env };
type SetupStatus = "fail" | "pass" | "warn";

export type SetupCheck = {
  readonly key: "database" | "domain" | "durableObjects" | "email" | "initialAdmin" | "r2" | "turnstile";
  readonly label: string;
  readonly status: SetupStatus;
  readonly message: string;
};

export const EXPECTED_LATEST_MIGRATION = "0017_add_reusable_speaker_profile_pages";
const PROBE_TIMEOUT_MS = 3_000;

const check = (
  key: SetupCheck["key"],
  label: string,
  status: SetupStatus,
  message: string,
): SetupCheck => ({ key, label, status, message });

const configuredString = (value: unknown): string | null =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : null;

const appUrl = (env: Env): URL | null => {
  try {
    const parsed = new URL(configuredString(env.APP_URL) ?? "");
    return parsed.pathname === "/" && !parsed.search && !parsed.hash ? parsed : null;
  } catch {
    return null;
  }
};

const domainCheck = (request: Request, env: Env): SetupCheck => {
  const configured = appUrl(env);
  if (!configured) return check("domain", "Custom domain", "fail", "APP_URL is missing or invalid.");
  const actual = new URL(request.url);
  return actual.origin === configured.origin
    ? check("domain", "Custom domain", "pass", "The request origin matches APP_URL.")
    : check("domain", "Custom domain", "fail", "The current origin does not match APP_URL.");
};

const databaseCheck = async (env: Env): Promise<SetupCheck> => {
  try {
    const row = await env.DB.prepare(
      "SELECT name FROM d1_migrations ORDER BY id DESC LIMIT 1",
    ).first<{ name: string }>();
    return row?.name.startsWith(EXPECTED_LATEST_MIGRATION)
      ? check("database", "D1 migrations", "pass", "The database is on the expected migration.")
      : check("database", "D1 migrations", "fail", "The database is missing one or more application migrations.");
  } catch {
    return check("database", "D1 migrations", "fail", "The D1 binding or migration history is unavailable.");
  }
};

const r2Check = async (env: Env): Promise<SetupCheck> => {
  try {
    await env.FILES.head("__session_party_setup_probe__");
    return check("r2", "R2 files", "pass", "The FILES bucket is readable.");
  } catch {
    return check("r2", "R2 files", "fail", "The FILES bucket is unavailable.");
  }
};

const healthRequest = (env: Env): RequestInit => ({
  method: "POST",
  headers: { "x-session-party-internal": sessionSecret(env) },
  signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
});

const durableObjectsCheck = async (env: Env): Promise<SetupCheck> => {
  try {
    const request = healthRequest(env);
    const [eventRoom, scheduler] = await Promise.all([
      env.EVENT_ROOM.get(env.EVENT_ROOM.idFromName("setup-health")).fetch(
        "https://event-room/health",
        request,
      ),
      env.SCHEDULER.get(env.SCHEDULER.idFromName("setup-health")).fetch(
        "https://scheduler/health",
        request,
      ),
    ]);
    return eventRoom.ok && scheduler.ok
      ? check("durableObjects", "Durable Objects", "pass", "EventRoom and Scheduler responded.")
      : check("durableObjects", "Durable Objects", "fail", "A required Durable Object did not respond.");
  } catch {
    return check("durableObjects", "Durable Objects", "fail", "Required Durable Object bindings are unavailable.");
  }
};

const emailCheck = (env: Env): SetupCheck => {
  if (isExplicitLocalEnvironment(env) || isExplicitPreviewEnvironment(env)) {
    return check("email", "Login email", "warn", "This environment captures email instead of delivering it.");
  }
  const from = configuredString(env.MAIL_FROM);
  return env.EMAIL && from && /@[^>\s]+/.test(from)
    ? check("email", "Login email", "pass", "Email delivery and MAIL_FROM are configured.")
    : check("email", "Login email", "fail", "Configure the EMAIL binding and a valid MAIL_FROM sender.");
};

const turnstileCheck = (env: Env): SetupCheck => {
  if (isExplicitLocalEnvironment(env) || isExplicitPreviewEnvironment(env)) {
    return check("turnstile", "Turnstile", "warn", "This environment uses non-production abuse controls.");
  }
  const configuredUrl = appUrl(env);
  const siteKey = configuredString(env.TURNSTILE_SITE_KEY);
  const secret = configuredString(env.TURNSTILE_SECRET);
  const hostnames = new Set(
    (configuredString(env.TURNSTILE_HOSTNAMES) ?? "")
      .split(",")
      .map((hostname) => hostname.trim().toLowerCase())
      .filter(Boolean),
  );
  return configuredUrl && siteKey && secret && hostnames.has(configuredUrl.hostname.toLowerCase())
    ? check("turnstile", "Turnstile", "pass", "Turnstile is configured for the application hostname.")
    : check("turnstile", "Turnstile", "fail", "Configure both Turnstile keys and include the APP_URL hostname.");
};

const initialAdminCheck = (env: Env, operatorEmail: string): SetupCheck => {
  const policy = eventCreationPolicy(env);
  if (!policy.configured) {
    return check("initialAdmin", "Event creation", "fail", "Set EVENT_CREATION_MODE to closed or open.");
  }
  if (policy.mode === "open") {
    return check("initialAdmin", "Event creation", "warn", "Open event creation is enabled; any signed-in account can create an event.");
  }
  if (!policy.initialAdminEmail) {
    return check("initialAdmin", "Event creation", "fail", "Closed event creation requires INITIAL_ADMIN_EMAIL.");
  }
  return policy.initialAdminEmail === operatorEmail.toLowerCase()
    ? check("initialAdmin", "Event creation", "pass", "Closed event creation and initial-admin access are configured.")
    : check("initialAdmin", "Event creation", "warn", "Event creation is closed; this operator is authorized as an existing event owner.");
};

const mayViewSetup = async (env: Env, userId: string, email: string): Promise<boolean> => {
  const initialAdminEmail = eventCreationPolicy(env).initialAdminEmail;
  if (initialAdminEmail === email.toLowerCase()) return true;
  try {
    const row = await env.DB.prepare(
      "SELECT 1 AS allowed FROM event_members WHERE user_id = ? AND role = 'owner' LIMIT 1",
    ).bind(userId).first<{ allowed: number }>();
    return row?.allowed === 1;
  } catch {
    return false;
  }
};

export const runSetupChecks = async (
  request: Request,
  env: Env,
  operatorEmail: string,
): Promise<readonly SetupCheck[]> => {
  const [database, r2, durableObjects] = await Promise.all([
    databaseCheck(env),
    r2Check(env),
    durableObjectsCheck(env),
  ]);
  return [
    domainCheck(request, env),
    database,
    r2,
    durableObjects,
    emailCheck(env),
    turnstileCheck(env),
    initialAdminCheck(env, operatorEmail),
  ];
};

const setup = new Hono<AppHono>();

setup.get("/", async (c) => {
  const principal = await sessionUser(c).catch(() => null);
  if (!principal || principal.kind !== "browser-session") {
    return c.json({ error: "Unauthenticated", message: "Sign in to inspect setup." }, 401);
  }
  if (!(await mayViewSetup(c.env, principal.userId, principal.email))) {
    return c.json({ error: "Forbidden", message: "Initial-admin or event-owner access is required." }, 403);
  }
  const checks = await runSetupChecks(c.req.raw, c.env, principal.email);
  const failures = checks.filter(({ status }) => status === "fail").length;
  const warnings = checks.filter(({ status }) => status === "warn").length;
  return c.json({
    operatorEmail: principal.email,
    ready: failures === 0,
    failures,
    warnings,
    checks,
  });
});

export default setup;
