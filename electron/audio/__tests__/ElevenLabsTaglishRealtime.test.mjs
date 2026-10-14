import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { ElevenLabsStreamingSTT } = require('../../../dist-electron/electron/audio/ElevenLabsStreamingSTT.js');
const { StreamingPcmResampler } = require('../../../dist-electron/electron/audio/streamingPcmResampler.js');

class Socket extends EventEmitter {
    readyState = 1;
    sent = [];
    send(data) { this.sent.push(JSON.parse(data)); }
    close() { this.readyState = 3; this.emit('close', 1000, ''); }
    terminate() { this.close(); }
    message(data) { this.emit('message', Buffer.from(JSON.stringify(data))); }
}
function setup(language = 'english-filipino') {
    const sockets = [], urls = [], errors = [], reconnects = [], transcripts = [];
    const stt = new ElevenLabsStreamingSTT('test-key', (url) => {
        urls.push(new URL(url)); const socket = new Socket(); sockets.push(socket); return socket;
    });
    stt.on('error', error => errors.push(error));
    stt.on('reconnecting', info => reconnects.push(info));
    stt.on('transcript', result => transcripts.push(result));
    stt.setRecognitionLanguage(language);
    stt.start();
    return { stt, sockets, urls, errors, reconnects, transcripts };
}
test('Taglish hints both languages; English and auto remain separate modes', () => {
    for (const [language, primary, secondary] of [['english-filipino', 'fil', ['eng']], ['english-us', 'en', []], ['auto', null, []]]) {
        const { stt, urls } = setup(language);
        try {
            assert.equal(urls[0].searchParams.get('language_code'), primary);
            assert.deepEqual(urls[0].searchParams.getAll('secondary_languages'), secondary);
            assert.equal(urls[0].searchParams.get('audio_format'), 'pcm_16000');
            assert.equal(urls[0].searchParams.get('commit_strategy'), 'vad');
        } finally { stt.stop(); }
    }
});
test('session confirmation gates audio, replay stays in 100 ms chunks', () => {
    const { stt, sockets } = setup(); const socket = sockets[0];
    try {
        stt.setSampleRate(48000);
        stt.write(Buffer.alloc(48000 * 2));
        socket.emit('open');
        assert.equal(socket.sent.length, 0);
        stt.setSampleRate(16000); // queued PCM must retain its old conversion
        socket.message({ message_type: 'session_started' });
        assert.equal(socket.sent.length, 10);
        for (const msg of socket.sent) {
            assert.equal(Buffer.from(msg.audio_base_64, 'base64').length, 3200);
            assert.equal(msg.sample_rate, 16000); assert.equal(msg.commit, false);
        }
    } finally { stt.stop(); }
});
test('delayed metadata never repeats text and genuine identical commits survive', () => {
    const { stt, sockets, transcripts } = setup(); const socket = sockets[0];
    try {
        socket.message({ message_type: 'session_started' });
        socket.message({ message_type: 'committed_transcript', text: 'Oo, yes.' });
        socket.message({ message_type: 'committed_transcript', text: 'Oo, yes.' });
        socket.message({ message_type: 'committed_transcript_with_timestamps', text: 'Oo, yes.', language_code: 'fil' });
        assert.deepEqual(transcripts.map(x => x.text), ['Oo, yes.', 'Oo, yes.']);
    } finally { stt.stop(); }
});
test('remote normal close reconnects; old socket callbacks cannot retire its replacement', () => {
    const { stt, sockets, reconnects } = setup(); const old = sockets[0];
    try {
        const oldClose = old.listeners('close')[0];
        old.message({ message_type: 'session_started' }); stt.setSampleRate(16000); stt.write(Buffer.alloc(3200)); old.close();
        assert.equal(reconnects.length, 1);
        clearTimeout(stt.reconnectTimer); stt.reconnectTimer = null;
        stt.connect(); const next = sockets[1];
        oldClose(1000, '');
        assert.equal(stt.ws, next);
        next.message({ message_type: 'session_started' });
        stt.setSampleRate(16000); stt.write(Buffer.alloc(3200));
        assert.equal(next.sent.length, 1);
    } finally { stt.stop(); }
});
test('quota/config rejection is terminal, actionable Error and does not reconnect', () => {
    for (const type of ['auth_error', 'quota_exceeded', 'invalid_request']) {
        const { stt, sockets, errors, reconnects } = setup();
        sockets[0].message({ message_type: type, error: 'Check account' });
        assert.equal(errors.length, 1); assert.ok(errors[0] instanceof Error);
        assert.equal(errors[0].code, 'elevenlabs_stt_unavailable');
        assert.equal(reconnects.length, 0); assert.equal(stt.isActive, false);
        stt.write(Buffer.alloc(3200)); assert.equal(sockets.length, 1);
        stt.stop();
    }
});
test('sessions that repeatedly open without transcribing cannot reset the retry limit', () => {
    const { stt, sockets, errors, reconnects } = setup();
    try {
        for (let attempt = 0; attempt <= 10; attempt++) {
            const socket = sockets.at(-1);
            socket.emit('open'); socket.message({ message_type: 'session_started' }); stt.setSampleRate(16000); stt.write(Buffer.alloc(3200)); socket.close();
            if (stt.reconnectTimer) {
                clearTimeout(stt.reconnectTimer); stt.reconnectTimer = null;
                stt.connect();
            }
        }
        assert.equal(reconnects.length, 10);
        assert.equal(errors.length, 1); assert.equal(stt.shouldReconnect, false);
        stt.write(Buffer.alloc(3200)); assert.equal(sockets.length, 11);
    } finally { stt.stop(); }
});
test('an unavailable connection retains at most ten seconds, independent of capture chunk size', () => {
    const { stt } = setup(); const warnings = [];
    stt.on('warning', warning => warnings.push(warning));
    try {
        stt.setSampleRate(16000);
        for (let i = 0; i < 12; i++) stt.write(Buffer.alloc(32000));
        assert.equal(stt.bufferedBytes, 320000);
        assert.equal(warnings.length, 2);
        assert.ok(warnings.every(warning => warning.droppedBytes === 32000));
    } finally { stt.stop(); }
});
test('44.1 kHz conversion is independent of callback boundaries and byte alignment', () => {
    const pcm = Buffer.alloc(44100 * 2);
    for (let i = 0; i < 44100; i++) pcm.writeInt16LE(Math.round(10000 * Math.sin(i * 0.12)), i * 2);
    const whole = new StreamingPcmResampler(44100).convert(pcm);
    const stream = new StreamingPcmResampler(44100); const parts = [];
    for (let i = 0; i < pcm.length; i += 202) {
        const part = pcm.subarray(i, i + 202);
        const unaligned = Buffer.alloc(part.length + 1); part.copy(unaligned, 1);
        parts.push(...stream.convert(unaligned.subarray(1)));
    }
    assert.equal(whole.length, 16000); assert.deepEqual(parts, [...whole]);
});
test('48 kHz conversion attenuates an aliased tone rather than selecting every third sample', () => {
    const pcm = Buffer.alloc(4800 * 2);
    for (let i = 0; i < 4800; i++) pcm.writeInt16LE(Math.round(20000 * Math.cos(i * 2 * Math.PI / 3)), i * 2);
    const out = new StreamingPcmResampler(48000).convert(pcm);
    assert.ok([...out].every(value => Math.abs(value) <= 1));
});


test('meeting mode does not open a billable socket for an empty audio channel', () => {
    const sockets = [];
    const stt = new ElevenLabsStreamingSTT('test-key', () => { const ws = new Socket(); sockets.push(ws); return ws; });
    stt.setConnectOnAudioOnly(true); stt.start();
    try {
        assert.equal(sockets.length, 0);
        stt.setSampleRate(16000); stt.write(Buffer.alloc(3200));
        assert.equal(sockets.length, 0, 'quiet keepalives cannot open a session');
        stt.write(Buffer.alloc(3200, 0x11));
        assert.equal(sockets.length, 1);
        sockets[0].message({ message_type: 'session_started' });
        assert.equal(sockets[0].sent.length, 1);
    } finally { stt.stop(); }
});

test('empty remote normal close waits for real capture instead of opening an idle reconnect loop', () => {
    const { stt, sockets, reconnects } = setup();
    try {
        sockets[0].message({ message_type: 'session_started' }); sockets[0].close();
        assert.equal(stt.isActive, true); assert.equal(stt.reconnectTimer, null);
        assert.equal(reconnects.length, 0);
        stt.setSampleRate(16000); stt.write(Buffer.alloc(3200));
        assert.equal(sockets.length, 1, 'idle silence must not reopen the socket');
        stt.write(Buffer.alloc(3200, 0x11));
        assert.equal(sockets.length, 2);
    } finally { stt.stop(); }
});

test('insufficient audio is idle, whereas a rate limit is actionable and never storms', () => {
    for (const type of ['insufficient_audio_activity', 'rate_limited']) {
        const { stt, sockets, reconnects, errors } = setup();
        try {
            sockets[0].message({ message_type: 'session_started' });
            stt.setSampleRate(16000); stt.write(Buffer.alloc(3200));
            sockets[0].message({ message_type: type, error: 'Server notice' });
            assert.equal(reconnects.length, 0);
            if (type === 'insufficient_audio_activity') assert.equal(stt.isActive, true);
            else { assert.equal(stt.isActive, false); assert.equal(errors.length, 1); }
        } finally { stt.stop(); }
    }
});
