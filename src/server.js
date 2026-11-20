import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';

export const WEBHOOK_PATH = '/telegram/webhook';

export function createWebhookServer({ secret, store, onUpdate = () => {}, log = console }) {
  const expected = Buffer.from(secret);
  const server = createServer(async (req, res) => {
    const respond = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(body));
    };
    if (req.url === '/health' && req.method === 'GET') return respond(200, { status: 'ok' });
    if (req.url !== WEBHOOK_PATH || req.method !== 'POST') return respond(404, { error: 'not_found' });
    const received = Buffer.from(req.headers['x-telegram-bot-api-secret-token'] || '');
    if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
      req.resume(); return respond(401, { error: 'unauthorized' });
    }
    if (!req.headers['content-type']?.toLowerCase().startsWith('application/json')) {
      req.resume(); return respond(415, { error: 'json_required' });
    }
    try {
      let size = 0;
      const chunks = [];
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 256 * 1024) { req.resume(); return respond(413, { error: 'too_large' }); }
        chunks.push(chunk);
      }
      let update;
      try { update = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { return respond(400, { error: 'invalid_json' }); }
      if (!update || Array.isArray(update) || !Number.isSafeInteger(update.update_id) || update.update_id < 0) {
        return respond(400, { error: 'invalid_update' });
      }
      // Commit before acknowledging: Telegram may safely retry the same update.
      store.enqueue(update);
      respond(200, { ok: true });
      Promise.resolve().then(onUpdate).catch(() => log.error('Update worker failed; persistent queue retained.'));
    } catch {
      log.error('Webhook storage/request failure.');
      if (!res.headersSent) respond(503, { error: 'temporarily_unavailable' });
    }
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  return server;
}
