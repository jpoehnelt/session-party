import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  RUBRIC_TYPES,
  type EvidencePlan,
  type RubricManifest,
  type Testability,
} from "./model.ts";

const MANIFEST_URL = new URL("../../rubric/manifest.json", import.meta.url);
const EXPECTED_REVISION = "2b0f7956ab0c6f4868d41356e495b3a225badaab";
const TESTABILITY = new Set<Testability>(["auto", "auto-partial", "manual"]);

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const fail = (message: string): never => {
  throw new Error(`Rubric manifest invalid: ${message}`);
};

export function loadManifest(): RubricManifest {
  const path = fileURLToPath(MANIFEST_URL);
  const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (!isObject(parsed)) fail("root must be an object");
  const root = parsed as Record<string, unknown>;
  if (root.schemaVersion !== 1) fail("schemaVersion must be 1");
  if (!isObject(root.source) || root.source.revision !== EXPECTED_REVISION) {
    fail(`source revision must remain locked to ${EXPECTED_REVISION}`);
  }
  if (!Array.isArray(root.areas)) fail("areas must be an array");
  const rawAreas = root.areas as unknown[];

  const ids = new Set<string>();
  const areas: RubricManifest["areas"] = rawAreas.map((candidate: unknown, areaIndex: number) => {
    if (!isObject(candidate)) fail(`areas[${areaIndex}] must be an object`);
    const areaObject = candidate as Record<string, unknown>;
    const { area, title, prefix, areaWeight, optional, items } = areaObject;
    if (typeof area !== "string" || typeof title !== "string" || typeof prefix !== "string") {
      fail(`areas[${areaIndex}] has invalid identity fields`);
    }
    if (typeof areaWeight !== "number" || areaWeight <= 0) {
      fail(`${area} has invalid areaWeight`);
    }
    if (typeof optional !== "boolean" || !Array.isArray(items)) {
      fail(`${area} has invalid optional/items fields`);
    }
    const areaName = area as string;
    const areaTitle = title as string;
    const areaPrefix = prefix as string;
    const decodedAreaWeight = areaWeight as number;
    const decodedOptional = optional as boolean;
    const rawItemsForArea = items as unknown[];
    const decodedItems = rawItemsForArea.map((item: unknown, itemIndex: number) => {
      if (!isObject(item)) fail(`${areaName}.items[${itemIndex}] must be an object`);
      const itemObject = item as Record<string, unknown>;
      const { id, criterion, weight, type, testability, passCriteria, manualInstructions } = itemObject;
      if (typeof id !== "string" || !id.startsWith(`${areaPrefix}-`) || ids.has(id)) {
        fail(`${areaName}.items[${itemIndex}] has an invalid or duplicate id`);
      }
      const itemId = id as string;
      ids.add(itemId);
      if (typeof criterion !== "string" || typeof passCriteria !== "string") {
        fail(`${itemId} must have criterion and passCriteria`);
      }
      if (weight !== 1 && weight !== 2 && weight !== 3) fail(`${itemId} has invalid weight`);
      if (typeof type !== "string" || !RUBRIC_TYPES.includes(type as (typeof RUBRIC_TYPES)[number])) {
        fail(`${itemId} has invalid type`);
      }
      if (typeof testability !== "string" || !TESTABILITY.has(testability as Testability)) {
        fail(`${itemId} has invalid testability`);
      }
      if (manualInstructions !== undefined && typeof manualInstructions !== "string") {
        fail(`${itemId} has invalid manualInstructions`);
      }
      const decodedWeight = weight as 1 | 2 | 3;
      const decodedManualInstructions = manualInstructions as string | undefined;
      return {
        id: itemId,
        criterion: criterion as string,
        weight: decodedWeight,
        type: type as (typeof RUBRIC_TYPES)[number],
        testability: testability as Testability,
        passCriteria: passCriteria as string,
        ...(decodedManualInstructions === undefined ? {} : { manualInstructions: decodedManualInstructions }),
      };
    });
    return {
      area: areaName,
      title: areaTitle,
      prefix: areaPrefix,
      areaWeight: decodedAreaWeight,
      optional: decodedOptional,
      items: decodedItems,
    };
  });

  const required = areas.filter(({ optional }) => !optional);
  const requiredAreaWeight = required.reduce((sum, { areaWeight }) => sum + areaWeight, 0);
  const requiredItemCount = required.reduce((sum, { items }) => sum + items.length, 0);
  const requiredItemWeight = required.flatMap(({ items }) => items).reduce((sum, { weight }) => sum + weight, 0);
  const optionalItemCount = areas.filter(({ optional }) => optional).reduce((sum, { items }) => sum + items.length, 0);
  if (requiredAreaWeight !== 100) fail(`required area weights sum to ${requiredAreaWeight}, expected 100`);
  if (requiredItemCount !== 86 || requiredItemWeight !== 183 || optionalItemCount !== 12) {
    fail(`locked totals changed: required=${requiredItemCount}/${requiredItemWeight}, optional=${optionalItemCount}`);
  }

  return {
    schemaVersion: 1,
    source: root.source as unknown as RubricManifest["source"],
    areas,
  };
}

export function validateEvidencePlan(manifest: RubricManifest, plan: EvidencePlan): void {
  const rubricIds = new Set(manifest.areas.flatMap(({ items }) => items.map(({ id }) => id)));
  const planIds = Object.keys(plan);
  for (const id of rubricIds) {
    const checks = plan[id];
    if (!checks || checks.length === 0) fail(`evidence plan has no checks for ${id}`);
  }
  for (const id of planIds) {
    if (!rubricIds.has(id)) fail(`evidence plan references unknown item ${id}`);
  }
}
