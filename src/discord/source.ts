import {
  ChannelType, DiscordAPIError, MessageType, PermissionFlagsBits,
  type Client, type Guild, type Message,
} from 'discord.js';
import { AccessError, type HistorySource, type IndexTarget, type RawMessage } from '../core/types.js';

const INDEXABLE_TYPES = new Set<MessageType>([MessageType.Default, MessageType.Reply]);
const ACCESS_CODES = new Set<number | string>([50001, 50013, 10003]);

/** Convert a discord.js message. Returns null for system messages and anything outside a server. */
export function toRaw(m: Message): RawMessage | null {
  if (!m.inGuild() || !INDEXABLE_TYPES.has(m.type)) return null;
  const scopeChannelId = m.channel.isThread() ? m.channel.parentId : m.channelId;
  if (!scopeChannelId) return null;
  return {
    guildId: m.guildId,
    id: m.id,
    channelId: m.channelId,
    scopeChannelId,
    authorId: m.author.id,
    authorName: m.author.username,
    authorIsBot: m.author.bot,
    sentAt: m.createdAt,
    editedAt: m.editedAt,
    content: m.content,
    replyToId: m.reference?.messageId ?? null,
    attachments: [...m.attachments.values()].map((a) => ({
      id: a.id, filename: a.name, contentType: a.contentType, sizeBytes: a.size, url: a.url,
    })),
    embeds: m.embeds.map((e) => ({
      url: e.url, title: e.title, description: e.description, provider: e.provider?.name ?? null, author: e.author?.name ?? null,
    })),
  };
}

export class DiscordHistory implements HistorySource {
  constructor(private readonly client: Client<true>) {}

  async fetchAfter(channelId: string, afterId: string | null, limit: number): Promise<RawMessage[]> {
    try {
      const channel = await this.client.channels.fetch(channelId);
      if (!channel || channel.isDMBased() || !channel.isTextBased()) throw new AccessError('Not a readable server channel.');
      // Discord returns an EMPTY list, not an error, when Read Message History
      // is missing. Check explicitly so an empty page is never mistaken for an empty channel.
      const perms = channel.permissionsFor(this.client.user);
      if (!perms?.has(PermissionFlagsBits.ViewChannel) || !perms.has(PermissionFlagsBits.ReadMessageHistory)) {
        throw new AccessError('The bot needs View Channel and Read Message History here.');
      }
      // discord.js queues requests per route and honours Discord's rate-limit headers and retry_after.
      const page = await channel.messages.fetch({ after: afterId ?? '0', limit, cache: false });
      return [...page.values()]
        .sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1))
        .map(toRaw)
        .filter((m): m is RawMessage => m !== null);
    } catch (err) {
      if (err instanceof DiscordAPIError && ACCESS_CODES.has(err.code)) throw new AccessError(err.message);
      throw err;
    }
  }
}

/** Channels and threads to index for the allowed parent channels. Also reports what could not be listed. */
export async function listTargets(guild: Guild, allowedChannelIds: string[]): Promise<{ targets: IndexTarget[]; notes: string[] }> {
  const targets: IndexTarget[] = [];
  const notes: string[] = [];
  const allowed = new Set(allowedChannelIds);
  const seen = new Set<string>();
  const push = (t: IndexTarget) => {
    if (!seen.has(t.channelId)) {
      seen.add(t.channelId);
      targets.push(t);
    }
  };

  for (const id of allowed) {
    const channel = await guild.channels.fetch(id).catch(() => null);
    if (!channel) {
      notes.push(`Channel ${id} no longer exists or is hidden from the bot.`);
      continue;
    }
    const hasOwnMessages = channel.type === ChannelType.GuildText || channel.type === ChannelType.GuildAnnouncement;
    const hasThreads = hasOwnMessages || channel.type === ChannelType.GuildForum || channel.type === ChannelType.GuildMedia;
    if (hasOwnMessages) push({ channelId: channel.id, scopeChannelId: channel.id, name: channel.name });
    if (!hasThreads || !('threads' in channel)) continue;
    for (const kind of ['public', 'private'] as const) {
      try {
        const archived = await channel.threads.fetchArchived({ type: kind, fetchAll: true });
        for (const t of archived.threads.values()) push({ channelId: t.id, scopeChannelId: channel.id, name: `${channel.name} › ${t.name}` });
      } catch {
        // Private archived threads need Manage Threads, which this bot does not ask for.
        if (kind === 'public') notes.push(`Could not list archived threads in #${channel.name}.`);
      }
    }
  }
  const active = await guild.channels.fetchActiveThreads().catch(() => null);
  for (const t of active?.threads.values() ?? []) {
    if (t.parentId && allowed.has(t.parentId)) push({ channelId: t.id, scopeChannelId: t.parentId, name: `${t.parent?.name ?? 'thread'} › ${t.name}` });
  }
  return { targets, notes };
}
