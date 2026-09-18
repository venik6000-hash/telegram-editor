import {mkdirSync,mkdtempSync,cpSync,existsSync,writeFileSync,chmodSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const exec=promisify(execFile);

export class Backups {
 constructor({database,dataDir,mediaDir}){Object.assign(this,{database,dataDir,mediaDir});this.pending=null;}
 create(){if(!this.pending)this.pending=this.run().finally(()=>this.pending=null);return this.pending;}
 async run(){
  const folder=join(this.dataDir,'backups');mkdirSync(folder,{recursive:true,mode:0o700});
  const stage=mkdtempSync(join(folder,'.snapshot-')),stamp=new Date().toISOString().replaceAll(':','-');
  const archive=join(folder,`editor-${stamp}.tar.gz`);
  try {
   this.database.backup(join(stage,'editor.sqlite'));
   if(existsSync(this.mediaDir))cpSync(this.mediaDir,join(stage,'media'),{recursive:true});
   writeFileSync(join(stage,'README.txt'),'Backup of editorial SQL data and media. Stop the editor before restoring. Restore editor.sqlite into data; remove stale editor.sqlite-wal/shm only while all editor processes are stopped. Telegram tokens are NOT included: retain private settings separately. Team account hashes are included; keep this backup private.\n',{mode:0o600});
   await exec('tar',['-czf',archive,'-C',stage,'.']);chmodSync(archive,0o600);
   return archive;
  } finally {rmSync(stage,{recursive:true,force:true});}
 }
 async daily(){
  const today=new Date().toISOString().slice(0,10);
  if(this.database.getDocument('backups','lastDay')===today)return null;
  const path=await this.create();this.database.setDocument('backups','lastDay',today);return path;
 }
}
