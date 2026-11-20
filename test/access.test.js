import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { Planner } from '../src/planner.js';
import { loadConfig } from '../src/config.js';

const owner={id:11,first_name:'Власник',username:'owner'};
const participant={id:22,first_name:'Олена',username:'buyer'};
const outsider={id:33,first_name:'Інша людина',username:'owner'};
const bot={id:99,is_bot:true,first_name:'Бот'};
const chat={id:-100,type:'supergroup'};
function setup(t,restricted=true) {
  const store=new Store(':memory:'); t.after(()=>store.close());
  const sent=[];const calls=[];
  const telegram={send:async(chatId,text,extra)=>{sent.push({chatId,text,extra});return {message_id:sent.length};},call:async(method,body)=>{calls.push({method,body});return method==='getChatAdministrators'?[{user:owner,status:'creator'}]:true;}};
  const config={timezone:'Europe/Warsaw',allowedChatIds:new Set(),ownerUserId:restricted?owner.id:null};
  const planner=new Planner(store,telegram,config,{warn(){}}); planner.username='planner_bot';planner.access.botId=bot.id;
  let nextUpdateId=1;
  const msg=(text,from=participant,extra={})=>({update_id:nextUpdateId++,message:{message_id:10,chat,from,text,...extra}});
  const membership=(from=owner,old='left',status='member')=>({update_id:100,my_chat_member:{chat,from,old_chat_member:{status:old,user:bot},new_chat_member:{status,user:bot}}});
  return {store,planner,telegram,config,sent,calls,msg,membership};
}
test('ordinary messages, replies, buttons and service joins discover participants without registration',async t=>{
  const s=setup(t,false);
  await s.planner.handle(s.msg('Привіт'));
  assert.equal(s.store.member(chat.id,participant.id).name,'Олена'); assert.equal(s.sent.length,0);
  await s.planner.handle(s.msg('/menu',owner,{reply_to_message:{from:outsider}}));
  assert.ok(s.store.member(chat.id,outsider.id));
  const menu=s.sent.at(-1);
  assert.doesNotMatch(menu.text,/\/join|Я учасник/);
  assert.ok(!menu.extra.reply_markup.inline_keyboard.flat().some(b=>b.callback_data==='m:join'));
  const newcomer={id:44,first_name:'Новий'};
  await s.planner.handle({update_id:2,message:{chat,from:owner,new_chat_members:[newcomer,bot]}});
  assert.ok(s.store.member(chat.id,newcomer.id));assert.equal(s.store.member(chat.id,bot.id),undefined);
  await s.planner.handle({update_id:3,message:{chat,from:owner,left_chat_member:newcomer}});
  assert.equal(s.store.member(chat.id,newcomer.id),undefined);
});
test('member updates automatically add and remove users, with no registration messages',async t=>{
  const s=setup(t,false);
  await s.planner.handle({update_id:1,chat_member:{chat,new_chat_member:{user:participant,status:'member'}}});
  assert.ok(s.store.member(chat.id,participant.id));
  await s.planner.handle({update_id:2,chat_member:{chat,new_chat_member:{user:participant,status:'left'}}});
  assert.equal(s.store.member(chat.id,participant.id),undefined);assert.equal(s.sent.length,0);
});
test('replying /task starts the wizard with that author already selected',async t=>{
  const s=setup(t,false);
  await s.planner.handle(s.msg('/task',owner,{reply_to_message:{from:participant}}));
  const draft=s.store.activeDraft(chat.id,owner.id,0);
  assert.equal(draft.assigneeId,participant.id);assert.equal(draft.stage,'date');
  assert.ok(s.calls.some(c=>c.method==='getChatAdministrators'));
});
test('owner join approves a group and participants can use it normally',async t=>{
  const s=setup(t);
  assert.equal(s.planner.allowed(chat.id),false);
  await s.planner.handle(s.membership());
  assert.equal(s.planner.allowed(chat.id),true);
  await s.planner.handle(s.msg('/menu'));
  assert.equal(s.sent.length,1);assert.ok(!s.calls.some(c=>c.method==='leaveChat'));
});
test('another account with the same username cannot add or authorize the bot',async t=>{
  const s=setup(t);
  await s.planner.handle(s.membership(outsider));
  assert.equal(s.planner.allowed(chat.id),false);
  assert.deepEqual(s.calls.filter(c=>c.method==='leaveChat').map(c=>c.body.chat_id),[chat.id]);
  await s.planner.handle(s.msg('/allow',outsider));await s.planner.handle(s.msg('/menu',outsider));
  assert.equal(s.sent.length,0);assert.equal(s.store.member(chat.id,outsider.id),undefined);
});
test('owner can authorize an existing group, and other admins can promote the bot without revoking access',async t=>{
  const s=setup(t);
  await s.planner.handle(s.msg('/allow',owner));assert.equal(s.planner.allowed(chat.id),true);
  await s.planner.handle(s.membership(participant,'member','administrator'));
  assert.equal(s.planner.allowed(chat.id),true);assert.ok(!s.calls.some(c=>c.method==='leaveChat'));
  await s.planner.handle(s.membership(owner,'administrator','left'));
  assert.equal(s.planner.allowed(chat.id),false);
});
test('removal and re-add by another user do not inherit prior approval, even for explicitly listed groups',async t=>{
  const s=setup(t);s.config.allowedChatIds.add(chat.id);
  await s.planner.handle(s.membership(owner));
  await s.planner.handle(s.membership(participant));
  assert.ok(s.calls.some(c=>c.method==='leaveChat'));
  assert.equal(s.store.groupApproved(chat.id,owner.id),false);
  assert.equal(s.planner.allowed(chat.id),false);
});
test('unapproved group callbacks cannot change tasks or acquire membership',async t=>{
  const s=setup(t);
  await s.planner.handle({update_id:1,callback_query:{id:'x',from:outsider,data:'m:new',message:{chat}}});
  assert.equal(s.store.member(chat.id,outsider.id),undefined);assert.equal(s.sent.length,0);
});
test('/id reports the requesting account ID in private chat without making it an owner',async t=>{
  const s=setup(t);
  await s.planner.handle({update_id:1,message:{chat:{id:outsider.id,type:'private'},from:outsider,text:'/id'}});
  assert.match(s.sent.at(-1).text,/<code>33<\/code>/);assert.equal(s.config.ownerUserId,owner.id);
});
test('owner configuration accepts only a positive numeric Telegram ID',()=>{
  const env={DATABASE_URL:"postgresql://test:test@localhost/test",TELEGRAM_BOT_TOKEN:'12345:test-token',WEBHOOK_SECRET:'a'.repeat(32),PUBLIC_BASE_URL:'https://example.com'};
  assert.equal(loadConfig({...env,OWNER_USER_ID:'11'}).ownerUserId,11);
  for(const value of ['@owner','0','-11','1.5','NaN'])assert.throws(()=>loadConfig({...env,OWNER_USER_ID:value}));
});
