import { z } from "zod";
import { defineRuntimeTool } from "../runtimes/tool.js";
import { runtimeText, type RuntimeTool } from "../runtimes/types.js";
import { currentPage } from "./launcher.js";

// TikTok reading via the persistent logged-in Patchright profile. Unlike
// Instagram, TikTok exposes per-video view/like/comment/share counts publicly,
// and its creator analytics (TikTok Studio) are readable on the web when logged
// in — so the browser can surface real numbers without any API.

const MAX_CONTENT_CHARS = 12_000;

async function humanPause(minMs = 1000, maxMs = 2400): Promise<void> {
  const ms = Math.floor(minMs + Math.random() * (maxMs - minMs));
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function collectWithScroll(times: number): Promise<string> {
  const page = await currentPage();
  const seen = new Set<string>();
  const lines: string[] = [];
  const collect = async () => {
    try {
      const snapshot = await page.ariaSnapshot({ mode: "ai" });
      for (const line of snapshot.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || seen.has(trimmed)) continue;
        seen.add(trimmed);
        lines.push(line);
      }
    } catch {
      /* transient snapshot failure shouldn't abort */
    }
  };
  await collect();
  for (let i = 0; i < times; i++) {
    await page.evaluate(() => window.scrollBy(0, Math.round(window.innerHeight * 0.85)));
    await humanPause(700, 1600);
    await collect();
  }
  const text = lines.join("\n").trim();
  if (!text) {
    return "(no readable content — TikTok may be showing a login wall or blocking automation; try browser_request_login)";
  }
  return text.length > MAX_CONTENT_CHARS ? `${text.slice(0, MAX_CONTENT_CHARS)}\n… (truncated)` : text;
}

export function createTiktokTools(namespace: string): RuntimeTool[] {
  return [
    defineRuntimeTool(
      namespace,
      "tiktok_latest_post",
      "Open a TikTok creator's most recent video and return its public stats (views, likes, comments, shares), caption, and top comments. TikTok shows these counts publicly, so this works for any handle. Pass the creator's @handle (the user's own for their latest video). Requires being logged into TikTok in the local browser; on a login wall, call browser_request_login first.",
      {
        handle: z.string().describe("TikTok @handle whose latest video to open, e.g. '@khaby.lame' or 'khaby.lame'."),
        comment_scrolls: z
          .number()
          .int()
          .min(0)
          .max(15)
          .optional()
          .describe("How many times to scroll to load stats/comments (default 4)."),
      },
      async ({ handle, comment_scrolls }) => {
        try {
          const clean = String(handle).trim().replace(/^@/, "");
          const page = await currentPage();
          await page.goto(`https://www.tiktok.com/@${encodeURIComponent(clean)}`, {
            waitUntil: "domcontentloaded",
            timeout: 45_000,
          });
          await humanPause(1800, 3200);
          const link = await page.evaluate(() => {
            const anchor = document.querySelector<HTMLAnchorElement>('a[href*="/video/"]');
            return anchor ? anchor.href : null;
          });
          if (!link) {
            return runtimeText(
              `(couldn't find a video on @${clean} — the profile may be private, empty, or blocked; try browser_request_login)`,
              false,
            );
          }
          await page.goto(link, { waitUntil: "domcontentloaded", timeout: 45_000 });
          await humanPause(1800, 3200);
          const scrolls = Math.min(15, Math.max(0, (comment_scrolls as number | undefined) ?? 4));
          const content = await collectWithScroll(scrolls);
          return runtimeText(
            `Latest TikTok for @${clean} (${link}) — stats + caption + comments:\n\n${content}`,
          );
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return runtimeText(`[tiktok_latest_post error] ${message}`, false);
        }
      },
    ),
    defineRuntimeTool(
      namespace,
      "tiktok_studio_analytics",
      "Open TikTok Studio (the creator analytics dashboard) in the user's logged-in browser and return the account analytics it shows — video views, profile views, likes, comments, shares, follower counts and trends. This is TikTok's real insights, readable on the web for logged-in creators. Requires the user to be logged into TikTok with a creator/pro account; on a login wall, call browser_request_login first.",
      {
        scrolls: z
          .number()
          .int()
          .min(0)
          .max(15)
          .optional()
          .describe("How many times to scroll the dashboard to load all metric tiles (default 6)."),
      },
      async ({ scrolls }) => {
        try {
          const page = await currentPage();
          await page.goto("https://www.tiktok.com/tiktokstudio/analytics", {
            waitUntil: "domcontentloaded",
            timeout: 45_000,
          });
          // Analytics tiles/charts load lazily; give them a beat.
          await humanPause(2500, 4000);
          const count = Math.min(15, Math.max(0, (scrolls as number | undefined) ?? 6));
          const content = await collectWithScroll(count);
          return runtimeText(`TikTok Studio analytics:\n\n${content}`);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return runtimeText(`[tiktok_studio_analytics error] ${message}`, false);
        }
      },
    ),
  ];
}
