import { Command as Primitive } from "cmdk";
import { Search } from "lucide-react";
import type { ComponentPropsWithRef } from "react";
import { cx } from "./cx";

export type CommandProps = ComponentPropsWithRef<typeof Primitive>;
export function Command({ className, ...props }: CommandProps) {
  return <Primitive className={cx("flex size-full flex-col overflow-hidden rounded-control bg-surface text-ink", className)} {...props} />;
}

export type CommandInputProps = ComponentPropsWithRef<typeof Primitive.Input>;
export function CommandInput({ className, ...props }: CommandInputProps) {
  return <div className="flex items-center border-b-2 border-line-strong px-3" cmdk-input-wrapper=""><Search className="mr-2 size-4 shrink-0 text-ink-faint" aria-hidden="true" /><Primitive.Input className={cx("flex h-11 w-full bg-transparent py-3 text-sm font-bold text-ink outline-none placeholder:font-normal placeholder:text-ink-faint disabled:cursor-not-allowed disabled:opacity-50", className)} {...props} /></div>;
}

export type CommandListProps = ComponentPropsWithRef<typeof Primitive.List>;
export function CommandList({ className, ...props }: CommandListProps) {
  return <Primitive.List className={cx("max-h-72 overflow-x-hidden overflow-y-auto", className)} {...props} />;
}

export type CommandEmptyProps = ComponentPropsWithRef<typeof Primitive.Empty>;
export function CommandEmpty({ className, ...props }: CommandEmptyProps) {
  return <Primitive.Empty className={cx("py-8 text-center text-sm text-ink-secondary", className)} {...props} />;
}

export type CommandGroupProps = ComponentPropsWithRef<typeof Primitive.Group>;
export function CommandGroup({ className, ...props }: CommandGroupProps) {
  return <Primitive.Group className={cx("overflow-hidden p-1 text-ink [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-[10px] [&_[cmdk-group-heading]]:font-black [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-[0.1em] [&_[cmdk-group-heading]]:text-ink-faint", className)} {...props} />;
}

export type CommandSeparatorProps = ComponentPropsWithRef<typeof Primitive.Separator>;
export function CommandSeparator({ className, ...props }: CommandSeparatorProps) {
  return <div {...props} role="presentation" className={cx("-mx-1 h-0.5 bg-line-strong", className)} />;
}

export type CommandItemProps = ComponentPropsWithRef<typeof Primitive.Item>;
export function CommandItem({ className, ...props }: CommandItemProps) {
  return <Primitive.Item className={cx("relative flex cursor-default select-none items-center rounded-control px-2 py-2 text-sm font-bold outline-none data-[disabled=true]:pointer-events-none data-[selected=true]:bg-production-sky data-[disabled=true]:opacity-50", className)} {...props} />;
}

export type CommandShortcutProps = ComponentPropsWithRef<"span">;
export function CommandShortcut({ className, ...props }: CommandShortcutProps) {
  return <span className={cx("ml-auto text-xs tracking-widest text-ink-faint", className)} {...props} />;
}
