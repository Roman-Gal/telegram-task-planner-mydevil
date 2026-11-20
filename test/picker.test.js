import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { Planner } from '../src/planner.js';
import { TelegramError } from '../src/telegram.js';

const author={id:11,first_name:'Автор'};
const target={id:22,first_name:'Олена',username:'buyer',is_bot:false};
const other={id:33,first_name:'Інший'};
const chat={id:-100,type:'supergroup'};
function setup(t) {
  const store=new Store(':memory:');t.after(()=>store.close());
  const sent=[];const calls=[];const panels=new Map();let messageId=100;let updateId=1;
  let member={status:'member',user:target};
  const telegram={
    async send(chatId,text,extra={}) { const message_id=++messageId;const message={chatId,text,...extra,message_id};sent.push(message);panels.set(message_id,message);return {message_id}; },
    async call(method,body) {
      calls.push({method,body});
      if(method==='getChatAdministrators')return [];
      if(method==='getChatMember') { if(member instanceof Error)throw member;return member; }
      if(method==='editMessageText')panels.set(body.message_id,{...panels.get(body.message_id),...body});
      return true;
    },
  };
  const planner=new Planner(store,telegram,{timezone:'Europe/Warsaw',allowedChatIds:new Set()},{warn(){}});planner.username='planner_bot';
  const start=async(user=author)=>{
    await planner.handle({update_id:updateId++,message:{chat,from:user,text:'/task',message_id:++messageId,message_thread_id:55}});
    return store.activeDraft(chat.id,user.id,55);
  };
  const open=async(draft,user=author)=>planner.handle({update_id:updateId++,message:{chat:{id:user.id,type:'private'},from:user,text:`/start pick_${draft.id}`,message_id:++messageId}});
  const requestId=()=>sent.filter(m=>m.reply_markup?.keyboard).at(-1).reply_markup.keyboard[0][0].request_users.request_id;
  const pick=async(request,user=author,selected=target.id,id)=>{
    const update_id=id??updateId++;
    await planner.handle({update_id,message:{chat:{id:user.id,type:'private'},from:user,message_id:++messageId,
      users_shared:{request_id:request,users:[{user_id:selected,first_name:'Untrusted display name'}]}}});
    return update_id;
  };
  return {store,planner,telegram,sent,calls,panels,start,open,pick,requestId,setMember:value=>{member=value;}};
}
test('unknown participant can be selected with Telegram native picker and group calendar resumes in its topic',async t=>{
  const s=setup(t);const draft=await s.start();
  assert.equal(s.store.member(chat.id,target.id),undefined);
  const buttons=s.panels.get(draft.panelId).reply_markup.inline_keyboard.flat();
  assert.ok(buttons.some(b=>b.text==='👤 Вказати через @'));
  assert.ok(!buttons.some(b=>b.url));
  await s.open(draft);
  const keyboard=s.sent.at(-1);
  assert.equal(keyboard.chatId,author.id);
  const options=keyboard.reply_markup.keyboard[0][0].request_users;
  assert.equal(options.max_quantity,1);assert.equal(options.user_is_bot,false);assert.equal(options.request_name,true);
  await s.pick(options.request_id);
  const current=s.store.draft(draft.id);
  assert.equal(current.stage,'date');assert.equal(current.assigneeId,target.id);assert.equal(current.assigneeName,'Олена');
  assert.equal(s.store.member(chat.id,target.id).username,'buyer');
  assert.match(s.panels.get(current.panelId).text,/Оберіть дату/);
  assert.equal(s.sent.at(-1).chatId,author.id);assert.equal(s.sent.at(-1).reply_markup.remove_keyboard,true);
  assert.ok(s.calls.some(c=>c.method==='getChatMember'&&c.body.chat_id===chat.id&&c.body.user_id===target.id));
  assert.equal(current.threadId,55);
});
test('deep link and selected-user request are bound to their creator, not whoever has the link',async t=>{
  const s=setup(t);const draft=await s.start();
  await s.open(draft,other);assert.match(s.sent.at(-1).text,/недоступний/);
  await s.open(draft);const request=s.requestId();
  await s.pick(request,other);assert.match(s.sent.at(-1).text,/іншій людині/);
  assert.equal(s.store.draft(draft.id).stage,'assignee');assert.equal(s.store.member(chat.id,target.id),undefined);
});
test('a non-member or bot cannot become the assignee through the picker',async t=>{
  const s=setup(t);const draft=await s.start();await s.open(draft);const request=s.requestId();
  for(const member of [{status:'left',user:target},{status:'restricted',is_member:false,user:target},{status:'member',user:{...target,is_bot:true}}]) {
    s.setMember(member);await s.pick(request);assert.equal(s.store.draft(draft.id).stage,'assignee');
    assert.match(s.sent.at(-1).text,/учасником цієї групи/);
  }
});
test('missing membership permissions give an actionable message and leave the selection retryable',async t=>{
  const s=setup(t);const draft=await s.start();await s.open(draft);const request=s.requestId();
  s.setMember(new TelegramError(403));await s.pick(request);
  assert.match(s.sent.at(-1).text,/права адміністратора/);assert.equal(s.store.draft(draft.id).stage,'assignee');
  assert.equal(s.store.userPick(request).consumed,0);
  s.setMember({status:'member',user:target});await s.pick(request);assert.equal(s.store.draft(draft.id).stage,'date');
});
test('duplicate users_shared updates apply the selected assignee only once',async t=>{
  const s=setup(t);const draft=await s.start();await s.open(draft);const request=s.requestId();
  await s.pick(request,author,target.id,700);const revision=s.store.draft(draft.id).revision;
  await s.pick(request,author,target.id,700);assert.equal(s.store.draft(draft.id).revision,revision);
  await s.pick(request);assert.match(s.sent.at(-1).text,/вже змінився/);assert.equal(s.store.draft(draft.id).revision,revision);
});
test('expired requests and cancelled drafts cannot be revived by a late private selection',async t=>{
  const s=setup(t);let draft=await s.start();await s.open(draft);let request=s.requestId();
  s.store.db.prepare('UPDATE user_picks SET expires_at=0 WHERE request_id=?').run(request);
  await s.pick(request);assert.match(s.sent.at(-1).text,/застарів/);assert.equal(s.store.draft(draft.id).stage,'assignee');
  draft=await s.start();await s.open(draft);request=s.requestId();
  s.store.transitionDraft(draft.id,draft.revision,900,d=>{d.stage='cancelled';});
  await s.pick(request);assert.equal(s.store.draft(draft.id).stage,'cancelled');
});
test('parallel pickers for different people cannot select into each other’s draft',async t=>{
  const s=setup(t);const a=await s.start();await s.open(a);const requestA=s.requestId();
  const b=await s.start(other);await s.open(b,other);const requestB=s.requestId();assert.notEqual(requestA,requestB);
  await s.pick(requestA,other);assert.equal(s.store.draft(a.id).stage,'assignee');assert.equal(s.store.draft(b.id).stage,'assignee');
  await s.pick(requestB,other);assert.equal(s.store.draft(b.id).stage,'date');assert.equal(s.store.draft(a.id).stage,'assignee');
});
test('a temporary Telegram error does not consume the request',async t=>{
  const s=setup(t);const draft=await s.start();await s.open(draft);const request=s.requestId();
  s.setMember(new TelegramError(503));await assert.rejects(s.pick(request),e=>e.code===503);
  assert.equal(s.store.userPick(request).consumed,0);assert.equal(s.store.draft(draft.id).stage,'assignee');
});
