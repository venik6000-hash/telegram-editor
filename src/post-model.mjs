// How a card changes over time: history snapshots, manual edit sessions, image variants and the agent log.
export const SESSION_WINDOW_MS=10*60*1000;
export const AGENT_LOG_LIMIT=50;
const CONTENT_KEYS=['title','brief','text','entities','image','sources','topic','dueAt','assignedTo'];

export const snapshot=post=>({
  revision:post.revision,topic:post.topic,title:post.title,brief:post.brief,text:post.text,entities:post.entities||[],image:post.image,
  sources:post.sources,assignedTo:post.assignedTo??null,dueAt:post.dueAt??null,savedAt:post.updatedAt,
  ...(post.lastChange?{change:post.lastChange}:{}),
});

const fingerprint=post=>Object.fromEntries(CONTENT_KEYS.map(key=>[key,JSON.stringify(post[key]??null)]));

export function continuesSession(post,origin,session,at=Date.now()) {
  const last=post.lastChange;
  return origin==='manual'&&Boolean(session)&&last?.origin==='manual'&&last.session===session&&at-Date.parse(last.at)<SESSION_WINDOW_MS;
}

// Records one content change. A manual edit that continues the current session updates the card without a new snapshot.
export function applyChange(post,{origin='manual',session=null,by='',jobId=null,instruction=null}={},fn=()=>{}) {
  ensureVariants(post);
  const at=Date.now(),coalesce=continuesSession(post,origin,session,at),before=fingerprint(post);
  if(!coalesce)post.history.push(snapshot(post));
  fn(post);
  post.revision++;
  const changed=CONTENT_KEYS.filter(key=>JSON.stringify(post[key]??null)!==before[key]).map(key=>key==='entities'?'text':key);
  const fields=[...new Set([...(coalesce?post.lastChange.fields||[]:[]),...changed])];
  post.lastChange={origin,at:new Date(at).toISOString(),fields};
  if(by)post.lastChange.by=String(by).slice(0,120);
  if(session)post.lastChange.session=session;
  if(jobId)post.lastChange.jobId=jobId;
  if(instruction)post.lastChange.instruction=String(instruction).slice(0,500);
  if(post.image)rememberVariant(post,post.image,{origin:['agent','upload'].includes(origin)?origin:'legacy',jobId,instruction});
  return post;
}

// Cards created before variants existed get their list from history snapshots and the current image.
export function ensureVariants(post) {
  if(Array.isArray(post.imageVariants))return post;
  const variants=[];
  const add=(image,at)=>{if(image?.name&&!variants.some(item=>item.name===image.name))variants.push({name:image.name,url:image.url,origin:'legacy',createdAt:at||null});};
  for(const version of post.history||[])add(version.image,version.savedAt);
  add(post.image,post.updatedAt);
  post.imageVariants=variants;
  return post;
}

export function rememberVariant(post,image,{origin='legacy',jobId=null,instruction=null}={}) {
  ensureVariants(post);
  if(!image?.name||post.imageVariants.some(item=>item.name===image.name))return post;
  const variant={name:image.name,url:image.url,origin,createdAt:new Date().toISOString()};
  if(jobId)variant.jobId=jobId;
  if(instruction)variant.instruction=String(instruction).slice(0,500);
  post.imageVariants.push(variant);
  return post;
}

export function logEntry(post,id){return (post.agentLog||[]).find(entry=>entry.id===id)||null;}
export function addLogEntry(post,entry){post.agentLog=[...(post.agentLog||[]),entry].slice(-AGENT_LOG_LIMIT);return entry;}
export function updateLogEntry(post,id,patch){const entry=logEntry(post,id);if(entry)Object.assign(entry,patch);return entry;}
export function recentLog(post,excludeId=null,limit=5){return (post.agentLog||[]).filter(entry=>entry.id!==excludeId&&entry.status!=='running').slice(-limit);}

// True when every change after `revision` touched only the picture, so a text edit based on `revision` is still safe.
export function onlyImageChangesSince(post,revision) {
  if(!Number.isInteger(revision)||revision>=post.revision)return false;
  const changes=[];
  for(let value=revision+1;value<post.revision;value++) {
    const version=(post.history||[]).find(item=>item.revision===value);
    if(!version?.change)return false;
    changes.push(version.change);
  }
  changes.push(post.lastChange);
  return changes.every(change=>Array.isArray(change?.fields)&&change.fields.length>0&&change.fields.every(field=>field==='image'));
}
