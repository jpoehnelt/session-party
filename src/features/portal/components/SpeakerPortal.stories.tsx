import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";
import { ProductionBareFrame } from "./production-ui";
import type { PortalSnapshot, PortalTask } from "../schema";
import { SpeakerPortalContent } from "../routes/speaker-portal";

const TASK_DUE_AT = Date.UTC(2027, 3, 15);

const taskDefinitions = [
  ["Upload Session Presentation", "upload", "Final slide deck as a PDF, 16:9 aspect ratio."],
  ["Confirm participation", "confirm", "Confirm participation in AI Engineer Sandbox."],
  ["Complete bio and profile", "profile", "Complete your biography, social links, and profile details."],
  ["Review speaker profile", "profile", "Review the public profile the event team will publish."],
  ["Confirm session title", "confirm", "Confirm the final title for the public program."],
  ["Confirm session description", "confirm", "Review the public session description."],
  ["Share accessibility needs", "confirm", "Tell production about any accessibility needs."],
  ["Confirm travel details", "confirm", "Confirm your arrival and departure details."],
  ["Review production schedule", "confirm", "Review your session time and room assignment."],
  ["Upload Final Headshot (print quality)", "upload", "Upload the requested file to complete this task."],
  ["Sign speaker release form", "link", "Review and sign the speaker release form."],
] as const satisfies readonly (readonly [string, PortalTask["kind"], string])[];

function makeTasks(completedCount: number): readonly PortalTask[] {
  return taskDefinitions.map(([name, kind, description], index) => {
    const completed = index < completedCount;
    return {
      id: `task-${index + 1}`,
      eventId: "event-ai-engineer-sandbox",
      name,
      description,
      kind,
      formId: null,
      dueAt: TASK_DUE_AT + index * 86_400_000,
      order: index + 1,
      targetMode: "all",
      speakerIds: [],
      version: 1,
      completed,
      completedAt: completed ? TASK_DUE_AT - 86_400_000 : null,
      completionData: null,
      completionVersion: completed ? 1 : 0,
      prerequisite: { satisfied: true, message: null },
    };
  });
}

function makeSnapshot(completedCount: number): PortalSnapshot {
  const tasks = makeTasks(completedCount);
  const outstanding = tasks.slice(completedCount);
  return {
    event: {
      id: "event-ai-engineer-sandbox",
      slug: "ai-engineer-sandbox",
      name: "AI Engineer Sandbox",
      description: "A hands-on gathering for engineers building reliable AI systems.",
      location: "Pier 27, San Francisco",
      timezone: "America/Los_Angeles",
      startsAt: Date.UTC(2027, 4, 12),
      endsAt: Date.UTC(2027, 4, 13),
      bannerAssetId: null,
      accentColor: "#7857ff",
    },
    speaker: {
      id: "speaker-river-okafor",
      eventId: "event-ai-engineer-sandbox",
      displayName: "River Okafor",
      contactEmail: "river@example.com",
      title: "Staff AI Engineer",
      company: "Signal House",
      bio: "River builds reliable agent systems and the production practices that keep them understandable under pressure.",
      workflowStatus: "Accepted",
      headshotAssetId: "asset-headshot",
      headshotUrl: null,
      links: [{ label: "Website", url: "https://example.com/river" }],
      visible: true,
      profileSourceId: null,
      profileSourceVersion: null,
      profileReviewStatus: "approved",
      profileReviewNote: null,
      profileSubmittedAt: null,
      profileReviewedAt: Date.UTC(2027, 3, 1),
      version: 4,
      pendingSyncFields: [],
    },
    submission: {
      id: "submission-reliable-agents",
      title: "Reliable agents: from prototype to production",
      category: "AI Systems",
      version: 3,
      confirmationStatus: "awaiting_confirmation",
    },
    provisioningStatus: "provisioned",
    tasks,
    resources: [{
      id: "resource-speaker-guide",
      eventId: "event-ai-engineer-sandbox",
      slug: "speaker-guide",
      title: "Speaker production guide",
      body: "Arrival, stage, recording, and accessibility guidance for every speaker.",
      embedUrl: null,
      audience: "speakers",
      order: 1,
      version: 1,
    }],
    assets: [{
      id: "asset-slides",
      eventId: "event-ai-engineer-sandbox",
      filename: "reliable-agents-slides.pdf",
      contentType: "application/pdf",
      size: 4_096,
      purpose: "slides",
      version: 1,
    }, {
      id: "asset-bio",
      eventId: "event-ai-engineer-sandbox",
      filename: "speaker-bio.docx",
      contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      size: 2_048,
      purpose: "document",
      version: 1,
    }, {
      id: "asset-headshot",
      eventId: "event-ai-engineer-sandbox",
      filename: "river-headshot.webp",
      contentType: "image/webp",
      size: 8_192,
      purpose: "headshot",
      version: 1,
    }],
    readiness: {
      tasksTotal: tasks.length,
      tasksDone: completedCount,
      outstandingTaskIds: outstanding.map(({ id }) => id),
      nextTaskId: outstanding[0]?.id ?? null,
      state: completedCount === tasks.length ? "ready" : completedCount === 0 ? "not_started" : "in_progress",
      missingItems: outstanding.map((task) => ({
        id: task.id,
        name: task.name,
        kind: task.kind,
        dueAt: task.dueAt,
        overdue: false,
        blocker: task.name,
        recommendedAction: task.name,
      })),
      overdueCount: 0,
      clearestBlocker: outstanding[0]?.name ?? null,
      recommendedNextAction: outstanding[0]?.name ?? null,
    },
  };
}

function PortalStory({ snapshot }: { readonly snapshot: PortalSnapshot }) {
  return (
    <ProductionBareFrame>
      <SpeakerPortalContent
        snapshot={snapshot}
        onSaveProfile={() => undefined}
        onToggleTask={() => undefined}
        onUpload={() => undefined}
        onSubmitTaskForm={async () => true}
      />
    </ProductionBareFrame>
  );
}

const meta = {
  title: "Features/Portal/Speaker workspace",
  parameters: {
    layout: "fullscreen",
    argos: { fitToContent: false },
  },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

export const TasksInProgress: Story = {
  render: () => <PortalStory snapshot={makeSnapshot(9)} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    expect(canvas.getAllByText("9 of 11 tasks complete")).toHaveLength(1);
    expect(canvas.getByText("Next tasks")).toBeVisible();
    expect(canvas.queryByText("Cues complete")).not.toBeInTheDocument();
    expect(canvas.queryByText("Cues remaining")).not.toBeInTheDocument();
    expect(canvas.queryByText("9 of 11 complete")).not.toBeInTheDocument();
  },
};

export const AllTasksComplete: Story = {
  render: () => <PortalStory snapshot={makeSnapshot(11)} />,
};

export const OptimisticTaskToggle: Story = {
  render: () => (
    <ProductionBareFrame>
      <SpeakerPortalContent
        snapshot={makeSnapshot(11)}
        onSaveProfile={() => undefined}
        onToggleTask={() => Promise.resolve(true)}
        onUpload={() => undefined}
        onSubmitTaskForm={async () => true}
      />
    </ProductionBareFrame>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const participation = canvas.getByRole("checkbox", { name: /Confirm participation/i });
    expect(participation).toBeChecked();
    await userEvent.click(participation);
    expect(participation).not.toBeChecked();
  },
};
