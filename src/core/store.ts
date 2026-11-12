import { createHash } from 'node:crypto';
import type { Queryable } from '../db/pool.js';
import type { IndexTarget, RawEmbed, RawMessage } from './types.js';

export type UpsertOutcome = 'inserted' | 'edited' | 'unchanged' | 'restored';

function contentHash(msg: RawMessage): string {
  const attachmentIds = msg.attachments.map((a) => a.id).sort().join(',');
  return createHash('sha256').update(`${msg.content}\u0000${attachmentIds}`).digest('hex');
}

function embedText(embeds: RawEmbed[]): string {
  return embeds
    .flatMap((e) => [e.provider, e.author, e.title, e.description])
    .filter((s): s is string => Boolean(s))
    .join('\n');
}

/**
 * Store a message, idempotently. Seeing the same message twice changes nothing;
 * seeing new wording keeps the previous wording as a version.
 * Call inside a transaction when checkpointing alongside it.
 */
export async function upsertMessage(db: Queryable, msg: RawMessage): Promise<UpsertOutcome> {
  const hash = contentHash(msg);
  const embeds = JSON.stringify(msg.embeds);
  const eText = embedText(msg.embeds);
  const existing = await db.query(
    `SELECT content, content_version, content_hash, edited_at, deleted_at
       FROM source_message WHERE guild_id = $1 AND message_id = $2 FOR UPDATE`,
    [msg.guildId, msg.id],
  );
  const row = existing.rows[0];
  let outcome: UpsertOutcome;

  if (!row) {
    await db.query(
      `INSERT INTO source_message
         (guild_id, message_id, channel_id, scope_channel_id, author_id, author_name, author_is_bot,
          sent_at, edited_at, content, content_hash, reply_to_id, embeds, embed_text)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [
        msg.guildId, msg.id, msg.channelId, msg.scopeChannelId, msg.authorId, msg.authorName,
        msg.authorIsBot, msg.sentAt, msg.editedAt, msg.content, hash, msg.replyToId, embeds, eText,
      ],
    );
    outcome = 'inserted';
  } else if (row.deleted_at) {
    // We saw it again, so it was not actually deleted.
    await db.query(
      `UPDATE source_message
          SET content = $3, content_hash = $4, edited_at = $5, embeds = $6, embed_text = $7,
              deleted_at = NULL, last_seen_at = now()
        WHERE guild_id = $1 AND message_id = $2`,
      [msg.guildId, msg.id, msg.content, hash, msg.editedAt, embeds, eText],
    );
    outcome = 'restored';
  } else if (row.content_hash !== hash) {
    await db.query(
      `INSERT INTO source_message_version (guild_id, message_id, version, content, edited_at)
       VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
      [msg.guildId, msg.id, row.content_version, row.content, row.edited_at],
    );
    await db.query(
      `UPDATE source_message
          SET content = $3, content_hash = $4, content_version = content_version + 1,
              edited_at = $5, embeds = $6, embed_text = $7, last_seen_at = now()
        WHERE guild_id = $1 AND message_id = $2`,
      [msg.guildId, msg.id, msg.content, hash, msg.editedAt ?? new Date(), embeds, eText],
    );
    outcome = 'edited';
  } else {
    // Same wording. Link previews often arrive late as an "update", so refresh them.
    await db.query(
      `UPDATE source_message SET embeds = $3, embed_text = $4, last_seen_at = now()
        WHERE guild_id = $1 AND message_id = $2`,
      [msg.guildId, msg.id, embeds, eText],
    );
    outcome = 'unchanged';
  }

  if (outcome !== 'unchanged') {
    await db.query(
      `DELETE FROM source_attachment WHERE guild_id = $1 AND message_id = $2 AND NOT (attachment_id = ANY($3))`,
      [msg.guildId, msg.id, msg.attachments.map((a) => a.id)],
    );
    for (const a of msg.attachments) {
      await db.query(
        `INSERT INTO source_attachment (guild_id, attachment_id, message_id, filename, content_type, size_bytes, url)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (guild_id, attachment_id) DO UPDATE SET url = EXCLUDED.url`,
        [msg.guildId, a.id, msg.id, a.filename, a.contentType, a.sizeBytes, a.url],
      );
    }
  }
  return outcome;
}

/**
 * The owner deleted the original. Keep only a tombstone: wording, earlier
 * versions, previews and attachment records all go.
 */
export async function markDeleted(db: Queryable, guildId: string, messageIds: string[]): Promise<number> {
  if (messageIds.length === 0) return 0;
  await db.query(`DELETE FROM source_message_version WHERE guild_id = $1 AND message_id = ANY($2)`, [guildId, messageIds]);
  await db.query(`DELETE FROM source_attachment WHERE guild_id = $1 AND message_id = ANY($2)`, [guildId, messageIds]);
  const res = await db.query(
    `UPDATE source_message
        SET content = '', embeds = '[]', embed_text = '', content_hash = '', deleted_at = now()
      WHERE guild_id = $1 AND message_id = ANY($2) AND deleted_at IS NULL`,
    [guildId, messageIds],
  );
  return res.rowCount ?? 0;
}

// ---- Scope ---------------------------------------------------------------

export type Sensitivity = 'general' | 'sensitive';

export interface ScopeRow {
  channelId: string;
  channelName: string;
  allowed: boolean;
  sensitivity: Sensitivity;
}

export async function setScope(
  db: Queryable,
  guildId: string,
  channelId: string,
  channelName: string,
  allowed: boolean,
  sensitivity?: Sensitivity,
): Promise<void> {
  await db.query(
    `INSERT INTO channel_scope (guild_id, channel_id, channel_name, allowed, sensitivity)
     VALUES ($1,$2,$3,$4,COALESCE($5,'general'))
     ON CONFLICT (guild_id, channel_id) DO UPDATE
       SET channel_name = EXCLUDED.channel_name, allowed = EXCLUDED.allowed,
           sensitivity = COALESCE($5, channel_scope.sensitivity), updated_at = now()`,
    [guildId, channelId, channelName, allowed, sensitivity ?? null],
  );
}

export async function listScope(db: Queryable, guildId: string): Promise<ScopeRow[]> {
  const res = await db.query(
    `SELECT channel_id, channel_name, allowed, sensitivity FROM channel_scope
      WHERE guild_id = $1 ORDER BY channel_name`,
    [guildId],
  );
  return res.rows.map((r) => ({
    channelId: r.channel_id, channelName: r.channel_name, allowed: r.allowed, sensitivity: r.sensitivity,
  }));
}

export async function isAllowed(db: Queryable, guildId: string, scopeChannelId: string): Promise<boolean> {
  const res = await db.query(
    `SELECT 1 FROM channel_scope WHERE guild_id = $1 AND channel_id = $2 AND allowed`,
    [guildId, scopeChannelId],
  );
  return res.rows.length > 0;
}

/** Remove a channel from the index entirely and stop watching it. Originals in Discord are untouched. */
export async function forgetChannel(db: Queryable, guildId: string, scopeChannelId: string): Promise<number> {
  const res = await db.query(`DELETE FROM source_message WHERE guild_id = $1 AND scope_channel_id = $2`, [guildId, scopeChannelId]);
  await db.query(`DELETE FROM index_coverage WHERE guild_id = $1 AND scope_channel_id = $2`, [guildId, scopeChannelId]);
  await db.query(`UPDATE channel_scope SET allowed = false, updated_at = now() WHERE guild_id = $1 AND channel_id = $2`, [guildId, scopeChannelId]);
  return res.rowCount ?? 0;
}

// ---- Coverage ------------------------------------------------------------

export type CoverageStatus = 'pending' | 'running' | 'complete' | 'failed' | 'inaccessible';

export async function registerTarget(db: Queryable, guildId: string, t: IndexTarget): Promise<void> {
  await db.query(
    `INSERT INTO index_coverage (guild_id, channel_id, scope_channel_id, channel_name)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (guild_id, channel_id) DO UPDATE SET channel_name = EXCLUDED.channel_name`,
    [guildId, t.channelId, t.scopeChannelId, t.name],
  );
}

export async function setCoverage(
  db: Queryable,
  guildId: string,
  channelId: string,
  patch: { status?: CoverageStatus; checkpointId?: string | null; error?: string | null; synced?: boolean },
): Promise<void> {
  await db.query(
    `UPDATE index_coverage SET
        status = COALESCE($3, status),
        checkpoint_id = CASE WHEN $4 THEN $5 ELSE checkpoint_id END,
        last_error = CASE WHEN $6 THEN $7 ELSE last_error END,
        last_sync_at = CASE WHEN $8 THEN now() ELSE last_sync_at END
      WHERE guild_id = $1 AND channel_id = $2`,
    [
      guildId, channelId, patch.status ?? null,
      patch.checkpointId !== undefined, patch.checkpointId ?? null,
      patch.error !== undefined, patch.error ?? null,
      patch.synced ?? false,
    ],
  );
}

export interface CoverageRow {
  channelId: string;
  scopeChannelId: string;
  channelName: string;
  status: CoverageStatus;
  messages: number;
  deleted: number;
  oldest: Date | null;
  newest: Date | null;
  lastSyncAt: Date | null;
  lastError: string | null;
}

export interface CoverageReport {
  indexed: CoverageRow[];
  /** Channels the owner has explicitly turned off. */
  excluded: ScopeRow[];
  totalMessages: number;
}

export async function coverageReport(db: Queryable, guildId: string): Promise<CoverageReport> {
  const res = await db.query(
    `SELECT c.channel_id, c.scope_channel_id, c.channel_name, c.status, c.last_sync_at, c.last_error,
            count(m.*) FILTER (WHERE m.deleted_at IS NULL)::int AS messages,
            count(m.*) FILTER (WHERE m.deleted_at IS NOT NULL)::int AS deleted,
            min(m.sent_at) FILTER (WHERE m.deleted_at IS NULL) AS oldest,
            max(m.sent_at) FILTER (WHERE m.deleted_at IS NULL) AS newest
       FROM index_coverage c
       LEFT JOIN source_message m ON m.guild_id = c.guild_id AND m.channel_id = c.channel_id
      WHERE c.guild_id = $1
      GROUP BY c.guild_id, c.channel_id
      ORDER BY c.channel_name`,
    [guildId],
  );
  const indexed: CoverageRow[] = res.rows.map((r) => ({
    channelId: r.channel_id, scopeChannelId: r.scope_channel_id, channelName: r.channel_name,
    status: r.status, messages: r.messages, deleted: r.deleted, oldest: r.oldest, newest: r.newest,
    lastSyncAt: r.last_sync_at, lastError: r.last_error,
  }));
  const excluded = (await listScope(db, guildId)).filter((s) => !s.allowed);
  return { indexed, excluded, totalMessages: indexed.reduce((n, r) => n + r.messages, 0) };
}

export async function logAction(db: Queryable, guildId: string, actorId: string, action: string, detail: object = {}): Promise<void> {
  await db.query(`INSERT INTO action_log (guild_id, actor_id, action, detail) VALUES ($1,$2,$3,$4)`, [guildId, actorId, action, JSON.stringify(detail)]);
}
