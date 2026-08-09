import { useState, type FormEvent, type ReactNode } from "react";
import { useParams } from "react-router";
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
  EmptyState,
  Input,
  PageHeader,
  Select,
  Textarea,
  Toaster,
  toast,
} from "@/ui";
import type { CreateTaskInput, PortalTaskDefinition, PortalTaskKind, UpdateTaskInput } from "../schema";
import { createTask, deleteTask, getTaskDefinitions, resolveOrganizerEventId, updateTask } from "./api";
import { RouteFailure, RouteLoading, useRouteLoad } from "../components/route-state";

export const path = "/e/:eventSlug/tasks";

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
  };
}

function updateTaskInput(eventId: string, task: PortalTaskDefinition, form: HTMLFormElement): UpdateTaskInput {
  return { ...createTaskInput(eventId, form), taskId: task.id, expectedVersion: task.version };
}

export default function OrganizerTasksRoute() {
  const { eventSlug = "" } = useParams();
  const [state, retry] = useRouteLoad(() => getTaskDefinitions(eventSlug), eventSlug);
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
        tasks={state.data}
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
  busyId = null,
  onCreate,
  onUpdate,
  onDelete,
}: {
  readonly tasks: readonly PortalTaskDefinition[];
  readonly busyId?: string | null;
  readonly onCreate: (form: HTMLFormElement) => void;
  readonly onUpdate: (task: PortalTaskDefinition, form: HTMLFormElement) => void;
  readonly onDelete: (task: PortalTaskDefinition) => void;
}) {
  return (
    <div className="space-y-7">
      <PageHeader title="Speaker tasks" description="Define the ordered checklist that drives speaker readiness across the portal and organizer dashboard." />
      <Card title="Create task">
        <TaskFields
          submitLabel="Create task"
          loading={busyId === "new"}
          onSubmit={(event) => {
            event.preventDefault();
            onCreate(event.currentTarget);
          }}
        />
      </Card>
      {tasks.length === 0 ? (
        <EmptyState title="No readiness tasks" description="Create the first production task so speakers know what to complete next." />
      ) : (
        <div className="space-y-4">
          {[...tasks].sort((left, right) => left.order - right.order).map((task) => (
            <Card key={task.id} title={task.name}>
              <TaskFields
                task={task}
                submitLabel="Save changes"
                loading={busyId === task.id}
                onSubmit={(event) => {
                  event.preventDefault();
                  onUpdate(task, event.currentTarget);
                }}
                deleteAction={
                  <AlertDialog>
                    <AlertDialogTrigger asChild>
                      <Button type="button" variant="ghost" size="sm" disabled={busyId !== null}>Delete task</Button>
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
      )}
    </div>
  );
}

function TaskFields({
  task,
  submitLabel,
  loading,
  onSubmit,
  deleteAction,
}: {
  readonly task?: PortalTaskDefinition;
  readonly submitLabel: string;
  readonly loading: boolean;
  readonly onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  readonly deleteAction?: ReactNode;
}) {
  const dateValue = localDateTimeValue(task?.dueAt);
  return (
    <form className="space-y-4" onSubmit={onSubmit}>
      <div className="grid gap-4 sm:grid-cols-2">
        <Input name="name" label="Task name" required defaultValue={task?.name ?? ""} />
        <Select name="kind" label="Task type" defaultValue={task?.kind ?? "confirm"}>
          {taskKinds.map((kind) => <option key={kind} value={kind}>{kind}</option>)}
        </Select>
        <Input name="order" label="Order" type="number" required defaultValue={task?.order ?? 0} />
        <Input name="dueAt" label="Due date" type="datetime-local" step={1} defaultValue={dateValue} />
        <Input name="formId" label="Form ID" hint="Required only for form tasks." defaultValue={task?.formId ?? ""} />
      </div>
      <Textarea name="description" label="Instructions" defaultValue={task?.description ?? ""} />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Button type="submit" loading={loading}>{submitLabel}</Button>
        {deleteAction}
      </div>
    </form>
  );
}
