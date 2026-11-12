import type { Queryable } from '../db/pool.js';
import { messageUrl } from './types.js';

export interface SearchOptions {
  guildId: string;
  query: string;
  /**
   * exact: the literal phrase, newest first. Deterministic; use for quotes and identifiers.
   * all:   every keyword must appear (plus phrase and fuzzy matches).
   * any:   any keyword may appear; best for natural-language questions.
   */
  mode?: 'exact' | 'all' | 'any';
  /** Limit to one channel (and its threads). */
  channelId?: string;
  from?: Date;
  to?: Date;
  /** Sensitive channels are only searched when this is true (private replies). */
  includeSensitive?: boolean;
  /** A sensitive channel is still searched when the question is asked inside it. */
  currentChannelId?: string;
  limit?: number;
  offset?: number;
}

export interface SearchHit {
  messageId: string;
  channelId: string;
  channelName: string;
  authorName: string;
  sentAt: Date;
  edited: boolean;
  content: string;
  url: string;
  /** Where the match was: the owner's own words, Discord's link preview, or both. */
  matchedIn: 'your_text' | 'link_preview' | 'both';
  matchKind: 'exact' | 'keywords' | 'fuzzy';
  previewTitles: string[];
  attachmentCount: number;
}

export interface SearchResult {
  hits: SearchHit[];
  /** Every match in scope, not just this page. */
  total: number;
  offset: number;
  scope: { channels: number; messages: number; sensitiveChannelsSkipped: number };
}

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * Search stored messages. Scope is re-read from channel_scope on every call,
 * so turning a channel off takes effect immediately.
 */
export async function search(db: Queryable, opts: SearchOptions): Promise<SearchResult> {
  const query = opts.query.trim();
  const mode = opts.mode ?? 'all';
  const limit = Math.min(Math.max(opts.limit ?? 5, 1), 25);
  const offset = Math.max(opts.offset ?? 0, 0);

  const scopeSql = `
    FROM source_message m
    JOIN channel_scope s ON s.guild_id = m.guild_id AND s.channel_id = m.scope_channel_id AND s.allowed
   WHERE m.guild_id = $1 AND m.deleted_at IS NULL
     AND ($2::boolean OR s.sensitivity = 'general' OR m.scope_channel_id = $3)
     AND ($4::text IS NULL OR m.scope_channel_id = $4 OR m.channel_id = $4)
     AND ($5::timestamptz IS NULL OR m.sent_at >= $5)
     AND ($6::timestamptz IS NULL OR m.sent_at < $6)`;
  const scopeParams = [
    opts.guildId, opts.includeSensitive ?? false, opts.currentChannelId ?? null,
    opts.channelId ?? null, opts.from ?? null, opts.to ?? null,
  ];

  const scopeRow = (
    await db.query(
      `SELECT count(DISTINCT m.scope_channel_id)::int AS channels, count(*)::int AS messages ${scopeSql}`,
      scopeParams,
    )
  ).rows[0];
  const skipped = opts.includeSensitive
    ? 0
    : (
        await db.query(
          `SELECT count(*)::int AS n FROM channel_scope
            WHERE guild_id = $1 AND allowed AND sensitivity = 'sensitive' AND channel_id IS DISTINCT FROM $2`,
          [opts.guildId, opts.currentChannelId ?? null],
        )
      ).rows[0].n;
  const scope = { channels: scopeRow.channels, messages: scopeRow.messages, sensitiveChannelsSkipped: skipped };
  if (!query) return { hits: [], total: 0, offset, scope };

  const tsq =
    mode === 'any'
      ? `NULLIF(replace(plainto_tsquery('english', $7)::text, '&', '|'), '')::tsquery`
      : `websearch_to_tsquery('english', $7)`;
  const fuzzyThreshold = mode === 'any' ? 0.6 : 0.5;
  const matchWhere =
    mode === 'exact' ? 'is_exact' : `(is_exact OR kw OR kw_embed OR sim >= ${fuzzyThreshold})`;
  const orderBy =
    mode === 'exact'
      ? 'sent_at DESC'
      : `(is_exact::int * 3 + kw::int * (1 + rank) + kw_embed::int * (0.5 + rank_embed) + sim) DESC, sent_at DESC`;

  const res = await db.query(
    `WITH scored AS (
       SELECT m.message_id, m.channel_id, m.author_name, m.sent_at, m.content_version, m.content, m.embeds,
              s.channel_name,
              (m.content ILIKE $8) AS is_exact,
              COALESCE(m.tsv_content @@ q.tsq, false) AS kw,
              COALESCE(m.tsv_embed @@ q.tsq, false) AS kw_embed,
              COALESCE(ts_rank_cd(m.tsv_content, q.tsq), 0) AS rank,
              COALESCE(ts_rank_cd(m.tsv_embed, q.tsq), 0) AS rank_embed,
              word_similarity($7, m.content) AS sim,
              (SELECT count(*)::int FROM source_attachment a WHERE a.guild_id = m.guild_id AND a.message_id = m.message_id) AS attachment_count
         ${scopeSql.replace('FROM source_message m', `FROM (SELECT ${tsq} AS tsq) q, source_message m`)}
     )
     SELECT *, count(*) OVER() AS total FROM scored
      WHERE ${matchWhere}
      ORDER BY ${orderBy}
      LIMIT $9 OFFSET $10`,
    [...scopeParams, query, `%${escapeLike(query)}%`, limit, offset],
  );

  const hits: SearchHit[] = res.rows.map((r) => ({
    messageId: r.message_id,
    channelId: r.channel_id,
    channelName: r.channel_name,
    authorName: r.author_name,
    sentAt: r.sent_at,
    edited: r.content_version > 1,
    content: r.content,
    url: messageUrl(opts.guildId, r.channel_id, r.message_id),
    matchedIn: r.is_exact || r.kw || !r.kw_embed ? (r.kw_embed ? 'both' : 'your_text') : 'link_preview',
    matchKind: r.is_exact ? 'exact' : r.kw || r.kw_embed ? 'keywords' : 'fuzzy',
    previewTitles: (r.embeds as { title: string | null }[]).map((e) => e.title).filter((t): t is string => Boolean(t)),
    attachmentCount: r.attachment_count,
  }));
  return { hits, total: res.rows[0] ? Number(res.rows[0].total) : 0, offset, scope };
}

const FILLER = new Set(
  `what have has had i i've ive saved save about my me the a an of in on for to and or did do does where when which
   show find everything anything all any that this those these with it is are was were tell give list get please
   notes note things thing stuff posted wrote said`.split(/\s+/),
);

/** Reduce a natural-language question to its content words for search-only answers. */
export function questionKeywords(question: string): string {
  const words = question.toLowerCase().replace(/[^\p{L}\p{N}\s'-]/gu, ' ').split(/\s+/).filter(Boolean);
  const kept = words.filter((w) => !FILLER.has(w));
  return (kept.length ? kept : words).join(' ');
}
