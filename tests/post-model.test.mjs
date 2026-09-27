import {test} from 'node:test';
import assert from 'node:assert/strict';
import {applyChange,continuesSession,ensureVariants,rememberVariant,addLogEntry,updateLogEntry,recentLog,onlyImageChangesSince,AGENT_LOG_LIMIT,SESSION_WINDOW_MS} from '../src/post-model.mjs';

const card=()=>({id:'POST-200',topic:'main',title:'Тема',brief:'',text:'',entities:[],image:null,sources:[],revision:1,history:[],updatedAt:'2026-09-26T10:00:00.000Z'});

test('manual edits of one session share a single snapshot',()=>{
 const post=card();
 applyChange(post,{origin:'manual',session:'s1'},p=>{p.text='Один';});
 applyChange(post,{origin:'manual',session:'s1'},p=>{p.text='Один два';});
 applyChange(post,{origin:'manual',session:'s1'},p=>{p.title='Новая тема';});
 assert.equal(post.revision,4);assert.equal(post.history.length,1);assert.equal(post.history[0].text,'');
 assert.deepEqual(post.lastChange.fields,['text','title']);assert.equal(post.lastChange.origin,'manual');
});
test('a new session, a missing session or an agent change start a new snapshot',()=>{
 const post=card();
 applyChange(post,{origin:'manual',session:'s1'},p=>{p.text='А';});
 applyChange(post,{origin:'manual',session:'s2'},p=>{p.text='Б';});
 applyChange(post,{origin:'manual'},p=>{p.text='В';});
 applyChange(post,{origin:'agent',jobId:'job-1',instruction:'Сократи'},p=>{p.text='Г';});
 applyChange(post,{origin:'manual',session:'s2'},p=>{p.text='Д';});
 assert.equal(post.history.length,5);
 assert.equal(post.history.at(-1).change.origin,'agent');assert.equal(post.history.at(-1).change.instruction,'Сократи');
});
test('a stale session does not continue after the window',()=>{
 const post=card();
 applyChange(post,{origin:'manual',session:'s1'},p=>{p.text='А';});
 post.lastChange.at=new Date(Date.now()-SESSION_WINDOW_MS-1000).toISOString();
 assert.equal(continuesSession(post,'manual','s1'),false);
 applyChange(post,{origin:'manual',session:'s1'},p=>{p.text='Б';});
 assert.equal(post.history.length,2);
});
test('variants are rebuilt from history and new images keep their origin',()=>{
 const post=card();
 post.history=[{revision:1,image:null,savedAt:'2026-09-01T00:00:00.000Z'},{revision:2,image:{name:'POST-200-a.png',url:'/media/a'},savedAt:'2026-09-02T00:00:00.000Z'}];
 post.image={name:'POST-200-b.png',url:'/media/b'};post.revision=3;
 ensureVariants(post);
 assert.deepEqual(post.imageVariants.map(v=>[v.name,v.origin]),[['POST-200-a.png','legacy'],['POST-200-b.png','legacy']]);
 applyChange(post,{origin:'agent',jobId:'job-2',instruction:'Добавь лого'},p=>{p.image={name:'POST-200-c.png',url:'/media/c'};});
 const added=post.imageVariants.at(-1);
 assert.equal(added.name,'POST-200-c.png');assert.equal(added.origin,'agent');assert.equal(added.jobId,'job-2');assert.equal(added.instruction,'Добавь лого');
 rememberVariant(post,{name:'POST-200-c.png',url:'/media/c'},{origin:'upload'});
 assert.equal(post.imageVariants.length,3);
});
test('a card without variants gets the new agent image as agent, not legacy',()=>{
 const post=card();
 applyChange(post,{origin:'agent',jobId:'job-3'},p=>{p.image={name:'POST-200-d.png',url:'/media/d'};});
 assert.deepEqual(post.imageVariants.map(v=>v.origin),['agent']);
});
test('agent log keeps the last entries only',()=>{
 const post=card();
 for(let index=0;index<AGENT_LOG_LIMIT+5;index++)addLogEntry(post,{id:`id-${index}`,status:'completed'});
 assert.equal(post.agentLog.length,AGENT_LOG_LIMIT);assert.equal(post.agentLog[0].id,'id-5');
 updateLogEntry(post,'id-54',{status:'failed'});assert.equal(post.agentLog.at(-1).status,'failed');
 addLogEntry(post,{id:'running',status:'running'});
 assert.deepEqual(recentLog(post,null,2).map(e=>e.id),['id-53','id-54']);
});
test('image-only changes since a revision are detected',()=>{
 const post=card();
 applyChange(post,{origin:'manual',session:'s1'},p=>{p.text='Текст';});
 const base=post.revision;
 applyChange(post,{origin:'agent',jobId:'j'},p=>{p.image={name:'POST-200-e.png',url:'/media/e'};});
 applyChange(post,{origin:'variant'},p=>{p.image=null;});
 assert.equal(onlyImageChangesSince(post,base),true);
 applyChange(post,{origin:'agent',jobId:'k'},p=>{p.text='Другой';});
 assert.equal(onlyImageChangesSince(post,base),false);
 assert.equal(onlyImageChangesSince(post,post.revision),false);
});
