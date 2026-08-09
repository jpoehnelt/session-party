import { useEffect, useRef, useState } from "react";
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

  if (loading) return <main className="mx-auto max-w-4xl space-y-4 px-4 py-10"><Skeleton className="h-24" /><Skeleton className="h-72" /></main>;
  if (error?.status === 401) {
    const returnTo = `/portal/events/${eventSlug}/submissions`;
    return (
      <main className="mx-auto max-w-xl px-4 py-12">
        <EmptyState
          title="Sign in to manage your proposals"
          description="Use the same email address you entered on the call for proposals."
          action={<Button onClick={() => navigate(`/login?returnTo=${encodeURIComponent(returnTo)}`)}>Sign in</Button>}
        />
      </main>
    );
  }
  if (error || !data) {
    return <main className="mx-auto max-w-xl px-4 py-12"><EmptyState title="Submissions could not be loaded" description={error?.message ?? "Try again."} /></main>;
  }

  return (
    <main className="mx-auto max-w-4xl space-y-6 px-4 py-10">
      <header className="space-y-2 border-b border-line pb-5">
        <p className="text-sm font-medium text-accent">{data.event.name}</p>
        <h1 className="text-3xl font-semibold tracking-tight text-ink">Your proposals</h1>
        <p className="text-sm text-ink-secondary">Statuses and edits here are scoped to the email on your signed-in account.</p>
      </header>
      {data.submissions.length === 0 ? (
        <EmptyState title="No proposals found" description="Submit with this account email, then return here to follow the decision." />
      ) : data.submissions.map((submission) => (
        <Card key={submission.id} title={submission.title}>
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={statusTone[submission.status]}>{statusLabel[submission.status]}</Badge>
            <Badge tone="neutral">{submission.category ?? "Uncategorized"}</Badge>
            <span className="text-xs text-ink-faint">Version {submission.version}</span>
          </div>
          <p className="mt-2 text-xs text-ink-faint">
            {submission.formName} · submitted {new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" }).format(submission.submittedAt)}
          </p>
          <div className="mt-4">
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
              className="mt-3"
              disabled={savingId !== null || (drafts[submission.id] ?? submission.abstract).trim() === submission.abstract}
              loading={savingId === submission.id}
              onClick={() => void save(submission.id)}
            >
              Save proposal changes
            </Button>
          ) : (
            <Alert className="mt-3" tone={submission.status === "rejected" ? "danger" : submission.status === "accepted" ? "success" : "warning"}>
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
      <p className="text-sm text-ink-secondary">
        Want to submit another proposal? <Link className="font-medium text-accent underline" to={`/event/${data.event.slug}/sessions`}>Visit the event program</Link>.
      </p>
      <Toaster />
    </main>
  );
}
