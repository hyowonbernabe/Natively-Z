import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { interviewOptions, pauseCountdown, questionPrompt, reviewPrompt } from './interviewPolicy';
import type { InterviewOptions, InterviewSession, InterviewState } from './types';
import { looksLikeServiceNotice } from '../../llm/filler';

export interface InterviewDependencies {
    directory: string;
    model: () => string;
    generate: (system: string, user: string, signal: AbortSignal) => AsyncIterable<string>;
    startCapture: (title: string) => Promise<string>;
    endCapture: (key: string) => Promise<void>;
    captureIsCurrent: (key: string) => boolean;
    finalizeMicrophone: () => void;
    speak: (text: string, signal: AbortSignal) => Promise<void>;
    cancelSpeech: () => void;
    voice: () => string;
    now?: () => number;
}

export class MockInterviewService extends EventEmitter {
    private state: InterviewState = { session: null, phase: 'idle', draft: '', partial: '', microphoneActive: false, level: 0, countdown: null, error: null, speechError: null };
    private controller = new AbortController();
    private captureKey: string | null = null;
    private captureStart: Promise<void> | null = null;
    private releasingCapture = false;
    private reviewing = false;
    private lastActivity = 0;
    private partialGrace = 0;
    private speechActive = false;
    private transcriptionAvailable = true;
    private timer: ReturnType<typeof setInterval>;
    private now: () => number;

    constructor(private deps: InterviewDependencies) {
        super();
        this.now = deps.now || Date.now;
        this.timer = setInterval(() => this.tick(), 250);
        this.timer.unref();
    }

    snapshot(): InterviewState { return JSON.parse(JSON.stringify(this.state)); }
    private publish(): void { this.emit('changed', this.snapshot()); }
    private save(): void {
        if (!this.state.session) return;
        fs.mkdirSync(this.deps.directory, { recursive: true });
        const file = path.join(this.deps.directory, `${this.state.session.id}.json`);
        const temp = `${file}.tmp`;
        fs.writeFileSync(temp, JSON.stringify(this.state.session, null, 2), 'utf8');
        fs.renameSync(temp, file);
    }

    history(): InterviewSession[] {
        if (!fs.existsSync(this.deps.directory)) return [];
        return fs.readdirSync(this.deps.directory).filter(name => /^[a-f0-9-]{36}\.json$/.test(name)).flatMap(name => {
            try {
                const session = JSON.parse(fs.readFileSync(path.join(this.deps.directory, name), 'utf8')) as InterviewSession;
                return session.id === name.slice(0, -5) && session.options?.role && Array.isArray(session.turns) ? [session] : [];
            } catch { return []; }
        }).sort((a, b) => b.startedAt - a.startedAt).slice(0, 50);
    }

    private ensureAnswering(): InterviewSession {
        const session = this.state.session;
        if (!session || session.status !== 'active' || this.state.phase !== 'answering') throw new Error('Wait for the interviewer to finish before answering.');
        return session;
    }

    private async generate(system: string, user: string, maxChars: number): Promise<string> {
        const controller = this.controller;
        const signal = controller.signal;
        let timer: ReturnType<typeof setTimeout>;
        let onAbort: () => void;
        const work = (async () => {
            let text = '';
            for await (const piece of this.deps.generate(system, user, signal)) {
                if (signal.aborted) throw new Error('Interview stopped.');
                text += piece;
                if (text.length > maxChars) throw new Error('The model returned too much text. Try again.');
            }
            if (signal.aborted) throw new Error('Interview stopped.');
            const result = text.trim();
            if (!result) throw new Error('The model returned no text. Check your AI provider and try again.');
            if (looksLikeServiceNotice(result)) throw new Error('The AI provider returned a service notice. Check your model connection and try again.');
            return result;
        })();
        try {
            return await Promise.race([work, new Promise<never>((_, reject) => {
                onAbort = () => reject(signal.reason instanceof Error && signal.reason.name !== 'AbortError' ? signal.reason : new Error('Interview stopped.'));
                signal.addEventListener('abort', onAbort, { once: true });
                timer = setTimeout(() => controller.abort(new Error('The AI took too long. Try again or check your provider.')), 60_000);
                if (signal.aborted) onAbort();
            })]);
        } finally { clearTimeout(timer!); signal.removeEventListener('abort', onAbort!); }
    }

    async start(input: Partial<InterviewOptions>): Promise<InterviewState> {
        if (this.state.session?.status === 'active' || this.releasingCapture || this.reviewing || this.captureStart) throw new Error('Finish or stop your current interview first.');
        const options = interviewOptions(input);
        this.speechActive = false;
        this.transcriptionAvailable = true;
        this.partialGrace = 0;
        this.controller.abort();
        this.controller = new AbortController();
        const session: InterviewSession = { id: crypto.randomUUID(), startedAt: this.now(), options, model: this.deps.model(), status: 'active', turns: [] };
        this.state = { session, phase: 'generating', draft: '', partial: '', microphoneActive: false, level: 0, countdown: null, error: null, speechError: null };
        this.publish();
        try {
            if (options.microphone) {
                this.captureStart = this.deps.startCapture(`Mock interview: ${options.role}`).then(key => { this.captureKey = key; });
                await this.captureStart;
                this.captureStart = null;
            }
            if (this.controller.signal.aborted || this.state.session !== session || session.status !== 'active') return this.snapshot();
            this.state.microphoneActive = Boolean(this.captureKey);
            await this.askQuestion();
        } catch (error) {
            if (session.status === 'active') {
                session.status = 'completed';
                session.endedAt = this.now();
                this.state.phase = 'completed';
                this.state.error = this.errorText(error);
                await this.releaseCapture();
                this.save();
                this.publish();
            }
        }
        return this.snapshot();
    }

    private async askQuestion(): Promise<void> {
        const session = this.state.session!;
        this.controller = new AbortController();
        const signal = this.controller.signal;
        this.state.phase = 'generating';
        this.state.error = null;
        this.state.countdown = null;
        this.lastActivity = 0;
        this.publish();
        const prompt = questionPrompt(session);
        const question = await this.generate(prompt.system, prompt.user, 1200);
        if (signal.aborted || session !== this.state.session || session.status !== 'active') return;
        session.turns.push({ speaker: 'interviewer', text: question, timestamp: this.now() });
        this.save();
        await this.playQuestion(question);
    }

    private async playQuestion(question: string): Promise<void> {
        const session = this.state.session!;
        const signal = this.controller.signal;
        this.state.speechError = null;
        if (session.options.spoken) {
            this.state.phase = 'speaking';
            this.publish();
            try { await this.deps.speak(question, signal); }
            catch (error) { if (!signal.aborted && session === this.state.session) this.state.speechError = this.errorText(error); }
        }
        if (signal.aborted || session !== this.state.session || session.status !== 'active') return;
        this.state.phase = 'answering';
        this.speechActive = false;
        this.partialGrace = 0;
        this.lastActivity = 0;
        this.publish();
    }

    microphoneLevel(level: number): void {
        if (!this.captureKey || !this.deps.captureIsCurrent(this.captureKey)) return;
        this.state.level = Math.min(1, Math.max(0, Number(level) || 0));
        // Meter amplitude includes background noise; it is not a speech clock.
    }

    speechActivity(speaking: boolean): void {
        if (!this.captureKey || !this.deps.captureIsCurrent(this.captureKey) || this.state.phase !== 'answering') return;
        this.speechActive = speaking;
        this.lastActivity = this.now();
        this.partialGrace = 0;
        this.state.countdown = null;
        this.publish();
    }

    transcriptionStatus(state: string): void {
        if (!this.captureKey || !this.deps.captureIsCurrent(this.captureKey)) return;
        if (state === 'failed' || state === 'reconnecting' || state === 'preparing') {
            this.transcriptionAvailable = false;
            this.speechActive = false;
            this.state.countdown = null;
        } else if (state === 'connected' || state === 'awaiting-audio') {
            if (!this.transcriptionAvailable) this.lastActivity = this.now();
            this.transcriptionAvailable = true;
        }
        this.publish();
    }

    transcript(segment: { speaker: string; text: string; final: boolean }): void {
        if (segment.speaker !== 'user' || !this.captureKey || !this.deps.captureIsCurrent(this.captureKey) || this.state.phase !== 'answering' || this.state.session?.turns.at(-1)?.speaker !== 'interviewer') return;
        const text = segment.text.trim().slice(0, 5000);
        if (!text || (!segment.final && text === this.state.partial)) return;
        // Ignore an exact echoed question, but keep candidate wording intact.
        const question = this.state.session?.turns.filter(t => t.speaker === 'interviewer').at(-1)?.text;
        const normalize = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
        if (question && normalize(text) === normalize(question)) return;
        if (segment.final) {
            this.state.draft = `${this.state.draft} ${text}`.trim().slice(0, 10000);
            this.state.partial = '';
        } else this.state.partial = text;
        this.lastActivity = this.now();
        this.partialGrace = 0;
        this.publish();
    }

    updateDraft(text: string): InterviewState {
        this.ensureAnswering();
        this.state.draft = String(text || '').slice(0, 10000);
        this.state.partial = '';
        this.lastActivity = this.now();
        this.partialGrace = 0;
        this.publish();
        return this.snapshot();
    }

    setAutoAdvance(enabled: boolean, seconds: number): InterviewState {
        if (this.state.session) {
            this.state.session.options.autoAdvance = Boolean(enabled);
            this.state.session.options.pauseSeconds = Math.max(3, Math.min(10, Number(seconds) || 5));
            this.lastActivity = this.now();
            this.state.countdown = null;
            this.save();
            this.publish();
        }
        return this.snapshot();
    }

    tick(): void {
        if (this.state.microphoneActive && this.captureKey && !this.deps.captureIsCurrent(this.captureKey)) {
            this.state.microphoneActive = false;
            this.captureKey = null;
            this.state.error = 'Microphone session ended. You can type your answer or finish this interview.';
            this.state.countdown = null;
            this.publish();
        }
        if (this.state.microphoneActive && this.state.phase === 'answering') this.publish();
        const options = this.state.session?.options;
        if (!options || !options.autoAdvance || !this.state.microphoneActive || this.state.phase !== 'answering' || this.state.error) return;
        if (!this.transcriptionAvailable || this.speechActive) {
            if (this.state.countdown !== null) { this.state.countdown = null; this.publish(); }
            return;
        }
        const remaining = pauseCountdown(this.now(), this.lastActivity, options.pauseSeconds, Boolean((this.state.draft + this.state.partial).trim()));
        if (remaining !== this.state.countdown) { this.state.countdown = remaining; this.publish(); }
        if (remaining === 1) this.deps.finalizeMicrophone();
        if (remaining !== 0) return;
        if (this.state.partial && !this.partialGrace) { this.partialGrace = this.now() + 2000; this.deps.finalizeMicrophone(); return; }
        if (this.partialGrace && this.now() < this.partialGrace) return;
        void this.next().catch(error => { this.state.error = this.errorText(error); this.publish(); });
    }

    private commitAnswer(): void {
        const session = this.state.session!;
        const answer = `${this.state.draft} ${this.state.partial}`.trim();
        if (answer && session.turns.at(-1)?.speaker === 'interviewer') {
            session.turns.push({ speaker: 'candidate', text: answer, timestamp: this.now() });
            this.state.draft = '';
            this.state.partial = '';
            this.save();
        }
    }

    async next(): Promise<InterviewState> {
        const session = this.ensureAnswering();
        if (!(this.state.draft + this.state.partial).trim() && session.turns.at(-1)?.speaker !== 'candidate') throw new Error('Speak or type an answer first.');
        this.commitAnswer();
        if (session.turns.filter(t => t.speaker === 'interviewer').length >= session.options.questions) return this.finish();
        try { await this.askQuestion(); }
        catch (error) {
            if (session === this.state.session && session.status === 'active') {
                this.state.phase = 'answering';
                this.state.error = this.errorText(error);
                this.publish();
            }
        }
        return this.snapshot();
    }

    async replay(): Promise<InterviewState> {
        this.ensureAnswering();
        if (this.state.session!.turns.at(-1)?.speaker !== 'interviewer') throw new Error('Your answer is already saved. Click Next to retry the next question.');
        const question = this.state.session!.turns.filter(t => t.speaker === 'interviewer').at(-1)?.text;
        if (question) { this.state.session!.options.spoken = true; await this.playQuestion(question); }
        return this.snapshot();
    }

    load(id: string): InterviewState {
        if (this.state.session?.status === 'active' || this.releasingCapture || this.reviewing) throw new Error('Finish your current interview before opening a saved transcript.');
        const session = this.history().find(item => item.id === id);
        if (!session) throw new Error('Saved interview not found.');
        // A saved active session was interrupted; reviewing it never reopens audio.
        session.status = 'completed';
        this.state = { session, phase: 'completed', draft: '', partial: '', microphoneActive: false, level: 0, countdown: null, error: null, speechError: null };
        this.publish();
        return this.snapshot();
    }

    stopSpeaking(): InterviewState {
        this.deps.cancelSpeech();
        return this.snapshot();
    }

    private async releaseCapture(): Promise<void> {
        this.releasingCapture = true;
        try {
            try { await this.captureStart; } catch { /* capture never started */ }
            this.captureStart = null;
            const key = this.captureKey;
            this.captureKey = null;
            this.state.microphoneActive = false;
            if (key && this.deps.captureIsCurrent(key)) await this.deps.endCapture(key);
        } finally { this.releasingCapture = false; }
    }

    async stop(): Promise<InterviewState> {
        this.controller.abort();
        this.deps.cancelSpeech();
        let saveError: unknown;
        if (this.state.session?.status === 'active') {
            try { this.commitAnswer(); } catch (error) { saveError = error; }
            this.state.session.status = 'completed';
            this.state.session.endedAt = this.now();
            try { this.save(); } catch (error) { saveError = error; }
        }
        this.state.phase = this.state.session ? 'completed' : 'idle';
        this.state.countdown = null;
        this.publish();
        await this.releaseCapture();
        if (saveError) this.state.error = 'Interview stopped, but saving failed. Export the transcript before closing.';
        this.publish();
        if (saveError) throw new Error(this.state.error!);
        return this.snapshot();
    }

    async finish(): Promise<InterviewState> {
        if (!this.state.session) throw new Error('Start an interview first.');
        if (this.state.session.feedback || this.reviewing) return this.snapshot();
        this.reviewing = true;
        try {
            await this.stop();
            this.controller = new AbortController();
            const session = this.state.session;
            const signal = this.controller.signal;
            this.state.phase = 'reviewing';
            this.state.error = null;
            this.publish();
            try {
                const prompt = reviewPrompt(session, this.deps.voice());
                const feedback = await this.generate(prompt.system, prompt.user, 12000);
                if (!signal.aborted && session === this.state.session) { session.feedback = feedback; this.save(); }
            } catch (error) { if (session === this.state.session) this.state.error = this.errorText(error); }
            if (session === this.state.session) { this.state.phase = 'completed'; this.publish(); }
            return this.snapshot();
        } finally { this.reviewing = false; }
    }

    dispose(): void {
        clearInterval(this.timer);
        this.controller.abort();
        this.deps.cancelSpeech();
        if (this.state.session?.status === 'active') {
            this.commitAnswer();
            this.state.session.status = 'completed';
            this.state.session.endedAt = this.now();
            this.save();
        }
    }
    private errorText(error: unknown): string { return error instanceof Error ? error.message.slice(0, 400) : 'Interview request failed. Try again.'; }
}
