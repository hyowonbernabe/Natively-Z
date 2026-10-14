import { EventEmitter } from 'events';
import WebSocket from 'ws';
import { safeDetachAndClose } from './wsSafeTeardown';
import { StreamingPcmResampler } from './streamingPcmResampler';
import { RECOGNITION_LANGUAGES, TAGLISH_LANGUAGE_KEY } from '../config/languages';
import { streamingStttWsOptions } from './dnsHelpers';
import { RealtimeSilenceTail } from './realtimeSilenceTail';

const ELEVENLABS_WS_URL = 'wss://api.elevenlabs.io/v1/speech-to-text/realtime';
// Cap reconnect attempts so a flapping network can't drive an indefinite WS
// open-loop against ElevenLabs (storm risk + per-key rate-limit risk). After
// the cap, emit 'error' so the orchestrator can surface a UI prompt; a
// user-triggered restart via stop()/start() resets the counter to 0.
const RECONNECT_MAX_ATTEMPTS = 10;

// COMMIT STRATEGY (2026-09-23). The realtime API's default is `manual`: a
// transcript only becomes `committed_transcript` when the client commits,
// and "even if you do not commit manually, the model automatically commits
// after approximately 36 seconds of accumulated audio" (elevenlabs.io/docs,
// "Transcripts and commit strategies"). This client never committed, so every
// final — the thing SessionTracker stores and Auto Answer judges — arrived
// once per ~36 s of audio. natively-api's own ElevenLabs relay has always sent
// commit_strategy=vad; the BYOK client did not.
//
// 0.8 s of silence ends a segment: long enough not to cut a question at a
// breath, short enough to finalize promptly (range 0.3–3.0, their example 1.5).
export const ELEVENLABS_VAD_SILENCE_SECS = 0.8;
// Real-time silence after the local VAD's speech end, so that 0.8 s is wall
// time rather than ~5× it at the native keepalive cadence:
// hangover (>= 500) + 600 = 1100 ms. See realtimeSilenceTail.ts.
export const ELEVENLABS_SILENCE_TAIL_MS = 600;
// 100 ms per message at 16 kHz — the low end of the 0.1–1 s chunk range the
// docs recommend ("smaller chunks result in lower latency"). It was 250 ms,
// which held every partial back by up to a quarter second, and during the
// keepalive cadence took ~1.25 s to fill.
export const ELEVENLABS_SEND_THRESHOLD_SAMPLES = 1600;

export class ElevenLabsStreamingSTT extends EventEmitter {
    private apiKey: string;
    private ws: WebSocket | null = null;
    private isActive = false;
    private shouldReconnect = false;
    private reconnectAttempts = 0;
    private reconnectTimer: NodeJS.Timeout | null = null;
    private inputSampleRate = 48000; // what the mic/system audio captures at
    private targetSampleRate = 16000; // what ElevenLabs Scribe v2 requires
    
    private buffer: Buffer[] = [];
    private isConnecting = false;
    private isSessionReady = false;
    private languageCode = 'en'; // Default to English
    
    private secondaryLanguages: string[] = [];
    private readonly resampler = new StreamingPcmResampler();
    private sessionTimer: NodeJS.Timeout | null = null;
    private bufferedBytes = 0;
    
    // Chunk buffering properties (100ms @ 16k — see ELEVENLABS_SEND_THRESHOLD_SAMPLES)
    private pcmAccumulator: Int16Array[] = [];
    private pcmAccumulatorLen = 0;
    private readonly SEND_THRESHOLD_SAMPLES = ELEVENLABS_SEND_THRESHOLD_SAMPLES;
    private readonly silenceTail = new RealtimeSilenceTail({
        tailMs: ELEVENLABS_SILENCE_TAIL_MS,
        format: () => ({ sampleRate: this.inputSampleRate, channels: 1 }),
        sink: (pcm) => this.sendAudio(pcm),
    });
    constructor(apiKey: string, private readonly createSocket: (url: string, options: any) => WebSocket = (url, options) => new WebSocket(url, options)) {
        super();
        this.apiKey = apiKey;
    }

    public setSampleRate(rate: number): void {
        if (rate === this.inputSampleRate) return;
        this.resampler.reset(rate);
        this.inputSampleRate = rate;
        console.log(`[ElevenLabsStreaming] Input sample rate set to ${rate}Hz`);
        // We always downsample to 16000Hz for ElevenLabs
    }

    /** No-op - channel count is expected to be mono by ElevenLabs Scribe */
    public setAudioChannelCount(_count: number): void {}

    /** Recognition language - maps Natively key to ISO-639-1 for ElevenLabs, or 'auto' to omit code */
    public setRecognitionLanguage(key: string): void {
        // Personal build: constrain Taglish language identification to Filipino and English.
        const iso = key === TAGLISH_LANGUAGE_KEY ? 'fil' : key === 'auto' ? '' : (RECOGNITION_LANGUAGES[key]?.iso639 ?? this.languageCode);
        const secondary = key === TAGLISH_LANGUAGE_KEY ? ['eng'] : [];
        const newCode = iso === 'tl' ? 'fil' : iso;
        if (this.languageCode !== newCode || this.secondaryLanguages.join() !== secondary.join()) {
            console.log(`[ElevenLabsStreaming] Language changed: ${this.languageCode || '(auto)'} -> ${newCode || '(auto)'}`);
            this.languageCode = newCode;
            this.secondaryLanguages = secondary;
            if (this.isActive) {
                console.log('[ElevenLabsStreaming] Restarting session to apply new language...');
                this.stop();
                this.start();
            }
        }
    }

    /** No-op - credentials passed via API key */
    public setCredentials(_path: string): void {}

    public start(): void {
        if (this.isActive) return;
        if (this.isConnecting) return; // Already mid-connect (prevents double-connect race)
        this.isActive = true;          // Set immediately so write() buffers audio during WS handshake
        this.shouldReconnect = true;
        this.reconnectAttempts = 0;
        this.connect();
    }

    public stop(): void {
        this.shouldReconnect = false;
        this.silenceTail.cancel();
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        if (this.ws) {
            // safeDetachAndClose (F-201): setRecognitionLanguage does
            // stop()+start(), so this runs mid-handshake — a CONNECTING
            // socket's abort error must not escape listener-less.
            safeDetachAndClose(this.ws);
            this.ws = null;
        }
        this.isActive = false;
        this.isConnecting = false;
        this.isSessionReady = false;
        this.buffer = [];
        this.bufferedBytes = 0;
        this.resampler.reset(this.inputSampleRate);
        this.clearSessionTimer();
        this.pcmAccumulator = [];
        this.pcmAccumulatorLen = 0;
        console.log('[ElevenLabsStreaming] Stopped');
    }

    /**
     * "Answer now": flush what is pending so the server has every sample now.
     *
     * Deliberately NO `commit: true`. Measured live (2026-09-23): a commit with
     * under 0.3 s of uncommitted audio is answered with `commit_throttled` —
     * "You need at least 0.3s of uncommitted audio before committing" — AND the
     * server CLOSES the socket (1000, reason commit_throttled). The VAD commit
     * is invisible until its transcript arrives, so the client cannot know
     * whether 0.3 s is still uncommitted when the button is pressed (the usual
     * case is right after the VAD already committed). The VAD commit
     * (commit_strategy=vad, 0.8 s, kept real-time by the silence tail) lands
     * ~1.2-1.4 s after speech end on its own — measured — so a manual commit
     * would buy a few hundred ms at the price of a dead session.
     */
    public finalize(): void {
        if (!this.isActive || !this.ws || this.ws.readyState !== WebSocket.OPEN || !this.isSessionReady) return;
        if (this.pcmAccumulatorLen === 0) return;

        const combined = new Int16Array(this.pcmAccumulatorLen);
        let offset = 0;
        for (const arr of this.pcmAccumulator) {
            combined.set(arr, offset);
            offset += arr.length;
        }
        this.pcmAccumulator = [];
        this.pcmAccumulatorLen = 0;
        try {
            this.ws.send(JSON.stringify(this.audioMessage(
                Buffer.from(combined.buffer, combined.byteOffset, combined.byteLength).toString('base64'),
                false,
            )));
            console.log('[ElevenLabsStreaming] Finalize — flushed pending accumulator');
        } catch (err) {
            console.error('[ElevenLabsStreaming] Finalize flush failed:', err);
        }
    }

    /** Local VAD: the speaker stopped. Keep the server VAD's clock real-time. */
    public notifySpeechEnded(): void {
        if (!this.isActive) return;
        this.silenceTail.start();
    }

    /**
     * input_audio_chunk as the API reference declares it: `commit` and
     * `sample_rate` are REQUIRED fields there. They used to be omitted, which
     * the server tolerated; sending them costs nothing and stops depending on
     * that leniency.
     */
    private audioMessage(audioBase64: string, commit: boolean): Record<string, unknown> {
        return {
            message_type: 'input_audio_chunk',
            audio_base_64: audioBase64,
            commit,
            sample_rate: this.targetSampleRate,
        };
    }

    private emitCommitted(text: string): void {
        // Only the primary commit is a transcript. Delayed metadata never repeats it.
        this.emit('transcript', { text, isFinal: true, confidence: 1.0 });
    }

    public write(chunk: Buffer): void {
        if (!this.isActive) return;
        this.silenceTail.observe(chunk);
        this.sendAudio(chunk);
    }

    private sendAudio(chunk: Buffer): void {
        if (!this.isActive) return;
        // Convert immediately: queued samples retain their format if a device changes.
        try {
            const output = this.resampler.convert(chunk);
            this.queuePcm(Buffer.from(output.buffer, output.byteOffset, output.byteLength));
        } catch (err) {
            this.emit('warning', { code: 'invalid_audio', message: String(err) });
        }
    }

    private queuePcm(pcm: Buffer): void {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.isSessionReady) {
            this.buffer.push(pcm);
            this.bufferedBytes += pcm.length;
            let dropped = 0;
            while (this.bufferedBytes > this.targetSampleRate * 2 * 10 && this.buffer.length) {
                const old = this.buffer.shift()!;
                this.bufferedBytes -= old.length;
                dropped += old.length;
            }
            if (dropped) this.emit('warning', { code: 'audio_buffer_overflow', message: 'Connection unavailable; oldest queued audio dropped.', droppedBytes: dropped });
            if (!this.ws && !this.isConnecting && this.shouldReconnect && !this.reconnectTimer) this.connect();
            return;
        }
        // Bounded 100 ms messages, including large capture callbacks and reconnect replay.
        const samples = new Int16Array(pcm.buffer, pcm.byteOffset, pcm.byteLength / 2);
        this.pcmAccumulator.push(samples);
        this.pcmAccumulatorLen += samples.length;
        if (this.pcmAccumulatorLen < this.SEND_THRESHOLD_SAMPLES) return;
        const combined = new Int16Array(this.pcmAccumulatorLen);
        let offset = 0;
        for (const part of this.pcmAccumulator) { combined.set(part, offset); offset += part.length; }
        offset = 0;
        while (combined.length - offset >= this.SEND_THRESHOLD_SAMPLES) {
            const part = combined.subarray(offset, offset + this.SEND_THRESHOLD_SAMPLES);
            this.ws.send(JSON.stringify(this.audioMessage(Buffer.from(part.buffer, part.byteOffset, part.byteLength).toString('base64'), false)));
            offset += this.SEND_THRESHOLD_SAMPLES;
        }
        const remaining = combined.slice(offset);
        this.pcmAccumulator = remaining.length ? [remaining] : [];
        this.pcmAccumulatorLen = remaining.length;
    }

    private clearSessionTimer(): void {
        if (this.sessionTimer) clearTimeout(this.sessionTimer);
        this.sessionTimer = null;
    }

    private fail(code: string, message: string): void {
        this.stop();
        this.emit('error', Object.assign(new Error(`ElevenLabs ${code}: ${message}`), { code: 'elevenlabs_stt_unavailable' }));
    }

    private connect(): void {
        if (this.isConnecting || this.ws || !this.isActive || !this.shouldReconnect) return;
        this.isConnecting = true;
        this.isSessionReady = false;
        
        console.log(`[ElevenLabsStreaming] Connecting`, { hasApiKey: Boolean(this.apiKey) });

        // raw WebSocket URL with parameters
        let url = `${ELEVENLABS_WS_URL}?model_id=scribe_v2_realtime&audio_format=pcm_${this.targetSampleRate}`
            + `&commit_strategy=vad&vad_silence_threshold_secs=${ELEVENLABS_VAD_SILENCE_SECS}`;
        
        // Always enable language detection metadata; only pin to a specific code when one is set
        if (this.languageCode) {
            url += `&language_code=${this.languageCode}`;
        }
        for (const language of this.secondaryLanguages) url += `&secondary_languages=${encodeURIComponent(language)}`;
        url += `&include_language_detection=true&keepalive_interval_ms=1000`;
        
        console.log(`[ElevenLabsStreaming] Connecting with URL: ${url.replace(this.apiKey, '***')}`);

        // streamingStttWsOptions: IPv4-only DNS + 15s handshake cap (dnsHelpers.ts).
        const socket = this.createSocket(url, streamingStttWsOptions({
            headers: {
                'xi-api-key': this.apiKey,
            },
        }) as any);

        this.ws = socket;
        // A TCP upgrade is not a usable transcription session.
        this.sessionTimer = setTimeout(() => {
            if (this.ws !== socket) return;
            socket.terminate();
        }, 20000);
        socket.on('open', () => {
            if (this.ws !== socket || !this.isActive) return;
            // Keep connecting latched until session_started, not merely socket open.
        });

        socket.on('message', (data: WebSocket.RawData) => {
            if (this.ws !== socket || !this.isActive) return;
            try {
                const rawStr = data.toString();
                const msg = JSON.parse(rawStr);

                // Note: The websocket API might use "type" or "message_type"
                const msgType = msg.type || msg.message_type;

                switch (msgType) {
                    case 'session_started':
                        console.log('[ElevenLabsStreaming] Session started:', msg.config);
                        this.clearSessionTimer();
                        this.isConnecting = false;
                        this.isSessionReady = true;
                        this.emit('connected');
                        
                        // Flush buffered audio now that session is strictly ready
                        while (this.buffer.length > 0) {
                            const chunk = this.buffer.shift();
                            if (chunk) {
                                this.bufferedBytes -= chunk.length;
                                this.queuePcm(chunk);
                            }
                        }
                        break;

                    case 'partial_transcript':
                        if (msg.text) {
                            this.reconnectAttempts = 0;
                            this.emit('transcript', { 
                                text: msg.text, 
                                isFinal: false, 
                                confidence: 1.0 
                            });
                        }
                        break;

                    case 'committed_transcript':
                        if (msg.text) { this.reconnectAttempts = 0; this.emitCommitted(msg.text); }
                        break;
                    case 'committed_transcript_with_timestamps':
                        if (msg.language_code) {
                            const locale = msg.language_code === 'fil' ? 'fil-PH' : Object.values(RECOGNITION_LANGUAGES).find(lang => lang.iso639 === msg.language_code)?.bcp47;
                            this.emit('languageDetected', locale || msg.language_code);
                        }
                        break;

                    case 'auth_error':
                    case 'quota_exceeded':
                    case 'unaccepted_terms':
                    case 'input_error':
                    case 'invalid_request':
                    case 'chunk_size_exceeded':
                        this.fail(msgType, String(msg.error || 'Check your Speech-to-Text key permissions and account settings.'));
                        break;
                    case 'warning':
                        this.emit('warning', { code: 'scribe_warning', message: msg.warning });
                        break;
                    default:
                        if (msg.error) {
                            this.emit('warning', { code: msgType, message: String(msg.error) });
                            socket.close(); // close handler owns bounded retries, including code 1000
                        }
                }
            } catch (err) {
                console.error('[ElevenLabsStreaming] Failed to parse message:', err);
            }
        });

        socket.on('close', (code, reason) => {
            if (this.ws !== socket) return;
            this.clearSessionTimer();
            // Null out the ws reference immediately to prevent stale reuse
            this.ws = null;
            this.isConnecting = false;
            this.isSessionReady = false;
            console.log(`[ElevenLabsStreaming] Closed: code=${code} reason=${reason}`);
            if (this.shouldReconnect) {
                this.scheduleReconnect();
            } else {
                // If not reconnecting, mark session as truly inactive
                this.isActive = false;
            }
        });

        socket.on('error', (err) => {
            if (this.ws !== socket) return;
            this.emit('warning', { code: 'socket_error', message: err.message });
        });
        socket.on('unexpected-response', (_request, response) => {
            if (this.ws !== socket) return;
            const status = response.statusCode;
            response.resume();
            if (status === 401 || status === 403) this.fail('authentication', `HTTP ${status}: check your API key and Speech-to-Text permission.`);
            else socket.terminate();
        });
    }

    private scheduleReconnect(): void {
        if (!this.shouldReconnect || this.reconnectTimer) return;

        if (this.reconnectAttempts >= RECONNECT_MAX_ATTEMPTS) {
            console.error(`[ElevenLabsStreaming] Max reconnect attempts (${RECONNECT_MAX_ATTEMPTS}) reached — giving up`);
            // Latch off the reconnect path so write()'s lazy-connect (line 154)
            // cannot resurrect the storm on the next audio chunk. start() resets
            // shouldReconnect=true so a user-triggered restart still works.
            // Mirrors the auth_error pattern at line ~317.
            this.fail('connection_failed', 'Reconnect attempts exhausted. Check your connection and restart transcription.');
            return;
        }

        const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);
        this.reconnectAttempts++;
        this.emit('reconnecting', { attempts: this.reconnectAttempts, delay });

        console.log(`[ElevenLabsStreaming] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts}/${RECONNECT_MAX_ATTEMPTS})...`);
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            if (this.shouldReconnect) {
                this.connect();
            }
        }, delay);
    }
}
