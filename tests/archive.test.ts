import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/pool.js';
import { backfillChannel } from '../src/core/backfill.js';
import { drain, enqueue, recoverStale } from '../src/core/jobs.js';
import { BACKFILL_JOB, backfillHandler, enqueueBackfill } from '../src/core/indexer.js';
import { coverageReport, forgetChannel, markDeleted, setScope, upsertMessage } from '../src/core/store.js';
import { questionKeywords, search } from '../src/core/search.js';
import { formatResults } from '../src/core/format.js';
import { exportBackup, restoreBackup } from '../src/core/backup.js';
import { RateLimitError } from '../src/core/types.js';
import { DEMO } from '../src/demo/fixtures.js';
import type { FakeDiscord } from '../src/demo/fake-discord.js';
import type { SyntheticArchive } from '../src/demo/fixtures.js';
import { freshDb, seed, target } from './helpers.js';

const G = DEMO.guildId;
let db: Db;
let fake: FakeDiscord;
let archive: SyntheticArchive;

async function indexAll(mode: 'resume' | 'rescan' = 'resume') {
  for (const key of Object.keys(DEMO.channels) as (keyof typeof DEMO.channels)[]) {
    await backfillChannel(db, fake, { guildId: G, target: target(key), botUserId: DEMO.botUserId, mode });
  }
}
const count = async (where = 'true') =>
  (await db.query(`SELECT count(*)::int AS n FROM source_message WHERE ${where}`)).rows[0].n as number;

beforeEach(async () => {
  if (db) await db.end();
  db = await freshDb();
  ({ fake, archive } = await seed(db));
});
afterAll(async () => db?.end());

describe('backfill', () => {
  it('indexes allowed channels, skips the bot itself, and reports an unreadable channel honestly', async () => {
    await indexAll();
    const expected = archive.messages.filter((m) => !m.authorIsBot && m.channelId !== DEMO.channels.locked.id).length;
    expect(await count()).toBe(expected);
    expect(await count(`author_id = '${DEMO.botUserId}'`)).toBe(0);
    expect(await count(`channel_id = '${DEMO.channels.locked.id}'`)).toBe(0);
    const report = await coverageReport(db, G);
    expect(report.indexed.find((r) => r.channelName === 'locked-notes')?.status).toBe('inaccessible');
    expect(report.indexed.find((r) => r.channelName === 'general')?.status).toBe('complete');
    expect(report.totalMessages).toBe(expected);
  });

  it('does not index a channel that is not in scope', async () => {
    await setScope(db, G, DEMO.channels.quotes.id, 'quotes-to-quote', false);
    const r = await backfillChannel(db, fake, { guildId: G, target: target('quotes'), botUserId: null });
    expect(r.status).toBe('out_of_scope');
    expect(await count()).toBe(0);
  });

  it('resumes an interrupted backfill from its checkpoint without duplicates', async () => {
    const handlers = { [BACKFILL_JOB]: backfillHandler(db, fake, DEMO.botUserId) };
    fake.failOnCall = { call: 2, error: new Error('socket hang up') };
    await enqueueBackfill(db, G, target('general'));
    await drain(db, handlers, { maxJobs: 1 });
    expect(await count()).toBe(100); // first page committed with its checkpoint
    expect((await coverageReport(db, G)).indexed[0]?.status).toBe('failed');
    const callsBefore = fake.calls;
    await drain(db, handlers);
    const inGeneral = archive.messages.filter((m) => m.channelId === DEMO.channels.general.id && !m.authorIsBot).length;
    expect(await count()).toBe(inGeneral);
    expect(fake.calls - callsBefore).toBe(2); // pages 2 and 3 only; page 1 was not re-read
    expect((await coverageReport(db, G)).indexed[0]?.status).toBe('complete');
  });

  it('waits as long as a rate limit asks, without using up a retry', async () => {
    const handlers = { [BACKFILL_JOB]: backfillHandler(db, fake, DEMO.botUserId) };
    fake.failOnCall = { call: 1, error: new RateLimitError(150) };
    await enqueueBackfill(db, G, target('quotes'));
    await drain(db, handlers);
    const job = (await db.query(`SELECT status, attempts, run_after > now() AS waiting FROM job`)).rows[0];
    expect(job).toMatchObject({ status: 'queued', attempts: 0, waiting: true });
    expect(await drain(db, handlers)).toBe(0); // not due yet
    await new Promise((r) => setTimeout(r, 200));
    expect(await drain(db, handlers)).toBe(1);
    expect(await count()).toBe(2);
  });

  it('requeues jobs that were running when the bot stopped, and never double-queues', async () => {
    expect(await enqueueBackfill(db, G, target('quotes'))).toBe(true);
    expect(await enqueueBackfill(db, G, target('quotes'))).toBe(false);
    await db.query(`UPDATE job SET status = 'running'`);
    expect(await recoverStale(db)).toBe(1);
    await drain(db, { [BACKFILL_JOB]: backfillHandler(db, fake, DEMO.botUserId) });
    expect(await count()).toBe(2);
  });

  it('gives up on a job that keeps failing and keeps the error', async () => {
    await enqueue(db, 'nope', 'nope:1', {});
    await db.query(`UPDATE job SET max_attempts = 2`);
    await drain(db, {});
    const job = (await db.query(`SELECT status, attempts, last_error FROM job`)).rows[0];
    expect(job.status).toBe('failed');
    expect(job.last_error).toMatch(/No handler/);
  });

  it('catches up on messages posted while offline', async () => {
    await indexAll();
    const before = await count();
    fake.add({ ...archive.refs.quote, id: '9999999999999999999', content: 'posted while the bot was offline', sentAt: new Date() });
    await indexAll();
    expect(await count()).toBe(before + 1);
  });
});

describe('edits and deletions', () => {
  it('keeps the earlier wording as a version and searches only the current one', async () => {
    await indexAll();
    const edited = { ...archive.refs.decision, content: 'Decision for Outbreak Islands: build the prototype in Unity instead.', editedAt: new Date('2026-03-20T10:00:00Z') };
    expect(await upsertMessage(db, edited)).toBe('edited');
    const row = (await db.query(`SELECT content_version FROM source_message WHERE message_id = $1`, [edited.id])).rows[0];
    expect(row.content_version).toBe(2);
    const versions = (await db.query(`SELECT version, content FROM source_message_version WHERE message_id = $1`, [edited.id])).rows;
    expect(versions).toEqual([{ version: 1, content: archive.refs.decision.content }]);
    expect((await search(db, { guildId: G, query: 'Godot', mode: 'exact' })).total).toBe(0);
    const unity = await search(db, { guildId: G, query: 'Unity', mode: 'exact' });
    expect(unity.hits[0]).toMatchObject({ messageId: edited.id, edited: true });
  });

  it('treats a late link-preview update as the same message, not an edit', async () => {
    await indexAll();
    const withPreview = { ...archive.refs.reel, embeds: [{ url: null, title: 'Reel preview', description: null, provider: 'Instagram', author: null }] };
    expect(await upsertMessage(db, withPreview)).toBe('unchanged');
    const row = (await db.query(`SELECT content_version, embed_text FROM source_message WHERE message_id = $1`, [withPreview.id])).rows[0];
    expect(row.content_version).toBe(1);
    expect(row.embed_text).toContain('Reel preview');
  });

  it('wipes a deleted source down to a tombstone', async () => {
    await indexAll();
    await upsertMessage(db, { ...archive.refs.toDelete, content: 'edited once before deletion' });
    expect(await markDeleted(db, G, [archive.refs.toDelete.id])).toBe(1);
    const row = (await db.query(`SELECT content, deleted_at FROM source_message WHERE message_id = $1`, [archive.refs.toDelete.id])).rows[0];
    expect(row.content).toBe('');
    expect(row.deleted_at).not.toBeNull();
    expect((await db.query(`SELECT 1 FROM source_message_version WHERE message_id = $1`, [archive.refs.toDelete.id])).rows).toHaveLength(0);
    expect((await search(db, { guildId: G, query: 'quarantine flags' })).total).toBe(0);
    expect((await search(db, { guildId: G, query: 'monetization', mode: 'any' })).total).toBe(0);
  });

  it('rescan finds edits and deletions made while offline', async () => {
    await indexAll();
    fake.edit(DEMO.channels.gameIdeas.id, archive.refs.decision.id, 'Decision for Outbreak Islands: Unity.', new Date());
    fake.remove(DEMO.channels.gameIdeas.id, archive.refs.toDelete.id);
    const r = await backfillChannel(db, fake, { guildId: G, target: target('gameIdeas'), botUserId: DEMO.botUserId, mode: 'rescan' });
    expect(r).toMatchObject({ status: 'complete', edited: 1, deleted: 1 });
  });

  it('never treats a permission error as a deletion', async () => {
    await indexAll();
    const before = await count('deleted_at IS NULL');
    fake.setInaccessible(DEMO.channels.gameIdeas.id);
    const r = await backfillChannel(db, fake, { guildId: G, target: target('gameIdeas'), botUserId: DEMO.botUserId, mode: 'rescan' });
    expect(r.status).toBe('inaccessible');
    expect(await count('deleted_at IS NULL')).toBe(before);
  });
});

describe('search', () => {
  beforeEach(async () => indexAll());

  it('finds every indexed mention, reports the true total, and pages through it', async () => {
    const page1 = await search(db, { guildId: G, query: 'Outbreak Islands', limit: 3 });
    expect(page1.total).toBe(5); // the bot's own "summary" is not among them
    expect(page1.hits).toHaveLength(3);
    const page2 = await search(db, { guildId: G, query: 'Outbreak Islands', limit: 3, offset: 3 });
    expect(page2.hits).toHaveLength(2);
    const ids = new Set([...page1.hits, ...page2.hits].map((h) => h.messageId));
    expect(ids.size).toBe(5);
    expect(ids.has(archive.refs.botReply.id)).toBe(false);
    expect(page1.hits[0]!.url).toBe(`https://discord.com/channels/${G}/${page1.hits[0]!.channelId}/${page1.hits[0]!.messageId}`);
    const text = formatResults(page1, 'Outbreak Islands', { discord: true });
    expect(text).toContain('Showing 1–3 of 5 matches');
    expect(text).toContain('More results exist');
  });

  it('keeps both saves of the same video, each with its own note', async () => {
    const r = await search(db, { guildId: G, query: 'SYNTH0001', mode: 'exact' });
    expect(r.hits.map((h) => h.messageId).sort()).toEqual([archive.refs.dupA.id, archive.refs.dupB.id].sort());
  });

  it('finds a quote from an exact fragment and from misremembered wording', async () => {
    const exact = await search(db, { guildId: G, query: 'discipline is choosing', mode: 'exact' });
    expect(exact.hits.map((h) => h.messageId)).toEqual([archive.refs.quote.id]);
    const fuzzy = await search(db, { guildId: G, query: 'disipline is chosing between what you want' });
    expect(fuzzy.hits[0]).toMatchObject({ messageId: archive.refs.quote.id, matchKind: 'fuzzy' });
  });

  it('answers a natural question in search-only mode', async () => {
    const q = questionKeywords('What have I saved about my game project?');
    expect(q).toBe('game project');
    const r = await search(db, { guildId: G, query: q, mode: 'any' });
    expect(r.total).toBeGreaterThan(0);
    expect(r.hits.every((h) => /game/i.test(h.content))).toBe(true);
  });

  it('labels a match that exists only in a link preview', async () => {
    const r = await search(db, { guildId: G, query: 'jump cuts' });
    expect(r.total).toBe(2);
    expect(r.hits.every((h) => h.matchedIn === 'link_preview')).toBe(true);
    expect(formatResults(r, 'jump cuts', { discord: false })).toContain('matched on the link preview only');
  });

  it('leaves sensitive channels out unless the reply is private or asked there', async () => {
    const pub = await search(db, { guildId: G, query: 'sunscreen' });
    expect(pub.total).toBe(0);
    expect(pub.scope.sensitiveChannelsSkipped).toBe(1);
    expect(formatResults(pub, 'sunscreen', { discord: true })).toContain('1 sensitive channel was left out');
    expect((await search(db, { guildId: G, query: 'sunscreen', includeSensitive: true })).total).toBe(2);
    expect((await search(db, { guildId: G, query: 'sunscreen', currentChannelId: DEMO.channels.skin.id })).total).toBe(2);
  });

  it('rechecks scope on every query and honours channel and date filters', async () => {
    expect((await search(db, { guildId: G, query: 'rotten apple' })).total).toBe(1);
    await setScope(db, G, DEMO.channels.quotes.id, 'quotes-to-quote', false);
    expect((await search(db, { guildId: G, query: 'rotten apple' })).total).toBe(0);
    const scoped = await search(db, { guildId: G, query: 'Outbreak Islands', channelId: DEMO.channels.general.id });
    expect(scoped.total).toBe(0);
    const dated = await search(db, { guildId: G, query: 'Outbreak Islands', from: new Date('2026-03-01'), to: new Date('2026-03-10') });
    expect(dated.total).toBe(2);
  });

  it('never returns another server\'s messages', async () => {
    expect((await search(db, { guildId: '123', query: 'Outbreak Islands', includeSensitive: true })).total).toBe(0);
  });

  it('says so plainly when nothing supports the query', async () => {
    const r = await search(db, { guildId: G, query: 'zeppelin maintenance schedule' });
    expect(formatResults(r, 'zeppelin maintenance schedule', { discord: true })).toMatch(/couldn't find anything/);
  });

  it('quotes stored prompt-injection text as inert data that cannot ping anyone', async () => {
    const r = await search(db, { guildId: G, query: 'SYSTEM OVERRIDE', mode: 'exact' });
    expect(r.hits).toHaveLength(1);
    const text = formatResults(r, 'SYSTEM OVERRIDE', { discord: true });
    expect(text).not.toContain('@everyone');
    expect(text).toContain('@​everyone');
    expect((await db.query(`SELECT count(*)::int AS n FROM channel_scope WHERE allowed`)).rows[0].n).toBe(5);
  });

  it('forgets a channel on request', async () => {
    const removed = await forgetChannel(db, G, DEMO.channels.skin.id);
    expect(removed).toBe(3);
    expect((await search(db, { guildId: G, query: 'sunscreen', includeSensitive: true })).total).toBe(0);
  });
});

describe('backup and restore', () => {
  it('round-trips the archive into an empty database with search intact', async () => {
    await indexAll();
    await upsertMessage(db, { ...archive.refs.decision, content: 'Decision: Unity.', editedAt: new Date() });
    await markDeleted(db, G, [archive.refs.toDelete.id]);
    const backup = JSON.parse(JSON.stringify(await exportBackup(db, G)));
    const before = await search(db, { guildId: G, query: 'Outbreak Islands', limit: 25 });

    await db.end();
    db = await freshDb();
    const counts = await restoreBackup(db, backup);
    expect(counts.source_message).toBe(backup.tables.source_message.length);
    const after = await search(db, { guildId: G, query: 'Outbreak Islands', limit: 25 });
    expect(after.hits.map((h) => h.messageId)).toEqual(before.hits.map((h) => h.messageId));
    expect((await db.query(`SELECT count(*)::int AS n FROM source_message_version`)).rows[0].n).toBe(1);
    await expect(restoreBackup(db, backup)).rejects.toThrow(/already holds messages/);
    await expect(restoreBackup(db, { ...backup, version: 99 })).rejects.toThrow(/Unsupported backup version/);
  });
});
