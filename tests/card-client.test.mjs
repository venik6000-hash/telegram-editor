import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {composition} from '../public/js/publish-dialog.js';

// card.js imports browser-only modules (/shared/…), so the pure helper is checked from the source.
test('message count mirrors the server split and composition names what goes out',async()=>{
 const source=readFileSync(new URL('../public/js/card.js',import.meta.url),'utf8');
 const helper=source.match(/export function messageCount\(text\) \{[\s\S]*?\n\}\n/)[0].replace('export ','');
 const messageCount=new Function(`${helper};return messageCount;`)();
 const {partsFor}=await import('../src/domain.mjs');
 for(const text of ['Коротко','я'.repeat(4096),'я'.repeat(4097),`${'слово '.repeat(1500)}`,`${'а'.repeat(3000)}\n${'б'.repeat(3000)}`])assert.equal(messageCount(text),partsFor({text,image:null}).length,text.length);
 assert.equal(composition([{type:'photo',url:'/m',caption:'Подпись'}]),'Фото с подписью');
 assert.equal(composition([{type:'photo',url:'/m',caption:''},{type:'text',text:'a'},{type:'text',text:'b'}]),'Фото и 2 сообщения');
 assert.equal(composition([{type:'text',text:'a'}]),'1 сообщение');
});
