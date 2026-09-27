import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Store} from '../src/store.mjs';
import {Jobs} from '../src/jobs.mjs';
import {EditorDatabase} from '../src/database.mjs';
import {ProjectStore} from '../src/project-store.mjs';
const pause=()=>new Promise(r=>setTimeout(r,25));
function fixture(run){const dir=mkdtempSync(`${tmpdir()}/editor-jobs-`);const store=new Store(dir+'/posts',[{id:'POST-016',topic:'main',title:'Идея'}]);return {store,jobs:new Jobs({store,assets:{},dir:dir+'/jobs',runnerFactory:()=>({run,cancel(){}})})};}
function postFixture(runnerFactory,seed={}) {
 const dir=mkdtempSync(`${tmpdir()}/editor-post-jobs-`);
 const store=new Store(dir+'/posts',[{id:'POST-016',topic:'main',title:'Идея',brief:'Сделать полезный пост',...seed}]);
 const jobs=new Jobs({store,assets:{fromFile:()=>({name:'generated.png',url:'/media/generated.png'})},dir:dir+'/jobs',runnerFactory});
 return {store,jobs};
}
test('автор и редактор выполняются последовательно, применяется только проверенный текст',async()=>{
 let count=0;const {store,jobs}=fixture(async()=>({text:++count===1?'Черновик':'Проверенный текст',sources:[]}));
 jobs.start('POST-016',1,'text');assert.throws(()=>jobs.start('POST-016',1,'text'),/выполняется/);
 for(let i=0;i<20&&jobs.active.size;i++)await pause();
 const p=store.get('POST-016');assert.equal(count,2);assert.equal(p.text,'Проверенный текст');assert.equal(p.revision,2);assert.equal(p.job.status,'completed');
});
test('ошибка редактора сохраняет исходный текст и не публикует авторский черновик',async()=>{
 let count=0;const {store,jobs}=fixture(async()=>{if(++count===2)throw new Error('Нужен источник');return {text:'Черновик',sources:[]};});
 jobs.start('POST-016',1,'text');for(let i=0;i<20&&jobs.active.size;i++)await pause();
 const p=store.get('POST-016');assert.equal(p.text,'');assert.equal(p.job.status,'failed');assert.equal(p.job.error,'Нужен источник');
});
test('отмена отбрасывает запоздалый результат',async()=>{
 let finish;const {store,jobs}=fixture(()=>new Promise(r=>{finish=r;}));jobs.start('POST-016',1,'text');await pause();
 jobs.cancel('POST-016',1);finish({text:'Поздний ответ',sources:[]});await pause();
 assert.equal(store.get('POST-016').text,'');assert.equal(store.get('POST-016').job.status,'failed');
});
test('semantic duplicate guard stops before writer, retaining old text and reference',async()=>{
 let calls=[];const {store,jobs}=fixture(async({kind})=>{calls.push(kind);return {ready:true,duplicateIds:['POST-003'],reason:'Эта задача уже разобрана'};});
 jobs.registry={catalog:()=>[{id:'POST-003',title:'Другой заголовок',url:'https://t.me/c/123/4',text:'Тот же смысл'}],findSimilar:()=>[]};
 jobs.start('POST-016',1,'text');for(let i=0;i<20&&jobs.active.size;i++)await pause();
 const p=store.get('POST-016');assert.deepEqual(calls,['duplicates']);assert.equal(p.text,'');assert.equal(p.job.status,'blocked');assert.equal(p.duplicateCheck.matches[0].id,'POST-003');
});
test('explicit new angle permits writing after duplicate stop',async()=>{
 const {store,jobs}=fixture(async()=>({text:'Новый ракурс',sources:[]}));jobs.registry={catalog:()=>[{id:'POST-003',title:'Ранее'}],findSimilar:()=>[{id:'POST-003',title:'Ранее'}]};
 jobs.start('POST-016',1,'text','Сравни другой подход','Новый сравнительный разбор');for(let i=0;i<20&&jobs.active.size;i++)await pause();
 assert.equal(store.get('POST-016').text,'Новый ракурс');assert.equal(store.get('POST-016').duplicateCheck.overrideReason,'Новый сравнительный разбор');
});
test('иллюстратор получает визуальный стиль проекта и без лишних вложений',async()=>{
 let request;const {store,jobs}=fixture(async args=>{request=args;return {imagePath:'/test/generated.png'};});
 store.mutate('POST-016',p=>{p.text='Пост для обложки';});
 jobs.assets={fromFile:()=>({path:'test.png'})};
 jobs.start('POST-016',store.get('POST-016').revision,'image');
 for(let i=0;i<20&&jobs.active.size;i++)await pause();
 assert.equal(request.kind,'image');assert.deepEqual(request.images,[]);
 assert.match(request.prompt,/Визуальный стиль проекта:\nНЕ ЗАПОЛНЕНО/);
 assert.equal(store.get('POST-016').job.status,'completed');
});

test('post writes and reviews the text first, then draws the picture for that text',async()=>{
 const pending=[];const started=[];
 const {store,jobs}=postFixture(()=>({run:async args=>{started.push(args.kind);return new Promise(resolve=>pending.push({...args,resolve}));},cancel(){}}));
 jobs.start('POST-016',1,'post');
 for(let i=0;i<20&&!pending.length;i++)await pause();
 assert.deepEqual(started,['text']);
 pending[0].resolve({text:'Черновик поста',sources:[]});
 for(let i=0;i<20&&pending.length<2;i++)await pause();
 pending[1].resolve({text:'Проверенный пост',sources:[]});
 for(let i=0;i<20&&pending.length<3;i++)await pause();
 assert.deepEqual(started,['text','text','image']);
 assert.match(pending[2].prompt,/"text":"Проверенный пост"/);
 assert.equal(store.get('POST-016').job.tasks.text.status,'completed');
 pending[2].resolve({imagePath:'/generated.png'});
 for(let i=0;i<30&&jobs.active.size;i++)await pause();
 const post=store.get('POST-016');
 assert.equal(post.text,'Проверенный пост');
 assert.equal(post.image.name,'generated.png');
 assert.equal(post.job.status,'completed');
 assert.equal(post.revision,3);
 assert.deepEqual(post.agentLog.at(-1).results,{text:{revision:2},image:{name:'generated.png',revision:3}});
});

test('post skips the picture when the text fails',async()=>{
 const started=[];
 const {store,jobs}=postFixture(()=>({run:async({kind})=>{started.push(kind);throw new Error('Автор не справился');},cancel(){}}));
 jobs.start('POST-016',1,'post');
 for(let i=0;i<30&&jobs.active.size;i++)await pause();
 const post=store.get('POST-016');
 assert.deepEqual(started,['text']);assert.equal(post.job.status,'failed');
 assert.equal(post.job.tasks.text.status,'failed');assert.equal(post.job.tasks.image.status,'cancelled');
 assert.equal(post.agentLog.at(-1).status,'failed');assert.equal(post.agentLog.at(-1).error,'Автор не справился');
});

test('post keeps working until image settles after text branch',async()=>{
 let finishImage;
 const {store,jobs}=postFixture(()=>({run:async({kind})=>kind==='image'?new Promise(resolve=>{finishImage=resolve;}):{text:'Готовый текст',sources:[]},cancel(){}}));
 jobs.start('POST-016',1,'post');
 for(let i=0;i<20&&!finishImage;i++)await pause();
 let post=store.get('POST-016');assert.equal(post.text,'Готовый текст');assert.equal(post.status,'working');assert.equal(post.job.status,'running');
 finishImage({imagePath:'/generated.png'});for(let i=0;i<30&&jobs.active.size;i++)await pause();
 post=store.get('POST-016');assert.equal(post.image.name,'generated.png');assert.equal(post.job.status,'completed');
});

test('post keeps successful branch when the other branch fails',async()=>{
 const {store,jobs}=postFixture(()=>({run:async({kind})=>kind==='image'?Promise.reject(new Error('Картинка недоступна')):Promise.resolve({text:'Готовый текст',sources:[]}),cancel(){}}));
 jobs.start('POST-016',1,'post');
 for(let i=0;i<30&&jobs.active.size;i++)await pause();
 const post=store.get('POST-016');
 assert.equal(post.text,'Готовый текст');
 assert.equal(post.image,null);
 assert.equal(post.job.status,'failed');
 assert.equal(post.job.tasks.text.status,'completed');
 assert.equal(post.job.tasks.image.status,'failed');
 assert.match(post.job.error,/Картинка недоступна/);
});

test('post duplicate guard runs before either paid branch',async()=>{
 const calls=[];const {store,jobs}=postFixture(()=>({run:async({kind})=>{calls.push(kind);return {duplicateIds:['POST-003'],reason:'Уже есть такой пост'};},cancel(){}}));
 jobs.registry={catalog:()=>[{id:'POST-003',title:'Старый'}],findSimilar:()=>[]};
 jobs.start('POST-016',1,'post');
 for(let i=0;i<30&&jobs.active.size;i++)await pause();
 assert.deepEqual(calls,['duplicates']);
 assert.equal(store.get('POST-016').job.status,'blocked');
});

test('cancelling post stops the runner, releases the slot and ignores late results',async()=>{
 const pending=[],cancelled=[];
 const {store,jobs}=postFixture(()=>({run:async({kind})=>new Promise(resolve=>pending.push({kind,resolve})),cancel(){cancelled.push(true);}}));
 jobs.start('POST-016',1,'post');
 for(let i=0;i<20&&!pending.length;i++)await pause();
 const before=store.get('POST-016');jobs.cancel('POST-016',before.revision);
 assert.equal(jobs.active.size,0);assert.equal(cancelled.length,1);
 for(const call of pending)call.resolve({text:'Поздний текст',sources:[]});
 await pause();
 const post=store.get('POST-016');assert.equal(post.text,'');assert.equal(post.image,null);assert.equal(post.job.status,'failed');
 assert.equal(post.job.tasks.text.status,'cancelled');assert.equal(post.job.tasks.image.status,'cancelled');
 assert.equal(post.agentLog.at(-1).status,'cancelled');
});

test('immediate post cancellation starts no runner',async()=>{
 let factoryCalls=0,runCalls=0;
 const {store,jobs}=postFixture(()=>{factoryCalls++;return {run:async()=>{runCalls++;return {text:'late',sources:[]};},cancel(){}};});
 jobs.start('POST-016',1,'post');jobs.cancel('POST-016',1);await pause();
 assert.equal(factoryCalls,0);assert.equal(runCalls,0);assert.equal(jobs.active.size,0);assert.equal(store.get('POST-016').job.status,'failed');
});

test('post rejects a result after an unrelated revision change',async()=>{
 let finish;
 const {store,jobs}=postFixture(()=>({run:async({kind})=>kind==='image'?new Promise(resolve=>{finish=resolve;}):Promise.resolve({text:'Текст',sources:[]}),cancel(){}}));
 jobs.start('POST-016',1,'post');for(let i=0;i<20&&!finish;i++)await pause();
 store.mutate('POST-016',post=>{post.revision++;post.text='Чужая правка';});
 finish({imagePath:'/late.png'});for(let i=0;i<30&&jobs.active.size;i++)await pause();
 const post=store.get('POST-016');assert.equal(post.text,'Чужая правка');assert.equal(post.job.tasks.image.status,'failed');assert.match(post.job.tasks.image.error,/изменилась/);
});

test('recovery closes interrupted post branches and invalidates approvals',()=>{
 const dir=mkdtempSync(join(tmpdir(),'editor-recover-')),database=new EditorDatabase(join(dir,'editor.sqlite')),store=new ProjectStore(database,'default');
 store.create({topic:'main',title:'Восстановление',brief:'Собрать пост'},'POST-016');
 store.mutate('POST-016',post=>{post.status='working';post.approval={revision:1};post.schedule={revision:1};post.job={id:'job',kind:'post',status:'running',phase:'В работе',error:null,tasks:{text:{status:'completed',phase:'Готово',error:null},image:{status:'running',phase:'Создаёт изображение',error:null}}};post.text='Готовый текст';});
 database.close();
 const reopened=new EditorDatabase(join(dir,'editor.sqlite')),recovered=new ProjectStore(reopened,'default');recovered.recover();
 const post=recovered.get('POST-016');
 assert.equal(post.status,'review');assert.equal(post.job.status,'failed');assert.equal(post.job.tasks.text.status,'completed');assert.equal(post.job.tasks.image.status,'failed');assert.equal(post.approval,null);assert.equal(post.schedule,null);assert.ok(post.job.finishedAt);
 reopened.close();
});

// Real store, media and attachments; the agent is a stub that records what it was given.
async function sqlFixture(t,run,{scout,text='Готовый текст поста'}={}) {
 const {Assets}=await import('../src/assets.mjs');
 const {Attachments}=await import('../src/attachments.mjs');
 const {makePng}=await import('./helpers/png.mjs');
 const {writeFileSync,mkdirSync}=await import('node:fs');
 const dir=mkdtempSync(join(tmpdir(),'editor-sql-jobs-')),database=new EditorDatabase(join(dir,'editor.sqlite'));t.after(()=>database.close());
 const store=new ProjectStore(database,'default'),assets=new Assets(join(dir,'media'),'default'),attachments=new Attachments(join(dir,'attachments'),'default');
 const created=store.create({topic:'main',title:'Карточка',brief:'Задание'},'POST-400');
 const post=text?store.save(created.id,{text},created.revision):created;
 const requests=[];
 const runnerFactory=()=>({cancel(){},run:async args=>{
  requests.push(args);
  const answer=await run(args,requests.length);
  if(args.kind==='image'&&answer?.imagePath==='draw'){mkdirSync(args.jobDir,{recursive:true});const path=join(args.jobDir,`out-${requests.length}.png`);writeFileSync(path,makePng(64,64));return {...answer,imagePath:path};}
  return answer;
 }});
 const jobs=new Jobs({store,assets,attachments,dir:join(dir,'jobs'),runnerFactory,...(scout?{scout}:{})});
 return {store,assets,attachments,jobs,post,requests,makePng,dir};
}
const settle=async jobs=>{for(let i=0;i<60&&jobs.active.size;i++)await pause();};

test('a picture job leaves the text editable and lands on the latest revision',async t=>{
 let finish;
 const {store,jobs,post}=await sqlFixture(t,({kind})=>kind==='image'?new Promise(resolve=>{finish=resolve;}):null);
 const started=jobs.start(post.id,post.revision,{target:'image',instruction:'Сделай ярче'},{by:'Ольга'});
 assert.equal(started.status,'review');assert.equal(started.job.kind,'image');assert.equal(started.agentLog.at(-1).status,'running');
 for(let i=0;i<20&&!finish;i++)await pause();
 const session='22222222-2222-4222-8222-222222222222';
 const typed=store.save(post.id,{text:'Текст правят, пока рисуется картинка'},started.revision,{session});
 finish({imagePath:'draw',usedAssets:[],note:'Сделано ярче'});await settle(jobs);
 const done=store.get(post.id);
 assert.equal(done.text,'Текст правят, пока рисуется картинка');assert.ok(done.image?.name);
 assert.equal(done.revision,typed.revision+1);assert.equal(done.lastChange.origin,'agent');assert.deepEqual(done.lastChange.fields,['image']);
 assert.deepEqual(done.imageVariants.at(-1),{...done.imageVariants.at(-1),origin:'agent',instruction:'Сделай ярче'});
 const entry=done.agentLog.at(-1);
 assert.equal(entry.status,'completed');assert.equal(entry.by,'Ольга');assert.equal(entry.note,'Сделано ярче');assert.equal(entry.results.image.name,done.image.name);
 const rebased=store.save(post.id,{text:'Дописано после картинки'},typed.revision,{session});
 assert.equal(rebased.image.name,done.image.name);assert.equal(rebased.text,'Дописано после картинки');
});

test('edit mode sends the current picture first, then attachments, site pictures and references',async t=>{
 const scouted=[];
 const scout=async(urls,options)=>{
  scouted.push({urls,options});
  const {mkdirSync,writeFileSync}=await import('node:fs');mkdirSync(options.dir,{recursive:true});
  const path=join(options.dir,'asset-1.png');writeFileSync(path,(await import('./helpers/png.mjs')).makePng(120,60));
  return {pages:[{url:urls[0],finalUrl:'https://www.example-app.com/',title:'Example',status:'ok',text:'Диктовка'}],assets:[{path,width:120,height:60,sourceUrl:'https://www.example-app.com/logo.png',pageUrl:'https://www.example-app.com/',label:'Example logo',kind:'img'}]};
 };
 const {store,assets,attachments,jobs,post,requests,makePng}=await sqlFixture(t,({kind},index)=>kind==='image'?{imagePath:'draw',usedAssets:index===1?[]:[3,1,2,4],note:'Лого перенесено'}:null,{scout});
 jobs.start(post.id,post.revision,{target:'image',mode:'new'});await settle(jobs);
 const first=store.get(post.id);assert.deepEqual(requests[0].images,[]);
 const upload=attachments.save(post.id,makePng(80,80),{label:'photo.png'});
 jobs.start(post.id,first.revision,{target:'image',instruction:'Возьми лого с example-app.com',attachmentIds:[upload.id]});
 assert.equal(store.get(post.id).job.mode,'edit');
 await settle(jobs);
 const request=requests[1];
 assert.equal(request.images[0],assets.resolve(first.image));
 assert.equal(request.images[1],attachments.byId(post.id,upload.id).path);
 assert.match(request.images[2],/asset-1\.png$/);
 assert.equal(request.images.length,3);
 assert.match(request.prompt,/^1\. Текущая картинка поста$/m);assert.match(request.prompt,/^2\. Вложение пользователя: photo\.png$/m);assert.match(request.prompt,/^3\. С сайта: example-app\.com — Example logo/m);
 assert.deepEqual(scouted[0].urls,['https://example-app.com/']);
 const entry=store.get(post.id).agentLog.at(-1);
 assert.equal(entry.mode,'edit');assert.deepEqual(entry.urls,['https://example-app.com/']);assert.equal(entry.sites[0].title,'Example');
 assert.deepEqual(entry.usedAssets.map(item=>item.role),['site','current','upload']);
 const kept=entry.usedAssets[0];assert.equal(kept.sourceUrl,'https://www.example-app.com/logo.png');assert.equal(attachments.byId(post.id,kept.id).source,'site');
 assert.equal(entry.attachments[0].label,'photo.png');
});

test('journal keeps instructions, feeds the last runs back as memory and turns markdown links into telegram links',async t=>{
 const {store,jobs,post,requests}=await sqlFixture(t,({kind},index)=>kind==='text'?{text:index<=2?'Смотрите [сайт](https://example.com) сейчас':'Второй текст',sources:[]}:null);
 jobs.start(post.id,post.revision,{target:'text',instruction:'Добавь ссылку на сайт'});await settle(jobs);
 const first=store.get(post.id);
 assert.equal(first.text,'Смотрите сайт сейчас');assert.deepEqual(first.entities,[{type:'text_link',offset:9,length:4,url:'https://example.com'}]);
 jobs.start(post.id,first.revision,{target:'text',instruction:'Сократи'});await settle(jobs);
 assert.match(requests[2].prompt,/1\. .* · текст · инструкция: "Добавь ссылку на сайт" · итог: готово/);
 assert.doesNotMatch(requests[0].prompt,/Журнал этой карточки/);
 assert.deepEqual(store.get(post.id).agentLog.map(entry=>[entry.instruction,entry.status]),[['Добавь ссылку на сайт','completed'],['Сократи','completed']]);
});

test('an agent question is kept in the journal and the answer is sent together with it',async t=>{
 const {store,jobs,post,requests}=await sqlFixture(t,({kind},index)=>{
  if(index===1)throw Object.assign(new Error('Какой тариф упомянуть?'),{question:'Какой тариф упомянуть?'});
  return {text:'Текст с тарифом',sources:[]};
 });
 jobs.start(post.id,post.revision,{target:'text',instruction:'Добавь цену'});await settle(jobs);
 const asked=store.get(post.id),question=asked.agentLog.at(-1);
 assert.equal(question.status,'question');assert.equal(question.question,'Какой тариф упомянуть?');assert.equal(asked.job.status,'question');assert.equal(asked.status,'review');
 assert.throws(()=>jobs.start(post.id,asked.revision,{target:'text',instruction:'x',replyTo:'33333333-3333-4333-8333-333333333333'}),/не найден/);
 jobs.start(post.id,asked.revision,{target:'text',instruction:'Тариф Plus',replyTo:question.id});await settle(jobs);
 assert.match(requests[1].prompt,/В прошлом запуске ты спросил: «Какой тариф упомянуть\?»\. Ниже ответ пользователя\.\nИнструкция пользователя: Тариф Plus/);
 const answered=store.get(post.id).agentLog.at(-1);assert.equal(answered.replyTo,question.id);assert.equal(answered.status,'completed');
});

test('text jobs read pages without downloading pictures; scheduled cards refuse agent jobs',async t=>{
 const calls=[];
 const {store,jobs,post}=await sqlFixture(t,()=>({text:'Текст',sources:[]}),{scout:async(urls,options)=>{calls.push(options.limits);return {pages:urls.map(url=>({url,status:'error',error:'Сайт недоступен.'})),assets:[]};}});
 jobs.start(post.id,post.revision,{target:'text',instruction:'Посмотри example.org'});await settle(jobs);
 assert.deepEqual(calls,[{images:0}]);
 assert.equal(store.get(post.id).agentLog.at(-1).sites[0].status,'error');
 store.mutate(post.id,p=>{p.status='scheduled';p.schedule={status:'scheduled',at:'2030-01-01T00:00:00.000Z',revision:p.revision};});
 assert.throws(()=>jobs.start(post.id,store.get(post.id).revision,{target:'text'}),/запланирована/);
 assert.throws(()=>jobs.start(post.id,store.get(post.id).revision,{target:'image',mode:'edit'}),/текущая картинка/);
});

test('a post that asks at the picture step keeps its text; the answer runs only the picture; cancel ignores a moved revision',async t=>{
 let pending=null;
 const {store,jobs,post,requests}=await sqlFixture(t,({kind},index)=>{
  if(kind==='text')return {text:'Текст поста',sources:[]};
  if(index===3)throw Object.assign(new Error('Какой логотип взять?'),{question:'Какой логотип взять?'});
  return new Promise(resolve=>{pending=resolve;});
 },{text:''});
 jobs.start(post.id,post.revision,{target:'post',instruction:'Пост с картинкой'});await settle(jobs);
 const asked=store.get(post.id),entry=asked.agentLog.at(-1);
 assert.equal(asked.text,'Текст поста');assert.equal(entry.status,'question');assert.equal(entry.step,'image');assert.deepEqual(Object.keys(entry.results),['text']);
 jobs.start(post.id,asked.revision,{target:'image',mode:'new',instruction:'Возьми синий',replyTo:entry.id});
 for(let i=0;i<20&&!pending;i++)await pause();
 assert.deepEqual(requests.map(r=>r.kind),['text','text','image','image']);
 store.save(post.id,{text:'Правка во время картинки'},store.get(post.id).revision);
 const stopped=jobs.cancel(post.id,asked.revision);
 assert.equal(stopped.agentLog.at(-1).status,'cancelled');assert.equal(jobs.active.size,0);
});
