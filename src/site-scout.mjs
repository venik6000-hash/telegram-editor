// Opens the pages a user pointed at and downloads candidate images for the agent.
// The agent itself has no shell or network: every request goes through the guards below.
import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns';
import {isIP} from 'node:net';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {existsSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';

const run=promisify(execFile);
const USER_AGENT='Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15 telegram-editor';
const PRIVATE_ERROR='Адрес ведёт во внутреннюю сеть. Такие ссылки редакция не открывает.';
const PNG_SIGNATURE=Buffer.from([137,80,78,71,13,10,26,10]);
const STOPPED='Сбор материалов остановлен.';
const MAX_TAG=8192;
export const LIMITS={pageBytes:3*1024*1024,imageBytes:8*1024*1024,svgBytes:1024*1024,totalBytes:30*1024*1024,timeoutMs:15000,redirects:3,images:8,deadlineMs:90000,minSide:48};

function isPublicV4(ip) {
  const [a,b,c]=ip.split('.').map(Number);
  if(a===0||a===10||a===127||a>=224)return false;
  if(a===100&&b>=64&&b<=127)return false;
  if(a===169&&b===254)return false;
  if(a===172&&b>=16&&b<=31)return false;
  if(a===192&&b===168)return false;
  if(a===192&&b===0&&(c===0||c===2))return false;
  if(a===198&&(b===18||b===19))return false;
  if(a===198&&b===51&&c===100)return false;
  if(a===203&&b===0&&c===113)return false;
  return true;
}
function expandV6(ip) {
  let address=ip;
  const v4=address.match(/(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if(v4){const [a,b,c,d]=v4.slice(1).map(Number);address=`${address.slice(0,-v4[0].length)}${((a<<8)|b).toString(16)}:${((c<<8)|d).toString(16)}`;}
  const halves=address.split('::');if(halves.length>2)return null;
  const parse=part=>part?part.split(':').map(group=>/^[0-9a-f]{1,4}$/.test(group)?parseInt(group,16):NaN):[];
  const left=parse(halves[0]),right=halves.length===2?parse(halves[1]):[];
  if(halves.length===1&&left.length!==8)return null;
  const missing=8-left.length-right.length;if(missing<0)return null;
  const groups=[...left,...new Array(halves.length===2?missing:0).fill(0),...right];
  return groups.length===8&&groups.every(Number.isInteger)?groups:null;
}
function isPublicV6(ip) {
  const groups=expandV6(ip.toLowerCase().replace(/%.*$/,''));
  if(!groups)return false;
  if(groups.slice(0,5).every(group=>group===0)&&groups[5]===0xffff)return isPublicV4([groups[6]>>8,groups[6]&255,groups[7]>>8,groups[7]&255].join('.'));
  const first=groups[0];
  if(first===0x2001&&groups[1]===0x0db8)return false;
  if(first===0x2002||(first===0x0064&&groups[1]===0xff9b))return false;
  return (first&0xe000)===0x2000;
}
export function isPublicAddress(address) {const version=isIP(String(address));return version===4?isPublicV4(address):version===6?isPublicV6(address):false;}

// Used as `lookup` for every connection, so a DNS answer is checked at the moment the socket opens.
export function guardedLookup(hostname,options,callback) {
  if(typeof options==='function'){callback=options;options={};}
  dns.lookup(hostname,{...options,all:true},(error,addresses)=>{
    if(error)return callback(error);
    if(!addresses.length||addresses.some(item=>!isPublicAddress(item.address)))return callback(Object.assign(new Error(PRIVATE_ERROR),{code:'EPRIVATE'}));
    if(options.all)return callback(null,addresses);
    callback(null,addresses[0].address,addresses[0].family);
  });
}

export function assertFetchable(value) {
  let url;try{url=value instanceof URL?value:new URL(value);}catch{throw new Error('Некорректная ссылка.');}
  if(!['http:','https:'].includes(url.protocol))throw new Error('Открываются только ссылки http и https.');
  if(url.username||url.password)throw new Error('Ссылки с логином и паролем не открываются.');
  const host=url.hostname.replace(/^\[|\]$/g,'').toLowerCase();
  if(isIP(host)&&!isPublicAddress(host))throw new Error(PRIVATE_ERROR);
  if(host==='localhost'||/\.(localhost|local|internal|lan|home|corp)$/.test(host))throw new Error(PRIVATE_ERROR);
  return url;
}

function requestOnce(url,{maxBytes,accept,timeoutMs,signal}) {
  return new Promise((resolve,reject)=>{
    const client=url.protocol==='https:'?https:http;
    // `timeout` only covers an idle socket; this also stops a site that trickles bytes forever.
    let request=null;
    const overall=setTimeout(()=>request?.destroy(new Error('Сайт отвечает слишком долго.')),timeoutMs*2);
    const finish=(fn,value)=>{clearTimeout(overall);fn(value);};
    resolve=finish.bind(null,resolve);reject=finish.bind(null,reject);
    if(signal?.aborted){reject(new Error(STOPPED));return;}
    try {request=client.request(url,{method:'GET',lookup:guardedLookup,timeout:timeoutMs,signal,headers:{'User-Agent':USER_AGENT,Accept:accept,'Accept-Language':'ru,en;q=0.8'}},response=>{
      const status=response.statusCode||0;
      if(status>=300&&status<400&&response.headers.location){response.resume();resolve({status,location:response.headers.location});return;}
      if(Number(response.headers['content-length']||0)>maxBytes){response.destroy();reject(new Error('Файл слишком большой.'));return;}
      const chunks=[];let size=0;
      response.on('data',chunk=>{size+=chunk.length;if(size>maxBytes){response.destroy();reject(new Error('Файл слишком большой.'));return;}chunks.push(chunk);});
      response.on('end',()=>resolve({status,contentType:String(response.headers['content-type']||''),body:Buffer.concat(chunks)}));
      response.on('error',reject);
    });} catch(error) {reject(new Error(error.message||'Сайт недоступен.'));return;}
    request.on('timeout',()=>request.destroy(new Error('Сайт не ответил вовремя.')));
    request.on('error',error=>reject(error.code==='EPRIVATE'?error:error.name==='AbortError'?new Error(STOPPED):new Error(error.message||'Сайт недоступен.')));
    request.end();
  });
}

export async function safeFetch(value,{maxBytes=LIMITS.imageBytes,accept='*/*',timeoutMs=LIMITS.timeoutMs,redirects=LIMITS.redirects,signal}={}) {
  let url=assertFetchable(value);
  for(let hop=0;hop<=redirects;hop++) {
    const response=await requestOnce(url,{maxBytes,accept,timeoutMs,signal});
    if(response.location){url=assertFetchable(new URL(response.location,url));continue;}
    if(response.status<200||response.status>=300)throw new Error(`Сайт ответил кодом ${response.status}.`);
    return {url:url.href,contentType:response.contentType,body:response.body};
  }
  throw new Error('Слишком много перенаправлений.');
}

function decode(value) {
  return String(value||'').replace(/&(#x[0-9a-f]+|#\d+|amp|quot|apos|lt|gt|nbsp);/gi,(entity,code)=>{
    const lower=code.toLowerCase();
    const named={amp:'&',quot:'"',apos:"'",lt:'<',gt:'>',nbsp:' '};
    if(named[lower])return named[lower];
    const point=lower.startsWith('#x')?parseInt(lower.slice(2),16):Number(lower.slice(1));
    return Number.isInteger(point)&&point>0&&point<=0x10ffff?String.fromCodePoint(point):entity;
  });
}
// Attribute pairs in document order with the original name case. Linear on any input, however broken.
function attributePairs(tag) {
  const source=String(tag),pairs=[],length=source.length;
  let index=1;
  while(index<length&&!/[\s\/>]/.test(source[index]))index++;
  while(index<length) {
    while(index<length&&/[\s\/]/.test(source[index]))index++;
    if(index>=length||source[index]==='>')break;
    let start=index;
    while(index<length&&!/[\s"'<>\/=]/.test(source[index]))index++;
    const name=source.slice(start,index);
    if(!name){index++;continue;}
    while(index<length&&/\s/.test(source[index]))index++;
    if(source[index]!=='='){pairs.push([name,'']);continue;}
    index++;
    while(index<length&&/\s/.test(source[index]))index++;
    const quote=source[index];let value;
    if(quote==='"'||quote==="'"){const end=source.indexOf(quote,index+1);value=source.slice(index+1,end<0?length:end);index=end<0?length:end+1;}
    else {start=index;while(index<length&&!/[\s>]/.test(source[index]))index++;value=source.slice(start,index);}
    pairs.push([name,decode(value)]);
  }
  return pairs;
}
function attributes(tag) {
  const result={};
  for(const [name,value] of attributePairs(tag)){const key=name.toLowerCase();if(!(key in result))result[key]=value;}
  return result;
}
// Every '<' opens a tag that ends at the next '>'. Crude, but linear: a hostile page cannot stall the server.
function* scanTags(source,lower) {
  let index=0;
  for(;;) {
    const open=lower.indexOf('<',index);if(open<0)return;
    const close=lower.indexOf('>',open+1);if(close<0)return;
    yield {name:/^[a-z][a-z0-9:-]*/.exec(lower.slice(open+1,Math.min(close,open+64)))?.[0]||'',open,close};
    index=close+1;
  }
}
const TEXTLESS=new Set(['script','style','noscript','svg','template']);
function visibleText(source,lower,limit=20000) {
  let text='',index=0;
  for(const {name,open,close} of scanTags(source,lower)) {
    if(open<index)continue;
    text+=`${source.slice(index,open)} `;index=close+1;
    if(TEXTLESS.has(name)) {
      const end=lower.indexOf(`</${name}`,close);
      if(end<0){index=source.length;break;}
      const after=lower.indexOf('>',end);index=after<0?source.length:after+1;
    }
    if(text.length>limit)return text;
  }
  return text+source.slice(index);
}
function resolveImageUrl(raw,baseUrl) {
  try {
    let url=new URL(decode(raw).trim(),baseUrl);
    if(url.pathname.endsWith('/_next/image')&&url.searchParams.get('url'))url=new URL(url.searchParams.get('url'),url);
    if(!['http:','https:'].includes(url.protocol))return null;
    url.hash='';return url.href;
  } catch {return null;}
}
function largestFromSrcset(srcset) {
  let best='',score=-1;
  for(const part of String(srcset||'').split(',')){const [candidate,descriptor='1x']=part.trim().split(/\s+/);const value=parseFloat(descriptor)||1;if(candidate&&value>score){best=candidate;score=value;}}
  return best;
}

export function extractPage(html,baseUrl) {
  const source=String(html).slice(0,LIMITS.pageBytes),lower=source.toLowerCase();
  const metas=[],links=[],images=[],svgs=[];
  let title='',titleSeen=false,main=null,bodyStart=-1,svgClose=null;
  for(const {name,open,close} of scanTags(source,lower)) {
    if(close-open>MAX_TAG)continue;
    if(name==='title'&&!titleSeen) {titleSeen=true;const end=lower.indexOf('</title',close);title=decode(source.slice(close+1,end<0?Math.min(source.length,close+1000):end)).replace(/\s+/g,' ').trim().slice(0,300);}
    else if(name==='meta'&&metas.length<200)metas.push(attributes(source.slice(open,close+1)));
    else if(name==='link'&&links.length<200)links.push(attributes(source.slice(open,close+1)));
    else if(name==='img'&&images.length<400)images.push(attributes(source.slice(open,close+1)));
    else if(name==='svg'&&svgs.length<2&&svgClose!==Infinity) {
      // The closing tag is looked up once and reused, so many unclosed <svg> openings stay linear.
      if(svgClose===null||svgClose<close){const end=lower.indexOf('</svg>',close);svgClose=end<0?Infinity:end;}
      if(svgClose===Infinity)continue;
      const hint=`${lower.slice(Math.max(0,open-300),open)} ${lower.slice(open,close+1)}`;
      if(svgClose+6-open<=200000&&/logo|brand/.test(hint))svgs.push({markup:source.slice(open,svgClose+6),label:'Логотип со страницы (SVG)',hint:'logo'});
    }
    else if(name==='main'&&!main) {const end=lower.indexOf('</main',close);main={start:close+1,end:end<0?source.length:end};}
    else if(name==='body'&&bodyStart<0)bodyStart=close+1;
  }
  const meta=key=>metas.find(item=>item.property===key||item.name===key)?.content||'';
  const candidates=[],seen=new Set();
  const add=(raw,kind,extra={})=>{const url=resolveImageUrl(raw,baseUrl);if(url&&!url.startsWith('data:')&&!seen.has(url)){seen.add(url);candidates.push({url,kind,...extra});}};
  for(const key of ['og:image','og:image:url','og:image:secure_url','twitter:image','twitter:image:src'])for(const item of metas.filter(m=>m.property===key||m.name===key))add(item.content,'og',{label:meta('og:image:alt')||'Картинка для соцсетей',hint:meta('og:image:alt').toLowerCase()});
  for(const attrs of links) {
    const rel=String(attrs.rel||'').toLowerCase();
    if(!attrs.href||!/(^|\s)(icon|apple-touch-icon|apple-touch-icon-precomposed|mask-icon)(\s|$)/.test(rel))continue;
    const size=Math.max(0,...String(attrs.sizes||'').split(/\s+/).slice(0,20).map(value=>Number(value.split('x')[0])||0));
    add(attrs.href,'icon',{label:rel.includes('apple')?'Иконка приложения':'Иконка сайта',hint:`${rel} ${attrs.href}`.toLowerCase(),width:size||undefined,height:size||undefined});
  }
  for(const attrs of images) {
    const src=largestFromSrcset(attrs.srcset)||attrs.src||attrs['data-src']||attrs['data-lazy-src'];
    if(!src)continue;
    add(src,'img',{label:String(attrs.alt||'').slice(0,200),hint:[attrs.alt,attrs.class,attrs.id,src].join(' ').toLowerCase().slice(0,2000),width:Number(attrs.width)||undefined,height:Number(attrs.height)||undefined});
  }
  const start=main?main.start:bodyStart>=0?bodyStart:0;
  const bodyEnd=lower.lastIndexOf('</body');
  const end=main?main.end:bodyEnd>start?bodyEnd:source.length;
  const text=decode(visibleText(source.slice(start,end),lower.slice(start,end))).replace(/\s+/g,' ').trim().slice(0,6000);
  return {title,description:(meta('description')||meta('og:description')).slice(0,500),text,candidates,svgs};
}

function score(candidate) {
  const hint=`${candidate.label||''} ${candidate.hint||''} ${candidate.url||''}`.toLowerCase();
  let value=0;
  if(candidate.kind==='direct')value+=300;
  if(/logo|brand|логотип/.test(hint))value+=100;
  if(candidate.kind==='svg')value+=90;
  if(candidate.kind==='og')value+=60;
  if(candidate.kind==='icon'){const size=candidate.width||0;value+=size>=180?80:size>=96?50:size>0&&size<48?-100:20;if(/apple-touch|512x512/.test(hint))value+=20;}
  if(/\bicon\b|app-icon|app icon/.test(hint))value+=40;
  if(candidate.kind==='img'){const width=candidate.width||0;value+=width>=600?30:width>=200?10:width>0&&width<48?-100:0;}
  if(/\.ico(\?|$)/.test(candidate.url||''))value-=30;
  return value;
}
export function rankCandidates(candidates,limit=LIMITS.images) {
  return candidates.map(item=>({...item,score:score(item)})).filter(item=>item.score>-50).sort((a,b)=>b.score-a.score).slice(0,limit);
}

export function sniffImage(data) {
  if(!Buffer.isBuffer(data)||data.length<12)return null;
  if(data.subarray(0,8).equals(PNG_SIGNATURE))return 'png';
  if(data[0]===0xff&&data[1]===0xd8&&data[2]===0xff)return 'jpg';
  if(data.toString('ascii',0,4)==='RIFF'&&data.toString('ascii',8,12)==='WEBP')return 'webp';
  if(data.toString('ascii',0,4)==='GIF8')return 'gif';
  if(data[0]===0&&data[1]===0&&data[2]===1&&data[3]===0)return 'ico';
  if(data.toString('ascii',4,8)==='ftyp'&&/^avi[fs]/.test(data.toString('ascii',8,12)))return 'avif';
  const head=data.subarray(0,2048).toString('utf8').replace(/^﻿/,'').replace(/<\?xml[\s\S]*?\?>/,'').replace(/<!--[\s\S]*?-->/g,'').replace(/<!DOCTYPE svg[^>]*>/i,'').trimStart();
  return /^<svg[\s>]/i.test(head)?'svg':null;
}

export function imageSize(data) {
  if(data.subarray(0,8).equals(PNG_SIGNATURE))return {width:data.readUInt32BE(16),height:data.readUInt32BE(20)};
  if(data[0]===0xff&&data[1]===0xd8) {
    let offset=2;
    while(offset+9<data.length) {
      if(data[offset]!==0xff){offset++;continue;}
      const marker=data[offset+1];
      if(marker===0xd8||marker===0x01||(marker>=0xd0&&marker<=0xd7)){offset+=2;continue;}
      const length=data.readUInt16BE(offset+2);
      if(marker>=0xc0&&marker<=0xcf&&![0xc4,0xc8,0xcc].includes(marker))return {height:data.readUInt16BE(offset+5),width:data.readUInt16BE(offset+7)};
      offset+=2+length;
    }
    return null;
  }
  if(data.toString('ascii',0,4)==='RIFF'&&data.toString('ascii',8,12)==='WEBP') {
    const chunk=data.toString('ascii',12,16);
    if(chunk==='VP8X')return {width:1+data.readUIntLE(24,3),height:1+data.readUIntLE(27,3)};
    if(chunk==='VP8L'){const bits=data.readUInt32LE(21);return {width:(bits&0x3fff)+1,height:((bits>>14)&0x3fff)+1};}
    if(chunk==='VP8 ')return {width:data.readUInt16LE(26)&0x3fff,height:data.readUInt16LE(28)&0x3fff};
  }
  return null;
}

const SVG_DROPPED=new Set(['script','style','foreignobject','iframe','object','embed','audio','video','animate','set']);
function safeSvgAttribute(name,value) {
  const key=name.toLowerCase(),text=String(value).toLowerCase();
  if(key.startsWith('on'))return false;
  if(key==='href'||key.endsWith(':href')||key==='src')return text.trim().startsWith('#');
  if(text.includes('@import')||text.includes('expression('))return false;
  return text.split('url(').slice(1).every(part=>/^\s*['"]?#/.test(part));
}
const escapeAttribute=value=>String(value).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;');
// Rebuilds the SVG from safe pieces only: no scripts, styles, event handlers, external links, DOCTYPE or processing instructions.
export function sanitizeSvg(markup) {
  const source=String(markup),lower=source.toLowerCase();
  let out='',index=0,started=false;
  for(const {name,open,close} of scanTags(source,lower)) {
    if(open<index)continue;
    // Nothing before the root <svg> survives: XML declarations, DOCTYPE and its internal subset.
    if(!started){if(name!=='svg')continue;started=true;index=open;}
    out+=source.slice(index,open);index=close+1;
    const raw=source.slice(open,close+1);
    if(raw[1]==='!'||raw[1]==='?')continue;
    if(raw[1]==='/') {const tagName=/^[A-Za-z][\w:.-]*/.exec(raw.slice(2).trim())?.[0];if(tagName&&!SVG_DROPPED.has(tagName.toLowerCase()))out+=`</${tagName}>`;continue;}
    if(!name)continue;
    const selfClosing=/\/\s*>$/.test(raw);
    if(SVG_DROPPED.has(name)) {
      if(selfClosing)continue;
      const end=lower.indexOf(`</${name}`,close);
      if(end<0){index=source.length;break;}
      const after=lower.indexOf('>',end);index=after<0?source.length:after+1;
      continue;
    }
    const pairs=attributePairs(raw).filter(([key,value])=>safeSvgAttribute(key,value));
    out+=`<${source.slice(open+1,open+1+name.length)}${pairs.map(([key,value])=>` ${key}="${escapeAttribute(value)}"`).join('')}${selfClosing?'/':''}>`;
  }
  return out+source.slice(index).replace(/</g,'&lt;');
}

export function sizedSvg(svg,target=1024) {
  const open=svg.match(/<svg\b[^>]*>/i);if(!open)throw new Error('Некорректный SVG.');
  const attrs=attributes(open[0]);
  let [width,height]=String(attrs.viewbox||'').trim().split(/[\s,]+/).slice(2).map(Number);
  if(!(width>0&&height>0)){width=parseFloat(attrs.width)||0;height=parseFloat(attrs.height)||0;}
  if(!(width>0&&height>0)){width=target;height=target;}
  const scale=target/Math.max(width,height);
  let tag=open[0].replace(/\s(width|height)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi,'');
  if(!/viewbox\s*=/i.test(tag))tag=tag.replace(/<svg\b/i,`<svg viewBox="0 0 ${width} ${height}"`);
  tag=tag.replace(/<svg\b/i,`<svg width="${Math.round(width*scale)}" height="${Math.round(height*scale)}"`);
  if(!/xmlns\s*=/i.test(tag))tag=tag.replace(/<svg\b/i,'<svg xmlns="http://www.w3.org/2000/svg"');
  return svg.replace(open[0],tag);
}

export async function sipsToPng(input,output) {
  if(process.platform!=='darwin')throw new Error('Преобразование формата доступно только на macOS.');
  await run('/usr/bin/sips',['-s','format','png',input,'--out',output],{timeout:20000});
  if(!existsSync(output))throw new Error('Не удалось преобразовать изображение.');
  return output;
}

const hostOf=value=>{try{return new URL(value).hostname;}catch{return String(value);}};

async function materialize(candidate,{fetcher,rasterize,dir,index,limit,account,left,signal}) {
  let body=candidate.body;
  if(candidate.kind==='svg')body=Buffer.from(candidate.markup,'utf8');
  else if(!body){const response=await fetcher(candidate.url,{maxBytes:Math.min(limit.imageBytes,left()),accept:'image/png,image/jpeg,image/webp,image/svg+xml,image/*;q=0.8',timeoutMs:limit.timeoutMs,signal});body=response.body;account(body.length);}
  const type=candidate.kind==='svg'?'svg':sniffImage(body);
  if(!type)throw new Error('Не изображение.');
  const base=join(dir,`asset-${index}`);
  let path;
  if(['png','jpg','webp'].includes(type)){path=`${base}.${type}`;writeFileSync(path,body);}
  else if(type==='svg') {
    if(body.length>limit.svgBytes)throw new Error('SVG слишком большой.');
    const source=`${base}.svg`;writeFileSync(source,sizedSvg(sanitizeSvg(body.toString('utf8'))));
    path=await rasterize(source,`${base}.png`);
  } else {const source=`${base}.${type}`;writeFileSync(source,body);path=await rasterize(source,`${base}.png`);}
  const size=imageSize(readFileSync(path));
  if(!size||size.width<limit.minSide||size.height<limit.minSide)throw new Error('Слишком маленькое изображение.');
  return {path,width:size.width,height:size.height};
}

// Opens up to three pages and downloads the best candidates. Cancel and the deadline abort requests in flight;
// the total download budget is checked before every request, not after.
export async function scoutSites(urls,{dir,fetcher=safeFetch,rasterize=sipsToPng,limits={},shouldStop=()=>false,onProgress=()=>{}}={}) {
  const limit={...LIMITS,...limits},budget={used:0},controller=new AbortController(),signal=controller.signal;
  const deadline=setTimeout(()=>controller.abort(),limit.deadlineMs);
  const watch=setInterval(()=>{if(shouldStop())controller.abort();},500);
  const alive=()=>!signal.aborted&&!shouldStop();
  const left=()=>limit.totalBytes-budget.used;
  const account=bytes=>{budget.used+=bytes;};
  const pages=[],pool=[],assets=[];
  try {
    mkdirSync(dir,{recursive:true,mode:0o700});
    for(const url of urls.slice(0,3)) {
      if(!alive())break;
      if(left()<=0){pages.push({url,status:'error',error:'Превышен общий объём загрузки.'});continue;}
      onProgress(`Смотрит ${hostOf(url)}`);
      try {
        const page=await fetcher(url,{maxBytes:Math.min(limit.pageBytes,left()),accept:'text/html,application/xhtml+xml,image/*;q=0.8',timeoutMs:limit.timeoutMs,signal});
        account(page.body.length);
        if(sniffImage(page.body)){pool.push({url:page.url,kind:'direct',label:'Картинка по ссылке',pageUrl:page.url,body:page.body});pages.push({url,finalUrl:page.url,title:'',status:'ok'});continue;}
        const info=extractPage(page.body.toString('utf8'),page.url);
        pages.push({url,finalUrl:page.url,title:info.title,description:info.description,text:info.text,status:'ok'});
        for(const candidate of info.candidates)pool.push({...candidate,pageUrl:page.url});
        info.svgs.forEach((svg,index)=>pool.push({...svg,kind:'svg',url:`${page.url}#svg-${index+1}`,pageUrl:page.url}));
      } catch(error) {pages.push({url,status:'error',error:String(error.message||error)});}
    }
    for(const candidate of rankCandidates(pool,limit.images*2)) {
      if(assets.length>=limit.images||!alive())break;
      if(candidate.kind!=='svg'&&!candidate.body&&left()<=1024)continue;
      try {
        onProgress(`Забирает картинки с ${hostOf(candidate.pageUrl)}`);
        const file=await materialize(candidate,{fetcher,rasterize,dir,index:assets.length+1,limit,account,left,signal});
        assets.push({...file,sourceUrl:candidate.kind==='svg'?candidate.pageUrl:candidate.url,pageUrl:candidate.pageUrl,label:candidate.label||'',kind:candidate.kind});
      } catch {/* a broken, oversized or stopped candidate is skipped */}
    }
    return {pages,assets};
  } finally {clearTimeout(deadline);clearInterval(watch);}
}
