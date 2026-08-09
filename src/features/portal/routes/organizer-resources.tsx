import { type FormEvent, type ReactNode, useState } from "react";
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
  Select,
  Textarea,
  Toaster,
  toast,
} from "@/ui";
import type { CreateResourceInput, PortalResource, UpdateResourceInput } from "../schema";
import { createResource, deleteResource, getPortalResources, resolveOrganizerEventId, updateResource } from "./api";
import { RouteFailure, RouteLoading, useRouteLoad } from "../components/route-state";
import {
  ProductionHeader,
  ProductionSectionLabel,
  ProductionStats,
  productionButtonClass,
  productionCardClass,
  productionFormClass,
} from "../components/production-ui";

export const path = "/e/:eventSlug/resources";

function nullable(values: FormData, key: string): string | null {
  return String(values.get(key) ?? "").trim() || null;
}

function createResourceInput(eventId: string, form: HTMLFormElement): CreateResourceInput {
  const values = new FormData(form);
  return {
    eventId,
    slug: String(values.get("slug") ?? "").trim(),
    title: String(values.get("title") ?? "").trim(),
    body: nullable(values, "body"),
    embedUrl: nullable(values, "embedUrl"),
    audience: String(values.get("audience")) as CreateResourceInput["audience"],
    order: Number(values.get("order")),
  };
}

function updateResourceInput(eventId: string, resource: PortalResource, form: HTMLFormElement): UpdateResourceInput {
  return { ...createResourceInput(eventId, form), resourceId: resource.id, expectedVersion: resource.version };
}

export default function OrganizerResourcesRoute() {
  const { eventSlug = "" } = useParams();
  const [state, retry] = useRouteLoad(() => getPortalResources(eventSlug), eventSlug);
  const [busyId, setBusyId] = useState<string | null>(null);

  if (state.status === "loading") return <RouteLoading label="Loading portal resources" />;
  if (state.status === "error") return <RouteFailure message={state.message} onRetry={retry} />;

  async function mutate(id: string, action: (eventId: string) => Promise<unknown>, success: string) {
    setBusyId(id);
    try {
      const eventId = await resolveOrganizerEventId(eventSlug);
      await action(eventId);
      toast(success, { tone: "success" });
      retry();
    } catch (error) {
      toast(error instanceof Error ? error.message : "Resource could not be saved", { tone: "danger" });
    } finally {
      setBusyId(null);
    }
  }

  return (
    <>
      <OrganizerResourcesContent
        resources={state.data}
        busyId={busyId}
        onCreate={(form) => mutate("new", (eventId) => createResource(eventId, createResourceInput(eventId, form)), "Resource created")}
        onUpdate={(resource, form) => mutate(resource.id, (eventId) => updateResource(eventId, updateResourceInput(eventId, resource, form)), "Resource updated")}
        onDelete={(resource) => mutate(resource.id, (eventId) => deleteResource(eventId, { eventId, resourceId: resource.id, expectedVersion: resource.version }), "Resource deleted")}
      />
      <Toaster />
    </>
  );
}

export function OrganizerResourcesContent({
  resources,
  busyId = null,
  onCreate,
  onUpdate,
  onDelete,
}: {
  readonly resources: readonly PortalResource[];
  readonly busyId?: string | null;
  readonly onCreate: (form: HTMLFormElement) => void;
  readonly onUpdate: (resource: PortalResource, form: HTMLFormElement) => void;
  readonly onDelete: (resource: PortalResource) => void;
}) {
  const speakerResources = resources.filter((resource) => resource.audience === "speakers").length;
  const embeddedResources = resources.filter((resource) => resource.embedUrl !== null).length;
  return (
    <div className="space-y-8">
      <ProductionHeader
        eyebrow="Organizer control room / Field kit"
        title="Speaker resources"
        description="Publish production guidance in the portal. Embeds are rendered only from the portal's approved HTTPS providers."
        accent="sky"
      />
      <ProductionStats
        stats={[
          { label: "Resources", value: resources.length, tone: "sky" },
          { label: "Speaker only", value: speakerResources, tone: "lime" },
          { label: "Embedded", value: embeddedResources, tone: "coral" },
        ]}
      />
      <Card className={productionCardClass} title="New asset / Create resource">
        <ResourceFields
          submitLabel="Create resource"
          loading={busyId === "new"}
          onSubmit={(event) => {
            event.preventDefault();
            onCreate(event.currentTarget);
          }}
        />
      </Card>
      {resources.length === 0 ? (
        <div className="border-2 border-[#171714] bg-[#fffdf7] p-6 shadow-[6px_6px_0_#171714]">
          <EmptyState title="No resources published" description="Create a speaker guide, slide template, or production briefing." />
        </div>
      ) : (
        <section>
          <ProductionSectionLabel>Published field kit</ProductionSectionLabel>
          <div className="grid gap-5 xl:grid-cols-2">
            {[...resources].sort((left, right) => left.order - right.order).map((resource) => (
              <Card
                className={productionCardClass}
                key={resource.id}
                title={`Asset ${String(resource.order).padStart(2, "0")} / ${resource.title}`}
              >
                <ResourceFields
                  resource={resource}
                  submitLabel="Save changes"
                  loading={busyId === resource.id}
                  onSubmit={(event) => {
                    event.preventDefault();
                    onUpdate(resource, event.currentTarget);
                  }}
                  deleteAction={
                    <AlertDialog>
                      <AlertDialogTrigger asChild>
                        <Button className={productionButtonClass} type="button" variant="ghost" size="sm" disabled={busyId !== null}>Delete resource</Button>
                      </AlertDialogTrigger>
                      <AlertDialogContent>
                        <AlertDialogHeader>
                          <AlertDialogTitle>Delete {resource.title}?</AlertDialogTitle>
                          <AlertDialogDescription>This removes the current version from the speaker portal.</AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel>Keep resource</AlertDialogCancel>
                          <AlertDialogAction onClick={() => onDelete(resource)}>Delete resource</AlertDialogAction>
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

function ResourceFields({
  resource,
  submitLabel,
  loading,
  onSubmit,
  deleteAction,
}: {
  readonly resource?: PortalResource;
  readonly submitLabel: string;
  readonly loading: boolean;
  readonly onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  readonly deleteAction?: ReactNode;
}) {
  return (
    <form className={`space-y-4 ${productionFormClass}`} onSubmit={onSubmit}>
      <div className="grid gap-4 sm:grid-cols-2">
        <Input name="title" label="Title" required defaultValue={resource?.title ?? ""} />
        <Input name="slug" label="Slug" required pattern="[a-z0-9]+(?:-[a-z0-9]+)*" defaultValue={resource?.slug ?? ""} />
        <Select name="audience" label="Audience" defaultValue={resource?.audience ?? "speakers"}>
          <option value="speakers">Speakers</option>
          <option value="public">Public</option>
        </Select>
        <Input name="order" label="Order" type="number" required defaultValue={resource?.order ?? 0} />
      </div>
      <Textarea name="body" label="Resource text" rows={5} defaultValue={resource?.body ?? ""} />
      <Input name="embedUrl" label="Approved embed URL" type="url" placeholder="https://" defaultValue={resource?.embedUrl ?? ""} />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Button className={`${productionButtonClass} bg-[#896aff] text-[#171714]`} type="submit" loading={loading}>{submitLabel}</Button>
        {deleteAction}
      </div>
    </form>
  );
}
