import type { Meta, StoryObj } from "@storybook/react-vite";
import { MemoryRouter } from "react-router";
import { expect, fireEvent, userEvent, waitFor, within } from "storybook/test";
import type { PublishedAgenda } from "@/features/agenda/schema";
import { ProductionBareFrame } from "@/features/portal/components/production-ui";
import { PublicSpeakerEmbedContent } from "@/features/portal/routes/public-speakers";
import type { PublicSpeakerGallery } from "@/features/portal/schema";
import { PublicProgram } from "./PublicProgram";
import { ScheduleEmbedContent } from "../routes/schedule-embed";
import {
  embedDesignStyle,
  embedTypographyClass,
  type EmbedDesign,
} from "../embed-design";

const START = Date.UTC(2027, 4, 12, 16);

const agenda: PublishedAgenda = {
  eventId: "story-event",
  eventName: "DevFlow Conf 2027",
  eventSlug: "devflow-conf-2027",
  timezone: "America/Los_Angeles",
  location: "Moscone West",
  revision: 4,
  publishedAt: Date.UTC(2027, 4, 1),
  talks: [
    {
      id: "talk-ci",
      title: "Taming 40-Minute CI",
      description: "A practical account of incremental builds, remote caching, and evidence from a large monorepo.",
      track: "Platform & Infra",
      room: "Main Stage",
      startsAt: START,
      durationMin: 30,
      speakerNames: ["Priya Raman"],
    },
    {
      id: "talk-docs",
      title: "Docs That Answer Back",
      description: "Retrieval-grounded documentation patterns for product teams.",
      track: "Developer Experience",
      room: "Room 2A",
      startsAt: START + 86_400_000,
      durationMin: 45,
      speakerNames: ["Marcus Okafor"],
    },
  ],
};

const gallery: PublicSpeakerGallery = {
  event: {
    id: agenda.eventId,
    slug: agenda.eventSlug,
    name: agenda.eventName,
    description: "The developer workflow conference",
    location: agenda.location,
    timezone: agenda.timezone,
    startsAt: START,
    endsAt: START + 2 * 86_400_000,
    bannerAssetId: null,
    accentColor: "#635BFF",
  },
  speakers: [
    {
      id: "speaker-priya",
      displayName: "Priya Raman",
      title: "Principal Engineer",
      company: "Latticework Systems",
      bio: "Priya builds high-scale developer infrastructure and humane platform tooling.",
      headshotUrl: null,
      links: [{ label: "Website", url: "https://example.com/priya" }],
    },
    {
      id: "speaker-marcus",
      displayName: "Marcus Okafor",
      title: "Staff Engineer",
      company: "Northstar",
      bio: "Marcus makes documentation systems easier to trust and maintain.",
      headshotUrl: null,
      links: [],
    },
  ],
};

const designs = {
  bold: { aesthetic: "bold", accent: "#635BFF" },
  minimal: { aesthetic: "minimal", accent: "#0A6B58" },
  editorial: { aesthetic: "editorial", accent: "#A13D2D" },
} as const satisfies Record<string, EmbedDesign>;

function ScheduleStory({ design }: { readonly design: EmbedDesign }) {
  return (
    <main
      className={`${design.aesthetic === "bold" ? "production-grid" : ""} min-h-dvh bg-canvas px-3 py-5 text-ink sm:px-8 sm:py-8 ${embedTypographyClass(design.aesthetic)}`}
      style={embedDesignStyle(design)}
    >
      <div className="mx-auto w-full max-w-6xl">
        <ScheduleEmbedContent agenda={agenda} error={null} onRetry={() => undefined} design={design} />
      </div>
    </main>
  );
}

function SpeakerStory({ design }: { readonly design: EmbedDesign }) {
  return (
    <ProductionBareFrame
      className={embedTypographyClass(design.aesthetic)}
      contentClassName={design.aesthetic === "editorial" ? "max-w-6xl" : ""}
      showGrid={design.aesthetic === "bold"}
      style={embedDesignStyle(design)}
    >
      <PublicSpeakerEmbedContent gallery={gallery} design={design} />
    </ProductionBareFrame>
  );
}

const meta = {
  title: "Features/Publication/Configurable embeds",
  parameters: {
    layout: "fullscreen",
    argos: { fitToContent: false },
  },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

export const ScheduleBold: Story = { render: () => <ScheduleStory design={designs.bold} /> };
export const ScheduleMinimal: Story = { render: () => <ScheduleStory design={designs.minimal} /> };
export const ScheduleEditorial: Story = { render: () => <ScheduleStory design={designs.editorial} /> };

export const SpeakersBold: Story = { render: () => <SpeakerStory design={designs.bold} /> };
export const SpeakersMinimal: Story = { render: () => <SpeakerStory design={designs.minimal} /> };
export const SpeakersEditorial: Story = { render: () => <SpeakerStory design={designs.editorial} /> };

export const WidgetBuilderConfiguration: Story = {
  render: () => (
    <MemoryRouter>
      <div className="min-h-dvh bg-canvas p-6">
        <PublicProgram agenda={agenda} gallery={gallery} surface="widgets" />
      </div>
    </MemoryRouter>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.selectOptions(canvas.getByLabelText("Design aesthetic"), "minimal");
    fireEvent.change(canvas.getByLabelText("Brand color"), { target: { value: "#0a6b58" } });

    await waitFor(() => {
      const generated = canvas.getByLabelText("Generated share URL or code") as HTMLTextAreaElement;
      expect(generated.value).toContain("aesthetic=minimal&accent=%230A6B58");
      expect(generated.value).toContain("border-top:4px solid #0A6B58");
    });
  },
};
