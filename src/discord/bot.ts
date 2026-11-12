import { Client, Events, GatewayIntentBits, Partials, type Message, type PartialMessage } from 'discord.js';
import type { Config } from '../config.js';
import type { Db } from '../db/pool.js';
import { BACKFILL_JOB, backfillHandler, enqueueBackfill } from '../core/indexer.js';
import { recoverStale, runWorker } from '../core/jobs.js';
import { isAllowed, listScope, markDeleted, upsertMessage } from '../core/store.js';
import { answer, commandDefinitions, handleCommand } from './commands.js';
import { DiscordHistory, listTargets, toRaw } from './source.js';

export async function startBot(db: Db, config: Config): Promise<Client<true>> {
  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
    partials: [Partials.Message, Partials.Channel],
    allowedMentions: { parse: [] }, // nothing the bot sends can ping anyone
  });

  const ready = new Promise<Client<true>>((resolve) => client.once(Events.ClientReady, (c) => resolve(c)));
  await client.login(config.DISCORD_TOKEN);
  const c = await ready;

  // Confirm the configured server and owner are real before doing anything.
  const guild = await c.guilds.fetch(config.DISCORD_GUILD_ID).catch(() => null);
  if (!guild) {
    throw new Error(`The bot is not in server ${config.DISCORD_GUILD_ID}. Invite it first (see README), or fix DISCORD_GUILD_ID.`);
  }
  const owner = await guild.members.fetch(config.DISCORD_OWNER_ID).catch(() => null);
  if (!owner) throw new Error(`User ${config.DISCORD_OWNER_ID} is not a member of "${guild.name}". Fix DISCORD_OWNER_ID.`);
  console.log(`Connected as ${c.user.tag} to "${guild.name}" for owner ${owner.user.username}.`);
  for (const other of c.guilds.cache.values()) {
    if (other.id !== guild.id) console.warn(`Ignoring server "${other.name}" (${other.id}): not the configured server.`);
  }
  await guild.commands.set(commandDefinitions);

  const inScope = async (m: Message | PartialMessage): Promise<boolean> => {
    if (m.guildId !== guild.id) return false;
    const scopeId = m.channel.isThread() ? m.channel.parentId : m.channelId;
    return scopeId ? isAllowed(db, guild.id, scopeId) : false;
  };

  c.on(Events.MessageCreate, async (m) => {
    try {
      if (m.guildId !== guild.id || m.author.id === c.user.id) return;
      // A question addressed to the bot is a request, not something to remember.
      if (m.mentions.users.has(c.user.id) && !m.mentions.everyone) {
        if (m.author.id !== config.DISCORD_OWNER_ID) return;
        if (!(await inScope(m))) {
          await m.reply('This channel is not in my scope. Add it with `/archive scope` first.');
          return;
        }
        const question = m.content.replace(/<@!?\d+>/g, '').trim();
        if (!question) return;
        // Public reply: sensitive channels stay out unless the question was asked inside one.
        const scopeId = m.channel.isThread() ? m.channel.parentId! : m.channelId;
        await m.reply(await answer(db, guild.id, question, { includeSensitive: false, currentChannelId: scopeId }));
        return;
      }
      if (!(await inScope(m))) return;
      const raw = toRaw(m);
      if (!raw) return;
      await upsertMessage(db, raw);
      if (config.ACK_REACTION && m.author.id === config.DISCORD_OWNER_ID) {
        await m.react(config.ACK_REACTION).catch(() => undefined);
      }
    } catch (err) {
      console.error('Failed to save a new message:', err instanceof Error ? err.message : err);
    }
  });

  c.on(Events.MessageUpdate, async (_old, updated) => {
    try {
      if (updated.guildId !== guild.id || !(await inScope(updated))) return;
      // Update events can be partial (for example, only a link preview). Always read the full message.
      const full = updated.partial ? await updated.fetch() : updated;
      if (full.author.id === c.user.id) return;
      const raw = toRaw(full);
      if (raw) await upsertMessage(db, raw);
    } catch (err) {
      console.error('Failed to record an edit:', err instanceof Error ? err.message : err);
    }
  });

  c.on(Events.MessageDelete, async (m) => {
    if (m.guildId === guild.id) await markDeleted(db, guild.id, [m.id]).catch((e) => console.error('Failed to record a deletion:', e.message));
  });
  c.on(Events.MessageBulkDelete, async (messages) => {
    const first = messages.first();
    if (first?.guildId === guild.id) await markDeleted(db, guild.id, [...messages.keys()]).catch((e) => console.error('Failed to record deletions:', e.message));
  });

  c.on(Events.InteractionCreate, async (i) => {
    if (!i.isChatInputCommand()) return;
    if (i.guildId !== guild.id || i.user.id !== config.DISCORD_OWNER_ID) {
      await i.reply({ content: 'This archive is private to its owner.', flags: 64 }).catch(() => undefined);
      return;
    }
    await handleCommand(i, { db, config, guild });
  });

  // Background indexing. On every start: put interrupted jobs back, then catch up on anything missed.
  await recoverStale(db);
  const allowed = (await listScope(db, guild.id)).filter((s) => s.allowed).map((s) => s.channelId);
  const { targets, notes } = await listTargets(guild, allowed);
  for (const t of targets) await enqueueBackfill(db, guild.id, t);
  for (const n of notes) console.warn(n);
  console.log(`Catching up on ${targets.length} channels and threads.`);
  void runWorker(db, { [BACKFILL_JOB]: backfillHandler(db, new DiscordHistory(c), c.user.id) }, { concurrency: 2 });

  return c;
}
