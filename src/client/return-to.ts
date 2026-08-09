export function validReturnTo(search: string): string | undefined {
  const returnTo = new URLSearchParams(search).get("returnTo");
  if (!returnTo || !returnTo.startsWith("/") || returnTo.startsWith("//") || returnTo.includes("\\")) {
    return undefined;
  }

  return returnTo;
}

export function loginPathForLocation(location: Pick<Location, "pathname" | "search" | "hash">): string {
  const returnTo = `${location.pathname}${location.search}${location.hash}`;
  return `/login?returnTo=${encodeURIComponent(returnTo)}`;
}
