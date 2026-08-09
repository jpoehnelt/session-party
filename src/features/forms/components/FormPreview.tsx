import { useMemo } from "react";
import { effectTsResolver } from "@hookform/resolvers/effect-ts";
import { useForm, useWatch } from "react-hook-form";
import { Badge, Button, Card, Checkbox, Input, Select, Textarea } from "@/ui";
import {
  PreviewAnswers,
  getFormAvailability,
  projectActiveAnswers,
  type FormAvailability,
  type FormDetail,
  type PreviewField,
} from "../schema";

export interface FormPreviewProps {
  form: FormDetail;
  now: number;
}



export function FormPreview({ form, now }: FormPreviewProps) {
  const fields: readonly PreviewField[] = form.publishedVersion?.fields ?? form.fields;
  const {
    control,
    formState: { isSubmitSuccessful },
    handleSubmit,
    register,
    setValue,
  } = useForm<PreviewAnswers>({
    defaultValues: {},
    resolver: effectTsResolver(PreviewAnswers),
  });
  const answers = useWatch({ control }) as PreviewAnswers;
  const projection = useMemo(() => projectActiveAnswers(fields, answers), [answers, fields]);
  const availability = getFormAvailability(form, now);
  const available = availability === "open";
  const availabilityLabel: Record<FormAvailability, string> = {
    draft: "Draft preview",
    scheduled: "Scheduled to open",
    open: "Open for proposals",
    expired: "Submission window ended",
    closed: "Manually closed",
  };
  const unavailableMessage: Record<Exclude<FormAvailability, "open">, string> = {
    draft: "This draft is visible to organizers only until it is published.",
    scheduled: "This form is published and will open at its scheduled start time.",
    expired: "The scheduled submission window has ended.",
    closed: "An organizer manually closed this form.",
  };

  const submit = handleSubmit(() => undefined);

  return (
    <div className="mx-auto w-full max-w-sm" aria-label="Mobile form preview">
      <div className="overflow-hidden rounded-card border border-line bg-canvas shadow-card">
        <div className="max-h-screen overflow-y-auto px-3 pb-4 pt-3 sm:px-4">
          <Card className="overflow-hidden">
            <div className="mb-5 border-b border-line pb-4">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                <span className="text-xs font-medium uppercase tracking-[0.12em] text-ink-faint">
                  Submission preview
                </span>
                <Badge tone={
                  availability === "open"
                    ? "success"
                    : availability === "scheduled"
                      ? "accent"
                      : availability === "expired" || availability === "closed"
                        ? "warning"
                        : "neutral"
                }>
                  {availabilityLabel[availability]}
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
                {unavailableMessage[availability as Exclude<FormAvailability, "open">]}
              </div>
            )}

            <form className="space-y-5" onSubmit={submit}>
              {projection.visibleFields.map((field) => {
                const fieldId = "sourceFieldId" in field ? field.sourceFieldId ?? field.id : field.id;
                const inputId = `preview-${form.id}-${fieldId}`;
                const answer = projection.activeAnswers[fieldId];
                const routedCategory = typeof answer === "string" ? field.routing[answer] : undefined;
                const label = field.required ? `${field.label} *` : field.label;

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
                      label={label}
                      hint={field.helpText ?? undefined}
                      required={field.required}
                      {...register(fieldId, { required: field.required })}
                    />
                  );
                }
                if (field.type === "select") {
                  return (
                    <div key={field.id}>
                      <Select
                        id={inputId}
                        label={label}
                        hint={field.helpText ?? undefined}
                        required={field.required}
                        {...register(fieldId, { required: field.required })}
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
                      label={label}
                      hint={field.helpText ?? "Select one or more options."}
                      required={field.required}
                      multiple
                      {...register(fieldId, { required: field.required })}
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
                            value={option}
                            required={field.required}
                            {...register(fieldId, { required: field.required })}
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
                      label={label}
                      description={field.helpText ?? undefined}
                      required={field.required}
                      {...register(fieldId, { required: field.required })}
                    />
                  );
                }
                return (
                  <Input
                    key={field.id}
                    id={inputId}
                    type={field.type === "file" ? "file" : field.type}
                    label={label}
                    hint={field.helpText ?? undefined}
                    required={field.required}
                    {...(field.type === "file"
                      ? {
                          onChange: (event) => setValue(
                            fieldId,
                            event.currentTarget.files !== null && event.currentTarget.files.length > 0,
                            { shouldDirty: true, shouldValidate: true },
                          ),
                        }
                      : register(fieldId, { required: field.required }))}
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
                {isSubmitSuccessful ? "Preview submission accepted." : ""}
              </div>
            </form>
          </Card>
        </div>
      </div>
    </div>
  );
}
