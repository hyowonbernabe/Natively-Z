// Personal build: my-context.md loading + selection (electron/llm/myContext).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = (rel) => pathToFileURL(path.resolve(here, '../../../dist-electron/electron', rel)).href;
const { readMyContext, selectMyContext, buildMyContextBlock } = await import(dist('llm/myContext.js'));

const FILE = `# Me
My name is Hyowon. I built Messenger Z.

## Story: Scaling the chat backend
Moved Messenger Z from one server to sharded Postgres under load.

## Story: Conflict with a teammate
Disagreed on release scope; we split the launch.
`;

test('missing or empty file -> no block (stock behaviour)', () => {
  assert.equal(readMyContext(path.join(os.tmpdir(), 'nope-does-not-exist.md')), '');
  assert.equal(buildMyContextBlock('tell me about yourself', null), '');
  assert.deepEqual(selectMyContext('   ', 'q'), { content: '', stories: [] });
});

test('small file is sent whole', () => {
  const r = selectMyContext(FILE, 'tell me about yourself');
  assert.equal(r.content, FILE.trim());
  assert.equal(r.stories.length, 2);
});

test('over the cap: head always included; only matching stories added', () => {
  const r = selectMyContext(FILE, 'tell me about a conflict with a teammate', 200);
  assert.match(r.content, /My name is Hyowon/);
  assert.match(r.content, /split the launch/);
  assert.doesNotMatch(r.content, /sharded Postgres/);
  assert.deepEqual(r.stories, ['Conflict with a teammate']);
});

test('cap respected: oversized stories skipped, oversized head truncated', () => {
  const big = FILE + `\n## Story: Conflict marathon\n${'conflict '.repeat(2000)}`;
  const r = selectMyContext(big, 'conflict', 400);
  assert.ok(r.content.length <= 400);
  assert.deepEqual(r.stories, ['Conflict with a teammate']);
  assert.equal(selectMyContext('x'.repeat(9000), 'q', 500).content.length, 500);
});

test('file is read and wrapped in its own block', () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'myctx-')), 'my-context.md');
  fs.writeFileSync(f, FILE);
  const block = buildMyContextBlock('tell me about yourself', f);
  assert.match(block, /^<user_personal_context>/);
  assert.match(block, /I built Messenger Z/);
  assert.match(block, /<\/user_personal_context>$/);
});

test('tags + word forms match; trailing non-story section always pinned; max 3 stories', () => {
  const doc = `# Me
Core facts.

## Story: Blocking an intern's PR
Tags: disagreement, pushing back
Body one.

## Story: Shipped the wrong model
Tags: failure, mistake
Body two.

## Story: Onboarding interns
Tags: mentoring, leadership
Body three.

## Story: Election system
Tags: leadership, ownership
Body four.

## Story: Portal changes
Tags: client, leadership
Body five.

## Story: Outage night
Tags: leadership, incident
Body six.

## Quick answers
Why AI: because.
`;
  const cap = doc.trim().length - 1; // force ranking
  const a = selectMyContext(doc, 'Tell me about a time you disagreed with someone', cap);
  assert.deepEqual(a.stories, ["Blocking an intern's PR"]);
  assert.match(a.content, /## Quick answers\nWhy AI: because\./);
  assert.match(selectMyContext(doc, 'Describe a time you failed', cap).content, /Body two/);
  assert.match(selectMyContext(doc, 'when did you mentor someone', cap).content, /Body three/);
  assert.equal(selectMyContext(doc, 'a time you led a team', cap).stories.length, 3);
});
