import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { Planner } from '../src/planner.js';

const author={id:11,first_name:'Автор'};
const target={id:22,first_name:'Олена',username:'buyer',is_bot:false};
const chat={id:-100,type:'supergroup'};
function setup(t,known=true) {
  const store=new Store(':memory:');t.after(()=>store.close());
  if(known)store.remember(target,chat.id);
  const sent=[];const panels=new Map();const calls=[];let messageId=100;let updateId=1;
  let member={status:'member',user:target};
  const telegram={
    async send(chatId,text,extra={}){const message_id=++messageId;sent.push({chatId,text,...extra});panels.set(message_id,{text,...extra});return {message_id};},
    async call(method,body){calls.push({method,body});if(method==='getChatAdministrators')return [];if(method==='getChatMember')return member;
      if(method==='editMessageText')panels.set(body.message_id,body);return true;},
  };
  const planner=new Planner(store,telegram,{timezone:'Europe/Warsaw',allowedChatIds:new Set()},{warn(){}});planner.username='planner_bot';
  const active=()=>store.activeDraft(chat.id,author.id,55);
  const message=async(text,entities=[],replyId)=>planner.handle({update_id:updateId++,message:{chat,from:author,message_id:++messageId,text,entities,message_thread_id:55,
    ...(replyId?{reply_to_message:{message_id:replyId}}:{})}});
  const startMention=async()=>{
    await message('/task');const draft=active();const button=panels.get(draft.panelId).reply_markup.inline_keyboard.flat().find(b=>b.text==='👤 Вказати через @');assert.ok(button);
    await planner.handle({update_id:updateId++,callback_query:{id:'q',from:author,data:button.callback_data,message:{chat,message_id:draft.panelId,message_thread_id:55}}});
    assert.equal(active().stage,'mention');
  };
  return {store,planner,sent,calls,active,message,startMention,setMember:value=>{member=value;}};
}
test('/task @username selects a verified group participant and opens the calendar',async t=>{
  const s=setup(t);await s.message('/task @buyer');
  assert.equal(s.active().stage,'date');assert.equal(s.active().assigneeId,target.id);
  assert.ok(s.sent.every(m=>m.chatId===chat.id));
});
test('mention field accepts @username and stays completely in the group',async t=>{
  const s=setup(t);await s.startMention();await s.message('@buyer',[{type:'mention',offset:0,length:6}],s.active().promptId);
  assert.equal(s.active().stage,'date');assert.equal(s.active().assigneeId,target.id);
  assert.ok(s.sent.every(m=>m.chatId===chat.id));
});
test('Telegram text_mention selects a previously unknown user without a username',async t=>{
  const s=setup(t,false);const user={id:44,first_name:'Ірина',is_bot:false};s.setMember({status:'member',user});
  await s.startMention();await s.message('Ірина',[{type:'text_mention',offset:0,length:5,user}],s.active().promptId);
  assert.equal(s.active().assigneeId,user.id);assert.equal(s.active().stage,'date');assert.ok(s.store.member(chat.id,user.id));
});
test('short /task supports a Telegram name mention with UTF-16 offsets',async t=>{
  const s=setup(t,false);const user={id:44,first_name:'👤 Ірина',is_bot:false};s.setMember({status:'member',user});
  const text='/task 👤 Ірина';await s.message(text,[{type:'bot_command',offset:0,length:5},{type:'text_mention',offset:6,length:text.length-6,user}]);
  assert.equal(s.active().assigneeId,user.id);assert.equal(s.active().stage,'date');
});
test('a profile known from private chat is checked for membership and added to the group list',async t=>{
  const s=setup(t,false);s.store.remember(target,target.id,true);assert.equal(s.store.member(chat.id,target.id),undefined);
  await s.message('/task @buyer');assert.equal(s.active().assigneeId,target.id);assert.ok(s.store.member(chat.id,target.id));
  assert.ok(s.calls.some(c=>c.method==='getChatMember'&&c.body.chat_id===chat.id&&c.body.user_id===target.id));
});
test('unknown usernames produce a useful reply option and leave the prompt usable',async t=>{
  const s=setup(t,false);await s.startMention();const promptId=s.active().promptId;
  await s.message('@not_seen',[],promptId);
  assert.equal(s.active().stage,'mention');assert.equal(s.active().promptId,promptId);
  assert.match(s.sent.at(-1).text,/\/task відповіддю/);
  s.store.remember(target,chat.id);await s.message('@buyer',[],promptId);assert.equal(s.active().stage,'date');
});
test('a stale username or departed member cannot be selected',async t=>{
  const s=setup(t);await s.startMention();const promptId=s.active().promptId;
  s.setMember({status:'member',user:{...target,username:'changed'}});await s.message('@buyer',[],promptId);assert.equal(s.active().stage,'mention');
  s.setMember({status:'left',user:target});await s.message('@buyer',[],promptId);assert.equal(s.active().stage,'mention');
});
