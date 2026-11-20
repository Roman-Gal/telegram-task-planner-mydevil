import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { Planner } from '../src/planner.js';
import { TelegramError } from '../src/telegram.js';

const author = { id: 11, first_name: 'Автор', username: 'author', is_bot: false };
const assignee = { id: 22, first_name: 'Виконавець', username: 'buyer', is_bot: false };
const stranger = { id: 33, first_name: 'Інший', is_bot: false };
const config = { timezone: 'Europe/Warsaw', allowedChatIds: new Set() };
const quiet = { warn() {}, error() {} };
function setup(t, path = ':memory:') {
  const store = new Store(path);
  t.after(() => store.close());
  const sent = [];
  const telegram = {
    send: async (chatId, text, extra) => { sent.push({ chatId, text, extra }); return { message_id: sent.length }; },
    call: async method => method === 'getChatMember' ? { status: 'member', user: assignee } : true,
  };
  const planner = new Planner(store, telegram, config, quiet);
  planner.username = 'planner_bot';
  return { store, sent, telegram, planner };
}
function message(id, text, from = author, chatId = -100, extra = {}) {
  return { update_id: id, message: { message_id: id, text, from, chat: { id: chatId, type: chatId > 0 ? 'private' : 'supergroup' }, ...extra } };
}
async function create(planner, id = 1, chatId = -100, extra = {}) {
  await planner.handle(message(id, '/task 2099-12-01 18:30 | Купити <масло> & хліб', author, chatId,
    { reply_to_message: { from: assignee }, ...extra }));
}

test('reply assignment escapes HTML and duplicate updates create one task', async t => {
  const { planner, store, sent } = setup(t);
  await create(planner); await create(planner);
  assert.equal(store.list({ chatId: -100 }).length, 1);
  assert.equal(store.task(1).assignee_id, assignee.id);
  assert.match(sent[0].text, /&lt;масло&gt; &amp; хліб/);
  assert.equal(sent[0].extra.reply_markup.inline_keyboard[0][0].callback_data, 'done:1');
});
test('username assignment requires a known member and verifies the current username', async t => {
  const { planner, store, sent, telegram } = setup(t);
  await planner.handle(message(1, '/task @buyer | завтра 18:30 | Купити воду'));
  assert.match(sent.at(-1).text, /відомих учасників/);
  await planner.handle(message(2, 'Звичайне повідомлення', assignee));
  await planner.handle(message(3, '/task @buyer | завтра 18:30 | Купити воду'));
  assert.equal(store.task(1).assignee_id, assignee.id);
  telegram.call = async () => ({ status: 'member', user: { ...assignee, username: 'changed' } });
  await planner.handle(message(4, '/task @buyer | завтра 18:30 | Ще вода'));
  assert.match(sent.at(-1).text, /змінив username/);
  assert.equal(store.list({ chatId: -100 }).length, 1);
});
test('only creator and assignee may change tasks, within their original group', async t => {
  const { planner, store, sent } = setup(t);
  await create(planner);
  await planner.handle(message(2, '/done 1', stranger));
  assert.match(sent.at(-1).text, /немає доступу/);
  await planner.handle(message(3, '/done 1', author, -200));
  assert.equal(store.task(1).status, 'open');
  await planner.handle(message(4, '/done 1', assignee));
  assert.equal(store.task(1).status, 'done');
});
test('a reassigned username resolves to the newly registered owner', t => {
  const { store } = setup(t);
  store.remember(assignee, -100);
  store.remember({ ...stranger, username: assignee.username }, -100);
  assert.equal(store.findMember(-100, assignee.username).id, stranger.id);
});
test('private tasks cannot assign another user through a reply', async t => {
  const { planner, store, sent } = setup(t);
  await create(planner, 1, author.id);
  assert.equal(store.task(1), undefined);
  assert.match(sent.at(-1).text, /лише собі/);
  await planner.handle(message(2, '/task me | завтра 18:30 | Вода', author, author.id));
  assert.equal(store.task(1).assignee_id, author.id);
});
test('group task list stays in its group; private task list includes only related tasks', async t => {
  const { planner, sent } = setup(t);
  await create(planner, 1, -100);
  await planner.handle(message(2, '/task me | завтра 18:30 | Секретна задача', assignee, -200));
  await planner.handle(message(3, '/tasks', assignee, -100));
  assert.doesNotMatch(sent.at(-1).text, /Секретна/);
  await planner.handle(message(4, '/tasks', assignee, assignee.id));
  assert.match(sent.at(-1).text, /Секретна/);
});
test('bot mentions, anonymous authors, channels, and disallowed groups are ignored', async t => {
  const { planner, sent } = setup(t);
  await planner.handle(message(1, '/help@other_bot'));
  await planner.handle(message(2, '/help', author, -100, { sender_chat: { id: -100 } }));
  await planner.handle({ update_id: 3, channel_post: { text: '/help' } });
  const restricted = new Planner(planner.store, planner.telegram, { ...config, allowedChatIds: new Set([-200]) }, quiet);
  await restricted.handle(message(4, '/help'));
  assert.equal(sent.length, 0);
});
test('due reminders go to group and opted-in user, once each, retaining the forum topic', async t => {
  const { planner, store, sent } = setup(t);
  await create(planner, 1, -100, { message_thread_id: 55 });
  await planner.handle(message(2, '/start', assignee, assignee.id));
  const due = store.task(1).due_at;
  sent.length = 0;
  await planner.remind(due - 1);
  assert.equal(sent.length, 0);
  await planner.remind(due);
  assert.deepEqual(sent.map(x => x.chatId), [-100, assignee.id]);
  assert.equal(sent[0].extra.message_thread_id, 55);
  await planner.remind(due + 1000);
  assert.equal(sent.length, 2);
});
test('failed private delivery does not repeat successful group reminder', async t => {
  const { planner, store, telegram, sent } = setup(t);
  await create(planner);
  store.remember(assignee, assignee.id, true);
  const originalSend = telegram.send;
  let fails = true;
  telegram.send = async (chatId, ...rest) => {
    if (chatId === assignee.id && fails) throw new TelegramError(503);
    return originalSend(chatId, ...rest);
  };
  const due = store.task(1).due_at;
  sent.length = 0;
  await planner.remind(due);
  assert.equal(sent.length, 1);
  fails = false;
  await planner.remind(due + 100_000);
  assert.deepEqual(sent.map(x => x.chatId), [-100, assignee.id]);
});
test('403 disables private reminders; /start enables them again', async t => {
  const { planner, store, telegram } = setup(t);
  await create(planner);
  store.remember(assignee, assignee.id, true);
  const send = telegram.send;
  telegram.send = async (chatId, ...args) => {
    if (chatId > 0) throw new TelegramError(403);
    return send(chatId, ...args);
  };
  await planner.remind(store.task(1).due_at);
  assert.equal(store.privateEnabled(assignee.id), false);
  telegram.send = send;
  await planner.handle(message(3, '/start', assignee, assignee.id));
  assert.equal(store.privateEnabled(assignee.id), true);
});
test('completion suppresses reminders; snooze is idempotent and creates a new reminder generation', async t => {
  const { planner, store, sent } = setup(t);
  await create(planner);
  const first = planner.act(1, 'snooze', 2, assignee.id, -100);
  const second = planner.act(1, 'snooze', 2, assignee.id, -100);
  assert.equal(first.due_at, second.due_at);
  assert.equal(store.task(1).generation, 1);
  await planner.remind(first.due_at);
  assert.equal(store.pendingDeliveries(first.due_at).length, 0);
  planner.act(1, 'done', 3, author.id, -100);
  sent.length = 0;
  await planner.remind(first.due_at + 100_000);
  assert.equal(sent.length, 0);
});
test('callbacks enforce identity and permit the assignee to mark a task done privately', async t => {
  const { planner, store, sent } = setup(t);
  await create(planner);
  const callback = (id, from) => ({ update_id: id, callback_query: { id: `q${id}`, from, data: 'done:1', message: { chat: { id: from.id } } } });
  await planner.handle(callback(2, stranger));
  assert.equal(store.task(1).status, 'open');
  await planner.handle(callback(3, assignee));
  assert.equal(store.task(1).status, 'done');
  assert.deepEqual(sent.slice(-2).map(m=>m.chatId),[assignee.id,-100]);
  assert.match(sent.at(-1).text,/виконано/);
});
test('SQLite recovers pending webhook and overdue reminder after reopening', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'planner-'));
  const path = join(directory, 'planner.sqlite');
  const first = new Store(path);
  first.remember(author, -100); first.remember(assignee, -100);
  first.createTask({ updateId: 1, chatId: -100, creatorId: author.id, assigneeId: assignee.id, description: 'Persistent', dueAt: 1 });
  first.enqueue(message(2, '/help'));
  first.close();
  const { planner, store, sent } = setup(t, path);
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  await planner.drain();
  await planner.remind();
  assert.equal(store.nextUpdate(), undefined);
  assert.equal(sent.length, 2);
  await planner.remind();
  assert.equal(sent.length, 2);
});
test('webhook retries do not duplicate tasks when initial confirmation fails', async t => {
  const { planner, store, telegram } = setup(t);
  const update = message(10, '/task me | завтра 18:30 | One task');
  store.enqueue(update);
  const original = telegram.send;
  telegram.send = async () => { throw new TelegramError(503); };
  await planner.drain();
  assert.equal(store.list({ chatId: -100 }).length, 1);
  telegram.send = original;
  store.db.prepare('UPDATE updates SET next_attempt_at=0').run();
  await planner.drain();
  assert.equal(store.list({ chatId: -100 }).length, 1);
  assert.equal(store.nextUpdate(), undefined);
});
