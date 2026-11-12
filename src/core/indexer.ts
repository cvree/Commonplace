import type { Db } from '../db/pool.js';
import { backfillChannel } from './backfill.js';
import { enqueue, type JobHandler } from './jobs.js';
import type { HistorySource, IndexTarget } from './types.js';

export const BACKFILL_JOB = 'backfill';

export function enqueueBackfill(db: Db, guildId: string, target: IndexTarget, mode: 'resume' | 'rescan' = 'resume'): Promise<boolean> {
  return enqueue(db, BACKFILL_JOB, `${BACKFILL_JOB}:${guildId}:${target.channelId}`, { guildId, target, mode });
}

export function backfillHandler(db: Db, source: HistorySource, botUserId: string | null): JobHandler {
  return async (job) => {
    const { guildId, target, mode } = job.payload as { guildId: string; target: IndexTarget; mode: 'resume' | 'rescan' };
    await backfillChannel(db, source, { guildId, target, botUserId, mode });
  };
}
