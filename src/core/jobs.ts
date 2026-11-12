import type { Db } from '../db/pool.js';
import { RateLimitError } from './types.js';

export interface Job {
  id: string;
  kind: string;
  payload: any;
  attempts: number;
}

export type JobHandler = (job: Job) => Promise<void>;

/** Queue a job unless an identical one is already waiting or running. */
export async function enqueue(db: Db, kind: string, dedupeKey: string, payload: object): Promise<boolean> {
  const res = await db.query(
    `INSERT INTO job (kind, dedupe_key, payload) VALUES ($1,$2,$3)
     ON CONFLICT (dedupe_key) WHERE status IN ('queued','running') DO NOTHING`,
    [kind, dedupeKey, JSON.stringify(payload)],
  );
  return (res.rowCount ?? 0) > 0;
}

/** Jobs left "running" by a crash or restart go back in the queue. */
export async function recoverStale(db: Db): Promise<number> {
  const res = await db.query(`UPDATE job SET status = 'queued', updated_at = now() WHERE status = 'running'`);
  return res.rowCount ?? 0;
}

async function claim(db: Db): Promise<Job | null> {
  const res = await db.query(
    `UPDATE job SET status = 'running', updated_at = now()
      WHERE id = (SELECT id FROM job WHERE status = 'queued' AND run_after <= now()
                   ORDER BY run_after, id FOR UPDATE SKIP LOCKED LIMIT 1)
      RETURNING id, kind, payload, attempts`,
  );
  return res.rows[0] ?? null;
}

async function runOne(db: Db, handlers: Record<string, JobHandler>, job: Job, backoffBaseMs: number): Promise<void> {
  try {
    const handler = handlers[job.kind];
    if (!handler) throw new Error(`No handler for job kind "${job.kind}"`);
    await handler(job);
    await db.query(`UPDATE job SET status = 'done', last_error = NULL, updated_at = now() WHERE id = $1`, [job.id]);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (err instanceof RateLimitError) {
      // Being told to wait is not a failure; honour the delay and do not use up an attempt.
      await db.query(
        `UPDATE job SET status = 'queued', last_error = $2, run_after = now() + ($3 || ' milliseconds')::interval, updated_at = now() WHERE id = $1`,
        [job.id, message, String(err.retryAfterMs)],
      );
      return;
    }
    const delayMs = backoffBaseMs * 2 ** job.attempts;
    await db.query(
      `UPDATE job SET attempts = attempts + 1, last_error = $2, updated_at = now(),
              status = CASE WHEN attempts + 1 >= max_attempts THEN 'failed' ELSE 'queued' END,
              run_after = now() + ($3 || ' milliseconds')::interval
        WHERE id = $1`,
      [job.id, message, String(delayMs)],
    );
  }
}

export interface WorkerOptions {
  concurrency?: number;
  pollMs?: number;
  backoffBaseMs?: number;
  signal?: AbortSignal;
}

/** Long-running bounded worker loop. */
export async function runWorker(db: Db, handlers: Record<string, JobHandler>, opts: WorkerOptions = {}): Promise<void> {
  const concurrency = opts.concurrency ?? 2;
  const pollMs = opts.pollMs ?? 1000;
  const loop = async () => {
    while (!opts.signal?.aborted) {
      const job = await claim(db).catch(() => null);
      if (!job) {
        await new Promise((r) => setTimeout(r, pollMs));
        continue;
      }
      await runOne(db, handlers, job, opts.backoffBaseMs ?? 5000);
    }
  };
  await Promise.all(Array.from({ length: concurrency }, loop));
}

/** Run everything that is due, then return. Used by tests and the demo. */
export async function drain(db: Db, handlers: Record<string, JobHandler>, opts: { backoffBaseMs?: number; maxJobs?: number } = {}): Promise<number> {
  let ran = 0;
  const max = opts.maxJobs ?? 1000;
  while (ran < max) {
    const job = await claim(db);
    if (!job) break;
    await runOne(db, handlers, job, opts.backoffBaseMs ?? 0);
    ran++;
  }
  return ran;
}

export async function jobSummary(db: Db): Promise<{ queued: number; running: number; failed: { kind: string; dedupeKey: string; lastError: string | null }[] }> {
  const counts = await db.query(`SELECT status, count(*)::int AS n FROM job WHERE status IN ('queued','running') GROUP BY status`);
  const failed = await db.query(`SELECT kind, dedupe_key, last_error FROM job WHERE status = 'failed' ORDER BY updated_at DESC LIMIT 10`);
  const get = (s: string) => counts.rows.find((r) => r.status === s)?.n ?? 0;
  return {
    queued: get('queued'),
    running: get('running'),
    failed: failed.rows.map((r) => ({ kind: r.kind, dedupeKey: r.dedupe_key, lastError: r.last_error })),
  };
}
