// Only supported Telegram entities are rendered; user HTML is never trusted.
const TYPES=['bold','italic','blockquote','spoiler','text_link'];

export function safeLinkUrl(value) {
  try {const url=new URL(value);return ['http:','https:'].includes(url.protocol)&&!url.username&&!url.password&&url.href.length<=2048?url.href:null;} catch {return null;}
}

// `links: 'open'` makes links clickable in read-only views; in the editor they only show the address.
export function renderRichText(element, text, entities = [], {links='edit'}={}) {
  element.replaceChildren();
  const ranges = [...entities].sort((a,b)=>a.offset-b.offset||b.length-a.length);
  const stack=[{node:element,end:text.length}];
  let position=0;
  for(const entity of ranges) {
    while(stack.length>1 && entity.offset>=stack.at(-1).end) {
      const current=stack.pop(); current.node.append(document.createTextNode(text.slice(position,current.end))); position=current.end;
    }
    const parent=stack.at(-1).node;
    parent.append(document.createTextNode(text.slice(position,entity.offset))); position=entity.offset;
    const node=entity.type==='text_link'?document.createElement('a'):document.createElement('span');
    node.dataset.format=entity.type;
    if(entity.type==='text_link') {
      const url=safeLinkUrl(entity.url);
      if(url){node.href=url;node.title=url;}
      if(links==='open'){node.target='_blank';node.rel='noopener noreferrer';}
    }
    parent.append(node);
    stack.push({node,end:entity.offset+entity.length});
  }
  while(stack.length) {
    const current=stack.pop();current.node.append(document.createTextNode(text.slice(position,current.end)));position=current.end;
  }
}

export function readRichText(element) {
  let text=''; const entities=[];
  function walk(node) {
    if(node.nodeType===3) { text+=node.data; return; }
    if(node.nodeName==='BR') {
      let block=node.parentElement;
      while(block && block!==element && !['DIV','P'].includes(block.nodeName))block=block.parentElement;
      const placeholder=block && block!==element && !block.textContent && block.querySelectorAll('br').length===1;
      if(!placeholder && (node!==element.lastChild || element.nodeType===11))text+='\n';
      return;
    }
    const block=['DIV','P'].includes(node.nodeName);
    let previous=node.previousSibling;
    while(previous && previous.nodeType===3 && !previous.data)previous=previous.previousSibling;
    if(block && previous && (['DIV','P'].includes(previous.nodeName)||!text.endsWith('\n')))text+='\n';
    const offset=text.length;
    for(const child of node.childNodes)walk(child);
    let type=node.dataset?.format;
    if(['B','STRONG'].includes(node.nodeName))type='bold';
    if(['I','EM'].includes(node.nodeName))type='italic';
    if(node.nodeName==='A')type='text_link';
    if(!TYPES.includes(type)||text.length<=offset)return;
    if(type!=='text_link'){entities.push({type,offset,length:text.length-offset});return;}
    const url=safeLinkUrl(node.getAttribute('href')||'');
    if(url)entities.push({type,offset,length:text.length-offset,url});
  }
  for(const child of element.childNodes)walk(child);
  return {text,entities:canonicalEntities(entities)};
}

// Character offsets of the current selection inside the editor, or null when the selection is elsewhere.
export function selectionOffsets(element) {
  const selection=window.getSelection();
  if(!selection.rangeCount)return null;
  const range=selection.getRangeAt(0);
  if(!element.contains(range.commonAncestorContainer))return null;
  const prefix=range.cloneRange();prefix.selectNodeContents(element);prefix.setEnd(range.startContainer,range.startOffset);
  const start=readRichText(prefix.cloneContents()).text.length;
  prefix.setEnd(range.endContainer,range.endOffset);
  const end=readRichText(prefix.cloneContents()).text.length;
  return {start,end};
}

export function linkAt(element,{start,end}) {
  return readRichText(element).entities.find(entity=>entity.type==='text_link'&&entity.offset<=start&&entity.offset+entity.length>=end&&(start<end||entity.offset<start))||null;
}

// Applies or removes one format on a character range; an empty url removes links from the range.
export function applyFormat(element,type,start,end,{url=''}={}) {
  const value=readRichText(element);
  const entities=value.entities.flatMap(entity=>{
    if(type!=='clear' && entity.type!==type)return [entity];
    const finish=entity.offset+entity.length;
    if(finish<=start||entity.offset>=end)return [entity];
    const pieces=[];
    if(entity.offset<start)pieces.push({...entity,length:start-entity.offset});
    if(finish>end)pieces.push({...entity,offset:end,length:finish-end});
    return pieces;
  });
  if(type==='text_link'){const safe=safeLinkUrl(url);if(safe&&end>start)entities.push({type,offset:start,length:end-start,url:safe});}
  else if(type!=='clear' && end>start)entities.push({type,offset:start,length:end-start});
  renderRichText(element,value.text,canonicalEntities(entities));
  restoreSelection(element,start,end);
}

export function bindRichEditor(element, onChange, {toolbar=document,onLink=null,onSave=null}={}) {
  element.addEventListener('paste',event=>{
    event.preventDefault();
    document.execCommand('insertText',false,event.clipboardData.getData('text/plain'));
  });
  // Links are edited, not followed, inside the editor.
  element.addEventListener('click',event=>{if(event.target.closest?.('a'))event.preventDefault();});
  const run=type=>{
    if(element.contentEditable!=='true')return;
    const offsets=selectionOffsets(element);
    if(!offsets)return;
    if(type==='text_link'){onLink?.(offsets,linkAt(element,offsets));return;}
    if(offsets.start===offsets.end)return;
    applyFormat(element,type,offsets.start,offsets.end);
    onChange();
  };
  element.addEventListener('keydown',event=>{
    if(event.key==='Enter') { event.preventDefault(); document.execCommand('insertText',false,'\n'); return; }
    if(!(event.metaKey||event.ctrlKey)||event.altKey||event.shiftKey)return;
    const type={KeyB:'bold',KeyI:'italic',KeyK:'text_link'}[event.code];
    if(type){event.preventDefault();run(type);}
    else if(event.code==='KeyS'&&onSave){event.preventDefault();onSave();}
  });
  for(const button of toolbar.querySelectorAll('button[data-format]')) {
    button.addEventListener('mousedown',event=>event.preventDefault());
    button.addEventListener('click',()=>run(button.dataset.format));
  }
}

// Merge adjacent formatting, then split crossing ranges into Telegram-compatible nesting.
export function canonicalEntities(entities) {
  const merged=[];
  for(const type of ['blockquote','bold','italic','spoiler']) {
    const ranges=entities.filter(e=>e.type===type).sort((a,b)=>a.offset-b.offset);
    let previous;
    for(const range of ranges) {
      if(previous && range.offset<=previous.offset+previous.length) previous.length=Math.max(previous.offset+previous.length,range.offset+range.length)-previous.offset;
      else {previous={...range};merged.push(previous);}
    }
  }
  // Links merge only with a neighbour that has the same address; a later link never overlaps an earlier one.
  let previous;
  for(const range of entities.filter(e=>e.type==='text_link').sort((a,b)=>a.offset-b.offset)) {
    const previousEnd=previous?previous.offset+previous.length:-1;
    if(previous && range.offset<=previousEnd && range.url===previous.url) {previous.length=Math.max(previousEnd,range.offset+range.length)-previous.offset;continue;}
    const start=Math.max(range.offset,previousEnd),end=range.offset+range.length;
    if(end<=start)continue;
    previous={...range,offset:start,length:end-start};merged.push(previous);
  }
  const result=[];
  for(const entity of merged) {
    let pieces=[entity];
    for(const existing of result) pieces=pieces.flatMap(piece=>{
      const start=piece.offset,end=start+piece.length,left=existing.offset,right=left+existing.length;
      let cut=null;
      if(start<left && left<end && end<right)cut=left;
      else if(start>left && start<right && right<end)cut=right;
      return cut===null?[piece]:[{...piece,length:cut-start},{...piece,offset:cut,length:end-cut}];
    });
    result.push(...pieces);
  }
  return result.sort((a,b)=>a.offset-b.offset||b.length-a.length);
}

export function restoreSelection(element,start,end=start) {
  const walker=document.createTreeWalker(element,NodeFilter.SHOW_TEXT),range=document.createRange();
  let offset=0,node,started=false,finished=false;
  while(node=walker.nextNode()) {
    if(!started && start<=offset+node.length){range.setStart(node,start-offset);started=true;}
    if(started && end<=offset+node.length){range.setEnd(node,end-offset);finished=true;break;}
    offset+=node.length;
  }
  if(!started){range.selectNodeContents(element);range.collapse(false);}
  else if(!finished)range.collapse(true);
  const selection=getSelection();selection.removeAllRanges();selection.addRange(range);element.focus();
}
