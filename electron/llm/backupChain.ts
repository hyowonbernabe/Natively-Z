// Personal build (Natively Z): backup chain.
//
// When the model answering a turn fails, the turn moves to the next model instead
// of ending with no answer. Design: docs/scratchpad/backup-chain-design.md (workspace).
//
//   instant failure (quota, usage limit, auth, "no longer available", error) → next model now
//   silent for its first-token budget (8 s cloud) → retry it AND start the next model in
//   parallel; the first to produce words wins, the rest are cancelled before showing anything
//   failed models are skipped for a while (quota ~1 h or Retry-After, gone 24 h, timeout 3 min);
//   if every model is cooling, they are tried anyway, least recently failed first
//
// Nothing shown is ever replaced: the winner is chosen BEFORE its first words go out.

import { EventEmitter } from 'events';

export const BACKUP_FIRST_TOKEN_MS = 8000;
export const BACKUP_LOCAL_FIRST_TOKEN_MS = 30000;
export const BACKUP_VISION_FIRST_TOKEN_MS = 20000;
/** Outer "no useful words yet" ceiling while the chain is on: room for several models to get a turn. */
export const BACKUP_OUTER_CEILING_MS = 30000;
const NOTICE_CHECK_CHARS = 40;
/**
 * A provider notice sent as answer text. Stricter than the filler's check: a real answer may well
 * start with "Error handling…" or "Sign in flows…", so only unmistakable service phrasing counts.
 */
const ANSWER_NOTICE_RE = /\b(is no longer available|are no longer available|(model|service) is (currently |temporarily )?unavailable|please (switch|select|choose) (to )?(a |another |a different |a newer )?model|quota (has been |is )?(exceeded|exhausted)|rate limit (exceeded|reached)|you('ve| have) (hit|reached) (your|the) (usage |rate )?limit|resource_exhausted)\b/i;
/** Only the FIRST sentence is checked: a real answer can mention limits later ("…until the rate limit is reached"). */
export function looksLikeAnswerNotice(text: string): boolean {
    // A sentence ends at . ! ? followed by space/end ("Gemini 3.5 Flash" is one sentence).
    const firstSentence = String(text || '').slice(0, 160).split(/[.!?](?=\s|$)|\n/)[0];
    return ANSWER_NOTICE_RE.test(firstSentence);
}
/** LLMHelper's in-band "answer was cut off" marker; must pass through as its own chunk. */
const TRUNCATION_SENTINEL = '__NATIVELY_STREAM_TRUNCATED__';

export type FailKind = 'quota' | 'gone' | 'auth' | 'timeout' | 'error';
export const COOLDOWN_MS: Record<FailKind, number> = {
    quota: 60 * 60_000,
    gone: 24 * 60 * 60_000,
    auth: 60 * 60_000,
    timeout: 3 * 60_000,
    error: 60_000,
};

export interface Rung {
    id: string;
    name: string;
    firstTokenMs: number;
    open: (signal: AbortSignal) => AsyncGenerator<string, void, unknown> | AsyncIterable<string>;
}

// ── settings ──
function settings(): { get(k: string): any; set(k: string, v: any): any } | null {
    try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        return require('../services/SettingsManager').SettingsManager.getInstance();
    } catch {
        return null;
    }
}
/** Only inside the running app: unit tests drive the pipeline with fakes and must see stock behaviour. */
let inApp: boolean | undefined;
function runningInApp(): boolean {
    if (inApp === undefined) {
        try {
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            const e = require('electron');
            inApp = typeof e?.app?.getPath === 'function';
        } catch { inApp = false; }
    }
    return inApp;
}
export function isBackupChainEnabled(): boolean {
    if (process.env.NATIVELY_BACKUP_CHAIN === '0' || !runningInApp()) return false;
    return settings()?.get('backupChainEnabled') !== false;
}
/**
 * Outer first-useful deadline: unchanged when the chain is off or skipped for this turn (screenshot
 * turns and a local Ollama model run without it), at least the ceiling when it will run.
 */
export function outerDeadlineMs(ms: number, chainSkipped = false): number {
    return isBackupChainEnabled() && !chainSkipped ? Math.max(ms, BACKUP_OUTER_CEILING_MS) : ms;
}

/** Turns that must measure ONE model (speed calibration) opt out of the chain by their signal. */
const optedOut = new WeakSet<AbortSignal>();
export function noBackup(signal: AbortSignal): AbortSignal { optedOut.add(signal); return signal; }
export function isOptedOut(signal: AbortSignal | undefined): boolean { return !!signal && optedOut.has(signal); }

export function backupPinned(): string[] {
    const v = settings()?.get('backupPinned');
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
}
export function backupKnownModels(): string[] {
    const v = settings()?.get('backupKnownModels');
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
}
/** Measured first-token time for a model: this session's observations, else the last speed test. */
export function modelSpeedMs(id: string): number | undefined {
    try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const live = require('./filler').observedFirstTokenMs?.(id);
        if (typeof live === 'number') return live;
    } catch { /* filler unavailable */ }
    const saved = settings()?.get('modelSpeedMs');
    const v = saved && typeof saved === 'object' ? Number(saved[id]) : NaN;
    return Number.isFinite(v) ? v : undefined;
}
/** A display name in the app's own style: "Gemini 3.5 Flash High (Antigravity)", "Codex GPT-5.6 Sol". */
export function prettyModelName(id: string): string {
    const words = (s: string) => s.split(/[-_\s]+/).filter(Boolean)
        .map((w) => (/^gpt$/i.test(w) ? 'GPT' : /^\d/.test(w) ? w : w[0].toUpperCase() + w.slice(1))).join(' ')
        .replace(/GPT (\d)/g, 'GPT-$1');
    if (id.startsWith('antigravity:')) return `${words(id.slice('antigravity:'.length))} (Antigravity)`;
    if (id.startsWith('codex-cli')) return id.includes(':') ? `Codex ${words(id.split(':')[1])}` : 'Codex';
    if (id.startsWith('ollama-')) return `${id.slice('ollama-'.length)} (Local)`;
    return words(id.replace(/^[\w.-]+\//, '')) || id;
}

// ── "answered by a backup" notice → main.ts forwards it to the overlay ──
export const backupEvents = new EventEmitter();
export function announceBackupUsed(id: string, name: string, failedId: string): void {
    const c = cooling.get(failedId);
    const reason = !c ? 'was skipped' : c.kind === 'quota' ? 'hit a usage limit' : c.kind === 'gone' ? 'is unavailable'
        : c.kind === 'auth' ? 'has a sign-in or key problem' : c.kind === 'timeout' ? "didn't respond in time" : 'failed';
    console.log(`[Backup] answered by ${id} (${failedId} ${reason})`);
    backupEvents.emit('used', { id, name, failedName: prettyModelName(failedId), reason, at: Date.now() });
}

// ── cooldown memory (in-memory; a restart forgets, and a still-limited model then fails instantly) ──
const cooling = new Map<string, { until: number; kind: FailKind; at: number }>();
export function noteFailure(id: string, kind: FailKind, retryAfterMs?: number, now = Date.now()): void {
    const ms = kind === 'quota' && retryAfterMs && retryAfterMs > 0 ? retryAfterMs : COOLDOWN_MS[kind];
    cooling.set(id, { until: now + ms, kind, at: now });
    console.warn(`[Backup] ${id} failed (${kind}) — skipped for ${Math.round(ms / 60000)} min`);
}
export function noteSuccess(id: string): void { cooling.delete(id); }
export function isCooling(id: string, now = Date.now()): boolean { return (cooling.get(id)?.until ?? 0) > now; }
export function _resetCooling(): void { cooling.clear(); }

/** Error → failure kind (+ Retry-After if the error says). */
export function classifyFailure(err: unknown): { kind: FailKind; retryAfterMs?: number } {
    const e = err as any;
    const status = Number(e?.status ?? e?.statusCode ?? e?.response?.status ?? 0);
    const msg = String(e?.message ?? e ?? '').toLowerCase();
    const code = String(e?.code ?? '').toLowerCase();
    let retryAfterMs: number | undefined;
    const ra = Number(e?.retryAfterMs ?? (e?.retryAfter ? Number(e.retryAfter) * 1000 : NaN));
    if (Number.isFinite(ra) && ra > 0) retryAfterMs = ra;
    const m = msg.match(/(?:retry|try again|resets?) (?:after|in) (\d+)\s*(second|minute|hour)/);
    if (!retryAfterMs && m) retryAfterMs = Number(m[1]) * (m[2] === 'hour' ? 3_600_000 : m[2] === 'minute' ? 60_000 : 1000);
    if (/no longer available|model[_ ]?not[_ ]?found|does not exist|deprecated|decommissioned|model_gone/.test(msg) || status === 404 || status === 410) return { kind: 'gone' };
    if (status === 429 || /quota|rate.?limit|usage limit|resource_exhausted|exhausted|too many requests|limit reached|cooldown|\b429\b/.test(msg)) return { kind: 'quota', retryAfterMs };
    if (status === 401 || status === 403 || /auth_required|auth_revoked|unauthori[sz]ed|forbidden|invalid (api )?key|sign in|signed out|api key/.test(msg) || /auth/.test(code)) return { kind: 'auth' };
    if (/timed? ?out|timeout|deadline/.test(msg)) return { kind: 'timeout' };
    return { kind: 'error' };
}

/** Active model first, then the user's picks, then everything else fastest first. Cooling models go last. */
export function orderModels(input: {
    active: string;
    pinned: string[];
    known: string[];
    speedMs: (id: string) => number | undefined;
    now?: number;
}): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    const add = (id: string) => { if (id && !seen.has(id)) { seen.add(id); out.push(id); } };
    add(input.active);
    input.pinned.forEach(add);
    const rest = input.known.filter((id) => !seen.has(id));
    rest.sort((a, b) => (input.speedMs(a) ?? 1e9) - (input.speedMs(b) ?? 1e9));
    rest.forEach(add);
    const now = input.now ?? Date.now();
    const ready = out.filter((id) => !isCooling(id, now));
    const cold = out.filter((id) => isCooling(id, now)).sort((a, b) => (cooling.get(a)!.at - cooling.get(b)!.at));
    return [...ready, ...cold];
}

// ── the race ──
interface Attempt {
    rung: Rung;
    ac: AbortController;
    iterator: AsyncIterator<string>;
    /** Resolves with the held opening text once it is known not to be a service notice. */
    first: Promise<{ held: string; done: boolean; extra?: string }>;
    detach: () => void;
    /** 1 = first attempt of this rung, 2 = its retry. */
    nth: number;
}

function startAttempt(rung: Rung, outer: AbortSignal, nth = 1): Attempt {
    const ac = new AbortController();
    const onAbort = () => ac.abort(outer.reason);
    if (outer.aborted) ac.abort(outer.reason); else outer.addEventListener('abort', onAbort, { once: true });
    const detach = () => outer.removeEventListener('abort', onAbort);
    const iterator = (rung.open(ac.signal) as AsyncIterable<string>)[Symbol.asyncIterator]();
    const first = (async () => {
        let held = '';
        for (;;) {
            const r = await iterator.next();
            // An empty reply is still an answer (some paths deliver their result another way, e.g.
            // negotiation coaching): passing it on avoids repeating that side effect on every model.
            if (r.done) {
                if (held.trim() && looksLikeAnswerNotice(held)) throw new Error(`service notice: ${held.slice(0, 120)}`);
                return { held, done: true };
            }
            const chunk = String(r.value ?? '');
            if (chunk === TRUNCATION_SENTINEL) {
                if (!held.trim()) throw new Error('stream cut off before any words');
                return { held, done: false, extra: chunk };
            }
            held += chunk;
            if (held.trim().length >= NOTICE_CHECK_CHARS) {
                if (looksLikeAnswerNotice(held)) throw new Error(`service notice: ${held.slice(0, 120)}`);
                return { held, done: false };
            }
        }
    })();
    first.catch(() => { /* handled by the race */ });
    return { rung, ac, iterator, first, detach, nth };
}

function stop(a: Attempt): void {
    a.detach();
    try { a.ac.abort('backup: stopped'); } catch { /* noop */ }
    try { void Promise.resolve(a.iterator.return?.(undefined as any)).catch(() => {}); } catch { /* noop */ }
}

const TIMEOUT = Symbol('timeout');

type RaceResult =
    | { kind: 'won'; a: Attempt; held: string; done: boolean; extra?: string }
    | { kind: 'timeout' }
    | { kind: 'all_failed' };

/** First attempt in `set` to produce real words; or why none did within `ms`. */
async function raceFirst(set: Attempt[], ms: number, signal: AbortSignal, run: { lastError?: unknown; failed: WeakSet<Attempt> }): Promise<RaceResult> {
    const pending = new Set(set);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<typeof TIMEOUT>((r) => { timer = setTimeout(() => r(TIMEOUT), ms); });
    let onAbort: (() => void) | undefined;
    const aborted = new Promise<typeof TIMEOUT>((r) => {
        onAbort = () => r(TIMEOUT);
        if (signal.aborted) r(TIMEOUT); else signal.addEventListener('abort', onAbort, { once: true });
    });
    try {
        while (pending.size) {
            const res = await Promise.race([
                timeout, aborted,
                ...[...pending].map((a) => a.first.then(
                    (v) => ({ a, ok: true as const, v }),
                    (err) => ({ a, ok: false as const, err }),
                )),
            ]);
            if (res === TIMEOUT) return { kind: 'timeout' };
            if (res.ok) return { kind: 'won', a: res.a, held: res.v.held, done: res.v.done, extra: res.v.extra };
            pending.delete(res.a);
            run.failed.add(res.a);
            const f = classifyFailure(res.err);
            noteFailure(res.a.rung.id, f.kind, f.retryAfterMs);
            run.lastError = res.err;
        }
        return { kind: 'all_failed' };
    } finally {
        if (timer) clearTimeout(timer);
        if (onAbort) signal.removeEventListener('abort', onAbort);
    }
}

/**
 * Streams the first rung that answers. `onAnswered(rung, index)` fires once, before its first words.
 * Throws the last failure if no rung answers.
 */
export async function* runBackupChain(
    rungs: Rung[],
    signal: AbortSignal,
    onAnswered?: (rung: Rung, index: number, nth: number) => void,
): AsyncGenerator<string, void, unknown> {
    const run: { lastError?: unknown; failed: WeakSet<Attempt> } = { failed: new WeakSet() };
    let winner: Extract<RaceResult, { kind: 'won' }> | null = null;
    const live: Attempt[] = [];
    let i = 0;
    while (i < rungs.length && !winner && !signal.aborted) {
        const rung = rungs[i];
        const a0 = startAttempt(rung, signal);
        live.push(a0);
        const r1 = await raceFirst([a0], rung.firstTokenMs, signal, run);
        if (r1.kind === 'won') { winner = r1; break; }
        if (signal.aborted) break;
        if (r1.kind === 'all_failed') { i++; continue; } // instant failure: next model now
        // Silent past its budget: retry it AND start the next model; first words win.
        console.warn(`[Backup] ${rung.id} silent for ${rung.firstTokenMs} ms — retrying it alongside the next model`);
        const retry = startAttempt(rung, signal, 2);
        const next = rungs[i + 1] ? startAttempt(rungs[i + 1], signal) : null;
        live.push(retry, ...(next ? [next] : []));
        const r2 = await raceFirst([a0, retry, ...(next ? [next] : [])], Math.max(rung.firstTokenMs, next?.rung.firstTokenMs ?? 0), signal, run);
        if (r2.kind === 'won') { winner = r2; break; }
        if (signal.aborted) break;
        if (!isCooling(rung.id)) noteFailure(rung.id, 'timeout');
        if (next && !run.failed.has(next) && !isCooling(next.rung.id)) noteFailure(next.rung.id, 'timeout');
        for (const a of [a0, retry, ...(next ? [next] : [])]) stop(a);
        i += next ? 2 : 1;
    }
    for (const a of live) if (a !== winner?.a) stop(a);
    if (!winner) {
        if (signal.aborted) return;
        throw run.lastError instanceof Error ? run.lastError : new Error('Every model in the backup chain failed or timed out.');
    }
    const idx = rungs.indexOf(winner.a.rung);
    noteSuccess(winner.a.rung.id);
    onAnswered?.(winner.a.rung, idx, winner.a.nth);
    // Whatever ends the turn early (output cap, repetition guard, a newer question), the winner's
    // request must be stopped too — before this wrapper, the caller closed the provider directly.
    let finished = false;
    try {
        if (winner.held) yield winner.held;
        if (winner.extra) yield winner.extra;
        if (winner.done) { finished = true; return; }
        for (;;) {
            const r = await winner.a.iterator.next();
            if (r.done) { finished = true; return; }
            yield r.value;
        }
    } finally {
        if (finished) winner.a.detach(); else stop(winner.a);
    }
}

// ── IPC (Settings → AI Providers → Backup order) ──
export function registerBackupIpc(safeHandle: (channel: string, fn: (...args: any[]) => any) => void): void {
    const config = () => ({
        enabled: isBackupChainEnabled(),
        pinned: backupPinned(),
        cooling: [...cooling.entries()].filter(([, c]) => c.until > Date.now()).map(([id, c]) => ({ id, kind: c.kind, until: c.until })),
    });
    const save = (k: string, v: unknown) => { try { settings()?.set(k, v); } catch { /* config() reports the real state */ } };
    // (pinned list is saved whole by the renderer, which edits the FULL saved list, not just visible models)
    safeHandle('backup:get-config', () => config());
    safeHandle('backup:set-enabled', (_e: unknown, on: boolean) => { save('backupChainEnabled', Boolean(on)); return config(); });
    safeHandle('backup:set-pinned', (_e: unknown, ids: string[]) => { save('backupPinned', (Array.isArray(ids) ? ids : []).filter((x) => typeof x === 'string').slice(0, 50)); return config(); });
    // The renderer owns the list of connected models; it reports it whenever the provider settings render.
    // Merged, never replaced: a half-loaded settings screen (Ollama off, keys still loading) must not
    // shrink the list. A model that is gone for good just fails instantly and cools down.
    safeHandle('backup:set-known', (_e: unknown, ids: string[]) => {
        const add = (Array.isArray(ids) ? ids : []).filter((x) => typeof x === 'string');
        if (!add.length) return false;
        const merged = [...new Set([...backupKnownModels(), ...add])].slice(0, 200);
        try { return settings()?.set('backupKnownModels', merged) !== false; } catch { return false; }
    });
    safeHandle('backup:clear-cooling', (_e: unknown, id?: string) => { if (id) cooling.delete(String(id)); else cooling.clear(); return config(); });
}
