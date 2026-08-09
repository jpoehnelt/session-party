import { Separator as Primitive } from "radix-ui";
import type { ComponentPropsWithRef } from "react";
import { cx } from "./cx";

export type SeparatorProps = ComponentPropsWithRef<typeof Primitive.Root>;

export function Separator({ className, orientation = "horizontal", decorative = true, ...props }: SeparatorProps) {
  return (
    <Primitive.Root
      decorative={decorative}
      orientation={orientation}
      className={cx("shrink-0 bg-line-strong data-[orientation=horizontal]:h-0.5 data-[orientation=horizontal]:w-full data-[orientation=vertical]:h-full data-[orientation=vertical]:w-0.5", className)}
      {...props}
    />
  );
}
