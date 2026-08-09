import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type MutableRefObject, type ReactNode } from "react";
import { Link, useParams } from "react-router";
import type { AnswerValue } from "contracts/types";
import { Schema } from "effect";
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Button,
  Checkbox,
  EmptyState,
  Input,
  Select,
  Skeleton,
  Textarea,
} from "@/ui";
import {
  CreatePublicSubmissionOutput,
  PublicSubmissionForm,
  type PublicFormField,
  type PublicSubmissionForm as PublicSubmissionFormValue,
} from "../schema";

export const path = "/submit/:eventSlug/:formId";
export const layout = "bare" as const;

export const draftStorageKey = (eventSlug: string, formId: string, versionId: string) =>
  `session-party:cfp-draft:${eventSlug}:${formId}:${versionId}`;

export async function fetchPublicSubmissionForm(
  eventSlug: string,
  formId: string,
): Promise<PublicSubmissionFormValue> {
  const response = await fetch(
    `/api/v1/public/events/${encodeURIComponent(eventSlug)}/forms/${encodeURIComponent(formId)}`,
  );
  if (!response.ok) {
    throw new Error(response.status === 404 ? "Submission form not found" : "Could not load submission form");
  }
  return Schema.decodeUnknownSync(PublicSubmissionForm)(await response.json());
}

export async function postPublicSubmission(
  eventSlug: string,
  formId: string,
  idempotencyKey: string,
  answers: Readonly<Record<string, AnswerValue>>,
  turnstileToken: string,
): Promise<typeof CreatePublicSubmissionOutput.Type> {
  const response = await fetch(
    `/api/v1/public/events/${encodeURIComponent(eventSlug)}/forms/${encodeURIComponent(formId)}/submissions`,
    {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": idempotencyKey,
    },
    body: JSON.stringify({
      answers: Object.entries(answers).map(([fieldId, value]) => ({ fieldId, value })),
      turnstileToken,
    }),
    },
  );
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message = payload && typeof payload === "object" && "message" in payload && typeof payload.message === "string"
      ? payload.message
      : "Could not submit this form";
    throw new Error(message);
  }
  return Schema.decodeUnknownSync(CreatePublicSubmissionOutput)(payload);
}

const conditionMatches = (
  condition: NonNullable<PublicFormField["logic"]>["conditions"][number],
  sourceType: PublicFormField["type"] | undefined,
  answer: AnswerValue | undefined,
): boolean => {
  /** An unchecked checkbox submits the literal "false"; it is an empty answer, not a present one. */
  const empty = answer === undefined
    || (Array.isArray(answer) && answer.length === 0)
    || (typeof answer === "string" && answer.trim().length === 0)
    || (sourceType === "checkbox" && answer === "false");
  if (condition.op === "not_empty") return !empty;
  if (condition.op === "in") {
    const values = Array.isArray(condition.value) ? condition.value : [condition.value ?? ""];
    return Array.isArray(answer)
      ? answer.some((value) => values.includes(value))
      : typeof answer === "string" && values.includes(answer);
  }
  const expected = Array.isArray(condition.value) ? condition.value[0] : condition.value;
  const equal = Array.isArray(answer) ? answer.includes(expected ?? "") : answer === expected;
  return condition.op === "eq" ? equal : !equal;
};

export function visibleFields(
  fields: readonly PublicFormField[],
  answers: Readonly<Record<string, AnswerValue>>,
): readonly PublicFormField[] {
  const visible: PublicFormField[] = [];
  const active: Record<string, AnswerValue> = {};
  const byId = new Map(fields.map((field) => [field.id, field]));
  for (const field of fields) {
    const matches = field.logic?.conditions.map((condition) =>
      conditionMatches(condition, byId.get(condition.fieldId)?.type, active[condition.fieldId]));
    const conditionsPass = field.logic === null
      ? true
      : field.logic.mode === "all" ? matches!.every(Boolean) : matches!.some(Boolean);
    const shown = field.logic?.action === "hide" ? !conditionsPass : conditionsPass;
    if (!shown) continue;
    visible.push(field);
    if (answers[field.id] !== undefined) active[field.id] = answers[field.id]!;
  }
  return visible;
}

export function PublicField({
  field,
  value,
  disabled,
  onChange,
}: {
  readonly field: PublicFormField;
  readonly value: AnswerValue | undefined;
  readonly disabled: boolean;
  readonly onChange: (value: AnswerValue) => void;
}) {
  const id = `public-submit-${field.id}`;
  if (field.type === "heading") return <h2 className="text-lg font-semibold text-ink">{field.label}</h2>;
  if (field.type === "html") {
    return <p className="text-sm leading-relaxed text-ink-secondary">{field.helpText ?? field.label}</p>;
  }
  if (field.type === "file") {
    return (
      <Alert tone="warning">
        <AlertTitle>{field.label}</AlertTitle>
        <AlertDescription>File answers require a verified upload flow and cannot be accepted on this public form yet.</AlertDescription>
      </Alert>
    );
  }
  if (field.type === "textarea") {
    return (
      <Textarea
        id={id}
        label={field.label}
        hint={field.helpText ?? undefined}
        required={field.required}
        disabled={disabled}
        value={typeof value === "string" ? value : ""}
        onChange={(event) => onChange(event.currentTarget.value)}
      />
    );
  }
  if (field.type === "select" || field.type === "radio") {
    return (
      <Select
        id={id}
        label={field.label}
        hint={field.helpText ?? undefined}
        required={field.required}
        disabled={disabled}
        value={typeof value === "string" ? value : ""}
        onChange={(event) => onChange(event.currentTarget.value)}
      >
        <option value="">Choose an option</option>
        {field.options.map((option) => <option key={option} value={option}>{option}</option>)}
      </Select>
    );
  }
  if (field.type === "multiselect") {
    return (
      <Select
        id={id}
        label={field.label}
        hint={field.helpText ?? undefined}
        required={field.required}
        disabled={disabled}
        multiple
        value={Array.isArray(value) ? [...value] : []}
        onChange={(event) => onChange(Array.from(event.currentTarget.selectedOptions, (option) => option.value))}
      >
        {field.options.map((option) => <option key={option} value={option}>{option}</option>)}
      </Select>
    );
  }
  if (field.type === "checkbox") {
    return (
      <Checkbox
        id={id}
        label={field.label}
        description={field.helpText ?? undefined}
        required={field.required}
        disabled={disabled}
        checked={value === "true"}
        onChange={(event) => onChange(event.currentTarget.checked ? "true" : "false")}
      />
    );
  }
  return (
    <Input
      id={id}
      type={field.type === "date" ? "date" : field.type === "email" ? "email" : field.type === "url" ? "url" : "text"}
      label={field.label}
      hint={field.helpText ?? undefined}
      required={field.required}
      disabled={disabled}
      value={typeof value === "string" ? value : ""}
      onChange={(event) => onChange(event.currentTarget.value)}
    />
  );
}

export interface PublicSubmitPageProps {
  readonly initialForm?: PublicSubmissionFormValue | null;
  readonly initialSuccess?: typeof CreatePublicSubmissionOutput.Type | null;
}

function PublicSubmitShell({ children }: { readonly children: ReactNode }) {
  return (
    <div className="production-grid min-h-dvh bg-canvas text-ink">
      <header className="border-b-2 border-line-strong bg-canvas">
        <div className="mx-auto flex h-18 max-w-6xl items-center justify-between gap-4 px-4 sm:px-6 lg:px-8">
          <Link className="inline-flex items-center gap-3 no-underline" to="/" aria-label="Session Party home">
            <span className="grid size-9 place-items-center border-2 border-line-strong bg-production-lime text-[11px] font-black tracking-[-0.04em] shadow-[3px_3px_0_#171714]">
              SP
            </span>
            <span className="text-sm font-black tracking-[-0.03em]">Session Party</span>
          </Link>
          <span className="border-2 border-line-strong bg-surface px-3 py-1.5 text-[10px] font-black uppercase tracking-[0.14em] shadow-[3px_3px_0_#171714]">
            Proposal desk
          </span>
        </div>
      </header>
      {children}
    </div>
  );
}

function LoadingPage() {
  return (
    <PublicSubmitShell>
      <main className="mx-auto grid max-w-6xl gap-8 px-4 py-10 sm:px-6 sm:py-16 lg:grid-cols-[minmax(0,0.78fr)_minmax(28rem,1.22fr)] lg:px-8">
        <Skeleton className="h-64" />
        <Skeleton className="h-[36rem]" />
      </main>
    </PublicSubmitShell>
  );
}

type TurnstileApi = {
  render: (container: HTMLElement, options: {
    readonly sitekey: string;
    readonly action: string;
    readonly callback: (token: string) => void;
    readonly "expired-callback": () => void;
    readonly "error-callback": () => void;
  }) => string;
  reset: (widgetId?: string) => void;
  remove: (widgetId: string) => void;
};

declare global {
  interface Window { turnstile?: TurnstileApi }
}

function TurnstileChallenge({
  siteKey,
  disabled,
  onToken,
  onUnavailable,
  widgetIdRef,
}: {
  readonly siteKey: string | null;
  readonly disabled: boolean;
  readonly onToken: (token: string | null) => void;
  readonly onUnavailable: () => void;
  readonly widgetIdRef: MutableRefObject<string | null>;
}) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!siteKey || !mountRef.current) return;
    let mounted = true;
    const render = () => {
      if (!mounted || !mountRef.current || !window.turnstile) return;
      widgetIdRef.current = window.turnstile.render(mountRef.current, {
        sitekey: siteKey,
        action: "cfp-submit",
        callback: (token) => onToken(token),
        "expired-callback": () => onToken(null),
        "error-callback": () => { onToken(null); onUnavailable(); },
      });
    };
    if (window.turnstile) render();
    else {
      const script = document.createElement("script");
      script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
      script.async = true;
      script.onload = render;
      script.onerror = onUnavailable;
      document.head.append(script);
    }
    return () => {
      mounted = false;
      if (widgetIdRef.current) window.turnstile?.remove(widgetIdRef.current);
      widgetIdRef.current = null;
    };
  }, [onToken, onUnavailable, siteKey, widgetIdRef]);
  if (!siteKey) {
    return <Alert tone="danger"><AlertTitle>Human verification unavailable</AlertTitle><AlertDescription>Please try again later.</AlertDescription></Alert>;
  }
  return <div aria-label="Human verification" aria-disabled={disabled} ref={mountRef} />;
}

export default function PublicSubmitPage({ initialForm, initialSuccess = null }: PublicSubmitPageProps) {
  const { eventSlug = "", formId = "" } = useParams();
  const [form, setForm] = useState<PublicSubmissionFormValue | null | undefined>(initialForm);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [answers, setAnswers] = useState<Record<string, AnswerValue>>({});
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [draftStatus, setDraftStatus] = useState<"restored" | "saved" | null>(null);
  const [success, setSuccess] = useState<typeof CreatePublicSubmissionOutput.Type | null>(initialSuccess);
  const idempotencyKey = useRef(crypto.randomUUID());
  const widgetId = useRef<string | null>(null);
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  const [turnstileUnavailable, setTurnstileUnavailable] = useState(false);
  const markTurnstileUnavailable = useCallback(() => setTurnstileUnavailable(true), []);

  useEffect(() => {
    if (initialForm !== undefined) return;
    let active = true;
    setForm(undefined);
    setLoadError(null);
    void fetchPublicSubmissionForm(eventSlug, formId).then(
      (loaded) => {
        if (active) setForm(loaded);
      },
      (error) => {
        if (!active) return;
        setLoadError(error instanceof Error ? error.message : "Could not load submission form");
        setForm(null);
      },
    );
    return () => {
      active = false;
    };
  }, [eventSlug, formId, initialForm]);

  useEffect(() => {
    if (!form) return;
    const key = draftStorageKey(eventSlug, formId, form.form.versionId);
    try {
      const raw = window.localStorage.getItem(key);
      if (!raw) return;
      const parsed = JSON.parse(raw) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
      const allowedIds = new Set(form.form.fields.map((field) => field.id));
      const restored: Record<string, AnswerValue> = {};
      for (const [fieldId, value] of Object.entries(parsed)) {
        const valid = typeof value === "string"
          || (Array.isArray(value) && value.every((item) => typeof item === "string"))
          || (value !== null && typeof value === "object" && "assetId" in value && typeof value.assetId === "string");
        if (allowedIds.has(fieldId) && valid) restored[fieldId] = value as AnswerValue;
      }
      if (Object.keys(restored).length > 0) {
        setAnswers(restored);
        setDraftStatus("restored");
      }
    } catch {
      window.localStorage.removeItem(key);
    }
  }, [eventSlug, form, formId]);

  const shownFields = useMemo(() => form ? visibleFields(form.form.fields, answers) : [], [answers, form]);

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!form || form.form.availability !== "open" || submitting || !turnstileToken) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const activeIds = new Set(shownFields.map((field) => field.id));
      const result = await postPublicSubmission(
        eventSlug,
        formId,
        idempotencyKey.current,
        Object.fromEntries(Object.entries(answers).filter(([fieldId]) => activeIds.has(fieldId))),
        turnstileToken,
      );
      window.localStorage.removeItem(draftStorageKey(eventSlug, formId, form.form.versionId));
      setSuccess(result);
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : "Could not submit this form");
      setTurnstileToken(null);
      if (widgetId.current) window.turnstile?.reset(widgetId.current);
    } finally {
      setSubmitting(false);
    }
  };

  if (form === undefined) {
    return <LoadingPage />;
  }
  if (form === null) {
    return (
      <PublicSubmitShell>
        <main className="mx-auto max-w-3xl px-4 py-12 sm:px-6 sm:py-20 lg:px-8">
          <div className="border-[3px] border-line-strong bg-surface p-2 shadow-[8px_8px_0_#171714]">
            <EmptyState title="Submission form unavailable" description={loadError ?? "This form may have moved or been removed."} />
          </div>
        </main>
      </PublicSubmitShell>
    );
  }
  if (success) {
    return (
      <PublicSubmitShell>
        <main className="mx-auto max-w-3xl px-4 py-12 sm:px-6 sm:py-20 lg:px-8">
          <section className="border-[3px] border-line-strong bg-surface shadow-[10px_10px_0_#171714]" aria-labelledby="submission-received-title">
            <div className="flex items-center justify-between gap-4 border-b-2 border-line-strong bg-ink px-5 py-3 text-on-accent">
              <span className="text-[10px] font-black uppercase tracking-[0.16em] text-white/65">Intake confirmation</span>
              <span className="size-3 bg-production-lime" aria-hidden="true" />
            </div>
            <div className="p-6 sm:p-10">
              <p className="inline-block border-2 border-line-strong bg-production-lime px-3 py-1.5 text-[10px] font-black uppercase tracking-[0.14em] shadow-[3px_3px_0_#171714]">
                Safely on the board
              </p>
              <h1 id="submission-received-title" className="mt-7 text-5xl font-black leading-[0.88] tracking-[-0.065em] sm:text-7xl">
                Submission received
              </h1>
              <p className="mt-6 max-w-xl text-base font-semibold leading-7 text-ink-secondary">
                Your proposal was saved successfully. Keep this reference for your records, then sign in with the same email to track its status and edit while the CFP remains open.
              </p>
              <div className="mt-8 border-2 border-line-strong bg-production-sky px-4 py-4">
                <p className="text-[10px] font-black uppercase tracking-[0.14em]">Submission reference</p>
                <p className="mt-1 break-all font-mono text-sm font-bold">{success.submissionId}</p>
              </div>
              <Link
                className="mt-7 inline-flex min-h-12 items-center justify-center border-2 border-line-strong bg-ink px-5 text-xs font-black uppercase tracking-[0.1em] text-on-accent shadow-[5px_5px_0_#7857ff] transition-transform hover:-translate-y-0.5"
                to={`/portal/events/${form.event.slug}/submissions`}
              >
                Manage your proposals →
              </Link>
            </div>
          </section>
        </main>
      </PublicSubmitShell>
    );
  }

  const accepting = form.form.availability === "open";
  const canSubmit = accepting && !!form.turnstileSiteKey && !!turnstileToken && !turnstileUnavailable;
  return (
    <PublicSubmitShell>
      <main className="mx-auto grid max-w-6xl items-start gap-10 px-4 py-10 sm:px-6 sm:py-16 lg:grid-cols-[minmax(0,0.78fr)_minmax(28rem,1.22fr)] lg:gap-14 lg:px-8">
        <header className="lg:sticky lg:top-8">
          <p className="inline-block -rotate-1 border-2 border-line-strong bg-production-coral px-3 py-2 text-[10px] font-black uppercase tracking-[0.15em] shadow-[4px_4px_0_#171714]">
            Call for speakers
          </p>
          <p className="mt-8 text-xs font-black uppercase tracking-[0.16em] text-accent">{form.event.name}</p>
          <h1 className="mt-3 text-5xl font-black leading-[0.88] tracking-[-0.065em] sm:text-7xl lg:text-[5.5rem]">
            {form.form.name}
          </h1>
          {form.form.description && (
            <p className="mt-6 max-w-xl border-l-[3px] border-line-strong pl-5 text-base font-semibold leading-7 text-ink-secondary">
              {form.form.description}
            </p>
          )}
          {form.form.closesAt !== null && (
            <div className="mt-6 max-w-md border-2 border-line-strong bg-production-yellow px-4 py-3 shadow-[4px_4px_0_#171714]">
              <p className="text-[9px] font-black uppercase tracking-[0.14em]">Deadline</p>
              <p className="mt-1 text-sm font-black">
                {new Intl.DateTimeFormat("en-US", {
                  dateStyle: "full",
                  timeStyle: "short",
                  timeZone: form.event.timezone,
                }).format(form.form.closesAt)} {form.event.timezone}
              </p>
            </div>
          )}
          <div className="mt-8 grid max-w-md grid-cols-2 border-2 border-line-strong bg-surface text-[10px] font-black uppercase tracking-[0.12em] shadow-[4px_4px_0_#171714]">
            <div className="border-r-2 border-line-strong px-3 py-3">Published form</div>
            <div className={`px-3 py-3 ${accepting ? "bg-production-lime" : "bg-production-yellow"}`}>
              {accepting ? "Intake open" : "View only"}
            </div>
          </div>
        </header>

        <section aria-label="Proposal form">
          {!accepting && (
            <Alert className="mb-5" tone="warning">
              <AlertTitle>{form.form.availability === "scheduled" ? "Submissions are not open yet" : "Submissions are closed"}</AlertTitle>
              <AlertDescription>
                {form.form.availability === "scheduled"
                  ? "Review the published form below and return when submissions open."
                  : "This published form is no longer accepting responses."}
              </AlertDescription>
            </Alert>
          )}
          {draftStatus && (
            <Alert className="mb-5" tone="success" role="status">
              <AlertTitle>{draftStatus === "restored" ? "Draft restored" : "Draft saved"}</AlertTitle>
              <AlertDescription>
                {draftStatus === "restored" ? "Your answers from this browser are ready to continue." : "Your answers are stored in this browser until you submit."}
              </AlertDescription>
            </Alert>
          )}
          <form className="border-[3px] border-line-strong bg-surface shadow-[10px_10px_0_#171714]" onSubmit={handleSubmit}>
            <div className="flex items-center justify-between gap-4 border-b-2 border-line-strong bg-ink px-5 py-3 text-on-accent">
              <div className="flex items-center gap-2">
                <span className={`size-2.5 ${accepting ? "bg-production-lime" : "bg-production-yellow"}`} aria-hidden="true" />
                <span className="text-[10px] font-black uppercase tracking-[0.16em]">Proposal intake</span>
              </div>
              <span className="text-[10px] font-black uppercase tracking-[0.12em] text-white/55">
                {shownFields.length} field{shownFields.length === 1 ? "" : "s"}
              </span>
            </div>
            <div className="divide-y-2 divide-line-strong">
              {shownFields.map((field, index) => (
                <div className={field.type === "heading" ? "bg-production-sky px-5 py-4" : "px-5 py-5 sm:px-6 sm:py-6"} key={field.id}>
                  <div className="mb-2 text-[9px] font-black uppercase tracking-[0.14em] text-ink-faint" aria-hidden="true">
                    {String(index + 1).padStart(2, "0")}
                  </div>
                  <PublicField
                    field={field}
                    value={answers[field.id]}
                    disabled={!accepting || submitting}
                    onChange={(value) => setAnswers((current) => ({ ...current, [field.id]: value }))}
                  />
                </div>
              ))}
            </div>
            {accepting && (
              <div className="border-t-2 border-line-strong bg-surface-muted px-5 py-5 sm:px-6">
                <p className="mb-3 text-[10px] font-black uppercase tracking-[0.12em] text-ink-secondary">Final check · human verification</p>
                <TurnstileChallenge
                  siteKey={form.turnstileSiteKey ?? null}
                  disabled={submitting}
                  onToken={setTurnstileToken}
                  onUnavailable={markTurnstileUnavailable}
                  widgetIdRef={widgetId}
                />
              </div>
            )}
            {submitError && (
              <div className="border-t-2 border-line-strong px-5 py-5 sm:px-6">
                <Alert tone="danger">
                  <AlertTitle>Submission not saved</AlertTitle>
                  <AlertDescription>{submitError}</AlertDescription>
                </Alert>
              </div>
            )}
            {accepting && (
              <div className="flex flex-col items-start justify-between gap-4 border-t-2 border-line-strong bg-production-lime px-5 py-5 sm:flex-row sm:items-center sm:px-6">
                <p className="max-w-xs text-xs font-bold leading-5 text-ink-secondary">Your answers are submitted together when verification is complete.</p>
                <div className="flex flex-wrap gap-3">
                  <Button
                    type="button"
                    variant="secondary"
                    disabled={submitting || Object.keys(answers).length === 0}
                    onClick={() => {
                      window.localStorage.setItem(
                        draftStorageKey(eventSlug, formId, form.form.versionId),
                        JSON.stringify(answers),
                      );
                      setDraftStatus("saved");
                    }}
                  >
                    Save draft
                  </Button>
                  <Button type="submit" disabled={submitting || !canSubmit}>{submitting ? "Submitting…" : "Submit proposal →"}</Button>
                </div>
              </div>
            )}
          </form>
        </section>
      </main>
    </PublicSubmitShell>
  );
}
