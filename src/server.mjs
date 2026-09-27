import http from 'node:http';
import {readFileSync,existsSync,mkdirSync,createReadStream} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname,join,resolve,extname,basename} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {fail,assertEditable,assertNotScheduled,assertImageFree,partsFor,publicationIssues,topicName} from './domain.mjs';
import {Settings} from './settings.mjs';
import {Assets} from './assets.mjs';
import {Attachments} from './attachments.mjs';
import {Jobs} from './jobs.mjs';
import {CodexRunner} from './codex.mjs';
import {Publisher} from './telegram.mjs';
import {acquireLock} from './lock.mjs';
import {Registry} from './registry.mjs';
import {Ideas} from './ideas.mjs';
import {EditorDatabase} from './database.mjs';
import {ProjectStore} from './project-store.mjs';
import {Scheduler} from './scheduler.mjs';
import {Team} from './team.mjs';
import {Backups} from './backups.mjs';

export const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const DEFAULT_DATA=join(ROOT,'data');
const MIME={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.png':'image/png','.jpg':'image/jpeg','.webp':'image/webp'};
// Browser modules are served from fixed lists only; shared modules are the same files the server uses.
const BROWSER_MODULES=new Set(['api','autosave','card','variants','agent-panel','history','publish-dialog','diff']);
const SHARED_MODULES=new Set(['urls','links']);
// The polling state carries card summaries; the full card with history and journal is loaded when it is opened.
const SUMMARY_OMIT=new Set(['history','agentLog','sources','comments','duplicateCheck','imageVariants']);
function summary(post){
 const result={};
 for(const [key,value] of Object.entries(post))if(!SUMMARY_OMIT.has(key))result[key]=value;
 result.logCount=post.agentLog?.length||0;result.variantCount=post.imageVariants?.length||0;
 return result;
}
const SESSION=/^[a-f0-9-]{36}$/;
const isLocal=address=>['127.0.0.1','::1','::ffff:127.0.0.1'].includes(address);
function json(res,value,status=200){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(value));}
async function body(req){
 if(!req.headers['content-type']?.startsWith('application/json'))fail('Нужен JSON-запрос.',415);
 const chunks=[];let size=0;
 for await(const c of req){size+=c.length;if(size>12*1024*1024)fail('Запрос слишком большой.',413);chunks.push(c);}
 try{const data=JSON.parse(Buffer.concat(chunks).toString());if(!data||Array.isArray(data)||typeof data!=='object')fail('Неверный запрос.');return data;}catch{fail('Неверный JSON.');}
}
function sessionCookie(res,token,secure){res.setHeader('Set-Cookie',`editor_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${token?604800:0}${secure?'; Secure':''}`);}
function canRead(user,project){return user&&(user.projectIds.includes('*')||user.projectIds.includes(project.id));}

export function createApp({dataDir=DEFAULT_DATA,mediaDir,seed,runnerFactory,transport,publicOrigin='',automaticBackups=false}={}) {
 const effectiveMediaDir=mediaDir||join(dataDir,'media');
 mkdirSync(dataDir,{recursive:true,mode:0o700});
 const database=new EditorDatabase(join(dataDir,'editor.sqlite'));
 const team=new Team(database),cache=new Map(),active=new Map();
 const codex=new CodexRunner();let closed=false,backupError=null;
 const services=id=>{
  if(cache.has(id))return cache.get(id);
  if(!database.getProject(id))fail('Проект не найден.',404);
  const getProject=()=>database.getProject(id);
  const projectDir=join(dataDir,'projects',id);mkdirSync(projectDir,{recursive:true,mode:0o700});
  const store=new ProjectStore(database,id);
  if(id==='default'&&Array.isArray(seed))for(const item of seed)if(!store.list().some(post=>post.id===item.id))store.create(item,item.id);
  store.recover();
  const settings=new Settings(join(dataDir,'private/projects',id,'telegram.json'),()=>getProject().topics);
  const assets=new Assets(join(effectiveMediaDir,'projects',id),id);
  const attachments=new Attachments(join(projectDir,'attachments'),id);
  const registry=new Registry({store});registry.sync();
  const jobs=new Jobs({store,assets,attachments,registry,dir:join(projectDir,'jobs'),getProject,active,runnerFactory});
  const ideas=new Ideas({store,registry,active,dir:join(projectDir,'ideas'),getProject,documents:database,runnerFactory});
  const publisher=new Publisher(store,()=>settings.read(),transport,image=>assets.resolve(image));
  const scheduler=new Scheduler({store,settings,publisher,registry});
  const result={store,settings,assets,attachments,registry,jobs,ideas,publisher,scheduler,getProject};cache.set(id,result);return result;
 };
 for(const project of database.listProjects())services(project.id);
 const backups=new Backups({database,dataDir,mediaDir:effectiveMediaDir});
 const doBackup=()=>backups.daily().then(()=>backupError=null).catch(()=>backupError='Не удалось создать резервную копию. Проверьте свободное место и доступ к папке данных.');
 if(automaticBackups)void doBackup();
 const timer=setInterval(()=>{if(closed)return;for(const ctx of cache.values())void ctx.scheduler.tick().catch(()=>{});},5000);timer.unref();
 const backupTimer=automaticBackups?setInterval(()=>void doBackup(),60*60*1000):null;backupTimer?.unref();
 const server=http.createServer(async(req,res)=>{
  res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');
  res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  try {
   const port=server.address()?.port,host=req.headers.host;
   const configured=publicOrigin?new URL(publicOrigin):null;
   if(![`127.0.0.1:${port}`,`localhost:${port}`,configured?.host].filter(Boolean).includes(host))fail('Недопустимый адрес.',403);
   const expectedOrigin=configured?.host===host?configured.origin:`http://${host}`;
   if(req.headers.origin&&req.headers.origin!==expectedOrigin)fail('Запрос с другой страницы заблокирован.',403);
   if(!isLocal(req.socket.remoteAddress)&&(!configured||!team.status().enabled))fail('Удалённый доступ требует настроенной команды и адреса подключения.',403);
   if(!['GET','HEAD'].includes(req.method)&&req.headers['x-editor-request']!=='editor')fail('Откройте редакцию для этого действия.',403);
   const url=new URL(req.url,expectedOrigin),path=decodeURIComponent(url.pathname);
   if(req.method==='GET'&&path==='/api/health')return json(res,{app:'telegram-editor',version:1});
   // The login page and its static resources contain no customer data.
   const staticFiles={'/':'index.html','/index.html':'index.html','/app.js':'app.js','/rich-text.js':'rich-text.js','/style.css':'style.css'};
   if(req.method==='GET'&&staticFiles[path]){const file=join(ROOT,'public',staticFiles[path]);res.writeHead(200,{'Content-Type':MIME[extname(file)]});return res.end(readFileSync(file));}
   const moduleMatch=req.method==='GET'&&(path.match(/^\/js\/([a-z-]+)\.js$/)||path.match(/^\/shared\/([a-z-]+)\.mjs$/));
   if(moduleMatch&&(path.startsWith('/js/')?BROWSER_MODULES:SHARED_MODULES).has(moduleMatch[1])){
    const file=path.startsWith('/js/')?join(ROOT,'public/js',`${moduleMatch[1]}.js`):join(ROOT,'src/shared',`${moduleMatch[1]}.mjs`);
    if(existsSync(file)){res.writeHead(200,{'Content-Type':MIME[extname(file)]});return res.end(readFileSync(file));}
   }
   if(req.method==='GET'&&path==='/api/team')return json(res,{...team.status(),user:team.authenticate(req.headers.cookie)});
   if(req.method==='POST'&&['/api/team/setup','/api/team/login'].includes(path)){
    if(path.endsWith('setup')&&!isLocal(req.socket.remoteAddress))fail('Первый вход настройте на основном компьютере.',403);
    const result=path.endsWith('setup')?team.setup(await body(req)):team.login(await body(req));
    sessionCookie(res,result.token,expectedOrigin.startsWith('https:'));return json(res,{user:result.user});
   }
   if(req.method==='POST'&&path==='/api/team/logout'){team.logout(req.headers.cookie);sessionCookie(res,'',expectedOrigin.startsWith('https:'));return json(res,{ok:true});}
   const user=team.authenticate(req.headers.cookie);if(!user)fail('Войдите в редакцию.',401);
   const projects=database.listProjects().filter(p=>canRead(user,p));
   const projectId=path.startsWith('/media/')?(url.searchParams.get('project')||'default'):(req.headers['x-editor-project']||url.searchParams.get('project')||projects[0]?.id||'default');
   if(typeof projectId!=='string')fail('Некорректный проект.');
   if(req.method==='GET'&&path==='/api/projects')return json(res,{projects});
   const requireOwner=()=>{if(user.role!=='owner'||!user.projectIds.includes('*'))fail('Доступно владельцу всей редакции.',403);};
   if(req.method==='POST'&&path==='/api/projects'){requireOwner();const input=await body(req);delete input.id;const project=database.createProject(input);services(project.id);return json(res,project,201);}
   const projectMatch=path.match(/^\/api\/projects\/([a-z0-9_-]+)$/);
   if(req.method==='PATCH'&&projectMatch){requireOwner();team.assertAccess(user,projectMatch[1],'admin');const input=await body(req);const updated=database.updateProject(projectMatch[1],input);return json(res,updated);}
   if(path==='/api/team/users'){
    requireOwner();
    if(req.method==='GET')return json(res,{users:team.listUsers()});
    if(req.method==='POST'){const input=await body(req);if(input.projectIds?.some(id=>id!=='*'&&!database.getProject(id)))fail('Неизвестный проект.');return json(res,team.createUser(input),201);}
   }
   const memberMatch=path.match(/^\/api\/team\/users\/([a-f0-9-]{36})$/);
   if(req.method==='PATCH'&&memberMatch){requireOwner();const input=await body(req);if(input.projectIds?.some(id=>id!=='*'&&!database.getProject(id)))fail('Неизвестный проект.');return json(res,team.updateUser(memberMatch[1],input));}
   if(req.method==='GET'&&path==='/api/calendar'){
    const events=[];
    for(const project of projects)for(const p of services(project.id).store.list()){
     if(p.deletedAt)continue;
     const published=p.status==='published'&&p.publication?.status==='published';
     const scheduled=p.status==='scheduled'&&p.schedule?.status==='scheduled';
     const at=published?(p.publication.finishedAt||p.publication.manuallyConfirmedAt):scheduled?p.schedule.at:null;
     if(at)events.push({id:p.id,projectId:project.id,projectName:project.name,color:project.color,timezone:project.timezone,title:p.title,topic:p.topic,status:published?'published':p.schedule.status,at,url:published?p.publication.messages?.[0]?.url||'':'',revision:p.revision});
    }
    return json(res,{events,projects});
   }
   if(req.method==='GET'&&path==='/api/backup'){
    requireOwner();const file=await backups.create();res.writeHead(200,{'Content-Type':'application/gzip','Content-Disposition':`attachment; filename="${basename(file)}"`});return createReadStream(file).pipe(res);
   }
   team.assertAccess(user,projectId,'read');
   const ctx=services(projectId),{store,settings,assets,attachments,registry,jobs,ideas,publisher,scheduler}=ctx;
   const mutating=!['GET','HEAD'].includes(req.method);
   if(mutating){
    const action=path.startsWith('/api/settings')?'admin':/\/(publish|reconcile|approve|schedule|unschedule)$/.test(path)?'publish':'edit';
    team.assertAccess(user,projectId,action);
   }
   if(req.method==='GET'&&path==='/api/state'){
    const members=team.listUsers().filter(u=>!u.disabled&&canRead(u,{id:projectId})).map(({id,name,role})=>({id,name,role}));
    const posts=store.list();
    const payload=JSON.stringify({posts:posts.filter(p=>!p.deletedAt).map(summary),trash:posts.filter(p=>p.deletedAt).map(summary),topics:ctx.getProject().topics,settings:settings.public(),ideaBatches:ideas.list(),registryWarning:registry.error,backupError,projects,project:ctx.getProject(),user,members,teamEnabled:team.status().enabled});
    const etag=`"${createHash('sha1').update(payload).digest('base64url')}"`;
    if(req.headers['if-none-match']===etag){res.writeHead(304,{ETag:etag});return res.end();}
    res.writeHead(200,{'Content-Type':'application/json; charset=utf-8',ETag:etag});return res.end(payload);
   }
   if(req.method==='GET'&&path==='/api/registry')return json(res,{entries:registry.list(),warning:registry.error});
   if(req.method==='POST'&&path==='/api/registry/refresh'){registry.sync();return json(res,{entries:registry.list(),warning:registry.error});}
   if(req.method==='POST'&&path==='/api/posts/trash')return json(res,{posts:store.trash((await body(req)).items)});
   if(req.method==='GET'&&path==='/api/ideas')return json(res,{batches:ideas.list()});
   if(req.method==='POST'&&path==='/api/ideas')return json(res,ideas.start(await body(req)),202);
   const ideaMatch=path.match(/^\/api\/ideas\/([a-f0-9-]{36})\/(accept|cancel)$/);
   if(req.method==='POST'&&ideaMatch){const b=await body(req);return json(res,ideaMatch[2]==='cancel'?ideas.cancel(ideaMatch[1]):ideas.accept(ideaMatch[1],b.selected));}
   if(req.method==='GET'&&path==='/api/codex')return json(res,await codex.status());
   if(path==='/api/settings'){
    if(req.method==='GET')return json(res,settings.public());
    if(req.method==='PUT'){
     const result=settings.save(await body(req));
     for(const p of store.list())if(p.status==='scheduled')scheduler.cancel(p.id,p.revision);
     return json(res,result);
    }
   }
   if(req.method==='POST'&&path==='/api/settings/verify')return json(res,await settings.verify());
   if(req.method==='POST'&&path==='/api/posts'){const {topic,title,brief}=await body(req);return json(res,store.create({topic,title,brief}),201);}
   const match=path.match(/^\/api\/posts\/(POST-\d{3,}(?:-[a-f0-9]{8})?)(?:\/(\w+)(?:\/([\w.-]+))?)?$/);
   if(match){
    const [,id,action,sub]=match;
    if(req.method==='GET'&&!action)return json(res,store.get(id));
    if(req.method==='GET'&&action==='attachments'&&sub){store.get(id);const file=attachments.resolve(id,sub);res.writeHead(200,{'Content-Type':MIME[extname(file)]});return res.end(readFileSync(file));}
    if(req.method==='GET'&&action==='preview'){
     const p=store.get(id),s=settings.public(),issues=publicationIssues(p,s);
     return json(res,{postId:p.id,revision:p.revision,routeVersion:s.routeVersion,parts:partsFor(p),destination:s.destinationType==='channel'?`${ctx.getProject().name} · канал`:topicName(p.topic,ctx.getProject().topics),ready:issues.length===0,issues});
    }
    const b=await body(req);
    if(sub) {
     if(req.method==='POST'&&action==='image'&&sub==='select')return json(res,store.selectVariant(id,b.revision,b.name,{by:user.name}));
     if(req.method==='POST'&&action==='links'&&sub==='convert')return json(res,store.convertLinks(id,b.revision,{by:user.name}));
     fail('Страница не найдена.',404);
    }
    if(req.method==='POST'&&action==='attachments'){
     const current=store.get(id);if(current.deletedAt)fail('Карточка в корзине.',409);
     return json(res,attachments.fromDataUrl(id,b.dataUrl,typeof b.name==='string'?b.name:''),201);
    }
    if(req.method==='PATCH'&&!action){
     const {revision,session=null,...patch}=b;
     if(session!==null&&(typeof session!=='string'||!SESSION.test(session)))fail('Некорректный сеанс правки.');
     return json(res,store.save(id,patch,revision,{session,by:user.name}));
    }
    if(req.method==='POST'&&action==='restore')return json(res,store.restore(id,b.revision,b.restoreRevision,b.fields??null));
    if(req.method==='POST'&&action==='untrash')return json(res,store.untrash(id,b.revision));
    if(req.method==='DELETE'&&!action)return json(res,store.trash([{id,revision:b.revision}])[0]);
    if(req.method==='POST'&&action==='jobs'){const {revision,...request}=b;return json(res,jobs.start(id,revision,request,{by:user.name}),202);}
    if(req.method==='POST'&&action==='cancel')return json(res,jobs.cancel(id,b.revision));
    if(req.method==='POST'&&action==='approve')return json(res,scheduler.approve(id,b.revision,user.name));
    if(req.method==='POST'&&action==='schedule')return json(res,scheduler.schedule(id,b.revision,b,user.name));
    if(req.method==='POST'&&action==='unschedule')return json(res,scheduler.cancel(id,b.revision));
    if(req.method==='POST'&&action==='comments'){
     if(typeof b.text!=='string'||!b.text.trim()||b.text.length>4000)fail('Комментарий: от 1 до 4000 символов.');
     return json(res,store.mutate(id,p=>{p.comments??=[];if(p.comments.length>=1000)fail('Достигнут лимит комментариев к материалу.');p.comments.push({id:randomUUID(),author:user.name,userId:user.id,text:b.text.trim(),at:new Date().toISOString()});}));
    }
    if(req.method==='POST'&&action==='duplicate'){
     const source=store.get(id);const copy=store.create({title:b.title||source.title+' — копия',topic:b.topic||source.topic,brief:source.brief});
     return json(res,store.change(copy.id,copy.revision,p=>{p.text=source.text;p.entities=source.entities||[];p.image=source.image;p.sources=source.sources;}),201);
    }
    if(req.method==='POST'&&action==='image'){
     const current=store.get(id);assertEditable(current,b.revision);assertNotScheduled(current);assertImageFree(current);
     const image=assets.fromDataUrl(b.dataUrl,id);
     return json(res,store.setImage(id,b.revision,image,{origin:'upload',by:user.name}));
    }
    if(req.method==='DELETE'&&action==='image')return json(res,store.setImage(id,b.revision,null,{origin:'manual',by:user.name}));
    if(req.method==='POST'&&action==='publish'){const result=await publisher.publish(id,b.revision,b.routeVersion);registry.sync();return json(res,result);}
    if(req.method==='POST'&&action==='reconcile'){const result=publisher.reconcile(id,b.revision,b.messageIds);registry.sync();return json(res,result);}
   }
   if(req.method==='GET'&&path.startsWith('/media/')){const file=assets.resolve(path.slice(7));res.writeHead(200,{'Content-Type':MIME[extname(file)]});return res.end(readFileSync(file));}
   fail('Страница не найдена.',404);
  }catch(e){if(!res.headersSent)json(res,{error:e.status?e.message:'Действие не выполнено. Проверьте подключение и повторите.'},e.status||500);else res.end();}
 });
 server.on('close',()=>{closed=true;clearInterval(timer);if(backupTimer)clearInterval(backupTimer);for(const ctx of cache.values())ctx.jobs.close();});
 return {server,...services('default'),database,team,services,backups};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const dataDir=process.env.EDITOR_DATA_DIR?resolve(process.env.EDITOR_DATA_DIR):DEFAULT_DATA;
 const mediaDir=process.env.EDITOR_MEDIA_DIR?resolve(process.env.EDITOR_MEDIA_DIR):join(dataDir,'media');
 const lock=join(dataDir,'server.pid');let cleanup;
 try{cleanup=acquireLock(lock);}catch(e){console.error(e.message);process.exit(1);}
 process.on('exit',cleanup);
 const app=createApp({dataDir,mediaDir,publicOrigin:process.env.EDITOR_ORIGIN||'',automaticBackups:true});
 const port=Number(process.env.EDITOR_PORT||4317),host=process.env.EDITOR_HOST||'127.0.0.1';
 for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{app.jobs.close();app.server.close();cleanup();process.exit(0);});
 app.server.on('error',e=>{console.error(e.code==='EADDRINUSE'?'Порт редакции уже занят.':'Не удалось открыть редакцию.');cleanup();process.exit(1);});
 app.server.listen(port,host,()=>console.log(`Редакция: http://127.0.0.1:${port}\nДля остановки нажмите Ctrl+C. Расписание работает, пока компьютер включён и редакция запущена.`));
}
