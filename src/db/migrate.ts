import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { createPool, withTx, type Db } from './pool.js';

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');

export async function migrate(db: Db): Promise<string[]> {
  await db.query(
    `CREATE TABLE IF NOT EXISTS schema_migration (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`,
  );
  const applied = new Set((await db.query('SELECT name FROM schema_migration')).rows.map((r) => r.name));
  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
  const ran: string[] = [];
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = await readFile(path.join(MIGRATIONS_DIR, file), 'utf8');
    await withTx(db, async (tx) => {
      await tx.query(sql);
      await tx.query('INSERT INTO schema_migration (name) VALUES ($1)', [file]);
    });
    ran.push(file);
  }
  return ran;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  await import('dotenv/config');
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');
  const db = createPool(url);
  const ran = await migrate(db);
  console.log(ran.length ? `Applied: ${ran.join(', ')}` : 'Database is up to date.');
  await db.end();
}
