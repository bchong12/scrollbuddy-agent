import * as sendblue from "./sendblue.js";
import * as bluebubbles from "./bluebubbles.js";

// Messaging transport selector. Sendblue (hosted iMessage bridge, paid) is the
// default; set BOOP_TRANSPORT=bluebubbles to use a free self-hosted BlueBubbles
// server instead. Both expose the same send/typing surface so the rest of the
// app is transport-agnostic.
export type TransportName = "sendblue" | "bluebubbles";

export function activeTransport(): TransportName {
  return process.env.BOOP_TRANSPORT?.trim() === "bluebubbles" ? "bluebubbles" : "sendblue";
}

export function sendImessage(to: string, text: string): Promise<void> {
  return activeTransport() === "bluebubbles"
    ? bluebubbles.sendImessage(to, text)
    : sendblue.sendImessage(to, text);
}

export function sendTypingIndicator(to: string): Promise<void> {
  return activeTransport() === "bluebubbles"
    ? bluebubbles.sendTypingIndicator(to)
    : sendblue.sendTypingIndicator(to);
}

export function startTypingLoop(to: string): () => void {
  return activeTransport() === "bluebubbles"
    ? bluebubbles.startTypingLoop(to)
    : sendblue.startTypingLoop(to);
}
