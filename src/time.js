const HOUR = 3_600_000;

function parts(timestamp, timezone) {
  const entries = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit',
    day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
    .formatToParts(timestamp).filter(p => p.type !== 'literal').map(p => [p.type, Number(p.value)]);
  return Object.fromEntries(entries);
}

export function parseWhen(input, timezone, now = Date.now()) {
  const value = input.trim().toLowerCase();
  const match = /^(?:(\d{4})-(\d{2})-(\d{2})|(сьогодні|завтра|today|tomorrow))\s+(\d{2}):(\d{2})$/.exec(value);
  if (!match) throw new Error('Час: YYYY-MM-DD HH:mm, «сьогодні HH:mm» або «завтра HH:mm».');
  let [, year, month, day, relative, hour, minute] = match;
  if (relative) {
    const local = parts(now, timezone);
    const date = new Date(Date.UTC(local.year, local.month - 1, local.day + (['завтра', 'tomorrow'].includes(relative) ? 1 : 0)));
    [year, month, day] = [date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate()];
  }
  [year, month, day, hour, minute] = [year, month, day, hour, minute].map(Number);
  const naive = Date.UTC(year, month - 1, day, hour, minute);
  const date = new Date(naive);
  if (year < 2020 || hour > 23 || minute > 59 || date.getUTCFullYear() !== year || date.getUTCMonth() + 1 !== month || date.getUTCDate() !== day) {
    throw new Error('Такої дати або часу не існує.');
  }
  const offsets = new Set();
  for (let shift = -36; shift <= 36; shift += 6) {
    const sample = naive + shift * HOUR;
    const p = parts(sample, timezone);
    offsets.add(Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - sample);
  }
  const candidates = [...offsets].map(offset => naive - offset).filter(candidate => {
    const p = parts(candidate, timezone);
    return p.year === year && p.month === month && p.day === day && p.hour === hour && p.minute === minute;
  });
  if (candidates.length !== 1) throw new Error('Цей час пропущений або повторюється при переході на літній/зимовий час. Оберіть інший.');
  if (candidates[0] <= now) throw new Error('Нагадування має бути в майбутньому.');
  return candidates[0];
}

export function formatWhen(timestamp, timezone) {
  return new Intl.DateTimeFormat('uk-UA', { timeZone: timezone, dateStyle: 'short', timeStyle: 'short' }).format(timestamp) + ` (${timezone})`;
}

export function localDate(timestamp, timezone) {
  const p = parts(timestamp, timezone);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

export function addDays(date, days) {
  const result = new Date(date + 'T12:00:00Z');
  result.setUTCDate(result.getUTCDate() + days);
  return result.toISOString().slice(0, 10);
}
