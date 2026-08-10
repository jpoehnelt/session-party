import { type ChangeEvent, type FormEvent, useState } from "react";
import { useLocation } from "react-router";
import { Button, Card, Input } from "@/ui";
import { apiFetch } from "./api";
import { validReturnTo } from "./return-to";

const demoPersonas = [
  { persona: "organizer", name: "Jordan Alvarez", email: "sbek-organizer@example.com" },
  { persona: "speaker", name: "Priya Raman", email: "sbek-speaker@example.com" },
  { persona: "reviewer", name: "Sam Whitfield", email: "sbek-reviewer@example.com" },
] as const;

type DemoPersona = (typeof demoPersonas)[number]["persona"];
type DemoLoginResponse = { readonly returnTo: string };

export default function LoginPage() {
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
      const result = await apiFetch<DemoLoginResponse>("/api/v1/auth/demo", {
        method: "POST",
        body: { persona, ...(requestedReturnTo ? { returnTo: requestedReturnTo } : {}) },
      });
      window.location.assign(result.returnTo);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to start the demo session.");
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
          <span className="grid size-11 place-items-center border-2 border-line-strong bg-production-lime text-xs font-black shadow-[3px_3px_0_#7857ff]">SP</span>
          <p className="text-sm font-black tracking-[-0.02em] text-ink">Session Party</p>
        </div>
        <p className="text-[10px] font-black uppercase tracking-[0.16em] text-accent-deep">Organizer access</p>
        <h1 className="mt-2 text-4xl font-black tracking-[-0.055em]">Back to the control room.</h1>
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
