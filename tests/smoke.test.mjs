import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {EditorDatabase} from '../src/database.mjs';
import {promptFor} from '../src/prompts.mjs';
import {editorAgentArgs} from '../src/codex.mjs';
import {createApp} from '../src/server.mjs';

test('starts with a generic project and never inherits a publisher profile', t => {
  const directory=mkdtempSync(join(tmpdir(),'telegram-editor-'));
  const database=new EditorDatabase(join(directory,'editor.sqlite'));
  t.after(()=>database.close());
  const project=database.getProject('default');
  assert.equal(project.name,'Мой проект');
  assert.equal(project.topics.length,1);
  assert.equal('schoolId' in project,false);
  assert.equal('brandProfile' in project,false);
});

test('generation prompt requires the project voice and visual style instead of guessing', () => {
  const project={id:'garden',name:'Сад',language:'ru',audience:'Начинающие садоводы',voice:'',visualStyle:'',examples:'',instructions:'',topics:[{id:'plants',name:'Растения'}]};
  const text=promptFor({kind:'text',project,post:{topic:'plants',title:'Томаты',brief:'Полив',text:''}});
  const image=promptFor({kind:'image',project,post:{topic:'plants',title:'Томаты',brief:'Полив',text:'Готовый текст'}});
  assert.match(text,/заполнить «Голос»/);
  assert.match(image,/заполнить «Визуальный стиль»/);
});

test('Codex run is pinned to the signed-in ChatGPT account, not a fixed model or API key', () => {
  const args=editorAgentArgs({jobDir:'/tmp/job',schema:'/tmp/schema.json',output:'/tmp/result.json'});
  assert.ok(args.includes('forced_login_method="chatgpt"'));
  assert.equal(args.includes('--model'),false);
  assert.equal(args.includes('--with-api-key'),false);
});

test('local server exposes the generic health endpoint and accepts its own request header', async t => {
  const directory=mkdtempSync(join(tmpdir(),'telegram-editor-server-'));
  const app=createApp({dataDir:directory,mediaDir:join(directory,'media')});
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  t.after(()=>app.server.close());
  const base=`http://127.0.0.1:${app.server.address().port}`;
  const health=await fetch(base+'/api/health');
  assert.deepEqual(await health.json(),{app:'telegram-editor',version:1});
  const page=await fetch(base+'/');
  assert.match(await page.text(),/Настройки редакции/);
  const setup=await fetch(base+'/api/team/setup',{method:'POST',headers:{'Content-Type':'application/json','X-Editor-Request':'editor'},body:JSON.stringify({name:'Owner',password:'a-long-test-password'})});
  assert.equal(setup.status,200);
  const cookie=setup.headers.get('set-cookie').split(';')[0];
  const post=await fetch(base+'/api/posts',{method:'POST',headers:{'Content-Type':'application/json','X-Editor-Request':'editor','X-Editor-Project':'default',Cookie:cookie},body:JSON.stringify({topic:'main',title:'Первая публикация',brief:'Проверка универсальной карточки'})});
  assert.equal(post.status,201);
  assert.equal((await post.json()).id,'POST-001');
});
