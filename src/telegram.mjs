import {readFileSync} from 'node:fs';
import {partsFor,publicationIssues,assertEditable,fail} from './domain.mjs';

function publicUsername(value) {
 const username=String(value||'').replace(/^@/,'');
 return /^[A-Za-z0-9_]{5,32}$/.test(username)?username:'';
}

export function telegramMessageUrl(destination,messageId) {
 const id=Number(messageId);
 if(!Number.isSafeInteger(id)||id<=0)fail('Telegram не вернул корректный номер сообщения.');
 const username=destination.destinationType==='channel'&&publicUsername(destination.chatUsername);
 if(username)return `https://t.me/${username}/${id}`;
 const chatId=String(destination.chatId||'');
 if(/^-100\d+$/.test(chatId))return `https://t.me/c/${chatId.slice(4)}/${id}`;
 return '';
}

function validateMessage(result,destination) {
 if(!Number.isSafeInteger(result?.message_id)||result.message_id<=0)
   fail('Telegram не вернул номер сообщения.');
 if(result.chat?.id===undefined)
   fail('Telegram не вернул чат сообщения.');
 if(String(result.chat.id)!==String(destination.chatId))
   fail('Telegram вернул сообщение из другого чата.');
 return result;
}

export async function telegramCall(token,method,body,photoPath) {
 let payload,headers;
 if(photoPath) {
  payload=new FormData();
  for(const [key,value] of Object.entries(body))payload.append(key,typeof value==='object'?JSON.stringify(value):String(value));
  payload.append('photo',new Blob([readFileSync(photoPath)]),photoPath.split('/').pop());
 } else {payload=JSON.stringify(body);headers={'Content-Type':'application/json'};}
 // Telegram does not provide an idempotency key. Never retry this request automatically.
 const response=await fetch(`https://api.telegram.org/bot${token}/${method}`,{method:'POST',headers,body:payload,signal:AbortSignal.timeout(45000)});
 let data;try{data=await response.json();}catch{throw new Error('Telegram вернул неопределённый результат.');}
 if(!data.ok)throw Object.assign(new Error(`Telegram отклонил запрос (${data.error_code||response.status}). Проверьте права бота и тему.`),{definite:true});
 return data.result;
}
export class Publisher {
 constructor(store,getSettings,transport=telegramCall,resolveImage=()=>{throw new Error('Изображение не найдено.');}) {
  this.store=store;this.getSettings=getSettings;this.transport=transport;this.resolveImage=resolveImage;
 }
 async publish(id,revision,routeVersion) {
  const settings=this.getSettings();const p=this.store.get(id);
  assertEditable(p,revision);
  if(settings.routeVersion!==routeVersion)fail('Изменились настройки адресата. Обновите предпросмотр.',409);
  const issues=publicationIssues(p,settings);if(issues.length)fail(issues.join(' '));
  const parts=partsFor(p);const photoPath=p.image?this.resolveImage(p.image):null;
  const destination=settings.destinationType==='channel'
   ? {chatId:String(settings.chatId),chatUsername:publicUsername(settings.chatUsername),destinationType:'channel',threadId:null}
   : {chatId:String(settings.chatId),threadId:Number(settings.topics[p.topic])};
  this.store.mutate(id,d=>{d.status='publishing';d.publication={status:'sending',revision,routeVersion,destination,parts,messages:[],startedAt:new Date().toISOString(),error:null};});
  try {
   for(const part of parts) {
    const method=part.type==='photo'?'sendPhoto':'sendMessage';
    const body={chat_id:destination.chatId};
    if(destination.threadId)body.message_thread_id=destination.threadId;
    if(part.type==='photo')body.caption=part.caption;else body.text=part.text;
    if(part.entities?.length)body[part.type==='photo'?'caption_entities':'entities']=part.entities;
    const result=await this.transport(settings.token,method,body,part.type==='photo'?photoPath:null);
    validateMessage(result,destination);
    const message={id:result.message_id,url:telegramMessageUrl(destination,result.message_id)};
    this.store.mutate(id,d=>d.publication.messages.push(message));
   }
   return this.store.mutate(id,d=>{d.status='published';d.publication.status='published';d.publication.finishedAt=new Date().toISOString();});
  }catch(error) {
   return this.store.mutate(id,d=>{
    const safeRetry=error.definite&&d.publication.messages.length===0;
    d.status=safeRetry?'review':'uncertain';d.publication.status=safeRetry?'failed':'uncertain';
    d.publication.error=safeRetry?error.message:'Результат отправки требует сверки в Telegram. Автоматический повтор отключён.';
   });
  }
 }
 reconcile(id,revision,messageIds) {
  const p=this.store.get(id);
  if(p.revision!==revision||p.status!=='uncertain')fail('Сверка доступна только для неопределённой отправки.',409);
  if(!Array.isArray(messageIds)||messageIds.length!==p.publication.parts.length||messageIds.some(n=>!Number.isSafeInteger(n)||n<=0)||new Set(messageIds).size!==messageIds.length)fail('Укажите ID всех фактически опубликованных частей без повторов.');
  return this.store.mutate(id,d=>{d.status='published';d.publication.status='published';d.publication.manuallyConfirmedAt=new Date().toISOString();d.publication.error=null;d.publication.messages=messageIds.map(n=>({id:n,url:telegramMessageUrl(d.publication.destination,n)}));});
 }
}
