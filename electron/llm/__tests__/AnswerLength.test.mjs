import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire, stripTypeScriptTypes } from 'node:module';
const require = createRequire(import.meta.url);
const file = require.resolve('../../../dist-electron/electron/llm/answerLength.js');
const { resolveAnswerLength, withAnswerLengthSystemPrompt } = require(file);

test('unset, invalid and Auto leave existing prompt behavior intact', () => {
    for (const value of [undefined, null, '', 'long', {}, 4]) assert.equal(resolveAnswerLength(value), 'auto');
    assert.equal(withAnswerLengthSystemPrompt('Original prompt', 'auto'), 'Original prompt');
});
test('each preset carries distinct guidance while preserving voice and explicit requests', () => {
    for (const [length, range] of [['brief', '50 to 90'], ['balanced', '100 to 170'], ['detailed', '180 to 280']]) {
        const prompt = withAnswerLengthSystemPrompt('Use plain language. Existing context.', length);
        assert.ok(prompt.startsWith('Use plain language. Existing context.'));
        assert.ok(prompt.includes(range));
        assert.match(prompt, /Explicit length or format requests in the current question take precedence/);
        assert.match(prompt, /not hard truncation limits/);
        assert.match(prompt, /Do not pad, invent facts/);
        assert.match(prompt, /main answer only/);
        assert.equal(withAnswerLengthSystemPrompt(prompt, length), prompt);
    }
});
test('a captured answer prompt retains its length after the setting changes', () => {
    const prompt = withAnswerLengthSystemPrompt('Base', 'brief');
    assert.equal(withAnswerLengthSystemPrompt(prompt, 'detailed'), prompt);
    assert.match(withAnswerLengthSystemPrompt('Base', 'detailed'), /180 to 280/);
});
function fixture() {
    let value; let writable = true;
    const handlers = new Map(), events = [];
    const exports = {};
    const source = stripTypeScriptTypes(fs.readFileSync(new URL('../answerLength.ts', import.meta.url), 'utf8')).replace(/^export /gm, '');
    vm.runInNewContext(source + '\nObject.assign(exports, { registerAnswerLengthIpc });', {
        exports, require: name => {
            if (name.includes('SettingsManager')) return { SettingsManager: { getInstance: () => ({ get: () => value, set: (_key, next) => { if (!writable) return false; value = next; return true; } }) } };
            if (name === 'electron') return { BrowserWindow: { getAllWindows: () => [
                { isDestroyed: () => false, webContents: { send: (...args) => events.push(args) } },
                { isDestroyed: () => true, webContents: { send: () => { throw Error('Destroyed window'); } } },
            ] } };
            throw Error(name);
        },
    });
    exports.registerAnswerLengthIpc((channel, handler) => handlers.set(channel, handler));
    return { get: () => handlers.get('answer-length:get')(), set: next => handlers.get('answer-length:set')(null, next), events, failWrites: () => { writable = false; } };
}
test('IPC persists and broadcasts all presets, including restoring Auto', () => {
    const f = fixture(); assert.equal(f.get(), 'auto');
    for (const value of ['brief', 'balanced', 'detailed', 'auto']) {
        assert.equal(f.set(value), value); assert.equal(f.get(), value);
        assert.deepEqual(Array.from(f.events.at(-1)), ['answer-length:changed', value]);
    }
    assert.equal(f.events.length, 4);
});
test('invalid values and failed persistence do not change state or broadcast', () => {
    const f = fixture(); f.set('brief');
    for (const value of [undefined, null, 'huge', {}, 3]) assert.throws(() => f.set(value));
    f.failWrites(); assert.throws(() => f.set('detailed'), /Could not save/);
    assert.equal(f.get(), 'brief'); assert.equal(f.events.length, 1);
});
