import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { api } from "../convex/_generated/api.js";
import { convex } from "./convex-client.js";
import { handleUserMessage } from "./interaction-agent.js";
import { broadcast } from "./broadcast.js";
import { redactContactHandle, redactPhoneNumbers } from "./privacy.js";
import { latestMessageRowId, readInboundSince } from "./apple/messages-local.js";

// Native macOS iMessage transport — no BlueBubbles, no webhook. Reads incoming
// texts straight from the Messages database (Full Disk Access required) and
// sends replies via AppleScript through Messages.app (Automation permission
// required). Selected with BOOP_TRANSPORT=imessage.

const execFileAsync = promisify(execFile);
const MAX_CHUNK = 2900;
const POLL_INTERVAL_MS = 3000;

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

const SEND_SCRIPT = [
  "on run {targetHandle, messageText}",
  '  tell application "Messages"',
  "    set targetService to 1st service whose service type = iMessage",
  "    set targetBuddy to buddy targetHandle of targetService",
  "    send messageText to targetBuddy",
  "  end tell",
  "end run",
].join("\n");

export async function sendImessage(to: string, text: string): Promise<void> {
  // Same privacy guard as the other transports: never text a phone number back.
  const plain = redactPhoneNumbers(stripMarkdown(text));
  for (const part of chunk(plain)) {
    try {
      await execFileAsync("/usr/bin/osascript", ["-e", SEND_SCRIPT, to, part], {
        timeout: 20_000,
      });
      console.log(`[imessage] → sent ${part.length} chars to ${redactContactHandle(to)}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[imessage] send failed: ${msg}`);
      if (/not authorized|Automation|not allowed/i.test(msg)) {
        console.error(
          "[imessage] → Grant your terminal permission to control Messages: System Settings → Privacy & Security → Automation.",
        );
      }
    }
  }
}

// Typing indicators aren't available via AppleScript; keep them as no-ops.
export async function sendTypingIndicator(_to: string): Promise<void> {
  /* no-op */
}

export function startTypingLoop(_to: string): () => void {
  return () => {};
}

let pollTimer: ReturnType<typeof setInterval> | null = null;
let lastRowId = 0;
let polling = false;

export async function startImessagePoller(): Promise<void> {
  try {
    lastRowId = await latestMessageRowId();
    console.log(
      `[imessage] native transport polling Messages every ${POLL_INTERVAL_MS}ms (from ROWID ${lastRowId})`,
    );
  } catch (err) {
    console.error(
      `[imessage] cannot read the Messages database. Grant Full Disk Access to the app running \`npm run dev\` (System Settings → Privacy & Security → Full Disk Access), then restart. (${err instanceof Error ? err.message : String(err)})`,
    );
    return;
  }
  pollTimer = setInterval(() => {
    void pollOnce();
  }, POLL_INTERVAL_MS);
}

export function stopImessagePoller(): void {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}

async function pollOnce(): Promise<void> {
  if (polling) return;
  polling = true;
  try {
    const messages = await readInboundSince(lastRowId);
    for (const message of messages) {
      lastRowId = Math.max(lastRowId, message.id);
      await handleInbound(message);
    }
  } catch {
    // Transient DB read errors (e.g. WAL churn) are fine to skip; next tick retries.
  } finally {
    polling = false;
  }
}

async function handleInbound(message: {
  id: number;
  handle: string;
  text: string;
}): Promise<void> {
  const { claimed } = await convex.mutation(api.sendblueDedup.claim, {
    handle: `imsg:${message.id}`,
  });
  if (!claimed) return;

  const conversationId = `sms:${message.handle}`;
  const turnTag = Math.random().toString(36).slice(2, 8);
  const preview = redactPhoneNumbers(message.text).slice(0, 100);
  console.log(`[turn ${turnTag}] ← ${redactContactHandle(message.handle)}: ${JSON.stringify(preview)}`);
  broadcast("message_in", {
    conversationId,
    content: message.text,
    from_number: message.handle,
  });

  try {
    const reply = await handleUserMessage({
      conversationId,
      content: message.text,
      turnTag,
      images: [],
      onThinking: (t) => broadcast("thinking", { conversationId, t }),
    });
    if (reply) {
      console.log(`[turn ${turnTag}] → reply (${reply.length} chars)`);
      await sendImessage(message.handle, reply);
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
}
