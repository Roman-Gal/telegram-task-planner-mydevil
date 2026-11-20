import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { createWebhookServer, WEBHOOK_PATH } from '../src/server.js';
import { Telegram, TelegramError } from '../src/telegram.js';

test('HTTP webhook checks secret, persists updates before ACK, and deduplicates retries', async t => {
  const store = new Store(':memory:');
  const server = createWebhookServer({ secret: 'a'.repeat(32), store });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); store.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': 'a'.repeat(32) };
  const post = (body, override = headers) => fetch(base + WEBHOOK_PATH, { method: 'POST', headers: override, body });
  assert.equal((await fetch(base + '/health')).status, 200);
  assert.equal((await fetch(base + '/elsewhere')).status, 404);
  assert.equal((await post('{"update_id":1}', { 'content-type': 'application/json' })).status, 401);
  assert.equal(store.nextUpdate(), undefined);
  assert.equal((await post('{')).status, 400);
  assert.equal((await post('[]')).status, 400);
  assert.equal((await post('{"update_id":"1"}')).status, 400);
  assert.equal((await post('{"update_id":1}')).status, 200);
  assert.equal((await post('{"update_id":1}')).status, 200);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM updates').get().count, 1);
  assert.equal((await post('x'.repeat(257 * 1024))).status, 413);
});
test('storage errors return 503 so Telegram can retry', async t => {
  const server = createWebhookServer({ secret: 's', store: { enqueue() { throw new Error('disk full'); } }, log: { error() {} } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const response = await fetch(`http://127.0.0.1:${server.address().port}${WEBHOOK_PATH}`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': 's' }, body: '{"update_id":1}',
  });
  assert.equal(response.status, 503);
});
test('Telegram transport errors omit tokens and respect retry_after', async () => {
  const telegram = new Telegram('PRIVATE_TOKEN', async () => { throw new Error('https://api.telegram.org/botPRIVATE_TOKEN'); });
  await assert.rejects(telegram.call('getMe'), error => error instanceof TelegramError && !error.message.includes('PRIVATE_TOKEN'));
  const limited = new Telegram('token', async () => ({ ok: false, status: 429, json: async () => ({ ok: false, error_code: 429, parameters: { retry_after: 30 } }) }));
  await assert.rejects(limited.call('sendMessage'), error => error.code === 429 && error.retryAfter === 30);
});
