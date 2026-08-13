import type { Page } from "playwright";

export type DemoRole = "organizer" | "reviewer" | "speaker";

export type WalkthroughOptions = {
  readonly baseUrl: string;
  readonly eventSlug: string;
  readonly outputDir: string;
  readonly headed: boolean;
};

export type SceneContext = WalkthroughOptions & {
  readonly page: Page;
  readonly state: Map<string, string>;
  readonly pause: (milliseconds: number) => Promise<void>;
  readonly titleCard: (title: string, subtitle: string, technicalDetails?: readonly string[]) => Promise<void>;
  readonly clearTechnicalOverlay: () => Promise<void>;
  readonly spotlight: (selector: string, label?: string) => Promise<void>;
  readonly clearSpotlight: () => Promise<void>;
  readonly scrollBy: (pixels: number) => Promise<void>;
};

export type Scene = {
  readonly id: string;
  readonly title: string;
  readonly narration: string;
  readonly shortSeconds: number;
  readonly run: (context: SceneContext) => Promise<void>;
};

export type RecordedScene = {
  readonly id: string;
  readonly title: string;
  readonly narration: string;
  readonly shortSeconds: number;
  readonly videoPath: string;
  readonly durationSeconds: number;
};
