import { Suspense, lazy, type ComponentType, type ReactNode, useEffect, useRef, useState } from "react";
import {
  Link,
  NavLink,
  Outlet,
  createBrowserRouter,
  useLocation,
  useMatches,
  useNavigate,
  useParams,
} from "react-router";
import { AppShell, Button, EmptyState, Sheet, Spinner } from "@/ui";
import { apiFetch } from "./api";
import {
  AuthenticatedAccessProvider,
  useAuthenticatedAccess,
} from "./auth-access";
import LoginPage from "./auth";
import { availableEventNavItems, type EventNavRole } from "./event-nav";
import {
  discoveredClientRouteModules,
  discoveredClientRoutePaths,
  type RouteModule,
} from "./route-discovery";
import { loginPathForLocation } from "./return-to";
import { clientRouteAccess, RouteAccessBoundary } from "./route-access";

export { discoveredClientRoutePaths };

const registeredEventNavItems = availableEventNavItems(
  discoveredClientRouteModules.map(({ path }) => path),
);

function Sidebar({ mobile = false, onNavigate }: { mobile?: boolean; onNavigate?: () => void }) {
  const { eventSlug } = useParams();
  const { state } = useAuthenticatedAccess();
  const currentAccess = state.status === "signed-in"
    ? state.events?.find(({ event }) => event.slug === eventSlug)
    : undefined;
  const memberRole: EventNavRole = currentAccess?.staff
    ? "owner"
    : currentAccess?.memberRole ?? (state.status === "loading" ? undefined : null);
  const navItems = !eventSlug
    ? registeredEventNavItems
    : memberRole === undefined || memberRole === null
      ? []
      : availableEventNavItems(registeredEventNavItems.map(({ path }) => path), memberRole);
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
        <Link className={`${mobile ? "flex min-h-11 items-center px-3" : ""} border-2 border-on-accent bg-production-lime px-3 py-2.5 text-xs font-black uppercase tracking-[0.1em] text-ink shadow-[4px_4px_0_#7857ff]`} to="/events?choose=1" onClick={onNavigate}>
          Your home →
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
        to="/events?choose=1"
        onClick={onNavigate}
      >
        ← Your home
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
  const authenticatedAccess = useAuthenticatedAccess();
  const { state: session } = authenticatedAccess;
  const [isLoggingOut, setIsLoggingOut] = useState(false);

  async function logout() {
    if (isLoggingOut) return;

    setIsLoggingOut(true);
    authenticatedAccess.clear();
    try {
      await apiFetch("/api/v1/auth/logout", { method: "POST" });
    } finally {
      navigate("/login", { replace: true });
    }
  }

  return (
    <div className="flex items-center justify-between gap-3 py-1">
      <Button
        id="mobile-navigation-trigger"
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
        <Button
          className="min-h-11"
          type="button"
          loading={isLoggingOut}
          onClick={() => void logout()}
        >
          {isLoggingOut ? "Logging out…" : "Log out"}
        </Button>
      ) : session.status === "signed-out" ? (
        <Button
          className="min-h-11"
          type="button"
          onClick={() => navigate(loginPathForLocation(location))}
        >
          Sign in
        </Button>
      ) : (
        <Button aria-hidden="true" className="invisible min-h-11" disabled tabIndex={-1} type="button">
          Log out
        </Button>
      )}
    </div>
  );
}

function Layout({ children, contentWidth }: { children: ReactNode; contentWidth?: RouteModule["contentWidth"] }) {
  const [mobileNavigationOpen, setMobileNavigationOpen] = useState(false);

  return (
    <>
      <AppShell
        contentWidth={contentWidth}
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
        onClose={() => {
          setMobileNavigationOpen(false);
          requestAnimationFrame(() => document.getElementById("mobile-navigation-trigger")?.focus());
        }}
        title="Navigation"
      >
        <Sidebar mobile onNavigate={() => setMobileNavigationOpen(false)} />
      </Sheet>
    </>
  );
}

function NotFound() {
  const navigate = useNavigate();
  return (
    <EmptyState
      headingLevel={1}
      title="Page not found"
      description="The page you requested does not exist."
      action={<Button onClick={() => navigate("/")}>Return home</Button>}
    />
  );
}

export function RouteCoordinator({ children }: { children: ReactNode }) {
  const location = useLocation();
  const previousPath = useRef(location.pathname);

  useEffect(() => {
    const isNavigation = previousPath.current !== location.pathname;
    previousPath.current = location.pathname;
    let settled = false;
    let focusFrame: number | undefined;
    const apply = () => {
      const heading = document.querySelector<HTMLElement>("h1");
      if (!heading) return false;
      const main = document.querySelector<HTMLElement>("main");
      if (main) {
        if (!main.id) main.id = "main-content";
        if (main.tabIndex !== -1) main.tabIndex = -1;
      }
      const name = (heading.textContent ?? "").replace(/\s+/g, " ").trim();
      if (location.pathname === "/") document.title = "Session Party — Your whole program, ready on cue.";
      else if (name) document.title = `${name} — Session Party`;
      const canonicalUrl = `${window.location.origin}${location.pathname}`;
      for (const selector of ['meta[property="og:title"]', 'meta[name="twitter:title"]']) {
        const meta = document.querySelector<HTMLMetaElement>(selector);
        if (meta?.content !== document.title) meta?.setAttribute("content", document.title);
      }
      const openGraphUrl = document.querySelector<HTMLMetaElement>('meta[property="og:url"]');
      if (openGraphUrl?.content !== canonicalUrl) openGraphUrl?.setAttribute("content", canonicalUrl);
      let canonical = document.querySelector<HTMLLinkElement>('link[rel="canonical"]');
      if (!canonical) {
        canonical = document.createElement("link");
        canonical.rel = "canonical";
        document.head.append(canonical);
      }
      if (canonical.href !== canonicalUrl) canonical.href = canonicalUrl;
      if (isNavigation && !settled) {
        heading.tabIndex = -1;
        settled = true;
        focusFrame = requestAnimationFrame(() => heading.focus({ preventScroll: true }));
      }
      return true;
    };
    apply();
    const observer = new MutationObserver(() => { apply(); });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    return () => {
      observer.disconnect();
      if (focusFrame !== undefined) cancelAnimationFrame(focusFrame);
    };
  }, [location.pathname]);

  return <>
    <a className="fixed left-3 top-3 z-[100] -translate-y-24 border-2 border-line-strong bg-production-lime px-4 py-3 font-black text-ink shadow-card transition-transform focus:translate-y-0" href="#main-content">Skip to main content</a>
    {children}
  </>;
}

function routeElement(Component: ComponentType, path: string) {
  return (
    <RouteAccessBoundary access={clientRouteAccess(path)}>
      <Suspense fallback={<div className="flex min-h-48 items-center justify-center gap-3 text-sm text-ink-secondary" role="status"><Spinner /> Loading page…</div>}>
        <Component />
      </Suspense>
    </RouteAccessBoundary>
  );
}

const discoveredRoutes = discoveredClientRouteModules.map(({ path, layout, contentWidth, load }) => {
  const Component = lazy(load);
  return {
    path,
    layout,
    contentWidth,
    element: routeElement(Component, path),
  };
});

function PersistentAppLayout() {
  const matches = useMatches();
  const contentWidth = [...matches].reverse().find(({ handle }) => handle)?.handle as
    | { readonly contentWidth?: RouteModule["contentWidth"] }
    | undefined;
  return <Layout contentWidth={contentWidth?.contentWidth}><Outlet /></Layout>;
}

const bareRoutes = discoveredRoutes
  .filter(({ layout }) => layout === "bare")
  .map(({ path, element }) => ({ path, element: <RouteCoordinator>{element}</RouteCoordinator> }));
const appRoutes = discoveredRoutes
  .filter(({ layout }) => layout !== "bare")
  .map(({ path, contentWidth, element }) => ({ path, element, handle: { contentWidth } }));

export const router = createBrowserRouter([
  {
    path: "/login",
    element: <RouteCoordinator><LoginPage /></RouteCoordinator>,
  },
  ...bareRoutes,
  {
    element: (
      <AuthenticatedAccessProvider>
        <RouteCoordinator><PersistentAppLayout /></RouteCoordinator>
      </AuthenticatedAccessProvider>
    ),
    children: [
      ...appRoutes,
      { path: "*", element: <NotFound /> },
    ],
  },
]);
