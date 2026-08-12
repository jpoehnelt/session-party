import { type ChangeEvent, type FormEvent, useState } from "react";
import { useLocation } from "react-router";
import { Button, Card, Input } from "@/ui";
import { apiFetch } from "./api";
import { validReturnTo } from "./return-to";
import { brandAssetUrl, useBrand } from "@/features/branding/components/client";

const demoPersonas = [
  { persona: "organizer", name: "Jordan Alvarez", email: "sbek-organizer@example.com" },
  { persona: "speaker", name: "Priya Raman", email: "sbek-speaker@example.com" },
  { persona: "reviewer", name: "Sam Whitfield", email: "sbek-reviewer@example.com" },
] as const;

type DemoPersona = (typeof demoPersonas)[number]["persona"];
type DemoLoginResponse = { readonly returnTo: string };
type DemoLoginRequest = (
  path: string,
  options: { readonly method: string; readonly body: unknown; readonly signal: AbortSignal },
) => Promise<DemoLoginResponse>;

export const DEMO_LOGIN_TIMEOUT_MS = 10_000;
const DEMO_LOGIN_TIMEOUT_MESSAGE = "Demo sign-in took too long. Try again.";

export async function requestDemoLogin(
  persona: DemoPersona,
  requestedReturnTo: string | undefined,
  request: DemoLoginRequest = apiFetch,
  timeoutMs = DEMO_LOGIN_TIMEOUT_MS,
): Promise<DemoLoginResponse> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await request("/api/v1/auth/demo", {
      method: "POST",
      body: { persona, ...(requestedReturnTo ? { returnTo: requestedReturnTo } : {}) },
      signal: controller.signal,
    });
  } catch (cause) {
    if (controller.signal.aborted) throw new Error(DEMO_LOGIN_TIMEOUT_MESSAGE);
    throw cause;
  } finally {
    clearTimeout(timeout);
  }
}

export default function LoginPage() {
  const { brand } = useBrand();
  const { search } = useLocation();
  const requestedReturnTo = validReturnTo(search);
  const returnTo = requestedReturnTo ?? "/events";
  const [email, setEmail] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string>();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [activeDemoPersona, setActiveDemoPersona] = useState<DemoPersona>();

  async function signInAsDemo(persona: DemoPersona) {
    setError(undefined);
    setActiveDemoPersona(persona);
    try {
      const result = await requestDemoLogin(persona, requestedReturnTo);
      window.location.assign(result.returnTo);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to start the demo session.");
    } finally {
      setActiveDemoPersona(undefined);
    }
  }

  async function requestLink(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(undefined);
    setIsSubmitting(true);

    try {
      await apiFetch("/api/v1/auth/request-link", {
        method: "POST",
        body: { email, returnTo },
      });
      setSubmitted(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to request a sign-in link.");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <main className="production-grid flex min-h-screen items-center justify-center bg-canvas px-6 py-12">
      <Card className="w-full max-w-lg">
        <div className="mb-6 flex items-center gap-3 border-b-2 border-line-strong pb-5">
          {brand.logoAssetId ? <img className="max-h-12 max-w-40 object-contain" src={brandAssetUrl(brand.logoAssetId)!} alt="" /> : <span className="grid size-11 place-items-center rounded-control border-2 border-line-strong bg-accent text-xs font-black text-on-accent shadow-button">{brand.name.slice(0, 2).toUpperCase()}</span>}
          <p className="text-sm font-black tracking-[-0.02em] text-ink">{brand.name}</p>
        </div>
        <p className="text-[10px] font-black uppercase tracking-[0.16em] text-accent-deep">Account access</p>
        <h1 className="mt-2 text-4xl font-black tracking-[-0.055em]">Back to {brand.name}.</h1>
        <section className="mt-6 border-2 border-line-strong bg-production-sky p-4" aria-labelledby="demo-access-heading">
          <p className="text-[10px] font-black uppercase tracking-[0.16em] text-accent-deep">Hackathon demo access</p>
          <h2 id="demo-access-heading" className="mt-1 text-xl font-black tracking-[-0.035em]">Choose a role</h2>
          <p className="mt-2 text-sm font-medium text-ink-secondary">
            These synthetic accounts let evaluators switch roles without an email inbox.
          </p>
          <div className="mt-4 grid gap-3">
            {demoPersonas.map(({ persona, name, email }) => (
              <Button
                key={persona}
                className="min-h-14 w-full flex-col items-start gap-1 whitespace-normal px-4 text-left normal-case tracking-normal"
                variant="secondary"
                disabled={activeDemoPersona !== undefined}
                loading={activeDemoPersona === persona}
                onClick={() => void signInAsDemo(persona)}
              >
                <span>Continue as {persona.charAt(0).toUpperCase() + persona.slice(1)} — {name}</span>
                <span className="break-all text-[10px] font-bold text-ink-secondary">{email}</span>
              </Button>
            ))}
          </div>
        </section>
        <div className="my-6 flex items-center gap-3" aria-hidden="true">
          <span className="h-0.5 flex-1 bg-line-strong" />
          <span className="text-[10px] font-black uppercase tracking-[0.12em] text-ink-faint">or use email</span>
          <span className="h-0.5 flex-1 bg-line-strong" />
        </div>
        {submitted ? (
          <p className="mt-5 border-2 border-line-strong bg-success-soft p-4 text-sm font-bold text-ink">
            Check your email for a sign-in link.
          </p>
        ) : (
          <form className="mt-6 space-y-4" onSubmit={requestLink}>
            <label className="block space-y-2" htmlFor="email">
              <span className="text-[11px] font-black uppercase tracking-[0.08em]">Email address</span>
              <Input
                id="email"
                type="email"
                autoComplete="email"
                value={email}
                onChange={(event: ChangeEvent<HTMLInputElement>) => setEmail(event.target.value)}
                required
              />
            </label>
            {error ? <p className="border-2 border-line-strong bg-danger-soft p-3 text-sm font-bold text-danger">{error}</p> : null}
            <Button className="min-h-11 w-full" type="submit" disabled={isSubmitting}>
              {isSubmitting ? "Sending link…" : "Email me a sign-in link"}
            </Button>
          </form>
        )}
      </Card>
    </main>
  );
}
