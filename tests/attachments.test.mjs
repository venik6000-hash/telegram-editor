import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,existsSync,statSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Attachments} from '../src/attachments.mjs';
import {makePng} from './helpers/png.mjs';

test('attachments are private per card and found by id with their label',()=>{
 const dir=mkdtempSync(join(tmpdir(),'editor-attachments-'));
 const attachments=new Attachments(dir,'default');
 const saved=attachments.fromDataUrl('POST-300',`data:image/png;base64,${makePng(64,64).toString('base64')}`,'logo.png');
 assert.match(saved.name,/^[a-f0-9-]{36}\.png$/);assert.equal(saved.label,'logo.png');assert.equal(saved.source,'upload');
 assert.equal(saved.url,`/api/posts/POST-300/attachments/${saved.name}?project=default`);
 const path=attachments.resolve('POST-300',saved.name);
 assert.ok(existsSync(path));assert.equal(statSync(path).mode&0o777,0o600);
 const found=attachments.byId('POST-300',saved.id);assert.equal(found.path,path);assert.equal(found.label,'logo.png');
 assert.throws(()=>attachments.byId('POST-301',saved.id),/не найдено/);
 assert.throws(()=>attachments.resolve('POST-300','../editor.sqlite'),/не найдено/);
 assert.throws(()=>attachments.fromDataUrl('POST-300','data:image/gif;base64,R0lGOD'),/PNG/);
 assert.throws(()=>attachments.save('POST-300',Buffer.from('<svg></svg>')),/PNG/);
 const source=join(dir,'site.png');writeFileSync(source,makePng(100,50));
 const site=attachments.fromFile('POST-300',source,{label:'Логотип',source:'site',sourceUrl:'https://example.com/logo.png'});
 assert.equal(attachments.byId('POST-300',site.id).sourceUrl,'https://example.com/logo.png');
});
