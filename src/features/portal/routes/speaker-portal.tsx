import { useCallback, useEffect, useMemo, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router";
import { ApiError, apiFetch } from "@/client/api";
import { loginPathForLocation } from "@/client/return-to";
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Avatar,
  Badge,
  Button,
  Card,
  Dropzone,
  EmptyState,
  Input,
  Label,
  PageHeader,
  Skeleton,
  Textarea,
  toast,
} from "@/ui";
import {
  PortalAssetContent,
  PortalMutationResult,
  PortalSnapshot as PortalSnapshotSchema,
  type PortalAsset,
  type PortalAssetPurpose,
  type PortalProfile,
  type PortalSnapshot,
  type PortalTask,
} from "../schema";

export const path = "/e/:eventSlug/portal";

const idempotencyKey = (action: string) => `${action}-${crypto.randomUUID()}`;
const portalApiPath = (eventSlug: string) => `/api/v1/events/${encodeURIComponent(eventSlug)}/portal`;

export async function loadSpeakerPortal(eventSlug: string): Promise<PortalSnapshot> {
  return apiFetch(portalApiPath(eventSlug), { schema: PortalSnapshotSchema });
}

export type PortalLoadError =
  | { readonly kind: "unauthenticated" }
  | { readonly kind: "unavailable" }
  | { readonly kind: "failed"; readonly message: string };

export function portalLoadError(error: unknown): PortalLoadError {
  if (error instanceof ApiError && error.status === 401) return { kind: "unauthenticated" };
  if (error instanceof ApiError && (error.status === 403 || error.status === 404)) return { kind: "unavailable" };
  return { kind: "failed", message: error instanceof Error ? error.message : "Could not load the speaker portal" };
}

function PortalLoading() {
  return (
    <main className="mx-auto w-full max-w-6xl space-y-4 p-3 sm:p-5 lg:p-7" aria-busy="true" aria-label="Loading speaker portal">
      <Skeleton className="h-28 motion-reduce:animate-none" />
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.15fr)_minmax(19rem,0.85fr)]">
        <Skeleton className="h-80 motion-reduce:animate-none" />
        <Skeleton className="h-80 motion-reduce:animate-none" />
      </div>
      <Skeleton className="h-64 motion-reduce:animate-none" />
      <span className="sr-only">Loading submissions, profile, tasks, and resources.</span>
    </main>
  );
}

function PortalFailure({ error, onRetry, onSignIn }: {
  readonly error: PortalLoadError;
  readonly onRetry: () => void;
  readonly onSignIn: () => void;
}) {
  if (error.kind === "unauthenticated") {
    return <main className="p-4 sm:p-6"><EmptyState title="Sign in to open your speaker portal" description="Use the account linked to your accepted proposal." action={<Button className="min-h-11" onClick={onSignIn}>Sign in</Button>} /></main>;
  }
  if (error.kind === "unavailable") {
    return <main className="p-4 sm:p-6"><EmptyState title="Speaker portal unavailable" description="This portal is available only to the account linked to an active accepted proposal." /></main>;
  }
  return (
    <main className="p-4 sm:p-6">
      <Card><EmptyState title="Speaker portal could not load" description={error.message} action={<Button className="min-h-11" onClick={onRetry}>Try again</Button>} /></Card>
    </main>
  );
}

const decodeAsset = (asset: typeof PortalAssetContent.Type): Blob => {
  const binary = atob(asset.contentBase64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new Blob([bytes], { type: asset.contentType });
};

function usePortalAssetUrl(eventSlug: string, asset: PortalAsset | null): string | undefined {
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    let active = true;
    let objectUrl: string | undefined;
    setUrl(undefined);
    if (!asset) return () => { active = false; };
    void apiFetch(asset.href, { schema: PortalAssetContent }).then((content) => {
      if (!active || typeof URL.createObjectURL !== "function") return;
      objectUrl = URL.createObjectURL(decodeAsset(content));
      setUrl(objectUrl);
    }).catch(() => undefined);
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [asset, eventSlug]);
  return url;
}

const fileContentBase64 = async (file: File): Promise<string> => {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 32_768) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + 32_768, bytes.length)));
  }
  return btoa(binary);
};

function ProfilePanel({ eventSlug, profile, onChanged }: {
  readonly eventSlug: string;
  readonly profile: PortalProfile;
  readonly onChanged: () => Promise<void>;
}) {
  const headshotUrl = usePortalAssetUrl(eventSlug, profile.headshot);
  const [displayName, setDisplayName] = useState(profile.displayName);
  const [title, setTitle] = useState(profile.title ?? "");
  const [company, setCompany] = useState(profile.company ?? "");
  const [bio, setBio] = useState(profile.bio ?? "");
  const [links, setLinks] = useState(profile.links.map((link) => ({ ...link })));
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    setDisplayName(profile.displayName);
    setTitle(profile.title ?? "");
    setCompany(profile.company ?? "");
    setBio(profile.bio ?? "");
    setLinks(profile.links.map((link) => ({ ...link })));
  }, [profile]);

  const save = async () => {
    setSaving(true);
    setError(undefined);
    try {
      await apiFetch(`${portalApiPath(eventSlug)}/profile`, {
        method: "PATCH",
        body: {
          displayName,
          title: title || null,
          company: company || null,
          bio: bio || null,
          links: links.filter(({ label, url }) => label.trim() && url.trim()),
          expectedVersion: profile.version,
          idempotencyKey: idempotencyKey("profile"),
        },
        schema: PortalMutationResult,
      });
      await onChanged();
      toast("Profile saved", { tone: "success" });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Profile could not be saved");
    } finally {
      setSaving(false);
    }
  };

  const uploadHeadshot = async ([file]: File[]) => {
    if (!file) return;
    setUploading(true);
    setError(undefined);
    try {
      await apiFetch(`${portalApiPath(eventSlug)}/assets`, {
        method: "POST",
        body: {
          purpose: "headshot",
          filename: file.name,
          contentType: file.type,
          contentBase64: await fileContentBase64(file),
          expectedVersion: profile.version,
          idempotencyKey: idempotencyKey("headshot"),
        },
        schema: PortalMutationResult,
      });
      await onChanged();
      toast(profile.headshot ? "Headshot replaced" : "Headshot uploaded", { tone: "success" });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Headshot could not be uploaded");
    } finally {
      setUploading(false);
    }
  };

  return (
    <Card className="h-fit p-4 sm:p-5">
      <div className="flex items-start gap-3">
        <Avatar name={profile.displayName} src={headshotUrl} size="lg" className="size-16" />
        <div className="min-w-0 flex-1">
          <h2 className="text-lg font-semibold text-ink">Profile</h2>
          <p className="text-sm text-ink-secondary">This is the speaker information organizers will use.</p>
          {profile.pendingSyncFields.length > 0 && <Badge tone="warning" className="mt-2">Pending organizer sync</Badge>}
        </div>
      </div>

      <div className="mt-5 space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <div><Label htmlFor="portal-display-name">Display name</Label><Input id="portal-display-name" value={displayName} onChange={(event) => setDisplayName(event.currentTarget.value)} /></div>
          <div><Label htmlFor="portal-title">Job title</Label><Input id="portal-title" value={title} onChange={(event) => setTitle(event.currentTarget.value)} /></div>
          <div className="sm:col-span-2"><Label htmlFor="portal-company">Company</Label><Input id="portal-company" value={company} onChange={(event) => setCompany(event.currentTarget.value)} /></div>
        </div>
        <div><Label htmlFor="portal-bio">Bio</Label><Textarea id="portal-bio" rows={5} value={bio} onChange={(event) => setBio(event.currentTarget.value)} /><p className="mt-1 text-xs text-ink-faint">A concise introduction for the program and event hosts.</p></div>
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-2"><Label>Links</Label><Button variant="ghost" size="sm" onClick={() => setLinks((current) => [...current, { label: "", url: "" }])}>Add link</Button></div>
          {links.length === 0 ? <p className="text-sm text-ink-faint">No profile links yet.</p> : links.map((link, index) => (
            <div key={index} className="grid gap-2 rounded-control border border-line p-3 sm:grid-cols-[0.7fr_1.3fr_auto]">
              <Input aria-label={`Link ${index + 1} label`} placeholder="Website" value={link.label} onChange={(event) => setLinks((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, label: event.currentTarget.value } : item))} />
              <Input aria-label={`Link ${index + 1} URL`} placeholder="https://" value={link.url} onChange={(event) => setLinks((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, url: event.currentTarget.value } : item))} />
              <Button variant="ghost" size="sm" onClick={() => setLinks((current) => current.filter((_, itemIndex) => itemIndex !== index))}>Remove</Button>
            </div>
          ))}
        </div>
        <div>
          <Label>Headshot</Label>
          <Dropzone accept="image/jpeg,image/png,image/webp" multiple={false} disabled={uploading || saving} onFiles={(files) => void uploadHeadshot(files)} hint="JPEG, PNG, or WebP · up to 10 MB" className="mt-1 min-h-28 py-5" />
        </div>
        {error && <Alert tone="danger"><AlertTitle>Profile not saved</AlertTitle><AlertDescription>{error}</AlertDescription></Alert>}
        <Button className="min-h-11 w-full sm:w-auto" disabled={saving || uploading || displayName.trim().length === 0} onClick={() => void save()}>{saving ? "Saving…" : "Save profile"}</Button>
      </div>
    </Card>
  );
}

const dateTime = (value: number, timezone: string) => new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: timezone,
}).format(value);

function SubmissionsPanel({ portal }: { readonly portal: PortalSnapshot }) {
  return (
    <section aria-labelledby="portal-submissions-heading">
      <div className="mb-3 flex items-end justify-between gap-3">
        <div><p className="text-xs font-semibold uppercase tracking-wide text-accent">Accepted program</p><h2 id="portal-submissions-heading" className="text-xl font-semibold text-ink">Submissions</h2></div>
        <Badge tone="success">Accepted</Badge>
      </div>
      <div className="space-y-3">
        {portal.submissions.map((submission) => (
          <Card key={submission.id} className="overflow-hidden p-0">
            <div className="border-l-4 border-success p-4 sm:p-5">
              <h3 className="text-lg font-semibold leading-snug text-ink">{submission.title}</h3>
              {submission.category && <p className="mt-1 text-sm text-ink-secondary">{submission.category}</p>}
              <div className="mt-4">
                <p className="text-xs font-semibold uppercase tracking-wide text-ink-faint">Speakers</p>
                <ul className="mt-2 flex flex-wrap gap-2">
                  {submission.coSpeakers.map((speaker) => <li key={speaker.id} className="flex items-center gap-2 rounded-full border border-line bg-surface-muted px-2.5 py-1 text-sm text-ink"><Avatar name={speaker.displayName} size="sm" />{speaker.displayName}{speaker.isPrimary && <span className="text-xs text-ink-faint">Primary</span>}</li>)}
                </ul>
              </div>
              <div className="mt-4 space-y-2">
                {submission.talks.length === 0 ? <p className="rounded-control bg-surface-muted p-3 text-sm text-ink-secondary">Schedule details are not assigned yet. Your accepted talk is still confirmed.</p> : submission.talks.map((talk) => (
                  <div key={talk.id} className="rounded-control border border-line bg-surface-muted p-3">
                    <div className="flex flex-wrap items-start justify-between gap-2"><p className="font-medium text-ink">{talk.title}</p><Badge tone={talk.status === "confirmed" ? "success" : talk.status === "cancelled" ? "danger" : "neutral"}>{talk.status}</Badge></div>
                    <p className="mt-1 text-sm text-ink-secondary">{talk.startsAt === null ? "Time to be announced" : dateTime(talk.startsAt, portal.event.timezone)} · {talk.durationMin} min{talk.roomName ? ` · ${talk.roomName}` : ""}{talk.trackName ? ` · ${talk.trackName}` : ""}</p>
                  </div>
                ))}
              </div>
            </div>
          </Card>
        ))}
      </div>
    </section>
  );
}

const uploadPurpose = (task: PortalTask, file: File): Exclude<PortalAssetPurpose, "headshot"> => {
  if (file.type.includes("powerpoint") || /\.(ppt|pptx)$/i.test(file.name) || /slides?|deck|presentation/i.test(task.name)) return "slides";
  return "supportingDocument";
};

function TaskPanel({ portal, onChanged }: { readonly portal: PortalSnapshot; readonly onChanged: () => Promise<void> }) {
  const [workingTask, setWorkingTask] = useState<string>();
  const [error, setError] = useState<string>();

  const complete = async (task: PortalTask) => {
    setWorkingTask(task.id);
    setError(undefined);
    try {
      await apiFetch(`${portalApiPath(portal.event.slug)}/tasks/${encodeURIComponent(task.id)}/complete`, {
        method: "POST",
        body: { expectedVersion: task.completion?.version ?? 0, idempotencyKey: idempotencyKey("task") },
        schema: PortalMutationResult,
      });
      await onChanged();
      toast("Task completed", { tone: "success" });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Task could not be completed");
    } finally {
      setWorkingTask(undefined);
    }
  };

  const upload = async (task: PortalTask, [file]: File[]) => {
    if (!file) return;
    setWorkingTask(task.id);
    setError(undefined);
    try {
      await apiFetch(`${portalApiPath(portal.event.slug)}/assets`, {
        method: "POST",
        body: {
          taskId: task.id,
          purpose: uploadPurpose(task, file),
          filename: file.name,
          contentType: file.type,
          contentBase64: await fileContentBase64(file),
          expectedVersion: task.completion?.version ?? 0,
          idempotencyKey: idempotencyKey("task-upload"),
        },
        schema: PortalMutationResult,
      });
      await onChanged();
      toast(task.completion ? "File replaced" : "File uploaded and task completed", { tone: "success" });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "File could not be uploaded");
    } finally {
      setWorkingTask(undefined);
    }
  };

  const download = async (asset: PortalAsset) => {
    try {
      const content = await apiFetch(asset.href, { schema: PortalAssetContent });
      const url = URL.createObjectURL(decodeAsset(content));
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = content.filename;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "File could not be downloaded");
    }
  };

  return (
    <section aria-labelledby="portal-tasks-heading">
      <div className="mb-3 flex items-end justify-between gap-3">
        <div><p className="text-xs font-semibold uppercase tracking-wide text-accent">Run of show</p><h2 id="portal-tasks-heading" className="text-xl font-semibold text-ink">Tasks</h2></div>
        <span className="text-sm font-medium text-ink-secondary">{portal.progress.completed} of {portal.progress.total}</span>
      </div>
      {portal.tasks.length === 0 ? <Card><EmptyState title="No onboarding tasks" description="Your organizer has not assigned any speaker tasks." /></Card> : (
        <div className="space-y-3">
          {portal.tasks.map((task, index) => {
            const completeState = task.completion !== null;
            const busy = workingTask === task.id;
            return (
              <Card key={task.id} className="relative overflow-hidden p-4 sm:p-5">
                <div className={`absolute bottom-0 left-0 top-0 w-1 ${completeState ? "bg-success" : "bg-accent"}`} />
                <div className="flex items-start gap-3">
                  <div className={`flex size-8 shrink-0 items-center justify-center rounded-full text-sm font-semibold ${completeState ? "bg-success-soft text-success" : "bg-accent-soft text-accent"}`} aria-hidden="true">{completeState ? "✓" : index + 1}</div>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-start justify-between gap-2"><h3 className="font-semibold text-ink">{task.name}</h3><Badge tone={completeState ? "success" : task.dueAt && task.dueAt < Date.now() ? "danger" : "neutral"}>{completeState ? "Complete" : "Open"}</Badge></div>
                    {task.description && <p className="mt-1 text-sm text-ink-secondary">{task.description}</p>}
                    {task.dueAt && <p className="mt-2 text-xs font-medium text-ink-faint">Due {dateTime(task.dueAt, portal.event.timezone)}</p>}
                    {!completeState && task.prerequisite.message && <p className="mt-3 rounded-control bg-warning-soft px-3 py-2 text-sm text-warning">{task.prerequisite.message}</p>}
                    {task.formPath && <a className="mt-3 inline-flex min-h-11 items-center rounded-control font-medium text-accent underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40" href={task.formPath}>Open required form</a>}
                    {task.kind === "upload" && (
                      <div className="mt-3">
                        {task.completion?.asset && <div className="mb-2 flex flex-wrap items-center justify-between gap-2 rounded-control border border-line bg-surface-muted p-3 text-sm"><span className="min-w-0 truncate text-ink">{task.completion.asset.filename}</span><Button variant="ghost" size="sm" onClick={() => void download(task.completion!.asset!)}>Download</Button></div>}
                        <Dropzone accept=".pdf,.ppt,.pptx,.doc,.docx,application/pdf" multiple={false} disabled={busy} onFiles={(files) => void upload(task, files)} hint={task.completion ? "Choose a replacement PDF, PowerPoint, or Word document" : "PDF, PowerPoint, or Word document"} className="min-h-28 py-5" />
                      </div>
                    )}
                    {task.kind !== "upload" && !completeState && <Button className="mt-3 min-h-11 w-full sm:w-auto" disabled={busy || !task.prerequisite.satisfied} onClick={() => void complete(task)}>{busy ? "Completing…" : "Mark complete"}</Button>}
                  </div>
                </div>
              </Card>
            );
          })}
        </div>
      )}
      {error && <Alert tone="danger" className="mt-3"><AlertTitle>Task action failed</AlertTitle><AlertDescription>{error}</AlertDescription></Alert>}
    </section>
  );
}

function ResourcesPanel({ portal }: { readonly portal: PortalSnapshot }) {
  return (
    <section aria-labelledby="portal-resources-heading">
      <div className="mb-3"><p className="text-xs font-semibold uppercase tracking-wide text-accent">Speaker handbook</p><h2 id="portal-resources-heading" className="text-xl font-semibold text-ink">Resources</h2></div>
      {portal.pages.length === 0 ? <Card><EmptyState title="No resources published" description="Organizer notes and speaker resources will appear here." /></Card> : (
        <div className="space-y-3">
          {portal.pages.map((page, index) => (
            <Card key={page.id} className="p-0">
              <details open={index === 0} className="group">
                <summary className="cursor-pointer list-none rounded-card px-4 py-4 font-semibold text-ink outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/40 sm:px-5">{page.title}<span className="float-right text-ink-faint group-open:rotate-45" aria-hidden="true">+</span></summary>
                <div className="border-t border-line px-4 py-4 sm:px-5">
                  {page.body && <p className="whitespace-pre-wrap text-sm leading-6 text-ink-secondary">{page.body}</p>}
                  {page.embed && <div className="mt-4 aspect-video overflow-hidden rounded-control border border-line bg-surface-muted"><iframe className="h-full w-full" src={page.embed.src} title={page.embed.title} sandbox="allow-scripts allow-same-origin allow-presentation" referrerPolicy="no-referrer" allow="fullscreen; picture-in-picture" /></div>}
                  {!page.body && !page.embed && <p className="text-sm text-ink-faint">This resource has no published content yet.</p>}
                </div>
              </details>
            </Card>
          ))}
        </div>
      )}
    </section>
  );
}

export interface SpeakerPortalRouteProps {
  readonly initialPortal?: PortalSnapshot;
  readonly initialLoadError?: PortalLoadError;
}

export default function SpeakerPortalRoute({
  initialPortal,
  initialLoadError,
}: SpeakerPortalRouteProps) {
  const { eventSlug = "" } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const [portal, setPortal] = useState<PortalSnapshot | undefined>(initialPortal);
  const [error, setError] = useState<PortalLoadError | undefined>(initialLoadError);
  const [requestVersion, setRequestVersion] = useState(0);

  const reload = useCallback(async () => {
    const loaded = await loadSpeakerPortal(eventSlug);
    setPortal(loaded);
    setError(undefined);
  }, [eventSlug]);

  useEffect(() => {
    if (requestVersion === 0 && (initialPortal || initialLoadError)) return;
    let active = true;
    setPortal(undefined);
    setError(undefined);
    void loadSpeakerPortal(eventSlug).then((loaded) => {
      if (active) setPortal(loaded);
    }).catch((caught: unknown) => {
      if (active) setError(portalLoadError(caught));
    });
    return () => { active = false; };
  }, [eventSlug, initialLoadError, initialPortal, requestVersion]);

  const eventDate = useMemo(() => {
    if (!portal?.event.startsAt) return "Dates to be announced";
    return new Intl.DateTimeFormat(undefined, { dateStyle: "long", timeZone: portal.event.timezone }).format(portal.event.startsAt);
  }, [portal]);

  if (error) return <PortalFailure error={error} onRetry={() => setRequestVersion((value) => value + 1)} onSignIn={() => navigate(loginPathForLocation(location))} />;
  if (!portal) return <PortalLoading />;

  const progressPercent = portal.progress.total === 0 ? 100 : Math.round((portal.progress.completed / portal.progress.total) * 100);
  return (
    <main className="mx-auto w-full max-w-6xl space-y-7 p-3 pb-10 sm:p-5 sm:pb-12 lg:p-7">
      <header className="overflow-hidden rounded-card border border-line bg-surface">
        <div className="border-l-[6px] border-accent p-4 sm:p-6">
          <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-accent">Speaker portal</p>
          <PageHeader title={`Welcome, ${portal.profile.displayName}`} description={`${portal.event.name} · ${eventDate}${portal.event.location ? ` · ${portal.event.location}` : ""}`} />
          <div className="mt-5 grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
            <div><div className="mb-2 flex justify-between text-xs font-medium text-ink-secondary"><span>Onboarding readiness</span><span>{progressPercent}%</span></div><div className="h-2 overflow-hidden rounded-full bg-surface-muted" role="progressbar" aria-label="Onboarding readiness" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progressPercent}><div className="h-full rounded-full bg-accent transition-[width] motion-reduce:transition-none" style={{ width: `${progressPercent}%` }} /></div></div>
            <p className="text-sm font-medium text-ink">{portal.progress.completed} of {portal.progress.total} tasks complete</p>
          </div>
        </div>
      </header>

      <div className="grid gap-7 lg:grid-cols-[minmax(0,1.1fr)_minmax(20rem,0.9fr)] lg:items-start">
        <SubmissionsPanel portal={portal} />
        <ProfilePanel eventSlug={portal.event.slug} profile={portal.profile} onChanged={reload} />
      </div>
      <TaskPanel portal={portal} onChanged={reload} />
      <ResourcesPanel portal={portal} />
    </main>
  );
}
