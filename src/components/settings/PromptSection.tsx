// Personal build (Natively Z): Settings → Intelligence → Prompt.
// Everything the AI is told lives here (plus My Context, Output Style and Answer Length above).
// The main process sends exactly these parts: electron/llm/transparentPrompt.ts.
import { Mic, RotateCcw, Save, ScrollText, Users } from 'lucide-react';
import React, { useEffect, useState } from 'react';
import type { LastPrompt, PromptAction, PromptSettings, PromptSettingsPayload } from '../../../electron/llm/transparentPrompt';
import { SETTINGS_BTN, SettingsRow, SettingsSectionHeading, SettingsSwitch } from './SettingsRow';

const BOX = 'w-full resize-y rounded-xl border border-border-subtle bg-bg-primary px-3 py-3 text-sm leading-relaxed text-text-primary focus:outline-none focus:ring-2 focus:ring-accent-primary disabled:opacity-50';

export function PromptSection() {
    const [data, setData] = useState<PromptSettingsPayload | null>(null);
    const [draft, setDraft] = useState<PromptSettings | null>(null);
    const [busy, setBusy] = useState(false);
    const [message, setMessage] = useState('');
    const [last, setLast] = useState<LastPrompt[] | null>(null);
    const [shown, setShown] = useState(0);

    const load = (p: PromptSettingsPayload) => { setData(p); setDraft(p.settings); };
    useEffect(() => {
        void window.electronAPI.getPromptSettings().then(load).catch(() => setMessage('Could not load prompt settings.'));
    }, []);

    const dirty = Boolean(data && draft && JSON.stringify(data.settings) !== JSON.stringify(draft));
    const run = async (fn: () => Promise<PromptSettingsPayload>, done: string) => {
        setBusy(true); setMessage('');
        try { load(await fn()); setMessage(done); } catch { setMessage('Could not save. Your edits are still here; try again.'); }
        finally { setBusy(false); }
    };
    const save = (next: PromptSettings) => run(() => window.electronAPI.setPromptSettings(next), 'Saved. Applies to the next answer.');
    const showLast = async () => {
        try { setLast(await window.electronAPI.getLastPrompts()); setShown(0); } catch { setMessage('Could not load the last prompt.'); }
    };

    if (!data || !draft) return <section><SettingsSectionHeading title="Prompt" /><p className="text-sm text-text-secondary">{message || 'Loading…'}</p></section>;
    const actions = Object.keys(data.labels) as PromptAction[];
    const current = last?.[shown];

    return (
        <section className="mt-6 border-t border-border-subtle pt-6">
            <SettingsSectionHeading title="Prompt" subtitle="Everything the AI is told. Each request is built from: these base instructions, My Context, Output Style, Answer Length, story priorities, your response language, the whole conversation so far, any screen text, screenshot or skill you used, and the instruction for the button you pressed, with short headings between them. Nothing else is added. Use “Show the last prompt sent” to see the exact text." />
            <SettingsRow icon={<Mic size={20} />} title="Include my microphone in the prompt"
                description="Adds what you said to the conversation the AI reads. Saves right away."
                control={<SettingsSwitch checked={draft.includeMic} disabled={busy} label="Include my microphone in the prompt"
                    onChange={() => {
                        // Saves only the switch; unsaved text edits stay in the boxes.
                        const includeMic = !draft.includeMic;
                        setBusy(true); setMessage('');
                        window.electronAPI.setPromptSettings({ ...data.settings, includeMic })
                            .then(p => { setData(p); setDraft(d => d && { ...d, includeMic: p.settings.includeMic }); setMessage('Saved.'); })
                            .catch(() => setMessage('Could not save. Try again.'))
                            .finally(() => setBusy(false));
                    }} />}
            />
            <SettingsRow icon={<Users size={20} />} title="Call the other people"
                description="How the people on the call are labelled in the transcript the AI reads: Interviewer for interviews, Them for normal calls. Saves right away."
                control={<select aria-label="Call the other people" value={draft.otherLabel} disabled={busy}
                    className="rounded-lg border border-border-subtle bg-bg-primary px-3 py-2 text-sm text-text-primary disabled:opacity-50"
                    onChange={e => {
                        const otherLabel = e.target.value as PromptSettings['otherLabel'];
                        setBusy(true); setMessage('');
                        window.electronAPI.setPromptSettings({ ...data.settings, otherLabel })
                            .then(p => { setData(p); setDraft(d => d && { ...d, otherLabel: p.settings.otherLabel }); setMessage('Saved.'); })
                            .catch(() => setMessage('Could not save. Try again.'))
                            .finally(() => setBusy(false));
                    }}>
                    <option value="Interviewer">Interviewer</option>
                    <option value="Them">Them</option>
                </select>}
            />
            <div className="mt-3 space-y-3">
                <label htmlFor="prompt-base" className="block text-sm font-medium text-text-primary">Base instructions (sent with every request)</label>
                <textarea id="prompt-base" rows={9} value={draft.base} disabled={busy} className={BOX}
                    onChange={e => { setDraft({ ...draft, base: e.target.value }); setMessage(''); }} />
                <details className="rounded-xl border border-border-subtle px-3 py-2">
                    <summary className="cursor-pointer text-sm font-medium text-text-primary">Instruction for each button</summary>
                    <div className="mt-3 space-y-3">
                        {actions.map(a => (
                            <div key={a}>
                                <label htmlFor={`prompt-action-${a}`} className="block text-xs font-medium text-text-secondary">{data.labels[a]}</label>
                                <textarea id={`prompt-action-${a}`} rows={2} value={draft.actions[a]} disabled={busy} className={BOX}
                                    onChange={e => { setDraft({ ...draft, actions: { ...draft.actions, [a]: e.target.value } }); setMessage(''); }} />
                            </div>
                        ))}
                    </div>
                </details>
                <div className="flex flex-wrap items-center gap-2">
                    <button type="button" className={SETTINGS_BTN} disabled={busy || !dirty} onClick={() => { void save(draft); }}><Save size={14} />{busy ? 'Saving…' : 'Save prompt'}</button>
                    <button type="button" className={SETTINGS_BTN} disabled={busy} onClick={() => { void run(() => window.electronAPI.resetPromptSettings(), 'Reset to default.'); }}><RotateCcw size={14} />Reset to default</button>
                    <button type="button" className={SETTINGS_BTN} onClick={() => { void showLast(); }}><ScrollText size={14} />Show the last prompt sent</button>
                    <span role="status" aria-live="polite" className="text-xs text-text-secondary">{message || (dirty ? 'Unsaved changes' : '')}</span>
                </div>
                {last && (last.length === 0
                    ? <p className="text-sm text-text-secondary">Nothing sent yet since the app started.</p>
                    : <div className="space-y-2">
                        <select aria-label="Which prompt" value={shown} onChange={e => setShown(Number(e.target.value))}
                            className="rounded-lg border border-border-subtle bg-bg-primary px-2 py-2 text-sm text-text-primary">
                            {last.map((p, i) => <option key={p.action} value={i}>{p.label}, {new Date(p.at).toLocaleTimeString()}</option>)}
                        </select>
                        {current && <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-xl border border-border-subtle bg-bg-primary p-3 text-xs text-text-primary">
                            {`SYSTEM\n${current.system}\n\nUSER\n${current.user}`}
                        </pre>}
                    </div>)}
            </div>
        </section>
    );
}
