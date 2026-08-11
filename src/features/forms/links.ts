const segment = encodeURIComponent;

export function selectedFormIdFromSearch(search: string | URLSearchParams): string | null {
  const params = typeof search === "string" ? new URLSearchParams(search) : search;
  return params.get("formId")?.trim() || null;
}

export function formSelectionSearch(search: string | URLSearchParams, formId: string | null): string {
  const params = typeof search === "string" ? new URLSearchParams(search) : new URLSearchParams(search);
  if (formId) params.set("formId", formId);
  else params.delete("formId");
  const value = params.toString();
  return value ? `?${value}` : "";
}

export function organizerFormPath(eventSlug: string, formId: string): string {
  return `/e/${segment(eventSlug)}/forms${formSelectionSearch("", formId)}`;
}
