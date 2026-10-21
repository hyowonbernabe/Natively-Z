// Personal build (Natively Z): the transparent prompt builder (electron/llm/transparentPrompt).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = (rel) => pathToFileURL(path.resolve(here, '../../../dist-electron/electron', rel)).href;
const tp = await import(dist('llm/transparentPrompt.js'));

const T0 = new Date(2026, 9, 16, 10, 31, 0).getTime();
const session = (segments, interim = null, start = T0 - 60_000) => ({
    getFullTranscript: () => segments,
    getSessionStartTime: () => start,
    getLastInterimInterviewer: () => interim,
    getTranscriptEpochSummaries: () => [],
});

test('a question that arrived in pieces is answered whole, under NEW, with timestamps and speakers', () => {
    const s = session([
        { speaker: 'interviewer', text: 'Tell me about yourself.', timestamp: T0, final: true },
        { speaker: 'interviewer', text: 'And what excites you right now?', timestamp: T0 + 3000, final: true },
        { speaker: 'user', text: 'Sure.', timestamp: T0 + 5000, final: true, origin: 'stt' },
    ]);
    const { user, system } = tp.buildTransparentPrompt({ action: 'answer', session: s }, tp.resolvePromptSettings({}));
    assert.ok(system.startsWith(tp.PROMPT_HEADER));
    assert.ok(tp.isTransparentPrompt(system));
    assert.match(user, /NEW SINCE YOUR LAST ANSWER \(respond to this\)\n\[10:31:00\] Interviewer: Tell me about yourself\.\n\[10:31:03\] Interviewer: And what excites you right now\?\n\[10:31:05\] Me: Sure\./);
    assert.doesNotMatch(user, /EARLIER/);
    assert.match(user, /# WHAT TO DO\nAnswer the question under NEW\./);
});

test('the split moves only when an answer is used; AI and filler lines stay EARLIER', () => {
    const start = T0 - 120_000;
    const segs = [
        { speaker: 'interviewer', text: 'Q1?', timestamp: T0, final: true },
        { speaker: 'assistant', text: 'A1 answer text.', timestamp: T0 + 9000, final: true },
        { speaker: 'interviewer', text: 'Q2?', timestamp: T0 + 20_000, final: true },
    ];
    tp.markAnswerCutoff(start, T0 + 1000);
    const { user } = tp.buildTransparentPrompt({ action: 'answer', session: session(segs, null, start) }, tp.resolvePromptSettings({}));
    const [earlier, fresh] = user.split('NEW SINCE YOUR LAST ANSWER');
    assert.match(earlier, /Interviewer: Q1\?/);
    assert.match(earlier, /AI suggested: A1 answer text\./);
    assert.match(fresh, /Interviewer: Q2\?/);
});

test('nothing new: answers repeat the latest question; other actions do not get that hint', () => {
    const start = T0 - 300_000;
    const segs = [{ speaker: 'interviewer', text: 'Q1?', timestamp: T0, final: true }];
    tp.markAnswerCutoff(start, T0 + 1000);
    const s = session(segs, null, start);
    const settings = tp.resolvePromptSettings({});
    assert.match(tp.buildTransparentPrompt({ action: 'answer', session: s }, settings).user, /Answer their most recent question again/);
    assert.doesNotMatch(tp.buildTransparentPrompt({ action: 'recap', session: s }, settings).user, /most recent question again/);
    // A named question replaces the hint.
    assert.doesNotMatch(tp.buildTransparentPrompt({ action: 'answer', session: s, request: 'Q2?' }, settings).user, /most recent question again/);
});

test('half-heard interviewer speech is included; the mic switch removes spoken Me lines only', () => {
    const s = session([
        { speaker: 'user', text: 'spoken line', timestamp: T0, final: true, origin: 'stt' },
        { speaker: 'user', text: 'typed line', timestamp: T0 + 1000, final: true, origin: 'manual_chat' },
    ], { text: 'So what would you', timestamp: T0 + 2000 }, T0 - 400_000);
    const off = tp.resolvePromptSettings({ includeMic: false });
    const { user } = tp.buildTransparentPrompt({ action: 'answer', session: s }, off);
    assert.doesNotMatch(user, /spoken line/);
    assert.match(user, /Me \(typed\): typed line/);
    assert.match(user, /Interviewer \(still speaking\): So what would you/);
});

test('settings: saved values override defaults one by one', () => {
    const r = tp.resolvePromptSettings({ base: 'B', actions: { recap: 'R' }, includeMic: false });
    assert.equal(r.base, 'B');
    assert.equal(r.actions.recap, 'R');
    assert.equal(r.actions.answer, tp.DEFAULT_ACTION_INSTRUCTIONS.answer);
    assert.equal(r.includeMic, false);
    assert.equal(tp.resolvePromptSettings(undefined).base, tp.DEFAULT_BASE_INSTRUCTIONS);
});

test('a small model drops the OLDEST lines (multi-line entries whole) and says so', () => {
    const user = [
        '# TRANSCRIPT',
        'EARLIER IN THE CONVERSATION (already answered)',
        '[10:00:00] Interviewer: oldest question',
        '[10:00:05] AI suggested: line one',
        'line two of the same answer',
        '[10:01:00] Interviewer: newer question',
        'NEW SINCE YOUR LAST ANSWER (respond to this)',
        '[10:02:00] Interviewer: newest question',
        '',
        '# WHAT TO DO',
        'Answer the question under NEW.',
    ].join('\n');
    const fitted = tp.fitTransparentUser(user, user.length - 30);
    assert.ok(fitted.length <= user.length - 30, String(fitted.length));
    assert.doesNotMatch(fitted, /oldest question|line one|line two/);
    assert.match(fitted, /newest question/);
    assert.match(fitted, /\(Note: \d+ earlier line\(s\) of the conversation were left out/);
    assert.equal(tp.fitTransparentUser(user, user.length), user, 'fits: unchanged');
});

test('trimming never removes the NEW section (the question being answered)', () => {
    const user = [
        '# TRANSCRIPT',
        'EARLIER IN THE CONVERSATION (already answered)',
        '[10:00:00] Interviewer: old',
        'NEW SINCE YOUR LAST ANSWER (respond to this)',
        '[10:02:00] Interviewer: the current question',
        '',
        '# MY SCREEN (text read from it)',
        'x'.repeat(2000),
        '',
        '# WHAT TO DO',
        'Answer the question under NEW.',
    ].join('\n');
    const fitted = tp.fitTransparentUser(user, 600);
    assert.match(fitted, /the current question/);
    assert.doesNotMatch(fitted, /Interviewer: old/);
    assert.match(fitted, /screen text was shortened/);
    assert.ok(fitted.length <= 600, `length ${fitted.length}`);
});

test('privacy: a provider not allowed the transcript gets a visible "withheld" line instead', () => {
    const user = '# TRANSCRIPT\nNEW SINCE YOUR LAST ANSWER (respond to this)\n[10:00:00] Interviewer: secret meeting talk\n\n# WHAT TO DO\nAnswer the question under NEW.';
    const out = tp.withholdTransparentTranscript(user);
    assert.doesNotMatch(out, /secret meeting talk/);
    assert.match(out, /# TRANSCRIPT\n\(Withheld: your privacy settings/);
    assert.match(out, /# WHAT TO DO\nAnswer the question under NEW\./);
});

test('extra instructions get their own heading, not THE QUESTION', () => {
    const { user } = tp.buildTransparentPrompt({ action: 'answer', session: null, request: 'Q?', instruction: 'Use the STAR format.' }, tp.resolvePromptSettings({}));
    assert.match(user, /# EXTRA INSTRUCTION\nUse the STAR format\.\n\n# THE QUESTION\nQ\?/);
});

test('code comments ("# ...") in screen text or answers are not mistaken for sections when trimming', () => {
    const code = Array.from({ length: 40 }, (_, i) => `# step ${i}\nx = ${i}`).join('\n');
    const user = ['# TRANSCRIPT', 'NEW SINCE YOUR LAST ANSWER (respond to this)', '[10:02:00] Interviewer: q', '',
        '# MY SCREEN (text read from it)', code, '', '# WHAT TO DO', 'Answer the question under NEW.'].join('\n');
    const fitted = tp.fitTransparentUser(user, 300);
    assert.ok(fitted.length <= 300, String(fitted.length));
    assert.match(fitted, /# WHAT TO DO\nAnswer the question under NEW\./);
});
