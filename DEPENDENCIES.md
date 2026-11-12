# Dependencies and design choices

Versions were checked against the npm registry and the official Discord API docs on 2026-11-12.

## In use

| Package | Pinned | License | Role |
|---|---|---|---|
| discord.js | 14.28.1 (current `latest`; v15 is pre-release) | Apache-2.0 | Gateway, REST, slash commands. Handles Discord's per-route rate limits and `retry_after` itself |
| pg | 8.23.1 | MIT | PostgreSQL client |
| zod | 4.6.7 | MIT | Config validation |
| dotenv | 18.0.10 | BSD-2-Clause | Loads `.env` |
| tsx | 4.23.15 | MIT | Runs TypeScript directly |
| typescript (dev) | 7.0.2 | Apache-2.0 | Type checking |
| vitest (dev) | 5.1.0 | MIT | Tests |
| PostgreSQL | 16 | PostgreSQL | Authoritative store; full-text search; `pg_trgm` 1.6 for phrase and fuzzy matching |
| pgvector | image `pgvector/pgvector:pg16` (0.6.0 used in development) | PostgreSQL | Extension is created now; first used in Milestone 2 |

## Discord facts verified in the official docs

- `MESSAGE_CONTENT` is a privileged intent; without it `content`, `embeds` and `attachments` arrive empty.
- `GET /channels/{id}/messages` takes one of `before` / `after` / `around`, max 100 per call.
- With View Channel but **without Read Message History, the endpoint returns an empty list rather than an error.** The adapter therefore checks permissions explicitly, so an unreadable channel is reported as inaccessible and never mistaken for an empty or deleted one.

## Choices

- **Job queue: one small `job` table** (`FOR UPDATE SKIP LOCKED`, dedupe by partial unique index, backoff, rate-limit waits that do not consume retries) rather than pg-boss. The only job kind so far is channel backfill; a library can replace it if needs grow.
- **Forward pagination with `after`.** Each page is committed in the same transaction as its checkpoint, so resuming after a crash, a restart, or downtime is one code path with no duplicates.
- **Search without AI first.** Full-text + trigram search is proven independently before any embedding or generation model is added.
- **Link previews are indexed separately from your own words** and labelled as previews in results: a title helps you find a save but is not evidence of what a video says.
- **Deleted sources are wiped**, not merely hidden.
- **Core logic has no discord.js imports** (`src/core`), so it is tested against a fake history source; `src/discord` is a thin adapter.

## Planned, not yet integrated or verified

Karakeep (AGPL-3.0, to run as a separate unmodified service behind an adapter), yt-dlp, WhisperX, an embedding/generation provider, YouTube Data API, Google Calendar API. Each will be pinned and recorded here when added.
