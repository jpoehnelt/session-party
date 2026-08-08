import { type ChangeEvent, type FormEvent, useState } from "react";
import { Button, Card, Input } from "@/ui";
import { apiFetch } from "./api";

export default function LoginPage() {
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
        body: { email },
      });
      setSubmitted(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to request a sign-in link.");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-md items-center px-6 py-12">
      <Card className="w-full p-8">
        <p className="text-sm font-medium text-muted-foreground">Session Party</p>
        <h1 className="mt-2 text-2xl font-semibold">Sign in</h1>
        {submitted ? (
          <p className="mt-4 text-sm text-muted-foreground">
            Check your email for a sign-in link.
          </p>
        ) : (
          <form className="mt-6 space-y-4" onSubmit={requestLink}>
            <label className="block space-y-2" htmlFor="email">
              <span className="text-sm font-medium">Email address</span>
              <Input
                id="email"
                type="email"
                autoComplete="email"
                value={email}
                onChange={(event: ChangeEvent<HTMLInputElement>) => setEmail(event.target.value)}
                required
              />
            </label>
            {error ? <p className="text-sm text-destructive">{error}</p> : null}
            <Button className="w-full" type="submit" disabled={isSubmitting}>
              {isSubmitting ? "Sending link…" : "Email me a sign-in link"}
            </Button>
          </form>
        )}
      </Card>
    </main>
  );
}
