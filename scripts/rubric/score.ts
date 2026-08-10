import type {
  AreaResult,
  EvidenceCheck,
  EvidencePlan,
  ItemResult,
  ResolvedCheck,
  RubricManifest,
  RubricReport,
  Verdict,
} from "./model.ts";

export type TestOutcomes = ReadonlyMap<string, "passed" | "failed" | "pending">;

export const testKey = (file: string, title: string): string => `${file}::${title}`;

function resolveCheck(check: EvidenceCheck, outcomes: TestOutcomes): ResolvedCheck {
  if (check.kind === "gap") {
    return { ...check, outcome: "fail", detail: check.reason };
  }
  if (check.kind === "manual") {
    return { ...check, outcome: "pending", detail: check.instructions };
  }
  const key = testKey(check.file, check.title);
  const status = outcomes.get(key);
  if (!status) throw new Error(`Rubric evidence test was not found: ${key}`);
  return {
    ...check,
    outcome: status === "passed" ? "pass" : status === "failed" ? "fail" : "pending",
    detail: `${check.file} — ${check.title} (${status})`,
  };
}

function verdict(checks: readonly ResolvedCheck[]): Verdict {
  if (checks.some(({ outcome }) => outcome === "pending")) return "cannot_judge";
  const passes = checks.filter(({ outcome }) => outcome === "pass").length;
  if (passes === checks.length) return "pass";
  if (passes === 0) return "fail";
  return "partial";
}

const verdictFactor = (value: Verdict): number | null => {
  if (value === "pass") return 1;
  if (value === "partial") return 0.5;
  if (value === "fail") return 0;
  return null;
};

function scoreArea(
  area: RubricManifest["areas"][number],
  plan: EvidencePlan,
  outcomes: TestOutcomes,
): AreaResult {
  const items: ItemResult[] = area.items.map((item) => {
    const checks = plan[item.id]?.map((check) => resolveCheck(check, outcomes));
    if (!checks || checks.length === 0) throw new Error(`No evidence checks registered for ${item.id}`);
    return {
      id: item.id,
      criterion: item.criterion,
      weight: item.weight,
      type: item.type,
      verdict: verdict(checks),
      evidenceBacked: checks.every(({ kind, outcome }) => kind === "vitest" && outcome !== "pending"),
      implementationGap: checks.some(({ kind }) => kind === "gap"),
      checks,
    };
  });
  let earned = 0;
  let judgeable = 0;
  let evidenceWeight = 0;
  let implementationGapWeight = 0;
  const totalWeight = items.reduce((sum, { weight }) => sum + weight, 0);
  for (const item of items) {
    if (item.evidenceBacked) evidenceWeight += item.weight;
    if (item.implementationGap) implementationGapWeight += item.weight;
    const factor = verdictFactor(item.verdict);
    if (factor === null) continue;
    earned += item.weight * factor;
    judgeable += item.weight;
  }
  return {
    area: area.area,
    title: area.title,
    optional: area.optional,
    areaWeight: area.areaWeight,
    earned,
    judgeable,
    evidenceWeight,
    implementationGapWeight,
    totalWeight,
    scorePct: judgeable === 0 ? null : (earned / judgeable) * 100,
    evidenceCoveragePct: totalWeight === 0 ? 0 : (evidenceWeight / totalWeight) * 100,
    implementationGapPct: totalWeight === 0 ? 0 : (implementationGapWeight / totalWeight) * 100,
    items,
  };
}

export function scoreRubric(
  manifest: RubricManifest,
  plan: EvidencePlan,
  outcomes: TestOutcomes,
): RubricReport {
  const areas = manifest.areas.map((area) => scoreArea(area, plan, outcomes));
  const required = areas.filter(({ optional }) => !optional);
  const optional = areas.filter(({ optional }) => optional);
  let weightedScore = 0;
  let weightedEvidenceCoverage = 0;
  let weightedImplementationGap = 0;
  let judgeableAreaWeight = 0;
  for (const area of required) {
    weightedEvidenceCoverage += area.areaWeight * (area.evidenceCoveragePct / 100);
    weightedImplementationGap += area.areaWeight * (area.implementationGapPct / 100);
    if (area.scorePct === null) continue;
    weightedScore += area.areaWeight * area.scorePct;
    judgeableAreaWeight += area.areaWeight;
  }
  return {
    schemaVersion: 2,
    rubricRevision: manifest.source.revision,
    overallScorePct: judgeableAreaWeight === 0 ? null : weightedScore / judgeableAreaWeight,
    overallEvidenceCoveragePct: weightedEvidenceCoverage,
    overallImplementationGapPct: weightedImplementationGap,
    required,
    optional,
  };
}
