import { AccessError, RateLimitError, type HistorySource, type RawMessage } from '../core/types.js';

/**
 * In-memory stand-in for Discord's history API, for tests and demo mode only.
 * It can be told to fail in the ways the real API does.
 */
export class FakeDiscord implements HistorySource {
  private channels = new Map<string, RawMessage[]>();
  private inaccessible = new Set<string>();
  /** Throw this error on the Nth fetch call (1-based), once. */
  failOnCall: { call: number; error: Error } | null = null;
  calls = 0;

  add(...messages: RawMessage[]): void {
    for (const m of messages) {
      const list = this.channels.get(m.channelId) ?? [];
      list.push(m);
      list.sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
      this.channels.set(m.channelId, list);
    }
  }

  edit(channelId: string, id: string, content: string, editedAt: Date): void {
    const m = this.channels.get(channelId)?.find((x) => x.id === id);
    if (!m) throw new Error(`No message ${id}`);
    m.content = content;
    m.editedAt = editedAt;
  }

  remove(channelId: string, id: string): void {
    this.channels.set(channelId, (this.channels.get(channelId) ?? []).filter((m) => m.id !== id));
  }

  setInaccessible(channelId: string, value = true): void {
    if (value) this.inaccessible.add(channelId);
    else this.inaccessible.delete(channelId);
  }

  async fetchAfter(channelId: string, afterId: string | null, limit: number): Promise<RawMessage[]> {
    this.calls++;
    if (this.failOnCall && this.calls === this.failOnCall.call) {
      const { error } = this.failOnCall;
      this.failOnCall = null;
      throw error;
    }
    if (this.inaccessible.has(channelId)) throw new AccessError('Missing Access');
    const all = this.channels.get(channelId) ?? [];
    const start = afterId === null ? all : all.filter((m) => BigInt(m.id) > BigInt(afterId));
    return start.slice(0, limit).map((m) => structuredClone(m));
  }
}

export { RateLimitError };
