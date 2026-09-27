import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {isPublicAddress,assertFetchable,guardedLookup,extractPage,rankCandidates,scoutSites,sanitizeSvg,sizedSvg,imageSize,sniffImage,sipsToPng} from '../src/site-scout.mjs';
import {makePng} from './helpers/png.mjs';

test('only public addresses are allowed',()=>{
 for(const address of ['127.0.0.1','10.1.2.3','172.20.0.1','192.168.1.10','169.254.169.254','100.64.0.1','0.0.0.0','224.0.0.1','::1','::','fe80::1','fc00::1','::ffff:127.0.0.1','::ffff:7f00:1','2001:db8::1'])assert.equal(isPublicAddress(address),false,address);
 for(const address of ['8.8.8.8','1.1.1.1','2606:4700:4700::1111','2a00:1450:4001:80b::200e'])assert.equal(isPublicAddress(address),true,address);
 assert.equal(isPublicAddress('example.com'),false);
});
test('links to local and non-http targets are refused before any request',()=>{
 for(const url of ['http://127.0.0.1:4317/api/state','http://localhost/','http://printer.local/','ftp://example.com/','http://user:pass@example.com/','http://[::1]/','http://169.254.169.254/latest'])assert.throws(()=>assertFetchable(url),Error,url);
 assert.equal(assertFetchable('https://example-app.com/').hostname,'example-app.com');
});
test('DNS answers that point inside the network are refused at connect time',async()=>{
 const error=await new Promise(resolve=>guardedLookup('localhost',{all:true},resolve));
 assert.equal(error?.code,'EPRIVATE');
});
const PAGE=`<html><head><title>Example — voice to text</title><meta name="description" content="Dictation for Mac">
<meta property="og:image" content="https://www.example-app.com/og-image.png"/><meta property="og:image:alt" content="Example app icon"/>
<link rel="icon" href="/favicon-16x16.png" sizes="16x16"/><link rel="icon" href="/android-chrome-512x512.png" sizes="512x512"/><link rel="apple-touch-icon" href="/apple-touch-icon.png"/>
</head><body><header><a class="logo" href="/"><svg viewBox="0 0 120 40" aria-label="Example logo"><circle cx="20" cy="20" r="16"/><script>alert(1)</script></svg></a></header>
<main><h1>Говорите — текст появляется</h1><img alt="Example app interface" src="/_next/image?url=%2Fscreens%2Fapp.png&amp;w=3840&amp;q=75" width="1624" height="1924"><img src="/tiny.png" width="16" height="16"></main></body></html>`;
test('page extraction finds logo, icons, social image and large pictures',()=>{
 const page=extractPage(PAGE,'https://www.example-app.com/');
 assert.equal(page.title,'Example — voice to text');assert.equal(page.description,'Dictation for Mac');
 assert.match(page.text,/Говорите/);
 const urls=page.candidates.map(item=>item.url);
 assert.ok(urls.includes('https://www.example-app.com/og-image.png'));
 assert.ok(urls.includes('https://www.example-app.com/android-chrome-512x512.png'));
 assert.ok(urls.includes('https://www.example-app.com/screens/app.png'));
 assert.equal(page.svgs.length,1);
 const ranked=rankCandidates([...page.candidates,{kind:'svg',url:'https://www.example-app.com/#svg-1',label:'Логотип со страницы (SVG)',hint:'logo'}]);
 assert.ok(!ranked.some(item=>item.url.endsWith('favicon-16x16.png')));
 assert.ok(!ranked.some(item=>item.url.endsWith('tiny.png')));
 assert.ok(ranked.findIndex(item=>item.kind==='svg')<ranked.findIndex(item=>item.url.endsWith('screens/app.png')));
});
test('svg is cleaned of scripts and external references and gets a raster size',()=>{
 const clean=sanitizeSvg('<svg viewBox="0 0 120 40" onload="x()"><script>alert(1)</script><image href="https://evil.example/a.png"/><use href="#a"/><rect style="fill:url(https://evil.example/f)"/></svg>');
 assert.doesNotMatch(clean,/script|onload|evil\.example/);assert.match(clean,/href="#a"/);
 const sized=sizedSvg(clean);
 assert.match(sized,/width="1024"/);assert.match(sized,/height="341"/);assert.match(sized,/xmlns=/);
});
test('scout downloads ranked candidates through the injected fetcher and records failures',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'editor-scout-'));
 const files={
  'https://www.example-app.com/':{contentType:'text/html',body:Buffer.from(PAGE)},
  'https://www.example-app.com/og-image.png':{contentType:'image/png',body:makePng(1200,630)},
  'https://www.example-app.com/android-chrome-512x512.png':{contentType:'image/png',body:makePng(512,512)},
  'https://www.example-app.com/apple-touch-icon.png':{contentType:'image/png',body:makePng(180,180)},
  'https://www.example-app.com/screens/app.png':{contentType:'text/html',body:Buffer.from('<html>not an image</html>')},
 };
 const fetcher=async url=>{const file=files[url];if(!file)throw new Error('404');return {url,...file};};
 const rasterize=async(input,output)=>{writeFileSync(output,makePng(1024,341));return output;};
 const result=await scoutSites(['https://www.example-app.com/','https://down.example/'],{dir,fetcher,rasterize});
 assert.equal(result.pages[0].status,'ok');assert.equal(result.pages[1].status,'error');
 assert.equal(result.assets.length,4);
 assert.ok(result.assets.every(asset=>existsSync(asset.path)&&asset.width>=48));
 assert.ok(result.assets.some(asset=>asset.kind==='svg'&&asset.path.endsWith('.png')));
 assert.ok(!result.assets.some(asset=>asset.sourceUrl.endsWith('screens/app.png')));
});
test('scout respects the total download budget',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'editor-scout-budget-'));
 const big=makePng(1200,630);
 const fetcher=async url=>url.endsWith('/')?{url,contentType:'text/html',body:Buffer.from(PAGE)}:{url,contentType:'image/png',body:big};
 const result=await scoutSites(['https://www.example-app.com/'],{dir,fetcher,rasterize:async(i,o)=>{writeFileSync(o,makePng(64,64));return o;},limits:{totalBytes:Buffer.byteLength(PAGE)+big.length+10}});
 assert.equal(result.assets.filter(asset=>asset.kind!=='svg').length,1);
});
test('image sizes are read from PNG headers and file types are sniffed',()=>{
 assert.deepEqual(imageSize(makePng(300,200)),{width:300,height:200});
 assert.equal(sniffImage(makePng(10,10)),'png');
 assert.equal(sniffImage(Buffer.from('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"></svg>')),'svg');
 assert.equal(sniffImage(Buffer.from('<!DOCTYPE html><html><svg></svg></html>')),null);
});
test('sips turns svg into png on macOS',{skip:process.platform!=='darwin'},async()=>{
 const dir=mkdtempSync(join(tmpdir(),'editor-sips-'));const input=join(dir,'logo.svg');
 writeFileSync(input,sizedSvg('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 40"><circle cx="20" cy="20" r="16" fill="#1E45FB"/></svg>'));
 const output=await sipsToPng(input,join(dir,'logo.png'));
 assert.deepEqual(imageSize(readFileSync(output)),{width:1024,height:341});
});
test('hostile markup is parsed in linear time',()=>{
 const pages=['<img '+'a'.repeat(400000)+'>','<svg '.repeat(100000),'<body '.repeat(100000),'<meta'.repeat(100000),'<script>'.repeat(60000),'<main '.repeat(100000),'<title>'+'<'.repeat(300000)];
 for(const html of pages){const started=Date.now();extractPage(html,'https://x.example/');assert.ok(Date.now()-started<1500,html.slice(0,12));}
 const started=Date.now();sanitizeSvg('<svg viewBox="0 0 10 10">'+'url('.repeat(100000)+'<script>'.repeat(30000)+'<a href="'.repeat(30000)+'</svg>');
 assert.ok(Date.now()-started<1500);
});
test('svg cleanup keeps case-sensitive names and drops namespaced links, styles and doctype',()=>{
 const clean=sanitizeSvg('<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY x SYSTEM "file:///etc/passwd">]><svg viewBox="0 0 10 10" xmlns:x="http://www.w3.org/1999/xlink"><style>@import url(https://evil.example/a.css);</style><linearGradient id="g"/><image x:href="https://evil.example/a.png"/><rect fill="url(#g)" style="fill:url(https://evil.example/f)"/><animate attributeName="href" to="https://evil.example"/></svg>');
 assert.doesNotMatch(clean,/evil\.example|DOCTYPE|ENTITY|passwd|<style|<\?xml|<animate/);
 assert.ok(clean.startsWith('<svg viewBox="0 0 10 10"'));assert.match(clean,/<linearGradient id="g"\/>/);assert.match(clean,/<rect fill="url\(#g\)"\/>/);
});
test('cancel aborts a request in flight; a spent budget stops further downloads',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'editor-scout-abort-'));let stop=false;
 const hanging=(url,{signal})=>new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(new Error('aborted'))));
 setTimeout(()=>{stop=true;},100);
 const started=Date.now();
 const stopped=await scoutSites(['https://a.example/'],{dir,fetcher:hanging,shouldStop:()=>stop});
 assert.ok(Date.now()-started<2000);assert.equal(stopped.pages[0].status,'error');
 const requested=[];
 const fetcher=async(url,{maxBytes})=>{requested.push([url,maxBytes]);return url.endsWith('/')?{url,body:Buffer.from(PAGE)}:{url,body:makePng(600,600)};};
 const size=Buffer.byteLength(PAGE);
 await scoutSites(['https://www.example-app.com/'],{dir:join(dir,'b'),fetcher,rasterize:async(i,o)=>{writeFileSync(o,makePng(64,64));return o;},limits:{totalBytes:size+2000}});
 assert.equal(requested[1][1],2000);
 assert.ok(requested.length<=2,'no downloads once the budget is spent');
});
