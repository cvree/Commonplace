# Commonplace

A personal Discord archivist. You keep dropping links, thoughts and quotes into your own private server; Commonplace indexes the channels you allow and finds things again, always with a link back to the original message.

It runs as a registered Discord bot (never a self-bot), stores everything in your own PostgreSQL database, and only answers its configured owner.

## What works today (Milestone 1)

- Indexes the full history of channels you allow, including threads, and resumes exactly where it stopped after an interruption.
- Saves new messages as you post them, with an optional quiet reaction as acknowledgment.
- Tracks edits (earlier wording is kept as a version) and deletions (the stored copy is wiped to a tombstone).
- `/find`: keyword, exact-phrase and similar-wording search, with channel and date filters, pagination, and a true total.
- `/ask` and @mention: a search-only answer. No AI model is connected yet, so it lists matching sources and says so; it does not summarize.
- `/archive status | scope | index | forget`: coverage per channel, what is excluded, what failed.
- Sensitive channels (health, money, prayers...) are kept out of public replies.
- Versioned backup and restore.

Not built yet: AI-written answers and semantic search, project cards, Karakeep and video transcripts, Instagram/YouTube import, Google Calendar. See [Roadmap](#roadmap).

**Verification status.** The indexing, search, edit/delete and backup logic is covered by automated tests against a real PostgreSQL database using a synthetic archive and a fake Discord (`npm test`). The discord.js layer compiles and type-checks but **has not been run against a live server yet**, because that needs your bot token. The Docker files are likewise unbuilt in the environment this was written in.

## Try it without credentials

```bash
npm install
```

```bash
DATABASE_URL=postgres://commonplace:commonplace@localhost:5432/commonplace npm run demo
```

This runs the real code on invented messages. It never contacts Discord.

## Setup

### 1. Create the bot

1. Go to <https://discord.com/developers/applications> → **New Application**.
2. **Installation** tab: set Install Link to *None*. **Bot** tab: turn **Public Bot off**, so nobody else can add your bot anywhere.
3. **Bot** tab → Privileged Gateway Intents: turn on **Message Content Intent**. Without it Discord sends the bot empty message text. Leave the other two off.
4. **Bot** tab → **Reset Token**, and copy it straight into your `.env` file. Treat it like a password.

### 2. Invite it with minimal permissions

Replace `YOUR_APP_ID` (General Information → Application ID):

```
https://discord.com/oauth2/authorize?client_id=YOUR_APP_ID&scope=bot+applications.commands&permissions=274877975616
```

That grants only: View Channels, Read Message History, Send Messages, Send Messages in Threads, Add Reactions. It does not ask for Administrator, Manage Channels or Manage Messages, and the bot cannot edit or delete anything you wrote.

The bot can only read channels it can see. For a private channel, add the bot's role to that channel's permissions.

### 3. Configure and start

```bash
cp .env.example .env
```

Fill in the token, your server ID and your user ID, then:

```bash
docker compose up -d --build
```

On start the bot checks that it is really in that server and that the owner ID is a member, and refuses to run otherwise.

Without Docker: install PostgreSQL 16 with the `pgvector` extension, create the database, then `npm install && npm start`.

### 4. Choose what it may read

Nothing is indexed until you allow it. In Discord:

```
/archive scope channel:#general action:allow
/archive scope channel:#skin-track action:allow sensitive:True
/archive status
```

Allowing a channel starts indexing its history straight away. Channels whose names look private (health, skin, money, prayers...) are marked sensitive automatically; you can override that.

### Restarting and where it runs

The bot only saves messages while it is running. When the computer it runs on is off or asleep, nothing is lost: on the next start it reads everything posted since its last checkpoint. Edits and deletions made while it was offline are picked up by `/archive index rescan:True`.

```bash
docker compose restart bot
```

```bash
docker compose logs -f bot
```

### Backup and restore

```bash
npm run backup
```

```bash
npm run restore -- backups/<file>.json
```

Restore refuses to overwrite an archive that already has messages unless you add `--replace`. Backup files contain your messages in plain text; keep them somewhere private. Search indexes are rebuilt automatically on restore.

## Privacy

See [docs/PRIVACY.md](docs/PRIVACY.md) for the full checklist.

## Roadmap

| Milestone | Contents | Notes |
|---|---|---|
| 2 | Semantic search (pgvector), AI-written answers with citations, project cards, decision timelines, context-bundle export | Needs a choice of AI provider: local (Ollama) or Claude API (paid, separate from a Claude subscription) |
| 3 | Karakeep for saved links, transcripts via yt-dlp + WhisperX where permitted, duplicate-link handling, paste-caption / attach-video fallbacks | |
| 3 | **YouTube playlists**: automatic sync through the official YouTube Data API after you sign in with Google | Officially supported |
| 3 | **Instagram saves**: sharing a post to Discord (works today, just saved as a message); import of Instagram's official "Download your information" export, with collection names as categories | Instagram offers no API for reading your saved folders. Commonplace will not log in as you or use session cookies: that breaks Instagram's terms and risks your account |
| 4 | `/schedule` to create Google Calendar events after a confirmation preview; `/organize`, quote cabinet, personal logs, idea connections, digest | Calendar needs a one-time Google sign-in |

## Sharing with friends

Today the safest way is for each friend to run their own copy with their own bot token: nobody's notes ever touch anyone else's machine. Every table is already keyed by server, so a single hosted bot serving several servers is possible later, but whoever hosts it can read everyone's data, and it needs per-user authorization and Discord's bot verification first. That is deliberately not switched on.
