import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { useParams } from "react-router";
import type { AnswerValue } from "contracts/types";
import {
  Alert,
  AlertDescription,
  AlertTitle,
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
  Skeleton,
  Textarea,
  Toaster,
  toast,
} from "@/ui";
import {
  type PublicSubmissionForm as PublicSubmissionFormValue,
  type SubmissionAnswer,
} from "@/features/submit/schema";
import { PublicField, visibleFields } from "@/features/submit/routes/public-submit";
import type {
  PortalResource,
  PortalSnapshot,
  PortalTask,
  SpeakerProfile,
  UpdateProfileInput,
  UploadPortalAssetInput,
} from "../schema";
import {
  getSpeakerTaskForm,
  getSpeakerPortal,
  setSpeakerTaskCompletion,
  submitSpeakerTaskForm,
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
export const PORTAL_UPLOAD_MAX_BYTES = 10 * 1_024 * 1_024;


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
  if (file.size > PORTAL_UPLOAD_MAX_BYTES) {
    throw new Error("File exceeds 10 MiB with the current upload transport");
  }
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
    idempotencyKey: crypto.randomUUID(),
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
  const snapshot = state.data;

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

  async function submitTaskForm(
    task: PortalTask,
    answers: readonly SubmissionAnswer[],
    idempotencyKey: string,
  ): Promise<boolean> {
    if (!task.formId) return false;
    setMutation("Task form");
    setMutationError(null);
    try {
      await submitSpeakerTaskForm({
        eventId: snapshot.event.id,
        formId: task.formId,
        answers,
        idempotencyKey,
      });
      toast(`${task.name} submitted`, { tone: "success" });
      retry();
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : `${task.name} could not be submitted`;
      setMutationError(message);
      toast(message, { tone: "danger" });
      return false;
    } finally {
      setMutation(null);
    }
  }

  return (
    <SpeakerPortalFrame>
      <SpeakerPortalContent
        snapshot={snapshot}
        busyAction={mutation}
        error={mutationError}
        onSaveProfile={(input) => mutate("Profile", () => updateSpeakerProfile(eventSlug, input))}
        onToggleTask={(task, completed) =>
          mutate("Task", () =>
            setSpeakerTaskCompletion(eventSlug, {
              eventId: snapshot.event.id,
              taskId: task.id,
              completed,
              idempotencyKey: crypto.randomUUID(),
            }),
          )
        }
        onUpload={(input) => mutate("Upload", () => uploadSpeakerAsset(eventSlug, input))}
        onSubmitTaskForm={submitTaskForm}
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
  readonly onSubmitTaskForm: (
    task: PortalTask,
    answers: readonly SubmissionAnswer[],
    idempotencyKey: string,
  ) => Promise<boolean>;
}

export function SpeakerPortalContent({
  snapshot,
  busyAction = null,
  error = null,
  onSaveProfile,
  onToggleTask,
  onUpload,
  onSubmitTaskForm,
}: SpeakerPortalContentProps) {
  const [activeFormTaskId, setActiveFormTaskId] = useState<string | null>(null);
  const currentTask = snapshot.tasks.find((task) => !task.completed)?.id;
  const incompleteFormTasks = snapshot.tasks.filter((task) => task.kind === "form" && !task.completed);
  const activeFormTask = incompleteFormTasks.find((task) => task.id === activeFormTaskId);
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

          {activeFormTask?.formId && (
            <SpeakerTaskFormPanel
              key={activeFormTask.id}
              eventSlug={snapshot.event.slug}
              task={activeFormTask}
              busy={busyAction !== null}
              onClose={() => setActiveFormTaskId(null)}
              onSubmit={(answers, idempotencyKey) =>
                onSubmitTaskForm(activeFormTask, answers, idempotencyKey)}
            />
          )}

          <ProfileEditor
            key={snapshot.speaker.version}
            profile={snapshot.speaker}
            loading={busyAction === "Profile"}
            onSave={onSaveProfile}
          />
          <UploadWorkspace
            eventId={snapshot.event.id}
            speaker={snapshot.speaker}
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
                    description: task.prerequisite.message ?? task.description ?? undefined,
                    state: task.completed ? "complete" : "pending",
                    timestamp: task.completedAt ? formatPortalDate(task.completedAt, snapshot.event.timezone) : undefined,
                  }))}
                />
              </Card>
              {incompleteFormTasks.length > 0 && (
                <Card title="Forms to complete">
                  <ul className="space-y-4">
                    {incompleteFormTasks.map((task) => {
                      const open = task.id === activeFormTask?.id;
                      return (
                        <li key={task.id} className="space-y-2">
                          <div>
                            <p className="text-sm font-medium text-ink">{task.name}</p>
                            {task.description && <p className="mt-1 text-sm text-ink-secondary">{task.description}</p>}
                          </div>
                          {task.formId ? (
                            <Button
                              type="button"
                              variant="secondary"
                              size="sm"
                              disabled={busyAction !== null}
                              aria-expanded={open}
                              aria-controls={`speaker-task-form-${task.id}`}
                              onClick={() => setActiveFormTaskId(open ? null : task.id)}
                            >
                              {open ? "Close form" : `Open ${task.name}`}
                            </Button>
                          ) : (
                            <p className="text-sm text-danger" role="status">The event team needs to relink this form.</p>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                </Card>
              )}
              <Card>
                <ProgressChecklist
                  items={snapshot.tasks.map((task) => ({
                    id: task.id,
                    label: task.name,
                    description: task.prerequisite.message ?? task.description ?? undefined,
                    completed: task.completed,
                    disabled: busyAction !== null || (!task.completed && !task.prerequisite.satisfied),
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

export function SpeakerTaskFormPanel({
  eventSlug,
  task,
  busy,
  initialForm,
  onClose,
  onSubmit,
}: {
  readonly eventSlug: string;
  readonly task: PortalTask;
  readonly busy: boolean;
  readonly initialForm?: PublicSubmissionFormValue | null;
  readonly onClose: () => void;
  readonly onSubmit: (
    answers: readonly SubmissionAnswer[],
    idempotencyKey: string,
  ) => Promise<boolean>;
}) {
  const [form, setForm] = useState<PublicSubmissionFormValue | null | undefined>(initialForm);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [answers, setAnswers] = useState<Record<string, AnswerValue>>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const idempotencyKey = useRef(crypto.randomUUID());

  useEffect(() => {
    if (initialForm !== undefined || !task.formId) return;
    let active = true;
    setForm(undefined);
    setLoadError(null);
    void getSpeakerTaskForm(eventSlug, task.formId).then(
      (loaded) => {
        if (active) setForm(loaded);
      },
      (error: unknown) => {
        if (!active) return;
        setLoadError(error instanceof Error ? error.message : "Could not load this form");
        setForm(null);
      },
    );
    return () => {
      active = false;
    };
  }, [eventSlug, initialForm, task.formId]);

  const shownFields = useMemo(() => form ? visibleFields(form.form.fields, answers) : [], [answers, form]);
  const accepting = form?.form.availability === "open";

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!accepting || busy) return;
    setSubmitError(null);
    const activeIds = new Set(shownFields.map((field) => field.id));
    const saved = await onSubmit(
      Object.entries(answers)
        .filter(([fieldId]) => activeIds.has(fieldId))
        .map(([fieldId, value]) => ({ fieldId, value })),
      idempotencyKey.current,
    );
    if (saved) onClose();
    else setSubmitError("The form was not submitted. Review the message above and try again.");
  };

  return (
    <section id={`speaker-task-form-${task.id}`} aria-labelledby={`speaker-task-form-title-${task.id}`}>
      <Card title={task.name}>
        <div className="space-y-5">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 id={`speaker-task-form-title-${task.id}`} className="font-semibold text-ink">Linked speaker form</h2>
              {task.description && <p className="mt-1 text-sm text-ink-secondary">{task.description}</p>}
            </div>
            <Button type="button" variant="ghost" size="sm" onClick={onClose}>Close</Button>
          </div>
          {form === undefined ? (
            <div className="space-y-3" aria-label="Loading linked form">
              <Skeleton className="h-10" />
              <Skeleton className="h-28" />
            </div>
          ) : form === null ? (
            <EmptyState title="Linked form unavailable" description={loadError ?? "Ask the event team to check this task's form."} />
          ) : (
            <form className="space-y-5" onSubmit={(event) => void submit(event)}>
              <div>
                <p className="text-sm font-medium text-ink">{form.form.name}</p>
                {form.form.description && <p className="mt-1 text-sm text-ink-secondary">{form.form.description}</p>}
              </div>
              {!accepting && (
                <Alert tone="warning">
                  <AlertTitle>{form.form.availability === "scheduled" ? "Form not open yet" : "Form closed"}</AlertTitle>
                  <AlertDescription>The event team must open this form before you can complete the task.</AlertDescription>
                </Alert>
              )}
              {shownFields.map((field) => (
                <PublicField
                  key={field.id}
                  field={field}
                  value={answers[field.id]}
                  disabled={!accepting || busy}
                  onChange={(value) => setAnswers((current) => ({ ...current, [field.id]: value }))}
                />
              ))}
              {submitError && (
                <Alert tone="danger">
                  <AlertTitle>Form not submitted</AlertTitle>
                  <AlertDescription>{submitError}</AlertDescription>
                </Alert>
              )}
              {accepting && <Button type="submit" loading={busy}>Submit form</Button>}
            </form>
          )}
        </div>
      </Card>
    </section>
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
      {profile.pendingSyncFields.length > 0 && (
        <p className="text-sm text-ink-secondary">
          Pending organizer sync: {profile.pendingSyncFields.join(", ")}
        </p>
      )}
    </form>
  );
}

function UploadWorkspace({
  eventId,
  speaker,
  assets,
  tasks,
  loading,
  onUpload,
}: {
  readonly eventId: string;
  readonly speaker: SpeakerProfile;
  readonly assets: PortalSnapshot["assets"];
  readonly tasks: readonly PortalTask[];
  readonly loading: boolean;
  readonly onUpload: (input: UploadPortalAssetInput) => void;
}) {
  const [purpose, setPurpose] = useState<UploadPortalAssetInput["purpose"]>("slides");
  const uploadTask = tasks.find((task) => task.kind === "upload");
  return (
    <section className="space-y-4" aria-labelledby="uploads-heading">
      <div>
        <h2 id="uploads-heading" className="text-lg font-semibold text-ink">Production files</h2>
        <p className="mt-1 text-sm text-ink-secondary">
          Upload the final files the event team should use. Up to 10 MiB with the current upload transport.
        </p>
      </div>
      <Select label="File purpose" value={purpose} disabled={loading} onChange={(event) => setPurpose(event.currentTarget.value as UploadPortalAssetInput["purpose"])}>
        <option value="slides">Slides</option>
        <option value="document">Document</option>
        <option value="headshot">Headshot</option>
      </Select>
      <Dropzone
        multiple={false}
        disabled={loading}
        accept={purpose === "headshot"
          ? ".jpg,.jpeg,.png,.webp,image/jpeg,image/png,image/webp"
          : purpose === "slides"
            ? ".pdf,.ppt,.pptx,application/pdf,application/vnd.ms-powerpoint,application/vnd.openxmlformats-officedocument.presentationml.presentation"
            : ".pdf,.doc,.docx,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document"}
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
                expectedVersion: purpose === "headshot"
                  ? speaker.version
                  : uploadTask?.completionVersion ?? 0,
                idempotencyKey: crypto.randomUUID(),
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
