import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Autosave,newSessionId} from '../public/js/autosave.js';

function fakeClock() {
 let now=0,sequence=0;const timers=new Map();
 return {
  setTimeout(fn,ms){const id=++sequence;timers.set(id,{fn,at:now+ms});return id;},
  clearTimeout(id){timers.delete(id);},
  async tick(ms){now+=ms;for(const [id,timer] of [...timers])if(timer.at<=now){timers.delete(id);timer.fn();}for(let i=0;i<5;i++)await new Promise(resolve=>setImmediate(resolve));},
 };
}
const settle=async()=>{for(let i=0;i<5;i++)await new Promise(resolve=>setImmediate(resolve));};
function deferred(){let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};}

test('edits are sent once after a pause with the session and the latest revision',async()=>{
 const clock=fakeClock(),calls=[],statuses=[];
 const autosave=new Autosave({clock,save:async request=>{calls.push(request);return {id:'P',revision:request.revision+1};},onChange:state=>statuses.push(state.status)});
 autosave.open({id:'P',revision:1});
 autosave.edit({text:'а'});autosave.edit({text:'аб'});await clock.tick(500);autosave.edit({text:'абв'});
 await clock.tick(799);assert.equal(calls.length,0);
 await clock.tick(1);
 assert.equal(calls.length,1);assert.deepEqual(calls[0].fields,{text:'абв'});assert.equal(calls[0].revision,1);assert.match(calls[0].session,/^[a-f0-9-]{36}$/);
 assert.equal(autosave.status,'saved');assert.equal(autosave.revision,2);assert.ok(statuses.includes('saving'));
 autosave.edit({title:'Новое'});await clock.tick(800);
 assert.equal(calls[1].revision,2);assert.equal(calls[1].session,calls[0].session);
});

test('edits made during a request go in the next request with the new revision',async()=>{
 const clock=fakeClock(),calls=[],pending=[];
 const autosave=new Autosave({clock,save:request=>{calls.push(request);const next=deferred();pending.push(next);return next.promise;}});
 autosave.open({id:'P',revision:1});
 autosave.edit({text:'один',title:'Т'});await clock.tick(800);
 autosave.edit({text:'один два'});
 const flushing=autosave.flush();
 pending[0].resolve({id:'P',revision:2});await settle();
 assert.equal(calls.length,2);assert.deepEqual(calls[1].fields,{text:'один два'});assert.equal(calls[1].revision,2);
 pending[1].resolve({id:'P',revision:3});
 assert.equal((await flushing).revision,3);assert.equal(autosave.dirty,false);assert.equal(autosave.status,'saved');
});

test('offline saves retry every five seconds; a conflict waits for the user',async()=>{
 const clock=fakeClock();let mode='offline';const calls=[];
 const autosave=new Autosave({clock,save:async request=>{calls.push(request);if(mode==='offline')throw Object.assign(new Error('Нет связи с редакцией.'),{status:0});if(mode==='conflict')throw Object.assign(new Error('Версия изменилась. Обновите карточку перед действием.'),{status:409});return {id:'P',revision:request.revision+1};}});
 autosave.open({id:'P',revision:4});
 autosave.edit({text:'x'});await clock.tick(800);
 assert.equal(autosave.status,'offline');assert.equal(calls.length,1);
 await clock.tick(5000);assert.equal(calls.length,2);
 mode='conflict';await clock.tick(5000);
 assert.equal(autosave.status,'conflict');assert.equal(calls.length,3);
 autosave.edit({text:'xy'});await clock.tick(10000);assert.equal(calls.length,3);
 await assert.rejects(()=>autosave.flush(),/изменили в другом месте/);
 mode='ok';
 const saved=await autosave.keepMine({id:'P',revision:9},{text:'xy',title:'Моё'});
 assert.equal(saved.revision,10);assert.equal(calls.at(-1).revision,9);assert.deepEqual(calls.at(-1).fields,{text:'xy',title:'Моё'});
 assert.notEqual(calls.at(-1).session,calls[0].session);
});

test('blocked and invalid saves keep the edits and reject flush; adopt follows outside changes only when idle',async()=>{
 const clock=fakeClock();let error=Object.assign(new Error('Введите название.'),{status:400});
 const autosave=new Autosave({clock,save:async request=>{if(error)throw error;return {id:'P',revision:request.revision+1};}});
 autosave.open({id:'P',revision:1});
 autosave.edit({title:''});
 await assert.rejects(()=>autosave.flush(),/название/);
 assert.equal(autosave.status,'invalid');assert.equal(autosave.dirty,true);
 assert.equal(autosave.adopt({id:'P',revision:5,lastChange:{origin:'agent'}}),false);
 error=null;autosave.edit({title:'Готово'});await autosave.flush();
 assert.equal(autosave.revision,2);
 const session=autosave.session;
 assert.equal(autosave.adopt({id:'P',revision:5,lastChange:{origin:'agent'}}),true);
 assert.equal(autosave.revision,5);assert.notEqual(autosave.session,session);
 autosave.discard({id:'P',revision:7});assert.equal(autosave.revision,7);assert.equal(autosave.dirty,false);
 assert.match(newSessionId(),/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
});
