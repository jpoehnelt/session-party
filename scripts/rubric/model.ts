export const RUBRIC_TYPES = [
  "exists",
  "crud",
  "roundtrip",
  "handoff",
  "rule",
  "scoping",
  "bulk",
  "side-effect",
  "depth",
] as const;

export type RubricType = (typeof RUBRIC_TYPES)[number];
export type Testability = "auto" | "auto-partial" | "manual";
export type Verdict = "pass" | "partial" | "fail" | "cannot_judge";

export interface RubricItem {
  readonly id: string;
  readonly criterion: string;
  readonly weight: 1 | 2 | 3;
  readonly type: RubricType;
  readonly testability: Testability;
  readonly passCriteria: string;
  readonly manualInstructions?: string;
}

export interface RubricArea {
  readonly area: string;
  readonly title: string;
  readonly prefix: string;
  readonly areaWeight: number;
  readonly optional: boolean;
  readonly items: readonly RubricItem[];
}

export interface RubricManifest {
  readonly schemaVersion: number;
  readonly source: {
    readonly repository: string;
    readonly revision: string;
  };
  readonly areas: readonly RubricArea[];
}

export interface VitestCheck {
  readonly kind: "vitest";
  readonly file: string;
  readonly title: string;
}

export interface GapCheck {
  readonly kind: "gap";
  readonly reason: string;
}

export interface ManualCheck {
  readonly kind: "manual";
  readonly instructions: string;
}

export type EvidenceCheck = VitestCheck | GapCheck | ManualCheck;
export type EvidencePlan = Readonly<Record<string, readonly EvidenceCheck[]>>;

export type ResolvedCheck = EvidenceCheck & {
  readonly outcome: "pass" | "fail" | "pending";
  readonly detail: string;
};

export interface ItemResult {
  readonly id: string;
  readonly criterion: string;
  readonly weight: number;
  readonly type: RubricType;
  readonly verdict: Verdict;
  readonly checks: readonly ResolvedCheck[];
}

export interface AreaResult {
  readonly area: string;
  readonly title: string;
  readonly optional: boolean;
  readonly areaWeight: number;
  readonly earned: number;
  readonly judgeable: number;
  readonly totalWeight: number;
  readonly scorePct: number | null;
  readonly coveragePct: number;
  readonly items: readonly ItemResult[];
}

export interface RubricReport {
  readonly schemaVersion: 1;
  readonly rubricRevision: string;
  readonly overallScorePct: number | null;
  readonly overallCoveragePct: number;
  readonly required: readonly AreaResult[];
  readonly optional: readonly AreaResult[];
}
