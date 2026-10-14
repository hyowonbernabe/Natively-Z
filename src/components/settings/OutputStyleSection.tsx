import { AnswerLengthControl } from './AnswerLengthControl';
import React, { useEffect, useState } from 'react';
import { MessageSquare, Save } from 'lucide-react';
import type { OutputStyleConfig } from '../../../electron/llm/myContext';
import { SETTINGS_BTN, SettingsRow, SettingsSectionHeading, SettingsSwitch } from './SettingsRow';

const MAX_CHARS = 10000;
const EXAMPLE = 'Use everyday words and short sentences. Sound like I’m speaking in a normal conversation. Avoid jargon; explain necessary technical terms briefly. Be direct and casual-professional. Keep my facts accurate.';

export function OutputStyleSection() {
    const [saved, setSaved] = useState<OutputStyleConfig | null>(null);
    const [text, setText] = useState('');
    const [busy, setBusy] = useState(false);
    const [message, setMessage] = useState('');
    const [error, setError] = useState('');

    useEffect(() => {
        let mounted = true;
        void window.electronAPI.getOutputStyle().then(config => {
            if (mounted) { setSaved(config); setText(config.text); }
        }).catch(() => { if (mounted) setError('Could not load Output Style. Reopen settings to try again.'); });
        return () => { mounted = false; };
    }, []);

    const persist = async (config: OutputStyleConfig, updateText: boolean) => {
        setBusy(true);
        setMessage('');
        setError('');
        try {
            const result = await window.electronAPI.setOutputStyle(config);
            setSaved(result);
            if (updateText) setText(result.text);
            setMessage('Saved. Applies to new answers.');
        } catch { setError('Could not save Output Style. Your edits are still here; try again.'); }
        finally { setBusy(false); }
    };

    return (
        <>
        <AnswerLengthControl />
        <section className="mt-6 border-t border-border-subtle pt-6">
            <SettingsSectionHeading title="Output Style" subtitle="Set how your answers sound, separately from your personal information." />
            <SettingsRow icon={<MessageSquare size={20} />} title="Use Output Style"
                description="Applies to answer wording even when My Context is off."
                control={<SettingsSwitch checked={saved?.enabled ?? false} disabled={!saved || busy} label="Use Output Style" onChange={() => { if (saved) void persist({ ...saved, enabled: !saved.enabled }, false); }} />}
            />
            <div className="mt-3 space-y-3">
                <label htmlFor="output-style-instructions" className="block text-sm font-medium text-text-primary">Speaking instructions</label>
                <textarea id="output-style-instructions" rows={7} maxLength={MAX_CHARS} value={text} disabled={!saved || busy}
                    placeholder={EXAMPLE}
                    onChange={event => { setText(event.target.value); setMessage(''); }}
                    className="w-full resize-y rounded-xl border border-border-subtle bg-bg-primary px-3 py-3 text-sm leading-relaxed text-text-primary placeholder:text-text-tertiary focus:outline-none focus:ring-2 focus:ring-accent-primary disabled:opacity-50"
                />
                <p className="text-xs leading-relaxed text-text-secondary">Describe your vocabulary, tone, sentence length, and how much detail you want. You can include example answers. Clear this field and save to remove the custom style.</p>
                <div className="flex flex-wrap items-center justify-between gap-3">
                    <span className="text-xs text-text-secondary">{text.length.toLocaleString()} / {MAX_CHARS.toLocaleString()} characters</span>
                    <button type="button" className={SETTINGS_BTN} disabled={!saved || busy || saved.text === text} onClick={() => { if (saved) void persist({ text, enabled: saved.enabled }, true); }}><Save size={14} />{busy ? 'Saving…' : 'Save style'}</button>
                </div>
                <p role={error ? 'alert' : 'status'} aria-live="polite" className={`min-h-4 text-xs ${error ? 'text-red-400' : 'text-text-secondary'}`}>{error || message || (saved && saved.text !== text ? 'Unsaved changes' : '')}</p>
            </div>
        </section>
        </>
    );
}
