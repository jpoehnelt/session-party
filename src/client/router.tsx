import { type ComponentType, type ReactNode, useEffect, useState } from "react";
import {
  Link,
  NavLink,
  createBrowserRouter,
  useNavigate,
  useParams,
} from "react-router";
import { AppShell, Button, EmptyState } from "@/ui";
import LoginPage from "./auth";
import { apiFetch } from "./api";

type RouteModule = {
  path: string;
  layout?: "app" | "bare";
  default: ComponentType;
};

type AuthMeResponse = {
  email?: string;
  user?: { email?: string };
};

const routeModules = import.meta.glob("../features/*/routes/*.tsx", {
  eager: true,
}) as Record<string, RouteModule>;

const navItems = [
  ["Overview", ""],
  ["Forms", "forms"],
  ["Submissions", "submissions"],
  ["Review", "review"],
  ["Agenda", "agenda"],
  ["Speakers", "speakers"],
  ["Comms", "comms"],
  ["Dashboard", "dashboard"],
  ["Settings", "settings"],
] as const;

function Sidebar() {
  const { eventSlug } = useParams();

  if (!eventSlug) {
    return (
      <nav className="flex h-full flex-col gap-5 p-4" aria-label="Main navigation">
        <Link className="text-lg font-semibold tracking-tight" to="/">
          Session Party
        </Link>
        <Link className="text-sm font-medium" to="/">
          Events
        </Link>
      </nav>
    );
  }

  const eventPath = `/e/${eventSlug}`;
  return (
    <nav className="flex h-full flex-col gap-5 p-4" aria-label="Event navigation">
      <Link className="text-lg font-semibold tracking-tight" to="/">
        Session Party
      </Link>
      <div className="space-y-1">
        {navItems.map(([label, segment]) => {
          const to = segment ? `${eventPath}/${segment}` : eventPath;
          return (
            <NavLink
              className={({ isActive }) =>
                `block rounded-md px-3 py-2 text-sm font-medium ${
                  isActive ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:bg-muted"
                }`
              }
              end={!segment}
              key={segment}
              to={to}
            >
              {label}
            </NavLink>
          );
        })}
      </div>
    </nav>
  );
}

function Topbar() {
  const navigate = useNavigate();
  const [email, setEmail] = useState<string>();

  useEffect(() => {
    let isCurrent = true;
    void apiFetch<AuthMeResponse>("/api/v1/auth/me")
      .then((user) => {
        if (isCurrent) setEmail(user.user?.email ?? user.email);
      })
      .catch(() => {
        if (isCurrent) setEmail(undefined);
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
      <span className="text-sm text-muted-foreground">{email ?? "Not signed in"}</span>
      <Button type="button" onClick={() => void logout()}>
        Log out
      </Button>
    </div>
  );
}

function Layout({ children }: { children: ReactNode }) {
  return (
    <AppShell sidebar={<Sidebar />} topbar={<Topbar />}>
      {children}
    </AppShell>
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
  ...Object.values(routeModules).map(({ path, layout, default: Component }) => ({
    path,
    element: routeElement(Component, layout),
  })),
  {
    path: "*",
    element: <NotFound />,
  },
]);
