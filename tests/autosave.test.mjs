import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {EditorDatabase} from '../src/database.mjs';
import {ProjectStore} from '../src/project-store.mjs';

function fixture(t){const database=new EditorDatabase(join(mkdtempSync(join(tmpdir(),'editor-autosave-')),'editor.sqlite'));t.after(()=>database.close());const store=new ProjectStore(database,'default');return {store,post:store.create({topic:'main',title:'Автосохранение'},'POST-300')};}
const SESSION='11111111-1111-4111-8111-111111111111';

test('autosave in one session keeps one history version and skips no-op saves',t=>{
 const {store,post}=fixture(t);
 let current=store.save(post.id,{text:'Раз'},post.revision,{session:SESSION});
 current=store.save(post.id,{text:'Раз два'},current.revision,{session:SESSION});
 current=store.save(post.id,{title:'Автосохранение 2'},current.revision,{session:SESSION});
 assert.equal(current.revision,4);assert.equal(current.history.length,1);assert.deepEqual(current.lastChange.fields,['text','title']);
 assert.equal(store.save(post.id,{text:'Раз два'},current.revision,{session:SESSION}).revision,4);
 assert.throws(()=>store.save(post.id,{text:'Старое'},2,{session:SESSION}),/Версия изменилась/);
});
test('a text save based on a revision before an image-only change is applied on top',t=>{
 const {store,post}=fixture(t);
 const typed=store.save(post.id,{text:'Черновик'},post.revision,{session:SESSION});
 const withImage=store.setImage(post.id,typed.revision,{name:'POST-300-aaaaaaaa.png',url:'/media/x'},{origin:'upload'});
 const saved=store.save(post.id,{text:'Черновик дописан'},typed.revision,{session:SESSION});
 assert.equal(saved.text,'Черновик дописан');assert.equal(saved.image.name,'POST-300-aaaaaaaa.png');assert.equal(saved.revision,withImage.revision+1);
});
test('variants can be selected without touching text, and restore can bring back only text',t=>{
 const {store,post}=fixture(t);
 let current=store.save(post.id,{text:'Первый текст'},post.revision);
 current=store.setImage(post.id,current.revision,{name:'POST-300-11111111.png',url:'/media/1'},{origin:'upload'});
 const firstTextRevision=current.revision;
 current=store.setImage(post.id,current.revision,{name:'POST-300-22222222.png',url:'/media/2'},{origin:'upload'});
 current=store.save(post.id,{text:'Второй текст'},current.revision);
 current=store.selectVariant(post.id,current.revision,'POST-300-11111111.png');
 assert.equal(current.text,'Второй текст');assert.equal(current.image.name,'POST-300-11111111.png');assert.equal(current.lastChange.origin,'variant');
 assert.deepEqual(current.imageVariants.map(v=>v.name),['POST-300-11111111.png','POST-300-22222222.png']);
 assert.throws(()=>store.selectVariant(post.id,current.revision,'POST-300-99999999.png'),/не найден/);
 current=store.restore(post.id,current.revision,firstTextRevision,['text']);
 assert.equal(current.text,'Первый текст');assert.equal(current.image.name,'POST-300-11111111.png');
});
test('scheduled cards and cards with a running image job reject the guarded changes',t=>{
 const {store,post}=fixture(t);
 const typed=store.save(post.id,{text:'Текст'},post.revision);
 store.mutate(post.id,p=>{p.status='scheduled';p.schedule={status:'scheduled',at:'2030-01-01T00:00:00.000Z',revision:p.revision};});
 assert.throws(()=>store.save(post.id,{text:'Правка'},typed.revision),/запланирована/);
 store.mutate(post.id,p=>{p.status='review';p.schedule=null;p.job={id:'job',kind:'image',status:'running'};});
 assert.doesNotThrow(()=>store.save(post.id,{text:'Правка во время картинки'},typed.revision));
 const latest=store.get(post.id);
 assert.throws(()=>store.setImage(post.id,latest.revision,null,{origin:'manual'}),/рисует/);
 assert.throws(()=>store.restore(post.id,latest.revision,1),/рисует/);
});
test('markdown links are converted in place',t=>{
 const {store,post}=fixture(t);
 const typed=store.save(post.id,{text:'См. [сайт](https://x.example)'},post.revision);
 const converted=store.convertLinks(post.id,typed.revision);
 assert.equal(converted.text,'См. сайт');assert.deepEqual(converted.entities,[{type:'text_link',offset:4,length:4,url:'https://x.example'}]);
 assert.equal(converted.lastChange.origin,'links');
 assert.throws(()=>store.convertLinks(post.id,converted.revision),/нет/);
});
test('recovery closes an interrupted image job that did not lock the card',t=>{
 const {store,post}=fixture(t);
 store.mutate(post.id,p=>{p.text='Текст';p.status='review';p.job={id:'job-1',kind:'image',status:'running',phase:'Создаёт'};p.agentLog=[{id:'job-1',status:'running'}];});
 store.recover();
 const recovered=store.get(post.id);
 assert.equal(recovered.job.status,'failed');assert.equal(recovered.agentLog[0].status,'failed');assert.equal(recovered.status,'review');
});
