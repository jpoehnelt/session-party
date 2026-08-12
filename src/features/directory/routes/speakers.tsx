import { useEffect, useState, type FormEvent } from "react";
import { apiFetch } from "@/client/api";
import { Badge, Button, Card, EmptyState, Input, PageHeader, Select, Skeleton, Toaster, toast } from "@/ui";
import {
  SpeakerDirectoryPage,
  type DirectoryParticipationStatus,
  type ListSpeakerDirectoryInput,
  type SpeakerDirectoryPage as SpeakerDirectoryPageRecord,
} from "../schema";

export const path = "/speaker-directory";
export const contentWidth = "wide" as const;

export function speakerDirectoryUrl(input: ListSpeakerDirectoryInput): string {
  const query = new URLSearchParams();
  if (input.query?.trim()) query.set("query", input.query.trim());
  if (input.eventId) query.set("eventId", input.eventId);
  if (input.status) query.set("status", input.status);
  query.set("page", String(input.page ?? 1));
  query.set("pageSize", String(input.pageSize ?? 25));
  return `/api/v1/install/speakers?${query}`;
}

export const fetchSpeakerDirectory = (input: ListSpeakerDirectoryInput): Promise<SpeakerDirectoryPageRecord> =>
  apiFetch(speakerDirectoryUrl(input), { schema: SpeakerDirectoryPage });

const statusLabel = (status: DirectoryParticipationStatus) =>
  status === "spoke" ? "Spoke" : status[0]!.toUpperCase() + status.slice(1);

const mediumLabel = (medium: "toolEmail" | "personalEmail" | "text" | "phone") => ({
  toolEmail: "Tool email",
  personalEmail: "Personal email",
  text: "Text",
  phone: "Phone",
})[medium];

export default function SpeakerDirectoryPageRoute() {
  const [draftQuery, setDraftQuery] = useState("");
  const [query, setQuery] = useState("");
  const [eventId, setEventId] = useState("");
  const [status, setStatus] = useState<DirectoryParticipationStatus | "">("");
  const [page, setPage] = useState(1);
  const [result, setResult] = useState<SpeakerDirectoryPageRecord | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let current = true;
    setLoading(true);
    void fetchSpeakerDirectory({
      query: query || undefined,
      eventId: eventId || undefined,
      status: status || undefined,
      page,
      pageSize: 25,
    }).then((next) => {
      if (current) setResult(next);
    }).catch((error) => {
      if (current) {
        setResult({ entries: [], events: [], page: 1, pageSize: 25, total: 0, hasMore: false });
        toast(error instanceof Error ? error.message : "Could not load the speaker directory", { tone: "danger" });
      }
    }).finally(() => {
      if (current) setLoading(false);
    });
    return () => { current = false; };
  }, [eventId, page, query, status]);

  const submitSearch = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setPage(1);
    setQuery(draftQuery);
  };

  return (
    <>
      <PageHeader
        title="Speaker directory"
        description="Installation-wide history grouped only by normalized email. Claimed and managed identities remain visible and unmerged."
      />
      <Card title="Search and filter">
        <form className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_15rem_13rem_auto] lg:items-end" onSubmit={submitSearch}>
          <Input label="Name, email, or profile" value={draftQuery} onChange={(event) => setDraftQuery(event.target.value)} />
          <Select label="Event" value={eventId} onChange={(event) => { setEventId(event.target.value); setPage(1); }}>
            <option value="">All events</option>
            {(result?.events ?? []).map((event) => <option key={event.id} value={event.id}>{event.name}</option>)}
          </Select>
          <Select label="Participation" value={status} onChange={(event) => { setStatus(event.target.value as DirectoryParticipationStatus | ""); setPage(1); }}>
            <option value="">Any participation</option>
            <option value="submitted">Submitted</option>
            <option value="accepted">Accepted</option>
            <option value="spoke">Spoke</option>
          </Select>
          <Button type="submit">Search</Button>
        </form>
      </Card>

      <div className="mt-6 flex items-center justify-between gap-3">
        <p className="text-sm font-bold text-ink-secondary">{result ? `${result.total} grouped ${result.total === 1 ? "person" : "people"}` : "Loading directory…"}</p>
        {result && result.total > result.pageSize ? <span className="text-sm text-ink-faint">Page {result.page}</span> : null}
      </div>

      {loading && result === null ? <Skeleton className="mt-4 h-96" /> : result?.entries.length === 0 ? (
        <div className="mt-4"><EmptyState title="No speakers match" description="Try a broader search or remove a participation filter." /></div>
      ) : (
        <div className="mt-4 space-y-5">
          {result?.entries.map((entry) => (
            <Card key={entry.groupKey} title={entry.displayName}>
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone={entry.normalizedEmail ? "success" : "neutral"}>{entry.normalizedEmail ?? "No email on record"}</Badge>
                <Badge>{entry.members.length} {entry.members.length === 1 ? "identity" : "identities"}</Badge>
                {entry.reusableProfile ? <Badge tone="success">Reusable profile v{entry.reusableProfile.version}</Badge> : <Badge>No reusable profile</Badge>}
              </div>

              {entry.reusableProfile ? (
                <p className="mt-3 text-sm text-ink-secondary">
                  {[entry.reusableProfile.title, entry.reusableProfile.company].filter(Boolean).join(" · ") || "Reusable profile has no title or company"}
                  {entry.reusableProfile.bio ? <span className="mt-1 block text-ink-faint">{entry.reusableProfile.bio}</span> : null}
                </p>
              ) : null}

              <div className="mt-5 grid gap-5 xl:grid-cols-3">
                <section>
                  <h3 className="text-sm font-black uppercase tracking-[0.08em] text-ink">Identity members</h3>
                  <ul className="mt-2 space-y-2">
                    {entry.members.map((member) => (
                      <li key={member.speakerId} className="border-l-2 border-line-strong pl-3 text-sm text-ink-secondary">
                        <strong className="text-ink">{member.eventName}</strong> · {member.kind}<br />
                        {member.displayName} · profile {member.profileReviewStatus.replace("_", " ")}
                      </li>
                    ))}
                  </ul>
                </section>
                <section>
                  <h3 className="text-sm font-black uppercase tracking-[0.08em] text-ink">Participation history</h3>
                  <ul className="mt-2 space-y-2">
                    {entry.participation.map((participation) => (
                      <li key={participation.eventId} className="border-l-2 border-production-purple pl-3 text-sm text-ink-secondary">
                        <strong className="text-ink">{participation.eventName}</strong>
                        <span className="mt-1 flex flex-wrap gap-1">
                          {(["submitted", "accepted", "spoke"] as const).filter((key) => participation[key]).map((key) => <Badge key={key}>{statusLabel(key)}</Badge>)}
                        </span>
                        {[...participation.submissionTitles, ...participation.talkTitles].map((title) => <span className="mt-1 block text-xs text-ink-faint" key={title}>{title}</span>)}
                      </li>
                    ))}
                  </ul>
                </section>
                <section>
                  <h3 className="text-sm font-black uppercase tracking-[0.08em] text-ink">Contact log</h3>
                  {entry.contacts.length === 0 ? <p className="mt-2 text-sm text-ink-faint">No organizer-recorded contact yet.</p> : (
                    <ul className="mt-2 space-y-2">
                      {entry.contacts.map((contact) => (
                        <li key={contact.id} className="border-l-2 border-production-lime pl-3 text-sm text-ink-secondary">
                          <strong className="text-ink">{mediumLabel(contact.medium)}</strong> · {contact.eventName}<br />
                          {contact.contactedAt.toLocaleDateString()} by {contact.actorName ?? "staff"}
                          {contact.note ? <span className="mt-1 block text-xs text-ink-faint">{contact.note}</span> : null}
                        </li>
                      ))}
                    </ul>
                  )}
                </section>
              </div>

              {entry.sameNameSuggestions.length > 0 ? (
                <p className="mt-5 border-2 border-line-strong bg-warning-soft p-3 text-sm text-ink">
                  <strong>Same-name suggestion only:</strong> {entry.sameNameSuggestions.map((suggestion) => suggestion.normalizedEmail ?? suggestion.groupKey).join(", ")}. These records are not merged.
                </p>
              ) : null}
            </Card>
          ))}
        </div>
      )}

      {result && (result.page > 1 || result.hasMore) ? (
        <div className="mt-6 flex justify-end gap-3">
          <Button type="button" variant="secondary" disabled={result.page <= 1 || loading} onClick={() => setPage((current) => Math.max(1, current - 1))}>Previous</Button>
          <Button type="button" variant="secondary" disabled={!result.hasMore || loading} onClick={() => setPage((current) => current + 1)}>Next</Button>
        </div>
      ) : null}
      <Toaster />
    </>
  );
}
