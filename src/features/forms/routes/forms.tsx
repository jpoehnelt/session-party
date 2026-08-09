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
  Input,
  Modal,
  PageHeader,
  Skeleton,
  Textarea,
  Toaster,
  toast,
} from "@/ui";
import { FormBuilder } from "../components/FormBuilder";
import { FormPreview } from "../components/FormPreview";
import {
  FormDetail,
  DeleteFormOutput,
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
  details?: { readonly name: string; readonly description: string | null },
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
      name: details?.name ?? (purpose === "primary-cfp" ? "Call for proposals" : "Speaker follow-up"),
      description: details?.description ?? (purpose === "primary-cfp" ? "Tell us about the session you would like to present." : null),
      opensAt: null,
      closesAt: null,
      fields: purpose === "primary-cfp" ? primaryCfpFields : additionalFormFields,
    }),
  });
  return mutationResponse(response);
}

/** Deletes only an unpublished additional-form draft through forms.deleteDraft. */
export async function deleteFormDraft(
  eventId: string,
  formId: string,
  expectedVersion: number,
  idempotencyKey: string,
) {
  const response = await fetch(
    `/api/v1/events/${encodeURIComponent(eventId)}/forms/${encodeURIComponent(formId)}`,
    {
      method: "DELETE",
      credentials: "include",
      headers: {
        "Idempotency-Key": idempotencyKey,
        "If-Match": String(expectedVersion),
      },
    },
  );
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message = payload && typeof payload === "object" && "message" in payload && typeof payload.message === "string"
      ? payload.message
      : `Form request failed with status ${response.status}`;
    throw new ApiError(response.status, message);
  }
  return Schema.decodeUnknownSync(DeleteFormOutput)(payload);
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
  action: "create" | "delete" | "save" | "publish" | "status" | null;
  tone: "neutral" | "success" | "danger";
  message: string | null;
}>;

function LoadingRegion({ label }: { readonly label: string }) {
  return (
    <>
      <div className="border-2 border-[#171714] bg-[#f3efe3] p-5 shadow-[6px_6px_0_#171714]" role="status" aria-live="polite" aria-label={label}>
        <span className="sr-only">{label}</span>
        <div className="space-y-4">
          <div className="flex items-center justify-between border-2 border-[#171714] bg-[#171714] px-4 py-3 text-white">
            <span className="text-[10px] font-black uppercase tracking-[0.18em]">Loading production board</span>
            <span className="size-3 animate-pulse bg-[#caff4a] motion-reduce:animate-none" aria-hidden="true" />
          </div>
          <Skeleton className="h-24 rounded-none border-2 border-[#171714] motion-reduce:animate-none" />
          <div className="grid gap-4 lg:grid-cols-[15rem_minmax(0,1fr)]">
            <Skeleton className="h-72 rounded-none border-2 border-[#171714] motion-reduce:animate-none" />
            <Skeleton className="h-[36rem] rounded-none border-2 border-[#171714] motion-reduce:animate-none" />
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
          <Card className="rounded-none border-[3px] border-[#171714] bg-[#caff4a] shadow-[8px_8px_0_#171714]">
            <EmptyState
              title="Sign in to view this event"
              description="Sign in to continue to this event's forms."
              action={
                <Button className="min-h-11 rounded-none border-2 border-[#171714] bg-[#171714] font-black uppercase tracking-[0.08em] text-white shadow-[4px_4px_0_#7857ff]" onClick={() => navigate(loginPathForLocation(location))}>
                  Sign in
                </Button>
              }
            />
          </Card>
          <Toaster />
        </>
      );
    }

    const recoverable = eventError !== null;
    return (
      <>
        <Card className="rounded-none border-[3px] border-[#171714] bg-[#ff714f] shadow-[8px_8px_0_#171714]">
          <EmptyState
            title={recoverable ? "Could not load event" : "Event not found"}
            description={eventError ?? "The event may have moved or been removed."}
            action={
              recoverable ? (
                <Button className="min-h-11 rounded-none border-2 border-[#171714] bg-[#fffdf7] font-black uppercase tracking-[0.08em] text-[#171714] shadow-[4px_4px_0_#171714]" onClick={() => setEventRequest((request) => request + 1)}>
                  Try again
                </Button>
              ) : undefined
            }
          />
        </Card>
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
  const [createAdditionalOpen, setCreateAdditionalOpen] = useState(false);
  const [additionalName, setAdditionalName] = useState("");
  const [additionalDescription, setAdditionalDescription] = useState("");

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

  const handleCreate = async (
    purpose: FormPurpose,
    details?: { readonly name: string; readonly description: string | null },
  ) => {
    setMutation({ action: "create", tone: "neutral", message: purpose === "primary-cfp" ? "Creating primary CFP…" : "Creating form…" });
    try {
      const created = await createFormDraft(event.id, purpose, mutationKey("forms-create"), details);
      applyDetail(created);
      const message = purpose === "primary-cfp" ? "Primary CFP draft created." : "Additional form draft created.";
      setMutation({ action: null, tone: "success", message });
      if (purpose === "additional") {
        setCreateAdditionalOpen(false);
        setAdditionalName("");
        setAdditionalDescription("");
      }
      toast(message, { tone: "success" });
    } catch (error) {
      failMutation(error, "Could not create form");
    }
  };

  const handleDelete = async (draft: FormDetail) => {
    setMutation({ action: "delete", tone: "neutral", message: "Deleting draft…" });
    try {
      await deleteFormDraft(event.id, draft.id, draft.version, mutationKey("forms-delete-draft"));
      const remaining = (summaries ?? []).filter((form) => form.id !== draft.id);
      setSummaries(remaining);
      setSelectedId(remaining[0]?.id ?? null);
      setSelectedForm(null);
      setMutation({ action: null, tone: "success", message: "Unpublished draft deleted." });
      toast("Draft deleted.", { tone: "success" });
    } catch (error) {
      failMutation(error, "Could not delete draft");
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
        <Card className="rounded-none border-2 border-[#171714] bg-[#fffdf7] shadow-[6px_6px_0_#ff714f]">
          <EmptyState
            title="Forms could not be loaded"
            description={listError ?? "Retry after the event connection is restored."}
            action={<Button className="rounded-none border-2 border-[#171714] bg-[#ff714f] font-black uppercase tracking-[0.08em] text-[#171714] shadow-[4px_4px_0_#171714]" onClick={() => setListRequest((request) => request + 1)}>Retry</Button>}
          />
        </Card>
        <Toaster />
      </>
    );
  }

  return (
    <div className="relative -mx-4 -my-6 min-h-full overflow-hidden bg-[#f3efe3] px-4 py-6 text-[#171714] sm:-mx-6 sm:-my-8 sm:px-6 sm:py-8 lg:-mx-8 lg:-my-10 lg:px-8 lg:py-10">
      <div className="pointer-events-none absolute inset-0 opacity-25 [background-image:linear-gradient(#b9b1a1_1px,transparent_1px),linear-gradient(90deg,#b9b1a1_1px,transparent_1px)] [background-size:36px_36px]" aria-hidden="true" />
      <div className="relative">
      <PageHeader
        title="CFP & forms"
        description="Build routed proposal forms, publish immutable versions, and control submission availability."
        className="border-[3px] border-[#171714] bg-[#7857ff] p-5 text-white shadow-[7px_7px_0_#171714] sm:p-7 [&_h1]:text-4xl [&_h1]:font-black [&_h1]:uppercase [&_h1]:leading-none [&_h1]:tracking-[-0.055em] [&_h1]:text-white sm:[&_h1]:text-5xl [&_p]:mt-3 [&_p]:max-w-xl [&_p]:font-semibold [&_p]:text-white/80"
        actions={summaries.length > 0 ? (
          <Button
            className="min-h-11 rounded-none border-2 border-[#171714] bg-[#caff4a] px-5 text-xs font-black uppercase tracking-[0.1em] text-[#171714] shadow-[4px_4px_0_#171714] hover:bg-[#d7ff78]"
            loading={mutation.action === "create"}
            onClick={() => {
              if (summaries.some((form) => form.purpose === "primary-cfp")) {
                setCreateAdditionalOpen(true);
              } else {
                void handleCreate("primary-cfp");
              }
            }}
          >
            {summaries.some((form) => form.purpose === "primary-cfp") ? "New additional form" : "Create primary CFP"}
          </Button>
        ) : undefined}
      />

      <div className="-mt-3 mb-7 ml-3 grid max-w-2xl grid-cols-3 border-2 border-[#171714] bg-[#fffdf7] shadow-[4px_4px_0_#171714]" aria-label="Form lifecycle totals">
        {[
          ["Open", summaries.filter((form) => form.status === "open").length, "bg-[#caff4a]"],
          ["Draft", summaries.filter((form) => form.status === "draft").length, "bg-[#8fdcff]"],
          ["Versions", summaries.reduce((total, form) => total + (form.publishedVersionNumber ? 1 : 0), 0), "bg-[#ff714f]"],
        ].map(([label, value, color], index) => (
          <div className={`px-3 py-2.5 ${color} ${index > 0 ? "border-l-2 border-[#171714]" : ""}`} key={label}>
            <span className="block text-xl font-black leading-none tracking-[-0.04em] sm:text-2xl">{value}</span>
            <span className="mt-1 block text-[9px] font-black uppercase tracking-[0.13em]">{label}</span>
          </div>
        ))}
      </div>

      {mutation.message && (
        <Alert
          tone={mutation.tone}
          role={mutation.tone === "danger" ? "alert" : "status"}
          aria-live="polite"
          className="mb-5 rounded-none border-2 border-[#171714] bg-[#fffdf7] text-[#171714] shadow-[4px_4px_0_#171714]"
        >
          <AlertTitle>
            {mutation.action ? "Working" : mutation.tone === "success" ? "Completed" : "Form update failed"}
          </AlertTitle>
          <AlertDescription>{mutation.message}</AlertDescription>
        </Alert>
      )}

      {summaries.length === 0 ? (
        <Card className="rounded-none border-[3px] border-[#171714] bg-[#caff4a] shadow-[8px_8px_0_#171714]">
          <EmptyState
            title="No forms yet"
            description="Create the primary CFP to start collecting routed proposals."
            action={
              <Button
                className="rounded-none border-2 border-[#171714] bg-[#171714] font-black uppercase tracking-[0.08em] text-white shadow-[4px_4px_0_#7857ff]"
                loading={mutation.action === "create"}
                onClick={() => void handleCreate("primary-cfp")}
              >
                Create primary CFP
              </Button>
            }
          />
        </Card>
      ) : (
        <div className="grid min-w-0 gap-6 xl:grid-cols-[15rem_minmax(0,1fr)_22rem]">
          <aside className="min-w-0 space-y-4" aria-label="Event forms">
            <Card
              className="rounded-none border-2 border-[#171714] bg-[#fffdf7] shadow-[5px_5px_0_#171714] [&>header]:border-b-2 [&>header]:border-[#171714] [&>header]:bg-[#171714] [&>header]:text-white [&>header_h3]:font-black [&>header_h3]:uppercase [&>header_h3]:tracking-[0.12em] [&>header_h3]:text-white"
              title="Form queue"
            >
              <div className="space-y-3">
                {summaries.map((form) => {
                  const active = form.id === selectedId;
                  return (
                    <Button
                      key={form.id}
                      variant={active ? "secondary" : "ghost"}
                      aria-current={active ? "page" : undefined}
                      onClick={() => setSelectedId(form.id)}
                      className={`h-auto w-full flex-col items-stretch whitespace-normal rounded-none border-2 border-[#171714] px-3 py-3 text-left transition-transform hover:-translate-y-0.5 ${
                        active ? "bg-[#7857ff] text-white shadow-[3px_3px_0_#171714]" : "bg-[#f3efe3] hover:bg-[#caff4a]"
                      }`}
                    >
                      <span className={`block truncate text-sm font-black ${active ? "text-white" : "text-[#171714]"}`}>{form.name}</span>
                      <span className="mt-1 flex flex-wrap items-center gap-1.5">
                        <Badge className="rounded-none border-[#171714] bg-[#fffdf7] font-black uppercase text-[#171714]" tone={form.status === "open" ? "success" : form.status === "closed" ? "warning" : "neutral"}>
                          {form.status}
                        </Badge>
                        <span className={`text-[10px] font-bold uppercase tracking-[0.08em] ${active ? "text-white/75" : "text-[#665f52]"}`}>
                          {form.purpose === "primary-cfp" ? "Primary CFP" : "Additional"}
                        </span>
                      </span>
                    </Button>
                  );
                })}
              </div>
            </Card>
            <Card className="rounded-none border-2 border-[#171714] bg-[#8fdcff] shadow-[5px_5px_0_#171714] [&>header]:border-b-2 [&>header]:border-[#171714] [&>header_h3]:font-black [&>header_h3]:uppercase [&>header_h3]:tracking-[0.12em]" title="Lifecycle">
              <dl className="space-y-0 border-2 border-[#171714] bg-[#fffdf7] text-sm">
                <div className="flex items-center justify-between gap-3 px-3 py-2.5">
                  <dt className="font-bold uppercase tracking-[0.08em] text-[#665f52]">Open</dt>
                  <dd className="text-lg font-black text-[#171714]">{summaries.filter((form) => form.status === "open").length}</dd>
                </div>
                <div className="flex items-center justify-between gap-3 border-t-2 border-[#171714] px-3 py-2.5">
                  <dt className="font-bold uppercase tracking-[0.08em] text-[#665f52]">Draft</dt>
                  <dd className="text-lg font-black text-[#171714]">{summaries.filter((form) => form.status === "draft").length}</dd>
                </div>
                <div className="flex items-center justify-between gap-3 border-t-2 border-[#171714] px-3 py-2.5">
                  <dt className="font-bold uppercase tracking-[0.08em] text-[#665f52]">Published</dt>
                  <dd className="text-lg font-black text-[#171714]">
                    {summaries.reduce((total, form) => total + (form.publishedVersionNumber ? 1 : 0), 0)}
                  </dd>
                </div>
              </dl>
            </Card>
          </aside>

          <section className="min-w-0" aria-label="Form editor">
            {selectedForm === undefined ? (
              <Skeleton className="h-[36rem] rounded-none border-2 border-[#171714] motion-reduce:animate-none" />
            ) : selectedForm === null ? (
              <Card className="rounded-none border-2 border-[#171714] bg-[#fffdf7] shadow-[5px_5px_0_#ff714f]">
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
                onDelete={(draft) => void handleDelete(draft)}
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
      <Modal
        open={createAdditionalOpen}
        onClose={() => {
          if (mutation.action !== "create") setCreateAdditionalOpen(false);
        }}
        title="Create an additional form"
        footer={(
          <>
            <Button type="button" variant="secondary" onClick={() => setCreateAdditionalOpen(false)} disabled={mutation.action === "create"}>
              Cancel
            </Button>
            <Button
              type="submit"
              form="create-additional-form"
              loading={mutation.action === "create"}
              disabled={additionalName.trim().length === 0}
            >
              Create draft
            </Button>
          </>
        )}
      >
        <form
          id="create-additional-form"
          className="space-y-4"
          onSubmit={(event_) => {
            event_.preventDefault();
            const name = additionalName.trim();
            if (!name) return;
            void handleCreate("additional", {
              name,
              description: additionalDescription.trim() || null,
            });
          }}
        >
          <p className="text-sm leading-relaxed text-ink-secondary">
            Name the follow-up form before its draft is created. You can safely delete it until it is published or linked to onboarding.
          </p>
          <Input
            autoFocus
            label="Form name"
            required
            value={additionalName}
            onChange={(event_) => setAdditionalName(event_.currentTarget.value)}
          />
          <Textarea
            label="Description"
            value={additionalDescription}
            onChange={(event_) => setAdditionalDescription(event_.currentTarget.value)}
          />
        </form>
      </Modal>
      <Toaster />
      </div>
    </div>
  );
}
