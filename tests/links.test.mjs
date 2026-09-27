import {test} from 'node:test';
import assert from 'node:assert/strict';
import {markdownLinksToEntities,hasMarkdownLinks} from '../src/shared/links.mjs';
import {validateEntities,partsFor,publicationIssues,assertNotScheduled,assertImageFree} from '../src/domain.mjs';

test('markdown links become text_link entities',()=>{
 const result=markdownLinksToEntities('Скачайте [Example](https://www.example-app.com/) сейчас');
 assert.equal(result.text,'Скачайте Example сейчас');assert.equal(result.converted,1);
 assert.deepEqual(result.entities,[{type:'text_link',offset:9,length:7,url:'https://www.example-app.com/'}]);
});
test('existing formatting shifts and shrinks with converted links',()=>{
 const text='[А](https://a.example) и [Б](https://b.example/x_(y)) конец';
 const bold={type:'bold',offset:0,length:text.indexOf(' и')};
 const tail={type:'italic',offset:text.indexOf('конец'),length:5};
 const result=markdownLinksToEntities(text,[bold,tail]);
 assert.equal(result.text,'А и Б конец');
 assert.deepEqual(result.entities.find(e=>e.type==='bold'),{type:'bold',offset:0,length:1});
 assert.deepEqual(result.entities.find(e=>e.type==='italic'),{type:'italic',offset:6,length:5});
 assert.deepEqual(result.entities.filter(e=>e.type==='text_link').map(e=>[e.offset,e.length,e.url]),[[0,1,'https://a.example'],[4,1,'https://b.example/x_(y)']]);
 assert.doesNotThrow(()=>validateEntities(result.text,result.entities));
});
test('text without markdown links is untouched',()=>{
 const entities=[{type:'bold',offset:0,length:3}];
 const result=markdownLinksToEntities('Нет ссылок [тут]',entities);
 assert.equal(result.converted,0);assert.equal(result.text,'Нет ссылок [тут]');assert.deepEqual(result.entities,entities);
 assert.equal(hasMarkdownLinks('см. [сайт](https://x.example)'),true);assert.equal(hasMarkdownLinks('см. https://x.example'),false);
});
test('text_link entities are validated and survive message splitting',()=>{
 assert.throws(()=>validateEntities('Ссылка',[{type:'text_link',offset:0,length:6,url:'javascript:alert(1)'}]),/http/);
 assert.throws(()=>validateEntities('Ссылка',[{type:'text_link',offset:0,length:6,url:'https://a.example'},{type:'text_link',offset:1,length:2,url:'https://b.example'}]),/пересекаются/);
 const text='я'.repeat(4090)+' ссылка '+'я'.repeat(100);
 const parts=partsFor({text,entities:[{type:'text_link',offset:4091,length:6,url:'https://a.example'}]});
 assert.equal(parts.find(part=>part.entities?.length).entities[0].url,'https://a.example');
});
test('publication waits for running agents and converted links; scheduled and image-busy cards are guarded',()=>{
 const settings={verified:true,destinationType:'channel',topics:{}};
 assert.match(publicationIssues({text:'Т',topic:'main',status:'review',job:{kind:'image',status:'running'}},settings).join(' '),/агента/);
 assert.match(publicationIssues({text:'См. [сайт](https://x.example)',topic:'main',status:'review'},settings).join(' '),/Markdown/);
 assert.throws(()=>assertNotScheduled({status:'scheduled',schedule:{status:'scheduled'}}),/запланирована/);
 assert.doesNotThrow(()=>assertNotScheduled({status:'approved',schedule:{status:'cancelled'}}));
 assert.throws(()=>assertImageFree({job:{kind:'image',status:'running'}}),/рисует/);
 assert.doesNotThrow(()=>assertImageFree({job:{kind:'text',status:'running'}}));
});
test('links Telegram would refuse keep only their label instead of failing the text',()=>{
 const text='Вход [тут](https://user:pw@x.example/) и [там](https://x.example:99999/) и [здесь](https://ok.example/)';
 const result=markdownLinksToEntities(text);
 assert.equal(result.text,'Вход тут и там и здесь');assert.equal(result.converted,3);
 assert.deepEqual(result.entities,[{type:'text_link',offset:17,length:5,url:'https://ok.example/'}]);
 assert.doesNotThrow(()=>validateEntities(result.text,result.entities));
});
