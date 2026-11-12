import type { SearchHit, SearchResult } from './search.js';
import type { CoverageReport } from './store.js';

export interface FormatOptions {
  /** Discord renders <t:...> in the reader's own timezone; the CLI demo uses plain dates. */
  discord: boolean;
  maxLength?: number;
}

/** Stored text is data. Make sure quoting it can never ping anyone. */
export function defuse(text: string): string {
  return text.replace(/@/g, '@​');
}

function snippet(text: string, max = 280): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function date(d: Date, discord: boolean): string {
  return discord ? `<t:${Math.floor(d.getTime() / 1000)}:D>` : d.toISOString().slice(0, 10);
}

function hitBlock(hit: SearchHit, n: number, o: FormatOptions): string {
  const lines: string[] = [];
  const how = hit.matchKind === 'exact' ? 'exact phrase' : hit.matchKind === 'keywords' ? 'keywords' : 'similar wording';
  lines.push(`**${n}.** #${hit.channelName} · ${date(hit.sentAt, o.discord)}${hit.edited ? ' · edited' : ''} · ${how}`);
  if (hit.content) lines.push(`> ${defuse(snippet(hit.content))}`);
  if (hit.previewTitles.length) {
    const note = hit.matchedIn === 'link_preview' ? 'matched on the link preview only, not on anything you wrote' : 'link preview';
    lines.push(`_${note}: “${defuse(snippet(hit.previewTitles[0]!, 100))}” (a title, not the video's contents)_`);
  }
  if (hit.attachmentCount) lines.push(`_${hit.attachmentCount} attachment${hit.attachmentCount > 1 ? 's' : ''}_`);
  lines.push(o.discord ? `<${hit.url}>` : hit.url);
  return lines.join('\n');
}

export function scopeLine(r: SearchResult): string {
  const skipped = r.scope.sensitiveChannelsSkipped
    ? ` ${r.scope.sensitiveChannelsSkipped} sensitive channel${r.scope.sensitiveChannelsSkipped > 1 ? 's were' : ' was'} left out.`
    : '';
  return `Searched ${r.scope.messages} indexed messages in ${r.scope.channels} channel${r.scope.channels === 1 ? '' : 's'}.${skipped}`;
}

export function formatResults(r: SearchResult, query: string, o: FormatOptions): string {
  const max = o.maxLength ?? 1900;
  if (r.total === 0) {
    return `I couldn't find anything for “${defuse(query)}”.\n${scopeLine(r)} Anything outside those channels, or not yet indexed, was not checked.`;
  }
  const first = r.offset + 1;
  const parts: string[] = [];
  let used = 0;
  let shown = 0;
  const footer = (count: number) => {
    const last = r.offset + count;
    const more = r.total > last ? ` More results exist: ask for the next page.` : '';
    return `Showing ${first}–${last} of ${r.total} matches.${more}\n${scopeLine(r)}`;
  };
  for (const [i, hit] of r.hits.entries()) {
    const block = hitBlock(hit, r.offset + i + 1, o);
    if (used + block.length + 2 > max - 220 && shown > 0) break;
    parts.push(block);
    used += block.length + 2;
    shown++;
  }
  return `${parts.join('\n\n')}\n\n${footer(shown)}`;
}

export function formatCoverage(c: CoverageReport, jobs: { queued: number; running: number; failed: { dedupeKey: string; lastError: string | null }[] }, o: FormatOptions): string {
  if (c.indexed.length === 0) {
    return 'Nothing is indexed yet. Choose channels with `/archive scope`, then run `/archive index`.';
  }
  const lines = [`**Archive coverage**: ${c.totalMessages} messages`];
  for (const row of c.indexed) {
    const range = row.oldest && row.newest ? `${date(row.oldest, o.discord)} → ${date(row.newest, o.discord)}` : 'no messages';
    const sync = row.lastSyncAt ? `, last sync ${o.discord ? `<t:${Math.floor(row.lastSyncAt.getTime() / 1000)}:R>` : row.lastSyncAt.toISOString()}` : '';
    const state =
      row.status === 'complete' ? '✓'
      : row.status === 'inaccessible' ? '⚠ cannot read (permissions); existing index kept'
      : row.status === 'failed' ? `✗ failed: ${row.lastError ?? 'unknown error'}`
      : `… ${row.status}`;
    const removed = row.deleted ? `, ${row.deleted} deleted at source` : '';
    lines.push(`#${row.channelName}: ${row.messages} messages (${range})${removed}${sync} ${state}`);
  }
  if (c.excluded.length) lines.push(`Excluded by you: ${c.excluded.map((s) => `#${s.channelName}`).join(', ')}`);
  if (jobs.queued + jobs.running) lines.push(`Indexing in progress: ${jobs.running} running, ${jobs.queued} waiting.`);
  for (const f of jobs.failed) lines.push(`Failed job ${f.dedupeKey}: ${f.lastError ?? 'unknown error'}`);
  const text = lines.join('\n');
  return text.length > 1900 ? `${text.slice(0, 1880)}\n… (truncated)` : text;
}
