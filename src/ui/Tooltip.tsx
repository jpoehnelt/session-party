import { Tooltip as Primitive } from "radix-ui";
import type { ComponentPropsWithRef } from "react";
import { cx } from "./cx";

export const TooltipProvider = Primitive.Provider;
export const Tooltip = Primitive.Root;
export const TooltipTrigger = Primitive.Trigger;

export type TooltipContentProps = ComponentPropsWithRef<typeof Primitive.Content>;
export function TooltipContent({ className, sideOffset = 5, ...props }: TooltipContentProps) {
  return (
    <Primitive.Portal>
      <Primitive.Content sideOffset={sideOffset} className={cx("z-50 max-w-xs rounded-md bg-ink px-3 py-1.5 text-xs leading-snug text-canvas shadow-pop", className)} {...props}>
        {props.children}
        <Primitive.Arrow className="fill-ink" />
      </Primitive.Content>
    </Primitive.Portal>
  );
}
