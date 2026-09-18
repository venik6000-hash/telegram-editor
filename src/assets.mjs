import {mkdirSync,readFileSync,writeFileSync,existsSync,appendFileSync,statSync,realpathSync} from 'node:fs';
import {join,basename} from 'node:path';
import {randomUUID} from 'node:crypto';
import {fail} from './domain.mjs';
export function imageType(data) {
 if(data.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return 'png';
 if(data[0]===255&&data[1]===216&&data[2]===255)return 'jpg';
 if(data.toString('ascii',0,4)==='RIFF'&&data.toString('ascii',8,12)==='WEBP')return 'webp';
 fail('Поддерживаются только настоящие PNG, JPEG и WebP.');
}
export class Assets {
 constructor(dir,projectId=''){this.dir=dir;this.projectId=projectId;mkdirSync(dir,{recursive:true});}
 save(data,postId){
  if(data.length>8*1024*1024)fail('Изображение должно быть меньше 8 МБ.');
  const ext=imageType(data),name=`${postId}-${randomUUID()}.${ext}`;
  writeFileSync(join(this.dir,name),data,{flag:'wx'});
  appendFileSync(join(this.dir,'Реестр_редакции.md'),`| ${name} | ${postId} | Черновик | ${new Date().toISOString()} |\n`);
  return {name,url:`/media/${name}${this.projectId?'?project='+encodeURIComponent(this.projectId):''}`};
 }
 fromDataUrl(dataUrl,postId){
  if(typeof dataUrl!=='string'||!/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=\r\n]+$/.test(dataUrl))fail('Неверный формат изображения.');
  return this.save(Buffer.from(dataUrl.slice(dataUrl.indexOf(',')+1),'base64'),postId);
 }
 fromFile(path,postId,jobDir,artifactRoot){
  if(typeof path!=='string'||!existsSync(path)||!statSync(path).isFile())fail('Агент не сохранил файл изображения.');
  // The native generator writes under its thread ID. artifactRoot comes from the CLI event, never the model JSON.
  const roots=[jobDir,artifactRoot].filter(root=>root&&existsSync(root)).map(root=>realpathSync(root)+'/');
  if(!roots.some(root=>realpathSync(path).startsWith(root)))fail('Изображение сохранено вне папки этого задания. Его можно прикрепить вручную.');
  if(statSync(path).size>8*1024*1024)fail('Изображение больше 8 МБ.');
  return this.save(readFileSync(path),postId);
 }
 resolve(image){const name=typeof image==='string'?image:image.name;if(!/^POST-\d{3,}-[a-f0-9-]+\.(png|jpg|webp)$/.test(name)||basename(name)!==name)fail('Изображение не найдено.',404);const path=join(this.dir,name);if(!existsSync(path))fail('Изображение не найдено.',404);return path;}
}
