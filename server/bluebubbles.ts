import express from "express";
import { randomUUID } from "node:crypto";
import { api } from "../convex/_generated/api.js";
import { convex } from "./convex-client.js";
import { handleUserMessage } from "./interaction-agent.js";
import { broadcast } from "./broadcast.js";
import { redactContactHandle, redactPhoneNumbers } from "./privacy.js";

// BlueBubbles transport: a free, self-hosted iMessage bridge. The BlueBubbles
// server app runs on a Mac signed into iMessage, exposes a REST API for sending,
// and POSTs "new-message" webhooks here for inbound texts. Selected when
// BOOP_TRANSPORT=bluebubbles (see transport.ts).

const MAX_CHUNK = 2900;

function serverUrl(): string | null {
  const url = process.env.BLUEBUBBLES_SERVER_URL?.trim();
  return url ? url.replace(/\/+$/, "") : null;
}

function sendMethod(): string {
  return process.env.BLUEBUBBLES_SEND_METHOD?.trim() || "apple-script";
}

// Accept either a full chat GUID ("iMessage;-;+15551234567") or a bare
// address/phone the other send paths pass, and normalize to a chat GUID.
function toChatGuid(to: string): string {
  const trimmed = to.trim();
  return trimmed.includes(";-;") ? trimmed : `iMessage;-;${trimmed}`;
}

function stripMarkdown(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, (m) => m.replace(/```\w*\n?|```/g, ""))
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/\*(.+?)\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^#+\s+/gm, "")
    .replace(/\[(.+?)\]\((.+?)\)/g, "$1 ($2)")
    .trim();
}

function chunk(text: string, size = MAX_CHUNK): string[] {
  if (text.length <= size) return [text];
  const out: string[] = [];
  let buf = "";
  for (const line of text.split(/\n/)) {
    if ((buf + "\n" + line).length > size) {
      if (buf) out.push(buf);
      buf = line;
    } else {
      buf = buf ? buf + "\n" + line : line;
    }
  }
  if (buf) out.push(buf);
  return out;
}

export async function sendImessage(to: string, text: string): Promise<void> {
  const base = serverUrl();
  const password = process.env.BLUEBUBBLES_PASSWORD;
  if (!base || !password) {
    console.warn("[bluebubbles] missing BLUEBUBBLES_SERVER_URL or BLUEBUBBLES_PASSWORD — not sending");
    return;
  }
  const chatGuid = toChatGuid(to);
  // Same privacy guard as the Sendblue path: never text a phone number back.
  const plain = redactPhoneNumbers(stripMarkdown(text));
  for (const part of chunk(plain)) {
    try {
      const res = await fetch(
        `${base}/api/v1/message/text?password=${encodeURIComponent(password)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chatGuid,
            tempGuid: randomUUID(),
            message: part,
            method: sendMethod(),
          }),
        },
      );
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        console.error(
          `[bluebubbles] send failed ${res.status}: ${redactPhoneNumbers(body).slice(0, 400)}`,
        );
      } else {
        console.log(`[bluebubbles] → sent ${part.length} chars to ${redactContactHandle(chatGuid)}`);
      }
    } catch (err) {
      console.error(`[bluebubbles] send error: ${String(err)}`);
    }
  }
}

// Typing indicators need the BlueBubbles Private API and are cosmetic; keep them
// as no-ops so an un-configured Private API never spams errors every few seconds.
export async function sendTypingIndicator(_to: string): Promise<void> {
  /* no-op */
}

export function startTypingLoop(_to: string): () => void {
  return () => {};
}

function webhookSecretOk(req: express.Request): boolean {
  const expected = process.env.BLUEBUBBLES_WEBHOOK_SECRET?.trim();
  if (!expected) return true; // no secret configured — accept (personal setup)
  const provided = (req.query.secret as string | undefined) ?? req.get("x-bb-secret") ?? "";
  return provided === expected;
}

interface BlueBubblesMessage {
  guid?: string;
  text?: string;
  isFromMe?: boolean;
  handle?: { address?: string } | null;
  chats?: Array<{ guid?: string; chatIdentifier?: string }>;
}

export function createBlueBubblesRouter(): express.Router {
  const router = express.Router();

  router.post("/webhook", async (req, res) => {
    if (!webhookSecretOk(req)) {
      res.status(401).json({ error: "invalid webhook secret" });
      return;
    }

    const { type, data } = (req.body ?? {}) as { type?: string; data?: BlueBubblesMessage };
    if (type !== "new-message" || !data || data.isFromMe) {
      res.json({ ok: true, skipped: true });
      return;
    }

    const text = typeof data.text === "string" ? data.text : "";
    const senderAddress = data.handle?.address ?? data.chats?.[0]?.chatIdentifier ?? "";
    const chatGuid =
      data.chats?.[0]?.guid ?? (senderAddress ? `iMessage;-;${senderAddress}` : "");
    if (!text || !chatGuid) {
      res.json({ ok: true, skipped: true });
      return;
    }

    // Reuse the generic dedup table keyed on the inbound message GUID.
    if (data.guid) {
      const { claimed } = await convex.mutation(api.sendblueDedup.claim, { handle: data.guid });
      if (!claimed) {
        res.json({ ok: true, deduped: true });
        return;
      }
    }

    const conversationId = `sms:${senderAddress || chatGuid}`;
    const turnTag = Math.random().toString(36).slice(2, 8);
    const safePreview = redactPhoneNumbers(text).slice(0, 100);
    console.log(`[turn ${turnTag}] ← ${redactContactHandle(senderAddress || chatGuid)}: ${JSON.stringify(safePreview)}`);
    const start = Date.now();

    broadcast("message_in", { conversationId, content: text, from_number: senderAddress, handle: data.guid });
    res.json({ ok: true });

    try {
      const reply = await handleUserMessage({
        conversationId,
        content: text,
        turnTag,
        images: [],
        onThinking: (t) => broadcast("thinking", { conversationId, t }),
      });
      if (reply) {
        const elapsed = ((Date.now() - start) / 1000).toFixed(1);
        console.log(`[turn ${turnTag}] → reply (${elapsed}s, ${reply.length} chars)`);
        await sendImessage(chatGuid, reply);
        await convex.mutation(api.messages.send, {
          conversationId,
          role: "assistant",
          content: reply,
        });
      } else {
        console.log(`[turn ${turnTag}] → (no reply)`);
      }
    } catch (err) {
      console.error(`[turn ${turnTag}] handler error`, err);
    }
  });

  return router;
}
