export interface EventNavItem {
  readonly label: string;
  readonly path: string;
  readonly segment: string;
}

const candidates: readonly EventNavItem[] = [
  { label: "Overview", path: "/e/:eventSlug", segment: "" },
  { label: "Forms", path: "/e/:eventSlug/forms", segment: "forms" },
  { label: "Submissions", path: "/e/:eventSlug/submissions", segment: "submissions" },
  { label: "Review", path: "/e/:eventSlug/review", segment: "review" },
  { label: "Onboarding", path: "/e/:eventSlug/dashboard", segment: "dashboard" },
  { label: "Speakers", path: "/e/:eventSlug/speakers", segment: "speakers" },
  { label: "Tasks", path: "/e/:eventSlug/tasks", segment: "tasks" },
  { label: "Resources", path: "/e/:eventSlug/resources", segment: "resources" },
  { label: "Agenda", path: "/e/:eventSlug/agenda", segment: "agenda" },
  { label: "Communications", path: "/e/:eventSlug/comms", segment: "comms" },
  { label: "Publication", path: "/e/:eventSlug/publication", segment: "publication" },
  { label: "Integrations", path: "/e/:eventSlug/integrations", segment: "integrations" },
  { label: "Settings", path: "/e/:eventSlug/settings", segment: "settings" },
];

export function availableEventNavItems(routePaths: Iterable<string>): readonly EventNavItem[] {
  const registeredPaths = new Set(routePaths);
  return candidates.filter(({ path }) => registeredPaths.has(path));
}
