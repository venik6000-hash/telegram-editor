import {mkdirSync,readFileSync,writeFileSync,renameSync,existsSync,readdirSync,openSync,fsyncSync,closeSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {assertEditable,fail,topicName} from './domain.mjs';

export function atomicJson(path,value) {
 const temp=`${path}.${randomUUID()}.tmp`;
 writeFileSync(temp,JSON.stringify(value,null,2)+'\n',{mode:0o600});
 const fd=openSync(temp,'r'); try {fsyncSync(fd);} finally {closeSync(fd);}
 renameSync(temp,path);
}
export function snapshot(p) {
 return {revision:p.revision,title:p.title,brief:p.brief,text:p.text,image:p.image,sources:p.sources,savedAt:p.updatedAt};
}
export class Store {
 constructor(dir,seed=[],{reservedIds=()=>[]}={}) {
  this.dir=dir;this.reservedIds=reservedIds; mkdirSync(dir,{recursive:true,mode:0o700});
  for(const row of seed) if(!existsSync(this.path(row.id))) this.create(row,row.id);
 }
 path(id) {if(!/^POST-\d{3,}(?:-[a-f0-9]{8})?$/.test(id)) fail('Карточка не найдена.',404);return join(this.dir,`${id}.json`);}
 get(id) {try{return JSON.parse(readFileSync(this.path(id),'utf8'));}catch(e){if(e.code==='ENOENT')fail('Карточка не найдена.',404);throw e;}}
 list() {return readdirSync(this.dir).filter(f=>/^POST-.*\.json$/.test(f)).map(f=>this.get(f.slice(0,-5))).sort((a,b)=>a.id.localeCompare(b.id,undefined,{numeric:true}));}
 create(data,id) {
  if(!topicName(data.topic)) fail('Неизвестная тема.');
  const title=String(data.title||'').trim(); if(!title || title.length>240) fail('Название: от 1 до 240 символов.');
  if(!id) {const max=Math.max(0,...[...this.list().map(p=>p.id),...this.reservedIds()].map(id=>Number(id.split('-')[1])||0));id=`POST-${String(max+1).padStart(3,'0')}`;}
  if(existsSync(this.path(id))) fail('ID уже занят.',409);
  const p={id,topic:data.topic,title,brief:String(data.brief||''),text:'',sources:[],image:null,status:'idea',revision:1,history:[],job:null,publication:null,updatedAt:new Date().toISOString()};
  if(data.ideaOrigin)p.ideaOrigin=data.ideaOrigin;
  atomicJson(this.path(id),p);return p;
 }
 mutate(id,fn) {const p=this.get(id);fn(p);p.updatedAt=new Date().toISOString();atomicJson(this.path(id),p);return p;}
 save(id,patch,expectedRevision) {
  for(const key of Object.keys(patch)) if(!['title','brief','text'].includes(key)) fail('Недопустимое поле карточки.');
  return this.change(id,expectedRevision,p=>{
   for(const [key,value] of Object.entries(patch)) {
    if(typeof value!=='string'||value.length>(key==='title'?240:24000)) fail('Некорректная длина текста.');
    if(key==='title'&&!value.trim())fail('Введите название.');p[key]=value;
   }
  });
 }
 change(id,revision,fn) {return this.mutate(id,p=>{assertEditable(p,revision);p.history.push(snapshot(p));fn(p);p.revision++;p.status=p.text.trim()?'review':'idea';});}
 restore(id,revision,restoreRevision) {return this.change(id,revision,p=>{
  const old=p.history.find(h=>h.revision===restoreRevision);if(!old)fail('Версия не найдена.',404);
  for(const key of ['title','brief','text','image','sources'])p[key]=old[key];
 });}
 trash(items) {
  if(!Array.isArray(items)||!items.length||items.length>500||new Set(items.map(i=>i?.id)).size!==items.length)fail('Выберите от 1 до 500 разных карточек.');
  for(const item of items)assertEditable(this.get(item.id),item.revision);
  return items.map(item=>this.change(item.id,item.revision,p=>{p.deletedAt=new Date().toISOString();}));
 }
 untrash(id,revision) {
  const p=this.get(id);if(!p.deletedAt||p.revision!==revision)fail('Корзина изменилась. Обновите список.',409);
  return this.mutate(id,d=>{d.deletedAt=null;d.revision++;});
 }
 recover() {for(const p of this.list()) {
  if(p.status==='working')this.mutate(p.id,d=>{d.status=d.text?'review':'idea';if(d.job){d.job.status='failed';d.job.error='Приложение закрылось во время подготовки. Запустите задачу ещё раз.';}});
  if(p.status==='publishing')this.mutate(p.id,d=>{d.status='uncertain';d.publication.status='uncertain';d.publication.error='Приложение закрылось во время отправки. Проверьте сообщения в Telegram.';});
 }}
}
