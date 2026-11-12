/**
 * Demo mode. Runs the real indexing and search code against a SYNTHETIC
 * archive and a fake Discord. It never connects to Discord and says nothing
 * about any real server.
 */
import 'dotenv/config';
import { backfillChannel } from '../core/backfill.js';
import { formatCoverage, formatResults } from '../core/format.js';
import { jobSummary } from '../core/jobs.js';
import { questionKeywords, search } from '../core/search.js';
import { coverageReport, markDeleted, setScope, upsertMessage } from '../core/store.js';
import { migrate } from '../db/migrate.js';
import { createPool } from '../db/pool.js';
import { FakeDiscord } from './fake-discord.js';
import { DEMO, buildSyntheticArchive } from './fixtures.js';

const url = process.env.DEMO_DATABASE_URL ?? process.env.DATABASE_URL;
if (!url) throw new Error('Set DATABASE_URL (or DEMO_DATABASE_URL) to a Postgres database for the demo.');
const db = createPool(url);
await migrate(db);
const G = DEMO.guildId;
const banner = (s: string) => console.log(`\n=== ${s} ===`);

console.log('SYNTHETIC DEMO: invented messages, fake Discord. Nothing here comes from a real server.');
for (const t of ['source_message', 'index_coverage', 'channel_scope']) await db.query(`DELETE FROM ${t} WHERE guild_id = $1`, [G]);

const archive = buildSyntheticArchive();
const fake = new FakeDiscord();
fake.add(...archive.messages);
fake.setInaccessible(DEMO.channels.locked.id);

banner('Indexing');
for (const c of Object.values(DEMO.channels)) {
  await setScope(db, G, c.id, c.name, true, c.sensitivity);
  const r = await backfillChannel(db, fake, { guildId: G, target: { channelId: c.id, scopeChannelId: c.id, name: c.name }, botUserId: DEMO.botUserId });
  console.log(`#${c.name}: ${r.status}, ${r.inserted} stored`);
}
await upsertMessage(db, { ...archive.refs.decision, content: 'Decision for Outbreak Islands: build the prototype in Unity instead.', editedAt: new Date('2026-03-20T10:00:00Z') });
await markDeleted(db, G, [archive.refs.toDelete.id]);
console.log('Then: one decision was edited, one message was deleted at the source.');

banner('/archive status');
console.log(formatCoverage(await coverageReport(db, G), await jobSummary(db), { discord: false }));

const show = async (label: string, opts: Parameters<typeof search>[1]) => {
  banner(label);
  console.log(formatResults(await search(db, opts), opts.query, { discord: false }));
};
const question = 'What have I saved about my game project?';
await show(`/ask ${question}  (search-only, keywords: "${questionKeywords(question)}")`, { guildId: G, query: questionKeywords(question), mode: 'any', includeSensitive: true });
await show('/find Outbreak Islands', { guildId: G, query: 'Outbreak Islands', includeSensitive: true, limit: 3 });
await show('/find "disipline is chosing between what you want"  (misremembered quote)', { guildId: G, query: 'disipline is chosing between what you want', includeSensitive: true });
await show('/find jump cuts  (only a link preview matches)', { guildId: G, query: 'jump cuts', includeSensitive: true });
await show('@mention in #general: sunscreen  (public reply, sensitive channel left out)', { guildId: G, query: 'sunscreen' });
await show('/find quarantine flags  (the deleted message)', { guildId: G, query: 'quarantine flags', includeSensitive: true });
await db.end();
