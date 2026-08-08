import { usePartySocket } from "partysocket/react";
import type { ClientMessage, ServerMessage } from "contracts/protocol";

export function useEventRoom(eventId: string, onMessage: (message: ServerMessage) => void) {
  const surface = location.pathname.split("/").filter(Boolean).at(-1) ?? "overview";
  const socket = usePartySocket({
    party: "event-room",
    room: eventId,
    onOpen(event) {
      (event.currentTarget as WebSocket).send(
        JSON.stringify({ t: "room/hello", surface } satisfies ClientMessage),
      );
    },
    onMessage(event) {
      try {
        onMessage(JSON.parse(event.data) as ServerMessage);
      } catch {
        // Ignore malformed room messages.
      }
    },
  });

  return {
    send(message: ClientMessage) {
      socket.send(JSON.stringify(message));
    },
  };
}
