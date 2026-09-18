const tokens=s=>new Set(String(s).toLowerCase().replace(/ё/g,'е').match(/[a-zа-я0-9]{4,}/g)?.map(w=>w.length>6?w.slice(0,-2):w)||[]);
export function similarity(a,b) {
 const x=tokens(a),y=tokens(b);let common=0;for(const t of x)if(y.has(t))common++;
 return x.size&&y.size?common/Math.min(x.size,y.size):0;
}
export class Registry {
 constructor({store,path}={}){Object.assign(this,{store,path});this.error=null;}
 list() {
  return this.store.list().filter(p=>p.status==='published'&&p.publication?.status==='published').map(p=>({
   id:p.id,title:p.title,text:p.text||'',topic:p.topic,
   date:p.publication.finishedAt||p.publication.manuallyConfirmedAt||'',
   url:p.publication.messages?.find(message=>message.url)?.url||'',
   confirmation:p.publication.confirmation?.detail||'Подтверждено в редакции',source:'sql',
  }));
 }
 findSimilar(post){
  const candidate=`${post.title||''} ${post.brief||''} ${post.text||''}`;
  return this.list().filter(p=>p.id!==post.id).map(p=>({...p,score:similarity(candidate,`${p.title} ${p.text||''}`)})).filter(p=>p.score>=0.65).sort((a,b)=>b.score-a.score).slice(0,8);
 }
 catalog(){return this.list().map(({id,title,topic,url,text})=>({id,title,topic,url,text}));}
 sync(){this.error=null;return true;}
}
