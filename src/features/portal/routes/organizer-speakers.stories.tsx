import type { Meta, StoryObj } from "@storybook/react-vite";
import { MemoryRouter } from "react-router";
import { expect, userEvent, within } from "storybook/test";
import { ProductionBareFrame } from "../components/production-ui";
import type { SpeakerDirectory, SpeakerDirectoryItem } from "../schema";
import { OrganizerSpeakersContent } from "./organizer-speakers";

const event = {
  id: "story-event",
  slug: "production-summit",
  name: "Production Summit",
  description: "A conference for event production teams.",
  location: "Denver, Colorado",
  timezone: "America/Denver",
  startsAt: Date.UTC(2027, 7, 18),
  endsAt: Date.UTC(2027, 7, 20),
  bannerAssetId: null,
  accentColor: "#7857ff",
} as const;

const taskNames = [
  "Complete your speaker profile",
  "Upload a headshot",
  "Upload session materials",
  "Share travel details",
  "Confirm the session title",
  "Review the code of conduct",
  "Add social links",
  "Confirm dietary needs",
  "Review the event schedule",
  "Sign the recording release",
  "Complete the final technical check",
] as const;

function speakerItem(
  index: number,
  options: { readonly tasks?: number; readonly ready?: boolean } = {},
): SpeakerDirectoryItem {
  const tasksTotal = options.tasks ?? 5;
  const tasksDone = options.ready ? tasksTotal : index % 3;
  const outstanding = taskNames.slice(tasksDone, tasksTotal).map((name, taskIndex) => ({
    id: `speaker-${index}-task-${taskIndex}`,
    name,
    kind: taskIndex === 1 || taskIndex === 2 ? "upload" as const : "profile" as const,
    dueAt: Date.UTC(2027, 7, 1 + taskIndex),
    overdue: taskIndex < 2,
    blocker: taskIndex === 0 ? `Missing: ${name}` : `${name} is incomplete`,
    recommendedAction: taskIndex === 0 ? "Complete this task in the speaker portal" : `Finish ${name.toLocaleLowerCase()}`,
  }));
  const names = ["Priya Raman", "Alex Morgan", "Avery Chen", "Blair Okafor", "Cameron Singh", "Dana Wu", "Emery Jones", "Frankie Lee", "Gray Patel", "Harper Kim", "Indigo Brown", "Jordan Park"];
  const displayName = names[index] ?? `Speaker ${index + 1}`;
  return {
    speaker: {
      id: `speaker-${index}`,
      eventId: event.id,
      displayName,
      contactEmail: `speaker-${index}@example.com`,
      title: index % 2 === 0 ? "Principal Engineer" : null,
      company: index % 2 === 0 ? "Signal House" : null,
      bio: null,
      workflowStatus: options.ready ? "Ready" : "Invited",
      headshotAssetId: null,
      headshotUrl: null,
      links: [],
      visible: index !== 3,
      profileSourceId: null,
      profileSourceVersion: null,
      profileReviewStatus: "approved",
      profileReviewNote: null,
      profileSubmittedAt: null,
      profileReviewedAt: Date.UTC(2027, 6, 20),
      version: 2,
      pendingSyncFields: [],
    },
    submission: {
      id: `submission-${index}`,
      title: index === 0 ? "Making complex systems feel calm" : `${displayName}: production patterns`,
      category: "Production",
      version: 2,
    },
    source: "accepted",
    acceptanceEventId: `acceptance-${index}`,
    provisioningId: `provisioning-${index}`,
    provisioningVersion: 2,
    provisioningStatus: "provisioned",
    provisionedAt: Date.UTC(2027, 6, 10),
    sessions: [],
    readiness: {
      tasksTotal,
      tasksDone,
      outstandingTaskIds: outstanding.map(({ id }) => id),
      nextTaskId: outstanding[0]?.id ?? null,
      state: options.ready ? "ready" : tasksDone > 0 ? "in_progress" : "not_started",
      missingItems: outstanding,
      overdueCount: outstanding.filter(({ overdue }) => overdue).length,
      clearestBlocker: outstanding[0]?.blocker ?? null,
      recommendedNextAction: outstanding[0]?.recommendedAction ?? null,
    },
    latestContact: null,
    privateFields: [],
  };
}

const directory: SpeakerDirectory = {
  event,
  speakers: [
    speakerItem(0, { tasks: 11 }),
    ...Array.from({ length: 10 }, (_, index) => speakerItem(index + 1)),
    speakerItem(11, { ready: true }),
  ],
};

function SpeakersStory() {
  return (
    <MemoryRouter>
      <ProductionBareFrame contentClassName="max-w-[92rem]">
        <OrganizerSpeakersContent
          directory={directory}
          onProvision={() => undefined}
          onVisibility={() => undefined}
        />
      </ProductionBareFrame>
    </MemoryRouter>
  );
}

const meta = {
  title: "Features/Portal/Speaker readiness cockpit",
  parameters: {
    layout: "fullscreen",
    argos: { fitToContent: false },
    viewport: {
      defaultViewport: "desktop",
      viewports: {
        desktop: { name: "Desktop", styles: { width: "1440px", height: "900px" } },
        mobile: { name: "Mobile", styles: { width: "390px", height: "844px" } },
      },
    },
  },
  render: () => <SpeakersStory />,
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

export const ElevenOutstandingTasks: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    expect(canvas.getAllByRole("button", { name: /Inspect / })).toHaveLength(12);
    expect(canvas.getByRole("button", { name: "Inspect Priya Raman" })).toHaveTextContent("0/11");
    expect(canvas.getByRole("button", { name: "Show 8 more tasks" })).toBeVisible();
  },
};

export const ExpandedTaskInspector: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "Show 8 more tasks" }));
    expect(canvas.getByRole("button", { name: "Show fewer tasks" })).toBeVisible();
    expect(canvas.getByText("Complete the final technical check")).toBeVisible();
  },
};

export const MobileTaskInspector: Story = {
  parameters: { viewport: { defaultViewport: "mobile" } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "Inspect Priya Raman" }));
    expect(canvas.getByRole("complementary", { name: "Speaker readiness inspector" })).toBeVisible();
    expect(canvas.getByRole("button", { name: "Close" })).toBeVisible();
  },
};
