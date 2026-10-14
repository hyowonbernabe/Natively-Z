import React, { useEffect, useRef, useState } from 'react';
import { ArrowRight, Download, Loader2, Mic, Square, Volume2, X } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import type { InterviewOptions, InterviewResult, InterviewSession, InterviewState } from '../../electron/services/mock-interview/types';

const DEFAULTS: InterviewOptions = { role: 'Software / AI engineer', focus: 'mixed', language: 'English', questions: 5, microphone: true, spoken: true, autoAdvance: true, pauseSeconds: 5 };
const button = 'inline-flex items-center justify-center gap-2 rounded-lg border border-border-subtle bg-bg-elevated px-3 py-2 text-sm text-text-primary hover:bg-bg-subtle disabled:opacity-40 disabled:cursor-not-allowed';
const field = 'w-full rounded-lg border border-border-subtle bg-bg-primary px-3 py-2 text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-accent-primary';
const initial: InterviewState = { session: null, phase: 'idle', draft: '', partial: '', microphoneActive: false, level: 0, countdown: null, error: null, speechError: null };

const feedbackComponents = {
    p: ({ children }: { children?: React.ReactNode }) => <p className="mb-3">{children}</p>,
    h2: ({ children }: { children?: React.ReactNode }) => <h4 className="mb-2 mt-4 font-semibold">{children}</h4>,
    h3: ({ children }: { children?: React.ReactNode }) => <h4 className="mb-2 mt-4 font-semibold">{children}</h4>,
    ul: ({ children }: { children?: React.ReactNode }) => <ul className="mb-3 list-disc space-y-1 pl-5">{children}</ul>,
    ol: ({ children }: { children?: React.ReactNode }) => <ol className="mb-3 list-decimal space-y-1 pl-5">{children}</ol>,
    img: () => null,
    a: ({ children }: { children?: React.ReactNode }) => <span>{children}</span>,
};

function InterviewSetup({ options, setOptions, history, busy, onStart, onLoad }: {
    options: InterviewOptions;
    setOptions: React.Dispatch<React.SetStateAction<InterviewOptions>>;
    history: InterviewSession[];
    busy: boolean;
    onStart: () => void;
    onLoad: (id: string) => void;
}) {
    return (
    <form className="space-y-4" onSubmit={event => { event.preventDefault(); onStart(); }}>
        <label className="block space-y-2 text-sm">Role{options.focus === 'personal' ? ' (optional)' : ''}<input className={field} value={options.role} maxLength={300} onChange={event => setOptions({ ...options, role: event.target.value })} required={options.focus !== 'personal'} /></label>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <label className="space-y-2 text-sm">Focus<select className={field} value={options.focus} onChange={event => setOptions({ ...options, focus: event.target.value as InterviewOptions['focus'] })}><option value="personal">Personal & general</option><option value="mixed">Mixed</option><option value="behavioral">Experience & teamwork</option><option value="technical">Technical</option></select></label>
            <label className="space-y-2 text-sm">Language<select className={field} value={options.language} onChange={event => setOptions({ ...options, language: event.target.value as InterviewOptions['language'] })}><option>English</option><option>Filipino</option><option>English and Filipino</option></select></label>
            <label className="space-y-2 text-sm">Questions<select className={field} value={options.questions} onChange={event => setOptions({ ...options, questions: Number(event.target.value) })}>{[3, 5, 8, 10].map(count => <option key={count} value={count}>{count}</option>)}</select></label>
        </div>
        {options.focus === 'personal' && <p className="text-sm text-text-secondary">Practice introducing yourself, your interests, strengths, motivation and goals. Conversational questions, without technical quizzes.</p>}
        <div className="space-y-3 rounded-xl border border-border-subtle bg-bg-primary p-4 text-sm">
            <label className="flex items-center gap-3"><input type="checkbox" checked={options.microphone} onChange={event => setOptions({ ...options, microphone: event.target.checked })} />Use my microphone for answers</label>
            <label className="flex items-center gap-3"><input type="checkbox" checked={options.spoken} onChange={event => setOptions({ ...options, spoken: event.target.checked })} />Read questions aloud</label>
            <label className="flex items-center gap-3"><input type="checkbox" checked={options.autoAdvance} disabled={!options.microphone} onChange={event => setOptions({ ...options, autoAdvance: event.target.checked })} />Next question automatically after a pause</label>
            <label className="flex items-center gap-3">Pause length<select className={`${field} !w-auto`} value={options.pauseSeconds} onChange={event => setOptions({ ...options, pauseSeconds: Number(event.target.value) })}>{[3, 5, 7, 10].map(seconds => <option key={seconds} value={seconds}>{seconds} seconds</option>)}</select></label>
        </div>
        <p className="text-xs leading-relaxed text-text-secondary">Uses your selected AI model and a built-in system voice. Questions play through your default output device. Headphones keep the interviewer’s speech out of your microphone. Microphone practice starts its own meeting; typed practice can run without one.</p>
        <button type="submit" className={`${button} !bg-accent-primary !text-white`} disabled={busy || (options.focus !== 'personal' && !options.role.trim())}><Mic size={16} />Start interview</button>
        {history.length > 0 && <div className="space-y-2 border-t border-border-subtle pt-4"><h3 className="text-sm font-medium">Saved interviews</h3>{history.slice(0, 8).map(item => <button type="button" key={item.id} className={`${button} w-full !justify-between`} onClick={() => onLoad(item.id)}><span className="truncate">{item.options.role}</span><span className="shrink-0 text-xs text-text-secondary">{new Date(item.startedAt).toLocaleDateString()}</span></button>)}</div>}
    </form>
    );
}

export function MockInterview({ onClose }: { onClose: () => void }) {
    const [state, setState] = useState(initial);
    const [options, setOptions] = useState(DEFAULTS);
    const [history, setHistory] = useState<InterviewSession[]>([]);
    const [setup, setSetup] = useState(true);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const [micError, setMicError] = useState('');
    const [draft, setDraft] = useState('');
    const typingUntil = useRef(0);
    const stateRef = useRef(state);
    const scroller = useRef<HTMLDivElement>(null);
    const closeButton = useRef<HTMLButtonElement>(null);
    const active = state.session?.status === 'active';
    const questionCount = state.session?.turns.filter(t => t.speaker === 'interviewer').length || 0;

    useEffect(() => {
        let mounted = true;
        const accept = (next: InterviewState) => {
            if (!mounted) return;
            stateRef.current = next;
            setState(next);
            if (next.session?.status === 'active' || next.phase === 'reviewing') setSetup(false);
            if (Date.now() >= typingUntil.current || next.phase !== 'answering') setDraft(`${next.draft}${next.partial ? ` ${next.partial}` : ''}`.trim());
        };
        const unsubscribe = window.electronAPI.onMockInterviewChanged(accept);
        void window.electronAPI.getMockInterview().then(next => { if (mounted) { accept(next); setSetup(!next.session); } }).catch(() => { if (mounted) setError('Could not load interview practice.'); });
        void window.electronAPI.getMockInterviewHistory().then(items => { if (mounted) setHistory(items); }).catch(() => {});
        const unsubscribeStt = window.electronAPI.onSttStatusChanged(status => {
            if (status.channel !== 'user' || !stateRef.current.microphoneActive) return;
            if (status.state === 'failed') {
                setMicError(status.error || 'Microphone transcription stopped. You can type your answer or restart the interview.');
            } else if (status.state === 'connected') setMicError('');
        });
        closeButton.current?.focus();
        return () => { mounted = false; unsubscribe(); unsubscribeStt(); };
    }, []);

    useEffect(() => {
        scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: 'smooth' });
    }, [state.session?.turns.length, state.session?.feedback]);

    const run = async (action: () => Promise<InterviewResult>) => {
        setBusy(true);
        setError('');
        try {
            const result = await action();
            if (!result.success) setError(result.error || 'Interview request failed.');
            void window.electronAPI.getMockInterviewHistory().then(setHistory).catch(() => {});
        } catch { setError('Could not complete that action. Try again.'); }
        finally { setBusy(false); }
    };

    const close = async () => {
        try {
            const result = await window.electronAPI.stopMockInterview();
            if (!result.success) { setError(result.error || 'Could not stop the interview.'); return; }
            onClose();
        }
        catch { setError('Could not stop the interview. Try Stop again.'); }
    };

    const onDialogKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
        if (event.key === 'Escape') { event.stopPropagation(); void close(); }
        if (event.key === 'Tab') {
            const items = [...event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled)')];
            const first = items[0], last = items.at(-1);
            if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
            else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
        }
    };

    const updateDraft = (text: string) => {
        typingUntil.current = Date.now() + 350;
        setDraft(text);
        void window.electronAPI.setMockInterviewDraft(text).then(result => { if (!result.success) setError(result.error || 'Could not update your answer.'); }).catch(() => setError('Could not update your answer.'));
    };

    const updateAuto = (enabled: boolean, seconds: number) => {
        void run(() => window.electronAPI.setMockInterviewAuto(enabled, seconds));
    };

    return (
        <div className="fixed inset-0 z-[1500] flex items-center justify-center bg-black/60 p-5">
            <div role="dialog" aria-modal="true" aria-labelledby="mock-interview-title" onKeyDown={onDialogKeyDown} className="flex max-h-[92vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-border-subtle bg-bg-card text-text-primary shadow-2xl">
                <header className="flex items-center justify-between gap-4 border-b border-border-subtle px-6 py-4">
                    <div>
                        <h2 id="mock-interview-title" className="text-lg font-semibold">Mock interview</h2>
                        <p className="mt-1 text-xs text-text-secondary">Practice here, hear the questions, and review your answers.</p>
                    </div>
                    <button ref={closeButton} className={button} aria-label="Stop interview and close" title="Stop and save before closing" onClick={() => { void close(); }}><X size={16} /></button>
                </header>
                <div ref={scroller} className="min-h-0 flex-1 space-y-5 overflow-y-auto p-6">
                    {(error || state.error || micError || state.speechError) && <div role="alert" className="rounded-lg border border-amber-500/25 bg-amber-500/10 p-3 text-sm text-text-primary">{error || state.error || micError || state.speechError}</div>}
                    {setup ? (
                        <InterviewSetup options={options} setOptions={setOptions} history={history} busy={busy}
                            onStart={() => { setSetup(false); setMicError(''); void run(() => window.electronAPI.startMockInterview(options)); }}
                            onLoad={id => { setSetup(false); void run(() => window.electronAPI.loadMockInterview(id)); }} />
                    ) : (
                        <>
                            <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
                                <span>{state.session?.options.role} · Question {questionCount} of {state.session?.options.questions || options.questions}</span>
                                {state.microphoneActive && <span className="flex items-center gap-2 text-xs text-text-secondary"><Mic size={13} /><span className="h-1.5 w-20 overflow-hidden rounded-full bg-bg-subtle"><span className="block h-full origin-left bg-emerald-400" style={{ transform: `scaleX(${state.level})` }} /></span>Microphone</span>}
                            </div>
                            {state.session?.turns.map((turn, index) => <article key={`${state.session!.id}-${index}`} className={`rounded-xl border border-border-subtle p-4 ${turn.speaker === 'interviewer' ? 'bg-bg-elevated' : 'bg-bg-primary'}`}><h3 className="mb-2 text-xs font-semibold text-text-secondary">{turn.speaker === 'interviewer' ? 'Interviewer' : 'You'}</h3><p className="whitespace-pre-wrap text-sm leading-relaxed">{turn.text}</p></article>)}
                            {['generating', 'speaking', 'reviewing'].includes(state.phase) && <p role="status" className="flex items-center gap-2 text-sm text-text-secondary"><Loader2 size={15} className="animate-spin" />{state.phase === 'speaking' ? 'Interviewer is speaking…' : state.phase === 'reviewing' ? 'Reviewing your answers…' : 'Preparing the next question…'}{state.phase === 'speaking' && <button className={button} onClick={() => { void run(() => window.electronAPI.stopMockInterviewSpeech()); }}>Stop voice</button>}</p>}
                            {active && state.phase === 'answering' && <div className="space-y-3">
                                {state.session?.turns.at(-1)?.speaker === 'candidate' ? <p className="text-sm text-text-secondary">Your answer is saved. Click Next to retry the next question.</p> : <label className="block space-y-2 text-sm">Your answer<textarea className={`${field} min-h-28 resize-y`} value={draft} maxLength={10000} placeholder={state.microphoneActive ? 'Speak naturally. Your answer appears here; you can edit it.' : 'Type your answer here.'} onChange={event => updateDraft(event.target.value)} /></label>}
                                <div className="flex flex-wrap items-center gap-3">
                                    <button className={button} disabled={busy || (!draft.trim() && state.session?.turns.at(-1)?.speaker !== 'candidate')} onClick={() => { void run(() => window.electronAPI.nextMockInterview()); }}>Next <ArrowRight size={14} /></button>
                                    <button className={button} disabled={busy} onClick={() => { void run(() => window.electronAPI.replayMockInterview()); }}><Volume2 size={14} />Replay</button>
                                    {state.microphoneActive && <div className="flex items-center gap-2 text-xs text-text-secondary"><label className="flex items-center gap-2"><input type="checkbox" checked={state.session!.options.autoAdvance} onChange={event => updateAuto(event.target.checked, state.session!.options.pauseSeconds)} />Auto-next</label><select className="rounded border border-border-subtle bg-bg-primary p-1" aria-label="Pause before next question" value={state.session!.options.pauseSeconds} onChange={event => updateAuto(state.session!.options.autoAdvance, Number(event.target.value))}>{[3, 5, 7, 10].map(seconds => <option key={seconds} value={seconds}>{seconds}s pause</option>)}</select></div>}
                                </div>
                                {state.countdown !== null && <p role="status" className="text-xs text-text-secondary">{state.countdown > 0 ? `Next question in ${state.countdown}s — keep speaking to continue your answer.` : 'Waiting for the final words of your answer…'}</p>}
                            </div>}
                            {state.session?.feedback && <article className="rounded-xl border border-accent-primary/30 bg-accent-primary/5 p-4"><h3 className="mb-3 font-semibold">Your feedback</h3><div className="space-y-3 text-sm leading-relaxed"><ReactMarkdown components={feedbackComponents}>{state.session.feedback}</ReactMarkdown></div></article>}
                            {state.phase === 'completed' && <p className="text-xs text-text-secondary">Transcript saved on this device. Feedback uses your words and speaking preferences; it does not change My Context.</p>}
                        </>
                    )}
                </div>
                {!setup && <footer className="flex flex-wrap items-center gap-2 border-t border-border-subtle px-6 py-4">
                    {active ? <>
                        <button className={button} disabled={state.phase === 'reviewing'} onClick={() => { void run(() => window.electronAPI.finishMockInterview()); }}>Finish & review</button>
                        <button className={button} onClick={() => { void run(() => window.electronAPI.stopMockInterview()); }}><Square size={13} />Stop</button>
                        {state.microphoneActive && <button className={button} onClick={() => { void window.electronAPI.setWindowMode('overlay', true).catch(() => setError('Could not open the live assistant.')); }}>Open live assistant</button>}
                    </> : <>
                        <button className={button} disabled={busy || state.phase === 'reviewing'} onClick={() => { setSetup(true); setError(''); }}>New interview</button>
                        {state.session && !state.session.feedback && <button className={button} disabled={busy || state.phase === 'reviewing'} onClick={() => { void run(() => window.electronAPI.finishMockInterview()); }}>Get feedback</button>}
                    </>}
                    {state.session && <button className={`${button} ml-auto`} onClick={() => { void window.electronAPI.exportMockInterview().then(result => { if (!result.success && !result.canceled) setError(result.error || 'Export failed.'); }).catch(() => setError('Export failed.')); }}><Download size={14} />Export transcript</button>}
                </footer>}
            </div>
        </div>
    );
}

// The interviewer continues in main while the assistant overlay is visible.
export function ReturnToMockInterview() {
    const [active, setActive] = useState(false);
    useEffect(() => {
        let mounted = true;
        const accept = (state: InterviewState) => { if (mounted) setActive(state.session?.status === 'active' || state.phase === 'reviewing'); };
        const off = window.electronAPI.onMockInterviewChanged(accept);
        void window.electronAPI.getMockInterview().then(accept).catch(() => {});
        return () => { mounted = false; off(); };
    }, []);
    if (!active) return null;
    return <button className="rounded-full border border-border-subtle bg-bg-elevated px-3 py-1 text-xs text-text-primary" onClick={() => { void window.electronAPI.setWindowMode('launcher', true).catch(() => {}); }}>Back to interview</button>;
}
