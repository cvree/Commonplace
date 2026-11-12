-- Milestone 1: trustworthy message memory.
-- Every row is scoped by guild_id so one database can later hold several
-- separate archives without a rewrite.

CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS vector; -- used from milestone 2 (semantic retrieval)

-- Which channels the owner has allowed. Nothing is indexed or searchable
-- unless it has a row here with allowed = true. Threads inherit their parent.
CREATE TABLE channel_scope (
  guild_id     text NOT NULL,
  channel_id   text NOT NULL,
  channel_name text NOT NULL DEFAULT '',
  allowed      boolean NOT NULL DEFAULT true,
  -- 'general' | 'sensitive'. Sensitive channels (health, money, prayers...)
  -- are left out of public replies and, later, out of briefs and cloud AI.
  sensitivity  text NOT NULL DEFAULT 'general' CHECK (sensitivity IN ('general', 'sensitive')),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (guild_id, channel_id)
);

CREATE TABLE source_message (
  guild_id          text NOT NULL,
  message_id        text NOT NULL,
  channel_id        text NOT NULL,          -- channel or thread the message is in
  scope_channel_id  text NOT NULL,          -- parent channel for threads, else channel_id
  author_id         text NOT NULL,
  author_name       text NOT NULL DEFAULT '',
  author_is_bot     boolean NOT NULL DEFAULT false,
  sent_at           timestamptz NOT NULL,
  edited_at         timestamptz,
  content           text NOT NULL DEFAULT '',
  content_version   integer NOT NULL DEFAULT 1,
  content_hash      text NOT NULL,
  reply_to_id       text,
  -- Link previews Discord attached. Useful for finding a save; NOT evidence
  -- of what a video or page says.
  embeds            jsonb NOT NULL DEFAULT '[]',
  embed_text        text NOT NULL DEFAULT '',
  deleted_at        timestamptz,
  first_indexed_at  timestamptz NOT NULL DEFAULT now(),
  last_seen_at      timestamptz NOT NULL DEFAULT now(),
  tsv_content tsvector GENERATED ALWAYS AS (to_tsvector('english'::regconfig, content)) STORED,
  tsv_embed   tsvector GENERATED ALWAYS AS (to_tsvector('english'::regconfig, embed_text)) STORED,
  PRIMARY KEY (guild_id, message_id)
);
CREATE INDEX source_message_channel_idx ON source_message (guild_id, scope_channel_id, sent_at DESC);
CREATE INDEX source_message_tsv_content_idx ON source_message USING gin (tsv_content);
CREATE INDEX source_message_tsv_embed_idx ON source_message USING gin (tsv_embed);
CREATE INDEX source_message_trgm_idx ON source_message USING gin (content gin_trgm_ops);

-- Earlier wording of edited messages. Removed when the source is deleted.
CREATE TABLE source_message_version (
  guild_id    text NOT NULL,
  message_id  text NOT NULL,
  version     integer NOT NULL,
  content     text NOT NULL,
  edited_at   timestamptz,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (guild_id, message_id, version),
  FOREIGN KEY (guild_id, message_id) REFERENCES source_message ON DELETE CASCADE
);

CREATE TABLE source_attachment (
  guild_id      text NOT NULL,
  attachment_id text NOT NULL,
  message_id    text NOT NULL,
  filename      text NOT NULL,
  content_type  text,
  size_bytes    bigint,
  url           text NOT NULL,
  -- queued | metadata_only | text_extracted | transcript_available |
  -- OCR_available | unavailable | source_deleted
  extraction_status text NOT NULL DEFAULT 'metadata_only',
  PRIMARY KEY (guild_id, attachment_id),
  FOREIGN KEY (guild_id, message_id) REFERENCES source_message ON DELETE CASCADE
);
CREATE INDEX source_attachment_message_idx ON source_attachment (guild_id, message_id);

-- One row per indexed channel or thread: what we have, and what we do not.
CREATE TABLE index_coverage (
  guild_id          text NOT NULL,
  channel_id        text NOT NULL,
  scope_channel_id  text NOT NULL,
  channel_name      text NOT NULL DEFAULT '',
  -- pending | running | complete | failed | inaccessible
  status            text NOT NULL DEFAULT 'pending',
  checkpoint_id     text,             -- newest message id safely stored
  last_sync_at      timestamptz,
  last_error        text,
  PRIMARY KEY (guild_id, channel_id)
);

CREATE TABLE job (
  id           bigserial PRIMARY KEY,
  kind         text NOT NULL,
  dedupe_key   text NOT NULL,
  payload      jsonb NOT NULL DEFAULT '{}',
  -- queued | running | done | failed
  status       text NOT NULL DEFAULT 'queued',
  attempts     integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 8,
  run_after    timestamptz NOT NULL DEFAULT now(),
  last_error   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
-- At most one live job per dedupe key.
CREATE UNIQUE INDEX job_live_dedupe_idx ON job (dedupe_key) WHERE status IN ('queued', 'running');
CREATE INDEX job_claim_idx ON job (run_after) WHERE status = 'queued';

-- Everything the bot changed on the owner's behalf.
CREATE TABLE action_log (
  id         bigserial PRIMARY KEY,
  guild_id   text NOT NULL,
  actor_id   text NOT NULL,
  action     text NOT NULL,
  detail     jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
