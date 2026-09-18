// Only supported Telegram entities are rendered; user HTML is never trusted.
export function renderRichText(element, text, entities = []) {
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
    const span=document.createElement('span');span.dataset.format=entity.type;parent.append(span);
    stack.push({node:span,end:entity.offset+entity.length});
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
    if(['bold','italic','blockquote','spoiler'].includes(type) && text.length>offset)entities.push({type,offset,length:text.length-offset});
  }
  for(const child of element.childNodes)walk(child);
  return {text,entities:canonicalEntities(entities)};
}

export function bindRichEditor(element, onChange) {
  element.addEventListener('paste',event=>{
    event.preventDefault();
    document.execCommand('insertText',false,event.clipboardData.getData('text/plain'));
  });
  element.addEventListener('keydown',event=>{
    if(event.key==='Enter') { event.preventDefault(); document.execCommand('insertText',false,'\n'); }
  });
  for(const button of document.querySelectorAll('[data-format]')) {
    if(button.tagName!=='BUTTON')continue;
    button.addEventListener('mousedown',event=>event.preventDefault());
    button.addEventListener('click',()=>{
      if(element.contentEditable!=='true')return;
      const selection=window.getSelection();
      if(!selection.rangeCount||selection.isCollapsed)return;
      const range=selection.getRangeAt(0);
      if(!element.contains(range.commonAncestorContainer))return;
      const prefix=range.cloneRange();prefix.selectNodeContents(element);prefix.setEnd(range.startContainer,range.startOffset);
      const start=readRichText(prefix.cloneContents()).text.length;
      prefix.setEnd(range.endContainer,range.endOffset);
      const end=readRichText(prefix.cloneContents()).text.length;
      const value=readRichText(element),type=button.dataset.format;
      const entities=value.entities.flatMap(entity=>{
        if(type!=='clear' && entity.type!==type)return [entity];
        const finish=entity.offset+entity.length;
        if(finish<=start||entity.offset>=end)return [entity];
        const pieces=[];
        if(entity.offset<start)pieces.push({...entity,length:start-entity.offset});
        if(finish>end)pieces.push({...entity,offset:end,length:finish-end});
        return pieces;
      });
      if(type!=='clear' && end>start)entities.push({type,offset:start,length:end-start});
      renderRichText(element,value.text,canonicalEntities(entities));
      restoreSelection(element,start,end);
      onChange();
    });
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

function restoreSelection(element,start,end) {
  const walker=document.createTreeWalker(element,NodeFilter.SHOW_TEXT),range=document.createRange();
  let offset=0,node,started=false;
  while(node=walker.nextNode()) {
    if(!started && start<=offset+node.length){range.setStart(node,start-offset);started=true;}
    if(started && end<=offset+node.length){range.setEnd(node,end-offset);break;}
    offset+=node.length;
  }
  const selection=getSelection();selection.removeAllRanges();selection.addRange(range);element.focus();
}
