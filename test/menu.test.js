import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { Planner } from '../src/planner.js';
import { TelegramError } from '../src/telegram.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const author = { id: 11, first_name: 'Автор', username: 'author' };
const buyer = { id: 22, first_name: 'Олена', username: 'buyer' };
const chat = { id: -100, type: 'supergroup' };
function setup(t) {
  const store = new Store(':memory:'); t.after(() => store.close());
  store.remember(author, chat.id); store.remember(buyer, chat.id);
  let id = 100; let updateId = 1;
  const messages = new Map(); const sent = []; const answers = [];
  const telegram = {
    async send(chatId, text, extra = {}) { const message_id = ++id; const m = { message_id, chatId, text, ...extra }; messages.set(message_id, m); sent.push(m); return { message_id }; },
    async call(method, body) {
      if (method === 'editMessageText') { messages.set(body.message_id, { ...messages.get(body.message_id), ...body }); return true; }
      if (method === 'editMessageReplyMarkup') { messages.set(body.message_id, { ...messages.get(body.message_id), reply_markup: body.reply_markup }); return true; }
      if (method === 'answerCallbackQuery') answers.push(body);
      return true;
    },
  };
  const planner = new Planner(store, telegram, { timezone: 'Europe/Warsaw', allowedChatIds: new Set() }, { warn() {} });
  planner.username = 'planner_bot';
  const active = (user = author, thread = 55) => store.activeDraft(chat.id, user.id, thread);
  const callback = async (data, user = author, chosenUpdateId, thread = 55) => {
    const update_id = chosenUpdateId ?? updateId++;
    await planner.handle({ update_id, callback_query: { id: `q${update_id}`, from: user, data,
      message: { chat, message_id: 99, message_thread_id: thread } } });
    return update_id;
  };
  const command = async (text, user = author, thread = 55) => planner.handle({ update_id: updateId++, message: { chat, from: user, message_id: ++id, text, message_thread_id: thread } });
  const press = async (label, user = author) => {
    const draft = active(user);
    const panel = messages.get(draft.panelId);
    const button = panel.reply_markup.inline_keyboard.flat().find(b => typeof label === 'string' ? b.text === label : label.test(b.text));
    assert.ok(button, `Button ${label} in stage ${draft.stage}`);
    return callback(button.callback_data, user);
  };
  const reply = async (text, user = author, promptId = active(user).promptId) => planner.handle({ update_id: updateId++, message: { chat, from: user, message_id: ++id, text, message_thread_id: 55, reply_to_message: { message_id: promptId } } });
  const start = async (user = author) => { await callback('m:new', user); return active(user); };
  const toDescription = async (user = author) => {
    await start(user); await press(user.id === author.id ? /Олена/ : /Собі/, user);
    await press('Завтра', user); await press('18:··', user); await press('18:30', user);
  };
  return { store, planner, telegram, messages, sent, answers, active, callback, command, press, reply, start, toDescription };
}

test('menu offers actions and opens a wizard without a typed task command', async t => {
  const s = setup(t); await s.command('/menu');
  assert.ok(s.sent.at(-1).reply_markup.inline_keyboard.flat().find(b => b.text === '➕ Нове завдання'));
  await s.start();
  assert.equal(s.active().stage, 'assignee');
  assert.ok(s.messages.get(s.active().panelId).text.includes('Хто виконавець'));
});
test('full group wizard persists assignee, exact time, priority, multiple reminders, and a single confirmed task', async t => {
  const s = setup(t); await s.toDescription();
  const prompt = s.messages.get(s.active().promptId);
  assert.equal(prompt.reply_markup.force_reply, true); assert.equal(prompt.message_thread_id, 55);
  await s.reply('Купити <масло> & воду'); await s.press('🔴 Високий');
  await s.press('⬜ 5 хв'); await s.press('⬜ 1 година');
  assert.deepEqual(s.active().reminderMinutes, [5,15,60]);
  await s.press('Далі ➡️');
  assert.match(s.messages.get(s.active().panelId).text, /&lt;масло&gt;/);
  const button = s.messages.get(s.active().panelId).reply_markup.inline_keyboard.flat().find(b => b.text === '✅ Створити');
  const updateId = await s.callback(button.callback_data);
  await s.callback(button.callback_data, author, updateId);
  await s.callback(button.callback_data);
  const tasks = s.store.list({ chatId: chat.id });
  assert.equal(tasks.length, 1); assert.equal(tasks[0].assignee_id, buyer.id);
  assert.equal(tasks[0].priority, 'high'); assert.deepEqual(JSON.parse(tasks[0].reminder_minutes), [5,15,60]);
  assert.equal(tasks[0].thread_id, 55); assert.equal(s.active().stage, 'created');
});
test('a retried checkbox callback cannot toggle a reminder twice', async t => {
  const s = setup(t); await s.toDescription(); await s.reply('Вода'); await s.press('🟢 Низький');
  const data = s.messages.get(s.active().panelId).reply_markup.inline_keyboard.flat().find(b => b.text === '⬜ 30 хв').callback_data;
  const updateId = await s.callback(data); await s.callback(data, author, updateId);
  assert.deepEqual(s.active().reminderMinutes, [15,30]);
});
test('concurrent drafts, foreign clicks, stale buttons, replies, and topics stay isolated', async t => {
  const s = setup(t); const first = await s.start(); await s.start(buyer);
  assert.notEqual(s.active().id, s.active(buyer).id);
  const firstButton = s.messages.get(first.panelId || s.active().panelId).reply_markup.inline_keyboard.flat().find(b => /Олена/.test(b.text));
  await s.callback(firstButton.callback_data, buyer);
  assert.equal(s.active().stage, 'assignee'); assert.equal(s.answers.at(-1).show_alert, true);
  await s.callback(firstButton.callback_data, author, undefined, 99);
  assert.equal(s.active().stage, 'assignee');
  await s.callback(firstButton.callback_data);
  assert.equal(s.active().stage, 'date');
  await s.callback(firstButton.callback_data);
  assert.equal(s.active().stage, 'date');
  await s.press('Завтра'); await s.press('18:··'); await s.press('18:30');
  await s.reply('Чужий опис', buyer, s.active().promptId);
  assert.equal(s.active().stage, 'description');
  await s.reply('Не відповідь на потрібний запит', author, 999999);
  assert.equal(s.active().stage, 'description');
  await s.reply('Правильний опис'); assert.equal(s.active().description, 'Правильний опис');
});
test('member search handles Ukrainian case and selecting users without usernames', async t => {
  const s = setup(t); s.store.remember({ id: 33, first_name: 'Ірина' }, chat.id);
  await s.start(); await s.press('🔎 Пошук серед відомих'); await s.reply('іРИНа');
  const panel = s.messages.get(s.active().panelId);
  assert.ok(panel.reply_markup.inline_keyboard.flat().some(b => b.text.includes('Ірина')));
  await s.press(/Ірина/); assert.equal(s.active().assigneeId, 33);
});
test('custom time accepts arbitrary minutes and invalid time keeps the prompt usable', async t => {
  const s = setup(t); await s.start(); await s.press(/Олена/); await s.press('Завтра'); await s.press('⌨️ Ввести час HH:mm');
  await s.reply('25:99'); assert.equal(s.active().stage, 'timeText');
  await s.reply('18:37'); assert.equal(s.active().stage, 'description');
  assert.match(new Intl.DateTimeFormat('en-GB', { timeZone:'Europe/Warsaw', hour:'2-digit', minute:'2-digit' }).format(s.active().dueAt), /18:37/);
});
test('draft cancellation creates no task and old buttons cannot revive it', async t => {
  const s = setup(t); await s.start(); const before = s.active();
  const old = s.messages.get(before.panelId).reply_markup.inline_keyboard.flat()[0].callback_data;
  await s.command('/cancel'); assert.equal(s.active().stage, 'cancelled');
  await s.callback(old); assert.equal(s.store.list({ chatId:chat.id }).length, 0);
  await s.command('/cancel'); assert.match(s.sent.at(-1).text, /чернетки немає/);
});
test('failed prompt delivery can resume from its saved wizard transition', async t => {
  const s = setup(t); await s.start(); await s.press(/Олена/); await s.press('Завтра'); await s.press('18:··');
  const data = s.messages.get(s.active().panelId).reply_markup.inline_keyboard.flat().find(b=>b.text==='18:30').callback_data;
  const send = s.telegram.send; s.telegram.send = async () => { throw new TelegramError(503); };
  await assert.rejects(s.callback(data, author, 700));
  assert.equal(s.active().stage, 'description'); assert.equal(s.active().promptId, undefined);
  s.telegram.send = send; await s.callback(data, author, 700);
  assert.ok(s.active().promptId);
});
test('the unified list includes all statuses in this group without leaking another group', async t => {
  const s = setup(t);
  s.store.createTask({ updateId:1000,chatId:chat.id,creatorId:author.id,assigneeId:buyer.id,description:'Authored',dueAt:Date.now()+100000 });
  s.store.createTask({ updateId:1001,chatId:-200,creatorId:author.id,assigneeId:buyer.id,description:'Other group secret',dueAt:Date.now()+100000 });
  s.store.createTask({ updateId:1002,chatId:chat.id,creatorId:buyer.id,assigneeId:author.id,description:'Completed item',dueAt:Date.now()+100000 });
  s.store.changeTask(3,'done',1003);
  await s.callback('m:tasks:0');
  assert.match(s.sent.at(-1).text, /Authored/); assert.doesNotMatch(s.sent.at(-1).text, /secret/);
  assert.match(s.sent.at(-1).text,/Completed item/); assert.match(s.sent.at(-1).text,/✅ Виконано/);
  const buttons=s.planner.menuButtons().inline_keyboard.flat();
  assert.ok(buttons.some(b=>b.text==='📋 Усі завдання'));
  assert.ok(!buttons.some(b=>/Мої завдання|Створені мною/.test(b.text)));
});
test('draft prompt, ownership, and expiry survive reopening the database', t => {
  const directory=mkdtempSync(join(tmpdir(),'planner-draft-')); const path=join(directory,'planner.sqlite');
  let store=new Store(path); t.after(()=>{store.close();rmSync(directory,{recursive:true,force:true});});
  store.remember(author, chat.id);
  let d=store.beginDraft(1,author,chat.id,55);
  d=store.transitionDraft(d.id,d.revision,2,draft=>{draft.stage='description';});
  assert.equal(store.replyDraft(chat.id,author.id,55,undefined),undefined);
  store.setDraftPrompt(d.id,d.revision,999);
  store.close(); store=new Store(path);
  assert.equal(store.replyDraft(chat.id,author.id,55,999).id,d.id);
  assert.equal(store.replyDraft(chat.id,buyer.id,55,999),undefined);
  assert.equal(store.draft(d.id,d.expiresAt+1),undefined);
});
test('search replaces old participant buttons with working back/cancel controls', async t => {
  const s=setup(t); await s.start();
  const old=s.messages.get(s.active().panelId).reply_markup.inline_keyboard.flat().find(b=>b.text==='Відомі учасники').callback_data;
  await s.press('🔎 Пошук серед відомих');
  const revision=s.active().revision;
  assert.equal(s.active().stage,'search');
  const controls=s.messages.get(s.active().panelId).reply_markup.inline_keyboard.flat();
  assert.deepEqual(controls.map(b=>b.text),['⬅️ Назад','✖️ Скасувати']);
  assert.ok(controls.every(b=>b.callback_data.includes(`:${revision}:`)));
  await s.callback(old);
  assert.equal(s.active().stage,'search');assert.equal(s.active().revision,revision);
  assert.equal(s.answers.at(-1).show_alert,false);
  assert.match(s.answers.at(-1).text,/актуальний крок/);
  await s.press('⬅️ Назад');assert.equal(s.active().stage,'assignee');
});
test('text replies remove superseded panel buttons and stale clicks cannot overwrite the answer',async t=>{
  const s=setup(t);await s.toDescription();
  const oldPanel=s.active().panelId;
  const old=s.messages.get(oldPanel).reply_markup.inline_keyboard.flat()[0].callback_data;
  await s.reply('Поточний опис');
  assert.equal(s.active().stage,'priority');
  assert.deepEqual(s.messages.get(oldPanel).reply_markup.inline_keyboard,[]);
  await s.callback(old);
  assert.equal(s.active().stage,'priority');assert.equal(s.active().description,'Поточний опис');
  assert.equal(s.answers.at(-1).show_alert,false);
});
