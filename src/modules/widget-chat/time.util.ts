/**
 * Laravel writes `widget_*` timestamps as naive strings in its app timezone (APP_TIMEZONE, default
 * Asia/Kolkata), so Node must read and write the same wall-clock, not the Node process / DB server zone.
 */
const TZ = process.env.APP_TIMEZONE || 'Asia/Kolkata';

const fmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
});

function parts(d: Date): Record<string, string> {
  return Object.fromEntries(fmt.formatToParts(d).map(p => [p.type, p.value]));
}

/** "YYYY-MM-DD HH:mm:ss" for `d` in the Laravel app timezone — what to store in a DATETIME column. */
export function nowLocal(d: Date = new Date()): string {
  const p = parts(d);
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
}

/** Naive app-timezone DATETIME string (as selected with DATE_FORMAT) → ISO-8601 UTC. */
export function toIso(naive: string | null | undefined): string | null {
  if (!naive) return null;
  const asUtc = Date.parse(naive.replace(' ', 'T') + 'Z');
  if (Number.isNaN(asUtc)) return null;
  const p = parts(new Date(asUtc));
  const shown = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return new Date(asUtc - (shown - asUtc)).toISOString();
}

/** SQL fragment: select a DATETIME column as a naive string for toIso(). */
export const dt = (col: string, alias = col.split('.').pop()!): string =>
  `DATE_FORMAT(${col}, '%Y-%m-%d %H:%i:%s') AS ${alias}`;
