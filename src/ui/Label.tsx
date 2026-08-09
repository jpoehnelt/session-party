import { Label as RadixLabel } from "radix-ui";
import type { ComponentPropsWithRef } from "react";
import { cx } from "./cx";

export type LabelProps = ComponentPropsWithRef<typeof RadixLabel.Root>;

export function Label({ className, ...props }: LabelProps) {
  return (
    <RadixLabel.Root
      className={cx("text-[13px] font-medium leading-none text-ink peer-disabled:cursor-not-allowed peer-disabled:opacity-60", className)}
      {...props}
    />
  );
}
