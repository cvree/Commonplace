import {
  ChannelType, MessageFlags, SlashCommandBuilder,
  type ChatInputCommandInteraction, type Guild,
} from 'discord.js';
import type { Config } from '../config.js';
import type { Db } from '../db/pool.js';
import { formatCoverage, formatResults } from '../core/format.js';
import { enqueueBackfill } from '../core/indexer.js';
import { jobSummary } from '../core/jobs.js';
import { questionKeywords, search } from '../core/search.js';
import { coverageReport, forgetChannel, listScope, logAction, setScope } from '../core/store.js';
import { zonedDateToUtc } from '../core/time.js';
import { listTargets } from './source.js';

const SCOPE_CHANNEL_TYPES = [ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildForum, ChannelType.GuildMedia] as const;
/** Channel names that default to "sensitive" unless the owner says otherwise. */
const SENSITIVE_NAME = /health|skin|diet|symptom|medical|money|financ|prayer|heal|relationship|therapy|journal/i;

export const commandDefinitions = [
  new SlashCommandBuilder()
    .setName('find')
    .setDescription('Search what you saved, with links to the originals')
    .addStringOption((o) => o.setName('query').setDescription('Words or a phrase').setRequired(true))
    .addStringOption((o) =>
      o.setName('mode').setDescription('How to match (default: combined)').addChoices(
        { name: 'combined: keywords, phrase and similar wording', value: 'all' },
        { name: 'exact: the literal phrase only', value: 'exact' },
      ),
    )
    .addChannelOption((o) => o.setName('channel').setDescription('Only this channel').addChannelTypes(...SCOPE_CHANNEL_TYPES))
    .addStringOption((o) => o.setName('after').setDescription('On or after this date, YYYY-MM-DD'))
    .addStringOption((o) => o.setName('before').setDescription('Before this date, YYYY-MM-DD'))
    .addIntegerOption((o) => o.setName('page').setDescription('Results page').setMinValue(1)),
  new SlashCommandBuilder()
    .setName('ask')
    .setDescription('Ask a question about your archive')
    .addStringOption((o) => o.setName('question').setDescription('Your question').setRequired(true)),
  new SlashCommandBuilder()
    .setName('archive')
    .setDescription('What is indexed, and what the bot may read')
    .addSubcommand((s) => s.setName('status').setDescription('Coverage: channels, date ranges, last sync, failures'))
    .addSubcommand((s) =>
      s.setName('scope').setDescription('Allow or exclude a channel')
        .addChannelOption((o) => o.setName('channel').setDescription('Channel').setRequired(true).addChannelTypes(...SCOPE_CHANNEL_TYPES))
        .addStringOption((o) => o.setName('action').setDescription('Allow or exclude').setRequired(true).addChoices({ name: 'allow', value: 'allow' }, { name: 'exclude', value: 'exclude' }))
        .addBooleanOption((o) => o.setName('sensitive').setDescription('Health, money or other private material: kept out of public replies')),
    )
    .addSubcommand((s) =>
      s.setName('index').setDescription('Index allowed channels (resumes where it left off)')
        .addBooleanOption((o) => o.setName('rescan').setDescription('Re-read everything to pick up edits and deletions made while the bot was offline')),
    )
    .addSubcommand((s) =>
      s.setName('forget').setDescription('Remove a channel from the index. Your Discord messages are not touched.')
        .addChannelOption((o) => o.setName('channel').setDescription('Channel').setRequired(true).addChannelTypes(...SCOPE_CHANNEL_TYPES)),
    ),
].map((c) => c.toJSON());

export interface CommandContext {
  db: Db;
  config: Config;
  guild: Guild;
}

const PAGE_SIZE = 5;
const quiet = { allowedMentions: { parse: [] as never[] } };

export async function handleCommand(i: ChatInputCommandInteraction, ctx: CommandContext): Promise<void> {
  const { db, config, guild } = ctx;
  await i.deferReply({ flags: MessageFlags.Ephemeral });
  const reply = (content: string) => i.editReply({ content, ...quiet });

  try {
    if (i.commandName === 'find') {
      const query = i.options.getString('query', true);
      const after = i.options.getString('after');
      const before = i.options.getString('before');
      const page = i.options.getInteger('page') ?? 1;
      const result = await search(db, {
        guildId: guild.id,
        query,
        mode: (i.options.getString('mode') as 'all' | 'exact' | null) ?? 'all',
        channelId: i.options.getChannel('channel')?.id,
        from: after ? zonedDateToUtc(after, config.TIMEZONE) : undefined,
        to: before ? zonedDateToUtc(before, config.TIMEZONE) : undefined,
        includeSensitive: true, // the reply is visible only to the owner
        limit: PAGE_SIZE,
        offset: (page - 1) * PAGE_SIZE,
      });
      await reply(formatResults(result, query, { discord: true }));
      return;
    }

    if (i.commandName === 'ask') {
      await reply(await answer(db, guild.id, i.options.getString('question', true), { includeSensitive: true }));
      return;
    }

    if (i.commandName === 'archive') {
      const sub = i.options.getSubcommand();
      if (sub === 'status') {
        await reply(formatCoverage(await coverageReport(db, guild.id), await jobSummary(db), { discord: true }));
      } else if (sub === 'scope') {
        const channel = i.options.getChannel('channel', true);
        const name = channel.name ?? channel.id;
        const allow = i.options.getString('action', true) === 'allow';
        const explicit = i.options.getBoolean('sensitive');
        const sensitive = explicit ?? SENSITIVE_NAME.test(name);
        await setScope(db, guild.id, channel.id, name, allow, allow ? (sensitive ? 'sensitive' : 'general') : undefined);
        await logAction(db, guild.id, i.user.id, allow ? 'scope.allow' : 'scope.exclude', { channelId: channel.id, sensitive });
        if (!allow) {
          await reply(`#${name} is excluded. New messages there are ignored and existing ones no longer appear in results. Use \`/archive forget\` to also remove what was indexed.`);
          return;
        }
        const { targets } = await listTargets(guild, [channel.id]);
        for (const t of targets) await enqueueBackfill(db, guild.id, t);
        const guessed = explicit === null && sensitive ? ' I marked it sensitive because of its name; pass `sensitive: False` to change that.' : '';
        await reply(`#${name} is allowed${sensitive ? ' and marked **sensitive** (kept out of public replies)' : ''}.${guessed} Indexing its history now; \`/archive status\` shows progress.`);
      } else if (sub === 'index') {
        const rescan = i.options.getBoolean('rescan') ?? false;
        const allowed = (await listScope(db, guild.id)).filter((s) => s.allowed).map((s) => s.channelId);
        if (allowed.length === 0) {
          await reply('No channels are allowed yet. Add some with `/archive scope`.');
          return;
        }
        const { targets, notes } = await listTargets(guild, allowed);
        for (const t of targets) await enqueueBackfill(db, guild.id, t, rescan ? 'rescan' : 'resume');
        await logAction(db, guild.id, i.user.id, rescan ? 'index.rescan' : 'index.resume', { targets: targets.length });
        const head = `${rescan ? 'Rescanning' : 'Indexing'} ${targets.length} channels and threads.${notes.length ? `\n${notes.join('\n')}` : ''}`;
        await reply(head);
        // Live progress for as long as the interaction can be edited (15 minutes).
        const deadline = Date.now() + 13 * 60_000;
        while (Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 5000));
          const jobs = await jobSummary(db);
          const report = await coverageReport(db, guild.id);
          const done = jobs.queued + jobs.running === 0;
          await reply(`${head}\n${done ? 'Done.' : `Working: ${jobs.running} running, ${jobs.queued} waiting.`} ${report.totalMessages} messages indexed so far.${done ? ' See `/archive status` for details.' : ''}`);
          if (done) return;
        }
        await reply(`${head}\nStill working in the background. \`/archive status\` shows progress.`);
      } else if (sub === 'forget') {
        const channel = i.options.getChannel('channel', true);
        const removed = await forgetChannel(db, guild.id, channel.id);
        await logAction(db, guild.id, i.user.id, 'index.forget', { channelId: channel.id, removed });
        await reply(`Removed ${removed} indexed messages from #${channel.name ?? channel.id} and excluded the channel. Your original Discord messages are untouched.`);
      }
    }
  } catch (err) {
    console.error(`Command /${i.commandName} failed:`, err instanceof Error ? err.message : err);
    await reply(`That didn't work: ${err instanceof Error ? err.message : 'unexpected error'}`);
  }
}

/**
 * Answer a question. No generation model is wired in yet, so this is an
 * honest search-only answer: matching sources, not a written synthesis.
 */
export async function answer(
  db: Db,
  guildId: string,
  question: string,
  opts: { includeSensitive: boolean; currentChannelId?: string },
): Promise<string> {
  const keywords = questionKeywords(question);
  const result = await search(db, { guildId, query: keywords, mode: 'any', limit: PAGE_SIZE, ...opts });
  if (result.total === 0) return formatResults(result, question, { discord: true });
  return `Search-only answer (no AI model is configured, so nothing here is summarized or inferred). Best matches for **${keywords.replace(/@/g, '@​')}**:\n\n${formatResults(result, question, { discord: true, maxLength: 1750 })}`;
}
