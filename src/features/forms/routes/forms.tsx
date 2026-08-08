import { useState } from "react";
import { useParams } from "react-router";
import { Badge, Button, Card, EmptyState, PageHeader, Select, Skeleton, Toaster, toast } from "@/ui";
import { FormBuilder } from "../components/FormBuilder";
import { FormPreview } from "../components/FormPreview";
import {
  FORMS_FIXTURE_NOW,
  formsFixtures,
  routedFormsFixture,
  type FormsFixture,
} from "../fixtures";
import type { FormDetail, FormField, FormVersionField } from "../schema";

export const path = "/e/:eventSlug/forms";

export interface FormsWorkbenchProps {
  fixture?: FormsFixture;
  state?: "ready" | "loading" | "error";
}


export function FormsWorkbench({ fixture = routedFormsFixture, state = "ready" }: FormsWorkbenchProps) {
  const [scenarioId, setScenarioId] = useState(fixture.id);
  const initialFixture = formsFixtures.find((candidate) => candidate.id === scenarioId) ?? fixture;
  const [forms, setForms] = useState<readonly FormDetail[]>(() => structuredClone(initialFixture.forms));
  const [selectedId, setSelectedId] = useState<string | null>(initialFixture.forms[0]?.id ?? null);
  const selected = forms.find((form) => form.id === selectedId) ?? null;

  const chooseScenario = (id: string) => {
    const next = formsFixtures.find((candidate) => candidate.id === id) ?? routedFormsFixture;
    setScenarioId(next.id);
    setForms(structuredClone(next.forms));
    setSelectedId(next.forms[0]?.id ?? null);
  };

  const replaceForm = (next: FormDetail) => {
    setForms((current) => current.map((form) => form.id === next.id ? next : form));
  };

  const createPrimary = () => {
    const primary: FormDetail = {
      id: "form-primary-cfp-new",
      eventId: fixture.eventId,
      purpose: "primary-cfp",
      name: "Call for proposals",
      description: "Tell us what you want to share with the community.",
      status: "draft",
      opensAt: null,
      closesAt: null,
      version: 1,
      createdAt: FORMS_FIXTURE_NOW,
      updatedAt: FORMS_FIXTURE_NOW,
      fields: [
        {
          id: "field-primary-category",
          order: 1,
          type: "radio",
          label: "Best-fit track",
          helpText: "Add or rename tracks in the field editor.",
          required: true,
          options: ["General"],
          logic: null,
          routing: { General: "general" },
          version: 1,
        },
      ],
      publishedVersion: null,
    };
    setForms([primary]);
    setSelectedId(primary.id);
  };

  const createAdditional = () => {
    let suffix = forms.length + 1;
    while (forms.some((form) => form.id === `form-additional-${suffix}`)) suffix += 1;
    const id = `form-additional-${suffix}`;
    const additional: FormDetail = {
      id,
      eventId: fixture.eventId,
      purpose: "additional",
      name: "Additional organizer form",
      description: null,
      status: "draft",
      opensAt: null,
      closesAt: null,
      version: 1,
      createdAt: FORMS_FIXTURE_NOW + suffix * 60_000,
      updatedAt: FORMS_FIXTURE_NOW + suffix * 60_000,
      fields: [{
        id: `${id}-field-1`,
        order: 1,
        type: "text",
        label: "New question",
        helpText: null,
        required: false,
        options: [],
        logic: null,
        routing: {},
        version: 1,
      }],
      publishedVersion: null,
    };
    setForms((current) => [...current, additional]);
    setSelectedId(id);
  };

  const saveDraft = (draft: FormDetail) => {
    const saved = {
      ...draft,
      version: draft.version + 1,
      updatedAt: draft.updatedAt + 1,
      fields: draft.fields.map((field) => ({ ...field, version: field.version + 1 })),
    };
    replaceForm(saved);
    toast("Draft saved", { tone: "success" });
  };

  const publish = (draft: FormDetail) => {
    const versionNumber = (draft.publishedVersion?.versionNumber ?? 0) + 1;
    const versionId = `${draft.id}-version-${versionNumber}`;
    const fields: readonly FormVersionField[] = draft.fields.map((field: FormField) => ({
      id: `${versionId}-${field.id}`,
      sourceFieldId: field.id,
      order: field.order,
      type: field.type,
      label: field.label,
      helpText: field.helpText,
      required: field.required,
      options: [...field.options],
      logic: field.logic ? structuredClone(field.logic) : null,
      routing: { ...field.routing },
    }));
    replaceForm({
      ...draft,
      status: "open",
      version: draft.version + 1,
      updatedAt: FORMS_FIXTURE_NOW + versionNumber * 3_600_000,
      publishedVersion: {
        id: versionId,
        versionNumber,
        name: draft.name,
        description: draft.description,
        publishedAt: FORMS_FIXTURE_NOW + versionNumber * 3_600_000,
        retiredAt: null,
        fields,
      },
    });
    toast(`Published immutable version ${versionNumber}`, { tone: "success" });
  };

  const changeStatus = (status: "open" | "closed") => {
    if (!selected) return;
    replaceForm({ ...selected, status, version: selected.version + 1, updatedAt: selected.updatedAt + 1 });
    toast(status === "open" ? "Form reopened" : "Form closed", {
      tone: status === "open" ? "success" : "warning",
    });
  };

  if (state === "loading") {
    return (
      <div aria-busy="true" aria-label="Loading forms" className="space-y-5">
        <Skeleton className="h-20" />
        <div className="grid gap-5 lg:grid-cols-[15rem_minmax(0,1fr)]">
          <Skeleton className="h-72" />
          <Skeleton className="h-[36rem]" />
        </div>
      </div>
    );
  }

  if (state === "error") {
    return (
      <Card>
        <EmptyState
          title="Forms could not be loaded"
          description="Your saved forms were not changed. Retry after the event connection is restored."
          action={<Button onClick={() => globalThis.location.reload()}>Retry</Button>}
        />
      </Card>
    );
  }

  return (
    <>
      <PageHeader
        title="CFP & forms"
        description="Build routed proposal forms, publish immutable versions, and control response windows."
        actions={
          <div className="min-w-44">
            <Select
              label="Deterministic view"
              value={scenarioId}
              onChange={(event) => chooseScenario(event.currentTarget.value)}
            >
              {formsFixtures.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>{candidate.label}</option>
              ))}
            </Select>
          </div>
        }
      />

      {forms.length === 0 ? (
        <Card>
          <EmptyState
            title="Create your primary CFP"
            description="Start with at least one track or category option. You can add logistics and follow-up forms later."
            action={<Button onClick={createPrimary}>Create primary CFP</Button>}
          />
        </Card>
      ) : (
        <div className="grid min-w-0 gap-5 xl:grid-cols-[15rem_minmax(0,1fr)_22rem]">
          <aside className="min-w-0 space-y-4" aria-label="Event forms">
            <Card
              title="Forms"
              footer={<Button className="w-full" size="sm" variant="secondary" onClick={createAdditional}>New additional form</Button>}
            >
              <div className="space-y-2">
                {forms.map((form) => {
                  const active = form.id === selectedId;
                  return (
                    <Button
                      key={form.id}
                      variant={active ? "secondary" : "ghost"}
                      aria-current={active ? "page" : undefined}
                      onClick={() => setSelectedId(form.id)}
                      className={`h-auto w-full flex-col items-stretch whitespace-normal px-3 py-2.5 text-left ${
                        active ? "border-accent bg-accent-soft" : ""
                      }`}
                    >
                      <span className="block truncate text-sm font-medium text-ink">{form.name}</span>
                      <span className="mt-1 flex flex-wrap items-center gap-1.5">
                        <Badge tone={form.status === "open" ? "success" : form.status === "closed" ? "warning" : "neutral"}>
                          {form.status}
                        </Badge>
                        <span className="text-xs text-ink-faint">
                          {form.purpose === "primary-cfp" ? "Primary CFP" : "Additional"}
                        </span>
                      </span>
                    </Button>
                  );
                })}
              </div>
            </Card>
            <Card title="Lifecycle">
              <dl className="space-y-3 text-sm">
                <div className="flex items-center justify-between gap-3">
                  <dt className="text-ink-faint">Open</dt>
                  <dd className="font-medium text-ink">{forms.filter((form) => form.status === "open").length}</dd>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <dt className="text-ink-faint">Draft</dt>
                  <dd className="font-medium text-ink">{forms.filter((form) => form.status === "draft").length}</dd>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <dt className="text-ink-faint">Published versions</dt>
                  <dd className="font-medium text-ink">{forms.reduce((total, form) => total + (form.publishedVersion ? 1 : 0), 0)}</dd>
                </div>
              </dl>
            </Card>
          </aside>

          {selected ? (
            <main className="min-w-0">
              <FormBuilder
                form={selected}
                onChange={replaceForm}
                onSave={saveDraft}
                onPublish={publish}
                onStatusChange={changeStatus}
              />
            </main>
          ) : (
            <Card><EmptyState title="Choose a form" description="Select a form to edit its draft." /></Card>
          )}

          <aside className="min-w-0 xl:sticky xl:top-4 xl:self-start" aria-label="Live mobile preview">
            {selected && <FormPreview form={selected} />}
          </aside>
        </div>
      )}
      <Toaster />
    </>
  );
}

export default function FormsPage() {
  const { eventSlug = "" } = useParams();
  return <FormsWorkbench fixture={routedFormsFixture} state={eventSlug ? "ready" : "error"} />;
}
