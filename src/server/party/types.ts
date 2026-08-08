import type { ClientMessage } from "contracts/protocol";
import type { Connection } from "partyserver";
import type { EventRoom, EventRoomConnectionState } from "./EventRoom";

export type PartyHandler = (
  room: EventRoom,
  connection: Connection<EventRoomConnectionState>,
  message: ClientMessage,
) => Promise<void>;

