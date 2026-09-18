import {createHash,randomBytes,randomUUID,scryptSync,timingSafeEqual} from 'node:crypto';
import {fail} from './domain.mjs';

const NAMESPACE='team';
const OWNER={id:'local-owner',name:'Local owner',role:'owner',projectIds:['*']};
const ROLES=new Set(['owner','editor','publisher']);
const ACTIONS={owner:new Set(['read','edit','publish','admin']),editor:new Set(['read','edit']),publisher:new Set(['read','edit','publish'])};
const normalizeName=name=>String(name||'').trim();
const tokenHash=token=>createHash('sha256').update(token).digest('hex');
const publicUser=({passwordHash,passwordSalt,authVersion,...user})=>user;

export class Team {
 constructor(db,{now=()=>Date.now(),sessionTtlMs=7*24*60*60*1000,maxAttempts=5,attemptWindowMs=15*60*1000}={}) {
  Object.assign(this,{db,now,sessionTtlMs,maxAttempts,attemptWindowMs});
 }

 status(){return {enabled:Boolean(this.db.getDocument(NAMESPACE,'enabled'))};}

 setup({name,password}) {
  if(this.status().enabled)fail('Команда уже настроена.',409);
  const user=this.buildUser({name,password,role:'owner',projectIds:['*']});
  return this.transaction(()=>{this.db.setDocument(NAMESPACE,`user:${user.id}`,user);this.db.setDocument(NAMESPACE,'enabled',true);return this.createSession(user);});
 }

 login({name,password}) {
  if(!this.status().enabled)fail('Сначала настройте команду.',409);
  name=normalizeName(name);password=String(password||'');
  if(!name||name.length>80)fail('Проверьте имя пользователя.');
  if(password.length>1024)fail('Пароль слишком длинный.');
  const key=name.toLocaleLowerCase('ru');
  const attempts=this.activeAttempts(key);
  if(attempts.length>=this.maxAttempts)fail('Слишком много попыток входа. Попробуйте позже.',429);
  const user=this.users().find(item=>!item.disabled&&item.name.toLocaleLowerCase('ru')===key);
  if(!user||!this.verifyPassword(password,user)) {
   attempts.push(this.now());this.db.setDocument(NAMESPACE,`attempts:${key}`,attempts);
   if(attempts.length>=this.maxAttempts)fail('Слишком много попыток входа. Попробуйте позже.',429);
   fail('Неверное имя или пароль.',401);
  }
  this.db.setDocument(NAMESPACE,`attempts:${key}`,[]);
  return this.createSession(user);
 }

 authenticate(cookieHeader) {
  if(!this.status().enabled)return {...OWNER};
  const token=this.cookieToken(cookieHeader);if(!token)return null;
  const hash=tokenHash(token),session=this.db.getDocument(NAMESPACE,`session:${hash}`);
  if(!session||session.expiresAt<=this.now())return null;
  const user=this.db.getDocument(NAMESPACE,`user:${session.userId}`);
  return user&&!user.disabled&&session.authVersion===(user.authVersion||1)?publicUser(user):null;
 }

 listUsers(){return this.users().map(publicUser);}

 createUser(input) {
  if(!this.status().enabled)fail('Сначала настройте команду.',409);
  const user=this.buildUser(input);
  if(this.users().some(item=>item.name.toLocaleLowerCase('ru')===user.name.toLocaleLowerCase('ru')))fail('Пользователь с таким именем уже существует.',409);
  this.db.setDocument(NAMESPACE,`user:${user.id}`,user);return publicUser(user);
 }

 updateUser(id,input={}) {
  const user=this.db.getDocument(NAMESPACE,`user:${id}`);if(!user)fail('Пользователь не найден.',404);
  const next={...user};
  if(input.name!==undefined) {
   const name=normalizeName(input.name);if(!name||name.length>80)fail('Укажите имя пользователя.');
   if(this.users().some(item=>item.id!==id&&item.name.toLocaleLowerCase('ru')===name.toLocaleLowerCase('ru')))fail('Пользователь с таким именем уже существует.',409);
   next.name=name;
  }
  if(input.role!==undefined) {if(!ROLES.has(input.role))fail('Неизвестная роль.');next.role=input.role;}
  if(input.projectIds!==undefined) {
   if(!Array.isArray(input.projectIds)||!input.projectIds.length||input.projectIds.some(projectId=>typeof projectId!=='string'||!projectId.trim()))fail('Укажите доступные проекты.');
   next.projectIds=[...new Set(input.projectIds)];
  }
  if(input.disabled!==undefined)next.disabled=Boolean(input.disabled);
  const wasGlobalOwner=user.role==='owner'&&!user.disabled&&user.projectIds.includes('*');
  const remainsGlobalOwner=next.role==='owner'&&!next.disabled&&next.projectIds.includes('*');
  if(wasGlobalOwner&&!remainsGlobalOwner&&this.enabledOwners().length===1)fail('Нельзя отключить или ограничить последнего глобального владельца.',409);
  if(input.password!==undefined) {
   const password=String(input.password);if(password.length<12||password.length>1024)fail('Пароль должен содержать не менее 12 символов.');
   next.passwordSalt=randomBytes(16).toString('hex');next.passwordHash=scryptSync(password,next.passwordSalt,64).toString('hex');next.authVersion=(user.authVersion||1)+1;
  } else if(!user.disabled&&next.disabled)next.authVersion=(user.authVersion||1)+1;
  next.updatedAt=new Date(this.now()).toISOString();
  this.db.setDocument(NAMESPACE,`user:${id}`,next);return publicUser(next);
 }

 logout(cookieHeader) {
  const token=this.cookieToken(cookieHeader);if(!token)return false;
  const key=`session:${tokenHash(token)}`;
  if(!this.db.getDocument(NAMESPACE,key))return false;
  this.db.setDocument(NAMESPACE,key,{revoked:true,expiresAt:0});return true;
 }

 assertAccess(user,projectId,action) {
  if(!user)fail('Требуется вход.',401);
  if(!user.projectIds.includes('*')&&!user.projectIds.includes(projectId))fail('Нет доступа к проекту.',403);
  if(!ACTIONS[user.role]?.has(action))fail('Недостаточно прав.',403);
  return true;
 }

 users(){return this.db.listDocuments(NAMESPACE).filter(row=>row.key.startsWith('user:')).map(row=>row.value);}

 enabledOwners(){return this.users().filter(user=>user.role==='owner'&&!user.disabled&&user.projectIds.includes('*'));}

 transaction(fn) {
  this.db.db.exec('BEGIN IMMEDIATE');
  try {const result=fn();this.db.db.exec('COMMIT');return result;}
  catch(error) {this.db.db.exec('ROLLBACK');throw error;}
 }

 buildUser({name,password,role,projectIds}) {
  name=normalizeName(name);password=String(password||'');
  if(name.length<1||name.length>80)fail('Укажите имя пользователя.');
  if(password.length<12||password.length>1024)fail('Пароль должен содержать не менее 12 символов.');
  if(!ROLES.has(role))fail('Неизвестная роль.');
  if(!Array.isArray(projectIds)||!projectIds.length||projectIds.some(id=>typeof id!=='string'||!id.trim()))fail('Укажите доступные проекты.');
  const passwordSalt=randomBytes(16).toString('hex');
  return {id:randomUUID(),name,role,projectIds:[...new Set(projectIds)],disabled:false,authVersion:1,passwordSalt,passwordHash:scryptSync(password,passwordSalt,64).toString('hex'),createdAt:new Date(this.now()).toISOString()};
 }

 verifyPassword(password,user) {
  const actual=scryptSync(String(password||''),user.passwordSalt,64),expected=Buffer.from(user.passwordHash,'hex');
  return actual.length===expected.length&&timingSafeEqual(actual,expected);
 }

 createSession(user) {
  const token=randomBytes(32).toString('base64url');
  this.db.setDocument(NAMESPACE,`session:${tokenHash(token)}`,{userId:user.id,authVersion:user.authVersion||1,createdAt:this.now(),expiresAt:this.now()+this.sessionTtlMs});
  return {user:publicUser(user),token};
 }

 activeAttempts(key) {
  const cutoff=this.now()-this.attemptWindowMs;
  return (this.db.getDocument(NAMESPACE,`attempts:${key}`)||[]).filter(at=>at>cutoff);
 }

 cookieToken(header) {
  for(const part of String(header||'').split(';')) {
   const [name,...value]=part.trim().split('=');
   if(name==='editor_session') {try{return decodeURIComponent(value.join('='));}catch{return '';}}
  }
  return '';
 }
}
