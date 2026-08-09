import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** Merge conditional classes while resolving conflicting Tailwind utilities. */
export function cx(...parts: ClassValue[]): string {
  return twMerge(clsx(parts));
}
