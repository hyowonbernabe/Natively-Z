import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { MockInterviewService } = require('../../../dist-electron/electron/services/mock-interview/MockInterviewService.js');
const { speechCommand } = require('../../../dist-electron/electron/services/mock-interview/InterviewSpeech.js');
const { interviewMarkdown, interviewOptions, questionPrompt, isQuestionEcho } = require('../../../dist-electron/electron/services/mock-interview/interviewPolicy.js');

function fixture(t, overrides = {}) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'natively-mock-test-'));
    let clock = 1000;
    let currentKey = 'practice-1';
    const calls = { generated: [], spoken: [], ended: [], finalized: 0 };
    const dependencies = {
        directory, model: () => 'test-model', now: () => clock,
        generate: async function* (system, user) {
            calls.generated.push({ system, user });
            yield system.includes('mock interview coach') ? 'Your example was clear. Explain what you did next.' : `What did you learn from project ${calls.generated.length}?`;
        },
        startCapture: async () => currentKey,
        endCapture: async key => { calls.ended.push(key); },
        captureIsCurrent: key => currentKey === key,
        finalizeMicrophone: () => { calls.finalized++; },
        speak: async text => { calls.spoken.push(text); },
        cancelSpeech: () => {}, voice: () => 'Simple words, short sentences.',
        ...overrides,
    };
    const service = new MockInterviewService(dependencies);
    t.after(() => {
        service.dispose();
        if (!path.resolve(directory).startsWith(path.join(os.tmpdir(), 'natively-mock-test-'))) throw new Error('Unexpected cleanup path');
        fs.rmSync(directory, { recursive: true, force: true });
    });
    return { service, calls, dependencies, advance: ms => { clock += ms; }, replaceMeeting: () => { currentKey = 'unrelated-meeting'; } };
}

test('spoken practice reuses one capture, asks as interviewer, and keeps candidate voice out of question prompts', async t => {
    const f = fixture(t);
    const state = await f.service.start({ role: 'Engineer' });
    assert.equal(state.phase, 'answering');
    assert.equal(state.microphoneActive, true);
    assert.equal(f.calls.spoken.length, 1);
    assert.match(f.calls.generated[0].system, /INTERVIEWER/);
    assert.doesNotMatch(f.calls.generated[0].user, /Simple words/);
    assert.equal(f.service.history().length, 1);
});

test('no answer never advances; activity during countdown resets it', async t => {
    const f = fixture(t);
    await f.service.start({ role: 'Engineer', spoken: false, pauseSeconds: 5 });
    f.advance(20000); f.service.tick();
    assert.equal(f.calls.generated.length, 1);
    f.service.transcript({ speaker: 'user', text: 'I fixed the issue.', final: true });
    f.advance(4000); f.service.tick();
    assert.equal(f.service.snapshot().countdown, 1);
    f.service.speechActivity(true); f.service.speechActivity(false); f.service.tick();
    assert.equal(f.service.snapshot().countdown, 5);
    assert.equal(f.calls.generated.length, 1);
});

test('silence submits the candidate answer once, including the answer in the next prompt', async t => {
    const f = fixture(t);
    await f.service.start({ role: 'Engineer', spoken: false, pauseSeconds: 3 });
    f.service.transcript({ speaker: 'user', text: 'I tested the fix first.', final: true });
    f.advance(3100); f.service.tick(); f.service.tick();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.calls.generated.length, 2);
    assert.equal(f.service.snapshot().session.turns.filter(x => x.speaker === 'candidate').length, 1);
    assert.match(f.calls.generated[1].user, /I tested the fix first/);
});

test('background microphone activity cannot indefinitely postpone a spoken answer', async t => {
    const f = fixture(t);
    await f.service.start({ role: 'Engineer', spoken: false, pauseSeconds: 3 });
    f.service.transcript({ speaker: 'user', text: 'I delivered the project.', final: true });
    for (let i = 0; i < 12; i++) {
        f.advance(250); f.service.microphoneLevel(0.15); f.service.tick();
    }
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.calls.generated.length, 2);
    assert.equal(f.service.snapshot().session.turns[1].text, 'I delivered the project.');
});

test('unchanged partial keepalives do not restart the pause or finalization grace', async t => {
    const f = fixture(t);
    await f.service.start({ role: 'Engineer', spoken: false, pauseSeconds: 3 });
    f.service.transcript({ speaker: 'user', text: 'I fixed the problem', final: false });
    for (let i = 0; i < 6; i++) {
        f.advance(1000);
        f.service.transcript({ speaker: 'user', text: 'I fixed the problem', final: false });
        f.service.tick();
    }
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.calls.generated.length, 2);
    assert.equal(f.service.snapshot().session.turns[1].text, 'I fixed the problem');
});

test('ongoing speech holds auto-next and the pause starts after its end', async t => {
    const f = fixture(t);
    await f.service.start({ role: 'Engineer', spoken: false, pauseSeconds: 3 });
    f.service.speechActivity(true);
    f.service.transcript({ speaker: 'user', text: 'My first point.', final: true });
    f.advance(10000); f.service.tick();
    assert.equal(f.calls.generated.length, 1);
    f.service.speechActivity(false);
    f.advance(2900); f.service.tick();
    assert.equal(f.calls.generated.length, 1);
    f.advance(200); f.service.tick();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.calls.generated.length, 2);
});

test('transcription reconnect pauses auto-next and recovery preserves the user preference', async t => {
    const f = fixture(t);
    await f.service.start({ role: 'Engineer', spoken: false, pauseSeconds: 3 });
    f.service.transcript({ speaker: 'user', text: 'I tested it.', final: true });
    f.service.transcriptionStatus('failed');
    f.advance(10000); f.service.tick();
    assert.equal(f.calls.generated.length, 1);
    assert.equal(f.service.snapshot().session.options.autoAdvance, true);
    f.service.transcriptionStatus('connected');
    f.advance(3100); f.service.tick();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.calls.generated.length, 2);
});

test('all spoken answers advance and the final answer completes review without typing or Next', async t => {
    const f = fixture(t);
    await f.service.start({ role: 'Engineer', questions: 3, pauseSeconds: 3 });
    for (let question = 1; question <= 3; question++) {
        f.service.speechActivity(true);
        f.service.transcript({ speaker: 'user', text: `Spoken answer ${question}.`, final: true });
        f.service.speechActivity(false);
        f.advance(3100); f.service.tick();
        await new Promise(resolve => setImmediate(resolve));
    }
    const state = f.service.snapshot();
    assert.equal(state.phase, 'completed'); assert.equal(state.session.status, 'completed');
    assert.equal(state.session.turns.filter(turn => turn.speaker === 'candidate').length, 3);
    assert.ok(state.session.feedback); assert.deepEqual(f.calls.ended, ['practice-1']);
});

test('late finals get a grace period; interims are replaced, not duplicated', async t => {
    const f = fixture(t);
    await f.service.start({ role: 'Engineer', spoken: false, pauseSeconds: 3 });
    f.service.transcript({ speaker: 'user', text: 'I made', final: false });
    f.service.transcript({ speaker: 'user', text: 'I made it faster', final: false });
    f.advance(3100); f.service.tick();
    assert.equal(f.calls.generated.length, 1);
    f.service.transcript({ speaker: 'user', text: 'I made it faster.', final: true });
    assert.equal(f.service.snapshot().draft, 'I made it faster.');
    assert.equal(f.service.snapshot().partial, '');
    f.advance(3100); f.service.tick();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.service.snapshot().session.turns[1].text, 'I made it faster.');
});

test('system audio, exact echoed questions, and audio during spoken questions are not candidate answers', async t => {
    let release;
    const f = fixture(t, { speak: () => new Promise(resolve => { release = resolve; }) });
    const starting = f.service.start({ role: 'Engineer' });
    await new Promise(resolve => setImmediate(resolve));
    f.service.transcript({ speaker: 'user', text: 'Playback echo', final: true });
    release(); await starting;
    f.service.transcript({ speaker: 'interviewer', text: 'More playback', final: true });
    f.service.transcript({ speaker: 'user', text: f.service.snapshot().session.turns[0].text, final: true });
    assert.equal(f.service.snapshot().draft, '');
});

test('failed next question preserves the submitted answer and retry never duplicates it', async t => {
    let count = 0;
    const f = fixture(t, { generate: async function* () { count++; if (count === 2) throw new Error('Provider unavailable'); yield 'Tell me about your work.'; } });
    await f.service.start({ role: 'Engineer', microphone: false, spoken: false });
    f.service.updateDraft('I built a useful tool.');
    let result = await f.service.next();
    assert.equal(result.error, 'Provider unavailable');
    assert.equal(result.session.turns.at(-1).speaker, 'candidate');
    result = await f.service.next();
    assert.equal(result.session.turns.filter(x => x.speaker === 'candidate').length, 1);
    assert.equal(result.session.turns.filter(x => x.speaker === 'interviewer').length, 2);
});

test('last answer ends owned capture, creates one review, and survives reload/export', async t => {
    const f = fixture(t);
    await f.service.start({ role: 'Engineer', questions: 1 });
    f.service.updateDraft('I asked the team what they needed.');
    const state = await f.service.next();
    assert.equal(state.phase, 'completed');
    assert.equal(state.session.status, 'completed');
    assert.equal(state.microphoneActive, false);
    assert.deepEqual(f.calls.ended, ['practice-1']);
    assert.match(f.calls.generated[1].user, /Simple words, short sentences/);
    assert.match(state.session.feedback, /clear/);
    await f.service.finish();
    assert.equal(f.calls.generated.length, 2);
    const loaded = f.service.load(state.session.id);
    assert.match(interviewMarkdown(loaded.session), /## You\nI asked the team/);
    assert.match(interviewMarkdown(loaded.session), /## Feedback/);
});

test('replaced meeting disables automatic progress; stopping practice does not stop unrelated capture', async t => {
    const f = fixture(t);
    await f.service.start({ role: 'Engineer' });
    f.replaceMeeting(); f.service.tick();
    assert.equal(f.service.snapshot().microphoneActive, false);
    assert.match(f.service.snapshot().error, /Microphone session ended/);
    await f.service.stop();
    assert.deepEqual(f.calls.ended, []);
});

test('typed practice does not touch microphones and auto-next can be paused', async t => {
    const f = fixture(t, { startCapture: () => { throw new Error('Should not start'); } });
    await f.service.start({ role: 'Engineer', microphone: false, spoken: false });
    f.service.updateDraft('My typed answer.');
    f.advance(20000); f.service.tick();
    assert.equal(f.calls.generated.length, 1);
    f.service.setAutoAdvance(false, 7);
    assert.equal(f.service.snapshot().session.options.autoAdvance, false);
    await f.service.stop();
    assert.equal(f.service.history()[0].turns.at(-1).text, 'My typed answer.');
});

test('stop cancels a model that ignores cancellation and never publishes its late question', async t => {
    let release;
    const f = fixture(t, { generate: async function* () { await new Promise(resolve => { release = resolve; }); yield 'A late question?'; } });
    const starting = f.service.start({ role: 'Engineer', microphone: false });
    await new Promise(resolve => setImmediate(resolve));
    await f.service.stop();
    await starting;
    release(); await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.service.snapshot().session.turns.length, 0);
    assert.equal(f.service.snapshot().session.status, 'completed');
    assert.equal(f.calls.spoken.length, 0);
});

test('stop during audio startup waits for ownership, then releases the correct capture', async t => {
    let release;
    const f = fixture(t, { startCapture: () => new Promise(resolve => { release = resolve; }) });
    const starting = f.service.start({ role: 'Engineer' });
    const stopping = f.service.stop();
    release('practice-1');
    await Promise.all([starting, stopping]);
    assert.deepEqual(f.calls.ended, ['practice-1']);
    assert.equal(f.calls.generated.length, 0);
});

test('capture failure remains recoverable, with no leaked ownership', async t => {
    const f = fixture(t, { startCapture: async () => { throw new Error('Microphone denied'); } });
    const state = await f.service.start({ role: 'Engineer' });
    assert.equal(state.microphoneActive, false);
    assert.equal(state.phase, 'completed');
    assert.equal(state.error, 'Microphone denied');
    assert.deepEqual(f.calls.ended, []);
    const retry = await f.service.start({ role: 'Engineer', microphone: false, spoken: false });
    assert.equal(retry.phase, 'answering');
});

test('speech failure keeps the question readable and permits an answer', async t => {
    const f = fixture(t, { speak: async () => { throw new Error('No installed voice'); } });
    const state = await f.service.start({ role: 'Engineer' });
    assert.equal(state.phase, 'answering');
    assert.equal(state.session.turns.length, 1);
    assert.equal(state.speechError, 'No installed voice');
});

test('corrupt saved files are ignored and external paths cannot be loaded', async t => {
    const f = fixture(t);
    fs.writeFileSync(path.join(f.dependencies.directory, '00000000-0000-0000-0000-000000000000.json'), 'broken');
    assert.deepEqual(f.service.history(), []);
    assert.throws(() => f.service.load('../../settings.json'), /not found/);
});

test('native speech commands are platform specific and never embed question text in a shell', () => {
    const win = speechCommand('win32');
    assert.equal(win.command, 'powershell.exe');
    assert.ok(win.args.includes('-NonInteractive'));
    assert.match(Buffer.from(win.args.at(-1), 'base64').toString('utf16le'), /In.ReadToEnd/);
    const mac = speechCommand('darwin', '/private/tmp/voice with spaces/question.txt');
    assert.deepEqual(mac, { command: '/usr/bin/say', args: ['-f', '/private/tmp/voice with spaces/question.txt'] });
    assert.throws(() => speechCommand('linux'), /supported on Windows and macOS/);
    assert.equal(interviewOptions({ role: 'Engineer', pauseSeconds: 0.5, questions: 500 }).pauseSeconds, 3);
    assert.equal(interviewOptions({ role: 'Engineer', questions: 500 }).questions, 10);
});

test('storage failure still stops owned capture and preserves a transcript in memory for export', async t => {
    const f = fixture(t);
    await f.service.start({ role: 'Engineer' });
    f.service.updateDraft('My answer should remain available.');
    f.service.save = () => { throw new Error('Disk full'); };
    await assert.rejects(f.service.stop(), /saving failed/);
    assert.deepEqual(f.calls.ended, ['practice-1']);
    assert.equal(f.service.snapshot().microphoneActive, false);
    assert.equal(f.service.snapshot().session.status, 'completed');
    assert.match(interviewMarkdown(f.service.snapshot().session), /My answer should remain available/);
});


test('personal mode supports no role and asks general conversational questions', () => {
  const options = interviewOptions({ focus: 'personal', role: '' });
  assert.equal(options.focus, 'personal');
  assert.equal(options.role, 'Personal introduction practice');
  const prompt = questionPrompt({ options, turns: [] });
  assert.match(prompt.system, /Tell me about yourself/);
  assert.match(prompt.system, /nontechnical/);
  assert.match(prompt.system, /Do not ask coding questions/);
  assert.equal(JSON.parse(prompt.user).questionNumber, 1);
  assert.throws(() => interviewOptions({ focus: 'technical', role: '' }));
});
test('personal practice retains spoken automatic progression and saved focus', async t => {
  const f = fixture(t);
  await f.service.start({ focus: 'personal', role: '', questions: 2 });
  assert.match(f.calls.generated[0].system, /personal\/general interview practice/);
  assert.equal(f.service.snapshot().session.options.autoAdvance, true);
  assert.equal(f.service.snapshot().session.options.focus, 'personal');
});
test('resume focus needs no role and asks recruiter-style background questions', () => {
  const options = interviewOptions({ focus: 'resume', role: '' });
  assert.equal(options.focus, 'resume');
  assert.equal(options.role, 'Resume screening');
  const prompt = questionPrompt({ options, turns: [] });
  assert.match(prompt.system + prompt.user, /how many years I have with each main tool/);
  assert.match(prompt.system + prompt.user, /no coding quizzes/);
});
test('read-aloud question heard back through meeting audio counts as an echo, real speech does not', () => {
  const q = 'You’re balancing a role at MultiplyOS with two businesses. How do you decide what gets your attention?';
  assert.equal(isQuestionEcho("You're balancing a role at MultiplyOS with two businesses.", q), true);
  assert.equal(isQuestionEcho('How do you decide', q), true);
  assert.equal(isQuestionEcho('Tell me about your-', 'Tell me about yourself and what led you to software.'), true);
  assert.equal(isQuestionEcho('Can you tell me about your salary expectations instead?', q), false);
  assert.equal(isQuestionEcho('anything', undefined), false);
});
test('stopping or closing while feedback is being written still saves the feedback', async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let calls = 0;
  const f = fixture(t, {
    generate: async function* () { calls++; if (calls > 1) { await gate; yield 'Clear answer. Add one example.'; } else yield 'What do you do day to day?'; },
  });
  await f.service.start({ role: 'Engineer', spoken: false, microphone: false, questions: 1 });
  f.service.updateDraft('I build features.');
  const finishing = f.service.finish();
  await new Promise(resolve => setImmediate(resolve));
  await f.service.stop();
  release();
  await finishing;
  assert.equal(f.service.history()[0].feedback, 'Clear answer. Add one example.');
});
test('echoed mock question still reaches the live transcript bar', () => {
  const main = fs.readFileSync(new URL('../../main.ts', import.meta.url), 'utf8');
  const branch = main.match(/mockInterviewEchoFilter\?\.\(segment\.text\)\) \{([\s\S]*?)return;/);
  assert.ok(branch, 'echo branch present');
  assert.match(branch[1], /sendThrottledTranscript\(/);
});
