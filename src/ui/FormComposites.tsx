import type { ReactNode } from "react";
import { Button } from "./Button";
import { Card } from "./Card";
import { Checkbox, Input, Select, Textarea } from "./fields";

export type FormRenderFieldType =
  | "text"
  | "email"
  | "url"
  | "textarea"
  | "select"
  | "checkbox"
  | "heading"
  | "guidance";

export interface FormRenderOption {
  value: string;
  label: string;
}

export interface FormRenderField {
  id: string;
  type: FormRenderFieldType;
  label: string;
  helpText?: string;
  required?: boolean;
  options?: readonly FormRenderOption[];
}

export interface FormRendererProps {
  fields: readonly FormRenderField[];
  values: Readonly<Record<string, unknown>>;
  onValueChange: (fieldId: string, value: unknown) => void;
  disabled?: boolean;
  errors?: Readonly<Record<string, string | undefined>>;
  idPrefix?: string;
}

export function FormRenderer({
  fields,
  values,
  onValueChange,
  disabled = false,
  errors = {},
  idPrefix = "form-field",
}: FormRendererProps) {
  return (
    <div className="space-y-5">
      {fields.map((field) => {
        const id = `${idPrefix}-${field.id}`;
        const value = values[field.id];
        if (field.type === "heading") {
          return <h2 key={field.id} className="text-lg font-semibold text-ink">{field.label}</h2>;
        }
        if (field.type === "guidance") {
          return <p key={field.id} className="text-sm leading-relaxed text-ink-secondary">{field.helpText ?? field.label}</p>;
        }
        if (field.type === "textarea") {
          return (
            <Textarea
              key={field.id}
              id={id}
              label={field.label}
              hint={field.helpText}
              error={errors[field.id]}
              required={field.required}
              disabled={disabled}
              value={typeof value === "string" ? value : ""}
              onChange={(event) => onValueChange(field.id, event.currentTarget.value)}
            />
          );
        }
        if (field.type === "select") {
          return (
            <Select
              key={field.id}
              id={id}
              label={field.label}
              hint={field.helpText}
              error={errors[field.id]}
              required={field.required}
              disabled={disabled}
              value={typeof value === "string" ? value : ""}
              onChange={(event) => onValueChange(field.id, event.currentTarget.value)}
            >
              <option value="">Choose an option</option>
              {field.options?.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </Select>
          );
        }
        if (field.type === "checkbox") {
          return (
            <Checkbox
              key={field.id}
              id={id}
              label={field.label}
              description={field.helpText}
              required={field.required}
              disabled={disabled}
              checked={value === true}
              onChange={(event) => onValueChange(field.id, event.currentTarget.checked)}
            />
          );
        }
        return (
          <Input
            key={field.id}
            id={id}
            type={field.type}
            label={field.label}
            hint={field.helpText}
            error={errors[field.id]}
            required={field.required}
            disabled={disabled}
            value={typeof value === "string" ? value : ""}
            onChange={(event) => onValueChange(field.id, event.currentTarget.value)}
          />
        );
      })}
    </div>
  );
}

export interface FormFieldEditorProps {
  field: FormRenderField;
  onChange: (field: FormRenderField) => void;
  onMoveUp?: () => void;
  onMoveDown?: () => void;
  onRemove?: () => void;
  disabled?: boolean;
  children?: ReactNode;
}

export function FormFieldEditor({
  field,
  onChange,
  onMoveUp,
  onMoveDown,
  onRemove,
  disabled = false,
  children,
}: FormFieldEditorProps) {
  return (
    <Card
      title={field.label || "Untitled field"}
      footer={(
        <div className="flex flex-wrap justify-between gap-2">
          <div className="flex gap-2">
            {onMoveUp && <Button size="sm" variant="ghost" disabled={disabled} onClick={onMoveUp}>Move up</Button>}
            {onMoveDown && <Button size="sm" variant="ghost" disabled={disabled} onClick={onMoveDown}>Move down</Button>}
          </div>
          {onRemove && <Button size="sm" variant="danger" disabled={disabled} onClick={onRemove}>Remove field</Button>}
        </div>
      )}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Input
          label="Field label"
          disabled={disabled}
          value={field.label}
          onChange={(event) => onChange({ ...field, label: event.currentTarget.value })}
        />
        <Select
          label="Field type"
          disabled={disabled}
          value={field.type}
          onChange={(event) => onChange({ ...field, type: event.currentTarget.value as FormRenderFieldType })}
        >
          <option value="text">Short text</option>
          <option value="email">Email</option>
          <option value="url">URL</option>
          <option value="textarea">Long text</option>
          <option value="select">Select</option>
          <option value="checkbox">Checkbox</option>
          <option value="heading">Heading</option>
          <option value="guidance">Guidance</option>
        </Select>
        <Textarea
          className="sm:col-span-2"
          label="Help text"
          disabled={disabled}
          value={field.helpText ?? ""}
          onChange={(event) => onChange({ ...field, helpText: event.currentTarget.value || undefined })}
        />
        <Checkbox
          className="sm:col-span-2"
          label="Required"
          disabled={disabled}
          checked={field.required ?? false}
          onChange={(event) => onChange({ ...field, required: event.currentTarget.checked })}
        />
      </div>
      {children}
    </Card>
  );
}
