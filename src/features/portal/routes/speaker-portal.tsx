import { useState, type FormEvent, type ReactNode } from "react";
import { useParams } from "react-router";
import {
  Alert,
  AlertDescription,
  Badge,
  Button,
  Card,
  Dropzone,
  EmptyState,
  Input,
  PageHeader,
  ProgressChecklist,
  ReadinessThread,
  Select,
  Textarea,
  Toaster,
  toast,
} from "@/ui";
import type {
  PortalResource,
  PortalSnapshot,
  PortalTask,
  SpeakerProfile,
  UpdateProfileInput,
  UploadPortalAssetInput,
} from "../schema";
import {
  getSpeakerPortal,
  setSpeakerTaskCompletion,
  updateSpeakerProfile,
  uploadSpeakerAsset,
} from "./api";
import { RouteFailure, RouteLoading, useRouteLoad } from "../components/route-state";

export const path = "/e/:eventSlug/portal/*";
export const layout = "bare" as const;

const embedHosts: Record<string, true> = {
  "docs.google.com": true,
  "player.vimeo.com": true,
  "www.youtube-nocookie.com": true,
  "www.youtube.com": true,
  "youtube-nocookie.com": true,
  "youtube.com": true,
};

export function allowlistedEmbedUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && embedHosts[url.hostname] === true ? url.href : null;
  } catch {
    return null;
  }
}

export function formatPortalDate(value: number, timezone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeZone: timezone,
  }).format(value);
}

export async function fileAsBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const chunks: string[] = [];
  const binaryChunkBytes = 32_768;
  for (let offset = 0; offset < bytes.length; offset += binaryChunkBytes) {
    chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + binaryChunkBytes)));
  }
  return btoa(chunks.join(""));
}

function profileInput(profile: SpeakerProfile, form: HTMLFormElement): UpdateProfileInput {
  const values = new FormData(form);
  const labels = values.getAll("linkLabel").map(String);
  const urls = values.getAll("linkUrl").map(String);
  return {
    eventId: profile.eventId,
    expectedVersion: profile.version,
    displayName: String(values.get("displayName") ?? "").trim(),
    title: String(values.get("title") ?? "").trim() || null,
    company: String(values.get("company") ?? "").trim() || null,
    bio: String(values.get("bio") ?? "").trim() || null,
    links: urls.flatMap((url, index) => {
      const trimmedUrl = url.trim();
      const label = labels[index]?.trim();
      return trimmedUrl && label ? [{ label, url: trimmedUrl }] : [];
    }),
  };
}

function SpeakerPortalFrame({ children }: { readonly children: ReactNode }) {
  return (
    <main className="min-h-dvh bg-canvas px-4 py-8 text-ink sm:px-6 lg:px-8">
      <div className="mx-auto max-w-7xl">{children}</div>
    </main>
  );
}

export default function SpeakerPortalRoute() {
  const { eventSlug = "" } = useParams();
  const [state, retry] = useRouteLoad(() => getSpeakerPortal(eventSlug), eventSlug);
  const [mutation, setMutation] = useState<string | null>(null);
  const [mutationError, setMutationError] = useState<string | null>(null);

  if (state.status === "loading") {
    return <SpeakerPortalFrame><RouteLoading label="Loading speaker portal" /></SpeakerPortalFrame>;
  }
  if (state.status === "error") {
    return <SpeakerPortalFrame><RouteFailure message={state.message} onRetry={retry} /></SpeakerPortalFrame>;
  }

  async function mutate(label: string, action: () => Promise<unknown>) {
    setMutation(label);
    setMutationError(null);
    try {
      await action();
      toast(`${label} saved`, { tone: "success" });
      retry();
    } catch (error) {
      const message = error instanceof Error ? error.message : `${label} could not be saved`;
      setMutationError(message);
      toast(message, { tone: "danger" });
    } finally {
      setMutation(null);
    }
  }

  return (
    <SpeakerPortalFrame>
      <SpeakerPortalContent
        snapshot={state.data}
        busyAction={mutation}
        error={mutationError}
        onSaveProfile={(input) => mutate("Profile", () => updateSpeakerProfile(eventSlug, input))}
        onToggleTask={(task, completed) =>
          mutate("Task", () =>
            setSpeakerTaskCompletion(eventSlug, {
              eventId: state.data.event.id,
              taskId: task.id,
              completed,
            }),
          )
        }
        onUpload={(input) => mutate("Upload", () => uploadSpeakerAsset(eventSlug, input))}
      />
      <Toaster />
    </SpeakerPortalFrame>
  );
}

export interface SpeakerPortalContentProps {
  readonly snapshot: PortalSnapshot;
  readonly busyAction?: string | null;
  readonly error?: string | null;
  readonly onSaveProfile: (input: UpdateProfileInput) => void;
  readonly onToggleTask: (task: PortalTask, completed: boolean) => void;
  readonly onUpload: (input: UploadPortalAssetInput) => void;
}

export function SpeakerPortalContent({
  snapshot,
  busyAction = null,
  error = null,
  onSaveProfile,
  onToggleTask,
  onUpload,
}: SpeakerPortalContentProps) {
  const currentTask = snapshot.tasks.find((task) => !task.completed)?.id;
  return (
    <div className="space-y-8">
      <PageHeader
        title={snapshot.event.name}
        description="Your speaker production workspace. Complete each step here before the event."
        actions={
          <Badge tone={snapshot.readiness.state === "ready" ? "success" : "accent"}>
            {snapshot.readiness.tasksDone} of {snapshot.readiness.tasksTotal} ready
          </Badge>
        }
      />
      {error && (
        <Alert tone="danger">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <div className="grid gap-8 xl:grid-cols-[minmax(0,1fr)_minmax(18rem,0.65fr)]">
        <div className="min-w-0 space-y-8">
          {snapshot.submission && (
            <section className="border-y border-line py-5" aria-labelledby="accepted-session-title">
              <p className="text-xs font-semibold uppercase tracking-wide text-ink-faint">Accepted session</p>
              <h2 id="accepted-session-title" className="mt-2 text-xl font-semibold text-ink">
                {snapshot.submission.title}
              </h2>
              {snapshot.submission.category && (
                <p className="mt-1 text-sm text-ink-secondary">{snapshot.submission.category}</p>
              )}
            </section>
          )}

          <ProfileEditor
            key={snapshot.speaker.version}
            profile={snapshot.speaker}
            loading={busyAction === "Profile"}
            onSave={onSaveProfile}
          />
          <UploadWorkspace
            eventId={snapshot.event.id}
            assets={snapshot.assets}
            tasks={snapshot.tasks}
            loading={busyAction === "Upload"}
            onUpload={onUpload}
          />
          <ResourceList resources={snapshot.resources} />
        </div>

        <aside className="min-w-0 space-y-5 xl:sticky xl:top-6 xl:self-start" aria-label="Speaker readiness">
          {snapshot.tasks.length === 0 ? (
            <Card>
              <EmptyState
                title="No production tasks"
                description="The event team has not assigned any speaker tasks yet."
              />
            </Card>
          ) : (
            <>
              <Card title="Production thread">
                <ReadinessThread
                  currentId={currentTask}
                  items={snapshot.tasks.map((task) => ({
                    id: task.id,
                    label: task.name,
                    description: task.description ?? undefined,
                    state: task.completed ? "complete" : "pending",
                    timestamp: task.completedAt ? formatPortalDate(task.completedAt, snapshot.event.timezone) : undefined,
                  }))}
                />
              </Card>
              <Card>
                <ProgressChecklist
                  items={snapshot.tasks.map((task) => ({
                    id: task.id,
                    label: task.name,
                    description: task.description ?? undefined,
                    completed: task.completed,
                    disabled: busyAction !== null,
                  }))}
                  onToggle={(taskId, completed) => {
                    const task = snapshot.tasks.find((candidate) => candidate.id === taskId);
                    if (task) onToggleTask(task, completed);
                  }}
                />
              </Card>
            </>
          )}
        </aside>
      </div>
    </div>
  );
}

function ProfileEditor({
  profile,
  loading,
  onSave,
}: {
  readonly profile: SpeakerProfile;
  readonly loading: boolean;
  readonly onSave: (input: UpdateProfileInput) => void;
}) {
  const [linkCount, setLinkCount] = useState(Math.max(profile.links.length, 1));
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    onSave(profileInput(profile, event.currentTarget));
  };
  return (
    <form className="space-y-5" onSubmit={submit} aria-labelledby="profile-heading">
      <div>
        <h2 id="profile-heading" className="text-lg font-semibold text-ink">Speaker profile</h2>
        <p className="mt-1 text-sm text-ink-secondary">This information is used by the event team and, when published, the speaker gallery.</p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Input name="displayName" label="Display name" required defaultValue={profile.displayName} />
        <Input name="title" label="Title" defaultValue={profile.title ?? ""} />
        <Input name="company" label="Company" defaultValue={profile.company ?? ""} />
      </div>
      <Textarea name="bio" label="Biography" rows={6} defaultValue={profile.bio ?? ""} />
      <fieldset className="space-y-3">
        <legend className="text-sm font-semibold text-ink">Public links</legend>
        {Array.from({ length: linkCount }, (_, index) => (
          <div key={index} className="grid gap-3 sm:grid-cols-[minmax(8rem,0.4fr)_minmax(0,1fr)]">
            <Input name="linkLabel" aria-label={`Link ${index + 1} label`} placeholder="Website" defaultValue={profile.links[index]?.label ?? ""} />
            <Input
              name="linkUrl"
              aria-label={`Link ${index + 1} URL`}
              type="url"
              pattern="https?://.*"
              placeholder="https://"
              defaultValue={profile.links[index]?.url ?? ""}
            />
          </div>
        ))}
        <Button type="button" variant="ghost" size="sm" onClick={() => setLinkCount((count) => count + 1)}>Add another link</Button>
      </fieldset>
      <Button type="submit" loading={loading}>Save profile</Button>
    </form>
  );
}

function UploadWorkspace({
  eventId,
  assets,
  tasks,
  loading,
  onUpload,
}: {
  readonly eventId: string;
  readonly assets: PortalSnapshot["assets"];
  readonly tasks: readonly PortalTask[];
  readonly loading: boolean;
  readonly onUpload: (input: UploadPortalAssetInput) => void;
}) {
  const [purpose, setPurpose] = useState<UploadPortalAssetInput["purpose"]>("slides");
  const uploadTask = tasks.find((task) => task.kind === "upload" && !task.completed);
  return (
    <section className="space-y-4" aria-labelledby="uploads-heading">
      <div>
        <h2 id="uploads-heading" className="text-lg font-semibold text-ink">Production files</h2>
        <p className="mt-1 text-sm text-ink-secondary">Upload the final files the event team should use.</p>
      </div>
      <Select label="File purpose" value={purpose} disabled={loading} onChange={(event) => setPurpose(event.currentTarget.value as UploadPortalAssetInput["purpose"])}>
        <option value="slides">Slides</option>
        <option value="document">Document</option>
        <option value="headshot">Headshot</option>
      </Select>
      <Dropzone
        multiple={false}
        disabled={loading}
        accept={purpose === "headshot" ? "image/*" : undefined}
        hint={loading ? "Uploading…" : "Choose one production-ready file."}
        onFiles={(files) => {
          const file = files[0];
          if (!file) return;
          void fileAsBase64(file).then(
            (contentBase64) =>
              onUpload({
                eventId,
                taskId: uploadTask?.id,
                purpose,
                filename: file.name,
                contentType: file.type || "application/octet-stream",
                contentBase64,
              }),
            (error: unknown) => toast(error instanceof Error ? error.message : "File could not be read", { tone: "danger" }),
          );
        }}
      />
      {assets.length === 0 ? (
        <EmptyState title="No files uploaded" description="Your uploaded headshots, slides, and documents will be listed here." />
      ) : (
        <ul className="divide-y divide-line border-y border-line">
          {assets.map((asset) => (
            <li key={asset.id} className="flex items-center justify-between gap-4 py-3 text-sm">
              <span className="min-w-0 truncate font-medium text-ink">{asset.filename}</span>
              <span className="shrink-0 text-ink-faint">{asset.purpose} · {Math.ceil(asset.size / 1024)} KB</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function ResourceList({ resources }: { readonly resources: readonly PortalResource[] }) {
  if (resources.length === 0) {
    return <EmptyState title="No speaker resources yet" description="Event guidance and production resources will appear here." />;
  }
  return (
    <section className="space-y-4" aria-labelledby="resources-heading">
      <h2 id="resources-heading" className="text-lg font-semibold text-ink">Speaker resources</h2>
      {resources.map((resource) => {
        const embedUrl = allowlistedEmbedUrl(resource.embedUrl);
        return (
          <article key={resource.id} className="border-t border-line pt-4">
            <h3 className="font-semibold text-ink">{resource.title}</h3>
            {resource.body && <p className="mt-2 whitespace-pre-line text-sm leading-relaxed text-ink-secondary">{resource.body}</p>}
            {embedUrl && (
              <iframe
                className="mt-4 aspect-video w-full rounded-card border border-line bg-surface"
                src={embedUrl}
                title={resource.title}
                loading="lazy"
                sandbox="allow-scripts allow-same-origin allow-presentation"
                referrerPolicy="no-referrer"
                allow="fullscreen"
              />
            )}
          </article>
        );
      })}
    </section>
  );
}
