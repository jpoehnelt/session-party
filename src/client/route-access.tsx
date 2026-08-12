import { type ReactNode, useEffect, useState } from "react";
import { Navigate, useLocation, useNavigate, useParams } from "react-router";
import { Button, EmptyState, Spinner } from "@/ui";
import { apiFetch } from "./api";
import { loginPathForLocation } from "./return-to";

export type ClientRouteAccess = "public" | "event-review" | "event-organizer" | "install-staff";

type EventAccess = {
  readonly event: { readonly slug: string };
  readonly memberRole: "owner" | "admin" | "reviewer" | null;
  readonly staff: boolean;
};

type AuthMeResponse = {
  readonly email?: string;
  readonly user?: {
    readonly email?: string;
    readonly installRole?: "staff";
  };
};

type AccessState =
  | { readonly status: "loading" }
  | { readonly status: "signed-out" }
  | { readonly status: "allowed" }
  | { readonly status: "forbidden" };

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
  const [state, setState] = useState<AccessState>(access === "public" ? { status: "allowed" } : { status: "loading" });

  useEffect(() => {
    if (access === "public") {
      setState({ status: "allowed" });
      return;
    }
    let current = true;
    const eventScoped = access === "event-review" || access === "event-organizer";
    void Promise.allSettled([
      apiFetch<AuthMeResponse>("/api/v1/auth/me"),
      eventScoped ? apiFetch<readonly EventAccess[]>("/api/v1/me/events") : Promise.resolve([] as const),
    ]).then(([authResult, eventsResult]) => {
      if (!current) return;
      if (authResult.status === "rejected") {
        setState({ status: "signed-out" });
        return;
      }
      const auth = authResult.value;
      const signedIn = Boolean(auth.user?.email ?? auth.email);
      if (!signedIn) {
        setState({ status: "signed-out" });
        return;
      }
      if (eventsResult.status === "rejected") {
        setState({ status: "forbidden" });
        return;
      }
      setState(canAccessClientRoute(access, eventSlug, auth, eventsResult.value)
        ? { status: "allowed" }
        : { status: "forbidden" });
    });
    return () => { current = false; };
  }, [access, eventSlug]);

  if (state.status === "loading") {
    return <div className="flex min-h-48 items-center justify-center gap-3 text-sm text-ink-secondary" role="status"><Spinner /> Checking access…</div>;
  }
  if (state.status === "signed-out") return <Navigate replace to={loginPathForLocation(location)} />;
  if (state.status === "forbidden") {
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
