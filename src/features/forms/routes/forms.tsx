import { useCallback, useEffect, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router";
import { Schema } from "effect";
import { ApiError, apiFetch } from "@/client/api";
import { loginPathForLocation } from "@/client/return-to";
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
  Button,
  Card,
  EmptyState,
  PageHeader,
  Skeleton,
  Toaster,
  toast,
} from "@/ui";
import { FormBuilder } from "../components/FormBuilder";
import { FormPreview } from "../components/FormPreview";
import {
  FormDetail,
  FormList,
  type FormFieldDraft,
  type FormPurpose,
  type FormStatus,
  type FormSummary,
} from "../schema";

export const path = "/e/:eventSlug/forms";

export interface EventIdentity {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
}

const EventIdentitySchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  slug: Schema.String,
});

/** Resolves the event slug in the URL to its authoritative event id. */
export function fetchEventIdentity(eventSlug: string): Promise<EventIdentity> {
  return apiFetch<EventIdentity>(`/api/v1/events/${encodeURIComponent(eventSlug)}`, { schema: EventIdentitySchema });
}

/** Lists organizer-visible forms for the event, ordered as the API returns them. */
export function fetchFormSummaries(eventId: string): Promise<readonly FormSummary[]> {
  return apiFetch<readonly FormSummary[]>(`/api/v1/events/${encodeURIComponent(eventId)}/forms`, { schema: FormList });
}

/** Loads the full draft + latest published snapshot for one form. */
export function fetchFormDetail(eventId: string, formId: string): Promise<FormDetail> {
  return apiFetch<FormDetail>(`/api/v1/events/${encodeURIComponent(eventId)}/forms/${encodeURIComponent(formId)}`, {
    schema: FormDetail,
  });
}

const mutationKey = (operation: string): string => `${operation}-${crypto.randomUUID()}`;

const primaryCfpFields: readonly FormFieldDraft[] = [
  {
    type: "text",
    label: "Session title",
    semanticKey: "submissionTitle",
    helpText: "A concise title for the proposed session.",
    required: true,
    options: [],
    logic: null,
    routing: {},
  },
  {
    type: "textarea",
    label: "Session abstract",
    semanticKey: "submissionAbstract",
    helpText: "Describe what attendees will learn.",
    required: true,
    options: [],
    logic: null,
    routing: {},
  },
  {
    type: "text",
    label: "Speaker name",
    semanticKey: "speakerName",
    helpText: null,
    required: true,
    options: [],
    logic: null,
    routing: {},
  },
  {
    type: "email",
    label: "Speaker email",
    semanticKey: "speakerEmail",
    helpText: "Used for proposal updates and speaker onboarding.",
    required: true,
    options: [],
    logic: null,
    routing: {},
  },
  {
    type: "radio",
    label: "Best-fit track",
    semanticKey: null,
    helpText: null,
    required: true,
    options: ["General"],
    logic: null,
    routing: { General: "general" },
  },
];

const additionalFormFields: readonly FormFieldDraft[] = [
  {
    type: "text",
    label: "Response",
    semanticKey: null,
    helpText: null,
    required: true,
    options: [],
    logic: null,
    routing: {},
  },
];

const draftFields = (form: FormDetail): readonly FormFieldDraft[] => form.fields.map((field) => ({
  id: field.id,
  type: field.type,
  label: field.label,
  semanticKey: field.semanticKey,
  helpText: field.helpText,
  required: field.required,
  options: field.options,
  logic: field.logic,
  routing: field.routing,
}));

async function mutationResponse(response: Response): Promise<FormDetail> {
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message = payload && typeof payload === "object" && "message" in payload && typeof payload.message === "string"
      ? payload.message
      : `Form request failed with status ${response.status}`;
    throw new ApiError(response.status, message);
  }
  return Schema.decodeUnknownSync(FormDetail)(payload);
}

/** Creates a useful draft through the registered forms.create REST operation. */
export async function createFormDraft(
  eventId: string,
  purpose: FormPurpose,
  idempotencyKey: string,
): Promise<FormDetail> {
  const response = await fetch(`/api/v1/events/${encodeURIComponent(eventId)}/forms`, {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": idempotencyKey,
    },
    body: JSON.stringify({
      purpose,
      name: purpose === "primary-cfp" ? "Call for proposals" : "Additional form",
      description: purpose === "primary-cfp" ? "Tell us about the session you would like to present." : null,
      opensAt: null,
      closesAt: null,
      fields: purpose === "primary-cfp" ? primaryCfpFields : additionalFormFields,
    }),
  });
  return mutationResponse(response);
}

/** Replaces the editable draft through forms.update, preserving field identities. */
export async function updateFormDraft(
  eventId: string,
  form: FormDetail,
  idempotencyKey: string,
): Promise<FormDetail> {
  const response = await fetch(
    `/api/v1/events/${encodeURIComponent(eventId)}/forms/${encodeURIComponent(form.id)}`,
    {
      method: "PUT",
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": idempotencyKey,
        "If-Match": String(form.version),
      },
      body: JSON.stringify({
        name: form.name,
        description: form.description,
        opensAt: form.opensAt,
        closesAt: form.closesAt,
        fields: draftFields(form),
      }),
    },
  );
  return mutationResponse(response);
}

/** Publishes the current server draft as an immutable version through forms.publish. */
export async function publishFormDraft(
  eventId: string,
  formId: string,
  expectedVersion: number,
  idempotencyKey: string,
): Promise<FormDetail> {
  const response = await fetch(
    `/api/v1/events/${encodeURIComponent(eventId)}/forms/${encodeURIComponent(formId)}/publish`,
    {
      method: "POST",
      credentials: "include",
      headers: {
        "Idempotency-Key": idempotencyKey,
        "If-Match": String(expectedVersion),
      },
    },
  );
  return mutationResponse(response);
}

/** Opens or closes a published form through forms.setStatus. */
export async function setFormLifecycle(
  eventId: string,
  formId: string,
  expectedVersion: number,
  status: Extract<FormStatus, "open" | "closed">,
  idempotencyKey: string,
): Promise<FormDetail> {
  const response = await fetch(
    `/api/v1/events/${encodeURIComponent(eventId)}/forms/${encodeURIComponent(formId)}/status`,
    {
      method: "POST",
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": idempotencyKey,
        "If-Match": String(expectedVersion),
      },
      body: JSON.stringify({ status }),
    },
  );
  return mutationResponse(response);
}

const toSummary = (form: FormDetail): FormSummary => ({
  id: form.id,
  eventId: form.eventId,
  purpose: form.purpose,
  name: form.name,
  description: form.description,
  status: form.status,
  opensAt: form.opensAt,
  closesAt: form.closesAt,
  version: form.version,
  publishedVersionNumber: form.publishedVersion?.versionNumber ?? null,
  updatedAt: form.updatedAt,
});

type MutationState = Readonly<{
  action: "create" | "save" | "publish" | "status" | null;
  tone: "neutral" | "success" | "danger";
  message: string | null;
}>;

function LoadingRegion({ label }: { readonly label: string }) {
  return (
    <>
      <div role="status" aria-live="polite" aria-label={label}>
        <span className="sr-only">{label}</span>
        <div className="space-y-5">
          <Skeleton className="h-20 motion-reduce:animate-none" />
          <div className="grid gap-5 lg:grid-cols-[15rem_minmax(0,1fr)]">
            <Skeleton className="h-72 motion-reduce:animate-none" />
            <Skeleton className="h-[36rem] motion-reduce:animate-none" />
          </div>
        </div>
      </div>
      <Toaster />
    </>
  );
}

export interface FormsPageProps {
  /** Seeds the initial render for tests; production always starts from `undefined` (loading). */
  readonly initialEvent?: EventIdentity | null;
  readonly initialEventError?: string | null;
}

export default function FormsPage({ initialEvent, initialEventError = null }: FormsPageProps) {
  const location = useLocation();
  const navigate = useNavigate();
  const { eventSlug = "" } = useParams();
  const [event, setEvent] = useState<EventIdentity | null | undefined>(initialEvent);
  const [eventError, setEventError] = useState<string | null>(initialEventError);
  const [eventRequest, setEventRequest] = useState(0);

  const handleUnauthenticated = useCallback(() => {
    setEventError("unauthenticated");
    setEvent(null);
  }, []);

  useEffect(() => {
    let active = true;
    setEvent(undefined);
    setEventError(null);
    void fetchEventIdentity(eventSlug)
      .then((loaded) => {
        if (active) {
          setEventError(null);
          setEvent(loaded);
        }
      })
      .catch((error) => {
        if (!active) return;
        const unauthorized = error instanceof ApiError && error.status === 401;
        const notFound = error instanceof ApiError && error.status === 404;
        const message = error instanceof Error ? error.message : "Could not load event";
        setEventError(notFound ? null : unauthorized ? "unauthenticated" : message);
        setEvent(null);
        if (!notFound && !unauthorized) toast(message, { tone: "danger" });
      });
    return () => {
      active = false;
    };
  }, [eventRequest, eventSlug]);

  if (event === undefined) {
    return <LoadingRegion label="Loading event forms" />;
  }

  if (event === null) {
    if (eventError === "unauthenticated") {
      return (
        <>
          <EmptyState
            title="Sign in to view this event"
            description="Sign in to continue to this event's forms."
            action={
              <Button className="min-h-11" onClick={() => navigate(loginPathForLocation(location))}>
                Sign in
              </Button>
            }
          />
          <Toaster />
        </>
      );
    }

    const recoverable = eventError !== null;
    return (
      <>
        <EmptyState
          title={recoverable ? "Could not load event" : "Event not found"}
          description={eventError ?? "The event may have moved or been removed."}
          action={
            recoverable ? (
              <Button className="min-h-11" onClick={() => setEventRequest((request) => request + 1)}>
                Try again
              </Button>
            ) : undefined
          }
        />
        <Toaster />
      </>
    );
  }

  return <FormsWorkspace key={event.id} event={event} onUnauthenticated={handleUnauthenticated} />;
}

export interface FormsWorkspaceProps {
  readonly event: EventIdentity;
  /** Seeds the initial render for tests; production always starts from `undefined` (loading). */
  readonly initialSummaries?: readonly FormSummary[] | null;
  readonly initialSelectedId?: string | null;
  readonly initialSelectedForm?: FormDetail | null;
  /** Lets the route promote a nested API 401 to its sign-in state. */
  readonly onUnauthenticated?: () => void;
}

export function FormsWorkspace({
  event,
  initialSummaries,
  initialSelectedId = null,
  initialSelectedForm,
  onUnauthenticated,
}: FormsWorkspaceProps) {
  const [summaries, setSummaries] = useState<readonly FormSummary[] | null | undefined>(initialSummaries);
  const [listError, setListError] = useState<string | null>(null);
  const [listRequest, setListRequest] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(initialSelectedId);
  const [selectedForm, setSelectedForm] = useState<FormDetail | null | undefined>(initialSelectedForm);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [mutation, setMutation] = useState<MutationState>({ action: null, tone: "neutral", message: null });

  const applyDetail = useCallback((form: FormDetail) => {
    setSelectedId(form.id);
    setSelectedForm(form);
    setSummaries((current) => {
      const summary = toSummary(form);
      if (!current) return [summary];
      return current.some((item) => item.id === form.id)
        ? current.map((item) => item.id === form.id ? summary : item)
        : [...current, summary];
    });
  }, []);

  const failMutation = useCallback((error: unknown, fallback: string) => {
    if (error instanceof ApiError && error.status === 401 && onUnauthenticated) {
      onUnauthenticated();
      return;
    }
    const message = error instanceof Error ? error.message : fallback;
    setMutation({ action: null, tone: "danger", message });
    toast(message, { tone: "danger" });
  }, [onUnauthenticated]);

  const handleCreate = async () => {
    const purpose: FormPurpose = summaries?.some((form) => form.purpose === "primary-cfp")
      ? "additional"
      : "primary-cfp";
    setMutation({ action: "create", tone: "neutral", message: purpose === "primary-cfp" ? "Creating primary CFP…" : "Creating form…" });
    try {
      const created = await createFormDraft(event.id, purpose, mutationKey("forms-create"));
      applyDetail(created);
      const message = purpose === "primary-cfp" ? "Primary CFP draft created." : "Additional form draft created.";
      setMutation({ action: null, tone: "success", message });
      toast(message, { tone: "success" });
    } catch (error) {
      failMutation(error, "Could not create form");
    }
  };

  const handleSave = async (draft: FormDetail) => {
    setMutation({ action: "save", tone: "neutral", message: "Saving draft…" });
    try {
      const saved = await updateFormDraft(event.id, draft, mutationKey("forms-update"));
      applyDetail(saved);
      setMutation({ action: null, tone: "success", message: "Draft saved." });
      toast("Draft saved.", { tone: "success" });
    } catch (error) {
      failMutation(error, "Could not save draft");
    }
  };

  const handlePublish = async (draft: FormDetail) => {
    setMutation({ action: "publish", tone: "neutral", message: "Saving and publishing form…" });
    try {
      const saved = await updateFormDraft(event.id, draft, mutationKey("forms-update-before-publish"));
      applyDetail(saved);
      const published = await publishFormDraft(event.id, saved.id, saved.version, mutationKey("forms-publish"));
      applyDetail(published);
      setMutation({ action: null, tone: "success", message: "Form published and open for submissions." });
      toast("Form published.", { tone: "success" });
    } catch (error) {
      failMutation(error, "Could not publish form");
    }
  };

  const handleStatus = async (
    status: Extract<FormStatus, "open" | "closed">,
    draft: FormDetail,
  ) => {
    setMutation({
      action: "status",
      tone: "neutral",
      message: status === "open" ? "Opening form…" : "Closing form…",
    });
    try {
      const saved = await updateFormDraft(event.id, draft, mutationKey("forms-update-before-status"));
      applyDetail(saved);
      const updated = await setFormLifecycle(event.id, saved.id, saved.version, status, mutationKey(`forms-${status}`));
      applyDetail(updated);
      const message = status === "open" ? "Form is open for submissions." : "Form closed.";
      setMutation({ action: null, tone: "success", message });
      toast(message, { tone: "success" });
    } catch (error) {
      failMutation(error, status === "open" ? "Could not open form" : "Could not close form");
    }
  };

  useEffect(() => {
    let active = true;
    setSummaries(undefined);
    setListError(null);
    void fetchFormSummaries(event.id)
      .then((loaded) => {
        if (!active) return;
        setSummaries(loaded);
        setSelectedId((current) =>
          current && loaded.some((form) => form.id === current) ? current : (loaded[0]?.id ?? null));
      })
      .catch((error) => {
        if (!active) return;
        if (error instanceof ApiError && error.status === 401 && onUnauthenticated) {
          onUnauthenticated();
          return;
        }
        const message = error instanceof Error ? error.message : "Could not load forms";
        setSummaries(null);
        setListError(message);
        toast(message, { tone: "danger" });
      });
    return () => {
      active = false;
    };
  }, [event.id, listRequest, onUnauthenticated]);

  useEffect(() => {
    if (!selectedId) {
      setSelectedForm(null);
      setDetailError(null);
      return;
    }
    let active = true;
    setSelectedForm(undefined);
    setDetailError(null);
    void fetchFormDetail(event.id, selectedId)
      .then((loaded) => {
        if (active) setSelectedForm(loaded);
      })
      .catch((error) => {
        if (!active) return;
        if (error instanceof ApiError && error.status === 401 && onUnauthenticated) {
          onUnauthenticated();
          return;
        }
        const message = error instanceof Error ? error.message : "Could not load form";
        setSelectedForm(null);
        setDetailError(message);
        toast(message, { tone: "danger" });
      });
    return () => {
      active = false;
    };
  }, [event.id, onUnauthenticated, selectedId]);

  if (summaries === undefined) {
    return <LoadingRegion label="Loading forms" />;
  }

  if (summaries === null) {
    return (
      <>
        <Card>
          <EmptyState
            title="Forms could not be loaded"
            description={listError ?? "Retry after the event connection is restored."}
            action={<Button onClick={() => setListRequest((request) => request + 1)}>Retry</Button>}
          />
        </Card>
        <Toaster />
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="CFP & forms"
        description="Build routed proposal forms, publish immutable versions, and control submission availability."
        actions={summaries.length > 0 ? (
          <Button loading={mutation.action === "create"} onClick={() => void handleCreate()}>
            {summaries.some((form) => form.purpose === "primary-cfp") ? "New additional form" : "Create primary CFP"}
          </Button>
        ) : undefined}
      />

      {mutation.message && (
        <Alert
          tone={mutation.tone}
          role={mutation.tone === "danger" ? "alert" : "status"}
          aria-live="polite"
          className="mb-5"
        >
          <AlertTitle>
            {mutation.action ? "Working" : mutation.tone === "success" ? "Completed" : "Form update failed"}
          </AlertTitle>
          <AlertDescription>{mutation.message}</AlertDescription>
        </Alert>
      )}

      {summaries.length === 0 ? (
        <Card>
          <EmptyState
            title="No forms yet"
            description="Create the primary CFP to start collecting routed proposals."
            action={
              <Button loading={mutation.action === "create"} onClick={() => void handleCreate()}>
                Create primary CFP
              </Button>
            }
          />
        </Card>
      ) : (
        <div className="grid min-w-0 gap-5 xl:grid-cols-[15rem_minmax(0,1fr)_22rem]">
          <aside className="min-w-0 space-y-4" aria-label="Event forms">
            <Card title="Forms">
              <div className="space-y-2">
                {summaries.map((form) => {
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
                  <dd className="font-medium text-ink">{summaries.filter((form) => form.status === "open").length}</dd>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <dt className="text-ink-faint">Draft</dt>
                  <dd className="font-medium text-ink">{summaries.filter((form) => form.status === "draft").length}</dd>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <dt className="text-ink-faint">Published versions</dt>
                  <dd className="font-medium text-ink">
                    {summaries.reduce((total, form) => total + (form.publishedVersionNumber ? 1 : 0), 0)}
                  </dd>
                </div>
              </dl>
            </Card>
          </aside>

          <section className="min-w-0" aria-label="Form editor">
            {selectedForm === undefined ? (
              <Skeleton className="h-[36rem] motion-reduce:animate-none" />
            ) : selectedForm === null ? (
              <Card>
                <EmptyState
                  title={detailError ? "Could not load form" : "Choose a form"}
                  description={detailError ?? "Select a form to view its draft."}
                />
              </Card>
            ) : (
              <FormBuilder
                key={`${selectedForm.id}:${selectedForm.version}`}
                form={selectedForm}
                busyAction={mutation.action}
                onChange={() => undefined}
                onSave={(draft) => void handleSave(draft)}
                onPublish={(draft) => void handlePublish(draft)}
                onStatusChange={(status, draft) => void handleStatus(status, draft)}
              />
            )}
          </section>

          <aside className="min-w-0 xl:sticky xl:top-4 xl:self-start" aria-label="Live mobile preview">
            {selectedForm && (
              <FormPreview
                key={`${selectedForm.id}:${selectedForm.version}`}
                form={selectedForm}
                now={Date.now()}
              />
            )}
          </aside>
        </div>
      )}
      <Toaster />
    </>
  );
}
