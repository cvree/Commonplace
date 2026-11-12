import { withTx, type Db } from '../db/pool.js';

export const BACKUP_FORMAT = 'commonplace-backup';
export const BACKUP_VERSION = 1;

/** Authoritative tables and the columns that are exported. Search columns are generated and rebuild themselves. */
const TABLES: Record<string, string[]> = {
  channel_scope: ['guild_id', 'channel_id', 'channel_name', 'allowed', 'sensitivity', 'updated_at'],
  source_message: [
    'guild_id', 'message_id', 'channel_id', 'scope_channel_id', 'author_id', 'author_name', 'author_is_bot',
    'sent_at', 'edited_at', 'content', 'content_version', 'content_hash', 'reply_to_id', 'embeds', 'embed_text',
    'deleted_at', 'first_indexed_at', 'last_seen_at',
  ],
  source_message_version: ['guild_id', 'message_id', 'version', 'content', 'edited_at', 'recorded_at'],
  source_attachment: ['guild_id', 'attachment_id', 'message_id', 'filename', 'content_type', 'size_bytes', 'url', 'extraction_status'],
  index_coverage: ['guild_id', 'channel_id', 'scope_channel_id', 'channel_name', 'status', 'checkpoint_id', 'last_sync_at', 'last_error'],
  action_log: ['guild_id', 'actor_id', 'action', 'detail', 'created_at'],
};

export interface Backup {
  format: typeof BACKUP_FORMAT;
  version: number;
  exportedAt: string;
  guildId: string;
  tables: Record<string, Record<string, unknown>[]>;
}

export async function exportBackup(db: Db, guildId: string): Promise<Backup> {
  const tables: Backup['tables'] = {};
  for (const [table, cols] of Object.entries(TABLES)) {
    const res = await db.query(`SELECT ${cols.join(', ')} FROM ${table} WHERE guild_id = $1`, [guildId]);
    tables[table] = res.rows;
  }
  return { format: BACKUP_FORMAT, version: BACKUP_VERSION, exportedAt: new Date().toISOString(), guildId, tables };
}

/**
 * Restore a backup. Refuses to merge into an archive that already has data
 * for this server unless `replace` is set, in which case that server's rows
 * are removed first. All or nothing.
 */
export async function restoreBackup(db: Db, backup: Backup, opts: { replace?: boolean } = {}): Promise<Record<string, number>> {
  if (backup.format !== BACKUP_FORMAT) throw new Error('Not a Commonplace backup file.');
  if (backup.version !== BACKUP_VERSION) throw new Error(`Unsupported backup version ${backup.version}; this build reads version ${BACKUP_VERSION}.`);
  const counts: Record<string, number> = {};
  await withTx(db, async (tx) => {
    const existing = await tx.query(`SELECT count(*)::int AS n FROM source_message WHERE guild_id = $1`, [backup.guildId]);
    if (existing.rows[0].n > 0 && !opts.replace) {
      throw new Error('This database already holds messages for that server. Re-run with --replace to overwrite them.');
    }
    for (const table of Object.keys(TABLES).reverse()) {
      await tx.query(`DELETE FROM ${table} WHERE guild_id = $1`, [backup.guildId]);
    }
    for (const [table, cols] of Object.entries(TABLES)) {
      const rows = backup.tables[table] ?? [];
      for (const row of rows) {
        const values = cols.map((c) => {
          const v = row[c];
          return v !== null && typeof v === 'object' && !(v instanceof Date) ? JSON.stringify(v) : v;
        });
        await tx.query(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})`, values);
      }
      counts[table] = rows.length;
    }
  });
  return counts;
}
