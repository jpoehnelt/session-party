const segment = (value: string) => encodeURIComponent(value);

export const organizerAgendaTalkPath = (eventSlug: string, talkId: string) =>
  `/e/${segment(eventSlug)}/agenda?talk=${segment(talkId)}`;
