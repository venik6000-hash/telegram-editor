import {existsSync,readFileSync,mkdirSync} from 'node:fs';
import {dirname} from 'node:path';
import {atomicJson} from './store.mjs';
import {normalizeRoutes,fail,TOPICS} from './domain.mjs';
import {telegramCall} from './telegram.mjs';

const CHAT_ID=/^-100\d+$/;
const USERNAME=/^[A-Za-z0-9_]{5,32}$/;

function routeVersion(value) { return Number.isSafeInteger(value)&&value>0?value:1; }

/** Normalize a user-entered public channel target to the API form. */
export function normalizeChannelTarget(value) {
  const input=String(value??'').trim();
  if(CHAT_ID.test(input))return {chatId:input,chatUsername:''};
  const match=input.match(/^https:\/\/t\.me\/([A-Za-z0-9_]{5,32})\/?(?:\?.*)?$/i) || input.match(/^@([A-Za-z0-9_]{5,32})$/);
  if(!match||!USERNAME.test(match[1]))fail('Укажите @username или ссылку https://t.me/username публичного канала.');
  return {chatId:`@${match[1]}`,chatUsername:match[1]};
}

export function normalizeForumTarget(value) {
  const input=String(value??'').trim();
  if(!CHAT_ID.test(input))fail('ID группы должен начинаться с -100. Для форума нужен числовой ID.');
  return {chatId:input,chatUsername:''};
}

function targetFor(settings) {
  // Once Telegram has resolved a target, prefer the canonical numeric ID.
  // This prevents a stale or changed public username from redirecting verify
  // to a different channel. Initial username based settings still use @name.
  if(CHAT_ID.test(String(settings.chatId||'')))return settings.chatId;
  return settings.destinationType==='channel'&&settings.chatUsername?`@${settings.chatUsername}`:settings.chatId;
}

function validateTopicInput(value,topics) {
  if(value===undefined)return;
  if(!value||typeof value!=='object'||Array.isArray(value))fail('Маршруты тем должны быть объектом.');
  const known=new Set(topics.map(topic=>topic.id));
  if(Object.keys(value).some(key=>!known.has(key)))fail('Неизвестная тема проекта.');
}

function numericChatId(value) {
  const id=String(value??'');
  if(!CHAT_ID.test(id))fail('Telegram вернул некорректный числовой ID чата.');
  return id;
}

function validateBot(bot) {
  if(!bot||!Number.isSafeInteger(bot.id)||bot.id<=0)fail('Telegram вернул некорректные данные бота.');
  if(bot.is_bot!==undefined&&bot.is_bot!==true)fail('Telegram вернул некорректные данные бота.');
  return bot;
}

function validateChat(chat,destinationType) {
  if(!chat||typeof chat.type!=='string')fail('Telegram вернул неполные данные чата.');
  const id=numericChatId(chat.id);
  if(destinationType==='channel') {
    if(chat.type!=='channel')fail('Нужен Telegram-канал.');
    if(chat.username!==undefined&&chat.username!==null&&!USERNAME.test(String(chat.username)))
      fail('Telegram вернул некорректное имя канала.');
  } else if(chat.type!=='supergroup'||!chat.is_forum) {
    fail('Нужна Telegram-группа с включёнными темами.');
  }
  return {id,username:destinationType==='channel'?String(chat.username||''):''};
}

export class Settings {
 constructor(path,getTopics=()=>TOPICS,transport=telegramCall){
  this.path=path;this.getTopics=getTopics;this.transport=transport;
  mkdirSync(dirname(path),{recursive:true,mode:0o700});
 }
 read(){
  if(!existsSync(this.path))return {token:'',chatId:'',chatUsername:'',destinationType:'forum',topics:normalizeRoutes('',{},this.getTopics()),verified:false,botName:'',routeVersion:1};
  const raw=JSON.parse(readFileSync(this.path,'utf8'));
  const candidate=typeof raw.chatUsername==='string'?raw.chatUsername.replace(/^@/,''):'';
  const chatUsername=USERNAME.test(candidate)?candidate:'';
  return {...raw,chatUsername,routeVersion:routeVersion(raw.routeVersion)};
 }
 public(){const {token,...rest}=this.read();return {...rest,tokenConfigured:Boolean(token)};}
 save(input={}){
  const current=this.read();
  const destinationType=input.destinationType||current.destinationType||'forum';
  if(!['forum','channel'].includes(destinationType))fail('Выберите канал или группу с темами.');
  const rawTarget=input.chatId===undefined?current.chatId:input.chatId;
  const target=destinationType==='channel'?normalizeChannelTarget(rawTarget):normalizeForumTarget(rawTarget);
  const suppliedToken=input.token===undefined||input.token===null?'':String(input.token).trim();
  const token=suppliedToken||current.token;
  if(token&&!/^\d+:[A-Za-z0-9_-]{20,}$/.test(token))fail('Проверьте токен бота из BotFather.');
  const topics=this.getTopics();
  validateTopicInput(input.topics,topics);
  let routeInput={};
  if(destinationType!=='channel')routeInput=input.topics===undefined?current.topics:input.topics;
  const routes=normalizeRoutes(destinationType==='channel'?'':target.chatId,routeInput,topics);
  const next={token,chatId:target.chatId,chatUsername:target.chatUsername,destinationType,topics:routes,verified:false,botName:'',routeVersion:current.routeVersion+1};
  atomicJson(this.path,next);return this.public();
 }
 async verify(){
  const snapshot=this.read();
  if(!snapshot.token||!snapshot.chatId)fail('Введите токен и адрес чата.');
  const bot=validateBot(await this.transport(snapshot.token,'getMe',{}));
  const chat=validateChat(await this.transport(snapshot.token,'getChat',{chat_id:targetFor(snapshot)}),snapshot.destinationType);
  const member=await this.transport(snapshot.token,'getChatMember',{chat_id:chat.id,user_id:bot.id});
  if(!member||!['administrator','creator'].includes(member.status))fail('Добавьте бота администратором для отправки в Telegram.');
  if(member.can_post_messages!==undefined&&typeof member.can_post_messages!=='boolean')fail('Telegram вернул некорректные права бота.');
  if(snapshot.destinationType==='channel'&&member.status!=='creator'&&member.can_post_messages!==true)
    fail('Дайте боту право публикации в канале.');
  const current=this.read();
  if(current.routeVersion!==snapshot.routeVersion)fail('Настройки изменились во время проверки. Повторите.',409);
  const username=snapshot.destinationType==='channel'?chat.username:'';
  const targetWasUsername=snapshot.destinationType==='channel'&&!CHAT_ID.test(String(snapshot.chatId||''));
  if(targetWasUsername&&!username)fail('Telegram не вернул публичное имя канала.');
  const next={...snapshot,chatId:chat.id,chatUsername:username,verified:true,botName:bot.username||bot.first_name||'',routeVersion:snapshot.routeVersion+1};
  atomicJson(this.path,next);return this.public();
 }
}
