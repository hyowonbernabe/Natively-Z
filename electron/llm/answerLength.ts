// Personal build: user-controlled answer length, independent of facts and voice.
export type AnswerLength = 'auto' | 'brief' | 'balanced' | 'detailed';
export const ANSWER_LENGTHS: readonly AnswerLength[] = ['auto', 'brief', 'balanced', 'detailed'];
export function resolveAnswerLength(value: unknown): AnswerLength {
    return ANSWER_LENGTHS.includes(value as AnswerLength) ? value as AnswerLength : 'auto';
}
export function getAnswerLength(): AnswerLength {
    try {
        const { SettingsManager } = require('../services/SettingsManager');
        return resolveAnswerLength(SettingsManager.getInstance().get('answerLength'));
    } catch { return 'auto'; }
}
export function withAnswerLengthSystemPrompt(prompt: string, length = getAnswerLength()): string {
    if (length === 'auto' || prompt.includes('<user_answer_length>')) return prompt;
    const guidance = {
        brief: 'BRIEF: aim for roughly 50 to 90 words. Give the direct answer and essential context, with only the most useful supporting detail.',
        balanced: 'BALANCED: aim for roughly 100 to 170 words. Explain the answer with enough context, a useful example or key steps, and a grounded outcome when relevant.',
        detailed: 'DETAILED: aim for roughly 180 to 280 words when the question warrants it. Develop a connected explanation, including relevant context, how or why it works, useful specifics and an outcome or takeaway.',
    }[length];
    return `${prompt}\n\n<user_answer_length>\n${guidance}\nThis user-selected answer length overrides generic brevity, sentence-count limits and duration or length defaults in saved Output Style. Preserve its vocabulary and tone. Explicit length or format requests in the current question take precedence, including one sentence, code-only, JSON or a requested word count. These word ranges are guides for natural-language answers, not hard truncation limits or targets for code. Keep simple questions appropriately short. Do not pad, invent facts, add unrelated anecdotes or change topic to reach a word count. Explain an unfamiliar project briefly before its details when relevant. This controls the main answer only; it does not expand the parallel opening.\n</user_answer_length>`;
}
export function registerAnswerLengthIpc(safeHandle: (channel: string, fn: (...args: any[]) => any) => void): void {
    safeHandle('answer-length:get', getAnswerLength);
    safeHandle('answer-length:set', (_event: unknown, value: unknown) => {
        if (!ANSWER_LENGTHS.includes(value as AnswerLength)) throw new Error('Choose a valid answer length.');
        const { SettingsManager } = require('../services/SettingsManager');
        if (!SettingsManager.getInstance().set('answerLength', value)) throw new Error('Could not save answer length. Please try again.');
        const { BrowserWindow } = require('electron');
        for (const win of BrowserWindow.getAllWindows()) {
            if (!win.isDestroyed()) win.webContents.send('answer-length:changed', value);
        }
        return value as AnswerLength;
    });
}
