// Personal build: my-context.md loading + selection (electron/llm/myContext).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = (rel) => pathToFileURL(path.resolve(here, '../../../dist-electron/electron', rel)).href;
const { readMyContext, selectMyContext, buildMyContextBlock, splitMyContext, renderMyContextBlock, resolveOutputStyleConfig, MY_CONTEXT_MAX_CHARS } = await import(dist('llm/myContext.js'));

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

test('speaking preferences become answer instructions, separate from factual grounding', () => {
  const text = '# Me\nI built Messenger Z.\n\n## How to answer for me\nUse simple words.\n\n## Quick answers\nWhy AI: I enjoy building.';
  const block = renderMyContextBlock(text, 'Explain how rain forms.', false, false, splitMyContext(text).voice);
  const [background, style] = block.split('<user_response_style>');
  assert.match(background, /I built Messenger Z/);
  assert.doesNotMatch(background, /Use simple words/);
  assert.match(style, /Use simple words/);
  assert.match(style, /even when the question is unrelated/);
  assert.match(style, /not facts to quote or summarize/);
  assert.match(style, /Apply the style to explanations, not code or structured data/);
});

test('voice survives oversized background and late placement in the document', () => {
  const text = `# Me\n${'Background fact. '.repeat(1500)}\n\n## How I sound\nKeep it conversational.`;
  const block = renderMyContextBlock(text, 'What is caching?', false, false, splitMyContext(text).voice);
  assert.match(block, /<user_response_style>[\s\S]*Keep it conversational\./);
  const parts = splitMyContext(text);
  const content = selectMyContext(parts.facts, '', MY_CONTEXT_MAX_CHARS - parts.voice.length).content;
  assert.ok(content.length + parts.voice.length <= MY_CONTEXT_MAX_CHARS);
});

test('stories mentioning speaking remain evidence; multiple style headings and CRLF work', () => {
  const text = '## Story: Speaking to a client\r\nI delivered a presentation.\r\n\r\n## Voice\r\nShort sentences.\r\n\r\n## Tone\r\nWarm.\r\n\r\n### Examples\r\nI made it faster.';
  const { facts, voice } = splitMyContext(text);
  assert.match(facts, /I delivered a presentation/);
  assert.doesNotMatch(voice, /I delivered a presentation/);
  assert.match(voice, /Short sentences/);
  assert.match(voice, /I made it faster/);
});

test('voice-only coding path excludes biography and stories, retains precision and format', () => {
  const text = `${FILE}\n## How I sound\nPlain words.`;
  const block = renderMyContextBlock(text, '', true, false, 'Plain words.');
  assert.match(block, /^<user_response_style>/);
  assert.doesNotMatch(block, /Messenger Z|sharded Postgres|user_personal_context/);
  assert.match(block, /necessary technical precision/);
  assert.match(block, /explicit code, JSON or other output formats/);
});

test('Output Style controls wording without a context file or personal facts', () => {
  const block = renderMyContextBlock('', 'Explain caching.', false, false, 'Use short sentences and everyday words.');
  assert.match(block, /<user_response_style>/);
  assert.match(block, /Use short sentences and everyday words/);
  assert.doesNotMatch(block, /<user_personal_context>/);
});

test('saved Output Style replaces legacy voice; blank/disabled choices never restore it', () => {
  const text = `${FILE}\n## How I sound\nUse long, technical sentences.`;
  const block = renderMyContextBlock(text, 'q', false, false, 'Use simple words.');
  assert.match(block, /Use simple words/);
  assert.doesNotMatch(block, /Use long, technical sentences/);
  assert.doesNotMatch(renderMyContextBlock(text, 'q'), /<user_response_style>/);
  assert.deepEqual(resolveOutputStyleConfig({ text: '', enabled: true }, 'Legacy voice'), { text: '', enabled: true });
  assert.deepEqual(resolveOutputStyleConfig({ text: 'Saved voice', enabled: false }, 'Legacy voice'), { text: 'Saved voice', enabled: false });
});

test('legacy instructions seed only an unset Output Style; later context changes do not replace saved preferences', () => {
  const migrated = resolveOutputStyleConfig(undefined, 'Keep it conversational.');
  assert.deepEqual(migrated, { text: 'Keep it conversational.', enabled: true });
  assert.deepEqual(resolveOutputStyleConfig(migrated, 'Now use a different voice.'), migrated);
  assert.deepEqual(resolveOutputStyleConfig(undefined, ''), { text: '', enabled: true });
});

test('no style section means no added speaking policy; empty and disabled context stay empty', () => {
  assert.doesNotMatch(renderMyContextBlock(FILE, 'q'), /<user_response_style>/);
  assert.equal(renderMyContextBlock(FILE, 'q', true), '');
  assert.equal(renderMyContextBlock('', 'q'), '');
  const old = process.env.NATIVELY_MY_CONTEXT;
  process.env.NATIVELY_MY_CONTEXT = '0';
  try {
    assert.equal(buildMyContextBlock('q', path.resolve(here, '../../../../docs/hyowon.md'), false), '');
  } finally {
    if (old === undefined) delete process.env.NATIVELY_MY_CONTEXT;
    else process.env.NATIVELY_MY_CONTEXT = old;
  }
});
