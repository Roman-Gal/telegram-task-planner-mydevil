import test from 'node:test';
import assert from 'node:assert/strict';
import { parseWhen, formatWhen } from '../src/time.js';
import { loadConfig } from '../src/config.js';

const zone = 'Europe/Warsaw';
const now = Date.parse('2026-11-19T12:00:00Z');

test('absolute and Ukrainian relative dates use Warsaw local time', () => {
  assert.equal(parseWhen('2026-11-19 18:30', zone, now), Date.parse('2026-11-19T17:30:00Z'));
  assert.equal(parseWhen('завтра 18:30', zone, now), Date.parse('2026-11-20T17:30:00Z'));
  assert.equal(parseWhen('сьогодні 18:30', zone, now), Date.parse('2026-11-19T17:30:00Z'));
  assert.match(formatWhen(now, zone), /Europe\/Warsaw/);
});
test('relative dates cross year and UTC day boundaries correctly', () => {
  assert.equal(parseWhen('tomorrow 00:30', zone, Date.parse('2026-12-31T22:00:00Z')), Date.parse('2026-12-31T23:30:00Z'));
  assert.equal(parseWhen('сьогодні 12:00', zone, Date.parse('2026-11-19T23:30:00Z')), Date.parse('2026-11-20T11:00:00Z'));
});
test('invalid calendar dates, past times, and malformed dates are rejected', () => {
  for (const value of ['2027-02-29 18:00', '2026-11-19 25:00', '2026-11-19 12:00', '18:30', '2026-13-01 10:00']) {
    assert.throws(() => parseWhen(value, zone, now));
  }
});
test('DST missing and ambiguous times are rejected', () => {
  const before = Date.parse('2026-01-01T00:00:00Z');
  assert.throws(() => parseWhen('2026-03-29 02:30', zone, before), /літній/);
  assert.throws(() => parseWhen('2026-10-25 02:30', zone, before), /літній/);
  assert.equal(parseWhen('2026-03-29 03:30', zone, before), Date.parse('2026-03-29T01:30:00Z'));
});
test('configuration requires secrets and an HTTPS origin', () => {
  const env = { DATABASE_URL: "postgresql://test:test@localhost/test", TELEGRAM_BOT_TOKEN: '12345:test-token', WEBHOOK_SECRET: 'a'.repeat(32), PUBLIC_BASE_URL: 'https://example.ngrok.app' };
  assert.equal(loadConfig(env).timezone, zone);
  assert.throws(() => loadConfig({ ...env, WEBHOOK_SECRET: '' }));
  assert.throws(() => loadConfig({ ...env, PUBLIC_BASE_URL: 'http://example.com' }));
  assert.throws(() => loadConfig({ ...env, PUBLIC_BASE_URL: 'https://example.com/secret' }));
  assert.throws(() => loadConfig({ ...env, ALLOWED_CHAT_IDS: '-100,NaN' }));
});
