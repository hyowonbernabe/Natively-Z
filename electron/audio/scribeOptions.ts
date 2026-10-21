// Personal build (Natively Z): ElevenLabs Scribe v2 Realtime options (Settings → Audio → Scribe options).
// Read by ElevenLabsStreamingSTT on every connect, so a change applies from the next session.
// API facts (elevenlabs.io/docs, 2026-10): `no_verbatim` drops fillers/false starts; `keyterms` biases
// recognition, at most 50 terms of 20 characters, repeated as a query key, +$0.08/h; `commit_strategy`
// `turn_prediction` commits when the model predicts the speaker finished (falls back to `vad` if refused).

export const SCRIBE_KEYTERM_MAX = 50;
export const SCRIBE_KEYTERM_CHARS = 20;

export interface ScribeSettings {
    /** Clean transcript (no stutters / false starts). Default on. */
    clean: boolean;
    /** Send a word list so names are spelled right. Default on (costs extra). */
    keyterms: boolean;
    /** One term per line; empty = built from My Context. */
    customTerms: string;
    /** Commit when the speaker seems finished, not after a fixed silence. Default on, with fallback. */
    turnPrediction: boolean;
}

export interface ScribeOptions { clean: boolean; keyterms: string[]; turnPrediction: boolean }

function settingsManager(): { get(k: string): any; set(k: string, v: unknown): boolean } | null {
    try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        return require('../services/SettingsManager').SettingsManager.getInstance();
    } catch { return null; }
}

export function resolveScribeSettings(saved: any): ScribeSettings {
    const s = saved && typeof saved === 'object' ? saved : {};
    return {
        clean: s.clean !== false,
        keyterms: s.keyterms !== false,
        customTerms: typeof s.customTerms === 'string' ? s.customTerms : '',
        turnPrediction: s.turnPrediction !== false,
    };
}

export function getScribeSettings(): ScribeSettings {
    return resolveScribeSettings(settingsManager()?.get('scribeOptions'));
}

/** Names worth biasing toward, from the context file: CamelCase / mixed names and the subjects of story titles. */
export function autoKeyterms(contextText: string): string[] {
    const terms: string[] = [];
    const add = (t: string) => {
        const term = t.trim().replace(/[.,;:)]+$/, '');
        if (term.length >= 3 && term.length <= SCRIBE_KEYTERM_CHARS && !terms.some(x => x.toLowerCase() === term.toLowerCase())) terms.push(term);
    };
    // "## Story: topic / topic: Subject words (note)" → only the capitalised name runs ("ZuraLog outages" → "ZuraLog").
    for (const m of contextText.matchAll(/^##\s+Story:.*:\s*([^\n(]+)/gim)) {
        for (const name of m[1].matchAll(/\b[A-Z0-9][\w-]*(?:\s+[A-Z0-9][\w-]*)*/g)) add(name[0]);
    }
    // ZuraLog, MultiplyOS, DevKada, Hack4Gov…
    for (const m of contextText.matchAll(/\b(?:[A-Z][a-z0-9]+[A-Z][A-Za-z0-9]*|[A-Z][A-Za-z]*\d+[A-Za-z0-9]*)\b/g)) add(m[0]);
    return terms.slice(0, SCRIBE_KEYTERM_MAX);
}

export function scribeKeyterms(settings: ScribeSettings = getScribeSettings()): string[] {
    if (!settings.keyterms) return [];
    const custom = settings.customTerms.split(/\r?\n/).map(t => t.trim()).filter(Boolean);
    if (custom.length) return custom.filter(t => t.length <= SCRIBE_KEYTERM_CHARS).slice(0, SCRIBE_KEYTERM_MAX);
    try { return autoKeyterms(require('../llm/myContext').readMyContext()); } catch { return []; }
}

export function getScribeOptions(): ScribeOptions {
    const s = getScribeSettings();
    return { clean: s.clean, keyterms: scribeKeyterms(s), turnPrediction: s.turnPrediction };
}

export function registerScribeOptionsIpc(safeHandle: (channel: string, fn: (...args: any[]) => any) => void): void {
    const payload = () => { // terms = the automatic list from My Context (shown as the fallback for an empty box)
        let terms: string[] = [];
        try { terms = autoKeyterms(require('../llm/myContext').readMyContext()); } catch { /* none */ }
        return { settings: getScribeSettings(), terms };
    };
    safeHandle('scribe-options:get', payload);
    safeHandle('scribe-options:set', (_e: unknown, next: unknown) => {
        const resolved = resolveScribeSettings(next);
        if (resolved.customTerms.length > 5000) throw new Error('Word list is too long.');
        if (!settingsManager()?.set('scribeOptions', resolved)) throw new Error('Could not save Scribe options. Please try again.');
        return payload();
    });
}
