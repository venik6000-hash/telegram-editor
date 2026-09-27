import {test} from 'node:test';
import assert from 'node:assert/strict';
import {historyEntries,changeLabel,changedFields} from '../public/js/history.js';

test('history labels say who changed what, newest first, including old snapshots without records',()=>{
 const post={revision:5,title:'Т',brief:'',text:'Три',entities:[],image:{name:'b.png',url:'/media/b.png'},updatedAt:'2026-09-26T12:00:00.000Z',
  lastChange:{origin:'variant',at:'2026-09-26T12:00:00.000Z',fields:['image']},
  history:[
   {revision:1,title:'Т',brief:'',text:'',entities:[],image:null,savedAt:'2026-09-20T10:00:00.000Z'},
   {revision:2,title:'Т',brief:'',text:'Один',entities:[],image:null,savedAt:'2026-09-21T10:00:00.000Z'},
   {revision:3,title:'Т',brief:'',text:'Один',entities:[],image:{name:'a.png',url:'/media/a.png'},savedAt:'2026-09-22T10:00:00.000Z',change:{origin:'agent',fields:['image'],instruction:'Возьми лого с сайта',at:'2026-09-22T10:00:00.000Z'}},
   {revision:4,title:'Т',brief:'',text:'Три',entities:[],image:{name:'a.png',url:'/media/a.png'},savedAt:'2026-09-23T10:00:00.000Z',change:{origin:'manual',fields:['text'],by:'Local owner',at:'2026-09-23T10:00:00.000Z'}},
  ]};
 const entries=historyEntries(post,{userName:'Local owner'});
 assert.deepEqual(entries.map(e=>[e.revision,e.label,e.current]),[[5,'Вариант картинки',true],[4,'Вы · текст',false],[3,'Агент · картинка',false],[2,'Правка · текст',false],[1,'Создание',false]]);
 assert.equal(entries[2].instruction,'Возьми лого с сайта');assert.equal(entries[2].imageChanged,true);assert.equal(entries[1].imageChanged,false);
 assert.equal(changeLabel({origin:'manual',by:'Аня'},['text','title'],{userName:'Ольга'}),'Аня · текст, название');
 assert.deepEqual(changedFields({text:'a',entities:[]},{text:'a',entities:[{type:'bold',offset:0,length:1}]}),['text']);
});
