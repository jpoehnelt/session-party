import type { Locator, Page } from "playwright";

export type Trace = {
  readonly action: string;
  readonly operation: string;
  readonly state: string;
};

export type ShotContext = {
  readonly page: Page;
  readonly baseUrl: string;
  readonly eventSlug: string;
  readonly state: Map<string, string>;
  readonly pause: (milliseconds: number) => Promise<void>;
  readonly anchor: (target: Locator, viewportRatio?: number) => Promise<void>;
  readonly trace: (details: Trace) => Promise<void>;
  readonly focus: (target: Locator, label: string) => Promise<void>;
  readonly clearFocus: () => Promise<void>;
  readonly click: (target: Locator, label: string) => Promise<void>;
};

export type WalkthroughShot = {
  readonly id: string;
  readonly chapter: string;
  readonly title: string;
  readonly durationSeconds: number;
  readonly shortSeconds?: number;
  readonly prepare: (context: ShotContext) => Promise<void>;
  readonly capture: (context: ShotContext) => Promise<void>;
};

export type RecordedShot = {
  readonly id: string;
  readonly chapter: string;
  readonly title: string;
  readonly durationSeconds: number;
  readonly shortSeconds?: number;
  readonly videoPath: string;
  readonly trimStartSeconds: number;
  readonly trimDurationSeconds: number;
  readonly screenshotPath: string;
};

export type RecordedOpeningView = {
  readonly id: string;
  readonly path: string;
  readonly screenshotPath: string;
  readonly sha256: string;
};
