import { ScrollArea as Primitive } from "radix-ui";
import type { ComponentPropsWithRef } from "react";
import { cx } from "./cx";

export type ScrollAreaProps = ComponentPropsWithRef<typeof Primitive.Root>;
export function ScrollArea({ className, children, ...props }: ScrollAreaProps) {
  return (
    <Primitive.Root className={cx("relative overflow-hidden", className)} {...props}>
      <Primitive.Viewport className="size-full rounded-[inherit]">{children}</Primitive.Viewport>
      <ScrollBar />
      <Primitive.Corner />
    </Primitive.Root>
  );
}

export type ScrollBarProps = ComponentPropsWithRef<typeof Primitive.Scrollbar>;
export function ScrollBar({ className, orientation = "vertical", ...props }: ScrollBarProps) {
  return (
    <Primitive.Scrollbar
      orientation={orientation}
      className={cx("flex touch-none select-none p-px transition-colors data-[orientation=horizontal]:h-2.5 data-[orientation=horizontal]:flex-col data-[orientation=vertical]:h-full data-[orientation=vertical]:w-2.5", className)}
      {...props}
    >
      <Primitive.Thumb className="relative flex-1 rounded-full bg-line-strong" />
    </Primitive.Scrollbar>
  );
}
