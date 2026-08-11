import { useState, type FormEvent, type ReactNode } from "react";
import { useParams } from "react-router";
import type { FormSummary } from "@/features/forms/schema";
import { organizerFormPath } from "@/features/forms/links";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
  Button,
  Card,
  Checkbox,
  EmptyState,
  Input,
  Select,
  Textarea,
  Toaster,
  toast,
} from "@/ui";
import type { CreateTaskInput, PortalTaskDefinition, PortalTaskKind, SpeakerDirectoryItem, UpdateTaskInput } from "../schema";
import { createTask, deleteTask, getOrganizerFormSummaries, getSpeakerDirectory, getTaskDefinitions, resolveOrganizerEventId, updateTask } from "./api";
import { RouteFailure, RouteLoading, useRouteLoad } from "../components/route-state";
import {
  ProductionHeader,
  ProductionSectionLabel,
  ProductionStats,
  productionButtonClass,
  productionCardClass,
  productionFormClass,
} from "../components/production-ui";

export const path = "/e/:eventSlug/tasks";
export const contentWidth = "standard" as const;

const taskKinds: readonly PortalTaskKind[] = ["profile", "upload", "form", "link", "confirm"];

function nullable(values: FormData, key: string): string | null {
  return String(values.get(key) ?? "").trim() || null;
}

function dueAt(values: FormData): number | null {
  const value = nullable(values, "dueAt");
  return value ? new Date(value).getTime() : null;
}

function localDateTimeValue(timestamp: number | null | undefined): string {
  if (timestamp == null) return "";
  const date = new Date(timestamp);
  return new Date(timestamp - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 19);
}

function createTaskInput(eventId: string, form: HTMLFormElement): CreateTaskInput {
  const values = new FormData(form);
  return {
    eventId,
    name: String(values.get("name") ?? "").trim(),
    description: nullable(values, "description"),
    kind: String(values.get("kind")) as PortalTaskKind,
    formId: nullable(values, "formId"),
    dueAt: dueAt(values),
    order: Number(values.get("order")),
    speakerIds: values.getAll("speakerIds").map(String),
  };
}

function updateTaskInput(eventId: string, task: PortalTaskDefinition, form: HTMLFormElement): UpdateTaskInput {
  return { ...createTaskInput(eventId, form), taskId: task.id, expectedVersion: task.version };
}

export default function OrganizerTasksRoute() {
  const { eventSlug = "" } = useParams();
  const [state, retry] = useRouteLoad(async () => {
    const [tasks, directory, forms] = await Promise.all([
      getTaskDefinitions(eventSlug),
      getSpeakerDirectory(eventSlug),
      getOrganizerFormSummaries(eventSlug),
    ]);
    return { tasks, speakers: directory.speakers, forms };
  }, eventSlug);
  const [busyId, setBusyId] = useState<string | null>(null);

  if (state.status === "loading") return <RouteLoading label="Loading portal tasks" />;
  if (state.status === "error") return <RouteFailure message={state.message} onRetry={retry} />;

  async function mutate(id: string, action: (eventId: string) => Promise<unknown>, success: string) {
    setBusyId(id);
    try {
      const eventId = await resolveOrganizerEventId(eventSlug);
      await action(eventId);
      toast(success, { tone: "success" });
      retry();
    } catch (error) {
      toast(error instanceof Error ? error.message : "Task could not be saved", { tone: "danger" });
    } finally {
      setBusyId(null);
    }
  }

  return (
    <>
      <OrganizerTasksContent
        tasks={state.data.tasks}
        speakers={state.data.speakers}
        forms={state.data.forms}
        eventSlug={eventSlug}
        busyId={busyId}
        onCreate={(form) => mutate("new", (eventId) => createTask(eventId, createTaskInput(eventId, form)), "Task created")}
        onUpdate={(task, form) => mutate(task.id, (eventId) => updateTask(eventId, updateTaskInput(eventId, task, form)), "Task updated")}
        onDelete={(task) => mutate(task.id, (eventId) => deleteTask(eventId, { eventId, taskId: task.id, expectedVersion: task.version }), "Task deleted")}
      />
      <Toaster />
    </>
  );
}

export function OrganizerTasksContent({
  tasks,
  speakers = [],
  forms = [],
  eventSlug,
  busyId = null,
  onCreate,
  onUpdate,
  onDelete,
}: {
  readonly tasks: readonly PortalTaskDefinition[];
  readonly speakers?: readonly SpeakerDirectoryItem[];
  readonly forms?: readonly FormSummary[];
  readonly eventSlug?: string;
  readonly busyId?: string | null;
  readonly onCreate: (form: HTMLFormElement) => void;
  readonly onUpdate: (task: PortalTaskDefinition, form: HTMLFormElement) => void;
  readonly onDelete: (task: PortalTaskDefinition) => void;
}) {
  const datedTasks = tasks.filter((task) => task.dueAt !== null).length;
  const linkedForms = tasks.filter((task) => task.kind === "form" && task.formId).length;
  return (
    <div className="space-y-8">
      <ProductionHeader
        eyebrow="Organizer control room / Cue stack"
        title="Speaker tasks"
        description="Define the ordered checklist that drives speaker readiness across the portal and organizer dashboard. Use confirm tasks for employer approvals or co-speaker confirmations."
        accent="purple"
      />
      <ProductionStats
        stats={[
          { label: "Cues", value: tasks.length, tone: "purple" },
          { label: "With deadlines", value: datedTasks, tone: "coral" },
          { label: "Linked forms", value: linkedForms, tone: "sky" },
        ]}
      />
      <Card className={productionCardClass} title="New cue / Create task">
        <TaskFields
          speakers={speakers}
          forms={forms}
          eventSlug={eventSlug}
          submitLabel="Create task"
          loading={busyId === "new"}
          onSubmit={(event) => {
            event.preventDefault();
            onCreate(event.currentTarget);
          }}
        />
      </Card>
      {tasks.length === 0 ? (
        <div className="border-2 border-[#171714] bg-[#fffdf7] p-6 shadow-[6px_6px_0_#171714]">
          <EmptyState title="No readiness tasks" description="Create the first production task so speakers know what to complete next." />
        </div>
      ) : (
        <section>
          <ProductionSectionLabel>Active cue stack</ProductionSectionLabel>
          <div className="grid gap-5 xl:grid-cols-2">
            {[...tasks].sort((left, right) => left.order - right.order).map((task) => (
              <Card
                className={productionCardClass}
                key={task.id}
                title={`Cue ${String(task.order).padStart(2, "0")} / ${task.name}`}
              >
                <TaskFields
                  task={task}
                  speakers={speakers}
                  forms={forms}
                  eventSlug={eventSlug}
                  submitLabel="Save changes"
                  loading={busyId === task.id}
                  onSubmit={(event) => {
                    event.preventDefault();
                    onUpdate(task, event.currentTarget);
                  }}
                  deleteAction={
                    <AlertDialog>
                      <AlertDialogTrigger asChild>
                        <Button className={productionButtonClass} type="button" variant="ghost" size="sm" disabled={busyId !== null}>Delete task</Button>
                      </AlertDialogTrigger>
                      <AlertDialogContent>
                        <AlertDialogHeader>
                          <AlertDialogTitle>Delete {task.name}?</AlertDialogTitle>
                          <AlertDialogDescription>Existing completion history for this version will no longer count toward readiness.</AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel>Keep task</AlertDialogCancel>
                          <AlertDialogAction onClick={() => onDelete(task)}>Delete task</AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                  }
                />
              </Card>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function TaskFields({
  task,
  speakers = [],
  forms = [],
  eventSlug,
  submitLabel,
  loading,
  onSubmit,
  deleteAction,
}: {
  readonly task?: PortalTaskDefinition;
  readonly speakers?: readonly SpeakerDirectoryItem[];
  readonly forms?: readonly FormSummary[];
  readonly eventSlug?: string;
  readonly submitLabel: string;
  readonly loading: boolean;
  readonly onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  readonly deleteAction?: ReactNode;
}) {
  const dateValue = localDateTimeValue(task?.dueAt);
  const [kind, setKind] = useState<PortalTaskKind>(task?.kind ?? "confirm");
  const [linkedFormId, setLinkedFormId] = useState(task?.formId ?? "");
  const missingLinkedForm = task?.formId && !forms.some((form) => form.id === task.formId)
    ? task.formId
    : null;
  return (
    <form className={`space-y-4 ${productionFormClass}`} onSubmit={onSubmit}>
      <div className="grid gap-4 sm:grid-cols-2">
        <Input name="name" label="Task name" required defaultValue={task?.name ?? ""} />
        <Select name="kind" label="Task type" value={kind} onChange={(event) => setKind(event.currentTarget.value as PortalTaskKind)}>
          {taskKinds.map((kind) => <option key={kind} value={kind}>{kind}</option>)}
        </Select>
        <Input name="order" label="Order" type="number" required defaultValue={task?.order ?? 0} />
        <Input name="dueAt" label="Due date" type="datetime-local" step={1} defaultValue={dateValue} />
        {kind === "form" && (
          <div className="space-y-2">
            <Select
              name="formId"
              label="Form"
              required
              value={linkedFormId}
              onChange={(event) => setLinkedFormId(event.currentTarget.value)}
            >
              <option value="">{forms.length === 0 ? "No forms available" : "Choose a form"}</option>
              {missingLinkedForm ? <option value={missingLinkedForm}>Unavailable form · {missingLinkedForm}</option> : null}
              {forms.map((form) => (
                <option key={form.id} value={form.id}>{form.name} · {form.status}</option>
              ))}
            </Select>
            {eventSlug ? (
              linkedFormId ? (
                <a
                  className="inline-flex text-xs font-black uppercase tracking-wide text-accent underline underline-offset-2"
                  href={organizerFormPath(eventSlug, linkedFormId)}
                >
                  Open form
                </a>
              ) : (
                <a
                  className="inline-flex text-xs font-black uppercase tracking-wide text-accent underline underline-offset-2"
                  href={`/e/${encodeURIComponent(eventSlug)}/forms`}
                >
                  Create a form
                </a>
              )
            ) : null}
          </div>
        )}
      </div>
      <Textarea name="description" label="Instructions" defaultValue={task?.description ?? ""} />
      <fieldset className="space-y-2 border-2 border-[#171714] bg-[#fffdf7] p-3">
        <legend className="px-2 text-xs font-black uppercase tracking-wide">Assigned speakers</legend>
        <p className="text-xs text-ink-muted">Leave every speaker unchecked to assign this task to all current and future speakers.</p>
        <div className="grid max-h-48 gap-2 overflow-auto sm:grid-cols-2">
          {speakers.map((item) => (
            <div className="flex items-start justify-between gap-2" key={item.speaker.id}>
              <Checkbox
                name="speakerIds"
                value={item.speaker.id}
                label={`${item.speaker.displayName} · ${item.speaker.workflowStatus}`}
                defaultChecked={task?.speakerIds.includes(item.speaker.id) ?? false}
              />
              {eventSlug && (
                <a
                  className="inline-flex min-h-6 shrink-0 items-center text-xs font-black uppercase tracking-wide text-accent-deep underline underline-offset-2"
                  href={`/e/${encodeURIComponent(eventSlug)}/speakers/${encodeURIComponent(item.speaker.id)}`}
                >
                  Profile
                </a>
              )}
            </div>
          ))}
        </div>
      </fieldset>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Button className={`${productionButtonClass} bg-[#896aff] text-[#171714]`} type="submit" loading={loading}>{submitLabel}</Button>
        {deleteAction}
      </div>
    </form>
  );
}
