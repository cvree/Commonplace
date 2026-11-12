/** Platform-neutral shapes. Nothing in src/core imports discord.js. */

export interface RawAttachment {
  id: string;
  filename: string;
  contentType: string | null;
  sizeBytes: number | null;
  url: string;
}

export interface RawEmbed {
  url: string | null;
  title: string | null;
  description: string | null;
  provider: string | null;
  author: string | null;
}

export interface RawMessage {
  guildId: string;
  id: string;
  /** Channel or thread the message was posted in. */
  channelId: string;
  /** Parent channel for threads; equals channelId otherwise. Scope is checked against this. */
  scopeChannelId: string;
  authorId: string;
  authorName: string;
  authorIsBot: boolean;
  sentAt: Date;
  editedAt: Date | null;
  content: string;
  replyToId: string | null;
  attachments: RawAttachment[];
  embeds: RawEmbed[];
}

export interface IndexTarget {
  channelId: string;
  scopeChannelId: string;
  name: string;
}

/** The channel exists but the bot may not read it. Never treated as "deleted". */
export class AccessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AccessError';
  }
}

/** The platform asked us to wait. */
export class RateLimitError extends Error {
  constructor(public readonly retryAfterMs: number) {
    super(`Rate limited; retry after ${retryAfterMs} ms`);
    this.name = 'RateLimitError';
  }
}

/** Read access to message history. Implemented by discord.js in production and by a fake in tests. */
export interface HistorySource {
  /**
   * Up to `limit` messages strictly newer than `afterId`, oldest first.
   * `afterId` of null means "from the beginning".
   * Must throw AccessError (not return []) when the bot lacks permission.
   */
  fetchAfter(channelId: string, afterId: string | null, limit: number): Promise<RawMessage[]>;
}

export function messageUrl(guildId: string, channelId: string, messageId: string): string {
  return `https://discord.com/channels/${guildId}/${channelId}/${messageId}`;
}
