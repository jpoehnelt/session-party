import type { Meta, StoryObj } from "@storybook/react-vite";
import { useForm } from "react-hook-form";
import { Button } from "./Button";
import { Input } from "./fields";
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from "./Form";

const meta = {
  title: "UI/Form composition",
  component: FormItem,
  parameters: { layout: "centered" },
} satisfies Meta<typeof FormItem>;

export default meta;
type Story = StoryObj<typeof meta>;

interface SpeakerForm {
  email: string;
  displayName: string;
}

function ValidatedForm() {
  const methods = useForm<SpeakerForm>({ defaultValues: { email: "invalid", displayName: "Ada Rivera" }, mode: "onSubmit" });
  return (
    <Form {...methods}>
      <form noValidate className="grid w-[min(32rem,calc(100vw-2rem))] gap-5 rounded-card border border-line bg-surface p-6 shadow-card" onSubmit={methods.handleSubmit(() => undefined)}>
        <FormField control={methods.control} name="displayName" rules={{ required: "Enter the public speaker name." }} render={({ field }) => <FormItem><FormLabel>Speaker name</FormLabel><FormControl><Input {...field} /></FormControl><FormDescription>Shown in the speaker gallery and agenda.</FormDescription><FormMessage /></FormItem>} />
        <FormField control={methods.control} name="email" rules={{ required: "Enter an email address.", pattern: { value: /^[^\s@]+@[^\s@]+\.[^\s@]+$/, message: "Enter a valid email address." } }} render={({ field }) => <FormItem><FormLabel>Email address</FormLabel><FormControl><Input type="email" {...field} /></FormControl><FormDescription>Used for the private speaker portal link.</FormDescription><FormMessage /></FormItem>} />
        <Button type="submit">Validate speaker</Button>
      </form>
    </Form>
  );
}

export const ReactHookFormValidation: Story = { render: () => <ValidatedForm /> };
