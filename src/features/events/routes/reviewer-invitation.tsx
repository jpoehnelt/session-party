import { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import { ApiError, apiFetch, decodeApiResponse } from "@/client/api";
import { loginPathForLocation } from "@/client/return-to";
import { Button, Card, EmptyState, PageHeader, Skeleton } from "@/ui";
import {
  AcceptReviewerInvitationOutput,
  type AcceptReviewerInvitationOutput as AcceptedInvitation,
} from "../schema";

export const path = "/reviewer-invitations/accept";
export const contentWidth = "compact" as const;

async function responseMessage(response: Response): Promise<string> {
  const body = await response.json().catch(() => undefined) as unknown;
  if (body && typeof body === "object" && "message" in body && typeof body.message === "string") {
    return body.message;
  }
  return response.statusText || `Request failed with status ${response.status}`;
}

export async function acceptReviewerInvitationToken(token: string, idempotencyKey: string) {
  const response = await fetch("/api/v1/reviewer-invitations/accept", {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      "idempotency-key": idempotencyKey,
      "x-request-id": `reviewer-invitation-accept-${crypto.randomUUID()}`,
    },
    body: JSON.stringify({ token }),
  });
  if (!response.ok) throw new ApiError(response.status, await responseMessage(response));
  return decodeApiResponse(response, AcceptReviewerInvitationOutput);
}

type PageState = "checking" | "signed-out" | "ready";

export default function ReviewerInvitationRoute() {
  const location = useLocation();
  const navigate = useNavigate();
  const token = new URLSearchParams(location.search).get("token") ?? "";
  const [state, setState] = useState<PageState>("checking");
  const [accepted, setAccepted] = useState<AcceptedInvitation>();
  const [error, setError] = useState<string>();
  const [accepting, setAccepting] = useState(false);
  const keyRef = useRef(`reviewer-invitation-accept-${crypto.randomUUID()}`);

  useEffect(() => {
    if (!token) {
      setError("This reviewer invitation link is incomplete.");
      setState("ready");
      return;
    }
    let active = true;
    void apiFetch("/api/v1/auth/me").then(
      () => { if (active) setState("ready"); },
      (cause) => {
        if (!active) return;
        setState(cause instanceof ApiError && cause.status === 401 ? "signed-out" : "ready");
        if (!(cause instanceof ApiError && cause.status === 401)) {
          setError(cause instanceof Error ? cause.message : "Your session could not be checked");
        }
      },
    );
    return () => { active = false; };
  }, [token]);

  const accept = async () => {
    setAccepting(true);
    setError(undefined);
    try {
      setAccepted(await acceptReviewerInvitationToken(token, keyRef.current));
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 401) {
        setState("signed-out");
      } else {
        setError(cause instanceof Error ? cause.message : "Reviewer invitation could not be accepted");
      }
    } finally {
      setAccepting(false);
    }
  };

  return (
    <div className="space-y-5">
      <PageHeader title="Reviewer invitation" description="Join an event review committee with the existing Session Party account and permission model." />
      {state === "checking" ? <Skeleton className="h-48" /> : accepted ? (
        <Card className="[&>header]:bg-production-lime [&>header_h3]:text-ink" title="Invitation accepted">
          <p className="text-sm text-ink-secondary">
            You now have reviewer access to {accepted.eventName}. No organizer or communications permissions were granted.
          </p>
          <Button className="mt-4" onClick={() => navigate(`/e/${encodeURIComponent(accepted.eventSlug)}/review`)}>Open review workspace</Button>
        </Card>
      ) : state === "signed-out" ? (
        <EmptyState
          title="Sign in to accept"
          description="Use the same email address that received this invitation. The existing magic-link flow will return you here."
          action={<Button onClick={() => navigate(loginPathForLocation(location))}>Sign in with magic link</Button>}
        />
      ) : (
        <Card className="[&>header]:bg-surface-muted [&>header]:text-ink [&>header_h3]:text-ink" title="Accept reviewer access">
          <p className="text-sm text-ink-secondary">
            Acceptance adds your authenticated account to this event with the reviewer role. The invitation is single-purpose and can be accepted only by its recipient email.
          </p>
          {error ? <p className="mt-4 text-sm font-bold text-danger" role="alert">{error}</p> : null}
          <Button className="mt-4" loading={accepting} disabled={!token || accepting} onClick={() => void accept()}>Accept invitation</Button>
        </Card>
      )}
    </div>
  );
}
