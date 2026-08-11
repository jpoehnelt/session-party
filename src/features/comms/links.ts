export const communicationWorkspaceTabs = ["templates", "send", "history"] as const;

export type CommunicationWorkspaceTab = typeof communicationWorkspaceTabs[number];

export interface CommunicationRouteSelection {
  readonly tab: CommunicationWorkspaceTab;
  readonly templateId: string | null;
  readonly needsCanonicalization: boolean;
}

const isWorkspaceTab = (value: string | null): value is CommunicationWorkspaceTab =>
  communicationWorkspaceTabs.some((tab) => tab === value);

export function communicationRouteSelection(search: string | URLSearchParams): CommunicationRouteSelection {
  const params = typeof search === "string" ? new URLSearchParams(search) : search;
  const rawTab = params.get("tab");
  const tab = isWorkspaceTab(rawTab) ? rawTab : "templates";
  const rawTemplateId = params.get("templateId");
  const trimmedTemplateId = rawTemplateId?.trim() || null;
  const templateId = tab === "history" ? null : trimmedTemplateId;
  return {
    tab,
    templateId,
    needsCanonicalization:
      rawTab !== tab
      || rawTemplateId !== trimmedTemplateId
      || (tab === "history" && rawTemplateId !== null),
  };
}

export function communicationSelectionSearch(
  search: string | URLSearchParams,
  tab: CommunicationWorkspaceTab,
  templateId: string | null,
): string {
  const params = typeof search === "string" ? new URLSearchParams(search) : new URLSearchParams(search);
  params.set("tab", tab);
  if (templateId && tab !== "history") params.set("templateId", templateId);
  else params.delete("templateId");
  const value = params.toString();
  return value ? `?${value}` : "";
}

export function organizerCommunicationsPath(
  eventSlug: string,
  tab: CommunicationWorkspaceTab,
  templateId: string | null = null,
): string {
  return `/e/${encodeURIComponent(eventSlug)}/comms${communicationSelectionSearch("", tab, templateId)}`;
}
