import { Check, ChevronRight, Circle } from "lucide-react";
import { DropdownMenu as Primitive } from "radix-ui";
import type { ComponentPropsWithRef } from "react";
import { cx } from "./cx";

export const DropdownMenu = Primitive.Root;
export const DropdownMenuTrigger = Primitive.Trigger;
export const DropdownMenuGroup = Primitive.Group;
export const DropdownMenuPortal = Primitive.Portal;
export const DropdownMenuSub = Primitive.Sub;
export const DropdownMenuRadioGroup = Primitive.RadioGroup;

export type DropdownMenuContentProps = ComponentPropsWithRef<typeof Primitive.Content>;
export function DropdownMenuContent({ className, sideOffset = 6, ...props }: DropdownMenuContentProps) {
  return <Primitive.Portal><Primitive.Content sideOffset={sideOffset} className={cx("z-50 min-w-44 overflow-hidden rounded-control border border-line bg-surface p-1 text-ink shadow-pop outline-none", className)} {...props} /></Primitive.Portal>;
}

export type DropdownMenuSubContentProps = ComponentPropsWithRef<typeof Primitive.SubContent>;
export function DropdownMenuSubContent({ className, ...props }: DropdownMenuSubContentProps) {
  return <Primitive.Portal><Primitive.SubContent className={cx("z-50 min-w-40 overflow-hidden rounded-control border border-line bg-surface p-1 text-ink shadow-pop outline-none", className)} {...props} /></Primitive.Portal>;
}

export interface DropdownMenuSubTriggerProps extends ComponentPropsWithRef<typeof Primitive.SubTrigger> { inset?: boolean; }
export function DropdownMenuSubTrigger({ className, inset, children, ...props }: DropdownMenuSubTriggerProps) {
  return <Primitive.SubTrigger className={cx("flex cursor-default select-none items-center rounded-md px-2 py-1.5 text-sm outline-none focus:bg-surface-muted data-[state=open]:bg-surface-muted", inset && "pl-8", className)} {...props}>{children}<ChevronRight className="ml-auto size-4" /></Primitive.SubTrigger>;
}

export interface DropdownMenuItemProps extends ComponentPropsWithRef<typeof Primitive.Item> { inset?: boolean; }
export function DropdownMenuItem({ className, inset, ...props }: DropdownMenuItemProps) {
  return <Primitive.Item className={cx("relative flex cursor-default select-none items-center rounded-md px-2 py-1.5 text-sm outline-none transition-colors focus:bg-surface-muted focus:text-ink data-[disabled]:pointer-events-none data-[disabled]:opacity-50", inset && "pl-8", className)} {...props} />;
}

export type DropdownMenuCheckboxItemProps = ComponentPropsWithRef<typeof Primitive.CheckboxItem>;
export function DropdownMenuCheckboxItem({ className, children, checked, ...props }: DropdownMenuCheckboxItemProps) {
  return <Primitive.CheckboxItem checked={checked} className={cx("relative flex cursor-default select-none items-center rounded-md py-1.5 pl-8 pr-2 text-sm outline-none focus:bg-surface-muted data-[disabled]:pointer-events-none data-[disabled]:opacity-50", className)} {...props}><span className="absolute left-2 flex size-4 items-center justify-center"><Primitive.ItemIndicator><Check className="size-4" /></Primitive.ItemIndicator></span>{children}</Primitive.CheckboxItem>;
}

export type DropdownMenuRadioItemProps = ComponentPropsWithRef<typeof Primitive.RadioItem>;
export function DropdownMenuRadioItem({ className, children, ...props }: DropdownMenuRadioItemProps) {
  return <Primitive.RadioItem className={cx("relative flex cursor-default select-none items-center rounded-md py-1.5 pl-8 pr-2 text-sm outline-none focus:bg-surface-muted data-[disabled]:pointer-events-none data-[disabled]:opacity-50", className)} {...props}><span className="absolute left-2 flex size-4 items-center justify-center"><Primitive.ItemIndicator><Circle className="size-2 fill-current" /></Primitive.ItemIndicator></span>{children}</Primitive.RadioItem>;
}

export interface DropdownMenuLabelProps extends ComponentPropsWithRef<typeof Primitive.Label> { inset?: boolean; }
export function DropdownMenuLabel({ className, inset, ...props }: DropdownMenuLabelProps) {
  return <Primitive.Label className={cx("px-2 py-1.5 text-xs font-semibold uppercase tracking-wide text-ink-faint", inset && "pl-8", className)} {...props} />;
}

export type DropdownMenuSeparatorProps = ComponentPropsWithRef<typeof Primitive.Separator>;
export function DropdownMenuSeparator({ className, ...props }: DropdownMenuSeparatorProps) {
  return <Primitive.Separator className={cx("-mx-1 my-1 h-px bg-line", className)} {...props} />;
}

export type DropdownMenuShortcutProps = ComponentPropsWithRef<"span">;
export function DropdownMenuShortcut({ className, ...props }: DropdownMenuShortcutProps) {
  return <span className={cx("ml-auto text-xs tracking-widest text-ink-faint", className)} {...props} />;
}
