import { useState, type FormEvent } from "react";
import { Badge, Button, Card, Checkbox, Input, Select, Textarea } from "@/ui";
import { FORM_FIELD_TYPES, type FormDetail, type FormField, type FormFieldType, type FormStatus } from "../schema";

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

const toDateTimeLocal = (value: number | null): string => {
  if (value === null) return "";
  const date = new Date(value - new Date(value).getTimezoneOffset() * 60_000);
  return date.toISOString().slice(0, 16);
};

export function FormBuilder({ form, onChange, onSave, onPublish, onStatusChange }: FormBuilderProps) {
  const [message, setMessage] = useState<string | null>(null);

  const patchForm = (patch: Partial<FormDetail>) => onChange({ ...form, ...patch });
  const patchField = (fieldId: string, patch: Partial<FormField>) => {
    onChange({
      ...form,
      fields: form.fields.map((field) => field.id === fieldId ? { ...field, ...patch } : field),
    });
    setMessage(null);
  };

  const moveField = (fieldId: string, direction: -1 | 1) => {
    const index = form.fields.findIndex((field) => field.id === fieldId);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= form.fields.length) return;
    const fields = [...form.fields];
    [fields[index], fields[target]] = [fields[target]!, fields[index]!];
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

  const save = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setMessage("Draft changes saved locally for this fixture preview.");
    onSave(form);
  };

  const routingFields = form.fields.filter((field) => Object.keys(field.routing).length > 0);
  const conditionalFields = form.fields.filter((field) => field.logic !== null);
  const fieldLabels = Object.fromEntries(form.fields.map((field) => [field.id, field.label]));

  return (
    <form className="space-y-5" onSubmit={save}>
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
              label="Form name"
              required
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
            type="datetime-local"
            label="Opens"
            value={toDateTimeLocal(form.opensAt)}
            onChange={(event) => patchForm({
              opensAt: event.currentTarget.value ? new Date(event.currentTarget.value).getTime() : null,
            })}
          />
          <Input
            type="datetime-local"
            label="Closes"
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
                          <p key={`${condition.fieldId}-${index}`}>
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
        <Button size="sm" variant="secondary" onClick={addField}>Add field</Button>
      </div>

      {form.fields.map((field, index) => {
        const precedingFields = form.fields.slice(0, index).filter((candidate) =>
          candidate.type !== "heading" && candidate.type !== "html");
        const condition = field.logic?.conditions[0];
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
                label="Label"
                required
                value={field.label}
                onChange={(event) => patchField(field.id, { label: event.currentTarget.value })}
              />
              <Select
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
                  <Textarea
                    label="Ordered options"
                    hint="One option per line. The displayed order is preserved in published versions."
                    rows={Math.max(3, field.options.length)}
                    value={field.options.join("\n")}
                    onChange={(event) => {
                      const options = event.currentTarget.value.split("\n").map((option) => option.trim()).filter(Boolean);
                      patchField(field.id, {
                        options,
                        routing: Object.fromEntries(
                          Object.entries(field.routing).filter(([option]) => options.includes(option)),
                        ),
                      });
                    }}
                  />
                </div>
              )}

              {field.logic && condition && (
                <fieldset className="grid gap-3 rounded-control border border-line bg-surface-muted/50 p-3 sm:col-span-2 sm:grid-cols-4">
                  <legend className="px-1 text-sm font-medium text-ink">Conditional rule</legend>
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
                    label="Earlier field"
                    value={condition.fieldId}
                    onChange={(event) => patchField(field.id, {
                      logic: {
                        ...field.logic!,
                        conditions: [{ ...condition, fieldId: event.currentTarget.value }],
                      },
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
                        logic: {
                          ...field.logic!,
                          conditions: [{ ...condition, op, value: op === "not_empty" ? undefined : condition.value ?? "" }],
                        },
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
                      logic: {
                        ...field.logic!,
                        conditions: [{
                          ...condition,
                          value: condition.op === "in"
                            ? event.currentTarget.value.split(",").map((value) => value.trim()).filter(Boolean)
                            : event.currentTarget.value,
                        }],
                      },
                    })}
                  />
                </fieldset>
              )}

              {(field.type === "select" || field.type === "radio") && field.options.length > 0 && (
                <fieldset className="grid gap-3 rounded-control border border-line p-3 sm:col-span-2 sm:grid-cols-2">
                  <legend className="px-1 text-sm font-medium text-ink">Category routing</legend>
                  {field.options.map((option) => (
                    <Input
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
          <Button type="submit" variant="secondary">Save draft</Button>
          <Button onClick={() => onPublish(form)}>
            {form.publishedVersion ? "Publish new version" : "Publish form"}
          </Button>
        </div>
      </div>
    </form>
  );
}
