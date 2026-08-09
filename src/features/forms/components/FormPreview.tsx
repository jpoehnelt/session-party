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

const PREVIEW_FIELD =
  "rounded-none border-2 border-[#171714] bg-[#fffdf7] shadow-none focus:border-[#7857ff] focus:ring-[#7857ff]/25";
const PREVIEW_BADGE =
  "rounded-none border-[#171714] bg-[#fffdf7] font-black uppercase tracking-[0.07em] text-[#171714]";

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
    <div className="relative mx-auto w-full max-w-sm py-5" aria-label="Mobile form preview">
      <div className="absolute inset-x-4 top-2 h-[94%] rotate-2 bg-[#7857ff]" aria-hidden="true" />
      <div className="absolute -right-1 top-0 z-20 rotate-3 border-2 border-[#171714] bg-[#caff4a] px-3 py-1.5 text-[9px] font-black uppercase tracking-[0.12em] shadow-[3px_3px_0_#171714]" aria-hidden="true">
        Live check
      </div>
      <div className="relative overflow-hidden border-[3px] border-[#171714] bg-[#171714] shadow-[7px_7px_0_#171714]">
        <div className="flex items-center justify-between border-b-2 border-[#171714] bg-[#171714] px-4 py-2.5 text-white">
          <div className="flex gap-1.5" aria-hidden="true">
            <span className="size-2 bg-[#ff714f]" />
            <span className="size-2 bg-[#ffd34e]" />
            <span className="size-2 bg-[#caff4a]" />
          </div>
          <span className="text-[9px] font-black uppercase tracking-[0.16em] text-white/60">Public form / mobile</span>
        </div>
        <div className="max-h-[calc(100dvh-8rem)] overflow-y-auto bg-[#ece8dc] px-3 pb-4 pt-3 sm:px-4">
          <Card className="overflow-hidden rounded-none border-2 border-[#171714] bg-[#fffdf7] shadow-none [&>div]:px-4 [&>div]:py-4">
            <div className="mb-5 border-b-2 border-[#171714] pb-4">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                <span className="text-[10px] font-black uppercase tracking-[0.14em] text-[#3e268f]">
                  Submission preview
                </span>
                <Badge className={PREVIEW_BADGE} tone={
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
              <h2 className="text-2xl font-black leading-tight tracking-[-0.045em] text-[#171714]">
                {form.publishedVersion?.name ?? form.name}
              </h2>
              {(form.publishedVersion?.description ?? form.description) && (
                <p className="mt-2 border-l-[3px] border-[#ff714f] pl-3 text-sm font-semibold leading-relaxed text-[#665f52]">
                  {form.publishedVersion?.description ?? form.description}
                </p>
              )}
            </div>

            {!available && (
              <div className="mb-5 border-2 border-[#171714] bg-[#ffd34e] px-3 py-2.5 text-sm font-semibold text-[#171714] shadow-[3px_3px_0_#171714]" role="status">
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
                  return <h3 key={field.id} className="border-t-[3px] border-[#171714] pt-5 text-lg font-black uppercase tracking-[-0.02em] text-[#171714]">{field.label}</h3>;
                }
                if (field.type === "html") {
                  return (
                    <p key={field.id} className="border-l-[3px] border-[#8fdcff] pl-3 text-sm font-semibold leading-relaxed text-[#665f52]">
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
                      className={PREVIEW_FIELD}
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
                        className={PREVIEW_FIELD}
                        required={field.required}
                        {...register(fieldId, { required: field.required })}
                      >
                        <option value="">Choose an option</option>
                        {field.options.map((option) => <option key={option} value={option}>{option}</option>)}
                      </Select>
                      {routedCategory && <Badge className={`${PREVIEW_BADGE} mt-2 bg-[#8fdcff]`} tone="accent">Routes to: {routedCategory}</Badge>}
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
                      className={PREVIEW_FIELD}
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
                      <legend className="text-sm font-black text-[#171714]">
                        {field.label}{field.required && <span aria-hidden="true"> *</span>}
                      </legend>
                      {field.helpText && <p className="text-xs font-semibold leading-relaxed text-[#665f52]">{field.helpText}</p>}
                      {field.options.map((option) => (
                        <label key={option} className="flex cursor-pointer items-start gap-2 border-2 border-[#171714] bg-[#fffdf7] px-3 py-2 text-sm font-semibold text-[#4f4a40] transition-colors hover:bg-[#caff4a] focus-within:bg-[#caff4a] focus-within:ring-2 focus-within:ring-[#7857ff]/30">
                          <input
                            className="mt-0.5 size-4 accent-[#7857ff]"
                            type="radio"
                            value={option}
                            required={field.required}
                            {...register(fieldId, { required: field.required })}
                          />
                          <span>{option}</span>
                        </label>
                      ))}
                      {routedCategory && <Badge className={`${PREVIEW_BADGE} bg-[#8fdcff]`} tone="accent">Routes to: {routedCategory}</Badge>}
                    </fieldset>
                  );
                }
                if (field.type === "checkbox") {
                  return (
                    <Checkbox
                      key={field.id}
                      className="border-2 border-[#171714] bg-[#fffdf7] p-3 [&_input]:rounded-none [&_input]:border-2 [&_input]:border-[#171714]"
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
                    className={PREVIEW_FIELD}
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
              <Button className="min-h-12 w-full rounded-none border-2 border-[#171714] bg-[#caff4a] text-xs font-black uppercase tracking-[0.1em] text-[#171714] shadow-[4px_4px_0_#171714] hover:bg-[#d7ff78]" type="submit" disabled={!available}>
                Submit proposal →
              </Button>
              <p className="text-center text-[10px] font-black uppercase tracking-[0.08em] text-[#665f52]">
                Required fields are marked with an asterisk.
              </p>
              <div className="min-h-5 text-center text-sm font-black text-[#198754]" aria-live="polite">
                {isSubmitSuccessful ? "Preview submission accepted." : ""}
              </div>
            </form>
          </Card>
        </div>
      </div>
    </div>
  );
}
