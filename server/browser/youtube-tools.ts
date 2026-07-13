import { z } from "zod";
import { defineRuntimeTool } from "../runtimes/tool.js";
import { runtimeText, type RuntimeTool } from "../runtimes/types.js";
import { currentPage } from "./launcher.js";

// YouTube analytics via the logged-in browser. YouTube Studio (studio.youtube.com)
// exposes the FULL creator analytics on the web — views, watch time, retention,
// traffic sources, subscribers — which the Data API (and Composio's YouTube
// toolkit) can't provide. So read the Studio dashboard through the browser.

const MAX_CONTENT_CHARS = 12_000;

async function humanPause(minMs = 1200, maxMs = 2800): Promise<void> {
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
      /* transient */
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
    return "(no readable content — YouTube Studio may need login; try browser_request_login)";
  }
  return text.length > MAX_CONTENT_CHARS ? `${text.slice(0, MAX_CONTENT_CHARS)}\n… (truncated)` : text;
}

export function createYoutubeTools(namespace: string): RuntimeTool[] {
  return [
    defineRuntimeTool(
      namespace,
      "youtube_studio_analytics",
      "Open YouTube Studio (studio.youtube.com) in the user's logged-in browser and return the channel analytics it shows — views, watch time, subscribers, and recent-video performance. This is the FULL creator analytics (deeper than the public Data API): use it for 'how's my channel doing' / 'my YouTube stats'. Requires the user to be logged into YouTube; on a login wall, call browser_request_login first.",
      {
        scrolls: z
          .number()
          .int()
          .min(0)
          .max(15)
          .optional()
          .describe("How many times to scroll the dashboard to load all cards (default 6)."),
      },
      async ({ scrolls }) => {
        try {
          const page = await currentPage();
          // Base Studio URL redirects to the logged-in channel's dashboard.
          await page.goto("https://studio.youtube.com", {
            waitUntil: "domcontentloaded",
            timeout: 45_000,
          });
          await humanPause(2800, 4500);
          const count = Math.min(15, Math.max(0, (scrolls as number | undefined) ?? 6));
          const content = await collectWithScroll(count);
          return runtimeText(`YouTube Studio analytics:\n\n${content}`);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return runtimeText(`[youtube_studio_analytics error] ${message}`, false);
        }
      },
    ),
  ];
}
