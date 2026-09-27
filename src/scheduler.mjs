import {assertEditable,fail,publicationIssues} from './domain.mjs';

const FIFTEEN_MINUTES=15*60*1000;

export class Scheduler {
 constructor({store,settings,publisher,registry,now=()=>Date.now()}) {
  Object.assign(this,{store,settings,publisher,registry,now});
  this.running=false;
 }

 currentSettings(){return typeof this.settings==='function'?this.settings():this.settings.read();}

 approve(id,revision,actor) {
  const post=this.store.get(id);assertEditable(post,revision);
  if(!String(post.text||'').trim())fail('Добавьте текст поста.');
  if(post.job?.status==='running')fail('Дождитесь завершения агента.',409);
  const approvedAt=new Date(this.now()).toISOString();
  return this.store.mutate(id,d=>{d.approval={revision,actor:String(actor||''),at:approvedAt};d.schedule=null;d.status='approved';});
 }

 schedule(id,revision,{at,routeVersion},actor) {
  const post=this.store.get(id);assertEditable(post,revision);
  if(post.approval?.revision!==revision)fail('Сначала одобрите текущую версию поста.',409);
  const timestamp=Date.parse(at);
  if(!Number.isFinite(timestamp)||timestamp<=this.now())fail('Укажите корректную будущую дату публикации.');
  const settings=this.currentSettings();
  if(settings.routeVersion!==routeVersion)fail('Изменились настройки адресата. Обновите предпросмотр.',409);
  const issues=publicationIssues(post,settings);if(issues.length)fail(issues.join(' '));
  const schedule={at:new Date(timestamp).toISOString(),routeVersion,revision,actor:String(actor||''),status:'scheduled'};
  return this.store.mutate(id,d=>{d.schedule=schedule;d.status='scheduled';});
 }

 cancel(id,revision) {
  const post=this.store.get(id);assertEditable(post,revision);
  if(post.status!=='scheduled')fail('У карточки нет активной публикации по расписанию.',409);
  return this.store.mutate(id,d=>{d.schedule={...d.schedule,status:'cancelled',cancelledAt:new Date(this.now()).toISOString()};d.status='approved';});
 }

 async tick() {
  if(this.running)return null;
  this.running=true;
  try {
   const posts=this.store.list();
   const recovered=posts.find(p=>p.status==='uncertain'&&p.schedule?.status==='scheduled');
   if(recovered)return this.mark(recovered.id,'uncertain','Результат отправки неизвестен. Автоматический повтор отключён.');
   const due=posts.filter(p=>p.status==='scheduled'&&p.schedule?.status==='scheduled'&&Date.parse(p.schedule.at)<=this.now()).sort((a,b)=>Date.parse(a.schedule.at)-Date.parse(b.schedule.at))[0];
   if(!due)return null;
   return await this.process(due);
  } finally {this.running=false;}
 }

 async process(post) {
  const current=this.store.get(post.id),schedule=current.schedule;
  if(this.now()-Date.parse(schedule.at)>FIFTEEN_MINUTES)return this.mark(current.id,'missed','Пропущено больше чем на 15 минут. Назначьте новое время.');
  const settings=this.currentSettings();
  if(current.revision!==schedule.revision||current.approval?.revision!==schedule.revision||settings.routeVersion!==schedule.routeVersion)return this.mark(current.id,'invalid','Версия поста или настройки адресата изменились.');
  const issues=publicationIssues(current,settings);
  if(issues.length)return this.mark(current.id,'invalid',issues.join(' '));
  try {
   await this.publisher.publish(current.id,current.revision,schedule.routeVersion);
   this.registry?.sync();
   const published=this.store.get(current.id);
   let scheduleStatus=published.status;
   if(published.publication?.status==='failed')scheduleStatus='failed';
   return this.store.mutate(current.id,d=>{d.schedule={...schedule,status:scheduleStatus,finishedAt:new Date(this.now()).toISOString()};});
  } catch(error) {
   const after=this.store.get(current.id),sending=after.status==='publishing'||after.publication?.status==='sending';
   return sending
    ?this.mark(current.id,'uncertain','Результат отправки неизвестен. Автоматический повтор отключён.',error)
    :this.mark(current.id,'invalid',String(error.message||error),error);
  }
 }

 mark(id,status,message,error) {
  return this.store.mutate(id,d=>{d.schedule={...d.schedule,status,error:message,finishedAt:new Date(this.now()).toISOString()};d.status=status==='missed'||status==='invalid'?'approved':'uncertain';if(error)d.schedule.detail=String(error.message||error);});
 }
}
