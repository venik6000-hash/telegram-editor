import {DatabaseSync} from 'node:sqlite';
import {dirname} from 'node:path';
import {chmodSync,mkdirSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {fail} from './domain.mjs';

const localTimezone=()=>Intl.DateTimeFormat().resolvedOptions().timeZone||'UTC';
const now=()=>new Date().toISOString();

function validTimezone(value) {
  try { new Intl.DateTimeFormat('en',{timeZone:value}).format(); return true; }
  catch { return false; }
}

function projectInput(input,current=null) {
  const text=(key,fallback='',max=24000)=>{
    const value=input[key]===undefined?fallback:String(input[key]);
    if(value.length>max)fail(`${key}: слишком длинное значение.`);
    return value;
  };
  const topics=input.topics===undefined?(current?.topics||[{id:'main',name:'Главная'}]):input.topics;
  if(!Array.isArray(topics)||!topics.length)fail('Добавьте хотя бы одну тему.');
  if(topics.length>100)fail('В проекте может быть не больше 100 тем.');
  const normalized=topics.map(topic=>({id:String(topic?.id||'').trim(),name:String(topic?.name||'').trim()}));
  if(normalized.some(topic=>!projectIdValid(topic.id)||!topic.name||topic.name.length>120))fail('Некорректная тема.');
  if(new Set(normalized.map(topic=>topic.id)).size!==normalized.length)fail('ID тем не должны повторяться.');
  const timezone=text('timezone',current?.timezone||localTimezone(),120);
  if(!validTimezone(timezone))fail('Некорректный часовой пояс.');
  const color=text('color',current?.color||'#5965e8',40);
  if(!/^#[0-9a-f]{6}$/i.test(color))fail('Укажите цвет в формате #RRGGBB.');
  return {
    name:text('name',current?.name||'',160).trim(), audience:text('audience',current?.audience||''),
    language:text('language',current?.language||'ru',40).trim()||'ru', voice:text('voice',current?.voice||''),
    visualStyle:text('visualStyle',current?.visualStyle||''), examples:text('examples',current?.examples||''),
    instructions:text('instructions',current?.instructions||''), timezone,
    color, topics:normalized,
  };
}

function projectIdValid(id) { return /^[a-z0-9][a-z0-9_-]{0,63}$/.test(id); }

export class EditorDatabase {
  constructor(path) {
    this.path=path;
    mkdirSync(dirname(path),{recursive:true,mode:0o700});
    this.db=new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS posts (project_id TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL,
        PRIMARY KEY(project_id,id), FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE);
      CREATE TABLE IF NOT EXISTS documents (namespace TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL,
        PRIMARY KEY(namespace,key));`);
    chmodSync(path,0o600);
    if(!this.getProject('default'))this.#insertProject('default',{
      name:'Мой проект',audience:'',language:'ru',voice:'',visualStyle:'',examples:'',instructions:'',
      timezone:localTimezone(),color:'#5965e8',topics:[{id:'main',name:'Главная'}],
    });
  }

  #insertProject(id,input,metadata={}) {
    const timestamp=now();
    const project={id,...projectInput(input),...metadata,revision:1,createdAt:timestamp,updatedAt:timestamp};
    this.db.prepare('INSERT INTO projects(id,data) VALUES (?,?)').run(id,JSON.stringify(project));
    return project;
  }

  listProjects() {
    return this.db.prepare('SELECT data FROM projects ORDER BY id').all().map(row=>JSON.parse(row.data));
  }

  getProject(id) {
    const row=this.db.prepare('SELECT data FROM projects WHERE id=?').get(id);
    return row?JSON.parse(row.data):null;
  }

  createProject(input={}) {
    const id=String(input.id||randomUUID()).trim().toLowerCase();
    if(!projectIdValid(id))fail('Некорректный ID проекта.');
    if(!String(input.name||'').trim())fail('Введите название проекта.');
    try{return this.#insertProject(id,input);}catch(error){
      if(error.code==='ERR_SQLITE_ERROR'&&/UNIQUE constraint/.test(error.message))fail('ID проекта уже занят.',409);
      throw error;
    }
  }

  updateProject(id,input={}) {
    const current=this.getProject(id);if(!current)fail('Проект не найден.',404);
    if(input.revision!==current.revision)fail('Профиль проекта изменился. Обновите страницу.',409);
    const data=projectInput(input,current);
    if(!data.name)fail('Введите название проекта.');
    const removed=current.topics.filter(old=>!data.topics.some(topic=>topic.id===old.id));
    if(removed.length) {
      const rows=this.db.prepare('SELECT data FROM posts WHERE project_id=?').all(id);
      const used=new Set(rows.map(row=>JSON.parse(row.data).topic));
      if(removed.some(topic=>used.has(topic.id)))fail('Нельзя удалить тему: она используется в карточках.',409);
    }
    const project={...current,...data,revision:current.revision+1,updatedAt:now()};
    this.db.prepare('UPDATE projects SET data=? WHERE id=?').run(JSON.stringify(project),id);
    return project;
  }

  getDocument(namespace,key) {
    const row=this.db.prepare('SELECT value FROM documents WHERE namespace=? AND key=?').get(namespace,key);
    return row?JSON.parse(row.value):null;
  }

  setDocument(namespace,key,value) {
    const json=JSON.stringify(value);if(json===undefined)fail('Документ должен быть JSON-совместимым.');
    this.db.prepare(`INSERT INTO documents(namespace,key,value) VALUES (?,?,?)
      ON CONFLICT(namespace,key) DO UPDATE SET value=excluded.value`).run(namespace,key,json);
    return value;
  }

  listDocuments(namespace) {
    return this.db.prepare('SELECT key,value FROM documents WHERE namespace=? ORDER BY key').all(namespace)
      .map(row=>({key:row.key,value:JSON.parse(row.value)}));
  }

  backup(path) {
    const escaped=String(path).replaceAll("'","''");
    this.db.exec(`VACUUM INTO '${escaped}'`);
    chmodSync(path,0o600);
    return path;
  }

  close() { this.db.close(); }
}
