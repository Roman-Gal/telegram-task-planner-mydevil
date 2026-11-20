import { parseWhen, formatWhen } from './time.js';
import { TelegramError } from './telegram.js';
import { Wizard } from './wizard.js';
import { escapeHtml, priorities, UserError } from './ui.js';
import { Access, activeMember } from './access.js';

export { escapeHtml } from './ui.js';
const mention = task => `<a href="tg://user?id=${task.assignee_id}">${escapeHtml(task.assignee_name)}</a>`;
const buttons = task => ({ inline_keyboard: [[
  { text: '✅ Виконано', callback_data: `done:${task.id}` },
  { text: '⏰ +15 хв', callback_data: `snooze:${task.id}` },
], [{ text: '✖️ Скасувати', callback_data: `cancel:${task.id}` }]] });

export class Planner {
  constructor(store, telegram, config, log = console) {
    this.store = store; this.telegram = telegram; this.config = config; this.log = log;
    this.username = ''; this.draining = false; this.reminding = false; this.stopping = false;
    this.wizard = new Wizard(this);
    this.access = new Access(store, telegram, config);
    this.adminSyncAt = new Map();
  }
  allowed(chatId) { return this.access.allowed(chatId); }
  observe(message) {
    if (!this.allowed(message.chat.id)) return;
    if (!message.sender_chat) this.store.remember(message.from, message.chat.id);
    if (!message.reply_to_message?.sender_chat) this.store.remember(message.reply_to_message?.from, message.chat.id);
    for (const user of message.new_chat_members || []) this.store.remember(user, message.chat.id);
    if (message.left_chat_member) this.store.forgetMember(message.chat.id, message.left_chat_member.id);
  }
  async syncAdministrators(chatId) {
    if (chatId > 0 || !this.allowed(chatId) || (this.adminSyncAt.get(chatId) || 0) > Date.now()-300_000) return;
    try {
      const admins = await this.telegram.call('getChatAdministrators', { chat_id: chatId });
      if (Array.isArray(admins)) {
        for (const member of admins) this.store.remember(member.user, chatId);
        this.adminSyncAt.set(chatId, Date.now());
      }
    } catch { /* Discovery is optional; known participants and reply assignment remain available. */ }
  }
  help() {
    return `📋 <b>Планнер завдань</b>\n\n` +
      `<b>Найзручніше: /menu → ➕ Нове завдання.</b>\nВиконавець → дата → час → опис → пріоритет → нагадування → підтвердження.\n\n` +
      `Або напишіть <code>/task @username</code> — решту оберете кнопками.\n\n` +
      `Учасники з’являються автоматично з доступних боту повідомлень, меню та подій входу. Для особистих нагадувань відкрийте бота та натисніть /start.\n\n` +
      `<b>Призначити завдання:</b>\n<code>/task @username | завтра 18:30 | Купити масло, хліб, воду</code>\n\n` +
      `Або відповіддю на повідомлення виконавця:\n<code>/task завтра 18:30 | Сходити в Бедронку</code>\n\n` +
      `Собі: <code>/task me | завтра 18:30 | Купити воду</code>\n` +
      `Дати: <code>YYYY-MM-DD HH:mm</code>, <code>сьогодні HH:mm</code>, <code>завтра HH:mm</code>.\n` +
      `Часовий пояс: <b>${escapeHtml(this.config.timezone)}</b>.\n\n` +
      `/menu — меню з кнопками\n/tasks — усі завдання чату\n/done ID — виконано\n/snooze ID — перенести строк на 15 хв\n/cancel ID — скасувати\n/stop — вимкнути особисті нагадування\n` +
      `Для наступної сторінки: <code>/tasks 2</code>.\n\n` +
      `Нагадування надходять у групу й особисто виконавцю. Після строку — ПРОТЕРМІНОВАНО кожні 15 хв до виконання або скасування.\n\n` +
      `Працюємо у групі або в обговоренні каналу. Анонімні повідомлення не підтримуються.`;
  }
  card(task, heading = '📋 Завдання') {
    const status = task.status === 'open' && task.due_at <= Date.now() ? '🔴 ПРОТЕРМІНОВАНО' : { open: 'відкрите', done: '✅ виконано', cancelled: 'скасовано' }[task.status];
    const reminders = JSON.parse(task.reminder_minutes || '[]');
    return `<b>${heading} #${task.id}</b>\n👤 ${mention(task)}\n📝 ${escapeHtml(task.description)}\n` +
      `⏰ ${escapeHtml(formatWhen(task.due_at, this.config.timezone))}\n${priorities[task.priority || 'medium']} пріоритет\n` +
      `🔔 Завчасно: ${reminders.length ? reminders.map(m => m === 60 ? '1 год' : m + ' хв').join(', ') : 'без нагадувань'}\nСтатус: ${status}`;
  }
  taskButtons(task) { return buttons(task); }
  menuButtons() {
    return { inline_keyboard: [
      [{ text: '➕ Нове завдання', callback_data: 'm:new' }],
      [{ text: '📋 Усі завдання', callback_data: 'm:tasks:0' }],
      [{ text: '❓ Довідка', callback_data: 'm:help' }],
      ...(this.username ? [[{ text: '🔔 Увімкнути приватні нагадування', url: `https://t.me/${this.username}?start=reminders` }]] : []),
    ] };
  }
  menu(chatId, threadId) {
    return this.telegram.send(chatId, '📋 <b>Планнер завдань</b>\n\nОберіть дію кнопкою. Меню можна закріпити в групі, щоб воно завжди було під рукою.\n\nУчасники додаються до списку виконавців автоматично.', {
      reply_markup: this.menuButtons(), ...(threadId ? { message_thread_id: threadId } : {}),
    });
  }
  async answer(id, text = '', alert = false) {
    try { await this.telegram.call('answerCallbackQuery', { callback_query_id: id, text, show_alert: alert }); } catch { /* callbacks expire independently of persisted work */ }
  }
  async taskChanged(task, chatId, threadId, heading) {
    const extra = task.status === 'open' ? { reply_markup: buttons(task) } : {};
    await this.telegram.send(chatId, this.card(task, heading), { ...extra, ...(threadId ? { message_thread_id: threadId } : {}) });
    if (task.chat_id < 0 && task.chat_id !== chatId) {
      await this.telegram.send(task.chat_id, this.card(task, heading), { ...extra, ...(task.thread_id ? { message_thread_id: task.thread_id } : {}) });
    }
  }
  async showTasks(chatId, userId, page, threadId) {
    if (!Number.isSafeInteger(page) || page < 0 || page > 9999) throw new UserError('Некоректний номер сторінки.');
    const tasks = this.store.visibleTasks(chatId, userId, page * 10);
    const status = t => t.status === 'done' ? '✅ Виконано' : t.status === 'cancelled' ? '✖️ Скасовано' : t.due_at <= Date.now() ? '🔴 ПРОТЕРМІНОВАНО' : '🕒 Відкрите';
    const lines = tasks.slice(0,10).map(t => `<b>#${t.id}</b> ${priorities[t.priority].split(' ')[0]} ${mention(t)} — ${escapeHtml(t.description.slice(0,100))}\n⏰ ${escapeHtml(formatWhen(t.due_at, this.config.timezone))}\n${status(t)}`);
    const rows = tasks.slice(0,10).map(t => [{ text: `Відкрити #${t.id} · ${t.description.slice(0,35)}`, callback_data: `view:${t.id}` }]);
    const nav = [];
    if (page > 0) nav.push({ text: '◀️', callback_data: `m:tasks:${page-1}` });
    if (tasks.length > 10) nav.push({ text: '▶️', callback_data: `m:tasks:${page+1}` });
    if (nav.length) rows.push(nav);
    rows.push([{ text: '➕ Нове завдання', callback_data: 'm:new' }, { text: '🏠 Меню', callback_data: 'm:home' }]);
    return this.telegram.send(chatId, `<b>📋 Усі завдання · сторінка ${page+1}</b>\n\n${lines.length ? lines.join('\n\n') : 'Завдань на цій сторінці немає.'}`, {
      reply_markup: { inline_keyboard: rows }, ...(threadId ? { message_thread_id: threadId } : {}),
    });
  }
  async handle(update) {
    if (update.my_chat_member) return this.access.membership(update.my_chat_member);
    if (update.chat_member) {
      const event = update.chat_member;
      if (event.chat && this.allowed(event.chat.id) && ['group','supergroup'].includes(event.chat.type)) {
        if (activeMember(event.new_chat_member)) this.store.remember(event.new_chat_member.user, event.chat.id);
        else if (event.new_chat_member?.user) this.store.forgetMember(event.chat.id, event.new_chat_member.user.id);
      }
      return;
    }
    if (update.callback_query) return this.callback(update);
    const message = update.message;
    if (!message?.chat || !['private','group','supergroup'].includes(message.chat.type)) return;
    if (message.text?.trim().match(new RegExp(`^/allow(?:@${this.username})?$`, 'i')) && !message.sender_chat && !message.from?.is_bot && this.access.authorize(message.chat.id, message.from?.id)) {
      this.observe(message);
      return this.telegram.send(message.chat.id, '✅ Цю групу дозволено власником бота.', { reply_markup: this.menuButtons(), ...(message.message_thread_id ? { message_thread_id: message.message_thread_id } : {}) });
    }
    this.observe(message);
    if (message.users_shared && message.from && !message.from.is_bot && !message.sender_chat) {
      try { return await this.wizard.picked(update, message); }
      catch (error) {
        if (!(error instanceof UserError)) throw error;
        return this.telegram.send(message.chat.id, `ℹ️ ${escapeHtml(error.message)}`, message.message_thread_id ? { message_thread_id: message.message_thread_id } : {});
      }
    }
    if (!message?.text || !message.from || message.from.is_bot || message.sender_chat ||
      !['private', 'group', 'supergroup'].includes(message.chat.type) || !this.allowed(message.chat.id)) return;
    const match = /^\/(\w+)(?:@([\w]+))?(?:\s+([\s\S]*))?$/.exec(message.text.trim());
    if (!match) {
      try { return await this.wizard.text(update, message); }
      catch (error) {
        if (!(error instanceof UserError)) throw error;
        return this.telegram.send(message.chat.id, `ℹ️ ${escapeHtml(error.message)}`, message.message_thread_id ? { message_thread_id: message.message_thread_id } : {});
      }
    }
    if (match[2] && match[2].toLowerCase() !== this.username.toLowerCase()) return;
    const command = match[1].toLowerCase();
    const args = match[3]?.trim() || '';
    this.store.remember(message.from, message.chat.id);
    const send = (text, extra = {}) => this.telegram.send(message.chat.id, text, {
      ...(message.message_thread_id ? { message_thread_id: message.message_thread_id } : {}), ...extra,
    });
    try {
      switch (command) {
        case 'start':
          this.store.remember(message.from, message.chat.id, message.chat.type === 'private');
          if (/^pick_[a-f0-9]{12}$/.test(args)) return await this.wizard.openPicker(args.slice(5), message);
          return this.menu(message.chat.id, message.message_thread_id);
        case 'menu': return this.menu(message.chat.id, message.message_thread_id);
        case 'help': return send(this.help());
        case 'id': return send(`Ваш Telegram user ID: <code>${message.from.id}</code>`);
        case 'stop':
          if (message.chat.type !== 'private') throw new UserError('Напишіть /stop в особистому чаті з ботом.');
          this.store.disablePrivate(message.from.id);
          return send('Особисті нагадування вимкнено. Групові залишаються активними. Увімкнути знову: /start.');
        case 'task': {
          if (!args) return this.wizard.start(update.update_id, message.from, message.chat.id, message.message_thread_id || 0,
            message.reply_to_message?.sender_chat ? null : message.reply_to_message?.from);
          const mentioned = (message.entities || []).some(entity => entity.type === 'text_mention' && message.text.slice(entity.offset,entity.offset+entity.length).trim() === args);
          if (!args.includes('|') && (/^@[a-zA-Z0-9_]{1,32}$/.test(args) || mentioned)) {
            const user = await this.resolveMention(message, args);
            return this.wizard.start(update.update_id, message.from, message.chat.id, message.message_thread_id || 0, user);
          }
          const task = await this.createTask(update, message, args);
          let text = this.card(task, '✅ Створено завдання');
          if (message.chat.id < 0 && !this.store.privateEnabled(task.assignee_id)) {
            text += '\n\nℹ️ Виконавець ще не ввімкнув особисті нагадування. Нагадування буде у групі.';
            if (this.username) text += ` <a href="https://t.me/${this.username}?start=reminders">Увімкнути в боті</a>.`;
          }
          return send(text, { reply_markup: buttons(task) });
        }
        case 'tasks':
        case 'mine': case 'created': {
          const page = args ? Number(args) : 1;
          if (!Number.isSafeInteger(page) || page < 1 || page > 10000) throw new UserError('Номер сторінки має бути від 1 до 10000.');
          return this.showTasks(message.chat.id, message.from.id, page-1, message.message_thread_id);
        }
        case 'done': case 'cancel': case 'snooze': {
          if (command === 'cancel' && !args) return await this.wizard.cancel(update.update_id, message.from.id, message.chat.id, message.message_thread_id || 0);
          const task = this.act(Number(args), command, update.update_id, message.from.id, message.chat.id);
          return this.taskChanged(task, message.chat.id, message.message_thread_id, command === 'snooze' ? '⏰ Відкладено на 15 хв' : '📋 Оновлено завдання');
        }
        default: return send('Невідома команда. /help — довідка.');
      }
    } catch (error) {
      if (error instanceof TelegramError) throw error;
      if (error instanceof UserError) return send(`ℹ️ ${escapeHtml(error.message)}`);
      throw error;
    }
  }
  async createTask(update, message, args) {
    const existing = this.store.taskByUpdate(update.update_id);
    if (existing) return existing;
    const fields = args.split('|').map(x => x.trim());
    let target, when, description;
    if (fields.length === 3) [target, when, description] = fields;
    else if (fields.length === 2 && message.reply_to_message) [when, description] = fields;
    else throw new UserError('Формат: /task @username | завтра 18:30 | Опис. Або відповіддю: /task завтра 18:30 | Опис.');
    if (!description || description.length > 1200) throw new UserError('Опис має містити від 1 до 1200 символів.');
    let assignee;
    if (['me', 'я'].includes(target?.toLowerCase())) assignee = message.from;
    else if (!target) {
      const reply = message.reply_to_message;
      if (reply.sender_chat) throw new UserError('Неможливо призначити завдання анонімному автору.');
      assignee = reply.from;
    } else {
      assignee = await this.resolveMention(message, target);
    }
    if (!assignee || assignee.is_bot) throw new UserError('Виконавцем має бути людина з видимим профілем.');
    if (message.chat.type === 'private' && assignee.id !== message.from.id) throw new UserError('У приватному чаті можна створювати завдання лише собі.');
    let dueAt;
    try { dueAt = parseWhen(when, this.config.timezone); } catch (error) { throw new UserError(error.message); }
    this.store.remember(assignee, message.chat.id);
    return this.store.createTask({ updateId: update.update_id, chatId: message.chat.id,
      threadId: message.message_thread_id, creatorId: message.from.id, assigneeId: assignee.id, description, dueAt });
  }
  async resolveMention(message, value = message.text.trim()) {
    const entities = (message.entities || []).filter(entity => entity.type === 'text_mention' && entity.user &&
      message.text.slice(entity.offset, entity.offset+entity.length).trim() === value);
    const username = /^@([a-zA-Z0-9_]{1,32})$/.exec(value)?.[1];
    let candidate;
    if (entities.length === 1) candidate = entities[0].user;
    else if (username) candidate = this.store.findMember(message.chat.id, username) || this.store.findUser(username);
    else throw new UserError('Введіть @ та оберіть одну людину зі списку Telegram. Або використайте /task відповіддю на її повідомлення.');
    if (!candidate) throw new UserError('Цього виконавця ще немає серед відомих учасників. Нехай він напише будь-яке повідомлення в цій групі або надішліть /task відповіддю на його повідомлення.');
    if (candidate.is_bot || !Number.isSafeInteger(candidate.id) || candidate.id <= 0) throw new UserError('Виконавцем має бути людина.');
    if (message.chat.type === 'private') {
      if (candidate.id !== message.from.id) throw new UserError('Завдання іншій людині створюйте у спільній групі.');
      return message.from;
    }
    let member;
    try { member = await this.telegram.call('getChatMember', { chat_id: message.chat.id, user_id: candidate.id }); }
    catch (error) {
      if (![400,403].includes(error.code)) throw error;
      throw new UserError('Не вдалося перевірити учасника. Дайте боту права адміністратора або використайте /task відповіддю на повідомлення.');
    }
    if (!activeMember(member) || !member.user || member.user.id !== candidate.id || member.user.is_bot ||
      (username && member.user.username?.toLowerCase() !== username.toLowerCase())) {
      throw new UserError('Виконавець змінив username або вийшов із групи. Виберіть його відповіддю на актуальне повідомлення.');
    }
    this.store.remember(member.user, message.chat.id);
    return member.user;
  }
  act(id, action, updateId, userId, chatId) {
    if (!Number.isSafeInteger(id) || id <= 0) throw new UserError('Вкажіть числовий ID завдання: /done 1.');
    const task = this.store.task(id);
    if (!task || !this.allowed(task.chat_id) || (chatId < 0 && task.chat_id !== chatId) ||
      (task.creator_id !== userId && task.assignee_id !== userId)) throw new UserError('Завдання не знайдено або у вас немає доступу.');
    const previous = this.store.previousAction(updateId);
    if (previous) return previous;
    if (task.status !== 'open') throw new UserError('Це завдання вже завершене або скасоване.');
    return this.store.changeTask(id, action, updateId);
  }
  async callback(update) {
    const q = update.callback_query;
    if (!q.from || q.from.is_bot || !q.message?.chat || !this.allowed(q.message.chat.id)) return;
    if (!['private','group','supergroup'].includes(q.message.chat.type || (q.message.chat.id > 0 ? 'private' : 'supergroup'))) return;
    try {
      this.store.remember(q.from, q.message.chat.id);
      if (await this.wizard.callback(update)) return;
      if (q.data?.startsWith('m:')) {
        const match = /^m:(new|home|mine|tasks|created|join|help)(?::(\d+))?(?::(\d+))?$/.exec(q.data);
        if (!match) return;
        const [, action, page = '0', owner] = match;
        if (owner && Number(owner) !== q.from.id) throw new UserError('Це список іншої людини. Відкрийте власний через меню.');
        this.store.remember(q.from, q.message.chat.id);
        await this.answer(q.id);
        switch (action) {
          case 'new': return this.wizard.start(update.update_id, q.from, q.message.chat.id, q.message.message_thread_id || 0);
          case 'home': return this.menu(q.message.chat.id, q.message.message_thread_id);
          case 'join': return this.menu(q.message.chat.id, q.message.message_thread_id); // Older pinned menus still open the updated menu.
          case 'help': return this.telegram.send(q.message.chat.id, this.help(), q.message.message_thread_id ? { message_thread_id: q.message.message_thread_id } : {});
          default: return this.showTasks(q.message.chat.id, q.from.id, Number(page), q.message.message_thread_id);
        }
      }
      const view = /^view:(\d+)$/.exec(q.data || '');
      if (view) {
        const task = this.store.task(Number(view[1]));
        if (!task || !this.allowed(task.chat_id) || (q.message.chat.id < 0 ? task.chat_id !== q.message.chat.id : task.creator_id !== q.from.id && task.assignee_id !== q.from.id)) throw new UserError('Завдання не знайдено або у вас немає доступу.');
        await this.answer(q.id);
        return this.telegram.send(q.message.chat.id, this.card(task), { ...(task.status === 'open' ? { reply_markup: buttons(task) } : {}), ...(q.message.message_thread_id ? { message_thread_id: q.message.message_thread_id } : {}) });
      }
    } catch (error) {
      if (!(error instanceof UserError)) throw error;
      return this.answer(q.id, error.message, true);
    }
    const match = /^(done|cancel|snooze):(\d+)$/.exec(q.data || '');
    if (!match) return;
    let task;
    try { task = this.act(Number(match[2]), match[1], update.update_id, q.from.id, q.message.chat.id); }
    catch (error) {
      if (!(error instanceof UserError)) throw error;
      try { await this.telegram.call('answerCallbackQuery', { callback_query_id: q.id, text: error.message, show_alert: true }); } catch { /* expired callback */ }
      return;
    }
    try { await this.telegram.call('answerCallbackQuery', { callback_query_id: q.id, text: 'Збережено ✅' }); } catch { /* expired callback */ }
    return this.taskChanged(task, q.message.chat.id, q.message.message_thread_id, match[1] === 'snooze' ? '⏰ Відкладено на 15 хв' : '📋 Оновлено завдання');
  }
  async drain() {
    if (this.draining || this.stopping) return;
    this.draining = true;
    try {
      for (let count = 0; count < 50 && !this.stopping; count++) {
        const row = this.store.nextUpdate();
        if (!row) break;
        try { await this.handle(JSON.parse(row.payload)); this.store.finishUpdate(row.id); }
        catch (error) {
          const code = error instanceof TelegramError ? error.code : 500;
          this.store.finishUpdate(row.id, code, error.retryAfter);
          this.log.warn(`Update ${row.id}: failure code ${code}; retry policy applied.`);
        }
      }
    } finally { this.draining = false; }
  }
  async remind(now = Date.now()) {
    if (this.reminding || this.stopping) return;
    this.reminding = true;
    try {
      this.store.prepareDeliveries(now);
      for (const delivery of this.store.pendingDeliveries(now)) {
        if (this.stopping) break;
        const task = this.store.task(delivery.task_id);
        if (!task || task.status !== 'open' || task.generation !== delivery.generation || !this.allowed(task.chat_id)) continue;
        if (delivery.destination === 'private' && !this.store.privateEnabled(task.assignee_id)) {
          this.store.deliveryResult(delivery, 403); continue;
        }
        try {
          const heading = delivery.kind === 'overdue' ? '🔴 ПРОТЕРМІНОВАНО' : `🔔 До строку: ${Math.round((task.due_at-delivery.event_at)/60_000)} хв`;
          await this.telegram.send(delivery.chat_id, this.card(task, heading), {
            ...(delivery.thread_id ? { message_thread_id: delivery.thread_id } : {}), reply_markup: buttons(task),
          });
          this.store.deliveryResult(delivery, null, 0, now);
        } catch (error) {
          const code = error instanceof TelegramError ? error.code : 500;
          this.store.deliveryResult(delivery, code, error.retryAfter, now);
          if (delivery.destination === 'private' && code === 403) this.store.disablePrivate(task.assignee_id);
          this.log.warn(`Reminder ${task.id}/${delivery.destination}: failure code ${code}; retry policy applied.`);
        }
      }
    } finally { this.reminding = false; }
  }
}
