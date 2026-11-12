import 'dotenv/config';
import { z } from 'zod';

const snowflake = z.string().regex(/^\d{17,20}$/, 'must be a Discord ID (17-20 digits). Enable Developer Mode, then right-click → Copy ID.');

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  DISCORD_TOKEN: z.string().min(1),
  DISCORD_GUILD_ID: snowflake,
  DISCORD_OWNER_ID: snowflake,
  /** IANA timezone used to read dates like "2026-03-01" in commands. */
  TIMEZONE: z.string().default('UTC'),
  /** Reaction the bot adds when it has saved one of your messages. Empty turns it off. */
  ACK_REACTION: z.string().default('🗂️'),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Configuration is incomplete. Copy .env.example to .env and fill it in.\n${problems}\n\nNo credentials yet? Run "npm run demo" to try it on a synthetic archive.`);
  }
  try {
    new Intl.DateTimeFormat('en', { timeZone: parsed.data.TIMEZONE });
  } catch {
    throw new Error(`TIMEZONE "${parsed.data.TIMEZONE}" is not a valid IANA timezone (example: America/Los_Angeles).`);
  }
  return parsed.data;
}
