// Personal build (Natively Z): backup chain (electron/llm/backupChain).

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = (rel) => pathToFileURL(path.resolve(here, '../../../dist-electron/electron', rel)).href;
const B = await import(dist('llm/backupChain.js'));

const LONG = 'This is a perfectly normal answer that is long enough to pass the notice check.';
const sleep = (ms, signal) => new Promise((r, j) => {
  const t = setTimeout(r, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); j(new Error('aborted')); }, { once: true });
});

/** A fake model. behaviour: 'ok' | 'fail' | 'silent' | 'notice'; delayMs before first words. */
function rung(id, behaviour, { delayMs = 0, firstTokenMs = 60, error = new Error('boom'), opened } = {}) {
  return {
    id, name: id, firstTokenMs,
    async *open(signal) {
      opened?.push(id);
      if (behaviour === 'fail') { await sleep(delayMs, signal); throw error; }
      if (behaviour === 'silent') { await sleep(10_000, signal); return; }
      await sleep(delayMs, signal);
      if (behaviour === 'notice') { yield 'Gemini 3.5 Flash is no longer available. Please switch to a newer model.'; return; }
      yield LONG.slice(0, 20);
      yield LONG.slice(20);
      yield ' The end.';
    },
  };
}
async function collect(gen) { let s = ''; for await (const c of gen) s += c; return s; }

beforeEach(() => B._resetCooling());

test('the active model answers: no backup used, full text passes through', async () => {
  let used;
  const out = await collect(B.runBackupChain([rung('a', 'ok'), rung('b', 'ok')], new AbortController().signal, (r, i) => { used = [r.id, i]; }));
  assert.equal(out, LONG + ' The end.');
  assert.deepEqual(used, ['a', 0]);
});

test('instant failure moves to the next model right away and remembers the failure', async () => {
  const t0 = Date.now();
  let used;
  const quota = Object.assign(new Error('Google quota is exhausted'), { status: 429 });
  const out = await collect(B.runBackupChain([rung('a', 'fail', { error: quota, firstTokenMs: 5000 }), rung('b', 'ok')], new AbortController().signal, (r) => { used = r.id; }));
  assert.equal(used, 'b');
  assert.match(out, /perfectly normal/);
  assert.ok(Date.now() - t0 < 1000, 'did not wait for the 5 s budget');
  assert.equal(B.isCooling('a'), true);
});

test('silent model: retried alongside the next one; first words win and nothing from the loser shows', async () => {
  const opened = [];
  let used;
  const out = await collect(B.runBackupChain(
    [rung('a', 'silent', { opened }), rung('b', 'ok', { delayMs: 10, opened })],
    new AbortController().signal, (r) => { used = r.id; },
  ));
  assert.equal(used, 'b');
  assert.deepEqual(opened, ['a', 'a', 'b'], 'original + retry of a, plus b in parallel');
  assert.equal(out, LONG + ' The end.');
});

test('a slow-but-alive model can still win its retry race', async () => {
  let used;
  // first attempt silent, retry answers quickly; next model is slower
  let n = 0;
  const flaky = {
    id: 'a', name: 'a', firstTokenMs: 60,
    async *open(signal) { n++; if (n === 1) { await sleep(10_000, signal); return; } yield LONG; },
  };
  await collect(B.runBackupChain([flaky, rung('b', 'ok', { delayMs: 200 })], new AbortController().signal, (r) => { used = r.id; }));
  assert.equal(used, 'a');
});

test('a service notice sent as an answer counts as a failure', async () => {
  let used;
  const out = await collect(B.runBackupChain([rung('a', 'notice'), rung('b', 'ok')], new AbortController().signal, (r) => { used = r.id; }));
  assert.equal(used, 'b');
  assert.doesNotMatch(out, /no longer available/);
  assert.equal(B.isCooling('a'), true);
});

test('everything fails: the last error is thrown', async () => {
  await assert.rejects(collect(B.runBackupChain([rung('a', 'fail'), rung('b', 'fail', { error: new Error('last one') })], new AbortController().signal)), /last one/);
});

test('cancelling the turn stops the chain quietly', async () => {
  const ac = new AbortController();
  const p = collect(B.runBackupChain([rung('a', 'silent', { firstTokenMs: 5000 })], ac.signal));
  setTimeout(() => ac.abort('superseded'), 20);
  assert.equal(await p, '');
});

test('classifies failures', () => {
  assert.equal(B.classifyFailure(Object.assign(new Error('x'), { status: 429 })).kind, 'quota');
  assert.equal(B.classifyFailure(new Error('Codex upstream 429 after 3 retries')).kind, 'quota');
  assert.equal(B.classifyFailure(new Error('You have hit your usage limit. Try again in 3 hours')).retryAfterMs, 3 * 3_600_000);
  assert.equal(B.classifyFailure(new Error('service notice: Gemini 3.5 Flash is no longer available')).kind, 'gone');
  assert.equal(B.classifyFailure(Object.assign(new Error('nope'), { status: 401 })).kind, 'auth');
  assert.equal(B.classifyFailure(new Error('Request timed out')).kind, 'timeout');
  assert.equal(B.classifyFailure(new Error('weird')).kind, 'error');
});

test('order: active, then picks, then the rest fastest first; cooling models go last but stay', () => {
  const speed = { c: 900, d: 200, e: undefined };
  const order = B.orderModels({ active: 'a', pinned: ['b'], known: ['c', 'd', 'e', 'a'], speedMs: (id) => speed[id] });
  assert.deepEqual(order, ['a', 'b', 'd', 'c', 'e']);
  B.noteFailure('a', 'quota');
  B.noteFailure('d', 'timeout');
  assert.deepEqual(B.orderModels({ active: 'a', pinned: ['b'], known: ['c', 'd', 'e'], speedMs: (id) => speed[id] }), ['b', 'c', 'e', 'a', 'd']);
});

test('quota cooldown honours a known reset time', () => {
  B.noteFailure('m', 'quota', 2000, 0);
  assert.equal(B.isCooling('m', 1999), true);
  assert.equal(B.isCooling('m', 2001), false);
});

test('real answers that start with "Error" or "Sign in" are not mistaken for service notices', async () => {
  assert.equal(B.looksLikeAnswerNotice('Error handling is something I take seriously, so I log every failure.'), false);
  assert.equal(B.looksLikeAnswerNotice('Sign in flows were the hardest part of Messenger Z, honestly.'), false);
  assert.equal(B.looksLikeAnswerNotice('Gemini 3.5 Flash is no longer available. Please switch to a newer model.'), true);
  assert.equal(B.looksLikeAnswerNotice("You've hit your usage limit. Try again later."), true);
  const ok = { id: 'a', name: 'a', firstTokenMs: 60, async *open() { yield 'Error handling is something I take seriously, so I log every failure.'; } };
  let used;
  await collect(B.runBackupChain([ok, rung('b', 'ok')], new AbortController().signal, (r) => { used = r.id; }));
  assert.equal(used, 'a');
});

test('an empty reply is an answer (no retry storm), a cut-off marker passes through as its own chunk', async () => {
  let used;
  const empty = { id: 'a', name: 'a', firstTokenMs: 60, async *open() { /* nothing */ } };
  assert.equal(await collect(B.runBackupChain([empty, rung('b', 'ok')], new AbortController().signal, (r) => { used = r.id; })), '');
  assert.equal(used, 'a');
  const SENT = '\uE010__NATIVELY_STREAM_TRUNCATED__\uE011';
  const cut = { id: 'c', name: 'c', firstTokenMs: 60, async *open() { yield 'Short start'; yield SENT; } };
  const chunks = [];
  for await (const c of B.runBackupChain([cut], new AbortController().signal)) chunks.push(c);
  assert.deepEqual(chunks, ['Short start', SENT]);
});

test('the winner is stopped when the caller ends the turn early', async () => {
  let aborted = false;
  const long = {
    id: 'a', name: 'a', firstTokenMs: 60,
    async *open(signal) {
      signal.addEventListener('abort', () => { aborted = true; });
      yield LONG;
      for (let i = 0; i < 100; i++) { await sleep(5); yield ' more'; }
    },
  };
  for await (const c of B.runBackupChain([long], new AbortController().signal)) { if (c.includes('more')) break; }
  assert.equal(aborted, true);
});

test('a later mention of limits is not a notice; only the first sentence counts', () => {
  assert.equal(B.looksLikeAnswerNotice('I would design it so requests queue. Then, once the rate limit is reached, we back off.'), false);
  assert.equal(B.looksLikeAnswerNotice('When the database is unavailable we serve from cache.'), false);
});

test('model names read like the app\'s own labels', () => {
  assert.equal(B.prettyModelName('antigravity:gemini-3.5-flash-high'), 'Gemini 3.5 Flash High (Antigravity)');
  assert.equal(B.prettyModelName('codex-cli:gpt-5.6-sol'), 'Codex GPT-5.6 Sol');
  assert.equal(B.prettyModelName('codex-cli'), 'Codex');
  assert.equal(B.prettyModelName('ollama-qwen2.5:0.5b'), 'qwen2.5:0.5b (Local)');
});
