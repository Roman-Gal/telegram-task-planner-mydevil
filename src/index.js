import { setTimeout as sleep } from 'node:timers/promises';
import { loadConfig } from './config.js';
import { Store } from './store.js';
import { Telegram, TelegramError } from './telegram.js';
import { Planner } from './planner.js';
import { createWebhookServer, WEBHOOK_PATH } from './server.js';

async function main() {
  let config;
  try { config = loadConfig(); } catch (error) { console.error(error.message); process.exitCode = 1; return; }
  const store = new Store(config.databasePath);
  const telegram = new Telegram(config.token);
  const planner = new Planner(store, telegram, config);
  const server = createWebhookServer({ secret: config.secret, store, onUpdate: () => planner.drain() });
  let timer;
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(timer);
    planner.stopping = true;
    if (server.listening) {
      const closed = new Promise(resolve => server.close(resolve));
      server.closeIdleConnections();
      await closed;
    }
    while (planner.draining || planner.reminding) await sleep(25);
    store.close();
  };
  process.once('SIGINT', () => { void shutdown(); });
  process.once('SIGTERM', () => { void shutdown(); });
  try {
    const me = await telegram.call('getMe');
    if (shuttingDown) return;
    planner.username = me.username;
    planner.access.botId = me.id;
    await telegram.call('setMyCommands', { commands: [
      { command: 'menu', description: '📋 Меню та створення завдання кнопками' },
      { command: 'help', description: 'Як користуватися планнером' },
      { command: 'id', description: 'Показати мій числовий Telegram ID' },
      { command: 'task', description: 'Створити завдання' },
      { command: 'tasks', description: '📋 Усі завдання чату' },
      { command: 'done', description: 'Позначити виконаним: /done ID' },
      { command: 'snooze', description: 'Відкласти на 15 хв: /snooze ID' },
      { command: 'cancel', description: 'Скасувати: /cancel ID' },
      { command: 'stop', description: 'Вимкнути особисті нагадування' },
    ] });
    if (shuttingDown) return;
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(config.port, config.host, () => { server.off('error', reject); resolve(); });
    });
    if (shuttingDown) return;
    await telegram.call('setWebhook', {
      url: config.publicUrl + WEBHOOK_PATH, secret_token: config.secret,
      allowed_updates: ['message', 'callback_query', 'my_chat_member', 'chat_member'], max_connections: 10, drop_pending_updates: false,
    });
    if (shuttingDown) return;
    const tick = () => {
      void planner.drain().catch(() => console.error('Update worker failed; will retry.'));
      void planner.remind().catch(() => console.error('Reminder worker failed; will retry.'));
    };
    timer = setInterval(tick, 1000);
    tick();
    console.log(`Planner @${me.username} ready on ${config.host}:${config.port}; timezone ${config.timezone}.`);
    console.log(`Webhook: ${config.publicUrl}${WEBHOOK_PATH}`);
    console.log('Managed MyDevil service; PostgreSQL is the authoritative store.');
  } catch (error) {
    console.error(error instanceof TelegramError ? `Startup failed: Telegram API code ${error.code}. Check token/network and bot settings.` : 'Startup failed. Check port, database path and filesystem permissions.');
    await shutdown();
    process.exitCode = 1;
  }
}

main().catch(() => { console.error('Fatal startup error. No credentials were logged.'); process.exitCode = 1; });
