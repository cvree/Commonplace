import { createPool, type Db } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';
import { setScope } from '../src/core/store.js';
import { DEMO, buildSyntheticArchive, type SyntheticArchive } from '../src/demo/fixtures.js';
import { FakeDiscord } from '../src/demo/fake-discord.js';
import type { IndexTarget } from '../src/core/types.js';

export const TEST_DB = process.env.TEST_DATABASE_URL ?? 'postgres://commonplace:commonplace@localhost:5432/commonplace_test';

export async function freshDb(): Promise<Db> {
  const db = createPool(TEST_DB);
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate(db);
  return db;
}

export function target(key: keyof typeof DEMO.channels): IndexTarget {
  const c = DEMO.channels[key];
  return { channelId: c.id, scopeChannelId: c.id, name: c.name };
}

export async function seed(db: Db): Promise<{ fake: FakeDiscord; archive: SyntheticArchive }> {
  const archive = buildSyntheticArchive();
  const fake = new FakeDiscord();
  fake.add(...archive.messages);
  fake.setInaccessible(DEMO.channels.locked.id);
  for (const c of Object.values(DEMO.channels)) {
    await setScope(db, DEMO.guildId, c.id, c.name, true, c.sensitivity);
  }
  return { fake, archive };
}
