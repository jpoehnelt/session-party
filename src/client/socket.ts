import { useCallback, useEffect, useMemo, useRef } from "react";
import { usePartySocket } from "partysocket/react";
import { decodeServerMessage, type ClientMessage, type ServerMessage } from "contracts/protocol";

export type EventRoomConnectionState = "connected" | "reconnecting" | "offline";

interface EventRoomLifecycle {
  readonly onConnectionChange?: (state: EventRoomConnectionState) => void;
  readonly onReconnect?: () => void;
}

const shouldReconnect = (event: CloseEvent) => event.code !== 4401 && event.code !== 4403;

export function useEventRoom(
  eventId: string,
  onMessage: (message: ServerMessage) => void,
  lifecycle: EventRoomLifecycle = {},
) {
  const surface = location.pathname.split("/").filter(Boolean).at(-1) ?? "overview";
  const hasOpened = useRef(false);
  useEffect(() => {
    hasOpened.current = false;
  }, [eventId]);

  const socket = usePartySocket({
    party: "event-room",
    room: eventId,
    shouldReconnectOnClose: shouldReconnect,
    onOpen(event) {
      (event.currentTarget as WebSocket).send(
        JSON.stringify({ t: "room/hello", surface } satisfies ClientMessage),
      );
      if (hasOpened.current) lifecycle.onReconnect?.();
      else lifecycle.onConnectionChange?.("connected");
      hasOpened.current = true;
    },
    onMessage(event) {
      try {
        const message = decodeServerMessage(JSON.parse(event.data));
        if (message) onMessage(message);
      } catch {
        // Ignore malformed room messages.
      }
    },
    onClose(event) {
      lifecycle.onConnectionChange?.(
        navigator.onLine && shouldReconnect(event) ? "reconnecting" : "offline",
      );
    },
  });

  const send = useCallback((message: ClientMessage) => {
    socket.send(JSON.stringify(message));
  }, [socket]);
  const setSurface = useCallback((surface: string) => {
    socket.send(JSON.stringify({ t: "room/hello", surface } satisfies ClientMessage));
  }, [socket]);

  return useMemo(() => ({ send, setSurface }), [send, setSurface]);
}
