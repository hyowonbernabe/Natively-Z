import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import vm from 'node:vm';
import { warningAfterAudioRecovery } from '../../../src/lib/audioCaptureRecovery.mjs';

// Execute the real wiring method with fake capture/timers, without booting the
// application's DB, network and windows. Exercise both platform branches.
const source = readFileSync(new URL('../../main.ts', import.meta.url), 'utf8');
const start = source.indexOf('  private wireMicCapture(');
const end = source.indexOf('  private async setupSystemAudioPipeline', start);
const code = stripTypeScriptTypes(`class Harness { ${source.slice(start, end)} }; Harness`, { mode: 'strip' });
function fixture(platform) {
    let now = 1000; const pending = new Set();
    const Harness = vm.runInNewContext(code, {
        process: { platform }, console: { log() {}, warn() {} },
        Date: { now: () => now },
        setTimeout: callback => { pending.add(callback); return callback; },
        clearTimeout: callback => pending.delete(callback), setImmediate: callback => callback(),
    });
    const harness = new Harness(), capture = new EventEmitter(), failures = [], edges = [], chunks = [];
    Object.assign(capture, { getSampleRate: () => 16000, getNativeSampleRate: () => 48000 });
    Object.assign(harness, {
        microphoneCapture: capture, isMeetingActive: true, _micSttRateApplied: false,
        googleSTT_User: { setSampleRate() {}, setAudioChannelCount() {}, write: chunk => chunks.push(chunk) },
        setupMicRecoveryHandler() {}, publishMeetingAudioLevel() {}, findBuiltInInputDevice: () => null,
        sendAudioCaptureFailed: payload => failures.push(payload),
        mockInterviewSpeechObserver: speaking => edges.push(speaking),
    });
    harness.wireMicCapture(capture);
    return { harness, capture, failures, edges, chunks,
        advance: ms => { now += ms; for (const callback of [...pending]) { pending.delete(callback); callback(); } } };
}
for (const platform of ['win32', 'darwin']) {
    test(`${platform}: healthy quiet keepalives never claim microphone mute or denial`, () => {
        const f = fixture(platform); f.capture.emit('start');
        for (let i = 0; i < 15; i++) { f.capture.emit('data', Buffer.alloc(640)); f.advance(1000); }
        assert.equal(f.failures.length, 0); assert.equal(f.chunks.length, 15);
    });
    test(`${platform}: genuinely stalled capture warns and later activity reports recovery`, () => {
        const f = fixture(platform); f.capture.emit('start'); f.advance(12000);
        assert.equal(f.failures.length, 1); assert.equal(f.failures[0].stuck, true);
        const speech = Buffer.alloc(640);
        for (let i = 0; i < speech.length; i += 2) speech.writeInt16LE(i % 4 ? 500 : -500, i);
        f.capture.emit('data', speech);
        assert.equal(f.failures[1].recovered, true);
        f.capture.emit('stop'); f.capture.emit('start'); f.advance(12000);
        assert.equal(f.failures[2].stuck, true, 'restart re-arms the no-data watchdog');
        f.capture.emit('data', speech); assert.equal(f.failures[3].recovered, true);
    });
    test(`${platform}: stale capture cannot clear a warning or drive spoken interview activity`, () => {
        const f = fixture(platform); f.harness.microphoneCapture = new EventEmitter();
        f.capture.emit('speech_edge', { channel: 'user', speaking: true });
        f.capture.emit('data', Buffer.alloc(640, 0x42));
        assert.equal(f.edges.length, 0); assert.equal(f.failures.length, 0); assert.equal(f.chunks.length, 0);
    });
    test(`${platform}: current microphone speech edges reach the interview`, () => {
        const f = fixture(platform);
        f.capture.emit('speech_edge', { channel: 'user', speaking: true });
        f.capture.emit('speech_edge', { channel: 'user', speaking: false });
        assert.deepEqual(f.edges, [true, false]);
    });
}
test('recovery clears only its own temporary capture warning', () => {
    const warning = { kind: 'audio-capture-failure', channel: 'mic', terminal: false };
    assert.equal(warningAfterAudioRecovery(warning, 'mic'), null);
    assert.equal(warningAfterAudioRecovery(warning, 'system'), warning);
    const terminal = { ...warning, terminal: true };
    assert.equal(warningAfterAudioRecovery(terminal, 'mic'), terminal);
    const permission = { kind: 'screen-recording-permission', channel: 'system' };
    assert.equal(warningAfterAudioRecovery(permission, 'system'), permission);
});
