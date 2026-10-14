// Personal build (Natively Z): filler / bridge line.
//
// When a live question triggers an answer, a fast model streams a short spoken
// acknowledgement + thinking-aloud line IN PARALLEL with the main answer, so the
// user can start talking at once. It never waits for, feeds, or replaces the main
// answer, and any failure is silent. Design: docs/filler-design.md (workspace).

import { readMyContext, selectMyContext } from './myContext';

export const FILLER_HARD_STOP_MS = 6000;
const FILLER_MAX_CHARS = 240;
const RECENT_KEEP = 5;

export type FillerSetting = 'auto' | 'off' | string;

export interface FillerHelper {
    canDispatchFillerModel(modelId: string): boolean;
    fillerAutoCandidates(): string[];
    streamFillerLine(modelId: string, system: string, user: string, signal: AbortSignal): AsyncGenerator<string, void, unknown>;
}

function settings(): { get(k: string): any } | null {
    try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        return require('../services/SettingsManager').SettingsManager.getInstance();
    } catch {
        return null;
    }
}

export function getFillerSetting(): FillerSetting {
    const v = settings()?.get('fillerModel');
    return typeof v === 'string' && v ? v : 'auto';
}

// ── Auto: try each candidate once, then keep the one with the lowest first-token time ──
// ponytail: in-memory per session; persist it if cold starts keep picking a slow model first.
const firstTokenMs = new Map<string, number[]>();

export function noteFirstToken(modelId: string, ms: number): void {
    const xs = firstTokenMs.get(modelId) ?? [];
    xs.push(ms);
    if (xs.length > 8) xs.shift();
    firstTokenMs.set(modelId, xs);
}

function median(xs: number[]): number {
    const s = [...xs].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
}

/** Median first-token time observed this session for a model, if any (also used by the backup chain). */
export function observedFirstTokenMs(modelId: string): number | undefined {
    const xs = firstTokenMs.get(modelId);
    return xs?.length ? median(xs) : undefined;
}

/** Speed-test results survive restarts so the backup chain can order models before any live use. */
function persistSpeed(modelId: string, ms: number): void {
    try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const sm = require('../services/SettingsManager').SettingsManager.getInstance();
        const prev = sm.get('modelSpeedMs');
        sm.set('modelSpeedMs', { ...(prev && typeof prev === 'object' ? prev : {}), [modelId]: ms });
    } catch { /* not persisted */ }
}

export function pickAutoModel(candidates: string[], seen: Map<string, number[]> = firstTokenMs): string | null {
    if (!candidates.length) return null;
    const untried = candidates.find((m) => !seen.get(m)?.length);
    if (untried) return untried;
    return [...candidates].sort((a, b) => median(seen.get(a)!) - median(seen.get(b)!))[0];
}

export function resolveFillerModel(helper: FillerHelper, setting: FillerSetting = getFillerSetting()): string | null {
    if (setting === 'off') return null;
    if (setting !== 'auto') return helper.canDispatchFillerModel(setting) ? setting : null;
    return pickAutoModel(helper.fillerAutoCandidates());
}

// ── Prompt ──
const BEHAVIOURAL_RE = /\b(tell me about (a|an|the|one) (time|situation|moment|project)|describe (a|an|the) (time|situation)|walk me through|give (me )?an example|how did you (handle|deal)|what (was|is) (the|your) (hardest|biggest|toughest|most))/i;

const recent: string[] = [];

/** The user's voice/style sections from my-context.md (headings mentioning voice, style, tone, attitude…). */
export function voiceFromContext(text: string): string {
    const secs = String(text || '').split(/^(?=##\s)/m);
    const voice = secs.filter((s) => /^##\s.*\b(voice|style|tone|sound|how to answer|speak)/i.test(s.split('\n')[0]));
    return voice.join('\n').trim().slice(0, 900);
}

export function buildFillerPrompt(question: string, opts: { voice?: string; recentLines?: string[]; storyHint?: string } = {}): { system: string; user: string } {
    const long = BEHAVIOURAL_RE.test(question);
    const words = long ? '18 to 26' : '10 to 16';
    const system = [
        'You write the first few words a person says out loud right after being asked a question in a live conversation or interview, to fill the pause while they gather their thoughts.',
        `Write ONE line of ${words} words, spoken, casual, first person.`,
        'You ARE that person (a human), never an assistant or an AI. Never offer help or ask how you can help.',
        'Start the way a real person starts answering out loud: a quick acknowledgement that echoes the topic in the asker\'s own words, then the opening words of the answer itself, setting it up without saying anything specific yet.',
        'Do NOT narrate your thinking: never "let me think", "where do I start", "how do I put this", "good question", "hmm". At most ONE filler word (like "so", "yeah" or "okay"). No "..." pauses: use commas.',
        'NEVER state any fact, name, company, number, date, opinion, decision or the answer itself. Never say "great question". No lists, no quotes, no emojis.',
        'Do not invent details like a time, place or scene ("that afternoon", "back in college"), and no slogans or vague claims ("AI changes everything"). Keep it plain and literal.',
        opts.storyHint ? `You MAY say which experience you are about to talk about using only these words: "${opts.storyHint}". Nothing else about it.` : '',
        opts.voice ? `Sound like this person (style only, do not use any facts from it):\n${opts.voice}` : '',
        opts.recentLines?.length ? `Do not reuse the wording of these earlier lines:\n${opts.recentLines.map((l) => `- ${l}`).join('\n')}` : '',
        'The line must END BEFORE the first real point of the answer: finish on an open lead-in (a comma, "so", "and"), never with the answer, a trait, a reason or an example.',
        'Output only the line, on one line.',
    ].filter(Boolean).join('\n');
    return { system, user: `Question: ${question.trim()}
Write only the filler line (${words} words, no facts).` };
}

function storyHintFor(question: string, text: string): string | undefined {
    if (settings()?.get('fillerStoryHint') !== true || !text) return undefined;
    const top = selectMyContext(text, question, 1).stories[0];
    // "Mentoring / coaching: onboarding interns at ZuraLog" → "onboarding interns at ZuraLog"
    return top ? top.split(':').pop()!.trim() || undefined : undefined;
}

/**
 * Small models ramble and start inventing a story on line 2. Keep the first line only,
 * at most two sentences, at most maxChars (cut at a word boundary).
 */
export function nextFillerPiece(sofar: string, chunk: string, maxChars: number = FILLER_MAX_CHARS): { piece: string; done: boolean } {
    let piece = sofar.trim() ? chunk : chunk.replace(/^\s+/, '');
    let done = false;
    const nl = piece.indexOf('\n');
    if (nl >= 0) { piece = piece.slice(0, nl); done = true; }
    const ends = [...(sofar + piece).matchAll(/[.!?](?=\s|$)(?<!\.\.\.)/g)];
    if (ends.length >= 2) {
        const cut = ends[1].index! + 1 - sofar.length;
        if (cut >= 0) { piece = piece.slice(0, cut); done = true; }
    }
    if (sofar.length + piece.length > maxChars) {
        const room = piece.slice(0, Math.max(0, maxChars - sofar.length));
        const sp = room.lastIndexOf(' ');
        piece = sp > 0 ? room.slice(0, sp) : room;
        done = true;
    }
    return { piece, done };
}

/**
 * Some providers (Antigravity) send a service notice as normal answer text, e.g.
 * "Gemini 3.5 Flash is no longer available. Please switch…". Never show that as a filler line.
 */
const SERVICE_NOTICE_RE = /\b(no longer available|(is|are) (not|currently) available|unavailable|please (switch|try again|select|choose|upgrade)|quota|rate.?limit|limit exceeded|not supported|unauthori[sz]ed|sign in|api key|error)\b/i;
export function looksLikeServiceNotice(text: string): boolean {
    return SERVICE_NOTICE_RE.test(String(text || '').slice(0, 200));
}
const NOTICE_CHECK_CHARS = 40;

export function cleanFillerChunk(s: string): string {
    // "..." pauses read as robotic in a spoken line: turn them into a comma.
    return s.replace(/["“”]/g, '').replace(/\[\[[A-Z_]+\]\]/g, '').replace(/\s*(\.{3}|…)(?=\s*\S)/g, ',');
}

/**
 * Fire-and-forget. Streams the filler line through onToken; resolves when done.
 * Never throws. Stops on signal abort, after FILLER_HARD_STOP_MS, or at FILLER_MAX_CHARS.
 */
export async function runFiller(input: {
    helper: FillerHelper;
    question: string;
    signal: AbortSignal;
    onToken: (chunk: string) => void;
}): Promise<string> {
    const question = String(input.question || '').trim();
    if (!question || input.signal.aborted) return '';
    let modelId: string | null = null;
    try {
        modelId = resolveFillerModel(input.helper);
        if (!modelId) return '';
        const ctx = readMyContext();
        const { system, user } = buildFillerPrompt(question, {
            voice: voiceFromContext(ctx),
            recentLines: recent,
            storyHint: storyHintFor(question, ctx),
        });
        const signal = AbortSignal.any([input.signal, AbortSignal.timeout(FILLER_HARD_STOP_MS)]);
        const maxChars = BEHAVIOURAL_RE.test(question) ? 190 : 130;
        const t0 = Date.now();
        let text = '';
        let held = '';
        let checked = false;
        for await (const raw of input.helper.streamFillerLine(modelId, system, user, signal)) {
            if (signal.aborted) break;
            const chunk = cleanFillerChunk(String(raw ?? ''));
            if (!chunk) continue;
            if (!text && !held) noteFirstToken(modelId, Date.now() - t0);
            const { piece, done } = nextFillerPiece(text + held, chunk, maxChars);
            // Hold the first few words until we know it's not a service notice, then stream normally.
            if (!checked) {
                held += piece;
                if (held.length >= NOTICE_CHECK_CHARS || done) { checked = true; if (looksLikeServiceNotice(held)) throw new Error(`service notice: ${held.slice(0, 80)}`); text = held; input.onToken(held); held = ''; }
            } else if (piece) { text += piece; input.onToken(piece); }
            if (done) break;
        }
        if (held) { if (looksLikeServiceNotice(held)) throw new Error(`service notice: ${held.slice(0, 80)}`); text += held; input.onToken(held); }
        text = text.trim();
        if (text) {
            recent.push(text);
            if (recent.length > RECENT_KEEP) recent.shift();
            console.log(`[Filler] ${modelId} ${Date.now() - t0}ms: ${text}`);
        }
        return text;
    } catch (e: any) {
        // A failed model counts as very slow, so Auto moves on.
        if (modelId && (!firstTokenMs.get(modelId)?.length || /service notice/.test(String(e?.message)))) noteFirstToken(modelId, FILLER_HARD_STOP_MS * 10);
        if (!input.signal.aborted) console.warn(`[Filler] skipped (${modelId ?? 'no model'}): ${e?.message ?? e}`);
        return '';
    }
}

// ── Speed test (Settings → Filler model → Test / Test all) ──
export interface FillerSpeedResult { modelId: string; ok: boolean; firstTokenMs?: number; totalMs?: number; wordsPerSec?: number; text?: string; error?: string }

/** One real filler call on modelId with a sample question. Measured result also teaches Auto. */
export async function testFillerSpeed(helper: FillerHelper, modelId: string, question = 'Tell me about a time you disagreed with a teammate.'): Promise<FillerSpeedResult> {
    if (!helper.canDispatchFillerModel(modelId)) return { modelId, ok: false, error: 'not supported for filler' };
    const { system, user } = buildFillerPrompt(question, { voice: voiceFromContext(readMyContext()) });
    const signal = AbortSignal.timeout(20000);
    const t0 = Date.now();
    let first: number | undefined;
    let text = '';
    let chunks = 0;
    try {
        for await (const raw of helper.streamFillerLine(modelId, system, user, signal)) {
            const chunk = cleanFillerChunk(String(raw ?? ''));
            if (!chunk) continue;
            if (first === undefined) first = Date.now() - t0;
            chunks++;
            text += chunk;
        }
        const totalMs = Date.now() - t0;
        if (first === undefined) return { modelId, ok: false, totalMs, error: 'no output' };
        if (looksLikeServiceNotice(text)) {
            noteFirstToken(modelId, FILLER_HARD_STOP_MS * 10);
            return { modelId, ok: false, totalMs, text: text.trim(), error: text.trim().slice(0, 120) };
        }
        noteFirstToken(modelId, first);
        persistSpeed(modelId, first);
        const words = text.trim().split(/\s+/).filter(Boolean).length;
        const streamSec = Math.max(0.001, (totalMs - first) / 1000);
        // One chunk = the reply arrived whole (not streamed): no meaningful rate.
        const wordsPerSec = chunks > 1 ? Math.round((words / streamSec) * 10) / 10 : undefined;
        return { modelId, ok: true, firstTokenMs: first, totalMs, wordsPerSec, text: text.trim() };
    } catch (e: any) {
        return { modelId, ok: false, totalMs: Date.now() - t0, error: String(e?.message ?? e).slice(0, 200) };
    }
}

// ── IPC (Settings → AI Providers → Filler model) ──
export function registerFillerIpc(safeHandle: (channel: string, fn: (...args: any[]) => any) => void, getHelper: () => FillerHelper): void {
    const config = () => {
        const s = settings();
        return { model: getFillerSetting(), storyHint: s?.get('fillerStoryHint') === true };
    };
    const save = (key: string, value: unknown) => {
        try {
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            require('../services/SettingsManager').SettingsManager.getInstance().set(key, value);
        } catch { /* config() reports the real state */ }
        return config();
    };
    safeHandle('filler:get-config', () => config());
    safeHandle('filler:set-model', (_e: unknown, model: string) => save('fillerModel', typeof model === 'string' && model ? model : 'auto'));
    safeHandle('filler:set-story-hint', (_e: unknown, on: boolean) => save('fillerStoryHint', Boolean(on)));
    safeHandle('filler:filter-candidates', (_e: unknown, ids: string[]) => (Array.isArray(ids) ? ids : []).filter((id) => {
        try { return getHelper().canDispatchFillerModel(String(id)); } catch { return false; }
    }));
    safeHandle('filler:test-speed', (_e: unknown, modelId: string) => testFillerSpeed(getHelper(), String(modelId || '')));
}
