import { useEffect, useRef, useState, type FormEvent } from "react";
import { Schema } from "effect";
import { ApiError, apiFetch, decodeApiResponse } from "@/client/api";
import { Badge, Button, Card, Input, Skeleton, Table } from "@/ui";
import {
  CreateReviewerInvitationOutput,
  ReviewerInvitation,
  type ReviewerInvitation as ReviewerInvitationRecord,
} from "../schema";

const segment = (value: string) => encodeURIComponent(value);

async function responseMessage(response: Response): Promise<string> {
  const body = await response.json().catch(() => undefined) as unknown;
  if (body && typeof body === "object" && "message" in body && typeof body.message === "string") {
    return body.message;
  }
  return response.statusText || `Request failed with status ${response.status}`;
}

export function loadReviewerInvitations(eventId: string): Promise<readonly ReviewerInvitationRecord[]> {
  return apiFetch(`/api/v1/events/${segment(eventId)}/reviewer-invitations`, {
    schema: Schema.Array(ReviewerInvitation),
  });
}

export async function inviteReviewer(eventId: string, email: string, idempotencyKey: string) {
  const response = await fetch(`/api/v1/events/${segment(eventId)}/reviewer-invitations`, {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      "idempotency-key": idempotencyKey,
      "x-request-id": `reviewer-invitation-${crypto.randomUUID()}`,
    },
    body: JSON.stringify({ email }),
  });
  if (!response.ok) throw new ApiError(response.status, await responseMessage(response));
  return decodeApiResponse(response, CreateReviewerInvitationOutput);
}

const statusTone = {
  pending: "warning",
  accepted: "success",
  expired: "neutral",
} as const;

export function ReviewerInvitations({ eventId }: { readonly eventId: string }) {
  const [invitations, setInvitations] = useState<readonly ReviewerInvitationRecord[] | null>(null);
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string>();
  const [status, setStatus] = useState<string>();
  const [sending, setSending] = useState(false);
  const keyRef = useRef(`reviewer-invitation-${crypto.randomUUID()}`);

  useEffect(() => {
    let active = true;
    void loadReviewerInvitations(eventId).then(
      (loaded) => { if (active) setInvitations(loaded); },
      (cause) => {
        if (!active) return;
        setInvitations([]);
        setError(cause instanceof Error ? cause.message : "Reviewer invitations could not load");
      },
    );
    return () => { active = false; };
  }, [eventId]);

  const submit = async (formEvent: FormEvent<HTMLFormElement>) => {
    formEvent.preventDefault();
    setSending(true);
    setError(undefined);
    setStatus(undefined);
    try {
      const result = await inviteReviewer(eventId, email.trim(), keyRef.current);
      keyRef.current = `reviewer-invitation-${crypto.randomUUID()}`;
      setEmail("");
      setInvitations((current) => [
        result.invitation,
        ...(current ?? []).filter((invitation) => invitation.id !== result.invitation.id),
      ]);
      setStatus(result.idempotent ? "That reviewer already has a pending invitation." : "Reviewer invitation queued for delivery.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Reviewer invitation could not be sent");
    } finally {
      setSending(false);
    }
  };

  return (
    <Card className="[&>header]:bg-surface-muted [&>header]:text-ink [&>header_h3]:text-ink" title="Reviewer invitations">
      <p className="text-sm text-ink-secondary">
        Invite by email. Acceptance signs the recipient in through the existing magic-link flow and grants only the event reviewer role.
      </p>
      <form className="mt-4 grid gap-3 sm:grid-cols-[minmax(15rem,1fr)_auto] sm:items-end" onSubmit={submit}>
        <Input
          label="Reviewer email"
          type="email"
          required
          maxLength={320}
          value={email}
          placeholder="reviewer@example.com"
          onChange={(change) => setEmail(change.target.value)}
        />
        <Button type="submit" loading={sending} disabled={!email.trim() || sending}>Invite reviewer</Button>
      </form>
      {error ? <p className="mt-3 text-sm font-bold text-danger" role="alert">{error}</p> : null}
      {status ? <p className="mt-3 text-sm font-bold text-success" role="status">{status}</p> : null}
      {invitations === null ? (
        <Skeleton className="mt-4 h-24" />
      ) : (
        <div className="mt-4">
          <Table
            columns={[
              { key: "email", header: "Recipient", render: (invitation: ReviewerInvitationRecord) => invitation.email },
              { key: "status", header: "Invitation", render: (invitation: ReviewerInvitationRecord) => <Badge tone={statusTone[invitation.status]}>{invitation.status}</Badge> },
              { key: "delivery", header: "Delivery", render: (invitation: ReviewerInvitationRecord) => <Badge>{invitation.deliveryStatus.replace("_", " ")}</Badge> },
              { key: "expires", header: "Expires", render: (invitation: ReviewerInvitationRecord) => invitation.expiresAt.toLocaleDateString() },
            ]}
            rows={[...invitations]}
            rowKey={(invitation) => invitation.id}
            empty="No reviewer invitations yet."
          />
        </div>
      )}
    </Card>
  );
}
