export const TOPICS = [{id:'main',name:'Главная'}];
export function fail(message, status=400) { throw Object.assign(new Error(message),{status}); }
function isConfirmedPublication(post) {
  return post.status === 'published' && post.publication?.status !== 'failed';
}
export function assertEditable(p, revision) {
  if(p.deletedAt) fail('Карточка в корзине. Сначала восстановите её.',409);
  if(p.revision !== revision) fail('Версия изменилась. Обновите карточку перед действием.',409);
  if(p.status === 'working') fail('Пост занят: дождитесь агента или отмените задачу.',409);
  if(isConfirmedPublication(p)||['uncertain','publishing'].includes(p.status)) fail('Пост опубликован или отправка требует сверки. Изменения заблокированы.',409);
}
export function topicName(id,topics=TOPICS) { return topics.find(t=>t.id===id)?.name || ''; }
export function validateEntities(text, entities=[]) {
  if(!Array.isArray(entities)||entities.length>2000) fail('Некорректное форматирование.');
  const ranges=entities.map(entity=>{
    const {type,offset,length}=entity||{};
    if(!['bold','italic','blockquote','spoiler'].includes(type)||!Number.isInteger(offset)||!Number.isInteger(length)||offset<0||length<=0||offset+length>text.length)
      fail('Некорректное форматирование.');
    for(const boundary of [offset,offset+length]) if(boundary>0&&boundary<text.length&&/[\uD800-\uDBFF]/.test(text[boundary-1])&&/[\uDC00-\uDFFF]/.test(text[boundary])) fail('Форматирование разрывает символ.');
    return {type,offset,length};
  });
  for(let i=0;i<ranges.length;i++)for(let j=i+1;j<ranges.length;j++) {
    const a=ranges[i],b=ranges[j],endA=a.offset+a.length,endB=b.offset+b.length;
    if(a.offset>=endB||b.offset>=endA)continue;
    const nested=(a.offset<=b.offset&&endA>=endB)||(b.offset<=a.offset&&endB>=endA);
    if(!nested||(a.type==='blockquote'&&b.type==='blockquote'))fail('Диапазоны форматирования пересекаются.');
  }
  return ranges;
}
export function partsFor(post) {
  const entities=validateEntities(post.text||'',post.entities||[]);
  const parts=plainPartsFor(post);
  let offset=0;
  for(const part of parts) {
    const length=(part.type==='photo'?part.caption:part.text).length;
    const ranges=entities.flatMap(entity=>{
      const start=Math.max(offset,entity.offset),end=Math.min(offset+length,entity.offset+entity.length);
      return end>start?[{type:entity.type,offset:start-offset,length:end-start}]:[];
    });
    if(ranges.length)part.entities=ranges;
    offset+=length;
  }
  return parts;
}
function plainPartsFor({text='',image=null}) {
  if(image && text.length<=1024) return [{type:'photo',url:image.url,caption:text}];
  const parts=image?[{type:'photo',url:image.url,caption:''}]:[];
  let rest=text;
  while(rest.length) {
    let end=Math.min(rest.length,4096);
    if(end<rest.length) {
      const para=rest.lastIndexOf('\n',end-1);
      const word=rest.lastIndexOf(' ',end-1);
      if(para>2048) end=para+1;
      else if(word>2048) end=word+1;
      if(/[\uD800-\uDBFF]/.test(rest[end-1])) end--;
    }
    parts.push({type:'text',text:rest.slice(0,end)}); rest=rest.slice(end);
  }
  return parts;
}
export function normalizeRoutes(chatId, input={},topics=TOPICS) {
  const result=Object.fromEntries(topics.map(t=>[t.id,'']));
  for(const [key,value] of Object.entries(input)) {
    if(!topicName(key,topics)) fail('Неизвестная тема проекта.');
    let id=String(value||'').trim();
    if(id.startsWith('https://')) {
      const match=id.match(/^https:\/\/t\.me\/c\/(\d+)\/(\d+)(?:\/\d+)?(?:\?.*)?$/);
      if(!match) fail('Нужна приватная ссылка на тему или числовой ID темы.');
      if(chatId!==`-100${match[1]}`) fail('Ссылка относится к другой группе.');
      id=match[2];
    }
    if(id && (!/^[1-9]\d{0,9}$/.test(id) || !Number.isSafeInteger(Number(id)))) fail('Некорректный ID темы.');
    result[key]=id;
  }
  const ids=Object.values(result).filter(Boolean);
  if(new Set(ids).size!==ids.length) fail('У каждой темы должен быть отдельный ID.');
  return result;
}
export function publicationIssues(post,settings) {
 const issues=[];
 if(post.deletedAt) issues.push('Карточка в корзине.');
 if(!post.text.trim()) issues.push('Добавьте текст поста.');
 if(post.status==='working') issues.push('Дождитесь завершения агента.');
 if(isConfirmedPublication(post)||['publishing','uncertain'].includes(post.status)) issues.push('Повторная отправка заблокирована.');
 if(!settings.verified) issues.push('Проверьте подключение Telegram в настройках.');
 if(settings.destinationType!=='channel'&&!settings.topics[post.topic]) issues.push('Укажите ссылку на эту тему в настройках.');
 return issues;
}
