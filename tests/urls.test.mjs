import {test} from 'node:test';
import assert from 'node:assert/strict';
import {findUrls} from '../src/shared/urls.mjs';

test('finds explicit and bare site addresses, at most three',()=>{
 assert.deepEqual(findUrls('Вот сайт example-app.com, возьми лого'),['https://example-app.com/']);
 assert.deepEqual(findUrls('См. https://www.example-app.com/press?lang=ru.'),['https://www.example-app.com/press?lang=ru']);
 assert.deepEqual(findUrls('www.example.org и example.com/logo.png'),['https://www.example.org/','https://example.com/logo.png']);
 assert.equal(findUrls('a.com b.com c.com d.com').length,3);
});
test('ignores file names, versions, e-mails and duplicates',()=>{
 assert.deepEqual(findUrls('Открой logo.png и README.md, модель gpt-5.6-terra, версия v1.2, т.е. e.g.'),[]);
 assert.deepEqual(findUrls('Пиши на team@example.com'),[]);
 assert.deepEqual(findUrls('example.com и https://example.com/'),['https://example.com/']);
 assert.deepEqual(findUrls('ftp://example.com javascript:alert(1)'),[]);
});
