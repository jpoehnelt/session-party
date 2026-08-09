import { Popover as Primitive } from "radix-ui";
import type { ComponentPropsWithRef } from "react";
import { cx } from "./cx";

export const Popover = Primitive.Root;
export const PopoverTrigger = Primitive.Trigger;
export const PopoverAnchor = Primitive.Anchor;

export type PopoverContentProps = ComponentPropsWithRef<typeof Primitive.Content>;
export function PopoverContent({ className, align = "center", sideOffset = 6, ...props }: PopoverContentProps) {
  return (
    <Primitive.Portal>
      <Primitive.Content align={align} sideOffset={sideOffset} className={cx("z-50 w-72 rounded-control border border-line bg-surface p-4 text-ink shadow-pop outline-none", className)} {...props} />
    </Primitive.Portal>
  );
}
