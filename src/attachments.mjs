import {mkdirSync,readFileSync,writeFileSync,existsSync,statSync,readdirSync} from 'node:fs';
import {join,basename} from 'node:path';
import {randomUUID} from 'node:crypto';
import {fail} from './domain.mjs';
import {imageType} from './assets.mjs';

// Pictures a user attached for the agent, and site images the agent used. Private data folder, not the media library.
const NAME=/^([a-f0-9-]{36})\.(png|jpg|webp)$/;
const ID=/^[a-f0-9-]{36}$/;
const POST_ID=/^POST-\d{3,}(?:-[a-f0-9]{8})?$/;
const MAX_BYTES=8*1024*1024;

export class Attachments {
 constructor(dir,projectId=''){this.dir=dir;this.projectId=projectId;}
 #folder(postId){if(!POST_ID.test(postId))fail('Карточка не найдена.',404);return join(this.dir,postId);}
 url(postId,name){return `/api/posts/${postId}/attachments/${name}${this.projectId?'?project='+encodeURIComponent(this.projectId):''}`;}
 save(postId,data,{label='',source='upload',sourceUrl=''}={}){
  if(!Buffer.isBuffer(data)||!data.length)fail('Пустой файл.');
  if(data.length>MAX_BYTES)fail('Изображение должно быть меньше 8 МБ.');
  const ext=imageType(data),id=randomUUID(),name=`${id}.${ext}`,folder=this.#folder(postId);
  mkdirSync(folder,{recursive:true,mode:0o700});
  writeFileSync(join(folder,name),data,{flag:'wx',mode:0o600});
  const meta={label:String(label||'').slice(0,200),source,sourceUrl:String(sourceUrl||'').slice(0,2048),createdAt:new Date().toISOString()};
  writeFileSync(join(folder,`${id}.json`),JSON.stringify(meta),{mode:0o600});
  return this.#describe(postId,id,name,meta);
 }
 fromDataUrl(postId,dataUrl,label=''){
  if(typeof dataUrl!=='string'||!/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=\r\n]+$/.test(dataUrl))fail('Поддерживаются PNG, JPEG и WebP.');
  return this.save(postId,Buffer.from(dataUrl.slice(dataUrl.indexOf(',')+1),'base64'),{label,source:'upload'});
 }
 fromFile(postId,path,options={}){
  if(!existsSync(path)||!statSync(path).isFile())fail('Файл вложения не найден.');
  return this.save(postId,readFileSync(path),options);
 }
 resolve(postId,name){
  if(typeof name!=='string'||!NAME.test(name)||basename(name)!==name)fail('Вложение не найдено.',404);
  const path=join(this.#folder(postId),name);if(!existsSync(path))fail('Вложение не найдено.',404);
  return path;
 }
 byId(postId,id){
  if(typeof id!=='string'||!ID.test(id))fail('Вложение не найдено.',404);
  const folder=this.#folder(postId);
  const name=existsSync(folder)?readdirSync(folder).find(file=>NAME.test(file)&&file.startsWith(`${id}.`)):null;
  if(!name)fail('Вложение не найдено. Загрузите файл ещё раз.',404);
  let meta={};try{meta=JSON.parse(readFileSync(join(folder,`${id}.json`),'utf8'));}catch{}
  return {...this.#describe(postId,id,name,meta),path:join(folder,name)};
 }
 #describe(postId,id,name,meta){
  const result={id,name,url:this.url(postId,name),source:meta.source||'upload'};
  if(meta.label)result.label=meta.label;
  if(meta.sourceUrl)result.sourceUrl=meta.sourceUrl;
  return result;
 }
}
