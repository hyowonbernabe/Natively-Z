import React, { useEffect, useId, useRef, useState } from 'react';
import { AlignLeft } from 'lucide-react';
import type { AnswerLength } from '../../../electron/llm/answerLength';
import { SettingsRow, SettingsSectionHeading } from './SettingsRow';

const options: { value: AnswerLength; label: string; description: string }[] = [
    { value: 'auto', label: 'Auto', description: 'Use your current style and the question to decide the length.' },
    { value: 'brief', label: 'Brief', description: 'About 50-90 words. The answer and essential context.' },
    { value: 'balanced', label: 'Balanced', description: 'About 100-170 words. Context and useful supporting detail.' },
    { value: 'detailed', label: 'Detailed', description: 'About 180-280 words. A fuller explanation with relevant examples.' },
];

export function AnswerLengthControl({ compact = false, dark = false }: { compact?: boolean; dark?: boolean }) {
    const controlId = useId();
    const [length, setLength] = useState<AnswerLength | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const revision = useRef(0);
    useEffect(() => {
        let active = true;
        const seen = revision.current;
        const unsubscribe = window.electronAPI.onAnswerLengthChanged(value => {
            revision.current++; if (active) { setLength(value); setError(''); }
        });
        void window.electronAPI.getAnswerLength().then(value => {
            if (active && revision.current === seen) setLength(value);
        }).catch(() => { if (active) setError('Could not load answer length.'); });
        return () => { active = false; unsubscribe(); };
    }, []);
    const change = async (value: AnswerLength) => {
        setBusy(true); setError('');
        const seen = revision.current;
        try {
            const result = await window.electronAPI.setAnswerLength(value);
            // Broadcasts are authoritative if another window changed it during this save.
            if (revision.current === seen) setLength(result);
        }
        catch { setError('Could not save. Try again.'); }
        finally { setBusy(false); }
    };
    const select = <select id={controlId} aria-label="Answer length" value={length || 'auto'} disabled={length === null || busy}
        onChange={event => { void change(event.target.value as AnswerLength); }}
        className={compact
            ? `w-full rounded-md border px-2 py-1.5 text-[11px] disabled:opacity-50 ${dark ? 'border-white/15 bg-zinc-900 text-white' : 'border-black/15 bg-white text-slate-900'}`
            : 'rounded-lg border border-border-subtle bg-bg-primary px-3 py-2 text-sm text-text-primary disabled:opacity-50'}>
        {options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
    </select>;
    const description = options.find(option => option.value === length)?.description;
    if (compact) return <div className={`mx-2 my-2 border-t pt-2 ${dark ? 'border-white/10 text-white/80' : 'border-black/10 text-slate-700'}`}>
        <div id={controlId} className="mb-1.5 text-[11px] font-medium">Answer length</div>
        <div role="group" aria-labelledby={controlId} className="grid grid-cols-2 gap-1">
            {options.map(option => <button key={option.value} type="button" aria-pressed={length === option.value}
                disabled={length === null || busy} onClick={() => { void change(option.value); }}
                className={`rounded-md border px-1 py-1.5 text-[11px] transition-colors disabled:opacity-50 ${length === option.value
                    ? dark ? 'border-white/30 bg-white/15 text-white' : 'border-slate-900/30 bg-slate-900 text-white'
                    : dark ? 'border-white/10 bg-white/5 text-white/75 hover:bg-white/10' : 'border-black/10 bg-black/5 text-slate-700 hover:bg-black/10'}`}>
                {option.label}
            </button>)}
        </div>
        <p className="mt-1 text-[10px] leading-relaxed" role={error ? 'alert' : undefined}>{error || 'Applies to new answers.'}</p>
    </div>;
    return <section className="mt-6 border-t border-border-subtle pt-6">
        <SettingsSectionHeading title="Answer length" subtitle="Control how brief or detailed the main AI answer should be." />
        <SettingsRow icon={<AlignLeft size={20} />} title="Default answer length" description={description} control={select} />
        <p className="mt-2 text-xs leading-relaxed text-text-secondary">Saves immediately and also appears in the meeting quick settings. Applies to new answers. Explicit length requests in a question take precedence; wording still follows Output Style.</p>
        {error && <p role="alert" className="mt-2 text-xs text-red-400">{error}</p>}
    </section>;
}
