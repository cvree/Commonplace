import { withTx, type Db } from '../db/pool.js';
import { isAllowed, markDeleted, registerTarget, setCoverage, upsertMessage } from './store.js';
import { AccessError, type HistorySource, type IndexTarget } from './types.js';

export interface BackfillOptions {
  guildId: string;
  target: IndexTarget;
  /** The bot's own user id; its messages are never indexed as knowledge. */
  botUserId: string | null;
  /**
   * resume: continue from the checkpoint (first run, restarts, catching up after downtime).
   * rescan: re-read the whole channel to pick up edits and deletions that happened while offline.
   */
  mode?: 'resume' | 'rescan';
  pageSize?: number;
  onProgress?: (p: { channelId: string; stored: number }) => void;
}

export interface BackfillResult {
  status: 'complete' | 'inaccessible' | 'out_of_scope';
  seen: number;
  inserted: number;
  edited: number;
  deleted: number;
}

/**
 * Index one channel or thread. Each page is stored together with its
 * checkpoint in a single transaction, so an interruption at any point resumes
 * exactly where it stopped and never produces duplicates.
 */
export async function backfillChannel(db: Db, source: HistorySource, opts: BackfillOptions): Promise<BackfillResult> {
  const { guildId, target, botUserId } = opts;
  const mode = opts.mode ?? 'resume';
  const pageSize = opts.pageSize ?? 100;
  const result: BackfillResult = { status: 'complete', seen: 0, inserted: 0, edited: 0, deleted: 0 };

  if (!(await isAllowed(db, guildId, target.scopeChannelId))) {
    return { ...result, status: 'out_of_scope' };
  }
  await registerTarget(db, guildId, target);
  await setCoverage(db, guildId, target.channelId, { status: 'running', error: null });

  const scanStartedAt = new Date();
  const seenIds: string[] = [];
  let after: string | null = null;
  if (mode === 'resume') {
    const cp = await db.query(`SELECT checkpoint_id FROM index_coverage WHERE guild_id = $1 AND channel_id = $2`, [guildId, target.channelId]);
    after = cp.rows[0]?.checkpoint_id ?? null;
  }

  try {
    for (;;) {
      const page = await source.fetchAfter(target.channelId, after, pageSize);
      if (page.length === 0) break;
      const last = page[page.length - 1]!;
      await withTx(db, async (tx) => {
        for (const msg of page) {
          if (botUserId && msg.authorId === botUserId) continue;
          const outcome = await upsertMessage(tx, msg);
          if (outcome === 'inserted' || outcome === 'restored') result.inserted++;
          if (outcome === 'edited') result.edited++;
        }
        if (mode === 'resume') {
          await setCoverage(tx, guildId, target.channelId, { checkpointId: last.id });
        }
      });
      for (const msg of page) seenIds.push(msg.id);
      result.seen += page.length;
      after = last.id;
      opts.onProgress?.({ channelId: target.channelId, stored: result.seen });
      if (page.length < pageSize) break;
    }
  } catch (err) {
    if (err instanceof AccessError) {
      // Not being allowed to read a channel says nothing about its messages.
      // Keep what we have and report the gap.
      await setCoverage(db, guildId, target.channelId, { status: 'inaccessible', error: err.message });
      return { ...result, status: 'inaccessible' };
    }
    await setCoverage(db, guildId, target.channelId, { status: 'failed', error: String(err instanceof Error ? err.message : err) });
    throw err;
  }

  if (mode === 'rescan') {
    // The whole channel was read successfully, so anything we hold that was
    // not in it has been deleted at the source. Messages that arrived while
    // the scan ran are left alone.
    const gone = await db.query(
      `SELECT message_id FROM source_message
        WHERE guild_id = $1 AND channel_id = $2 AND deleted_at IS NULL
          AND first_indexed_at < $3 AND NOT (message_id = ANY($4))`,
      [guildId, target.channelId, scanStartedAt, seenIds],
    );
    result.deleted = await markDeleted(db, guildId, gone.rows.map((r) => r.message_id));
    if (after) await setCoverage(db, guildId, target.channelId, { checkpointId: after });
  }

  await setCoverage(db, guildId, target.channelId, { status: 'complete', error: null, synced: true });
  return result;
}
