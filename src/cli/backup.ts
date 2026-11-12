import 'dotenv/config';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { exportBackup, restoreBackup } from '../core/backup.js';
import { migrate } from '../db/migrate.js';
import { createPool } from '../db/pool.js';

const [action, ...args] = process.argv.slice(2);
const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is not set');
const db = createPool(url);
try {
  await migrate(db);
  if (action === 'export') {
    const guildId = args[0] ?? process.env.DISCORD_GUILD_ID;
    if (!guildId) throw new Error('Usage: npm run backup -- [server id]   (or set DISCORD_GUILD_ID)');
    const backup = await exportBackup(db, guildId);
    await mkdir('backups', { recursive: true });
    const file = path.join('backups', `commonplace-${guildId}-${backup.exportedAt.replace(/[:.]/g, '-')}.json`);
    await writeFile(file, JSON.stringify(backup), { mode: 0o600 });
    console.log(`Wrote ${file}: ${backup.tables.source_message?.length ?? 0} messages. This file contains your messages in plain text; store it somewhere private.`);
  } else if (action === 'restore') {
    const file = args.find((a) => !a.startsWith('--'));
    if (!file) throw new Error('Usage: npm run restore -- <backup file> [--replace]');
    const counts = await restoreBackup(db, JSON.parse(await readFile(file, 'utf8')), { replace: args.includes('--replace') });
    console.log('Restored:', counts);
  } else {
    throw new Error('Usage: backup.ts export|restore');
  }
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  await db.end();
}
