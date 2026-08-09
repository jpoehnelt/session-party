import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type MutableRefObject } from "react";
import { useParams } from "react-router";
import type { AnswerValue } from "contracts/types";
import { Schema } from "effect";
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Button,
  Card,
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
    return <main className="mx-auto max-w-2xl space-y-5 px-4 py-10"><Skeleton className="h-24" /><Skeleton className="h-[32rem]" /></main>;
  }
  if (form === null) {
    return (
      <main className="mx-auto max-w-2xl px-4 py-10">
        <EmptyState title="Submission form unavailable" description={loadError ?? "This form may have moved or been removed."} />
      </main>
    );
  }
  if (success) {
    return (
      <main className="mx-auto max-w-2xl px-4 py-10">
        <Card>
          <EmptyState
            title="Submission received"
            description={`Your proposal was saved successfully. Reference: ${success.submissionId}`}
          />
        </Card>
      </main>
    );
  }

  const accepting = form.form.availability === "open";
  const canSubmit = accepting && !!form.turnstileSiteKey && !!turnstileToken && !turnstileUnavailable;
  return (
    <main className="mx-auto max-w-2xl space-y-6 px-4 py-10">
      <header className="space-y-2">
        <p className="text-sm font-medium text-accent">{form.event.name}</p>
        <h1 className="text-3xl font-semibold tracking-tight text-ink">{form.form.name}</h1>
        {form.form.description && <p className="leading-relaxed text-ink-secondary">{form.form.description}</p>}
      </header>
      {!accepting && (
        <Alert tone="warning">
          <AlertTitle>{form.form.availability === "scheduled" ? "Submissions are not open yet" : "Submissions are closed"}</AlertTitle>
          <AlertDescription>
            {form.form.availability === "scheduled"
              ? "Review the published form below and return when submissions open."
              : "This published form is no longer accepting responses."}
          </AlertDescription>
        </Alert>
      )}
      <Card>
        <form className="space-y-6" onSubmit={handleSubmit}>
          {shownFields.map((field) => (
            <PublicField
              key={field.id}
              field={field}
              value={answers[field.id]}
              disabled={!accepting || submitting}
              onChange={(value) => setAnswers((current) => ({ ...current, [field.id]: value }))}
            />
          ))}
          {accepting && (
            <TurnstileChallenge
              siteKey={form.turnstileSiteKey ?? null}
              disabled={submitting}
              onToken={setTurnstileToken}
              onUnavailable={markTurnstileUnavailable}
              widgetIdRef={widgetId}
            />
          )}
          {submitError && (
            <Alert tone="danger">
              <AlertTitle>Submission not saved</AlertTitle>
              <AlertDescription>{submitError}</AlertDescription>
            </Alert>
          )}
          {accepting && <Button type="submit" disabled={submitting || !canSubmit}>{submitting ? "Submitting…" : "Submit proposal"}</Button>}
        </form>
      </Card>
    </main>
  );
}
