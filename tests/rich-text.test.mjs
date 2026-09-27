import {test} from 'node:test';
import assert from 'node:assert/strict';
import {canonicalEntities} from '../public/rich-text.js';
import {validateEntities} from '../src/domain.mjs';

test('overlapping selections become valid Telegram nesting without changing covered characters',()=>{
 const original=[{type:'bold',offset:0,length:8},{type:'spoiler',offset:5,length:10},{type:'blockquote',offset:3,length:10}];
 const result=canonicalEntities(original);
 assert.doesNotThrow(()=>validateEntities('a'.repeat(20),result));
 for(const type of ['bold','spoiler','blockquote'])for(let i=0;i<20;i++)assert.equal(result.some(e=>e.type===type&&e.offset<=i&&e.offset+e.length>i),original.some(e=>e.type===type&&e.offset<=i&&e.offset+e.length>i));
});
test('links keep their address, merge only with the same address and never overlap',()=>{
 const merged=canonicalEntities([{type:'text_link',offset:0,length:4,url:'https://a.example/'},{type:'text_link',offset:4,length:3,url:'https://a.example/'},{type:'text_link',offset:5,length:5,url:'https://b.example/'},{type:'bold',offset:2,length:6}]);
 assert.deepEqual(merged.filter(e=>e.type==='text_link').map(e=>[e.offset,e.length,e.url]),[[0,2,'https://a.example/'],[2,5,'https://a.example/'],[7,1,'https://b.example/'],[8,2,'https://b.example/']]);
 assert.doesNotThrow(()=>validateEntities('a'.repeat(12),merged));
});
