import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { Planner } from '../src/planner.js';
import { TelegramError } from '../src/telegram.js';

const MINUTE = 60000;
function setup(t) {
  const store = new Store(':memory:'); t.after(()=>store.close());
  store.remember({id:1,first_name:'Автор'},-100);
  store.remember({id:2,first_name:'Виконавець'},-100,true);
  const sent=[]; const telegram={send:async (chatId,text)=>{sent.push({chatId,text});return {};}};
  const planner=new Planner(store,telegram,{timezone:'Europe/Warsaw',allowedChatIds:new Set()},{warn(){}});
  const created=Date.now(); const due=created+120*MINUTE;
  const task=store.createTask({updateId:1,chatId:-100,creatorId:1,assigneeId:2,description:'Тест',dueAt:due,priority:'high',reminderMinutes:[5,15,30,60]},created);
  return {store,planner,telegram,sent,created,due,task};
}
test('all selected advance reminders and every overdue interval reach group and private chat',async t=>{
  const s=setup(t);
  for(const offset of [60,30,15,5,0,-15,-30]) {
    const before=s.sent.length; const now=s.due-offset*MINUTE;
    await s.planner.remind(now); await s.planner.remind(now+1);
    assert.equal(s.sent.length,before+2,`offset ${offset}`);
    assert.deepEqual(s.sent.slice(-2).map(x=>x.chatId),[-100,2]);
    assert.match(s.sent.at(-1).text,offset>0?new RegExp(`До строку: ${offset} хв`):/ПРОТЕРМІНОВАНО/);
  }
});
test('overdue repetition has no total limit, and either creator or assignee can stop it',async t=>{
  for(const userId of [1,2]) {
    const s=setup(t);
    for(let slot=0;slot<110;slot++) await s.planner.remind(s.due+slot*15*MINUTE);
    assert.equal(s.sent.length,220);
    s.planner.act(s.task.id,'done',500,userId,-100);
    await s.planner.remind(s.due+200*15*MINUTE);
    assert.equal(s.sent.length,220);
  }
});
test('downtime sends one current overdue notification and resumes fifteen minutes later',async t=>{
  const s=setup(t); await s.planner.remind(s.due);
  const resumed=s.due+8*60*MINUTE;
  await s.planner.remind(resumed);
  assert.equal(s.sent.length,4);
  await s.planner.remind(resumed+15*MINUTE-1); assert.equal(s.sent.length,4);
  await s.planner.remind(resumed+15*MINUTE); assert.equal(s.sent.length,6);
});
test('missed advance alerts collapse to the latest, and completed tasks suppress all future alerts',async t=>{
  const s=setup(t); await s.planner.remind(s.due-14*MINUTE);
  assert.equal(s.sent.length,2); assert.match(s.sent[0].text,/До строку: 15 хв/);
  s.planner.act(1,'done',3,2,-100);
  await s.planner.remind(s.due-5*MINUTE); await s.planner.remind(s.due+30*MINUTE);
  assert.equal(s.sent.length,2);
});
test('advance reminders whose time preceded creation are skipped',async t=>{
  const s=setup(t);
  s.store.db.prepare('UPDATE tasks SET created_at=?,updated_at=? WHERE id=1').run(s.due-10*MINUTE,s.due-10*MINUTE);
  await s.planner.remind(s.due-9*MINUTE); assert.equal(s.sent.length,0);
  await s.planner.remind(s.due-5*MINUTE); assert.equal(s.sent.length,2);
});
test('429 retry_after is respected independently per destination',async t=>{
  const s=setup(t); const send=s.telegram.send; let failures=1;
  s.telegram.send=async(chatId,text)=>{if(chatId===2&&failures-- >0)throw new TelegramError(429,120);return send(chatId,text);};
  const now=s.due-30*MINUTE;
  await s.planner.remind(now); assert.equal(s.sent.length,1);
  await s.planner.remind(now+119999); assert.equal(s.sent.length,1);
  await s.planner.remind(now+120000); assert.deepEqual(s.sent.map(x=>x.chatId),[-100,2]);
});
test('cancelling and snoozing invalidate outstanding reminders from the old schedule',async t=>{
  const s=setup(t); s.store.prepareDeliveries(s.due-60*MINUTE);
  s.store.changeTask(1,'snooze',10,s.due-60*MINUTE);
  assert.equal(s.store.pendingDeliveries(s.due).length,0);
  s.store.changeTask(1,'cancel',11,s.due);
  await s.planner.remind(s.due+100*MINUTE); assert.equal(s.sent.length,0);
});
test('migration preserves legacy tasks, delivery records, identities, and update deduplication',{skip: Boolean(process.env.PLANNER_TEST_DATABASE_URL)},t=>{
  const directory=mkdtempSync(join(tmpdir(),'planner-migrate-')); const path=join(directory,'old.sqlite');
  const old=new DatabaseSync(path);
  old.exec(`CREATE TABLE users(id INTEGER PRIMARY KEY,username TEXT,name TEXT NOT NULL,private_enabled INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE tasks(id INTEGER PRIMARY KEY,source_update_id INTEGER UNIQUE NOT NULL,chat_id INTEGER NOT NULL,thread_id INTEGER,creator_id INTEGER NOT NULL,assignee_id INTEGER NOT NULL,description TEXT NOT NULL,due_at INTEGER NOT NULL,status TEXT NOT NULL DEFAULT 'open',generation INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
    CREATE TABLE deliveries(task_id INTEGER NOT NULL,generation INTEGER NOT NULL,destination TEXT NOT NULL,chat_id INTEGER NOT NULL,thread_id INTEGER,state TEXT NOT NULL DEFAULT 'pending',attempts INTEGER NOT NULL DEFAULT 0,next_attempt_at INTEGER NOT NULL,last_code INTEGER,PRIMARY KEY(task_id,generation,destination));
    INSERT INTO users VALUES(1,'author','Автор',1);
    INSERT INTO tasks VALUES(1,100,-100,NULL,1,1,'Зберегти дані',1000,'open',0,1,1);
    INSERT INTO deliveries VALUES(1,0,'chat',-100,NULL,'sent',1,2000,NULL);`);
  old.close();
  let store=new Store(path); t.after(()=>{store.close();rmSync(directory,{recursive:true,force:true});});
  assert.equal(store.task(1).description,'Зберегти дані'); assert.equal(store.task(1).priority,'medium');
  assert.equal(store.db.prepare('SELECT state FROM deliveries').get().state,'sent');
  assert.ok(store.task(1).next_overdue_at>Date.now());
  assert.equal(store.createTask({updateId:100}).id,1);
  store.close(); store=new Store(path);
  assert.equal(store.task(1).description,'Зберегти дані');
});
