import { type ComponentType, type ReactNode, useEffect, useState } from "react";
import {
  Link,
  NavLink,
  createBrowserRouter,
  useLocation,
  useNavigate,
  useParams,
} from "react-router";
import { AppShell, Button, EmptyState, Sheet } from "@/ui";
import { apiFetch } from "./api";
import LoginPage from "./auth";
import { availableEventNavItems } from "./event-nav";
import {
  discoveredClientRouteModules,
  discoveredClientRoutePaths,
  type RouteModule,
} from "./route-discovery";
import { loginPathForLocation } from "./return-to";

export { discoveredClientRoutePaths };

type AuthMeResponse = {
  email?: string;
  user?: { email?: string };
};

type SessionState =
  | { status: "loading" }
  | { status: "signed-out" }
  | { status: "signed-in"; email: string };

const navItems = availableEventNavItems(
  discoveredClientRouteModules.map(({ path }) => path),
);

function Sidebar({ mobile = false, onNavigate }: { mobile?: boolean; onNavigate?: () => void }) {
  const { eventSlug } = useParams();
  const navClassName = mobile
    ? "flex h-full flex-col gap-5 bg-ink p-1 text-on-accent"
    : "flex h-full flex-col gap-6 p-5";

  const brand = (
    <span className="flex items-center gap-3">
      <span className="grid size-9 place-items-center border-2 border-on-accent bg-production-lime text-[10px] font-black tracking-[-0.04em] text-ink shadow-[3px_3px_0_#7857ff]">
        SP
      </span>
      <span className="font-black tracking-[-0.035em]">Session Party</span>
    </span>
  );

  if (!eventSlug) {
    return (
      <nav className={navClassName} aria-label="Main navigation">
        <Link className={`${mobile ? "flex min-h-12 items-center px-3" : ""} text-lg text-on-accent`} to="/" onClick={onNavigate}>
          {brand}
        </Link>
        <Link className={`${mobile ? "flex min-h-11 items-center px-3" : ""} border-2 border-on-accent bg-production-lime px-3 py-2.5 text-xs font-black uppercase tracking-[0.1em] text-ink shadow-[4px_4px_0_#7857ff]`} to="/events" onClick={onNavigate}>
          Event control room →
        </Link>
      </nav>
    );
  }

  const eventPath = `/e/${eventSlug}`;
  return (
    <nav className={navClassName} aria-label="Event navigation">
      <Link className={`${mobile ? "flex min-h-12 items-center px-3" : ""} text-lg text-on-accent`} to="/" onClick={onNavigate}>
        {brand}
      </Link>
      <Link
        className={`${mobile ? "flex min-h-11 items-center" : "block"} border-y border-white/25 px-3 py-2.5 text-[10px] font-black uppercase tracking-[0.14em] text-white/55 hover:bg-white/10 hover:text-white`}
        to="/events"
        onClick={onNavigate}
      >
        ← All events
      </Link>
      <div className="space-y-1.5">
        {navItems.map(({ label, segment }) => {
          const to = segment ? `${eventPath}/${segment}` : eventPath;
          return (
            <NavLink
              className={({ isActive }) =>
                `${mobile ? "flex min-h-11 items-center" : "block"} border-2 px-3 py-2.5 text-[11px] font-black uppercase tracking-[0.08em] transition-transform ${
                  isActive ? "border-on-accent bg-production-lime text-ink shadow-[4px_4px_0_#7857ff]" : "border-transparent text-white/65 hover:border-white/40 hover:bg-white/10 hover:text-white"
                }`
              }
              end={!segment}
              key={segment}
              to={to}
              onClick={onNavigate}
            >
              {label}
            </NavLink>
          );
        })}
      </div>
    </nav>
  );
}

function Topbar({
  onOpenNavigation,
  navigationOpen,
}: {
  onOpenNavigation: () => void;
  navigationOpen: boolean;
}) {
  const location = useLocation();
  const navigate = useNavigate();
  const [session, setSession] = useState<SessionState>({ status: "loading" });

  useEffect(() => {
    let isCurrent = true;
    void apiFetch<AuthMeResponse>("/api/v1/auth/me")
      .then((user) => {
        if (!isCurrent) return;
        const email = user.user?.email ?? user.email;
        setSession(email ? { status: "signed-in", email } : { status: "signed-out" });
      })
      .catch(() => {
        if (isCurrent) setSession({ status: "signed-out" });
      });

    return () => {
      isCurrent = false;
    };
  }, []);

  async function logout() {
    try {
      await apiFetch("/api/v1/auth/logout", { method: "POST" });
    } finally {
      navigate("/");
    }
  }

  return (
    <div className="flex items-center justify-between gap-3 py-1">
      <Button
        className="min-h-11 lg:hidden"
        variant="secondary"
        type="button"
        aria-haspopup="dialog"
        aria-expanded={navigationOpen}
        aria-controls="mobile-navigation"
        onClick={onOpenNavigation}
      >
        Menu
      </Button>
      <span className="ml-auto hidden border-l-2 border-line-strong pl-4 text-[10px] font-black uppercase tracking-[0.08em] text-ink-secondary sm:block">
        {session.status === "loading"
          ? "Checking session…"
          : session.status === "signed-in"
            ? session.email
            : "Not signed in"}
      </span>
      {session.status === "signed-in" ? (
        <Button className="min-h-11" type="button" onClick={() => void logout()}>
          Log out
        </Button>
      ) : session.status === "signed-out" ? (
        <Button
          className="min-h-11"
          type="button"
          onClick={() => navigate(loginPathForLocation(location))}
        >
          Sign in
        </Button>
      ) : null}
    </div>
  );
}

function Layout({ children }: { children: ReactNode }) {
  const [mobileNavigationOpen, setMobileNavigationOpen] = useState(false);

  return (
    <>
      <AppShell
        sidebar={<Sidebar />}
        sidebarClassName="hidden lg:block"
        topbar={(
          <Topbar
            onOpenNavigation={() => setMobileNavigationOpen(true)}
            navigationOpen={mobileNavigationOpen}
          />
        )}
      >
        {children}
      </AppShell>
      <Sheet
        id="mobile-navigation"
        open={mobileNavigationOpen}
        onClose={() => setMobileNavigationOpen(false)}
        title="Navigation"
      >
        <Sidebar mobile onNavigate={() => setMobileNavigationOpen(false)} />
      </Sheet>
    </>
  );
}

function NotFound() {
  return (
    <Layout>
      <EmptyState
        title="Page not found"
        description="The page you requested does not exist."
      />
    </Layout>
  );
}

function routeElement(Component: ComponentType, layout?: RouteModule["layout"]) {
  const page = <Component />;
  return layout === "bare" ? page : <Layout>{page}</Layout>;
}

export const router = createBrowserRouter([
  {
    path: "/login",
    element: <LoginPage />,
  },
  ...discoveredClientRouteModules.map(({ path, layout, default: Component }) => ({
    path,
    element: routeElement(Component, layout),
  })),
  {
    path: "*",
    element: <NotFound />,
  },
]);
