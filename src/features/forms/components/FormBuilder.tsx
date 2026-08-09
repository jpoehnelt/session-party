import { useEffect, useState } from "react";
import { effectTsResolver } from "@hookform/resolvers/effect-ts";
import { useFieldArray, useForm, useWatch } from "react-hook-form";
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
  Badge,
  Button,
  Card,
  Checkbox,
  Input,
  Select,
  Textarea,
} from "@/ui";
import {
  FORM_FIELD_OPTION_TYPES,
  FORM_FIELD_TYPES,
  FORM_SEMANTIC_KEYS,
  FormDetail,
  normalizeOptionDraft,
  updateConditionAt,
  validatePublishIntent,
  type ConditionalLogic,
  type FormField,
  type FormFieldType,
  type FormSemanticKey,
  type FormStatus,
  type PublishValidationIssue,
} from "../schema";

const FIELD_TYPE_LABELS: Record<FormFieldType, string> = {
  text: "Short text",
  textarea: "Long text",
  select: "Select",
  multiselect: "Multi-select",
  radio: "Radio group",
  checkbox: "Checkbox",
  email: "Email",
  url: "URL",
  file: "File upload (unavailable)",
  date: "Date",
  heading: "Section heading",
  html: "Guidance text",
};

const BUILDER_FIELD_TYPES: readonly FormFieldType[] = FORM_FIELD_TYPES.filter((type) => type !== "file");

const SEMANTIC_KEY_LABELS: Record<FormSemanticKey, string> = {
  submissionTitle: "Submission title",
  submissionAbstract: "Submission abstract",
  speakerName: "Speaker name",
  speakerEmail: "Speaker email",
};

const PRODUCTION_CARD =
  "rounded-none border-2 border-[#171714] bg-[#fffdf7] shadow-[5px_5px_0_#171714] [&>header]:border-b-2 [&>header]:border-[#171714] [&>header]:px-4 [&>header]:py-3 [&>header_h3]:font-black [&>header_h3]:uppercase [&>header_h3]:tracking-[0.08em] [&>div]:px-4 [&>div]:py-4";
const PRODUCTION_FIELD =
  "rounded-none border-2 border-[#171714] bg-[#fffdf7] shadow-none focus:border-[#7857ff] focus:ring-[#7857ff]/25";
const PRODUCTION_BADGE =
  "rounded-none border-[#171714] bg-[#fffdf7] font-black uppercase tracking-[0.08em] text-[#171714]";
const SECONDARY_BUTTON =
  "rounded-none border-2 border-[#171714] bg-[#fffdf7] font-black uppercase tracking-[0.06em] text-[#171714] shadow-[3px_3px_0_#171714] hover:bg-[#caff4a]";

const LOGIC_OPERATOR_LABELS: Record<string, string> = {
  eq: "equals",
  neq: "does not equal",
  in: "is one of",
  not_empty: "is not empty",
};

export interface FormBuilderProps {
  form: FormDetail;
  onChange: (form: FormDetail) => void;
  onSave: (form: FormDetail) => void;
  onPublish: (form: FormDetail) => void;
  onStatusChange: (status: Extract<FormStatus, "open" | "closed">, form: FormDetail) => void;
  onDelete?: (form: FormDetail) => void;
  /** False only when the surrounding client intentionally presents a read-only form. Defaults to true. */
  mutationsAvailable?: boolean;
  /** Disables every edit while one versioned mutation is in flight. */
  busyAction?: "create" | "delete" | "save" | "publish" | "status" | null;
}


interface OptionsEditorProps {
  readonly field: FormField;
  readonly error?: string;
  readonly onCommit: (options: readonly string[], routing: Readonly<Record<string, string>>) => void;
}

function OptionsEditor({ field, error, onCommit }: OptionsEditorProps) {
  return (
    <Textarea
      id={`builder-field-${field.id}-options`}
      label="Ordered options"
      hint="One option per line. Renaming options in place keeps their category routing."
      error={error}
      className={PRODUCTION_FIELD}
      rows={Math.max(3, field.options.length)}
      defaultValue={field.options.join("\n")}
      onBlur={(event) => {
        const normalized = normalizeOptionDraft(event.currentTarget.value, field.options, field.routing);
        onCommit(normalized.options, normalized.routing);
      }}
    />
  );
}

const toDateTimeLocal = (value: number | null): string => {
  if (value === null) return "";
  const date = new Date(value - new Date(value).getTimezoneOffset() * 60_000);
  return date.toISOString().slice(0, 16);
};

export function FormBuilder({
  form,
  onChange,
  onSave,
  onPublish,
  onStatusChange,
  onDelete,
  mutationsAvailable = true,
  busyAction = null,
}: FormBuilderProps) {
  const [message, setMessage] = useState<string | null>(null);
  const {
    control,
    clearErrors,
    formState: { errors },
    handleSubmit,
    register,
    setError,
    setValue,
    subscribe,
  } = useForm<typeof FormDetail.Encoded, unknown, FormDetail>({
    defaultValues: structuredClone(form),
    resolver: effectTsResolver(FormDetail),
    mode: "onChange",
  });
  const { fields: fieldRows, append, remove, replace } = useFieldArray({
    control,
    name: "fields",
    keyName: "formKey",
  });
  const watchedForm = useWatch({ control }) as FormDetail;
  const watchedFields = useWatch({ control, name: "fields" }) as readonly FormField[];

  useEffect(
    () => subscribe({
      formState: { values: true },
      callback: ({ values }) => onChange(values as FormDetail),
    }),
    [onChange, subscribe],
  );

  const clearFeedback = () => {
    setMessage(null);
    clearErrors();
  };

  const patchField = (index: number, patch: Partial<FormField>) => {
    const current = watchedFields[index];
    if (!current) return;
    setValue(`fields.${index}`, { ...current, ...patch }, {
      shouldDirty: true,
      shouldValidate: true,
    });
    clearFeedback();
  };

  const moveField = (fieldId: string, direction: -1 | 1) => {
    const index = watchedFields.findIndex((field) => field.id === fieldId);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= watchedFields.length) return;
    const fields = [...watchedFields];
    [fields[index], fields[target]] = [fields[target]!, fields[index]!];
    const positions = Object.fromEntries(fields.map((field, position) => [field.id, position]));
    const invalid = fields.find((field, position) =>
      field.logic?.conditions.some((condition) => {
        const sourcePosition = positions[condition.fieldId];
        return sourcePosition === undefined || sourcePosition >= position;
      }));
    if (invalid) {
      setMessage(`Move blocked: ${invalid.label || "this field"} must stay below every field it depends on.`);
      return;
    }
    replace(fields.map((field, order) => ({ ...field, order: order + 1 })));
    clearFeedback();
  };

  const addField = () => {
    let suffix = watchedFields.length + 1;
    while (watchedFields.some((field) => field.id === `${watchedForm.id}-field-${suffix}`)) suffix += 1;
    append({
      id: `${watchedForm.id}-field-${suffix}`,
      order: watchedFields.length + 1,
      type: "text",
      label: "New question",
      helpText: null,
      required: false,
      options: [],
      logic: null,
      routing: {},
      semanticKey: null,
      version: 1,
    });
    clearFeedback();
  };

  const removeField = (fieldId: string, index: number) => {
    const referenced = watchedFields.some((field) =>
      field.logic?.conditions.some((condition) => condition.fieldId === fieldId));
    if (referenced) {
      setMessage("Remove conditional rules that reference this field first.");
      return;
    }
    remove(index);
    const remaining = watchedFields
      .filter((field) => field.id !== fieldId)
      .map((field, order) => ({ ...field, order: order + 1 }));
    replace(remaining);
    clearFeedback();
  };

  const pathForIssue = (issue: PublishValidationIssue): Parameters<typeof setError>[0] => {
    if (issue.controlId === "builder-form-name") return "name";
    if (issue.controlId === "builder-closes-at") return "closesAt";
    const index = watchedFields.findIndex((field) =>
      issue.controlId.startsWith(`builder-field-${field.id}-`));
    if (index < 0) return "root.publish";
    if (issue.controlId.endsWith("-label")) return `fields.${index}.label`;
    if (issue.controlId.endsWith("-options")) return `fields.${index}.options`;
    if (issue.controlId.endsWith("-semantic-key")) return `fields.${index}.semanticKey`;
    if (issue.controlId.includes("-routing-")) return `fields.${index}.routing`;
    return `fields.${index}`;
  };

  const submit = handleSubmit((values, event) => {
    const submitter = (event?.nativeEvent as SubmitEvent | undefined)?.submitter as HTMLButtonElement | null;
    clearErrors();
    if (submitter?.value === "save") {
      setMessage(null);
      onSave(values);
      return;
    }
    const issues = validatePublishIntent(values);
    if (issues.length > 0) {
      setMessage(null);
      setError("root.publish", {
        type: "publish",
        message: issues.map((issue) => issue.message).join("\n"),
      });
      for (const issue of issues) {
        setError(pathForIssue(issue), { type: "publish", message: issue.message });
      }
      globalThis.setTimeout(() => globalThis.document?.getElementById(issues[0]!.controlId)?.focus(), 0);
      return;
    }
    setMessage(null);
    onPublish(values);
  });

  const routingFields = watchedFields.filter((field) => Object.keys(field.routing).length > 0);
  const conditionalFields = watchedFields.filter((field) => field.logic !== null);
  const fieldLabels = Object.fromEntries(watchedFields.map((field) => [field.id, field.label]));
  return (
    <form
      noValidate
      aria-busy={busyAction !== null}
      onSubmit={mutationsAvailable ? submit : (event) => event.preventDefault()}
    >
      <fieldset disabled={!mutationsAvailable || busyAction !== null} className="m-0 min-w-0 space-y-6 border-0 p-0">
      {!mutationsAvailable && (
        <div className="border-2 border-[#171714] bg-[#ffd34e] px-4 py-3 text-sm font-semibold text-[#171714] shadow-[4px_4px_0_#171714]" role="status">
          This form is read-only right now. This client can't yet send the idempotency headers organizer edits require.
        </div>
      )}
      {errors.root?.publish?.message && (
        <div className="border-2 border-[#171714] bg-[#ff714f] px-4 py-3 text-sm text-[#171714] shadow-[4px_4px_0_#171714]" role="alert">
          <h2 className="font-black uppercase tracking-[0.06em]">Fix these issues before publishing</h2>
          <ul className="mt-2 list-disc space-y-1 pl-5 font-semibold">
            {errors.root.publish.message.split("\n").map((issue) => <li key={issue}>{issue}</li>)}
          </ul>
        </div>
      )}
      <Card
        className={`${PRODUCTION_CARD} [&>header]:bg-[#caff4a]`}
        title={
          <span className="flex flex-wrap items-center justify-between gap-2">
            <span>Form settings</span>
            <Badge className={PRODUCTION_BADGE} tone={watchedForm.status === "open" ? "success" : watchedForm.status === "closed" ? "warning" : "neutral"}>
              {watchedForm.status === "open" ? "Open" : watchedForm.status === "closed" ? "Closed" : "Draft"}
            </Badge>
          </span>
        }
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <Input
              id="builder-form-name"
              label="Form name"
              required
              error={errors.name?.message}
              className={PRODUCTION_FIELD}
              {...register("name")}
            />
          </div>
          <div className="sm:col-span-2">
            <Textarea
              label="Description"
              hint="Shown at the top of the public form."
              className={PRODUCTION_FIELD}
              {...register("description", { setValueAs: (value) => value || null })}
            />
          </div>
          <Input
            id="builder-opens-at"
            type="datetime-local"
            label="Opens"
            className={PRODUCTION_FIELD}
            value={toDateTimeLocal(watchedForm.opensAt)}
            onChange={(event) => {
              setValue("opensAt", event.currentTarget.value ? new Date(event.currentTarget.value).getTime() : null, {
                shouldDirty: true,
                shouldValidate: true,
              });
              clearFeedback();
            }}
          />
          <Input
            id="builder-closes-at"
            type="datetime-local"
            label="Closes"
            error={errors.closesAt?.message}
            className={PRODUCTION_FIELD}
            value={toDateTimeLocal(watchedForm.closesAt)}
            onChange={(event) => {
              setValue("closesAt", event.currentTarget.value ? new Date(event.currentTarget.value).getTime() : null, {
                shouldDirty: true,
                shouldValidate: true,
              });
              clearFeedback();
            }}
          />
        </div>
      </Card>

      <Card
        className={`${PRODUCTION_CARD} [&>header]:bg-[#7857ff] [&>header_h3]:text-white`}
        title={
          <span className="flex flex-wrap items-center justify-between gap-2">
            <span>Proposal routing map</span>
            <Badge className={PRODUCTION_BADGE} tone="accent">
              {routingFields.length} {routingFields.length === 1 ? "router" : "routers"} · {conditionalFields.length} conditional
            </Badge>
          </span>
        }
      >
        {routingFields.length === 0 && conditionalFields.length === 0 ? (
          <div className="border-2 border-dashed border-[#171714] bg-[#f3efe3] px-4 py-5 text-sm font-semibold text-[#665f52]">
            Add category routing or a conditional rule to see how answers move through this form.
          </div>
        ) : (
          <div className="grid gap-5 lg:grid-cols-[minmax(0,1.25fr)_minmax(12rem,0.75fr)]">
            <div className="space-y-3">
              <p className="text-xs font-black uppercase tracking-[0.14em] text-[#7857ff]">
                Answer to review category
              </p>
              {routingFields.length === 0 ? (
                <p className="text-sm font-semibold text-[#665f52]">No track or category routing yet.</p>
              ) : routingFields.map((field) => (
                <section key={field.id} className="overflow-hidden border-2 border-[#171714] bg-[#f3efe3]">
                  <header className="flex flex-wrap items-center justify-between gap-2 border-b-2 border-[#171714] bg-[#8fdcff] px-3 py-2">
                    <h3 className="text-sm font-black text-[#171714]">{field.label}</h3>
                    <span className="text-[10px] font-black uppercase tracking-[0.08em] text-[#4f4a40]">{field.required ? "Required choice" : "Optional choice"}</span>
                  </header>
                  <ul className="divide-y divide-accent/15">
                    {field.options.map((option) => (
                      <li key={option} className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2 px-3 py-2 text-sm">
                        <span className="truncate font-semibold text-[#4f4a40]">{option}</span>
                        <span className="font-black text-[#7857ff]" aria-hidden="true">→</span>
                        <span className="truncate font-black text-[#171714]">{field.routing[option] || "Needs category"}</span>
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
            </div>
            <div className="border-t-2 border-[#171714] pt-4 lg:border-l-2 lg:border-t-0 lg:pl-5 lg:pt-0">
              <p className="text-xs font-black uppercase tracking-[0.14em] text-[#7857ff]">
                Conditional branches
              </p>
              {conditionalFields.length === 0 ? (
                <p className="mt-3 text-sm font-semibold text-[#665f52]">Every field is always shown.</p>
              ) : (
                <ol className="mt-3 space-y-3">
                  {conditionalFields.map((field) => (
                    <li key={field.id} className="border-2 border-[#171714] bg-[#f3efe3] px-3 py-2.5 shadow-[3px_3px_0_#171714]">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge className={PRODUCTION_BADGE} tone={field.logic?.action === "hide" ? "warning" : "accent"}>
                          {field.logic?.action === "hide" ? "Hide" : "Show"}
                        </Badge>
                        <span className="text-sm font-black text-[#171714]">{field.label}</span>
                      </div>
                      <div className="mt-1.5 space-y-1 text-xs font-semibold leading-relaxed text-[#665f52]">
                        {field.logic?.conditions.map((condition, index) => (
                          <p key={index}>
                            {index > 0 ? `${field.logic?.mode === "all" ? "and" : "or"} ` : "when "}
                            <span className="font-black text-[#171714]">{fieldLabels[condition.fieldId] ?? "Missing field"}</span>
                            {" "}{LOGIC_OPERATOR_LABELS[condition.op] ?? condition.op}
                            {condition.value === undefined
                              ? ""
                              : ` ${Array.isArray(condition.value) ? condition.value.join(", ") : condition.value}`}
                          </p>
                        ))}
                      </div>
                    </li>
                  ))}
                </ol>
              )}
            </div>
          </div>
        )}
      </Card>

      <div className="flex flex-wrap items-end justify-between gap-3 border-b-[3px] border-[#171714] pb-3">
        <div>
          <p className="text-[10px] font-black uppercase tracking-[0.16em] text-[#7857ff]">Build the call sheet</p>
          <h2 className="mt-1 text-2xl font-black uppercase tracking-[-0.04em] text-[#171714]">Fields</h2>
          <p className="text-sm font-semibold text-[#665f52]">Order, validation, conditions, and category routing.</p>
        </div>
        <Button className={`${SECONDARY_BUTTON} bg-[#caff4a]`} id="builder-add-field" size="sm" variant="secondary" onClick={addField}>+ Add field</Button>
      </div>

      {fieldRows.map((row, index) => {
        const field: FormField = watchedFields[index] ?? row as FormField;
        const precedingFields = watchedFields.slice(0, index).filter((candidate) =>
          candidate.type !== "heading" && candidate.type !== "html");
        const optionType = FORM_FIELD_OPTION_TYPES[field.type];
        return (
          <Card
            key={row.formKey}
            className={`${PRODUCTION_CARD} ${index % 4 === 0 ? "[&>header]:bg-[#8fdcff]" : index % 4 === 1 ? "[&>header]:bg-[#ff714f]" : index % 4 === 2 ? "[&>header]:bg-[#caff4a]" : "[&>header]:bg-[#7857ff] [&>header_h3]:text-white"}`}
            title={
              <span className="flex flex-wrap items-center justify-between gap-2">
                <span><span className="mr-2 opacity-60">{String(index + 1).padStart(2, "0")}</span>{field.label || "Untitled field"}</span>
                <Badge className={PRODUCTION_BADGE}>{FIELD_TYPE_LABELS[field.type]}</Badge>
              </span>
            }
            footer={
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex gap-1">
                  <Button
                    size="sm"
                    variant="secondary"
                    className={SECONDARY_BUTTON}
                    aria-label={`Move ${field.label} up`}
                    disabled={index === 0}
                    onClick={() => moveField(field.id, -1)}
                  >
                    Move up
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    className={SECONDARY_BUTTON}
                    aria-label={`Move ${field.label} down`}
                    disabled={index === watchedFields.length - 1}
                    onClick={() => moveField(field.id, 1)}
                  >
                    Move down
                  </Button>
                </div>
                <Button className="rounded-none border-2 border-[#171714] bg-[#ff714f] font-black uppercase tracking-[0.06em] text-[#171714]" size="sm" variant="ghost" onClick={() => removeField(field.id, index)}>Remove</Button>
              </div>
            }
          >
            <div className="grid gap-4 sm:grid-cols-2">
              <Input
                id={`builder-field-${field.id}-label`}
                label="Label"
                required
                error={errors.fields?.[index]?.label?.message}
                className={PRODUCTION_FIELD}
                {...register(`fields.${index}.label`)}
              />
              <Select
                id={`builder-field-${field.id}-type`}
                label="Field type"
                className={PRODUCTION_FIELD}
                value={field.type}
                onChange={(event) => {
                  const type = event.currentTarget.value as FormFieldType;
                  patchField(index, {
                    type,
                    required: type === "heading" || type === "html" ? false : field.required,
                    options: FORM_FIELD_OPTION_TYPES[type] ? field.options : [],
                    routing: type === "select" || type === "radio" ? field.routing : {},
                  });
                }}
              >
                {[
                  ...BUILDER_FIELD_TYPES,
                  ...(field.type === "file" ? ["file" as const] : []),
                ].map((type) => (
                  <option key={type} value={type} disabled={type === "file"}>{FIELD_TYPE_LABELS[type]}</option>
                ))}
              </Select>
              <Select
                id={`builder-field-${field.id}-semantic-key`}
                label="Use this answer as"
                hint={watchedForm.purpose === "primary-cfp"
                  ? "Assign proposal title, proposal abstract, and speaker name once each before publishing."
                  : "Optionally connect this answer to submission and review screens. Each role can be assigned once."}
                className={PRODUCTION_FIELD}
                value={field.semanticKey ?? ""}
                error={errors.fields?.[index]?.semanticKey?.message}
                onChange={(event) => patchField(index, {
                  semanticKey: event.currentTarget.value === ""
                    ? null
                    : event.currentTarget.value as FormSemanticKey,
                })}
              >
                <option value="">None</option>
                {FORM_SEMANTIC_KEYS.map((semanticKey) => (
                  <option key={semanticKey} value={semanticKey}>{SEMANTIC_KEY_LABELS[semanticKey]}</option>
                ))}
              </Select>
              <div className="sm:col-span-2">
                <Input
                  label="Help text"
                  className={PRODUCTION_FIELD}
                  value={field.helpText ?? ""}
                  onChange={(event) => patchField(index, { helpText: event.currentTarget.value || null })}
                />
              </div>
              <Checkbox
                className="border-l-[3px] border-[#caff4a] pl-3 [&_input]:rounded-none [&_input]:border-2 [&_input]:border-[#171714]"
                label="Required response"
                description="The browser blocks submission until this field is completed."
                disabled={field.type === "heading" || field.type === "html"}
                checked={field.required}
                onChange={(event) => patchField(index, { required: event.currentTarget.checked })}
              />
              <Checkbox
                className="border-l-[3px] border-[#8fdcff] pl-3 [&_input]:rounded-none [&_input]:border-2 [&_input]:border-[#171714]"
                label="Conditional field"
                description="Show or hide this field based on an earlier answer."
                disabled={precedingFields.length === 0}
                checked={field.logic !== null}
                onChange={(event) => patchField(index, {
                  logic: event.currentTarget.checked && precedingFields[0]
                    ? {
                        action: "show",
                        mode: "all",
                        conditions: [{ fieldId: precedingFields[0].id, op: "eq", value: "" }],
                      }
                    : null,
                })}
              />

              {optionType && (
                <div className="sm:col-span-2">
                  <OptionsEditor
                    field={field}
                    error={errors.fields?.[index]?.options?.message}
                    onCommit={(options, routing) => patchField(index, { options, routing })}
                  />
                </div>
              )}

              {field.logic && (
                <fieldset className="space-y-3 border-2 border-[#171714] bg-[#f3efe3] p-3 sm:col-span-2">
                  <legend className="bg-[#7857ff] px-2 py-1 text-xs font-black uppercase tracking-[0.08em] text-white">Conditional rules</legend>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Select
                      label="Action"
                      className={PRODUCTION_FIELD}
                      value={field.logic.action}
                      onChange={(event) => patchField(index, {
                        logic: { ...field.logic!, action: event.currentTarget.value as "show" | "hide" },
                      })}
                    >
                      <option value="show">Show when</option>
                      <option value="hide">Hide when</option>
                    </Select>
                    <Select
                      label="Match"
                      className={PRODUCTION_FIELD}
                      value={field.logic.mode}
                      onChange={(event) => patchField(index, {
                        logic: { ...field.logic!, mode: event.currentTarget.value as "all" | "any" },
                      })}
                    >
                      <option value="all">All conditions match</option>
                      <option value="any">Any condition matches</option>
                    </Select>
                  </div>
                  <div className="space-y-3">
                    {field.logic.conditions.map((condition, conditionIndex) => {
                      const sourceField = precedingFields.find((candidate) => candidate.id === condition.fieldId);
                      const sourceOptions = sourceField && FORM_FIELD_OPTION_TYPES[sourceField.type]
                        ? sourceField.options
                        : [];
                      const valueControlId = `builder-field-${field.id}-condition-${conditionIndex}-value`;
                      return (
                      <div key={conditionIndex} className="grid gap-3 border-2 border-[#171714] bg-[#fffdf7] p-3 shadow-[3px_3px_0_#171714] sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_auto]">
                        <Select
                          id={`builder-field-${field.id}-condition-${conditionIndex}-source`}
                          label={`Earlier field ${conditionIndex + 1}`}
                          className={PRODUCTION_FIELD}
                          value={condition.fieldId}
                          onChange={(event) => patchField(index, {
                            logic: updateConditionAt(field.logic!, conditionIndex, {
                              fieldId: event.currentTarget.value,
                              value: condition.op === "not_empty"
                                ? undefined
                                : condition.op === "in" ? [] : "",
                            }),
                          })}
                        >
                          {precedingFields.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.label}</option>)}
                        </Select>
                        <Select
                          label="Comparison"
                          className={PRODUCTION_FIELD}
                          value={condition.op}
                          onChange={(event) => {
                            const op = event.currentTarget.value as typeof condition.op;
                            patchField(index, {
                              logic: updateConditionAt(field.logic!, conditionIndex, {
                                op,
                                value: op === "not_empty"
                                  ? undefined
                                  : op === "in"
                                    ? Array.isArray(condition.value)
                                      ? condition.value
                                      : condition.value ? [condition.value] : []
                                    : Array.isArray(condition.value)
                                      ? condition.value[0] ?? ""
                                      : condition.value ?? "",
                              }),
                            });
                          }}
                        >
                          <option value="eq">Equals</option>
                          <option value="neq">Does not equal</option>
                          <option value="in">Is one of</option>
                          <option value="not_empty">Is not empty</option>
                        </Select>
                        {sourceOptions.length > 0 && condition.op !== "not_empty" ? (
                          <Select
                            id={valueControlId}
                            label={condition.op === "in" ? "Values" : "Value"}
                            hint={condition.op === "in" ? "Select one or more answers." : "Select an answer."}
                            className={condition.op === "in" ? `${PRODUCTION_FIELD} min-h-28` : PRODUCTION_FIELD}
                            multiple={condition.op === "in"}
                            value={condition.op === "in"
                              ? Array.isArray(condition.value) ? condition.value : []
                              : Array.isArray(condition.value) ? condition.value[0] ?? "" : condition.value ?? ""}
                            onChange={(event) => patchField(index, {
                              logic: updateConditionAt(field.logic!, conditionIndex, {
                                value: condition.op === "in"
                                  ? Array.from(event.currentTarget.selectedOptions, (option) => option.value)
                                  : event.currentTarget.value,
                              }),
                            })}
                          >
                            {condition.op !== "in" && <option value="">Choose an answer</option>}
                            {sourceOptions.map((option) => <option key={option} value={option}>{option}</option>)}
                          </Select>
                        ) : (
                          <Input
                            id={valueControlId}
                            label="Value"
                            hint={condition.op === "in" ? "Separate multiple answers with commas." : undefined}
                            className={PRODUCTION_FIELD}
                            disabled={condition.op === "not_empty"}
                            value={Array.isArray(condition.value) ? condition.value.join(", ") : condition.value ?? ""}
                            onChange={(event) => patchField(index, {
                              logic: updateConditionAt(field.logic!, conditionIndex, {
                                value: condition.op === "in"
                                  ? event.currentTarget.value.split(",").map((value) => value.trim()).filter(Boolean)
                                  : event.currentTarget.value,
                              }),
                            })}
                          />
                        )}
                        <Button
                          className={`${SECONDARY_BUTTON} self-end`}
                          size="sm"
                          variant="ghost"
                          disabled={field.logic!.conditions.length === 1}
                          onClick={() => {
                            const conditions = field.logic!.conditions.filter((_, index) => index !== conditionIndex);
                            patchField(index, {
                              logic: { ...field.logic!, conditions: conditions as unknown as ConditionalLogic["conditions"] },
                            });
                          }}
                        >
                          Remove
                        </Button>
                      </div>
                      );
                    })}
                  </div>
                  <Button
                    className={SECONDARY_BUTTON}
                    size="sm"
                    variant="secondary"
                    disabled={precedingFields.length === 0}
                    onClick={() => {
                      if (!precedingFields[0]) return;
                      patchField(index, {
                        logic: {
                          ...field.logic!,
                          conditions: [
                            ...field.logic!.conditions,
                            { fieldId: precedingFields[0].id, op: "eq", value: "" },
                          ],
                        },
                      });
                    }}
                  >
                    Add condition
                  </Button>
                </fieldset>
              )}

              {(field.type === "select" || field.type === "radio") && field.options.length > 0 && (
                <fieldset className="grid gap-3 border-2 border-[#171714] bg-[#8fdcff]/30 p-3 sm:col-span-2 sm:grid-cols-2">
                  <legend className="bg-[#8fdcff] px-2 py-1 text-xs font-black uppercase tracking-[0.08em] text-[#171714]">Category routing</legend>
                  <p className="text-xs font-semibold text-[#665f52] sm:col-span-2">
                    Use clear review category names. Changes reach new submissions after you publish a new version; existing submissions keep their original category.
                  </p>
                  {field.options.map((option) => (
                    <Input
                      id={`builder-field-${field.id}-routing-${field.options.indexOf(option)}`}
                      error={(errors.fields?.[index]?.routing as { message?: string } | undefined)?.message}
                      key={option}
                      label={option}
                      hint="Review category"
                      className={PRODUCTION_FIELD}
                      value={field.routing[option] ?? ""}
                      onChange={(event) => patchField(index, {
                        routing: { ...field.routing, [option]: event.currentTarget.value },
                      })}
                    />
                  ))}
                </fieldset>
              )}
            </div>
          </Card>
        );
      })}

      {message && (
        <div className="border-2 border-[#171714] bg-[#ffd34e] px-3 py-2 text-sm font-semibold text-[#171714] shadow-[3px_3px_0_#171714]" role="status">
          {message}
        </div>
      )}
      <div className="sticky bottom-3 z-10 flex flex-wrap items-center justify-between gap-3 border-[3px] border-[#171714] bg-[#171714]/95 p-3 text-white shadow-[6px_6px_0_#7857ff] backdrop-blur-sm">
        <div className="text-[10px] font-black uppercase tracking-[0.12em] text-white/70">
          Draft v{watchedForm.version} <span className="px-1 text-[#caff4a]">◆</span> {watchedFields.length} {watchedFields.length === 1 ? "field" : "fields"}
        </div>
        <div className="flex flex-wrap gap-2">
          {watchedForm.purpose === "additional" &&
            watchedForm.status === "draft" &&
            watchedForm.publishedVersion === null &&
            onDelete && (
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button variant="danger" loading={busyAction === "delete"}>Delete draft</Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Delete “{watchedForm.name}”?</AlertDialogTitle>
                    <AlertDialogDescription>
                      This permanently removes the unpublished additional-form draft. Published forms and the primary CFP cannot be deleted.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Keep draft</AlertDialogCancel>
                    <AlertDialogAction onClick={() => onDelete(watchedForm)}>Delete draft</AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            )}
          {watchedForm.status === "open" && (
            <Button
              variant="secondary"
              className={SECONDARY_BUTTON}
              loading={busyAction === "status"}
              onClick={() => onStatusChange("closed", watchedForm)}
            >
              Close form
            </Button>
          )}
          {watchedForm.status === "closed" && watchedForm.publishedVersion && (
            <Button
              variant="secondary"
              className={SECONDARY_BUTTON}
              loading={busyAction === "status"}
              onClick={() => onStatusChange("open", watchedForm)}
            >
              Reopen form
            </Button>
          )}
          <Button className={SECONDARY_BUTTON} type="submit" name="intent" value="save" variant="secondary" loading={busyAction === "save"}>
            Save draft
          </Button>
          <Button className="rounded-none border-2 border-[#171714] bg-[#caff4a] font-black uppercase tracking-[0.06em] text-[#171714] shadow-[3px_3px_0_#7857ff] hover:bg-[#d7ff78]" type="submit" name="intent" value="publish" loading={busyAction === "publish"}>
            {watchedForm.publishedVersion ? "Publish new version" : "Publish form"}
          </Button>
        </div>
      </div>
      </fieldset>
    </form>
  );
}
