// Markdown links written by agents become Telegram text_link entities. Shared by the server and the browser.
const LINK_SOURCE=String.raw`\[([^\[\]\n]{1,300})\]\((https?:\/\/[^\s()]+(?:\([^\s()]*\)[^\s()]*)*)\)`;

export function hasMarkdownLinks(text=''){return new RegExp(LINK_SOURCE).test(String(text));}

// Telegram accepts http(s) links without credentials; anything else stays plain text.
export function isLinkUrl(value) {
  if(typeof value!=='string'||!value||value.length>2048)return false;
  try {const url=new URL(value);return ['http:','https:'].includes(url.protocol)&&!url.username&&!url.password;} catch {return false;}
}

export function markdownLinksToEntities(text='',entities=[]) {
  const source=String(text),map=new Array(source.length+1),links=[];
  let output='',cursor=0,converted=0;
  const copy=(from,to)=>{for(let index=from;index<to;index++){map[index]=output.length;output+=source[index];}};
  for(const match of source.matchAll(new RegExp(LINK_SOURCE,'g'))) {
    const [token,label,url]=match,start=match.index;
    copy(cursor,start);
    const labelStart=output.length;map[start]=labelStart;
    for(let index=0;index<label.length;index++){map[start+1+index]=output.length;output+=label[index];}
    const labelEnd=output.length;
    for(let index=start+1+label.length;index<start+token.length;index++)map[index]=labelEnd;
    // A link Telegram would refuse keeps only its label, so one bad address never sinks the whole text.
    if(isLinkUrl(url))links.push({type:'text_link',offset:labelStart,length:label.length,url});
    converted++;
    cursor=start+token.length;
  }
  if(!converted)return {text:source,entities:[...entities],converted:0};
  copy(cursor,source.length);map[source.length]=output.length;
  const overlapsLink=entity=>links.some(link=>entity.offset<link.offset+link.length&&link.offset<entity.offset+entity.length);
  const shifted=entities.flatMap(entity=>{
    const start=map[entity.offset],end=map[entity.offset+entity.length];
    if(!(end>start))return [];
    const moved={...entity,offset:start,length:end-start};
    return moved.type==='text_link'&&overlapsLink(moved)?[]:[moved];
  });
  return {text:output,entities:[...shifted,...links].sort((a,b)=>a.offset-b.offset||b.length-a.length),converted};
}
