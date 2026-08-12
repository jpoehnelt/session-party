import { Suspense, lazy, type ComponentType, type ReactNode, useEffect, useRef, useState } from "react";
import {
  Link,
  NavLink,
  createBrowserRouter,
  useLocation,
  useNavigate,
  useParams,
} from "react-router";
import { AppShell, Button, EmptyState, Sheet, Spinner } from "@/ui";
import {
  apiFetch,
  invalidateAuthGeneration,
  synchronizeAuthenticatedPrincipal,
} from "./api";
import LoginPage from "./auth";
import {
  applyBrandTheme,
  applyEventBrand,
  brandAssetUrl,
  fetchEventBrand,
  useBrand,
} from "@/features/branding/components/client";
import { availableEventNavItems, type EventNavRole } from "./event-nav";
import {
  discoveredClientRouteModules,
  discoveredClientRoutePaths,
  type RouteModule,
} from "./route-discovery";
import { loginPathForLocation } from "./return-to";

export { discoveredClientRoutePaths };

type AuthMeResponse = {
  email?: string;
  sessionId?: string;
  userId?: string;
  user?: { email?: string; sessionId?: string; userId?: string };
};

type SessionState =
  | { status: "loading" }
  | { status: "signed-out" }
  | { status: "signed-in"; email: string };

const registeredEventNavItems = availableEventNavItems(
  discoveredClientRouteModules.map(({ path }) => path),
);

function Sidebar({ mobile = false, onNavigate }: { mobile?: boolean; onNavigate?: () => void }) {
  const { eventSlug } = useParams();
  const { brand: installationBrand } = useBrand();
  const [memberRole, setMemberRole] = useState<EventNavRole>(undefined);
  useEffect(() => {
    if (!eventSlug) {
      setMemberRole(undefined);
      return;
    }
    let current = true;
    void apiFetch<readonly { event: { slug: string }; memberRole: EventNavRole }[]>("/api/v1/me/events")
      .then((access) => {
        if (current) setMemberRole(access.find(({ event }) => event.slug === eventSlug)?.memberRole ?? null);
      })
      .catch(() => {
        if (current) setMemberRole(null);
      });
    return () => { current = false; };
  }, [eventSlug]);
  const navItems = !eventSlug
    ? registeredEventNavItems
    : memberRole === undefined || memberRole === null
      ? []
      : availableEventNavItems(registeredEventNavItems.map(({ path }) => path), memberRole);
  const navClassName = mobile
    ? "flex h-full flex-col gap-5 bg-ink p-1 text-on-ink"
    : "flex h-full flex-col gap-6 p-5";

  const brand = (
    <span className="flex items-center gap-3">
      {installationBrand.logoAssetId ? (
        <img className="max-h-10 max-w-28 object-contain" src={brandAssetUrl(installationBrand.logoAssetId)!} alt="" />
      ) : (
        <span className="grid size-9 place-items-center rounded-control border-2 border-on-accent bg-accent text-[10px] font-black tracking-[-0.04em] text-on-accent shadow-button">
          {installationBrand.name.slice(0, 2).toUpperCase()}
        </span>
      )}
      <span className="min-w-0 truncate font-black tracking-[-0.035em]">{installationBrand.name}</span>
    </span>
  );

  if (!eventSlug) {
    return (
      <nav className={navClassName} aria-label="Main navigation">
        <Link className={`${mobile ? "flex min-h-12 items-center px-3" : ""} text-lg text-on-ink`} to="/" onClick={onNavigate}>
          {brand}
        </Link>
        <Link className={`${mobile ? "flex min-h-11 items-center px-3" : ""} border-2 border-on-accent bg-accent px-3 py-2.5 text-xs font-black uppercase tracking-[0.1em] text-on-accent shadow-button`} to="/events?choose=1" onClick={onNavigate}>
          Your home →
        </Link>
        <Link className={`${mobile ? "flex min-h-11 items-center px-3" : ""} px-3 py-2 text-[10px] font-black uppercase tracking-[0.1em] text-white/65 hover:text-white`} to="/setup" onClick={onNavigate}>
          Installation appearance
        </Link>
      </nav>
    );
  }

  const eventPath = `/e/${eventSlug}`;
  return (
    <nav className={navClassName} aria-label="Event navigation">
      <Link className={`${mobile ? "flex min-h-12 items-center px-3" : ""} text-lg text-on-ink`} to="/" onClick={onNavigate}>
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
                  isActive ? "border-on-accent bg-accent text-on-accent shadow-button" : "border-transparent text-white/65 hover:border-white/40 hover:bg-white/10 hover:text-white"
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
  const [isLoggingOut, setIsLoggingOut] = useState(false);

  useEffect(() => {
    let isCurrent = true;
    void apiFetch<AuthMeResponse>("/api/v1/auth/me")
      .then((user) => {
        if (!isCurrent) return;
        const email = user.user?.email ?? user.email;
        synchronizeAuthenticatedPrincipal(user.user?.sessionId ?? user.sessionId ?? user.user?.userId ?? user.userId ?? email ?? null);
        setSession(email ? { status: "signed-in", email } : { status: "signed-out" });
      })
      .catch(() => {
        if (!isCurrent) return;
        synchronizeAuthenticatedPrincipal(null);
        setSession({ status: "signed-out" });
      });

    return () => {
      isCurrent = false;
    };
  }, []);

  async function logout() {
    if (isLoggingOut) return;

    setIsLoggingOut(true);
    synchronizeAuthenticatedPrincipal(null);
    try {
      await apiFetch("/api/v1/auth/logout", { method: "POST" });
    } finally {
      invalidateAuthGeneration();
      setSession({ status: "signed-out" });
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
    <Layout>
      <EmptyState
        headingLevel={1}
        title="Page not found"
        description="The page you requested does not exist."
        action={<Button onClick={() => navigate("/")}>Return home</Button>}
      />
    </Layout>
  );
}

function RouteCoordinator({ children }: { children: ReactNode }) {
  const location = useLocation();
  const navigate = useNavigate();
  const { brand } = useBrand();
  const previousPath = useRef(location.pathname);
  const [surfaceBrandName, setSurfaceBrandName] = useState<string | null>(null);

  useEffect(() => {
    const match = location.pathname.match(/^\/(?:event|embed|submit)\/([^/]+)/)
      ?? location.pathname.match(/^\/e\/([^/]+)\/portal(?:\/|$)/);
    if (!match?.[1]) {
      setSurfaceBrandName(null);
      applyBrandTheme(brand);
      return;
    }
    let current = true;
    void fetchEventBrand(decodeURIComponent(match[1]))
      .then((eventBrand) => {
        if (!current) return;
        setSurfaceBrandName(eventBrand.publicName);
        applyEventBrand(eventBrand);
      })
      .catch(() => {
        if (current) setSurfaceBrandName(null);
      });
    return () => {
      current = false;
      applyBrandTheme(brand);
    };
  }, [brand, location.pathname]);

  useEffect(() => {
    if (brand.configured || location.pathname === "/setup" || location.pathname === "/login") return;
    if (!location.pathname.startsWith("/events") && !location.pathname.startsWith("/e/")) return;
    let current = true;
    void apiFetch<AuthMeResponse>("/api/v1/auth/me")
      .then(() => { if (current) navigate("/setup", { replace: true }); })
      .catch(() => undefined);
    return () => { current = false; };
  }, [brand.configured, location.pathname, navigate]);

  useEffect(() => {
    const isNavigation = previousPath.current !== location.pathname;
    previousPath.current = location.pathname;
    let settled = false;
    const apply = () => {
      const heading = document.querySelector<HTMLElement>("h1");
      if (!heading) return false;
      const main = document.querySelector<HTMLElement>("main");
      if (main) {
        main.id ||= "main-content";
        main.tabIndex = -1;
      }
      const name = heading.innerText.replace(/\s+/g, " ").trim();
      const resolvedBrandName = surfaceBrandName ?? brand.name;
      if (location.pathname === "/") document.title = `${resolvedBrandName} — Your whole program, ready on cue.`;
      else if (name) document.title = `${name} — ${resolvedBrandName}`;
      const canonicalUrl = `${window.location.origin}${location.pathname}`;
      for (const selector of ['meta[property="og:title"]', 'meta[name="twitter:title"]']) {
        document.querySelector<HTMLMetaElement>(selector)?.setAttribute("content", document.title);
      }
      document.querySelector<HTMLMetaElement>('meta[property="og:url"]')?.setAttribute("content", canonicalUrl);
      let canonical = document.querySelector<HTMLLinkElement>('link[rel="canonical"]');
      if (!canonical) {
        canonical = document.createElement("link");
        canonical.rel = "canonical";
        document.head.append(canonical);
      }
      canonical.href = canonicalUrl;
      if (isNavigation && !settled) {
        heading.tabIndex = -1;
        heading.focus({ preventScroll: false });
        settled = true;
      }
      return true;
    };
    if (apply()) return undefined;
    const target = document.querySelector("main") ?? document.body;
    const observer = new MutationObserver(() => {
      if (apply()) observer.disconnect();
    });
    observer.observe(target, { childList: true, subtree: true });
    const timeout = window.setTimeout(() => observer.disconnect(), 10_000);
    return () => {
      observer.disconnect();
      window.clearTimeout(timeout);
    };
  }, [brand.name, location.pathname, surfaceBrandName]);

  return <>
    <a className="fixed left-3 top-3 z-[100] -translate-y-24 border-2 border-line-strong bg-production-lime px-4 py-3 font-black text-ink shadow-card transition-transform focus:translate-y-0" href="#main-content">Skip to main content</a>
    {children}
  </>;
}

function routeElement(Component: ComponentType, layout?: RouteModule["layout"], contentWidth?: RouteModule["contentWidth"]) {
  const page = (
    <Suspense fallback={<div className="flex min-h-48 items-center justify-center gap-3 text-sm text-ink-secondary" role="status"><Spinner /> Loading page…</div>}>
      <Component />
    </Suspense>
  );
  return <RouteCoordinator>{layout === "bare" ? page : <Layout contentWidth={contentWidth}>{page}</Layout>}</RouteCoordinator>;
}

const discoveredRoutes = discoveredClientRouteModules.map(({ path, layout, contentWidth, load }) => {
  const Component = lazy(load);
  return {
    path,
    element: routeElement(Component, layout, contentWidth),
  };
});

export const router = createBrowserRouter([
  {
    path: "/login",
    element: <RouteCoordinator><LoginPage /></RouteCoordinator>,
  },
  ...discoveredRoutes,
  {
    path: "*",
    element: <RouteCoordinator><NotFound /></RouteCoordinator>,
  },
]);
