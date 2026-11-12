import { loadConfig } from './config.js';
import { migrate } from './db/migrate.js';
import { createPool } from './db/pool.js';
import { startBot } from './discord/bot.js';

try {
  const config = loadConfig();
  const db = createPool(config.DATABASE_URL);
  await migrate(db);
  const client = await startBot(db, config);
  const stop = async () => {
    await client.destroy();
    await db.end();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}
