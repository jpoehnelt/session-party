export interface EventNavItem {
  readonly label: string;
  readonly path: string;
  readonly segment: string;
}

const candidates: readonly EventNavItem[] = [
  { label: "Overview", path: "/e/:eventSlug", segment: "" },
  { label: "Forms", path: "/e/:eventSlug/forms", segment: "forms" },
  { label: "Review", path: "/e/:eventSlug/review", segment: "review" },
  { label: "Agenda", path: "/e/:eventSlug/agenda", segment: "agenda" },
];

export function availableEventNavItems(routePaths: Iterable<string>): readonly EventNavItem[] {
  const registeredPaths = new Set(routePaths);
  return candidates.filter(({ path }) => registeredPaths.has(path));
}
