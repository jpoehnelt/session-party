import { Slot } from "radix-ui";
import { createContext, useContext, useId, type ComponentPropsWithRef, type ReactNode } from "react";
import {
  Controller,
  FormProvider,
  useFormContext,
  type ControllerProps,
  type FieldPath,
  type FieldValues,
} from "react-hook-form";
import { cx } from "./cx";
import { Label } from "./Label";

export const Form = FormProvider;

interface FormFieldContextValue<TFieldValues extends FieldValues = FieldValues> {
  name: FieldPath<TFieldValues>;
}
const FormFieldContext = createContext<FormFieldContextValue | null>(null);

export function FormField<
  TFieldValues extends FieldValues = FieldValues,
  TName extends FieldPath<TFieldValues> = FieldPath<TFieldValues>,
>(props: ControllerProps<TFieldValues, TName>) {
  return <FormFieldContext.Provider value={{ name: props.name }}><Controller {...props} /></FormFieldContext.Provider>;
}

interface FormItemContextValue { id: string; }
const FormItemContext = createContext<FormItemContextValue | null>(null);

export function useFormField() {
  const fieldContext = useContext(FormFieldContext);
  const itemContext = useContext(FormItemContext);
  const { getFieldState, formState } = useFormContext();
  if (!fieldContext || !itemContext) throw new Error("useFormField must be used inside FormField and FormItem");
  const fieldState = getFieldState(fieldContext.name, formState);
  return {
    id: itemContext.id,
    name: fieldContext.name,
    formItemId: `${itemContext.id}-form-item`,
    formDescriptionId: `${itemContext.id}-form-item-description`,
    formMessageId: `${itemContext.id}-form-item-message`,
    ...fieldState,
  };
}

export type FormItemProps = ComponentPropsWithRef<"div">;
export function FormItem({ className, ...props }: FormItemProps) {
  const id = useId();
  return <FormItemContext.Provider value={{ id }}><div className={cx("space-y-2", className)} {...props} /></FormItemContext.Provider>;
}

export type FormLabelProps = ComponentPropsWithRef<typeof Label>;
export function FormLabel({ className, ...props }: FormLabelProps) {
  const { error, formItemId } = useFormField();
  return <Label htmlFor={formItemId} className={cx(error && "text-danger", className)} {...props} />;
}

export type FormControlProps = ComponentPropsWithRef<typeof Slot.Root>;
export function FormControl(props: FormControlProps) {
  const { error, formItemId, formDescriptionId, formMessageId } = useFormField();
  return (
    <Slot.Root
      id={formItemId}
      aria-describedby={error ? `${formDescriptionId} ${formMessageId}` : formDescriptionId}
      aria-invalid={Boolean(error)}
      {...props}
    />
  );
}

export type FormDescriptionProps = ComponentPropsWithRef<"p">;
export function FormDescription({ className, ...props }: FormDescriptionProps) {
  const { formDescriptionId } = useFormField();
  return <p id={formDescriptionId} className={cx("text-[13px] leading-relaxed text-ink-faint", className)} {...props} />;
}

export interface FormMessageProps extends Omit<ComponentPropsWithRef<"p">, "children"> { children?: ReactNode; }
export function FormMessage({ className, children, ...props }: FormMessageProps) {
  const { error, formMessageId } = useFormField();
  const body = error?.message ? String(error.message) : children;
  if (!body) return null;
  return <p id={formMessageId} className={cx("text-[13px] font-medium text-danger", className)} {...props}>{body}</p>;
}
