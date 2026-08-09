import { useEffect, useState } from "react";
import { effectTsResolver } from "@hookform/resolvers/effect-ts";
import { useFieldArray, useForm, useWatch } from "react-hook-form";
import { Badge, Button, Card, Checkbox, Input, Select, Textarea } from "@/ui";
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
  file: "File upload",
  date: "Date",
  heading: "Section heading",
  html: "Guidance text",
};

const SEMANTIC_KEY_LABELS: Record<FormSemanticKey, string> = {
  submissionTitle: "Submission title",
  submissionAbstract: "Submission abstract",
  speakerName: "Speaker name",
  speakerEmail: "Speaker email",
};


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
  onStatusChange: (status: Extract<FormStatus, "open" | "closed">) => void;
  /** False when the client cannot yet send the write headers these operations require. Defaults to true. */
  mutationsAvailable?: boolean;
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
      hint="One option per line. Options are normalized when you leave this field."
      error={error}
      rows={Math.max(3, field.options.length)}
      defaultValue={field.options.join("\n")}
      onBlur={(event) => {
        const normalized = normalizeOptionDraft(event.currentTarget.value, field.routing);
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

export function FormBuilder({ form, onChange, onSave, onPublish, onStatusChange, mutationsAvailable = true }: FormBuilderProps) {
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
      setMessage("Draft saved.");
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
    <form noValidate onSubmit={mutationsAvailable ? submit : (event) => event.preventDefault()}>
      <fieldset disabled={!mutationsAvailable} className="m-0 min-w-0 space-y-5 border-0 p-0">
      {!mutationsAvailable && (
        <div className="rounded-control border border-line bg-surface-muted px-4 py-3 text-sm text-ink-secondary" role="status">
          This form is read-only right now. This client can't yet send the idempotency headers organizer edits require.
        </div>
      )}
      {errors.root?.publish?.message && (
        <div className="rounded-control border border-danger bg-danger-soft px-4 py-3 text-sm text-ink" role="alert">
          <h2 className="font-semibold">Fix these issues before publishing</h2>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-ink-secondary">
            {errors.root.publish.message.split("\n").map((issue) => <li key={issue}>{issue}</li>)}
          </ul>
        </div>
      )}
      <Card
        title={
          <span className="flex flex-wrap items-center justify-between gap-2">
            <span>Form settings</span>
            <Badge tone={watchedForm.status === "open" ? "success" : watchedForm.status === "closed" ? "warning" : "neutral"}>
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
              {...register("name")}
            />
          </div>
          <div className="sm:col-span-2">
            <Textarea
              label="Description"
              hint="Shown at the top of the public form."
              {...register("description", { setValueAs: (value) => value || null })}
            />
          </div>
          <Input
            id="builder-opens-at"
            type="datetime-local"
            label="Opens"
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
        className="border-accent/30"
        title={
          <span className="flex flex-wrap items-center justify-between gap-2">
            <span>Proposal routing map</span>
            <Badge tone="accent">
              {routingFields.length} {routingFields.length === 1 ? "router" : "routers"} · {conditionalFields.length} conditional
            </Badge>
          </span>
        }
      >
        {routingFields.length === 0 && conditionalFields.length === 0 ? (
          <div className="rounded-control border border-dashed border-line-strong px-4 py-5 text-sm text-ink-secondary">
            Add category routing or a conditional rule to see how answers move through this form.
          </div>
        ) : (
          <div className="grid gap-5 lg:grid-cols-[minmax(0,1.25fr)_minmax(12rem,0.75fr)]">
            <div className="space-y-3">
              <p className="text-xs font-semibold uppercase tracking-[0.12em] text-ink-faint">
                Answer to review category
              </p>
              {routingFields.length === 0 ? (
                <p className="text-sm text-ink-faint">No track or category routing yet.</p>
              ) : routingFields.map((field) => (
                <section key={field.id} className="overflow-hidden rounded-control border border-accent/25 bg-accent-soft/40">
                  <header className="flex flex-wrap items-center justify-between gap-2 border-b border-accent/20 px-3 py-2">
                    <h3 className="text-sm font-semibold text-ink">{field.label}</h3>
                    <span className="text-xs text-ink-faint">{field.required ? "Required choice" : "Optional choice"}</span>
                  </header>
                  <ul className="divide-y divide-accent/15">
                    {field.options.map((option) => (
                      <li key={option} className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2 px-3 py-2 text-sm">
                        <span className="truncate text-ink-secondary">{option}</span>
                        <span className="font-semibold text-accent-deep" aria-hidden="true">→</span>
                        <span className="truncate font-medium text-ink">{field.routing[option] || "Needs category"}</span>
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
            </div>
            <div className="border-t border-line pt-4 lg:border-l lg:border-t-0 lg:pl-5 lg:pt-0">
              <p className="text-xs font-semibold uppercase tracking-[0.12em] text-ink-faint">
                Conditional branches
              </p>
              {conditionalFields.length === 0 ? (
                <p className="mt-3 text-sm text-ink-faint">Every field is always shown.</p>
              ) : (
                <ol className="mt-3 space-y-3">
                  {conditionalFields.map((field) => (
                    <li key={field.id} className="rounded-control border border-line bg-surface-muted/60 px-3 py-2.5">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge tone={field.logic?.action === "hide" ? "warning" : "accent"}>
                          {field.logic?.action === "hide" ? "Hide" : "Show"}
                        </Badge>
                        <span className="text-sm font-medium text-ink">{field.label}</span>
                      </div>
                      <div className="mt-1.5 space-y-1 text-xs leading-relaxed text-ink-secondary">
                        {field.logic?.conditions.map((condition, index) => (
                          <p key={index}>
                            {index > 0 ? `${field.logic?.mode === "all" ? "and" : "or"} ` : "when "}
                            <span className="font-medium text-ink">{fieldLabels[condition.fieldId] ?? "Missing field"}</span>
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

      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-ink">Fields</h2>
          <p className="text-sm text-ink-faint">Order, validation, conditions, and category routing.</p>
        </div>
        <Button id="builder-add-field" size="sm" variant="secondary" onClick={addField}>Add field</Button>
      </div>

      {fieldRows.map((row, index) => {
        const field: FormField = watchedFields[index] ?? row as FormField;
        const precedingFields = watchedFields.slice(0, index).filter((candidate) =>
          candidate.type !== "heading" && candidate.type !== "html");
        const optionType = FORM_FIELD_OPTION_TYPES[field.type];
        return (
          <Card
            key={row.formKey}
            title={
              <span className="flex flex-wrap items-center justify-between gap-2">
                <span>{index + 1}. {field.label || "Untitled field"}</span>
                <Badge>{FIELD_TYPE_LABELS[field.type]}</Badge>
              </span>
            }
            footer={
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex gap-1">
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={`Move ${field.label} up`}
                    disabled={index === 0}
                    onClick={() => moveField(field.id, -1)}
                  >
                    Move up
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={`Move ${field.label} down`}
                    disabled={index === watchedFields.length - 1}
                    onClick={() => moveField(field.id, 1)}
                  >
                    Move down
                  </Button>
                </div>
                <Button size="sm" variant="ghost" onClick={() => removeField(field.id, index)}>Remove</Button>
              </div>
            }
          >
            <div className="grid gap-4 sm:grid-cols-2">
              <Input
                id={`builder-field-${field.id}-label`}
                label="Label"
                required
                error={errors.fields?.[index]?.label?.message}
                {...register(`fields.${index}.label`)}
              />
              <Select
                id={`builder-field-${field.id}-type`}
                label="Field type"
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
                {FORM_FIELD_TYPES.map((type) => <option key={type} value={type}>{FIELD_TYPE_LABELS[type]}</option>)}
              </Select>
              <Select
                id={`builder-field-${field.id}-semantic-key`}
                label="Submission/review meaning"
                hint="Assign a stable meaning for public submission and review. Labels are never used as a fallback."
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
                  value={field.helpText ?? ""}
                  onChange={(event) => patchField(index, { helpText: event.currentTarget.value || null })}
                />
              </div>
              <Checkbox
                label="Required response"
                description="The browser blocks submission until this field is completed."
                disabled={field.type === "heading" || field.type === "html"}
                checked={field.required}
                onChange={(event) => patchField(index, { required: event.currentTarget.checked })}
              />
              <Checkbox
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
                <fieldset className="space-y-3 rounded-control border border-line bg-surface-muted/50 p-3 sm:col-span-2">
                  <legend className="px-1 text-sm font-medium text-ink">Conditional rules</legend>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Select
                      label="Action"
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
                    {field.logic.conditions.map((condition, conditionIndex) => (
                      <div key={conditionIndex} className="grid gap-3 rounded-control border border-line bg-surface p-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_auto]">
                        <Select
                          id={`builder-field-${field.id}-condition-${conditionIndex}-source`}
                          label={`Earlier field ${conditionIndex + 1}`}
                          value={condition.fieldId}
                          onChange={(event) => patchField(index, {
                            logic: updateConditionAt(field.logic!, conditionIndex, {
                              fieldId: event.currentTarget.value,
                            }),
                          })}
                        >
                          {precedingFields.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.label}</option>)}
                        </Select>
                        <Select
                          label="Comparison"
                          value={condition.op}
                          onChange={(event) => {
                            const op = event.currentTarget.value as typeof condition.op;
                            patchField(index, {
                              logic: updateConditionAt(field.logic!, conditionIndex, {
                                op,
                                value: op === "not_empty" ? undefined : condition.value ?? "",
                              }),
                            });
                          }}
                        >
                          <option value="eq">Equals</option>
                          <option value="neq">Does not equal</option>
                          <option value="in">Is one of</option>
                          <option value="not_empty">Is not empty</option>
                        </Select>
                        <Input
                          label="Value"
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
                        <Button
                          className="self-end"
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
                    ))}
                  </div>
                  <Button
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
                <fieldset className="grid gap-3 rounded-control border border-line p-3 sm:col-span-2 sm:grid-cols-2">
                  <legend className="px-1 text-sm font-medium text-ink">Category routing</legend>
                  {field.options.map((option) => (
                    <Input
                      id={`builder-field-${field.id}-routing-${field.options.indexOf(option)}`}
                      error={(errors.fields?.[index]?.routing as { message?: string } | undefined)?.message}
                      key={option}
                      label={option}
                      hint="Internal category key"
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
        <div className="rounded-control border border-line bg-surface-muted px-3 py-2 text-sm text-ink-secondary" role="status">
          {message}
        </div>
      )}
      <div className="sticky bottom-3 z-10 flex flex-wrap items-center justify-between gap-3 rounded-card border border-line bg-surface/95 p-3 shadow-card backdrop-blur-sm">
        <div className="text-xs text-ink-faint">
          Draft v{watchedForm.version} · {watchedFields.length} {watchedFields.length === 1 ? "field" : "fields"}
        </div>
        <div className="flex flex-wrap gap-2">
          {watchedForm.status === "open" && (
            <Button variant="secondary" onClick={() => onStatusChange("closed")}>Close form</Button>
          )}
          {watchedForm.status === "closed" && watchedForm.publishedVersion && (
            <Button variant="secondary" onClick={() => onStatusChange("open")}>Reopen form</Button>
          )}
          <Button type="submit" name="intent" value="save" variant="secondary">Save draft</Button>
          <Button type="submit" name="intent" value="publish">
            {watchedForm.publishedVersion ? "Publish new version" : "Publish form"}
          </Button>
        </div>
      </div>
      </fieldset>
    </form>
  );
}
