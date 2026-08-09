import { type ChangeEvent, type FormEvent, useState } from "react";
import { useLocation } from "react-router";
import { Button, Card, Input } from "@/ui";
import { apiFetch } from "./api";
import { validReturnTo } from "./return-to";

export default function LoginPage() {
  const { search } = useLocation();
  const returnTo = validReturnTo(search) ?? "/events";
  const [email, setEmail] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string>();
  const [isSubmitting, setIsSubmitting] = useState(false);

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
