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
    ? "flex h-full flex-col gap-5 p-1"
    : "flex h-full flex-col gap-5 p-4";

  if (!eventSlug) {
    return (
      <nav className={navClassName} aria-label="Main navigation">
        <Link className={`${mobile ? "flex min-h-11 items-center px-3" : ""} text-lg font-semibold tracking-tight`} to="/" onClick={onNavigate}>
          Session Party
        </Link>
        <Link className={`${mobile ? "flex min-h-11 items-center px-3" : ""} text-sm font-medium`} to="/" onClick={onNavigate}>
          Events
        </Link>
      </nav>
    );
  }

  const eventPath = `/e/${eventSlug}`;
  return (
    <nav className={navClassName} aria-label="Event navigation">
      <Link className={`${mobile ? "flex min-h-11 items-center px-3" : ""} text-lg font-semibold tracking-tight`} to="/" onClick={onNavigate}>
        Session Party
      </Link>
      <div className="space-y-1">
        {navItems.map(({ label, segment }) => {
          const to = segment ? `${eventPath}/${segment}` : eventPath;
          return (
            <NavLink
              className={({ isActive }) =>
                `${mobile ? "flex min-h-11 items-center" : "block"} rounded-md px-3 py-2 text-sm font-medium ${
                  isActive ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:bg-muted"
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

function Topbar({ onOpenNavigation }: { onOpenNavigation: () => void }) {
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
      navigate("/login");
    }
  }

  return (
    <div className="flex items-center gap-3 px-4 py-2">
      <Button
        className="min-h-11 lg:hidden"
        variant="secondary"
        type="button"
        onClick={onOpenNavigation}
      >
        Menu
      </Button>
      <span className="text-sm text-muted-foreground">
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
        topbar={<Topbar onOpenNavigation={() => setMobileNavigationOpen(true)} />}
      >
        {children}
      </AppShell>
      <Sheet
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
