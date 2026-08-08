import { useState, type FormEvent } from "react";
import { Badge, Button, Card, Checkbox, Input, Select, Textarea } from "@/ui";
import { FORM_FIELD_TYPES, type ConditionalLogic, type FormDetail, type FormField, type FormFieldType, type FormStatus, type LogicCondition } from "../schema";

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

const OPTION_TYPES: Record<FormFieldType, boolean> = {
  text: false,
  textarea: false,
  select: true,
  multiselect: true,
  radio: true,
  checkbox: false,
  email: false,
  url: false,
  file: false,
  date: false,
  heading: false,
  html: false,
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
}

export interface PublishValidationIssue {
  readonly controlId: string;
  readonly message: string;
}

export const validatePublishIntent = (form: FormDetail): readonly PublishValidationIssue[] => {
  const issues: PublishValidationIssue[] = [];
  if (form.name.trim().length === 0) {
    issues.push({ controlId: "builder-form-name", message: "Enter a form name." });
  }
  if (form.opensAt !== null && form.closesAt !== null && form.closesAt < form.opensAt) {
    issues.push({ controlId: "builder-closes-at", message: "Close time must be at or after open time." });
  }
  for (const [fieldIndex, field] of form.fields.entries()) {
    if (field.label.trim().length === 0) {
      issues.push({
        controlId: `builder-field-${field.id}-label`,
        message: `Field ${field.order} needs a label.`,
      });
    }
    if (OPTION_TYPES[field.type]) {
      if (field.options.length === 0) {
        issues.push({
          controlId: `builder-field-${field.id}-options`,
          message: `${field.label || `Field ${field.order}`} needs at least one option.`,
        });
      }
      const normalized = field.options.map((option) => option.trim());
      if (normalized.some((option) => option.length === 0) || new Set(normalized).size !== normalized.length) {
        issues.push({
          controlId: `builder-field-${field.id}-options`,
          message: `${field.label || `Field ${field.order}`} has blank or duplicate options.`,
        });
      }
    }
    field.logic?.conditions.forEach((condition, conditionIndex) => {
      const sourceIndex = form.fields.findIndex((candidate) => candidate.id === condition.fieldId);
      if (sourceIndex < 0 || sourceIndex >= fieldIndex) {
        issues.push({
          controlId: `builder-field-${field.id}-condition-${conditionIndex}-source`,
          message: `${field.label || `Field ${field.order}`} must depend on an earlier field.`,
        });
      }
    });
  }
  if (form.purpose === "primary-cfp") {
    const completeRouter = form.fields.find((field) =>
      (field.type === "select" || field.type === "radio") &&
      field.options.length > 0 &&
      field.options.every((option) => field.routing[option]?.trim()));
    if (!completeRouter) {
      const candidate = form.fields.find((field) => field.type === "select" || field.type === "radio");
      const missingOptionIndex = candidate?.options.findIndex((option) =>
        !candidate.routing[option]?.trim()) ?? -1;
      issues.push({
        controlId: candidate
          ? candidate.options.length > 0
            ? `builder-field-${candidate.id}-routing-${Math.max(0, missingOptionIndex)}`
            : `builder-field-${candidate.id}-options`
          : form.fields[0]
            ? `builder-field-${form.fields[0].id}-type`
            : "builder-add-field",
        message: "Route every option in one select or radio field to a review category.",
      });
    }
  }
  return issues;
};

export const updateConditionAt = (
  logic: ConditionalLogic,
  conditionIndex: number,
  patch: Partial<LogicCondition>,
): ConditionalLogic => ({
  ...logic,
  conditions: logic.conditions.map((condition, index) =>
    index === conditionIndex ? { ...condition, ...patch } : condition) as ConditionalLogic["conditions"],
});

export const normalizeOptionDraft = (
  raw: string,
  routing: Readonly<Record<string, string>>,
): { readonly options: readonly string[]; readonly routing: Readonly<Record<string, string>> } => {
  const options = raw.split(/\r?\n/).map((option) => option.trim()).filter(Boolean);
  return {
    options,
    routing: Object.fromEntries(
      Object.entries(routing).filter(([option]) => options.includes(option)),
    ),
  };
};

interface OptionsEditorProps {
  readonly field: FormField;
  readonly error?: string;
  readonly onCommit: (options: readonly string[], routing: Readonly<Record<string, string>>) => void;
}

function OptionsEditor({ field, error, onCommit }: OptionsEditorProps) {
  const [raw, setRaw] = useState(field.options.join("\n"));
  return (
    <Textarea
      id={`builder-field-${field.id}-options`}
      label="Ordered options"
      hint="One option per line. Options are normalized when you leave this field."
      error={error}
      rows={Math.max(3, raw.split(/\r?\n/).length)}
      value={raw}
      onChange={(event) => setRaw(event.currentTarget.value)}
      onBlur={() => {
        const normalized = normalizeOptionDraft(raw, field.routing);
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

export function FormBuilder({ form, onChange, onSave, onPublish, onStatusChange }: FormBuilderProps) {
  const [message, setMessage] = useState<string | null>(null);
  const [publishIssues, setPublishIssues] = useState<readonly PublishValidationIssue[]>([]);

  const patchForm = (patch: Partial<FormDetail>) => {
    onChange({ ...form, ...patch });
    setMessage(null);
    setPublishIssues([]);
  };
  const patchField = (fieldId: string, patch: Partial<FormField>) => {
    onChange({
      ...form,
      fields: form.fields.map((field) => field.id === fieldId ? { ...field, ...patch } : field),
    });
    setMessage(null);
    setPublishIssues([]);
  };

  const moveField = (fieldId: string, direction: -1 | 1) => {
    const index = form.fields.findIndex((field) => field.id === fieldId);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= form.fields.length) return;
    const fields = [...form.fields];
    [fields[index], fields[target]] = [fields[target]!, fields[index]!];
    const positions = Object.fromEntries(fields.map((field, position) => [field.id, position]));
    const invalid = fields.find((field, position) =>
      field.logic?.conditions.some((condition) =>
        positions[condition.fieldId] === undefined || positions[condition.fieldId] >= position));
    if (invalid) {
      setMessage(`Move blocked: ${invalid.label || "this field"} must stay below every field it depends on.`);
      return;
    }
    patchForm({ fields: fields.map((field, order) => ({ ...field, order: order + 1 })) });
  };

  const addField = () => {
    let suffix = form.fields.length + 1;
    while (form.fields.some((field) => field.id === `${form.id}-field-${suffix}`)) suffix += 1;
    const field: FormField = {
      id: `${form.id}-field-${suffix}`,
      order: form.fields.length + 1,
      type: "text",
      label: "New question",
      helpText: null,
      required: false,
      options: [],
      logic: null,
      routing: {},
      version: 1,
    };
    patchForm({ fields: [...form.fields, field] });
  };

  const removeField = (fieldId: string) => {
    const referenced = form.fields.some((field) =>
      field.logic?.conditions.some((condition) => condition.fieldId === fieldId));
    if (referenced) {
      setMessage("Remove conditional rules that reference this field first.");
      return;
    }
    patchForm({
      fields: form.fields
        .filter((field) => field.id !== fieldId)
        .map((field, order) => ({ ...field, order: order + 1 })),
    });
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const submitter = (event.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null;
    if (submitter?.value === "save") {
      setMessage("Draft changes saved locally for this fixture preview.");
      setPublishIssues([]);
      onSave(form);
      return;
    }
    const issues = validatePublishIntent(form);
    if (issues.length > 0) {
      setMessage(null);
      setPublishIssues(issues);
      globalThis.setTimeout(() => globalThis.document?.getElementById(issues[0]!.controlId)?.focus(), 0);
      return;
    }
    setPublishIssues([]);
    setMessage(null);
    onPublish(form);
  };

  const routingFields = form.fields.filter((field) => Object.keys(field.routing).length > 0);
  const conditionalFields = form.fields.filter((field) => field.logic !== null);
  const fieldLabels = Object.fromEntries(form.fields.map((field) => [field.id, field.label]));

  return (
    <form className="space-y-5" noValidate onSubmit={submit}>
      {publishIssues.length > 0 && (
        <div className="rounded-control border border-danger bg-danger-soft px-4 py-3 text-sm text-ink" role="alert">
          <h2 className="font-semibold">Fix these issues before publishing</h2>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-ink-secondary">
            {publishIssues.map((issue) => <li key={`${issue.controlId}-${issue.message}`}>{issue.message}</li>)}
          </ul>
        </div>
      )}
      <Card
        title={
          <span className="flex flex-wrap items-center justify-between gap-2">
            <span>Form settings</span>
            <Badge tone={form.status === "open" ? "success" : form.status === "closed" ? "warning" : "neutral"}>
              {form.status === "open" ? "Open" : form.status === "closed" ? "Closed" : "Draft"}
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
              error={publishIssues.find((issue) => issue.controlId === "builder-form-name")?.message}
              value={form.name}
              onChange={(event) => patchForm({ name: event.currentTarget.value })}
            />
          </div>
          <div className="sm:col-span-2">
            <Textarea
              label="Description"
              hint="Shown at the top of the public form."
              value={form.description ?? ""}
              onChange={(event) => patchForm({ description: event.currentTarget.value || null })}
            />
          </div>
          <Input
            id="builder-opens-at"
            type="datetime-local"
            label="Opens"
            value={toDateTimeLocal(form.opensAt)}
            onChange={(event) => patchForm({
              opensAt: event.currentTarget.value ? new Date(event.currentTarget.value).getTime() : null,
            })}
          />
          <Input
            id="builder-closes-at"
            type="datetime-local"
            label="Closes"
            error={publishIssues.find((issue) => issue.controlId === "builder-closes-at")?.message}
            value={toDateTimeLocal(form.closesAt)}
            onChange={(event) => patchForm({
              closesAt: event.currentTarget.value ? new Date(event.currentTarget.value).getTime() : null,
            })}
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

      {form.fields.map((field, index) => {
        const precedingFields = form.fields.slice(0, index).filter((candidate) =>
          candidate.type !== "heading" && candidate.type !== "html");
        const optionType = OPTION_TYPES[field.type];
        return (
          <Card
            key={field.id}
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
                    disabled={index === form.fields.length - 1}
                    onClick={() => moveField(field.id, 1)}
                  >
                    Move down
                  </Button>
                </div>
                <Button size="sm" variant="ghost" onClick={() => removeField(field.id)}>Remove</Button>
              </div>
            }
          >
            <div className="grid gap-4 sm:grid-cols-2">
              <Input
                id={`builder-field-${field.id}-label`}
                label="Label"
                required
                error={publishIssues.find((issue) => issue.controlId === `builder-field-${field.id}-label`)?.message}
                value={field.label}
                onChange={(event) => patchField(field.id, { label: event.currentTarget.value })}
              />
              <Select
                id={`builder-field-${field.id}-type`}
                label="Field type"
                value={field.type}
                onChange={(event) => {
                  const type = event.currentTarget.value as FormFieldType;
                  patchField(field.id, {
                    type,
                    required: type === "heading" || type === "html" ? false : field.required,
                    options: OPTION_TYPES[type] ? field.options : [],
                    routing: type === "select" || type === "radio" ? field.routing : {},
                  });
                }}
              >
                {FORM_FIELD_TYPES.map((type) => <option key={type} value={type}>{FIELD_TYPE_LABELS[type]}</option>)}
              </Select>
              <div className="sm:col-span-2">
                <Input
                  label="Help text"
                  value={field.helpText ?? ""}
                  onChange={(event) => patchField(field.id, { helpText: event.currentTarget.value || null })}
                />
              </div>
              <Checkbox
                label="Required response"
                description="The browser blocks submission until this field is completed."
                disabled={field.type === "heading" || field.type === "html"}
                checked={field.required}
                onChange={(event) => patchField(field.id, { required: event.currentTarget.checked })}
              />
              <Checkbox
                label="Conditional field"
                description="Show or hide this field based on an earlier answer."
                disabled={precedingFields.length === 0}
                checked={field.logic !== null}
                onChange={(event) => patchField(field.id, {
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
                    error={publishIssues.find((issue) =>
                      issue.controlId === `builder-field-${field.id}-options`)?.message}
                    onCommit={(options, routing) => patchField(field.id, { options, routing })}
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
                      onChange={(event) => patchField(field.id, {
                        logic: { ...field.logic!, action: event.currentTarget.value as "show" | "hide" },
                      })}
                    >
                      <option value="show">Show when</option>
                      <option value="hide">Hide when</option>
                    </Select>
                    <Select
                      label="Match"
                      value={field.logic.mode}
                      onChange={(event) => patchField(field.id, {
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
                          onChange={(event) => patchField(field.id, {
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
                            patchField(field.id, {
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
                          onChange={(event) => patchField(field.id, {
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
                          disabled={field.logic.conditions.length === 1}
                          onClick={() => {
                            const conditions = field.logic!.conditions.filter((_, index) => index !== conditionIndex);
                            patchField(field.id, {
                              logic: { ...field.logic!, conditions: conditions as ConditionalLogic["conditions"] },
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
                      patchField(field.id, {
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
                      error={publishIssues.find((issue) =>
                        issue.controlId === `builder-field-${field.id}-routing-${field.options.indexOf(option)}`)?.message}
                      key={option}
                      label={option}
                      hint="Internal category key"
                      value={field.routing[option] ?? ""}
                      onChange={(event) => patchField(field.id, {
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
          Draft v{form.version} · {form.fields.length} {form.fields.length === 1 ? "field" : "fields"}
        </div>
        <div className="flex flex-wrap gap-2">
          {form.status === "open" && (
            <Button variant="secondary" onClick={() => onStatusChange("closed")}>Close form</Button>
          )}
          {form.status === "closed" && form.publishedVersion && (
            <Button variant="secondary" onClick={() => onStatusChange("open")}>Reopen form</Button>
          )}
          <Button type="submit" name="intent" value="save" variant="secondary">Save draft</Button>
          <Button type="submit" name="intent" value="publish">
            {form.publishedVersion ? "Publish new version" : "Publish form"}
          </Button>
        </div>
      </div>
    </form>
  );
}
