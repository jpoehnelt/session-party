import { Schema } from "effect";

export const BrandFont = Schema.Literal("system", "inter", "manrope", "source-sans");
export type BrandFont = typeof BrandFont.Type;

export const BrandAppearance = Schema.Literal("light", "dark", "system");
export type BrandAppearance = typeof BrandAppearance.Type;

export const BrandRadius = Schema.Literal("square", "soft", "round");
export type BrandRadius = typeof BrandRadius.Type;

export const BrandColor = Schema.String.pipe(
  Schema.pattern(/^#[0-9a-fA-F]{6}$/),
);

const AssetId = Schema.NullOr(Schema.String);
const OptionalAssetId = Schema.optional(AssetId);
const OptionalEmail = Schema.optional(Schema.NullOr(
  Schema.String.pipe(
    Schema.maxLength(254),
    Schema.pattern(/^[^\s@]+@[^\s@]+\.[^\s@]+$/),
  ),
));

export const InstallationBrand = Schema.Struct({
  configured: Schema.Boolean,
  name: Schema.String,
  logoAssetId: AssetId,
  faviconAssetId: AssetId,
  primaryColor: BrandColor,
  font: BrandFont,
  appearance: BrandAppearance,
  radius: BrandRadius,
  version: Schema.Int.pipe(Schema.nonNegative()),
});
export type InstallationBrand = typeof InstallationBrand.Type;

export const InstallationBrandAdmin = Schema.extend(
  InstallationBrand,
  Schema.Struct({
    senderName: Schema.String,
    senderEmail: Schema.NullOr(Schema.String),
    replyToEmail: Schema.NullOr(Schema.String),
  }),
);
export type InstallationBrandAdmin = typeof InstallationBrandAdmin.Type;

export const UpdateInstallationBrandInput = Schema.Struct({
  expectedVersion: Schema.Int.pipe(Schema.nonNegative()),
  name: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(120), Schema.pattern(/^[^\r\n]+$/)),
  logoAssetId: OptionalAssetId,
  faviconAssetId: OptionalAssetId,
  primaryColor: BrandColor,
  font: BrandFont,
  appearance: BrandAppearance,
  radius: BrandRadius,
  senderName: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(120), Schema.pattern(/^[^\r\n]+$/)),
  senderEmail: OptionalEmail,
  replyToEmail: OptionalEmail,
});
export type UpdateInstallationBrandInput = typeof UpdateInstallationBrandInput.Type;

export const EventBrand = Schema.Struct({
  eventId: Schema.String,
  publicName: Schema.String,
  inheritInstallationBrand: Schema.Boolean,
  logoAssetId: AssetId,
  bannerAssetId: AssetId,
  primaryColor: Schema.NullOr(BrandColor),
  effectiveLogoAssetId: AssetId,
  effectivePrimaryColor: BrandColor,
  font: BrandFont,
  appearance: BrandAppearance,
  radius: BrandRadius,
  version: Schema.Int.pipe(Schema.positive()),
});
export type EventBrand = typeof EventBrand.Type;

export const GetEventBrandInput = Schema.Struct({
  eventId: Schema.String.pipe(Schema.minLength(1)),
});

export const UpdateEventBrandInput = Schema.Struct({
  eventId: Schema.String.pipe(Schema.minLength(1)),
  expectedVersion: Schema.Int.pipe(Schema.positive()),
  publicName: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(200)),
  inheritInstallationBrand: Schema.Boolean,
  logoAssetId: OptionalAssetId,
  bannerAssetId: OptionalAssetId,
  primaryColor: Schema.optional(Schema.NullOr(BrandColor)),
});
export type UpdateEventBrandInput = typeof UpdateEventBrandInput.Type;

export const BrandAssetKind = Schema.Literal(
  "installation-logo",
  "installation-favicon",
  "event-logo",
  "event-banner",
);
export type BrandAssetKind = typeof BrandAssetKind.Type;

export const UploadBrandAssetInput = Schema.Struct({
  kind: BrandAssetKind,
  eventId: Schema.optional(Schema.String.pipe(Schema.minLength(1))),
  filename: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(255)),
  contentType: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(100)),
  contentBase64: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(7_000_000)),
});
export type UploadBrandAssetInput = typeof UploadBrandAssetInput.Type;

export const BrandAsset = Schema.Struct({
  id: Schema.String,
  filename: Schema.String,
  contentType: Schema.String,
  size: Schema.Int.pipe(Schema.nonNegative()),
  url: Schema.String,
});
export type BrandAsset = typeof BrandAsset.Type;
