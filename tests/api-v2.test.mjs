import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createApp} from '../src/server.mjs';
import {makePng} from './helpers/png.mjs';

async function start(t,options={}) {
 const dir=mkdtempSync(join(tmpdir(),'editor-v2-api-'));
 const app=createApp({dataDir:dir,mediaDir:join(dir,'media'),seed:[{id:'POST-016',topic:'main',title:'Идея',brief:'Задание'}],...options});
 await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));t.after(()=>app.server.close());
 const base=`http://127.0.0.1:${app.server.address().port}`;
 const call=async(path,method='GET',data,headers={})=>{
  const response=await fetch(base+path,{method,headers:{'Content-Type':'application/json','X-Editor-Request':'editor',...headers},body:data?JSON.stringify(data):undefined});
  const text=await response.text();
  return {status:response.status,headers:response.headers,data:text&&response.headers.get('content-type')?.includes('json')?JSON.parse(text):null};
 };
 return {app,dir,base,call};
}
const dataUrl=(width,height,color)=>`data:image/png;base64,${makePng(width,height,color).toString('base64')}`;

test('state carries card summaries and answers 304 while nothing changed',async t=>{
 const {call}=await start(t);
 const first=await call('/api/state');
 const etag=first.headers.get('etag'),card=first.data.posts.find(post=>post.id==='POST-016');
 assert.ok(etag);assert.equal(card.history,undefined);assert.equal(card.agentLog,undefined);assert.equal(card.logCount,0);assert.equal(card.variantCount,0);
 assert.equal((await call('/api/state','GET',undefined,{'If-None-Match':etag})).status,304);
 await call('/api/posts/POST-016','PATCH',{revision:1,text:'Новый текст'});
 const changed=await call('/api/state','GET',undefined,{'If-None-Match':etag});
 assert.equal(changed.status,200);assert.notEqual(changed.headers.get('etag'),etag);
});

test('browser modules and shared code come from fixed lists only',async t=>{
 const {base}=await start(t);
 const shared=await fetch(base+'/shared/links.mjs');
 assert.equal(shared.status,200);assert.match(shared.headers.get('content-type'),/javascript/);assert.match(await shared.text(),/markdownLinksToEntities/);
 for(const path of ['/shared/site-scout.mjs','/js/unknown.js','/shared/%2e%2e/database.mjs','/js/..%2fsrc%2fserver.mjs'])assert.notEqual((await fetch(base+path)).status,200,path);
});

test('autosave session over HTTP keeps one version and validates the session id',async t=>{
 const {call}=await start(t);
 const session='44444444-4444-4444-8444-444444444444';
 let response=await call('/api/posts/POST-016','PATCH',{revision:1,text:'Раз',session});
 response=await call('/api/posts/POST-016','PATCH',{revision:response.data.revision,text:'Раз два',session});
 assert.equal(response.status,200);assert.equal(response.data.history.length,1);assert.ok(response.data.lastChange.by);
 assert.equal((await call('/api/posts/POST-016','PATCH',{revision:response.data.revision,text:'x',session:'bad'})).status,400);
});

test('attachments are uploaded to a card and served only for that card',async t=>{
 const {base,call}=await start(t);
 const uploaded=await call('/api/posts/POST-016/attachments','POST',{dataUrl:dataUrl(64,64),name:'logo.png'});
 assert.equal(uploaded.status,201);assert.equal(uploaded.data.label,'logo.png');
 const file=await fetch(base+uploaded.data.url);
 assert.equal(file.status,200);assert.equal(file.headers.get('content-type'),'image/png');assert.deepEqual(Buffer.from(await file.arrayBuffer()),makePng(64,64));
 assert.equal((await fetch(base+'/api/posts/POST-016/attachments/not-a-name.png')).status,404);
 assert.equal((await fetch(base+uploaded.data.url.replace('POST-016','POST-017'))).status,404);
 assert.equal((await call('/api/posts/POST-016/attachments','POST',{dataUrl:'data:text/html;base64,PGh0bWw+',name:'x.html'})).status,400);
});

test('variants, link conversion and text-only restore over HTTP',async t=>{
 const {call}=await start(t);
 let post=(await call('/api/posts/POST-016','PATCH',{revision:1,text:'См. [сайт](https://x.example)'})).data;
 post=(await call('/api/posts/POST-016/image','POST',{revision:post.revision,dataUrl:dataUrl(32,32,[1,2,3])})).data;
 const firstImage=post.image.name;
 post=(await call('/api/posts/POST-016/image','POST',{revision:post.revision,dataUrl:dataUrl(32,32,[4,5,6])})).data;
 assert.deepEqual(post.imageVariants.map(variant=>variant.origin),['upload','upload']);
 post=(await call('/api/posts/POST-016/image/select','POST',{revision:post.revision,name:firstImage})).data;
 assert.equal(post.image.name,firstImage);assert.equal(post.lastChange.origin,'variant');
 assert.match((await call('/api/posts/POST-016/preview')).data.issues.join(' '),/Markdown/);
 post=(await call('/api/posts/POST-016/links/convert','POST',{revision:post.revision})).data;
 assert.equal(post.text,'См. сайт');assert.equal(post.entities[0].type,'text_link');
 const converted=post.revision;
 post=(await call('/api/posts/POST-016','PATCH',{revision:post.revision,text:'Другой текст'})).data;
 post=(await call('/api/posts/POST-016/restore','POST',{revision:post.revision,restoreRevision:converted,fields:['text']})).data;
 assert.equal(post.text,'См. сайт');assert.equal(post.image.name,firstImage);assert.equal(post.entities[0].url,'https://x.example');
 assert.equal((await call('/api/posts/POST-016/image/nope','POST',{revision:post.revision})).status,404);
});

test('a running picture job keeps text editable but guards the picture, approval and publication',async t=>{
 const pending=[];
 const {call}=await start(t,{runnerFactory:()=>({cancel(){},run:args=>new Promise(resolve=>pending.push({args,resolve}))})});
 let post=(await call('/api/posts/POST-016','PATCH',{revision:1,text:'Текст поста'})).data;
 const started=await call('/api/posts/POST-016/jobs','POST',{revision:post.revision,target:'image',instruction:'Нарисуй кота'});
 assert.equal(started.status,202);assert.equal(started.data.agentLog.at(-1).instruction,'Нарисуй кота');assert.equal(started.data.status,'review');
 const upload=await call('/api/posts/POST-016/image','POST',{revision:started.data.revision,dataUrl:dataUrl(32,32)});
 assert.equal(upload.status,409);assert.match(upload.data.error,/рисует/);
 assert.equal((await call('/api/posts/POST-016/approve','POST',{revision:started.data.revision})).status,409);
 const typed=await call('/api/posts/POST-016','PATCH',{revision:started.data.revision,text:'Правка во время картинки'});
 assert.equal(typed.status,200);
 const cancelled=await call('/api/posts/POST-016/cancel','POST',{revision:started.data.revision});
 assert.equal(cancelled.status,200);assert.equal(cancelled.data.agentLog.at(-1).status,'cancelled');assert.equal(cancelled.data.text,'Правка во время картинки');
 const legacy=await call('/api/posts/POST-016/jobs','POST',{revision:cancelled.data.revision,kind:'text',feedback:'Старый формат'});
 assert.equal(legacy.status,202);assert.equal(legacy.data.status,'working');assert.equal(legacy.data.agentLog.at(-1).instruction,'Старый формат');
 await call('/api/posts/POST-016/cancel','POST',{revision:legacy.data.revision});
});
