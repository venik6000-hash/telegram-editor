import {test} from 'node:test';
import assert from 'node:assert/strict';
import {diffWords,diffStats} from '../public/js/diff.js';

test('word diff marks only the changed words and keeps the text intact',()=>{
 const parts=diffWords('Скачайте Example сегодня бесплатно','Скачайте Example завтра бесплатно');
 assert.deepEqual(parts,[{type:'same',text:'Скачайте Example '},{type:'removed',text:'сегодня'},{type:'added',text:'завтра'},{type:'same',text:' бесплатно'}]);
 assert.equal(parts.filter(p=>p.type!=='added').map(p=>p.text).join(''),'Скачайте Example сегодня бесплатно');
 assert.equal(parts.filter(p=>p.type!=='removed').map(p=>p.text).join(''),'Скачайте Example завтра бесплатно');
 assert.deepEqual(diffStats(parts),{added:1,removed:1});
});
test('empty sides and identical texts',()=>{
 assert.deepEqual(diffWords('','Новый текст'),[{type:'added',text:'Новый текст'}]);
 assert.deepEqual(diffWords('Старый',''),[{type:'removed',text:'Старый'}]);
 assert.deepEqual(diffWords('Тот же\nтекст','Тот же\nтекст'),[{type:'same',text:'Тот же\nтекст'}]);
});
test('long rewrites stay fast',()=>{
 const before=Array.from({length:3000},(_,i)=>`слово${i}`).join(' '),after=Array.from({length:3000},(_,i)=>`другое${i}`).join(' ');
 const started=Date.now();const parts=diffWords(before,after);
 assert.ok(Date.now()-started<2000);
 assert.equal(parts.filter(p=>p.type!=='added').map(p=>p.text).join(''),before);
});
