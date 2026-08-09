import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { Schema } from "effect";
import { ApiError, apiFetch } from "@/client/api";
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
  Button,
  Card,
  EmptyState,
  Skeleton,
  Textarea,
  Toaster,
  toast,
} from "@/ui";
import {
  OwnSubmissions,
  UpdateOwnSubmissionAbstractOutput,
  type OwnSubmissions as OwnSubmissionsValue,
} from "../schema";

export const path = "/portal/events/:eventSlug/submissions";
export const layout = "bare" as const;

const segment = encodeURIComponent;

async function responseMessage(response: Response): Promise<string> {
  const payload = await response.json().catch(() => null) as unknown;
  if (payload && typeof payload === "object" && "message" in payload && typeof payload.message === "string") {
    return payload.message;
  }
  return response.statusText || `Request failed with status ${response.status}`;
}

export const fetchOwnSubmissions = (eventSlug: string) =>
  apiFetch(`/api/v1/events/by-slug/${segment(eventSlug)}/my-submissions`, { schema: OwnSubmissions });

export async function updateOwnAbstract(input: {
  readonly eventSlug: string;
  readonly submissionId: string;
  readonly abstract: string;
  readonly expectedVersion: number;
  readonly idempotencyKey: string;
}) {
  const response = await fetch(
    `/api/v1/events/by-slug/${segment(input.eventSlug)}/my-submissions/${segment(input.submissionId)}/abstract`,
    {
      method: "PUT",
      credentials: "include",
      headers: { "Content-Type": "application/json", "idempotency-key": input.idempotencyKey },
      body: JSON.stringify({ abstract: input.abstract, expectedVersion: input.expectedVersion }),
    },
  );
  if (!response.ok) throw new ApiError(response.status, await responseMessage(response));
  return Schema.decodeUnknownSync(UpdateOwnSubmissionAbstractOutput)(await response.json());
}

const statusTone = {
  submitted: "neutral",
  in_review: "accent",
  accepted: "success",
  rejected: "danger",
  waitlist: "warning",
  withdrawn: "neutral",
} as const;

const statusLabel = {
  submitted: "Submitted",
  in_review: "In review",
  accepted: "Accepted",
  rejected: "Rejected",
  waitlist: "Waitlist",
  withdrawn: "Withdrawn",
} as const;

const statusPanel = {
  submitted: "[&>header]:bg-production-sky [&>header_h3]:text-ink",
  in_review: "[&>header]:bg-accent [&>header_h3]:text-on-accent",
  accepted: "[&>header]:bg-production-lime [&>header_h3]:text-ink",
  rejected: "[&>header]:bg-danger-soft [&>header_h3]:text-ink",
  waitlist: "[&>header]:bg-production-yellow [&>header_h3]:text-ink",
  withdrawn: "[&>header]:bg-surface-muted [&>header_h3]:text-ink",
} as const;

function ProposalPortalShell({ children }: { readonly children: ReactNode }) {
  return (
    <div className="production-grid min-h-dvh bg-canvas text-ink">
      <header className="border-b-2 border-line-strong bg-canvas">
        <div className="mx-auto flex h-18 max-w-6xl items-center justify-between gap-4 px-4 sm:px-6 lg:px-8">
          <Link className="inline-flex items-center gap-3 no-underline" to="/" aria-label="Session Party home">
            <span className="grid size-9 place-items-center border-2 border-line-strong bg-production-lime text-[11px] font-black tracking-[-0.04em] shadow-[3px_3px_0_#171714]">
              SP
            </span>
            <span className="text-sm font-black tracking-[-0.03em]">Session Party</span>
          </Link>
          <span className="border-2 border-line-strong bg-production-sky px-3 py-1.5 text-[10px] font-black uppercase tracking-[0.14em] shadow-[3px_3px_0_#171714]">
            Proposal tracker
          </span>
        </div>
      </header>
      {children}
    </div>
  );
}

export interface MySubmissionsPageProps {
  readonly initialData?: OwnSubmissionsValue;
}

export default function MySubmissionsPage({ initialData }: MySubmissionsPageProps) {
  const { eventSlug = "" } = useParams();
  const navigate = useNavigate();
  const [data, setData] = useState<OwnSubmissionsValue | null>(initialData ?? null);
  const [loading, setLoading] = useState(initialData === undefined);
  const [error, setError] = useState<{ readonly status: number; readonly message: string } | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>(
    Object.fromEntries(initialData?.submissions.map((submission) => [submission.id, submission.abstract]) ?? []),
  );
  const [savingId, setSavingId] = useState<string | null>(null);
  const idempotencyKeys = useRef<Record<string, string>>({});

  useEffect(() => {
    if (initialData !== undefined) return;
    let active = true;
    setLoading(true);
    void fetchOwnSubmissions(eventSlug).then(
      (loaded) => {
        if (!active) return;
        setData(loaded);
        setDrafts(Object.fromEntries(loaded.submissions.map((submission) => [submission.id, submission.abstract])));
        setError(null);
        setLoading(false);
      },
      (cause) => {
        if (!active) return;
        setError({
          status: cause instanceof ApiError ? cause.status : 500,
          message: cause instanceof Error ? cause.message : "Could not load your submissions",
        });
        setLoading(false);
      },
    );
    return () => { active = false; };
  }, [eventSlug, initialData]);

  async function save(submissionId: string) {
    const current = data?.submissions.find((submission) => submission.id === submissionId);
    if (!current) return;
    const abstract = drafts[submissionId]?.trim() ?? "";
    if (!abstract) {
      toast("Abstract is required", { tone: "danger" });
      return;
    }
    setSavingId(submissionId);
    try {
      const idempotencyKey = idempotencyKeys.current[submissionId] ?? crypto.randomUUID();
      idempotencyKeys.current[submissionId] = idempotencyKey;
      const result = await updateOwnAbstract({
        eventSlug,
        submissionId,
        abstract,
        expectedVersion: current.version,
        idempotencyKey,
      });
      delete idempotencyKeys.current[submissionId];
      setData((value) => value && ({
        ...value,
        submissions: value.submissions.map((submission) =>
          submission.id === submissionId ? result.submission : submission),
      }));
      setDrafts((value) => ({ ...value, [submissionId]: result.submission.abstract }));
      toast("Proposal updated", { tone: "success" });
    } catch (cause) {
      toast(cause instanceof Error ? cause.message : "Proposal could not be updated", { tone: "danger" });
    } finally {
      setSavingId(null);
    }
  }

  if (loading) {
    return (
      <ProposalPortalShell>
        <main className="mx-auto grid max-w-6xl gap-6 px-4 py-10 sm:px-6 sm:py-16 lg:grid-cols-[0.72fr_1.28fr] lg:px-8">
          <Skeleton className="h-64 border-2 border-line-strong" />
          <Skeleton className="h-[32rem] border-2 border-line-strong" />
        </main>
      </ProposalPortalShell>
    );
  }
  if (error?.status === 401) {
    const returnTo = `/portal/events/${eventSlug}/submissions`;
    return (
      <ProposalPortalShell>
        <main className="mx-auto max-w-2xl px-4 py-12 sm:px-6 sm:py-20 lg:px-8">
          <div className="border-[3px] border-line-strong bg-production-yellow p-2 shadow-[8px_8px_0_#171714]">
            <EmptyState
              title="Sign in to manage your proposals"
              description="Use the same email address you entered on the call for proposals."
              action={<Button onClick={() => navigate(`/login?returnTo=${encodeURIComponent(returnTo)}`)}>Sign in</Button>}
            />
          </div>
        </main>
      </ProposalPortalShell>
    );
  }
  if (error || !data) {
    return (
      <ProposalPortalShell>
        <main className="mx-auto max-w-2xl px-4 py-12 sm:px-6 sm:py-20 lg:px-8">
          <div className="border-[3px] border-line-strong bg-danger-soft p-2 shadow-[8px_8px_0_#171714]">
            <EmptyState title="Submissions could not be loaded" description={error?.message ?? "Try again."} />
          </div>
        </main>
      </ProposalPortalShell>
    );
  }

  return (
    <ProposalPortalShell>
      <main className="mx-auto max-w-6xl px-4 py-10 sm:px-6 sm:py-16 lg:px-8">
        <header className="border-[3px] border-line-strong bg-accent p-6 text-on-accent shadow-[9px_9px_0_#171714] sm:p-8">
          <p className="inline-block border-2 border-white bg-production-lime px-3 py-1.5 text-[10px] font-black uppercase tracking-[0.15em] text-ink shadow-[3px_3px_0_#171714]">
            {data.event.name}
          </p>
          <h1 className="mt-7 text-5xl font-black leading-[0.86] tracking-[-0.065em] text-white sm:text-7xl">Your proposals</h1>
          <p className="mt-5 max-w-2xl text-sm font-semibold leading-6 text-white/75">
            Statuses and edits here are scoped to the email on your signed-in account.
          </p>
          <dl className="mt-8 grid max-w-2xl grid-cols-3 border-2 border-line-strong bg-surface text-ink shadow-[4px_4px_0_#171714]">
            <div className="bg-production-sky px-3 py-3">
              <dt className="text-[9px] font-black uppercase tracking-[0.12em]">On file</dt>
              <dd className="mt-1 text-2xl font-black leading-none">{data.submissions.length}</dd>
            </div>
            <div className="border-l-2 border-line-strong bg-production-yellow px-3 py-3">
              <dt className="text-[9px] font-black uppercase tracking-[0.12em]">In review</dt>
              <dd className="mt-1 text-2xl font-black leading-none">{data.submissions.filter((submission) => submission.status === "in_review").length}</dd>
            </div>
            <div className="border-l-2 border-line-strong bg-production-lime px-3 py-3">
              <dt className="text-[9px] font-black uppercase tracking-[0.12em]">Accepted</dt>
              <dd className="mt-1 text-2xl font-black leading-none">{data.submissions.filter((submission) => submission.status === "accepted").length}</dd>
            </div>
          </dl>
        </header>

        <section className="mt-10 space-y-7" aria-label="Your submitted proposals">
          {data.submissions.length === 0 ? (
            <div className="border-[3px] border-line-strong bg-production-yellow p-2 shadow-[8px_8px_0_#171714]">
              <EmptyState title="No proposals found" description="Submit with this account email, then return here to follow the decision." />
            </div>
          ) : data.submissions.map((submission) => (
            <Card
              className={`border-[3px] border-line-strong shadow-[7px_7px_0_#171714] [&>header]:border-b-2 [&>header]:border-line-strong [&>header_h3]:font-black [&>header_h3]:tracking-[-0.035em] ${statusPanel[submission.status]}`}
              key={submission.id}
              title={submission.title}
            >
              <div className="flex flex-wrap items-center gap-2 border-b-2 border-line-strong pb-4">
                <Badge tone={statusTone[submission.status]}>{statusLabel[submission.status]}</Badge>
                <Badge tone="neutral">{submission.category ?? "Uncategorized"}</Badge>
                <span className="font-mono text-[10px] font-black uppercase tracking-[0.08em] text-ink-faint">Version {submission.version}</span>
              </div>
              <p className="mt-4 inline-block border-2 border-line-strong bg-surface-muted px-3 py-2 text-[10px] font-black uppercase tracking-[0.1em] text-ink-secondary">
                {submission.formName} · submitted {new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" }).format(submission.submittedAt)}
              </p>
              <div className="mt-5 border-l-[3px] border-line-strong pl-4">
                <Textarea
                  label="Abstract"
                  value={drafts[submission.id] ?? submission.abstract}
                  rows={8}
                  maxLength={20_000}
                  disabled={!submission.editable || savingId !== null}
                  onChange={(event) => setDrafts((value) => ({ ...value, [submission.id]: event.target.value }))}
                />
              </div>
              {submission.editable ? (
                <Button
                  className="mt-4"
                  disabled={savingId !== null || (drafts[submission.id] ?? submission.abstract).trim() === submission.abstract}
                  loading={savingId === submission.id}
                  onClick={() => void save(submission.id)}
                >
                  Save proposal changes
                </Button>
              ) : (
                <Alert className="mt-4" tone={submission.status === "rejected" ? "danger" : submission.status === "accepted" ? "success" : "warning"}>
                  <AlertTitle>{submission.status === "accepted" ? "Proposal accepted" : submission.status === "rejected" ? "Proposal not selected" : "Editing is locked"}</AlertTitle>
                  <AlertDescription>
                    {submission.status === "accepted" || submission.status === "rejected"
                      ? "The organizer decision is now reflected here."
                      : "The call for proposals is closed, so this proposal is read-only."}
                  </AlertDescription>
                </Alert>
              )}
            </Card>
          ))}
        </section>

        <p className="mt-10 border-2 border-line-strong bg-ink px-4 py-4 text-sm font-semibold text-on-accent shadow-[5px_5px_0_#7857ff]">
          Want to submit another proposal? <Link className="font-black text-production-lime underline decoration-2 underline-offset-4" to={`/event/${data.event.slug}/sessions`}>Visit the event program</Link>.
        </p>
        <Toaster />
      </main>
    </ProposalPortalShell>
  );
}
