import * as sendblue from "./sendblue.js";
import * as bluebubbles from "./bluebubbles.js";
import * as imessage from "./imessage.js";

// Messaging transport selector via BOOP_TRANSPORT:
//   sendblue    — hosted iMessage bridge (paid)
//   bluebubbles — self-hosted BlueBubbles server (free)
//   imessage    — native macOS transport, reads Messages DB + sends via AppleScript (free, no extra app)
export type TransportName = "sendblue" | "bluebubbles" | "imessage";

export function activeTransport(): TransportName {
  const t = process.env.BOOP_TRANSPORT?.trim();
  if (t === "bluebubbles") return "bluebubbles";
  if (t === "imessage") return "imessage";
  return "sendblue";
}

function impl() {
  switch (activeTransport()) {
    case "bluebubbles":
      return bluebubbles;
    case "imessage":
      return imessage;
    default:
      return sendblue;
  }
}

export function sendImessage(to: string, text: string): Promise<void> {
  return impl().sendImessage(to, text);
}

export function sendTypingIndicator(to: string): Promise<void> {
  return impl().sendTypingIndicator(to);
}

export function startTypingLoop(to: string): () => void {
  return impl().startTypingLoop(to);
}
