import type { Meta, StoryObj } from "@storybook/react-vite";
import { Alert, AlertDescription, AlertTitle } from "./Alert";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from "./AlertDialog";
import { Button } from "./Button";

const meta = {
  title: "UI/Alerts",
  component: Alert,
  parameters: { layout: "centered" },
} satisfies Meta<typeof Alert>;

export default meta;
type Story = StoryObj<typeof meta>;

export const StatusTones: Story = {
  render: () => (
    <div className="grid w-[min(36rem,calc(100vw-2rem))] gap-3">
      <Alert role="status"><AlertTitle>Draft saved</AlertTitle><AlertDescription>Your changes are available to the organizer team.</AlertDescription></Alert>
      <Alert tone="success" role="status"><AlertTitle>Agenda published</AlertTitle><AlertDescription>Revision 3 is now visible on the public schedule.</AlertDescription></Alert>
      <Alert tone="warning" role="status"><AlertTitle>Speaker tasks remain</AlertTitle><AlertDescription>Three speakers still need to upload a headshot.</AlertDescription></Alert>
      <Alert tone="danger"><AlertTitle>Room conflict</AlertTitle><AlertDescription>Two confirmed talks overlap on the Main stage.</AlertDescription></Alert>
    </div>
  ),
};

export const DestructiveConfirmation: Story = {
  render: () => (
    <AlertDialog>
      <AlertDialogTrigger asChild><Button variant="danger">Delete draft</Button></AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete this form draft?</AlertDialogTitle>
          <AlertDialogDescription>This removes the unpublished draft. Published versions and submissions remain intact.</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter><AlertDialogCancel>Keep draft</AlertDialogCancel><AlertDialogAction>Delete draft</AlertDialogAction></AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  ),
};
