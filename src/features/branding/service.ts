import { Conflict, External, Forbidden, NotFound, Validation, type AppError } from "contracts/errors";
import { eventAuthorization } from "contracts/principal";
import { assets, eventMembers, events, installationBrands } from "contracts/schema";
import { Effect } from "effect";
import { and, eq, or } from "drizzle-orm";
import { nanoid } from "nanoid";
import { Authorizer, CurrentUser, Db, Files } from "@/server/services";
import type {
  BrandAsset,
  BrandAssetKind,
  EventBrand,
  InstallationBrand,
  InstallationBrandAdmin,
  UpdateEventBrandInput,
  UpdateInstallationBrandInput,
  UploadBrandAssetInput,
} from "./schema";

export const DEFAULT_INSTALLATION_BRAND: InstallationBrandAdmin = {
  configured: false,
  name: "Session Party",
  logoAssetId: null,
  faviconAssetId: null,
  primaryColor: "#896aff",
  font: "inter",
  appearance: "system",
  radius: "square",
  senderName: "Session Party",
  senderEmail: null,
  replyToEmail: null,
  version: 0,
};

const installationBrandId = "default";
export const brandAssetKey = (assetId: string) => `brand/${assetId}`;

const eventBrandAuthorization = eventAuthorization(
  { kind: "event-member", roles: ["owner", "admin"] },
  { kind: "deny" },
);

const database = <A>(run: () => Promise<A>): Effect.Effect<A, External> =>
  Effect.tryPromise({
    try: run,
    catch: (error) => new External({
      service: "database",
      detail: error instanceof Error ? error.message : String(error),
    }),
  });

type InstallationRow = typeof installationBrands.$inferSelect;
type EventRow = typeof events.$inferSelect;

const publicBrand = (row: InstallationRow | undefined): InstallationBrand => row ? {
  configured: true,
  name: row.name,
  logoAssetId: row.logoAssetId,
  faviconAssetId: row.faviconAssetId,
  primaryColor: row.primaryColor,
  font: row.font,
  appearance: row.appearance,
  radius: row.radius,
  version: row.version,
} : DEFAULT_INSTALLATION_BRAND;

const adminBrand = (row: InstallationRow | undefined): InstallationBrandAdmin => row ? {
  ...publicBrand(row),
  senderName: row.senderName,
  senderEmail: row.senderEmail,
  replyToEmail: row.replyToEmail,
} : DEFAULT_INSTALLATION_BRAND;

const findInstallationBrand = Effect.gen(function* () {
  const { db } = yield* Db;
  const [row] = yield* database(() => db
    .select()
    .from(installationBrands)
    .where(eq(installationBrands.id, installationBrandId))
    .limit(1));
  return row;
});

export const getInstallationBrand = (): Effect.Effect<InstallationBrand, AppError, Db> =>
  findInstallationBrand.pipe(Effect.map(publicBrand));

const requireInstallationOwner = (row: InstallationRow | undefined) =>
  Effect.gen(function* () {
    const principal = yield* CurrentUser;
    if (principal.kind !== "browser-session") {
      return yield* Effect.fail(new Forbidden({ reason: "Installation branding requires a browser session" }));
    }
    if (row && row.ownerUserId !== principal.userId) {
      return yield* Effect.fail(new Forbidden({ reason: "Installation owner required" }));
    }
    if (!row) {
      const { db } = yield* Db;
      const [anyOwner, principalOwner] = yield* Effect.all([
        database(() => db.select({ id: eventMembers.id }).from(eventMembers).where(eq(eventMembers.role, "owner")).limit(1)),
        database(() => db.select({ id: eventMembers.id }).from(eventMembers).where(and(
          eq(eventMembers.userId, principal.userId),
          eq(eventMembers.role, "owner"),
        )).limit(1)),
      ]);
      if (anyOwner[0] && !principalOwner[0]) {
        return yield* Effect.fail(new Forbidden({ reason: "An event owner must complete installation setup" }));
      }
    }
    return principal;
  });

export const getInstallationBrandAdmin = (): Effect.Effect<InstallationBrandAdmin, AppError, CurrentUser | Db> =>
  Effect.gen(function* () {
    const row = yield* findInstallationBrand;
    yield* requireInstallationOwner(row);
    return adminBrand(row);
  });

const findAsset = (id: string) =>
  Effect.gen(function* () {
    const { db } = yield* Db;
    const [asset] = yield* database(() => db.select().from(assets).where(eq(assets.id, id)).limit(1));
    if (!asset) return yield* Effect.fail(new Validation({ message: "Selected brand asset does not exist" }));
    return asset;
  });

const validateInstallationAsset = (id: string | null | undefined, purpose: BrandAssetKind) =>
  id == null ? Effect.void : Effect.gen(function* () {
    const asset = yield* findAsset(id);
    if (asset.eventId !== null || asset.brandKind !== purpose) {
      return yield* Effect.fail(new Validation({ message: `Selected asset is not an approved ${purpose}` }));
    }
  });

const validateEventAsset = (id: string | null | undefined, eventId: string, purpose: BrandAssetKind) =>
  id == null ? Effect.void : Effect.gen(function* () {
    const asset = yield* findAsset(id);
    if (asset.eventId !== eventId || asset.brandKind !== purpose) {
      return yield* Effect.fail(new Validation({ message: `Selected asset is not an approved ${purpose}` }));
    }
  });

export const updateInstallationBrand = (
  input: UpdateInstallationBrandInput,
): Effect.Effect<InstallationBrandAdmin, AppError, CurrentUser | Db> =>
  Effect.gen(function* () {
    const { db } = yield* Db;
    const existing = yield* findInstallationBrand;
    const principal = yield* requireInstallationOwner(existing);
    if ((existing?.version ?? 0) !== input.expectedVersion) {
      return yield* Effect.fail(new Conflict({ message: "Brand settings changed; reload before saving" }));
    }
    yield* validateInstallationAsset(input.logoAssetId, "installation-logo");
    yield* validateInstallationAsset(input.faviconAssetId, "installation-favicon");

    const now = new Date();
    const values = {
      name: input.name.trim(),
      logoAssetId: input.logoAssetId === undefined ? existing?.logoAssetId ?? null : input.logoAssetId,
      faviconAssetId: input.faviconAssetId === undefined ? existing?.faviconAssetId ?? null : input.faviconAssetId,
      primaryColor: input.primaryColor.toLowerCase(),
      font: input.font,
      appearance: input.appearance,
      radius: input.radius,
      senderName: input.senderName.trim(),
      senderEmail: input.senderEmail === undefined ? existing?.senderEmail ?? null : input.senderEmail,
      replyToEmail: input.replyToEmail === undefined ? existing?.replyToEmail ?? null : input.replyToEmail,
      updatedAt: now,
      version: (existing?.version ?? 0) + 1,
    } as const;
    const [saved] = existing
      ? yield* database(() => db.update(installationBrands).set(values).where(and(
          eq(installationBrands.id, installationBrandId),
          eq(installationBrands.version, input.expectedVersion),
        )).returning())
      : yield* database(() => db.insert(installationBrands).values({
          id: installationBrandId,
          ownerUserId: principal.userId,
          createdAt: now,
          ...values,
        }).returning());
    if (!saved) return yield* Effect.fail(new Conflict({ message: "Brand settings changed; reload before saving" }));
    return adminBrand(saved);
  });

const findEvent = (idOrSlug: string) => Effect.gen(function* () {
  const { db } = yield* Db;
  const [event] = yield* database(() => db.select().from(events).where(or(
    eq(events.id, idOrSlug),
    eq(events.slug, idOrSlug),
  )).limit(1));
  if (!event) return yield* Effect.fail(new NotFound({ entity: "event", id: idOrSlug }));
  return event;
});

const eventBrand = (event: EventRow, installation: InstallationBrand): EventBrand => {
  const inherit = event.inheritInstallationBrand;
  const eventPrimaryColor = event.accentColor && /^#[0-9a-fA-F]{6}$/.test(event.accentColor)
    ? event.accentColor.toLowerCase()
    : null;
  return {
    eventId: event.id,
    publicName: event.publicName ?? event.name,
    inheritInstallationBrand: inherit,
    logoAssetId: event.logoAssetId,
    bannerAssetId: event.bannerAssetId,
    primaryColor: eventPrimaryColor,
    effectiveLogoAssetId: inherit ? installation.logoAssetId : event.logoAssetId ?? installation.logoAssetId,
    effectivePrimaryColor: inherit ? installation.primaryColor : eventPrimaryColor ?? installation.primaryColor,
    font: installation.font,
    appearance: installation.appearance,
    radius: installation.radius,
    version: event.version,
  };
};

export const getEventBrand = (
  idOrSlug: string,
): Effect.Effect<EventBrand, AppError, Db> =>
  Effect.gen(function* () {
    const [event, installation] = yield* Effect.all([
      findEvent(idOrSlug),
      getInstallationBrand(),
    ]);
    return eventBrand(event, installation);
  });

const authorizeEventBrand = (eventId: string) => Effect.gen(function* () {
  const principal = yield* CurrentUser;
  const { authorize } = yield* Authorizer;
  yield* authorize({ principal, policy: eventBrandAuthorization, eventId });
});

export const updateEventBrand = (
  input: UpdateEventBrandInput,
): Effect.Effect<EventBrand, AppError, Authorizer | CurrentUser | Db> =>
  Effect.gen(function* () {
    const { db } = yield* Db;
    const event = yield* findEvent(input.eventId);
    yield* authorizeEventBrand(event.id);
    if (event.version !== input.expectedVersion) {
      return yield* Effect.fail(new Conflict({ message: "Event appearance changed; reload before saving" }));
    }
    yield* validateEventAsset(input.logoAssetId, event.id, "event-logo");
    yield* validateEventAsset(input.bannerAssetId, event.id, "event-banner");
    const [saved] = yield* database(() => db.update(events).set({
      publicName: input.publicName.trim(),
      inheritInstallationBrand: input.inheritInstallationBrand,
      logoAssetId: input.logoAssetId === undefined ? event.logoAssetId : input.logoAssetId,
      bannerAssetId: input.bannerAssetId === undefined ? event.bannerAssetId : input.bannerAssetId,
      accentColor: input.primaryColor === undefined ? event.accentColor : input.primaryColor?.toLowerCase() ?? null,
      version: event.version + 1,
      updatedAt: new Date(),
    }).where(and(eq(events.id, event.id), eq(events.version, input.expectedVersion))).returning());
    if (!saved) return yield* Effect.fail(new Conflict({ message: "Event appearance changed; reload before saving" }));
    const installation = yield* getInstallationBrand();
    return eventBrand(saved, installation);
  });

const allowedContentTypes = new Set(["image/png", "image/jpeg", "image/webp", "image/x-icon", "image/vnd.microsoft.icon"]);

const decodedImage = (input: UploadBrandAssetInput) => Effect.try({
  try: () => {
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(input.contentBase64)) throw new Error("invalid base64");
    const binary = atob(input.contentBase64);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const contentType = input.contentType.toLowerCase();
    if (!allowedContentTypes.has(contentType)) throw new Error("unsupported image type");
    const isPng = bytes.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => bytes[index] === byte);
    const isJpeg = bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    const isWebp = bytes.length >= 12
      && new TextDecoder().decode(bytes.slice(0, 4)) === "RIFF"
      && new TextDecoder().decode(bytes.slice(8, 12)) === "WEBP";
    const isIco = bytes.length >= 4 && bytes[0] === 0 && bytes[1] === 0 && bytes[2] === 1 && bytes[3] === 0;
    const matches = contentType === "image/png" ? isPng
      : contentType === "image/jpeg" ? isJpeg
      : contentType === "image/webp" ? isWebp
      : isIco;
    if (!matches) throw new Error("image contents do not match the declared type");
    const maxSize = input.kind === "installation-favicon" ? 1_000_000 : 5_000_000;
    if (bytes.byteLength > maxSize) throw new Error(`image exceeds ${Math.round(maxSize / 1_000_000)} MB`);
    return { bytes, contentType };
  },
  catch: (error) => new Validation({ message: error instanceof Error ? error.message : "Invalid image" }),
});

export const uploadBrandAsset = (
  input: UploadBrandAssetInput,
): Effect.Effect<BrandAsset, AppError, Authorizer | CurrentUser | Db | Files> =>
  Effect.gen(function* () {
    const principal = yield* CurrentUser;
    if (principal.kind !== "browser-session") {
      return yield* Effect.fail(new Forbidden({ reason: "Brand uploads require a browser session" }));
    }
    const installationUpload = input.kind.startsWith("installation-");
    let eventId: string | null = null;
    if (installationUpload) {
      if (input.eventId) return yield* Effect.fail(new Validation({ message: "Installation assets cannot be event-scoped" }));
      const installation = yield* findInstallationBrand;
      yield* requireInstallationOwner(installation);
    } else {
      if (!input.eventId) return yield* Effect.fail(new Validation({ message: "Event assets require an eventId" }));
      const event = yield* findEvent(input.eventId);
      yield* authorizeEventBrand(event.id);
      eventId = event.id;
    }
    const { bytes, contentType } = yield* decodedImage(input);
    const assetId = nanoid();
    const key = brandAssetKey(assetId);
    const files = yield* Files;
    yield* files.put(key, bytes, {
      httpMetadata: { contentType, contentDisposition: "inline" },
      customMetadata: { brandPurpose: input.kind },
    });
    const { db } = yield* Db;
    const now = new Date();
    const inserted = yield* database(() => db.insert(assets).values({
      id: assetId,
      eventId,
      uploaderUserId: principal.userId,
      brandKind: input.kind,
      filename: input.filename,
      contentType,
      size: bytes.byteLength,
      createdAt: now,
      updatedAt: now,
    }).returning()).pipe(Effect.either);
    if (inserted._tag === "Left") {
      yield* files.delete(key).pipe(Effect.ignore);
      return yield* Effect.fail(inserted.left);
    }
    const asset = inserted.right[0];
    if (!asset) {
      yield* files.delete(key).pipe(Effect.ignore);
      return yield* Effect.fail(new External({ service: "database", detail: "Brand asset insert returned no row" }));
    }
    return { id: asset.id, filename: asset.filename, contentType: asset.contentType, size: asset.size, url: `/api/v1/assets/${asset.id}` };
  });

export interface ApprovedBrandAsset {
  readonly object: R2ObjectBody;
  readonly filename: string;
  readonly contentType: string;
}

export const getApprovedBrandAsset = (
  assetId: string,
): Effect.Effect<ApprovedBrandAsset, AppError, Db | Files> =>
  Effect.gen(function* () {
    const { db } = yield* Db;
    const [asset] = yield* database(() => db.select().from(assets).where(eq(assets.id, assetId)).limit(1));
    if (!asset?.brandKind) {
      return yield* Effect.fail(new NotFound({ entity: "brand asset", id: assetId }));
    }
    const files = yield* Files;
    const object = yield* files.get(brandAssetKey(assetId));
    if (!object) return yield* Effect.fail(new NotFound({ entity: "brand asset", id: assetId }));
    return { object, filename: asset.filename, contentType: asset.contentType };
  });
