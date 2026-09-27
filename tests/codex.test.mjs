import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseResult,CODEX_PATHS} from '../src/codex.mjs';

test('ready=false is an agent question, not a crash',()=>{
 const error=(()=>{try{parseResult('{"ready":false,"text":"","sources":[],"needsInput":"Какой тариф упомянуть?"}','text');}catch(e){return e;}})();
 assert.equal(error.question,'Какой тариф упомянуть?');assert.equal(error.message,'Какой тариф упомянуть?');
});
test('image result keeps the numbers of used attachments and the note',()=>{
 const result=parseResult('{"ready":true,"needsInput":"","imagePath":"/tmp/a.png","usedAssets":[2,2,"x",3],"note":"Логотип с сайта"}','image');
 assert.deepEqual(result.usedAssets,[2,3]);assert.equal(result.note,'Логотип с сайта');
 assert.deepEqual(parseResult('{"ready":true,"needsInput":"","imagePath":"/tmp/a.png"}','image').usedAssets,[]);
});
test('duplicate checks accept this edition\'s card ids; the CLI is looked up in the current ChatGPT layout first',()=>{
 assert.deepEqual(parseResult(JSON.stringify({ready:true,duplicateIds:['POST-017'],reason:'Уже было'}),'duplicates').duplicateIds,['POST-017']);
 assert.throws(()=>parseResult(JSON.stringify({ready:true,duplicateIds:['../etc'],reason:''}),'duplicates'),/некорректный/);
 assert.equal(CODEX_PATHS[0],'/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex');
});
