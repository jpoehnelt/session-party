import { useId, type ComponentPropsWithRef, type ReactNode } from "react";
import { cx } from "./cx";
import { ChevronDownIcon } from "./icons";

const FIELD =
  "w-full rounded-control border-2 border-line-strong bg-surface px-3 text-sm font-medium text-ink shadow-xs outline-none transition-colors placeholder:font-normal placeholder:text-ink-faint focus:border-accent focus:ring-2 focus:ring-accent/25 disabled:cursor-not-allowed disabled:bg-surface-muted disabled:text-ink-faint";

const FIELD_ERROR = "border-danger focus:border-danger focus:ring-danger/20";

interface FieldChrome {
  label?: string;
  error?: string;
  hint?: string;
}

function FieldShell({
  id,
  label,
  error,
  hint,
  children,
}: FieldChrome & { id: string; children: ReactNode }) {
  return (
    <div className="flex w-full flex-col gap-1.5">
      {label && (
        <label htmlFor={id} className="text-[11px] font-black uppercase tracking-[0.08em] text-ink-secondary">
          {label}
        </label>
      )}
      {children}
      {error ? (
        <p className="text-[13px] text-danger">{error}</p>
      ) : hint ? (
        <p className="text-[13px] text-ink-faint">{hint}</p>
      ) : null}
    </div>
  );
}

export interface InputProps extends ComponentPropsWithRef<"input">, FieldChrome {}

export function Input({ label, error, hint, className, id, ...rest }: InputProps) {
  const autoId = useId();
  const inputId = id ?? autoId;
  return (
    <FieldShell id={inputId} label={label} error={error} hint={hint}>
      <input
        {...rest}
        id={inputId}
        aria-invalid={error ? true : undefined}
        className={cx(FIELD, "h-10", error && FIELD_ERROR, className)}
      />
    </FieldShell>
  );
}

export interface TextareaProps
  extends ComponentPropsWithRef<"textarea">,
    FieldChrome {}

export function Textarea({
  label,
  error,
  hint,
  className,
  id,
  rows = 4,
  ...rest
}: TextareaProps) {
  const autoId = useId();
  const inputId = id ?? autoId;
  return (
    <FieldShell id={inputId} label={label} error={error} hint={hint}>
      <textarea
        {...rest}
        id={inputId}
        rows={rows}
        aria-invalid={error ? true : undefined}
        className={cx(FIELD, "py-2.5 leading-relaxed", error && FIELD_ERROR, className)}
      />
    </FieldShell>
  );
}

export interface SelectProps extends ComponentPropsWithRef<"select">, FieldChrome {}

export function Select({
  label,
  error,
  hint,
  className,
  id,
  children,
  ...rest
}: SelectProps) {
  const autoId = useId();
  const inputId = id ?? autoId;
  return (
    <FieldShell id={inputId} label={label} error={error} hint={hint}>
      <div className="relative">
        <select
          {...rest}
          id={inputId}
          aria-invalid={error ? true : undefined}
          className={cx(
            FIELD,
            "h-10 appearance-none pr-9",
            error && FIELD_ERROR,
            className,
          )}
        >
          {children}
        </select>
        <ChevronDownIcon className="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 text-ink-faint" />
      </div>
    </FieldShell>
  );
}

export interface CheckboxProps
  extends Omit<ComponentPropsWithRef<"input">, "type">,
    Pick<FieldChrome, "label"> {
  description?: string;
}

export function Checkbox({
  label,
  description,
  className,
  id,
  ...rest
}: CheckboxProps) {
  const autoId = useId();
  const inputId = id ?? autoId;
  return (
    <div className={cx("flex items-start gap-2.5", className)}>
      <input
        {...rest}
        id={inputId}
        type="checkbox"
        className="mt-0.5 size-4 shrink-0 rounded-none border-2 border-line-strong accent-accent outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-canvas"
      />
      {(label || description) && (
        <label htmlFor={inputId} className="flex select-none flex-col gap-0.5">
          {label && <span className="text-sm font-bold text-ink">{label}</span>}
          {description && (
            <span className="text-[13px] text-ink-faint">{description}</span>
          )}
        </label>
      )}
    </div>
  );
}
