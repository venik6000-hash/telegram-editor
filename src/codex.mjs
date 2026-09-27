import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {existsSync,readFileSync,mkdirSync,writeFileSync} from 'node:fs';
import {join,basename} from 'node:path';
import {homedir} from 'node:os';
const exec=promisify(execFile);
export function safeEnvironment(source=process.env) {
 const env={};
 for(const key of ['PATH','HOME','USER','LOGNAME','SHELL','TMPDIR','LANG','LC_ALL','CODEX_HOME','SSL_CERT_FILE','SSL_CERT_DIR'])if(source[key])env[key]=source[key];
 env.NO_COLOR='1';env.RUST_LOG='error';return env;
}
export function parseResult(raw,kind) {
 let result;try{result=JSON.parse(raw);}catch{throw new Error('Агент не вернул результат в ожидаемом формате. Повторите задачу.');}
 if(result.ready===false){const question=String(result.needsInput||'').trim()||'Нужны дополнительные данные для поста.';throw Object.assign(new Error(question),{question});}
 if(kind==='duplicates') {
  if(!Array.isArray(result.duplicateIds)||result.duplicateIds.some(id=>typeof id!=='string'||!/^POST-\d{3,}(?:-[a-f0-9]{8})?$/.test(id))||typeof result.reason!=='string')throw new Error('Проверка повторов вернула некорректный результат.');
  return result;
 }
 if(kind==='ideas') {
  if(!Array.isArray(result.ideas)||!result.ideas.length||result.ideas.length>10)throw new Error('Агент должен вернуть от 1 до 10 идей.');
  for(const idea of result.ideas){
   if(typeof idea.title!=='string'||!idea.title.trim()||idea.title.length>240||typeof idea.brief!=='string'||idea.brief.length>4000)throw new Error('Агент вернул некорректную идею.');
   if(!Array.isArray(idea.sources)||idea.sources.some(s=>typeof s.title!=='string'||!/^https?:\/\/\S+$/i.test(s.url)))throw new Error('Агент вернул некорректные источники идеи.');
  }
  return result;
 }
 if(kind==='image') {
  if(typeof result.imagePath!=='string'||!result.imagePath)throw new Error('Агент не создал изображение.');
  result.usedAssets=Array.isArray(result.usedAssets)?[...new Set(result.usedAssets.filter(Number.isInteger))]:[];
  result.note=typeof result.note==='string'?result.note.trim().slice(0,1000):'';
  return result;
 }
 if(typeof result.text!=='string'||!result.text.trim())throw new Error('Агент вернул пустой текст.');
 if(result.text.length>24000)throw new Error('Текст слишком длинный для редакции.');
 if(!Array.isArray(result.sources))throw new Error('Агент не указал список источников.');
 for(const s of result.sources)if(typeof s.title!=='string'||!/^https?:\/\/\S+$/i.test(s.url))throw new Error('Агент вернул некорректную ссылку.');
 return result;
}
function resultProperties(kind) {
 const sources={type:'array',items:{type:'object',additionalProperties:false,properties:{title:{type:'string'},url:{type:'string'}},required:['title','url']}};
 if(kind==='image')return {imagePath:{type:'string'},usedAssets:{type:'array',items:{type:'integer'}},note:{type:'string'}};
 if(kind==='duplicates')return {duplicateIds:{type:'array',items:{type:'string'}},reason:{type:'string'}};
 if(kind==='ideas')return {ideas:{type:'array',items:{type:'object',additionalProperties:false,properties:{title:{type:'string'},brief:{type:'string'},sources},required:['title','brief','sources']}}};
 return {text:{type:'string'},sources};
}
// Since the September 2026 ChatGPT update the CLI lives in Resources/codex-cli/bin; older builds kept it in Resources.
export const CODEX_PATHS=['/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex','/Applications/ChatGPT.app/Contents/Resources/codex','/Applications/Codex.app/Contents/Resources/codex-cli/bin/codex','/Applications/Codex.app/Contents/Resources/codex','/opt/homebrew/bin/codex','/usr/local/bin/codex'];
function binary() {
 for(const path of CODEX_PATHS)if(existsSync(path))return path;
 return 'codex';
}
export function editorAgentArgs({jobDir,schema,output}) {
 return ['exec','--ignore-user-config','--ephemeral','--skip-git-repo-check','--json','--color','never','-s','workspace-write','--disable','shell_tool','--enable','image_generation','-c','forced_login_method="chatgpt"','-c','web_search="live"','-C',jobDir,'--output-schema',schema,'-o',output,'-'];
}
export class CodexRunner {
 constructor(){this.binary=binary();this.child=null;this.cancelled=false;this.stopProcess=null;}
 async status() {
  try {
   const env=safeEnvironment();
   const [v,a]=await Promise.all([exec(this.binary,['--version'],{env,timeout:15000}),exec(this.binary,['login','status'],{env,timeout:15000})]);
   const authenticated=/Logged in using ChatGPT/.test(a.stdout+' '+a.stderr);
   return {available:true,authenticated,version:v.stdout.trim(),message:authenticated?'Подключена подписка ChatGPT':'Войдите в Codex через ChatGPT. Доступ по API-ключу отключён.'};
  } catch {return {available:false,authenticated:false,version:'',message:'Откройте Codex и войдите через ChatGPT, затем повторите проверку.'};}
 }
 async run({kind,prompt,jobDir,images=[],onEvent=()=>{}}) {
  if(this.cancelled)throw new Error('Задача отменена.');
  const auth=await this.status();if(!auth.authenticated)throw new Error(auth.message);
  if(this.cancelled)throw new Error('Задача отменена.');
  mkdirSync(jobDir,{recursive:true,mode:0o700});
  const output=join(jobDir,'result.json');const schema=join(jobDir,'schema.json');
  const properties=resultProperties(kind);
  Object.assign(properties,{ready:{type:'boolean'},needsInput:{type:'string'}});
  writeFileSync(schema,JSON.stringify({type:'object',additionalProperties:false,properties,required:Object.keys(properties)}));
  const args=editorAgentArgs({jobDir,schema,output});
  if(kind==='image') {
   for(const image of images) {
    if(!existsSync(image))throw new Error('Не найдено изображение для агента: '+basename(image));
    args.splice(args.length-1,0,'--image',image);
   }
  }
  let threadId=null;
  await new Promise((resolve,reject)=>{
   const child=spawn(this.binary,args,{cwd:jobDir,env:safeEnvironment(),stdio:['pipe','pipe','pipe']});this.child=child;
   let buffer='',stderr='',failure='';let settled=false,stopError=null,killTimer=null;
   const done=(error)=>{if(settled)return;settled=true;clearTimeout(timer);clearTimeout(killTimer);if(this.child===child){this.child=null;this.stopProcess=null;}error?reject(error):resolve();};
   this.stopProcess=(error)=>{
    if(stopError)return;stopError=error;child.kill('SIGTERM');
    killTimer=setTimeout(()=>{if(!settled)child.kill('SIGKILL');},5000);
   };
   const timer=setTimeout(()=>this.stopProcess?.(new Error('Агент не завершил задачу за 15 минут. Результат не применён.')),15*60*1000);
   child.on('error',()=>done(new Error('Не удалось запустить Codex. Проверьте установку приложения.')));
   child.stderr.on('data',b=>{stderr=(stderr+b.toString()).slice(-2500);});
   child.stdout.on('data',chunk=>{
    buffer+=chunk.toString();let i;
    while((i=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,i);buffer=buffer.slice(i+1);try {
     const e=JSON.parse(line);
     if(e.type==='thread.started'&&/^[a-f0-9-]{36}$/.test(e.thread_id))threadId=e.thread_id;
     if(e.type==='turn.failed'||e.type==='error')failure=e.error?.message||e.message||'Ошибка агента';
     if(e.type==='item.started'||e.type==='item.completed')onEvent(e.item?.type==='web_search'?'Проверяет источники':kind==='image'?'Создаёт изображение':'Работает над текстом');
    }catch {}}
   });
   child.on('close',code=>{
    if(stopError){done(stopError);return;}
    if(code!==0||failure) {
     const diagnostic=failure||stderr;
     const message=/limit|quota|usage|credits/i.test(diagnostic)?'Достигнут лимит подписки. Дождитесь его восстановления; платный API не используется.':/cancel|interrupt/i.test(diagnostic)?'Задача отменена.':'Codex не завершил задачу. Откройте приложение, проверьте вход и доступ к сети, затем повторите.';
     done(new Error(message));
    } else done();
   });
   child.stdin.on('error',()=>{});child.stdin.end(prompt);
  });
  if(!existsSync(output))throw new Error('Codex завершился без результата.');
  const result=parseResult(readFileSync(output,'utf8'),kind);
  if(kind==='image'&&threadId)result.artifactRoot=join(process.env.CODEX_HOME||join(homedir(),'.codex'),'generated_images',threadId);
  return result;
 }
 cancel(){this.cancelled=true;this.stopProcess?.(new Error('Задача отменена.'));}
}
