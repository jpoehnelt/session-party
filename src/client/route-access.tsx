import { type ReactNode } from "react";
import { Navigate, useLocation, useNavigate, useParams } from "react-router";
import { Button, EmptyState, Spinner } from "@/ui";
import {
  type AuthMeResponse,
  useOptionalAuthenticatedAccess,
} from "./auth-access";
import { loginPathForLocation } from "./return-to";

export type ClientRouteAccess = "public" | "event-review" | "event-organizer" | "install-staff";

type EventAccess = {
  readonly event: { readonly slug: string };
  readonly memberRole: "owner" | "admin" | "reviewer" | null;
  readonly staff: boolean;
};

export function clientRouteAccess(path: string): ClientRouteAccess {
  if (path === "/staff" || path === "/speaker-directory") return "install-staff";
  if (path === "/e/:eventSlug/review") return "event-review";
  if (path === "/e/:eventSlug" || (path.startsWith("/e/:eventSlug/") && !path.startsWith("/e/:eventSlug/portal"))) {
    return "event-organizer";
  }
  return "public";
}

export function canAccessClientRoute(
  access: ClientRouteAccess,
  eventSlug: string | undefined,
  auth: AuthMeResponse,
  events: readonly EventAccess[],
): boolean {
  if (access === "public") return true;
  if (access === "install-staff") return auth.user?.installRole === "staff";
  const eventAccess = events.find(({ event }) => event.slug === eventSlug);
  if (!eventAccess) return false;
  if (eventAccess.staff) return true;
  if (access === "event-review") {
    return eventAccess.memberRole === "owner" || eventAccess.memberRole === "admin" || eventAccess.memberRole === "reviewer";
  }
  return eventAccess.memberRole === "owner" || eventAccess.memberRole === "admin";
}

export function RouteAccessBoundary({
  access,
  children,
}: {
  readonly access: ClientRouteAccess;
  readonly children: ReactNode;
}) {
  const { eventSlug } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const authenticatedAccess = useOptionalAuthenticatedAccess();

  if (access === "public") return children;
  if (!authenticatedAccess || authenticatedAccess.state.status === "loading") {
    return <div className="flex min-h-48 items-center justify-center gap-3 text-sm text-ink-secondary" role="status"><Spinner /> Checking access…</div>;
  }
  if (authenticatedAccess.state.status === "signed-out") {
    return <Navigate replace to={loginPathForLocation(location)} />;
  }
  const events = authenticatedAccess.state.events;
  const allowed = (access === "install-staff" || events !== null) && canAccessClientRoute(
    access,
    eventSlug,
    authenticatedAccess.state.auth,
    events ?? [],
  );
  if (!allowed) {
    return (
      <EmptyState
        headingLevel={1}
        title="Access denied"
        description="Your account does not have permission to open this page."
        action={<Button onClick={() => navigate("/events?choose=1")}>Return to your home</Button>}
      />
    );
  }
  return children;
}
