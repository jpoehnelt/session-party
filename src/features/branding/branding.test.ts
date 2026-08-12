import { applyD1Migrations, env, type D1Migration } from "cloudflare:test";
import type { AppError } from "contracts/errors";
import type { BrowserSessionPrincipal } from "contracts/principal";
import { eventMembers, events, users } from "contracts/schema";
import { drizzle } from "drizzle-orm/d1";
import { Effect, Layer } from "effect";
import { beforeAll, describe, expect, it } from "vitest";
import { AppLayer, CurrentUser, type Authorizer, type Db, type Files } from "@/server/services";
import {
  getEventBrand,
  getInstallationBrand,
  getInstallationBrandAdmin,
  updateEventBrand,
  updateInstallationBrand,
  uploadBrandAsset,
} from "./service";
import { brandInitials, deriveBrandColors } from "./colors";

type TestEnv = Cloudflare.Env & { readonly TEST_MIGRATIONS: readonly D1Migration[] };
type Requirements = Authorizer | CurrentUser | Db | Files;

const principal = (userId: string): BrowserSessionPrincipal => ({
  kind: "browser-session",
  userId,
  email: `${userId}@example.com`,
  name: userId,
  sessionId: `session-${userId}`,
  expiresAt: Date.UTC(2100, 0, 1),
});

const owner = principal("brand-owner");
const outsider = principal("brand-outsider");

const runEither = <A>(
  actor: BrowserSessionPrincipal,
  effect: Effect.Effect<A, AppError, Requirements>,
) => Effect.runPromise(effect.pipe(
  Effect.either,
  Effect.provide(Layer.merge(AppLayer(env), Layer.succeed(CurrentUser, actor))),
));

const run = async <A>(actor: BrowserSessionPrincipal, effect: Effect.Effect<A, AppError, Requirements>): Promise<A> => {
  const result = await runEither(actor, effect);
  if (result._tag === "Left") throw result.left;
  return result.right;
};

beforeAll(async () => {
  if (!("TEST_MIGRATIONS" in env)) throw new Error("TEST_MIGRATIONS binding unavailable");
  await applyD1Migrations(env.DB, [...(env as TestEnv).TEST_MIGRATIONS]);
  const db = drizzle(env.DB);
  const now = new Date();
  await db.insert(users).values([owner, outsider].map((actor) => ({
    id: actor.userId,
    email: actor.email,
    name: actor.name,
    createdAt: now,
    updatedAt: now,
  })));
  await db.insert(events).values({
    id: "brand-event",
    slug: "brand-event",
    name: "Internal Event Name",
    timezone: "UTC",
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(eventMembers).values({
    id: "brand-owner-membership",
    eventId: "brand-event",
    userId: owner.userId,
    role: "owner",
    createdAt: now,
    updatedAt: now,
  });
});

describe("runtime branding", () => {
  it("derives readable foregrounds across light and dark primary colors", () => {
    for (const primary of ["#1264a3", "#ffd34e", "#171714", "#f3efe3"]) {
      expect(deriveBrandColors(primary).contrast).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("derives recognizable fallback marks from organization names", () => {
    expect(brandInitials("Session Party")).toBe("SP");
    expect(brandInitials("Northstar")).toBe("NO");
    expect(brandInitials("  ")).toBe("SP");
  });

  it("returns an accessible public fallback before setup", async () => {
    const brand = await Effect.runPromise(getInstallationBrand().pipe(Effect.provide(AppLayer(env))));
    expect(brand).toMatchObject({ configured: false, name: "Session Party", primaryColor: "#896aff", version: 0 });
  });

  it("lets the first authenticated administrator claim setup and keeps it owner-only", async () => {
    const saved = await run(owner, updateInstallationBrand({
      expectedVersion: 0,
      name: "Northstar Events",
      logoAssetId: null,
      faviconAssetId: null,
      primaryColor: "#1264a3",
      font: "manrope",
      appearance: "system",
      radius: "soft",
      senderName: "Northstar Events",
      senderEmail: "hello@northstar.example",
      replyToEmail: "support@northstar.example",
    }));
    expect(saved).toMatchObject({ configured: true, name: "Northstar Events", version: 1 });

    const denied = await runEither(outsider, getInstallationBrandAdmin());
    expect(denied._tag).toBe("Left");
    if (denied._tag === "Left") expect(denied.left._tag).toBe("Forbidden");
  });

  it("stores safe R2 assets and resolves event overrides independently", async () => {
    const onePixelPng = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
    const logo = await run(owner, uploadBrandAsset({
      kind: "event-logo",
      eventId: "brand-event",
      filename: "logo.png",
      contentType: "image/png",
      contentBase64: onePixelPng,
    }));
    const saved = await run(owner, updateEventBrand({
      eventId: "brand-event",
      expectedVersion: 1,
      publicName: "Northstar Summit",
      inheritInstallationBrand: false,
      logoAssetId: logo.id,
      bannerAssetId: null,
      primaryColor: "#e44d26",
    }));
    expect(saved).toMatchObject({
      publicName: "Northstar Summit",
      effectiveLogoAssetId: logo.id,
      effectivePrimaryColor: "#e44d26",
      font: "manrope",
    });
    const publicBrand = await Effect.runPromise(getEventBrand("brand-event").pipe(Effect.provide(AppLayer(env))));
    expect(publicBrand.publicName).toBe("Northstar Summit");
  });
});
