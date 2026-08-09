import { Schema } from "effect";

export const PublicationBySlugInput = Schema.Struct({
  eventSlug: Schema.String.pipe(
    Schema.minLength(2),
    Schema.maxLength(80),
    Schema.pattern(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  ),
});
export type PublicationBySlugInput = typeof PublicationBySlugInput.Type;
