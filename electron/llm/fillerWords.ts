// Personal build (Natively Z): how many spoken filler words answers use. The one source of truth for
// filler: Output Style keeps tone and wording, this sets the amount. Shown in the prompt as its own part.
export type FillerWords = 'auto' | 'clean' | 'light' | 'natural' | 'heavy';
export const FILLER_WORDS: readonly FillerWords[] = ['auto', 'clean', 'light', 'natural', 'heavy'];
/** New users get spoken-sounding answers. */
export const DEFAULT_FILLER_WORDS: FillerWords = 'natural';

export const FILLER_WORDS_LINES: Record<Exclude<FillerWords, 'auto'>, string> = {
    clean: 'Clean: no filler words. Polished, but still conversational.',
    light: 'Light: a few natural ones, like "so", "honestly", "I mean".',
    natural: 'Natural: regular "um", "uh", "yeah", "like", "you know", the way people really talk.',
    heavy: 'Heavy: lots of them, chained together, like "and uh... yeah...", "so, um, like...", "I mean, yeah, like...", with "..." for pauses.',
};

export function resolveFillerWords(value: unknown): FillerWords {
    return FILLER_WORDS.includes(value as FillerWords) ? value as FillerWords : DEFAULT_FILLER_WORDS;
}
export function getFillerWords(): FillerWords {
    try {
        const { SettingsManager } = require('../services/SettingsManager');
        return resolveFillerWords(SettingsManager.getInstance().get('fillerWords'));
    } catch { return DEFAULT_FILLER_WORDS; }
}
export function registerFillerWordsIpc(safeHandle: (channel: string, fn: (...args: any[]) => any) => void): void {
    safeHandle('filler-words:get', getFillerWords);
    safeHandle('filler-words:set', (_event: unknown, value: unknown) => {
        if (!FILLER_WORDS.includes(value as FillerWords)) throw new Error('Choose a valid filler-word setting.');
        const { SettingsManager } = require('../services/SettingsManager');
        if (!SettingsManager.getInstance().set('fillerWords', value)) throw new Error('Could not save filler words. Please try again.');
        const { BrowserWindow } = require('electron');
        for (const win of BrowserWindow.getAllWindows()) {
            if (!win.isDestroyed()) win.webContents.send('filler-words:changed', value);
        }
        return value as FillerWords;
    });
}
