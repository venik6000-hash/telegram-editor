import {existsSync,readFileSync,writeFileSync,unlinkSync,mkdirSync,rmdirSync} from 'node:fs';
import {dirname} from 'node:path';
export function acquireLock(path) {
 mkdirSync(dirname(path),{recursive:true,mode:0o700});
 const guard=path+'.acquire';
 try{mkdirSync(guard);}catch(e){if(e.code==='EEXIST')throw new Error('Другой запуск редакции ещё не завершён. Повторите через несколько секунд.');throw e;}
 try {
 if(existsSync(path)) {
  const pid=Number(readFileSync(path,'utf8'));
  if(!Number.isInteger(pid)||pid<=0)throw new Error('Файл запуска повреждён. Проверьте data/server.pid.');
  let alive=true;try{process.kill(pid,0);}catch(e){if(e.code==='ESRCH')alive=false;}
  if(alive)throw new Error('Редакция уже запущена. Откройте http://127.0.0.1:4317');
  unlinkSync(path);
 }
 try{writeFileSync(path,String(process.pid),{flag:'wx',mode:0o600});}
 catch(e){if(e.code==='EEXIST')throw new Error('Редакция уже запущена.');throw e;}
 }finally{rmdirSync(guard);}
 return ()=>{try{if(readFileSync(path,'utf8')===String(process.pid))unlinkSync(path);}catch{}};
}
