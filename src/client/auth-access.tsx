import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { Schema } from "effect";
import { EventAccess, type EventAccess as EventAccessValue } from "@/features/events/schema";
import {
  apiFetch,
  synchronizeAuthenticatedPrincipal,
} from "./api";

export type AuthMeResponse = {
  readonly email?: string;
  readonly sessionId?: string;
  readonly userId?: string;
  readonly user?: {
    readonly email?: string;
    readonly sessionId?: string;
    readonly userId?: string;
    readonly installRole?: "staff";
  };
};

export type AuthAccessState =
  | { readonly status: "loading" }
  | { readonly status: "signed-out" }
  | {
      readonly status: "signed-in";
      readonly auth: AuthMeResponse;
      readonly email: string;
      readonly events: readonly EventAccessValue[] | null;
    };

type AuthAccessContextValue = {
  readonly state: AuthAccessState;
  readonly clear: () => void;
  readonly refresh: () => void;
};

const AuthAccessContext = createContext<AuthAccessContextValue | null>(null);

export function AuthenticatedAccessProvider({ children }: { readonly children: ReactNode }) {
  const [state, setState] = useState<AuthAccessState>({ status: "loading" });
  const [request, setRequest] = useState(0);

  useEffect(() => {
    let current = true;
    setState({ status: "loading" });
    void Promise.allSettled([
      apiFetch<AuthMeResponse>("/api/v1/auth/me"),
      apiFetch("/api/v1/me/events", { schema: Schema.Array(EventAccess) }),
    ]).then(([authResult, eventsResult]) => {
      if (!current) return;
      if (authResult.status === "rejected") {
        synchronizeAuthenticatedPrincipal(null);
        setState({ status: "signed-out" });
        return;
      }
      const auth = authResult.value;
      const email = auth.user?.email ?? auth.email;
      if (!email) {
        synchronizeAuthenticatedPrincipal(null);
        setState({ status: "signed-out" });
        return;
      }
      synchronizeAuthenticatedPrincipal(
        auth.user?.sessionId ?? auth.sessionId ?? auth.user?.userId ?? auth.userId ?? email,
      );
      setState({
        status: "signed-in",
        auth,
        email,
        events: eventsResult.status === "fulfilled" ? eventsResult.value : null,
      });
    });
    return () => { current = false; };
  }, [request]);

  const clear = useCallback(() => {
    synchronizeAuthenticatedPrincipal(null);
    setState({ status: "signed-out" });
  }, []);
  const refresh = useCallback(() => setRequest((current) => current + 1), []);
  const value = useMemo(() => ({ state, clear, refresh }), [clear, refresh, state]);

  return <AuthAccessContext.Provider value={value}>{children}</AuthAccessContext.Provider>;
}

export function useAuthenticatedAccess(): AuthAccessContextValue {
  const context = useContext(AuthAccessContext);
  if (!context) throw new Error("Authenticated access is unavailable outside the app shell");
  return context;
}

export function useOptionalAuthenticatedAccess(): AuthAccessContextValue | null {
  return useContext(AuthAccessContext);
}
