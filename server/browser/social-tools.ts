import { z } from "zod";
import { defineRuntimeTool } from "../runtimes/tool.js";
import { runtimeText, type RuntimeTool } from "../runtimes/types.js";
import { currentPage } from "./launcher.js";

// Scrollbuddy's social-reading layer. Sits on top of the persistent Patchright
// profile so a login stays valid across sessions — log in once by hand (via
// browser_request_login) and these tools reuse the same logged-in browser.

type Platform = "instagram" | "tiktok" | "youtube";

const DEFAULT_SCROLLS = 5;
const MAX_SCROLLS = 15;
const MAX_CONTENT_CHARS = 12_000;

function targetUrl(platform: Platform, target?: string): string {
  const raw = (target ?? "").trim();
  const handle = raw.replace(/^@/, "");
  switch (platform) {
    case "instagram":
      if (!raw || /^(feed|home)$/i.test(raw)) return "https://www.instagram.com/";
      if (/^explore$/i.test(raw)) return "https://www.instagram.com/explore/";
      if (/^reels$/i.test(raw)) return "https://www.instagram.com/reels/";
      if (raw.startsWith("#")) {
        return `https://www.instagram.com/explore/tags/${encodeURIComponent(raw.slice(1))}/`;
      }
      return `https://www.instagram.com/${encodeURIComponent(handle)}/`;
    case "tiktok":
      if (!raw || /^(fyp|foryou|for you|home)$/i.test(raw)) return "https://www.tiktok.com/foryou";
      if (/^following$/i.test(raw)) return "https://www.tiktok.com/following";
      if (raw.startsWith("#")) return `https://www.tiktok.com/tag/${encodeURIComponent(raw.slice(1))}`;
      return `https://www.tiktok.com/@${encodeURIComponent(handle)}`;
    case "youtube":
      if (!raw || /^(subs|subscriptions)$/i.test(raw)) {
        return "https://www.youtube.com/feed/subscriptions";
      }
      if (/^home$/i.test(raw)) return "https://www.youtube.com/";
      if (/^trending$/i.test(raw)) return "https://www.youtube.com/feed/trending";
      // Keep the literal @ for channel handles (YouTube routes /@handle).
      if (raw.startsWith("@")) return `https://www.youtube.com/${raw}/videos`;
      return `https://www.youtube.com/results?search_query=${encodeURIComponent(raw)}`;
  }
}

// Randomized pause so scrolling reads as human, not a burst of automation.
async function humanPause(minMs = 900, maxMs = 2200): Promise<void> {
  const ms = Math.floor(minMs + Math.random() * (maxMs - minMs));
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function scrollAndCollect(platform: Platform, scrolls: number): Promise<string> {
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
      // A transient snapshot failure mid-scroll shouldn't abort the read.
    }
  };

  await collect();
  for (let i = 0; i < scrolls; i++) {
    if (platform === "tiktok") {
      // TikTok's feed is a full-screen swiper; ArrowDown advances one video.
      await page.keyboard.press("ArrowDown");
    } else {
      await page.evaluate(() => window.scrollBy(0, Math.round(window.innerHeight * 0.9)));
    }
    await humanPause();
    await collect();
  }

  const text = lines.join("\n").trim();
  if (!text) {
    return "(no readable content — the page may be showing a login wall or blocking automation; try browser_request_login)";
  }
  return text.length > MAX_CONTENT_CHARS ? `${text.slice(0, MAX_CONTENT_CHARS)}\n… (truncated)` : text;
}

// Reads the current page's aria tree a few times while scrolling, so lazily
// loaded comments get pulled in. Shared by the latest-post reader.
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
      /* transient */
    }
  };
  await collect();
  for (let i = 0; i < times; i++) {
    await page.evaluate(() => window.scrollBy(0, Math.round(window.innerHeight * 0.8)));
    await humanPause(700, 1600);
    await collect();
  }
  const text = lines.join("\n").trim();
  return text.length > MAX_CONTENT_CHARS ? `${text.slice(0, MAX_CONTENT_CHARS)}\n… (truncated)` : text;
}

export function createSocialTools(namespace: string): RuntimeTool[] {
  return [
    defineRuntimeTool(
      namespace,
      "social_scroll",
      "Scroll a social feed (Instagram, TikTok, or YouTube) in the user's logged-in local browser and return the readable content — captions, usernames, video titles — so you can summarize what's new. Requires the user to already be logged into that site in the local browser profile; if the result looks like a login wall, call browser_request_login first, wait for the user to sign in, then retry. Keep scroll counts modest to avoid tripping the platform's automation defenses.",
      {
        platform: z.enum(["instagram", "tiktok", "youtube"]),
        target: z
          .string()
          .optional()
          .describe(
            "What to read. Instagram: 'feed' (default), 'explore', 'reels', a '@handle', or '#tag'. TikTok: 'fyp' (default), 'following', a '@handle', or '#tag'. YouTube: 'subscriptions' (default), 'home', 'trending', a '@handle', or a search phrase.",
          ),
        scrolls: z
          .number()
          .int()
          .min(0)
          .max(MAX_SCROLLS)
          .optional()
          .describe(`How many times to scroll (default ${DEFAULT_SCROLLS}, max ${MAX_SCROLLS}). Each scroll loads more items.`),
      },
      async ({ platform, target, scrolls }) => {
        try {
          const plat = platform as Platform;
          const url = targetUrl(plat, target as string | undefined);
          const page = await currentPage();
          await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
          await humanPause(1500, 3000);
          const count = Math.min(MAX_SCROLLS, Math.max(0, (scrolls as number | undefined) ?? DEFAULT_SCROLLS));
          const content = await scrollAndCollect(plat, count);
          return runtimeText(
            `Read ${plat} (${(target as string | undefined) ?? "default"}) — ${count} scroll(s) at ${url}:\n\n${content}`,
          );
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return runtimeText(`[social_scroll error] ${message}`, false);
        }
      },
    ),
    defineRuntimeTool(
      namespace,
      "instagram_latest_post",
      "Open the most recent post or reel on an Instagram profile and return its caption plus the visible comments — use this for questions like 'what's going on in my latest video/post'. Pass the profile's @handle (the user's own handle for their own latest post). Requires being logged into Instagram in the local browser; on a login wall, call browser_request_login first.",
      {
        handle: z.string().describe("Instagram @handle whose latest post to open, e.g. '@nasa' or 'nasa'."),
        comment_scrolls: z
          .number()
          .int()
          .min(0)
          .max(MAX_SCROLLS)
          .optional()
          .describe(`How many times to scroll the comments to load more (default 4).`),
      },
      async ({ handle, comment_scrolls }) => {
        try {
          const clean = String(handle).trim().replace(/^@/, "");
          const page = await currentPage();
          await page.goto(`https://www.instagram.com/${encodeURIComponent(clean)}/`, {
            waitUntil: "domcontentloaded",
            timeout: 45_000,
          });
          await humanPause(1500, 3000);
          // Grab the first post/reel permalink from the profile grid.
          const link = await page.evaluate(() => {
            const anchor = document.querySelector<HTMLAnchorElement>(
              'a[href*="/p/"], a[href*="/reel/"]',
            );
            return anchor ? anchor.href : null;
          });
          if (!link) {
            return runtimeText(
              `(couldn't find a post on @${clean} — the profile may be private, empty, or showing a login wall; try browser_request_login)`,
              false,
            );
          }
          await page.goto(link, { waitUntil: "domcontentloaded", timeout: 45_000 });
          await humanPause(1500, 3000);
          const scrolls = Math.min(MAX_SCROLLS, Math.max(0, (comment_scrolls as number | undefined) ?? 4));
          const content = await collectWithScroll(scrolls);
          return runtimeText(
            `Latest post for @${clean} (${link}) — caption + comments:\n\n${content || "(no readable content)"}`,
          );
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return runtimeText(`[instagram_latest_post error] ${message}`, false);
        }
      },
    ),
  ];
}
