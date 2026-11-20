
export function loadConfig(env = process.env) {
  const token = env.TELEGRAM_BOT_TOKEN?.trim();
  if (!token || !/^\d+:[\w-]+$/.test(token)) throw new Error('Заповніть TELEGRAM_BOT_TOKEN у .env.');
  const secret = env.WEBHOOK_SECRET?.trim();
  if (!secret || !/^[\w-]{32,256}$/.test(secret)) throw new Error('WEBHOOK_SECRET: потрібно 32–256 символів A-Z, a-z, 0-9, _ або -.');
  let url;
  try { url = new URL(env.PUBLIC_BASE_URL); } catch { throw new Error('Вкажіть PUBLIC_BASE_URL — HTTPS-адресу хоста.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('PUBLIC_BASE_URL має бути HTTPS origin без шляху, пароля чи параметрів.');
  }
  const timezone = env.TIMEZONE || 'Europe/Warsaw';
  try { new Intl.DateTimeFormat('uk-UA', { timeZone: timezone }).format(); } catch { throw new Error('Невідомий TIMEZONE.'); }
  const port = Number(env.PORT || 8080);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Некоректний PORT.');
  const allowedChatIds = (env.ALLOWED_CHAT_IDS || '').split(',').map(x => x.trim()).filter(Boolean).map(Number);
  if (allowedChatIds.some(x => !Number.isSafeInteger(x))) throw new Error('ALLOWED_CHAT_IDS має містити числові ID чатів.');
  const ownerUserId = env.OWNER_USER_ID?.trim() ? Number(env.OWNER_USER_ID) : null;
  if (!/^postgres(?:ql)?:\/\//.test(env.DATABASE_URL || '')) throw new Error('Hosting edition requires PostgreSQL DATABASE_URL.');
  if (ownerUserId !== null && (!Number.isSafeInteger(ownerUserId) || ownerUserId <= 0)) throw new Error('OWNER_USER_ID має бути додатним числовим Telegram user ID.');
  return { token, secret, timezone, port, host: env.HOST || '127.0.0.1', publicUrl: url.origin,
    databasePath: env.DATABASE_URL, allowedChatIds: new Set(allowedChatIds), ownerUserId };
}
