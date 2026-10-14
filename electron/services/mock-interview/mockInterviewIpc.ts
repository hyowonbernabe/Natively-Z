import { app, BrowserWindow, dialog } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import type { AppState } from '../../main';
import { getOutputStyleText } from '../../llm/myContext';
import { MockInterviewService } from './MockInterviewService';
import { InterviewSpeech } from './InterviewSpeech';
import { interviewMarkdown } from './interviewPolicy';
import type { InterviewOptions, InterviewResult } from './types';

export function registerMockInterviewIpc(appState: AppState, safeHandle: (channel: string, fn: (...args: any[]) => any) => void): void {
    const speech = new InterviewSpeech();
    const captureIsCurrent = (key: string) => appState.getIsMeetingActive() && appState.getIntelligenceManager().conversationSessionId() === key;
    const service = new MockInterviewService({
        directory: path.join(app.getPath('userData'), 'mock-interviews'),
        model: () => appState.processingHelper.getLLMHelper().getCurrentModel(),
        generate: (system, user, signal) => appState.processingHelper.getLLMHelper().streamInterview(system, user, signal),
        startCapture: async title => {
            if (appState.getIsMeetingActive()) throw new Error('End the current meeting before starting a spoken interview, or turn off the microphone and type your answers.');
            if (appState.getAmbientChatEnabled()) throw new Error('Turn off Ambient AI Chat in General settings to use microphone answers, or start with the microphone off.');
            await appState.startMeeting({ title, mockInterview: true });
            return appState.getIntelligenceManager().conversationSessionId();
        },
        endCapture: async key => { if (captureIsCurrent(key)) await appState.endMeeting(); },
        captureIsCurrent,
        finalizeMicrophone: () => { appState.finalizeMicSTT(); },
        speak: (text, signal) => speech.speak(text, signal),
        cancelSpeech: () => speech.cancel(),
        voice: () => getOutputStyleText(),
    });
    service.on('changed', state => {
        appState.mockInterviewTranscriptObserver = state.microphoneActive ? segment => service.transcript(segment) : null;
        appState.mockInterviewLevelObserver = state.microphoneActive ? level => service.microphoneLevel(level) : null;
        for (const window of BrowserWindow.getAllWindows()) {
            if (!window.isDestroyed() && !window.webContents.isDestroyed()) window.webContents.send('mock-interview:changed', state);
        }
    });
    app.once('before-quit', () => {
        appState.mockInterviewTranscriptObserver = null;
        appState.mockInterviewLevelObserver = null;
        service.dispose();
    });
    const action = async (fn: () => unknown): Promise<InterviewResult> => {
        try { await fn(); return { success: true, state: service.snapshot() }; }
        catch (error) { return { success: false, state: service.snapshot(), error: error instanceof Error ? error.message : 'Interview request failed.' }; }
    };
    safeHandle('mock-interview:get', () => service.snapshot());
    safeHandle('mock-interview:history', () => service.history());
    safeHandle('mock-interview:start', (_event, options: Partial<InterviewOptions>) => action(() => service.start(options || {})));
    safeHandle('mock-interview:next', () => action(() => service.next()));
    safeHandle('mock-interview:draft', (_event, text: string) => action(() => service.updateDraft(String(text || ''))));
    safeHandle('mock-interview:auto', (_event, enabled: boolean, seconds: number) => action(() => service.setAutoAdvance(enabled, seconds)));
    safeHandle('mock-interview:replay', () => action(() => service.replay()));
    safeHandle('mock-interview:stop-speaking', () => action(() => service.stopSpeaking()));
    safeHandle('mock-interview:finish', () => action(() => service.finish()));
    safeHandle('mock-interview:stop', () => action(() => service.stop()));
    safeHandle('mock-interview:load', (_event, id: string) => action(() => service.load(String(id))));
    safeHandle('mock-interview:export', async () => {
        const session = service.snapshot().session;
        if (!session) return { success: false, error: 'No interview to export.' };
        const result = await dialog.showSaveDialog({
            title: 'Export interview transcript',
            defaultPath: `Mock interview-${new Date(session.startedAt).toISOString().slice(0, 10)}.md`,
            filters: [{ name: 'Markdown transcript', extensions: ['md'] }],
        });
        if (result.canceled || !result.filePath) return { success: false, canceled: true };
        fs.writeFileSync(result.filePath, interviewMarkdown(session), 'utf8');
        return { success: true };
    });
}
