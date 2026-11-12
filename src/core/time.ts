/** Midnight at the start of a YYYY-MM-DD date in an IANA timezone, as a UTC instant. */
export function zonedDateToUtc(date: string, timeZone: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date.trim());
  if (!m) throw new Error(`"${date}" is not a date. Use YYYY-MM-DD, for example 2026-03-01.`);
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const utcGuess = Date.UTC(y, mo - 1, d);
  if (new Date(utcGuess).getUTCDate() !== d) throw new Error(`"${date}" is not a real calendar date.`);
  const offsetAt = (t: number) => {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric',
    }).formatToParts(new Date(t));
    const get = (type: string) => Number(parts.find((p) => p.type === type)!.value);
    return Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second')) - t;
  };
  let t = utcGuess - offsetAt(utcGuess);
  t = utcGuess - offsetAt(t); // second pass settles dates next to a clock change
  return new Date(t);
}
