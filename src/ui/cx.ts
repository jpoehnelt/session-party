/** Joins truthy class fragments. Internal — not part of the kit's public API. */
export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}
