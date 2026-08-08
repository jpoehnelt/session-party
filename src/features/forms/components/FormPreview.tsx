import { useMemo, useState, type FormEvent } from "react";
import { Badge, Button, Card, Checkbox, Input, Select, Textarea } from "@/ui";
import type { FormDetail, FormField, FormVersionField, LogicCondition } from "../schema";

type Answer = string | readonly string[] | boolean;
type PreviewField = FormField | FormVersionField;

export interface FormPreviewProps {
  form: FormDetail;
}

const conditionMatches = (condition: LogicCondition, answer: Answer | undefined): boolean => {
  if (condition.op === "not_empty") {
    return Array.isArray(answer) ? answer.length > 0 : answer !== undefined && answer !== "" && answer !== false;
  }
  if (condition.op === "in") {
    const accepted = Array.isArray(condition.value) ? condition.value : [condition.value ?? ""];
    return Array.isArray(answer)
      ? answer.some((value) => accepted.includes(value))
      : typeof answer === "string" && accepted.includes(answer);
  }
  const expected = Array.isArray(condition.value) ? condition.value[0] : condition.value;
  const equal = Array.isArray(answer) ? answer.includes(expected ?? "") : answer === expected;
  return condition.op === "eq" ? equal : !equal;
};


export function FormPreview({ form }: FormPreviewProps) {
  const [answers, setAnswers] = useState<Record<string, Answer>>({});
  const [submitted, setSubmitted] = useState(false);
  const fields: readonly PreviewField[] = form.publishedVersion?.fields ?? form.fields;
  const visibleFields = useMemo(
    () => fields.filter((field) => {
      if (!field.logic) return true;
      const matches = field.logic.conditions.map((condition) =>
        conditionMatches(condition, answers[condition.fieldId]));
      const conditionsPass = field.logic.mode === "all" ? matches.every(Boolean) : matches.some(Boolean);
      return field.logic.action === "hide" ? !conditionsPass : conditionsPass;
    }),
    [answers, fields],
  );
  const available = form.status === "open" && form.publishedVersion !== null;

  const setAnswer = (fieldId: string, answer: Answer) => {
    setSubmitted(false);
    setAnswers((current) => ({ ...current, [fieldId]: answer }));
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (available) setSubmitted(true);
  };

  return (
    <div className="mx-auto w-full max-w-[24rem]" aria-label="Mobile form preview">
      <div className="overflow-hidden rounded-[2rem] border-[6px] border-ink bg-canvas shadow-card">
        <div className="mx-auto mt-2 h-1.5 w-16 rounded-full bg-ink-faint" aria-hidden="true" />
        <div className="max-h-[46rem] overflow-y-auto px-3 pb-4 pt-3 sm:px-4">
          <Card className="overflow-hidden">
            <div className="mb-5 border-b border-line pb-4">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                <span className="text-xs font-medium uppercase tracking-[0.12em] text-ink-faint">
                  Submission preview
                </span>
                <Badge tone={available ? "success" : form.status === "closed" ? "warning" : "neutral"}>
                  {available ? "Open for proposals" : form.status === "closed" ? "Closed" : "Draft preview"}
                </Badge>
              </div>
              <h2 className="text-xl font-semibold tracking-[-0.02em] text-ink">
                {form.publishedVersion?.name ?? form.name}
              </h2>
              {(form.publishedVersion?.description ?? form.description) && (
                <p className="mt-2 text-sm leading-relaxed text-ink-secondary">
                  {form.publishedVersion?.description ?? form.description}
                </p>
              )}
            </div>

            {!available && (
              <div className="mb-5 rounded-control border border-line bg-surface-muted px-3 py-2.5 text-sm text-ink-secondary" role="status">
                {form.status === "closed"
                  ? "This form is closed. Responses cannot be submitted."
                  : "This draft is visible to organizers only until it is published."}
              </div>
            )}

            <form className="space-y-5" onSubmit={handleSubmit}>
              {visibleFields.map((field) => {
                const fieldId = "sourceFieldId" in field
                  ? field.sourceFieldId ?? field.id
                  : field.id;
                const inputId = `preview-${form.id}-${fieldId}`;
                const answer = answers[fieldId];
                const routedCategory = typeof answer === "string" ? field.routing[answer] : undefined;

                if (field.type === "heading") {
                  return <h3 key={field.id} className="border-t border-line pt-5 text-base font-semibold text-ink">{field.label}</h3>;
                }
                if (field.type === "html") {
                  return (
                    <p key={field.id} className="text-sm leading-relaxed text-ink-secondary">
                      {field.label}
                    </p>
                  );
                }
                if (field.type === "textarea") {
                  return (
                    <Textarea
                      key={field.id}
                      id={inputId}
                      label={field.label}
                      hint={field.helpText ?? undefined}
                      required={field.required}
                      value={typeof answer === "string" ? answer : ""}
                      onChange={(event) => setAnswer(fieldId, event.currentTarget.value)}
                    />
                  );
                }
                if (field.type === "select") {
                  return (
                    <div key={field.id}>
                      <Select
                        id={inputId}
                        label={field.label}
                        hint={field.helpText ?? undefined}
                        required={field.required}
                        value={typeof answer === "string" ? answer : ""}
                        onChange={(event) => setAnswer(fieldId, event.currentTarget.value)}
                      >
                        <option value="">Choose an option</option>
                        {field.options.map((option) => <option key={option} value={option}>{option}</option>)}
                      </Select>
                      {routedCategory && <Badge className="mt-2" tone="accent">Routes to: {routedCategory}</Badge>}
                    </div>
                  );
                }
                if (field.type === "multiselect") {
                  return (
                    <Select
                      key={field.id}
                      id={inputId}
                      label={field.label}
                      hint={field.helpText ?? "Hold Command or Control to select more than one."}
                      required={field.required}
                      multiple
                      value={Array.isArray(answer) ? [...answer] : []}
                      onChange={(event) => setAnswer(
                        fieldId,
                        [...event.currentTarget.selectedOptions].map((option) => option.value),
                      )}
                    >
                      {field.options.map((option) => <option key={option} value={option}>{option}</option>)}
                    </Select>
                  );
                }
                if (field.type === "radio") {
                  return (
                    <fieldset key={field.id} className="space-y-2">
                      <legend className="text-sm font-medium text-ink">
                        {field.label}{field.required && <span aria-hidden="true"> *</span>}
                      </legend>
                      {field.helpText && <p className="text-xs leading-relaxed text-ink-faint">{field.helpText}</p>}
                      {field.options.map((option) => (
                        <label key={option} className="flex cursor-pointer items-start gap-2 rounded-control border border-line px-3 py-2 text-sm text-ink-secondary focus-within:border-accent focus-within:ring-2 focus-within:ring-accent/20">
                          <input
                            className="mt-0.5 size-4 accent-accent"
                            type="radio"
                            name={inputId}
                            value={option}
                            required={field.required}
                            checked={answer === option}
                            onChange={() => setAnswer(fieldId, option)}
                          />
                          <span>{option}</span>
                        </label>
                      ))}
                      {routedCategory && <Badge tone="accent">Routes to: {routedCategory}</Badge>}
                    </fieldset>
                  );
                }
                if (field.type === "checkbox") {
                  return (
                    <Checkbox
                      key={field.id}
                      id={inputId}
                      label={field.label}
                      description={field.helpText ?? undefined}
                      required={field.required}
                      checked={answer === true}
                      onChange={(event) => setAnswer(fieldId, event.currentTarget.checked)}
                    />
                  );
                }
                return (
                  <Input
                    key={field.id}
                    id={inputId}
                    type={field.type === "file" ? "file" : field.type}
                    label={field.label}
                    hint={field.helpText ?? undefined}
                    required={field.required}
                    value={field.type === "file" ? undefined : typeof answer === "string" ? answer : ""}
                    onChange={(event) => {
                      if (field.type !== "file") setAnswer(fieldId, event.currentTarget.value);
                    }}
                  />
                );
              })}
              <Button className="w-full" type="submit" disabled={!available}>
                Submit proposal
              </Button>
              <p className="text-center text-xs text-ink-faint">
                Required fields are marked with an asterisk.
              </p>
              <div className="min-h-5 text-center text-sm font-medium text-success" aria-live="polite">
                {submitted ? "Preview submission accepted." : ""}
              </div>
            </form>
          </Card>
        </div>
      </div>
    </div>
  );
}
