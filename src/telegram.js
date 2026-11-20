export class TelegramError extends Error {
  constructor(code, retryAfter = 0) {
    super(`Telegram API error ${code}`);
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

export class Telegram {
  constructor(token, request = fetch) { this.token = token; this.request = request; }
  async call(method, body = {}) {
    // Never log the request URL: it contains the bot token.
    let response;
    try {
      response = await this.request(`https://api.telegram.org/bot${this.token}/${method}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000),
      });
    } catch { throw new TelegramError(503); }
    let data;
    try { data = await response.json(); } catch { throw new TelegramError(502); }
    if (!response.ok || !data.ok) throw new TelegramError(data.error_code || response.status, data.parameters?.retry_after || 0);
    return data.result;
  }
  send(chatId, text, extra = {}) { return this.call('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', ...extra }); }
}
