import { expect, it } from 'vitest';
import { zonedDateToUtc } from '../src/core/time.js';

it('reads a calendar date in the configured timezone', () => {
  expect(zonedDateToUtc('2026-01-15', 'America/Los_Angeles').toISOString()).toBe('2026-01-15T08:00:00.000Z');
  expect(zonedDateToUtc('2026-07-15', 'America/Los_Angeles').toISOString()).toBe('2026-07-15T07:00:00.000Z');
  expect(zonedDateToUtc('2026-03-08', 'America/Los_Angeles').toISOString()).toBe('2026-03-08T08:00:00.000Z'); // clocks change that day
  expect(zonedDateToUtc('2026-03-09', 'America/Los_Angeles').toISOString()).toBe('2026-03-09T07:00:00.000Z');
  expect(zonedDateToUtc('2026-06-01', 'Asia/Tokyo').toISOString()).toBe('2026-05-31T15:00:00.000Z');
  expect(() => zonedDateToUtc('2026-02-30', 'UTC')).toThrow(/not a real calendar date/);
  expect(() => zonedDateToUtc('last month', 'UTC')).toThrow(/YYYY-MM-DD/);
});
