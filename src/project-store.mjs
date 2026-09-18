import {chmodSync,copyFileSync,existsSync,mkdirSync,readdirSync,readFileSync,writeFileSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {assertEditable,fail,validateEntities} from './domain.mjs';

const POST_ID=/^POST-\d{3,}(?:-[a-f0-9]{8})?$/;
const now=()=>new Date().toISOString();
const contentSignature=post=>JSON.stringify([post.topic,post.title,post.brief,post.text,post.entities,post.image,post.sources]);
export const snapshot=post=>({
  revision:post.revision,topic:post.topic,title:post.title,brief:post.brief,text:post.text,entities:post.entities||[],image:post.image,
  sources:post.sources,assignedTo:post.assignedTo??null,dueAt:post.dueAt??null,savedAt:post.updatedAt,
});

export class ProjectStore {
  constructor(database,projectId,{reservedIds=()=>[]}={}) {
    this.database=database;this.db=database.db;this.projectId=projectId;this.reservedIds=reservedIds;
    this.transactionDepth=0;
    if(!database.getProject(projectId))fail('Проект не найден.',404);
  }

  path(id) { this.#validateId(id);return `/?project=${encodeURIComponent(this.projectId)}&post=${encodeURIComponent(id)}`; }
  #validateId(id) {if(!POST_ID.test(id))fail('Карточка не найдена.',404);}
  #topic(id) {return this.database.getProject(this.projectId).topics.some(topic=>topic.id===id);}
  topicName(id) {return this.database.getProject(this.projectId).topics.find(topic=>topic.id===id)?.name||'';}
  #write(post) {this.db.prepare(`INSERT INTO posts(project_id,id,data) VALUES (?,?,?)
    ON CONFLICT(project_id,id) DO UPDATE SET data=excluded.data`).run(this.projectId,post.id,JSON.stringify(post));return post;}

  get(id) {
    this.#validateId(id);
    const row=this.db.prepare('SELECT data FROM posts WHERE project_id=? AND id=?').get(this.projectId,id);
    if(!row)fail('Карточка не найдена.',404);
    return JSON.parse(row.data);
  }

  list() {
    return this.db.prepare('SELECT data FROM posts WHERE project_id=?').all(this.projectId)
      .map(row=>JSON.parse(row.data)).sort((a,b)=>a.id.localeCompare(b.id,undefined,{numeric:true}));
  }

  create(data,id) {
    if(!this.#topic(data.topic))fail('Неизвестная тема.');
    const title=String(data.title||'').trim();if(!title||title.length>240)fail('Название: от 1 до 240 символов.');
    if(!id) {
      const ids=[...this.list().map(post=>post.id),...this.reservedIds()];
      const max=Math.max(0,...ids.map(value=>Number(value.split('-')[1])||0));
      id=`POST-${String(max+1).padStart(3,'0')}`;
    }
    this.#validateId(id);
    const post={id,projectId:this.projectId,topic:data.topic,title,brief:String(data.brief||''),text:'',sources:[],image:null,
      status:'idea',revision:1,history:[],job:null,publication:null,updatedAt:now()};
    if(data.ideaOrigin)post.ideaOrigin=data.ideaOrigin;
    return this.transaction(()=>{
      if(this.db.prepare('SELECT 1 FROM posts WHERE project_id=? AND id=?').get(this.projectId,id))fail('ID уже занят.',409);
      this.db.prepare('INSERT INTO posts(project_id,id,data) VALUES (?,?,?)').run(this.projectId,id,JSON.stringify(post));
      return post;
    });
  }

  mutate(id,fn) {
    return this.transaction(()=>{
      const post=this.get(id),before=contentSignature(post),oldText=post.text,oldEntities=post.entities;fn(post);
      if(post.text!==oldText&&post.entities===oldEntities)post.entities=[];
      if(contentSignature(post)!==before)this.#invalidateApproval(post);
      post.updatedAt=now();return this.#write(post);
    });
  }

  save(id,patch,expectedRevision) {
    const allowed=['title','brief','text','entities','topic','assignedTo','dueAt'];
    for(const key of Object.keys(patch))if(!allowed.includes(key))fail('Недопустимое поле карточки.');
    return this.change(id,expectedRevision,post=>{
      for(const [key,value] of Object.entries(patch)) {
        if(key==='entities')continue;
        if(key==='assignedTo'&&value===null){post.assignedTo=null;continue;}
        if(key==='topic') {if(typeof value!=='string'||!this.#topic(value))fail('Неизвестная тема.');post.topic=value;continue;}
        if(key==='dueAt') {if(value!==null&&(typeof value!=='string'||!Number.isFinite(Date.parse(value))))fail('Некорректный срок.');post.dueAt=value;continue;}
        if(typeof value!=='string'||value.length>(key==='title'?240:24000))fail('Некорректная длина текста.');
        if(key==='title'&&!value.trim())fail('Введите название.');post[key]=value;
      }
      if(Object.hasOwn(patch,'entities'))post.entities=validateEntities(post.text,patch.entities);
      else if(Object.hasOwn(patch,'text'))post.entities=[];
    });
  }

  #invalidateApproval(post) {post.approval=null;post.schedule=null;}
  change(id,revision,fn) {
    return this.mutate(id,post=>{assertEditable(post,revision);post.history.push(snapshot(post));fn(post);post.revision++;
      post.status=post.text.trim()?'review':'idea';this.#invalidateApproval(post);});
  }
  restore(id,revision,restoreRevision) {return this.change(id,revision,post=>{
    const old=post.history.find(item=>item.revision===restoreRevision);if(!old)fail('Версия не найдена.',404);
    post.entities=old.entities||[];
    for(const key of ['topic','title','brief','text','image','sources','assignedTo','dueAt'])if(Object.hasOwn(old,key))post[key]=old[key];
  });}

  trash(items) {
    if(!Array.isArray(items)||!items.length||items.length>500||new Set(items.map(item=>item?.id)).size!==items.length)fail('Выберите от 1 до 500 разных карточек.');
    return this.transaction(()=>{for(const item of items)assertEditable(this.get(item.id),item.revision);
      return items.map(item=>this.change(item.id,item.revision,post=>{post.deletedAt=now();}));});
  }
  untrash(id,revision) {const post=this.get(id);if(!post.deletedAt||post.revision!==revision)fail('Корзина изменилась. Обновите список.',409);
    return this.mutate(id,value=>{value.deletedAt=null;value.revision++;});}

  transaction(fn) {
    const outer=this.transactionDepth===0,savepoint=`editor_${this.transactionDepth}`;
    this.db.exec(outer?'BEGIN IMMEDIATE':`SAVEPOINT ${savepoint}`);this.transactionDepth++;
    try {
      const result=fn();this.transactionDepth--;
      this.db.exec(outer?'COMMIT':`RELEASE ${savepoint}`);return result;
    } catch(error) {
      this.transactionDepth--;
      this.db.exec(outer?'ROLLBACK':`ROLLBACK TO ${savepoint}`);
      if(!outer)this.db.exec(`RELEASE ${savepoint}`);
      throw error;
    }
  }

  importLegacy(dir,seed=[]) {
    const marker=`legacy-import:${this.projectId}`;
    if(this.database.getDocument('migrations',marker))return {imported:0,backupPath:null,legacyBackupPath:null};
    const backupPath=`${this.database.path}.pre-legacy-${this.projectId}-${randomUUID()}.sqlite`;
    this.database.backup(backupPath);
    const files=existsSync(dir)?readdirSync(dir).filter(name=>POST_ID.test(name.slice(0,-5))&&name.endsWith('.json')):[];
    const legacyBackupPath=join(dirname(this.database.path),'migration-backups',`${this.projectId}-${randomUUID()}`);
    mkdirSync(legacyBackupPath,{recursive:true,mode:0o700});
    for(const name of files) {const target=join(legacyBackupPath,name);copyFileSync(join(dir,name),target);chmodSync(target,0o600);}
    const seedPath=join(legacyBackupPath,'seed.json');writeFileSync(seedPath,JSON.stringify(seed,null,2)+'\n',{mode:0o600});
    return this.transaction(()=>{
      let imported=0;
      for(const name of files) {
        const post=JSON.parse(readFileSync(join(dir,name),'utf8'));const id=name.slice(0,-5);
        if(post.id!==id)fail(`ID карточки ${post.id||'не указан'} не совпадает с именем файла ${id}.`);
        if(!this.#topic(post.topic))fail('Неизвестная тема.');
        const exists=this.db.prepare('SELECT 1 FROM posts WHERE project_id=? AND id=?').get(this.projectId,post.id);
        if(!exists){this.#write({...post,projectId:this.projectId});imported++;}
      }
      for(const row of seed) {
        const exists=this.db.prepare('SELECT 1 FROM posts WHERE project_id=? AND id=?').get(this.projectId,row.id);
        if(!exists){this.create(row,row.id);imported++;}
      }
      this.database.setDocument('migrations',marker,{at:now(),source:dir});
      return {imported,backupPath,legacyBackupPath};
    });
  }

  recover() {for(const post of this.list()) {
    if(post.status==='working')this.mutate(post.id,value=>{
      const error='Приложение закрылось во время подготовки. Запустите задачу ещё раз.';
      value.status=value.text||value.image?'review':'idea';value.approval=null;value.schedule=null;
      if(value.job){
        if(value.job.tasks)for(const task of Object.values(value.job.tasks))if(['queued','running'].includes(task.status)){task.status='failed';task.phase='Прервано после перезапуска';task.error=error;}
        value.job.status='failed';value.job.phase='Нужна ваша проверка';value.job.error=error;value.job.finishedAt=now();
      }
    });
    if(post.status==='publishing')this.mutate(post.id,value=>{value.status='uncertain';value.publication.status='uncertain';value.publication.error='Приложение закрылось во время отправки. Проверьте сообщения в Telegram.';});
  }}
}
