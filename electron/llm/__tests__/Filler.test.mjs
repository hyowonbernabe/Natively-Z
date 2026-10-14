// Personal build (Natively Z): filler / bridge line (electron/llm/filler).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = (rel) => pathToFileURL(path.resolve(here, '../../../dist-electron/electron', rel)).href;
const F = await import(dist('llm/filler.js'));

function fakeHelper(chunks, { delayMs = 0, fail = false, models = ['m-a', 'm-b'] } = {}) {
  const calls = [];
  return {
    calls,
    canDispatchFillerModel: (id) => models.includes(id),
    fillerAutoCandidates: () => models,
    async *streamFillerLine(modelId, system, user, signal) {
      calls.push({ modelId, system, user });
      if (fail) throw new Error('boom');
      for (const c of chunks) {
        if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
        if (signal.aborted) return;
        yield c;
      }
    },
  };
}

test('auto tries each untried candidate first, then keeps the fastest', () => {
  const seen = new Map();
  assert.equal(F.pickAutoModel(['a', 'b'], seen), 'a');
  seen.set('a', [900]);
  assert.equal(F.pickAutoModel(['a', 'b'], seen), 'b');
  seen.set('b', [300]);
  assert.equal(F.pickAutoModel(['a', 'b'], seen), 'b');
  assert.equal(F.pickAutoModel([], seen), null);
});

test('off and unsupported picks give no model; explicit pick is honoured', () => {
  const h = fakeHelper([]);
  assert.equal(F.resolveFillerModel(h, 'off'), null);
  assert.equal(F.resolveFillerModel(h, 'nope'), null);
  assert.equal(F.resolveFillerModel(h, 'm-b'), 'm-b');
});

test('prompt: no facts rule, longer for behavioural, story hint and recent lines only when given', () => {
  const short = F.buildFillerPrompt('Why do you want this job?');
  assert.match(short.system, /10 to 16 words/);
  assert.match(short.system, /NEVER state any fact/);
  assert.doesNotMatch(short.system, /MAY say which experience/);
  const long = F.buildFillerPrompt('Tell me about a time you disagreed with a teammate', { storyHint: 'blocking an intern\'s PR', recentLines: ['Okay so, disagreeing…'] });
  assert.match(long.system, /18 to 26 words/);
  assert.match(long.system, /blocking an intern's PR/);
  assert.match(long.system, /Okay so, disagreeing/);
  assert.ok(long.user.startsWith('Question: Tell me about a time you disagreed with a teammate\n'));
});

test('voice comes only from style-like sections', () => {
  const v = F.voiceFromContext('# Me\nfacts\n\n## How to answer for me\nCasual, direct.\n\n## Story: X\nTags: y\nsecret fact');
  assert.match(v, /Casual, direct/);
  assert.doesNotMatch(v, /secret fact/);
});

test('runFiller streams cleaned chunks and returns the line', async () => {
  const got = [];
  const h = fakeHelper(['"Yeah, ', 'a time I disagreed', ' [[GIST]]… okay so"']);
  const text = await F.runFiller({ helper: h, question: 'Tell me about a time you disagreed', signal: new AbortController().signal, onToken: (c) => got.push(c) });
  assert.equal(text, 'Yeah, a time I disagreed, okay so');
  assert.equal(got.join(''), 'Yeah, a time I disagreed, okay so');
});

test('runFiller is silent on failure and on an aborted answer', async () => {
  const got = [];
  assert.equal(await F.runFiller({ helper: fakeHelper([], { fail: true }), question: 'q?', signal: new AbortController().signal, onToken: (c) => got.push(c) }), '');
  const ac = new AbortController();
  const p = F.runFiller({ helper: fakeHelper(['a ', 'b ', 'c '], { delayMs: 20 }), question: 'q?', signal: ac.signal, onToken: (c) => got.push(c) });
  ac.abort('superseded');
  await p;
  assert.ok(got.length <= 1);
});

test('speed test reports first token, total and words per second', async () => {
  const r = await F.testFillerSpeed(fakeHelper(['one two ', 'three four'], { delayMs: 15 }), 'm-a');
  assert.equal(r.ok, true);
  assert.ok(r.firstTokenMs >= 10 && r.totalMs >= r.firstTokenMs);
  assert.ok(r.wordsPerSec > 0);
  assert.equal((await F.testFillerSpeed(fakeHelper([]), 'zzz')).ok, false);
  assert.equal((await F.testFillerSpeed(fakeHelper(['all at once']), 'm-a')).wordsPerSec, undefined);
});

test('stream trimming: first line only, two sentences max, char cap at a word boundary', () => {
  assert.deepEqual(F.nextFillerPiece('', 'Okay so, pressure.\nSo one day I', 200), { piece: 'Okay so, pressure.', done: true });
  assert.deepEqual(F.nextFillerPiece('Yeah. ', 'Let me think. And then', 200), { piece: 'Let me think.', done: true });
  assert.deepEqual(F.nextFillerPiece('Hmm... ', 'okay so', 200), { piece: 'okay so', done: false });
  const r = F.nextFillerPiece('', 'one two three four five six', 12);
  assert.equal(r.piece, 'one two');
  assert.equal(r.done, true);
});

test('service notices sent as answer text are never shown and fail the speed test', async () => {
  const notice = 'Gemini 3.5 Flash is no longer available. Please switch to a newer model.';
  assert.equal(F.looksLikeServiceNotice(notice), true);
  assert.equal(F.looksLikeServiceNotice('Yeah, a time I disagreed with a teammate... okay, so'), false);
  const got = [];
  const text = await F.runFiller({ helper: fakeHelper([notice]), question: 'q?', signal: new AbortController().signal, onToken: (c) => got.push(c) });
  assert.equal(text, '');
  assert.equal(got.length, 0);
  const streamed = [];
  await F.runFiller({ helper: fakeHelper(['Gemini 3.5 ', 'Flash is no ', 'longer available, please switch']), question: 'q?', signal: new AbortController().signal, onToken: (c) => streamed.push(c) });
  assert.equal(streamed.length, 0);
  const r = await F.testFillerSpeed(fakeHelper([notice]), 'm-a');
  assert.equal(r.ok, false);
  assert.match(r.error, /no longer available/);
});
