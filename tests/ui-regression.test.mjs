import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const appSource = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');

test('switching or creating a project and logging in first save the open card', () => {
  const block = (pattern) => { const match = appSource.match(pattern); assert.ok(match, `${pattern} must remain present`); return match[0]; };
  assert.match(block(/async function switchProject\([\s\S]*?\n}\n/), /if \(!\(await card\.leave\(\)\)\) \{[^}]*return false; \}\s*state\.projectId = projectId;/);
  assert.match(block(/async function saveProject\(\) \{[\s\S]*?\n}\n/), /if \(creating && !\(await card\.leave\(\)\)\) return;[\s\S]*state\.projectId = project\.id;/);
  assert.match(block(/async function submitTeam\(\) \{[\s\S]*?\n}\n/), /if \(!state\.projects\.some\(\(project\) => project\.id === state\.projectId\)\) \{\s*await card\.leave\(\);\s*state\.projectId =/);
  assert.match(block(/async function selectPost\([\s\S]*?\n}\n/), /if \(!\(await card\.leave\(\)\)\) return;/);
});

test('the card has no manual save button and every id used by the modules exists once', () => {
  assert.doesNotMatch(html, /id="save-button"|Сохранить изменения/);
  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);
  assert.equal(new Set(ids).size, ids.length, 'ids must be unique');
  const used = new Set();
  for (const file of ['card.js', 'agent-panel.js', 'history.js', 'publish-dialog.js']) {
    const source = readFileSync(new URL(`../public/js/${file}`, import.meta.url), 'utf8');
    for (const match of source.matchAll(/\$\("([a-z-]+)"\)/g)) used.add(match[1]);
    const list = source.match(/const IDS = \[([^\]]+)\]/);
    if (list) for (const match of list[1].matchAll(/"([a-z-]+)"/g)) used.add(match[1]);
  }
  for (const id of used) assert.ok(ids.includes(id), `missing #${id}`);
});
