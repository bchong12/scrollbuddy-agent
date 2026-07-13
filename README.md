<p align="center">
  <img src="assets/bori.gif" alt="Bori" width="200" />
</p>

<h1 align="center">Scrollbuddy</h1>

<p align="center"><em>Text an AI agent from iMessage and it scrolls Instagram, TikTok &amp; YouTube for you.</em></p>

---

**Scrollbuddy** is a personal agent you text from iMessage. Ask *"what's going on in my latest post?"* and it opens your newest Instagram post and reads the comments back. Ask *"what's new on my TikTok FYP?"* and it scrolls your feed and summarizes it. It runs entirely on your own machine and your existing **Claude Code** (or Codex) subscription — no per-message fees, no cloud AI bill.

> Based on **[Boop](https://github.com/raroque/boop-agent)** (MIT) by [@raroque](https://github.com/raroque), retooled for social media: free self-hosted iMessage via BlueBubbles + a logged-in browser that reads your feeds.

## What it does

- **Scrolls your feeds** — reads Instagram / TikTok / YouTube (home feed, a profile, a hashtag, your subscriptions) and summarizes what's new.
- **Reads your latest post** — opens your newest post/reel and reads its caption + comments.
- **Free iMessage** — replies land in your normal iMessage thread via a self-hosted [BlueBubbles](https://bluebubbles.app) bridge. No paid SMS service.
- **Logged in once** — a persistent local Chrome profile (Patchright) keeps you signed into your socials, so it reads them as you. Sign in one time; it stays.
- **Remembers you** — tiered memory with nightly consolidation; it learns your handles, preferences, and context over time.
- **Runs on your subscription** — Claude Code or Codex/ChatGPT login. No AI API key required.

## How it works

```
 iMessage  ──▶  BlueBubbles  ──▶  Scrollbuddy server  ──▶  logged-in browser
  (you)          (your Mac)         (agent + memory)          (IG / TikTok / YT)
    ▲                                                                │
    └──────────────────────────  reply  ────────────────────────────┘
```

You text your own number. BlueBubbles (running on your Mac, signed into iMessage) forwards the message to Scrollbuddy. The agent decides what to do, drives a real logged-in browser to read your feeds, and texts the summary back — all local.

## Requirements

- A **Mac** signed into iMessage (BlueBubbles and the logged-in browser both need macOS).
- **Node 20+**.
- A **Claude Code** or **Codex / ChatGPT** subscription (the agent's brain — no API key).
- Free accounts: **[Convex](https://convex.dev)** (database) and **[BlueBubbles](https://bluebubbles.app)** (iMessage bridge). Optional: **[Composio](https://composio.dev)** for extra integrations (Gmail, Calendar, …).

## Setup

### 1. Clone & install
```bash
git clone https://github.com/bchong12/scrollbuddy-agent.git
cd scrollbuddy-agent
npm install
cp .env.example .env.local
```

### 2. Pick your AI runtime
Install one and sign in — no API key needed:
```bash
npm install -g @anthropic-ai/claude-code
claude            # then run /login
# (or use Codex: install it and run `codex login`)
```
`.env.local` defaults to `BOOP_RUNTIME=claude`.

### 3. Database (Convex)
```bash
npx convex dev
```
Creates a free Convex project, fills `CONVEX_DEPLOYMENT` + `VITE_CONVEX_URL` in `.env.local`, and generates the backend types. Leave it running (or use `npx convex dev --once` to just generate types).

### 4. iMessage bridge (BlueBubbles)
1. Install the **[BlueBubbles Server](https://bluebubbles.app)** app on a Mac signed into iMessage.
2. Grant it **Full Disk Access** and set a **server password**. (No SIP disabling required.)
3. Add to `.env.local`:
   ```
   BOOP_TRANSPORT=bluebubbles
   BLUEBUBBLES_SERVER_URL=http://localhost:1234
   BLUEBUBBLES_PASSWORD=your-server-password
   ```

### 5. Run it
```bash
npm run dev
```
Starts the server, Convex, the debug dashboard, and an **ngrok** tunnel — and prints a public URL like `https://xxxx.ngrok.app`.

Then in the **BlueBubbles app → Settings → Webhooks**, add:
```
https://xxxx.ngrok.app/bluebubbles/webhook
```
subscribed to the **new-message** event. (If BlueBubbles and Scrollbuddy run on the same Mac, `http://localhost:3456/bluebubbles/webhook` also works.)

### 6. Log into your socials (once)
Text yourself *"what's on my Instagram?"*. The first time, Scrollbuddy opens its local browser and asks you to sign in. Do it once — the session persists at `~/.scrollbuddy/browser-profile`, so it stays logged in.

## Using it

Text your own iMessage number:

- *"What's going on in my latest post?"* → opens your newest IG post, reads the comments
- *"What's new on my TikTok FYP?"* → scrolls your For You feed, summarizes
- *"Anything good in my YouTube subs?"* → reads your subscriptions
- *"What did @nasa post recently?"* → reads a specific profile

Under the hood the agent uses two tools:

| Tool | What it does |
|------|--------------|
| `social_scroll(platform, target, scrolls)` | Scrolls an Instagram/TikTok/YouTube feed; returns captions, usernames, titles |
| `instagram_latest_post(handle)` | Opens a profile's newest post/reel; returns its caption + comments |

## A note on automation

Scrollbuddy reads your feeds through your own logged-in browser. Keep it gentle — occasional, human-paced reads on your own account. Heavy automation can trip Instagram/TikTok bot defenses. (YouTube also has an official API you can wire in later for a sanctioned, higher-volume path.)

## Cost

**$0/month recurring.** You host the iMessage bridge (BlueBubbles) and the browser, and the agent runs on your existing subscription. The only real cost is leaving a Mac on.

## Configuration

All settings live in `.env.local` (documented in `.env.example`). Highlights:

| Var | Purpose |
|-----|---------|
| `BOOP_RUNTIME` | `claude` or `codex` |
| `BOOP_TRANSPORT` | `bluebubbles` (default) |
| `BLUEBUBBLES_SERVER_URL` / `BLUEBUBBLES_PASSWORD` | your BlueBubbles server |
| `BOOP_BROWSER_ENABLED` | enable the local logged-in browser |
| `COMPOSIO_API_KEY` | optional: Gmail / Calendar / etc. |

## Credit

Scrollbuddy is a fork of **[Boop](https://github.com/raroque/boop-agent)** by [@raroque](https://github.com/raroque) (MIT). Boop provides the agent core — the dispatcher/sub-agent design, tiered memory, drafts, and integrations. Scrollbuddy swaps in a free **BlueBubbles** iMessage transport and adds the **social-feed reading** tools. Mascot: **Bori** 🐶.

## License

MIT — see [LICENSE](./LICENSE).
