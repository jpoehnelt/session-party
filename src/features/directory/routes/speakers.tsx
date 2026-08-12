import { useEffect, useState, type FormEvent } from "react";
import { apiFetch } from "@/client/api";
import { Badge, Button, Card, EmptyState, Input, Modal, PageHeader, Select, Skeleton, Toaster, toast } from "@/ui";
import {
  ApplyReturningSpeakerInviteOutput,
  ReturningSpeakerInvitePlan,
  SpeakerDirectoryPage,
  type ApplyReturningSpeakerInviteOutput as ApplyReturningSpeakerInviteOutputRecord,
  type DirectoryParticipationStatus,
  type ListSpeakerDirectoryInput,
  type ReturningSpeakerInvitePlan as ReturningSpeakerInvitePlanRecord,
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

const segment = (value: string) => encodeURIComponent(value);

export const previewReturningSpeakerInvite = (eventId: string, groupKey: string): Promise<ReturningSpeakerInvitePlanRecord> =>
  apiFetch(`/api/v1/events/${segment(eventId)}/directory/speakers/invite-preview?groupKey=${segment(groupKey)}`, {
    schema: ReturningSpeakerInvitePlan,
  });

export const applyReturningSpeakerInvite = (
  plan: Exclude<ReturningSpeakerInvitePlanRecord, { action: "conflict" }>,
  idempotencyKey = crypto.randomUUID(),
): Promise<ApplyReturningSpeakerInviteOutputRecord> => {
  if (!plan.profileCopy || plan.action === "conflict") throw new Error("A conflict preview cannot be applied");
  return apiFetch(`/api/v1/events/${segment(plan.eventId)}/directory/speakers/invite`, {
    method: "POST",
    body: {
      groupKey: plan.groupKey,
      expectedAction: plan.action,
      expectedSourceId: plan.profileCopy.sourceId,
      expectedSourceVersion: plan.profileCopy.sourceVersion,
      idempotencyKey,
    },
    schema: ApplyReturningSpeakerInviteOutput,
  });
};

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
  const [targetEventId, setTargetEventId] = useState("");
  const [invitePreview, setInvitePreview] = useState<ReturningSpeakerInvitePlanRecord | null>(null);
  const [inviteLoading, setInviteLoading] = useState(false);

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

  const loadInvitePreview = async (groupKey: string) => {
    if (!targetEventId) {
      toast("Choose a target event first", { tone: "danger" });
      return;
    }
    setInviteLoading(true);
    try {
      setInvitePreview(await previewReturningSpeakerInvite(targetEventId, groupKey));
    } catch (error) {
      toast(error instanceof Error ? error.message : "Could not preview the returning-speaker invite", { tone: "danger" });
    } finally {
      setInviteLoading(false);
    }
  };

  const applyInvite = async () => {
    const preview = invitePreview;
    if (!preview || preview.action === "conflict" || !preview.profileCopy) return;
    setInviteLoading(true);
    try {
      const invited = await applyReturningSpeakerInvite(preview as Exclude<ReturningSpeakerInvitePlanRecord, { action: "conflict" }>);
      toast(`${preview.normalizedEmail ?? preview.profileCopy.displayName} was added for profile approval`, { tone: "success" });
      setInvitePreview(null);
      if (invited.emailQueued) toast("An invitation email was queued", { tone: "success" });
    } catch (error) {
      toast(error instanceof Error ? error.message : "Could not invite the returning speaker", { tone: "danger" });
    } finally {
      setInviteLoading(false);
    }
  };

  const conflictLabel = (reason: ReturningSpeakerInvitePlanRecord["conflictReason"]) => {
    if (reason === "missing-email") return "This directory identity has no verified email to provision.";
    if (reason === "already-in-event") return "This person already has a speaker record in the target event.";
    if (reason === "profile-fields-owned-by-airtable") return "Airtable owns speaker profile fields for the target event.";
    return "The target event cannot accept this returning speaker.";
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

      <div className="mt-5">
        <Card title="Invite returning speakers">
          <div className="grid gap-3 lg:grid-cols-[minmax(0,24rem)_1fr] lg:items-end">
            <Select label="Target event" value={targetEventId} onChange={(event) => setTargetEventId(event.target.value)}>
              <option value="">Choose an event</option>
              {(result?.events ?? []).map((event) => <option key={event.id} value={event.id}>{event.name}</option>)}
            </Select>
            <p className="text-sm text-ink-secondary">Preview first. Apply creates or links an event speaker, copies the stated profile version into review, implies no acceptance, and sends no email.</p>
          </div>
        </Card>
      </div>

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
                <Button type="button" size="sm" variant="secondary" disabled={!targetEventId || inviteLoading} onClick={() => void loadInvitePreview(entry.groupKey)}>Preview invite</Button>
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
      <Modal
        open={invitePreview !== null}
        onClose={() => setInvitePreview(null)}
        title="Returning speaker invite preview"
        footer={invitePreview ? (
          <div className="flex justify-end gap-3">
            <Button type="button" variant="secondary" onClick={() => setInvitePreview(null)}>Cancel</Button>
            {invitePreview.action !== "conflict" ? <Button type="button" loading={inviteLoading} onClick={() => void applyInvite()}>Add for profile approval</Button> : null}
          </div>
        ) : undefined}
      >
        {invitePreview ? (
          <div className="space-y-3 text-sm text-ink-secondary">
            <p><strong className="text-ink">Target:</strong> {invitePreview.eventName}</p>
            <p><strong className="text-ink">Identity:</strong> {invitePreview.normalizedEmail ?? "No email on record"}</p>
            {invitePreview.action === "conflict" ? (
              <p className="border-2 border-line-strong bg-warning-soft p-3 text-ink"><strong>Conflict:</strong> {conflictLabel(invitePreview.conflictReason)}</p>
            ) : (
              <>
                <p><strong className="text-ink">Provisioning:</strong> {invitePreview.action === "link-existing-user" ? "Link the existing user account to a new event speaker" : "Create a new organizer-managed event speaker"}.</p>
                <p><strong className="text-ink">Profile copy:</strong> {invitePreview.profileCopy?.kind === "reusable-profile" ? "Reusable profile" : "Prior event profile"} {invitePreview.profileCopy?.displayName} v{invitePreview.profileCopy?.sourceVersion}, then require organizer approval.</p>
                <p><strong className="text-ink">Side effects:</strong> No acceptance and no email delivery.</p>
              </>
            )}
          </div>
        ) : null}
      </Modal>
      <Toaster />
    </>
  );
}
