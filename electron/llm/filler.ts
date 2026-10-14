// Personal build (Natively Z): filler / bridge line.
//
// When a live question triggers an answer, a fast model streams a short spoken
// complete, neutral opening sentence IN PARALLEL with the main answer, so the
// user can start talking at once. It never waits for, feeds, or replaces the main
// answer, and any failure is silent. Design: docs/filler-design.md (workspace).

import { readMyContext } from './myContext';

export const FILLER_HARD_STOP_MS = 6000;
const FILLER_MAX_CHARS = 240;
const RECENT_KEEP = 5;

export type FillerSetting = 'auto' | 'off' | string;
const mainAnswersStarted = new WeakSet<AbortSignal>();
export function markMainAnswerStarted(signal?: AbortSignal): void {
    if (signal) mainAnswersStarted.add(signal);
}

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
export const PARALLEL_MAIN_OPENING_RULE = 'A separate parallel model may show a short, complete conversational opening. Begin directly with the first substantive point: no acknowledgement, repeated question, topic echo, or second introduction. Do not assume a particular opening was shown or refer to it. Your answer must stand on its own. Preserve grounding and any explicitly requested code, JSON, or other output format.';

export function withParallelMainOpening(prompt: string, enabled: boolean): string {
    return enabled && !prompt.includes(PARALLEL_MAIN_OPENING_RULE)
        ? `${prompt}\n\n${PARALLEL_MAIN_OPENING_RULE}` : prompt;
}

const recent: string[] = [];

/** The user's voice/style sections from my-context.md (headings mentioning voice, style, tone, attitude…). */
export function voiceFromContext(text: string): string {
    const secs = String(text || '').split(/^(?=##\s)/m);
    const voice = secs.filter((s) => /^##\s.*\b(voice|style|tone|sound|how to answer|speak)/i.test(s.split('\n')[0]));
    return voice.join('\n').trim().slice(0, 900);
}

export function buildFillerPrompt(question: string, opts: { voice?: string; recentLines?: string[] } = {}): { system: string; user: string } {
    const words = '6 to 12';
    const system = [
        'You write the first few words a person says out loud right after being asked a question in a live conversation or interview, to fill the pause while they gather their thoughts.',
        `Write ONE short, COMPLETE sentence of ${words} words, spoken, casual, first person. Use the same language as the question unless the supplied voice instructions specify otherwise.`,
        'You ARE that person (a human), never an assistant or an AI. Never offer help or ask how you can help.',
        'Write a neutral conversational opening that can be followed immediately by the first substantive point. Do not repeat the question or choose the direction of the answer.',
        'Do NOT narrate your thinking: never "let me think", "where do I start", "how do I put this", "good question", "hmm". At most ONE filler word (like "so", "yeah" or "okay"). No "..." pauses: use commas.',
        'NEVER state any fact, name, company, number, date, opinion, decision or the answer itself. Never say "great question". No lists, no quotes, no emojis.',
        'Do not invent details like a time, place or scene ("that afternoon", "back in college"), and no slogans or vague claims ("AI changes everything"). Keep it plain and literal.',
        'Never select or name a story, experience, employer, project, reason, opinion, or number of points. The main answer independently selects those details.',
        opts.voice ? `Sound like this person (style only, do not use any facts from it):\n${opts.voice}` : '',
        opts.recentLines?.length ? `Do not reuse the wording of these earlier lines:\n${opts.recentLines.map((l) => `- ${l}`).join('\n')}` : '',
        'End with terminal punctuation. Never end on an unfinished clause, a comma, colon, ellipsis, "so", "and", or "because". Do not require the next sentence to complete yours.',
        'Output only the line, on one line.',
    ].filter(Boolean).join('\n');
    return { system, user: `Question: ${question.trim()}
Write only the filler line (${words} words, no facts).` };
}

/** Only commit a complete opening; partial provider output must never be read. */
export function completeFillerSentence(text: string, maxChars = 160): string {
    const line = cleanFillerChunk(text).split(/[\r\n]/, 1)[0].trim();
    const ending = /[.!?。！？](?=\s|$)/g;
    for (const match of line.matchAll(ending)) {
        const sentence = line.slice(0, match.index! + 1).trim();
        if (sentence.length > maxChars) return '';
        if (/\.{2,}|…/.test(sentence) || /\b(so|and|because|but|or|then)[.!?]$/i.test(sentence)) return '';
        return sentence;
    }
    return '';
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

export function cleanFillerChunk(s: string): string {
    // "..." pauses read as robotic in a spoken line: turn them into a comma.
    return s.replace(/["“”]/g, '').replace(/\[\[[A-Z_]+\]\]/g, '').replace(/\s*(\.{3}|…)(?=\s*\S)/g, ',');
}

/**
 * Fire-and-forget. Buffers a complete sentence, then publishes it once.
 * Never throws. Stops on signal abort, after FILLER_HARD_STOP_MS, or at FILLER_MAX_CHARS.
 */
export async function runFiller(input: {
    helper: FillerHelper;
    question: string;
    signal: AbortSignal;
    onToken: (chunk: string) => void;
}): Promise<string> {
    const question = String(input.question || '').trim();
    if (!question || input.signal.aborted || mainAnswersStarted.has(input.signal)) return '';
    let modelId: string | null = null;
    try {
        modelId = resolveFillerModel(input.helper);
        if (!modelId) return '';
        const ctx = readMyContext();
        const { system, user } = buildFillerPrompt(question, {
            voice: voiceFromContext(ctx),
            recentLines: recent,
        });
        const signal = AbortSignal.any([input.signal, AbortSignal.timeout(FILLER_HARD_STOP_MS)]);
        const maxChars = 160;
        const t0 = Date.now();
        let text = '';
        let buffer = '';
        for await (const raw of input.helper.streamFillerLine(modelId, system, user, signal)) {
            if (signal.aborted || mainAnswersStarted.has(input.signal)) return '';
            const chunk = cleanFillerChunk(String(raw ?? ''));
            if (!chunk) continue;
            if (!buffer) noteFirstToken(modelId, Date.now() - t0);
            buffer += chunk;
            if (looksLikeServiceNotice(buffer)) throw new Error(`service notice: ${buffer.slice(0, 80)}`);
            text = completeFillerSentence(buffer, maxChars);
            if (text) break;
            if (buffer.length > maxChars || /[\r\n]/.test(buffer)) break;
        }
        if (signal.aborted || mainAnswersStarted.has(input.signal)) return '';
        if (!text) {
            noteFirstToken(modelId, FILLER_HARD_STOP_MS * 10);
            return '';
        }
        input.onToken(text);
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
