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

test('prompt: question-specific complete opening without inventing the story', () => {
  const short = F.buildFillerPrompt('Why do you want this job?');
  assert.match(short.system, /8 to 18 words/);
  assert.match(short.system, /NEVER invent a fact/);
  assert.doesNotMatch(short.system, /MAY say which experience/);
  const long = F.buildFillerPrompt('Tell me about a time you disagreed with a teammate', { recentLines: ['Okay so, disagreeing…'] });
  assert.match(long.system, /8 to 18 words/);
  assert.match(long.system, /Never select a particular story/);
  assert.match(long.system, /End with terminal punctuation/);
  assert.match(long.system, /Okay so, disagreeing/);
  assert.ok(long.user.startsWith('Question: Tell me about a time you disagreed with a teammate\n'));
});

test('voice comes only from style-like sections', () => {
  const v = F.voiceFromContext('# Me\nfacts\n\n## How to answer for me\nCasual, direct.\n\n## Story: X\nTags: y\nsecret fact');
  assert.match(v, /Casual, direct/);
  assert.doesNotMatch(v, /secret fact/);
});

test('runFiller publishes one complete sentence and omits a following sentence', async () => {
  const got = [];
  const h = fakeHelper(['"Here is ', 'how I would ', 'approach that." Another sentence.']);
  const text = await F.runFiller({ helper: h, question: 'Tell me about a time you disagreed', signal: new AbortController().signal, onToken: (c) => got.push(c) });
  assert.equal(text, 'Here is how I would approach that.');
  assert.deepEqual(got, ['Here is how I would approach that.']);
});

test('partial, oversized and interrupted openings are never published', async () => {
  for (const chunks of [['Okay, so'], ['An unfinished opening\nAnother line.'], ['x'.repeat(180) + '.']]) {
    const got = [];
    const text = await F.runFiller({ helper: fakeHelper(chunks), question: 'How?', signal: new AbortController().signal, onToken: c => got.push(c) });
    assert.equal(text, ''); assert.deepEqual(got, []);
  }
  const ac = new AbortController(); const got = [];
  const helper = fakeHelper(['An unfinished ', 'opening.'], { delayMs: 20 });
  const pending = F.runFiller({ helper, question: 'How?', signal: ac.signal, onToken: c => got.push(c) });
  await new Promise(r => setTimeout(r, 25)); ac.abort();
  assert.equal(await pending, ''); assert.deepEqual(got, []);
});

test('a faster main answer suppresses its late opening without waiting for filler', async () => {
  const ac = new AbortController(); const got = [];
  const pending = F.runFiller({ helper: fakeHelper(['Here is ', 'how I would approach that.'], { delayMs: 20 }), question: 'How?', signal: ac.signal, onToken: c => got.push(c) });
  await new Promise(r => setTimeout(r, 25)); F.markMainAnswerStarted(ac.signal);
  assert.equal(await pending, ''); assert.deepEqual(got, []);
});

test('main opening rule preserves the base prompt, is idempotent and leaves Off unchanged', () => {
  const base = 'Use only grounded facts. Return JSON when requested.';
  assert.equal(F.withParallelMainOpening(base, false), base);
  const enabled = F.withParallelMainOpening(base, true);
  assert.ok(enabled.startsWith(base)); assert.match(enabled, /including a short explanation of an unfamiliar project/);
  assert.equal(F.withParallelMainOpening(enabled, true), enabled);
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


test('observed invented filler claims are suppressed before display', async () => {
    const question = 'Tell me a technical problem you encountered in one of your projects and how you fixed it.';
    for (const line of ['Yeah, that particular bug required tracking down the root cause.', 'So, that project involved dealing with some pretty tricky memory leaks.']) {
        const shown = [];
        assert.equal(await F.runFiller({ helper: fakeHelper([line]), question, signal: new AbortController().signal, onToken: text => shown.push(text) }), '');
        assert.deepEqual(shown, []);
    }
    const line = 'I can share a technical challenge from one of my projects.';
    const shown = [];
    assert.equal(await F.runFiller({ helper: fakeHelper([line]), question, signal: new AbortController().signal, onToken: text => shown.push(text) }), line);
    assert.deepEqual(shown, [line]);
});
