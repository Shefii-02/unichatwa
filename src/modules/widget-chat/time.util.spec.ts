import { nowLocal, toIso } from './time.util';

describe('widget-chat time util (Laravel app-timezone wall-clock)', () => {
  const saved = process.env.APP_TIMEZONE;
  afterAll(() => { if (saved === undefined) delete process.env.APP_TIMEZONE; else process.env.APP_TIMEZONE = saved; });

  it('reads a naive Asia/Kolkata DATETIME as the right UTC instant (+05:30)', () => {
    expect(toIso('2026-10-28 10:30:00')).toBe('2026-10-28T05:00:00.000Z');
  });

  it('round-trips: nowLocal() → toIso() is the same instant (to the second)', () => {
    const d = new Date('2026-03-01T20:15:42.000Z');
    expect(toIso(nowLocal(d))).toBe(d.toISOString());
  });

  it('handles null / garbage', () => {
    expect(toIso(null)).toBeNull();
    expect(toIso('not a date')).toBeNull();
  });
});
