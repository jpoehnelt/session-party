import { useCallback, useEffect, useState } from "react";
import { Button, Card } from "@/ui";
import { apiFetch } from "./api";

type SetupStatus = "fail" | "pass" | "warn";
type SetupResponse = {
  readonly operatorEmail: string;
  readonly ready: boolean;
  readonly failures: number;
  readonly warnings: number;
  readonly checks: readonly {
    readonly key: string;
    readonly label: string;
    readonly status: SetupStatus;
    readonly message: string;
  }[];
};

const statusStyles: Readonly<Record<SetupStatus, string>> = {
  pass: "border-success bg-success-soft text-success",
  warn: "border-warning bg-warning-soft text-ink",
  fail: "border-danger bg-danger-soft text-danger",
};

export default function SetupPage() {
  const [setup, setSetup] = useState<SetupResponse>();
  const [error, setError] = useState<string>();
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);

  const refresh = useCallback(async () => {
    setError(undefined);
    try {
      setSetup(await apiFetch<SetupResponse>("/api/v1/setup"));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to inspect this installation.");
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  async function sendTestLoginEmail() {
    if (!setup || sending) return;
    setSending(true);
    setSent(false);
    setError(undefined);
    try {
      await apiFetch("/api/v1/auth/request-link", {
        method: "POST",
        body: { email: setup.operatorEmail, returnTo: "/setup" },
      });
      setSent(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to queue the test login email.");
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="space-y-6">
      <header>
        <p className="text-[10px] font-black uppercase tracking-[0.16em] text-accent-deep">Self-hosting</p>
        <h1 className="mt-2 text-4xl font-black tracking-[-0.055em]">Installation setup</h1>
        <p className="mt-3 max-w-3xl text-sm font-medium text-ink-secondary">
          Verify the bindings and access paths this installation needs before inviting a team or opening a CFP.
        </p>
      </header>

      {error ? <p className="border-2 border-danger bg-danger-soft p-4 text-sm font-bold text-danger">{error}</p> : null}

      {setup ? (
        <>
          <Card className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <p className="text-[10px] font-black uppercase tracking-[0.12em] text-ink-secondary">Current result</p>
              <p className="mt-1 text-xl font-black">
                {setup.ready ? "Ready" : `${setup.failures} setup ${setup.failures === 1 ? "issue" : "issues"}`}
              </p>
              <p className="mt-1 text-sm text-ink-secondary">{setup.warnings} warning{setup.warnings === 1 ? "" : "s"}</p>
            </div>
            <Button variant="secondary" onClick={() => void refresh()}>Run checks again</Button>
          </Card>

          <div className="grid gap-4 md:grid-cols-2">
            {setup.checks.map((item) => (
              <Card key={item.key} className={`border-2 ${statusStyles[item.status]}`}>
                <p className="text-[10px] font-black uppercase tracking-[0.12em]">{item.status}</p>
                <h2 className="mt-1 text-lg font-black">{item.label}</h2>
                <p className="mt-2 text-sm font-medium">{item.message}</p>
              </Card>
            ))}
          </div>

          <Card>
            <h2 className="text-xl font-black">Test login delivery</h2>
            <p className="mt-2 text-sm text-ink-secondary">
              Queue a normal one-time sign-in link to {setup.operatorEmail}. No provider secret or token is returned to the browser.
            </p>
            <div className="mt-4 flex flex-wrap items-center gap-3">
              <Button loading={sending} disabled={sending} onClick={() => void sendTestLoginEmail()}>
                {sending ? "Queuing…" : "Send test login email"}
              </Button>
              {sent ? <p className="text-sm font-bold text-success">Queued. Check the inbox and delivery logs.</p> : null}
            </div>
          </Card>
        </>
      ) : !error ? <p className="text-sm font-bold text-ink-secondary">Running setup checks…</p> : null}
    </div>
  );
}
