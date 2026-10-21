import React, { useEffect, useId, useRef, useState } from 'react';
import { AlignLeft, MessageCircle } from 'lucide-react';
import type { AnswerLength } from '../../../electron/llm/answerLength';
import type { FillerWords } from '../../../electron/llm/fillerWords';
import { SettingsRow, SettingsSectionHeading } from './SettingsRow';

type Option<T> = { value: T; label: string; description: string };

const lengthOptions: Option<AnswerLength>[] = [
    { value: 'auto', label: 'Auto', description: 'Use your current style and the question to decide the length.' },
    { value: 'brief', label: 'Brief', description: 'About 50-90 words. The answer and essential context.' },
    { value: 'balanced', label: 'Balanced', description: 'About 100-170 words. Context and useful supporting detail.' },
    { value: 'detailed', label: 'Detailed', description: 'About 180-280 words. A fuller explanation with relevant examples.' },
];

// Personal build (Natively Z): the one place that sets how many spoken filler words answers use.
const fillerOptions: Option<FillerWords>[] = [
    { value: 'auto', label: 'Auto', description: 'Adds nothing; your Output Style decides.' },
    { value: 'clean', label: 'Clean', description: 'No filler words. Polished, but still conversational.' },
    { value: 'light', label: 'Light', description: 'A few natural ones, like "so", "honestly", "I mean".' },
    { value: 'natural', label: 'Natural', description: 'Regular "um", "uh", "yeah", "like", "you know".' },
    { value: 'heavy', label: 'Heavy', description: 'Lots, chained together: "and uh... yeah...", "so, um, like...".' },
];

interface ChoiceApi<T> { get: () => Promise<T>; set: (value: T) => Promise<T>; onChanged: (cb: (value: T) => void) => () => void }

function QuickChoice<T extends string>({ title, options, api, compact, dark, icon, heading, rowTitle, footnote }: {
    title: string; options: Option<T>[]; api: ChoiceApi<T>; compact: boolean; dark: boolean;
    icon: React.ReactNode; heading: { title: string; subtitle: string }; rowTitle: string; footnote: string;
}) {
    const controlId = useId();
    const [value, setValue] = useState<T | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const revision = useRef(0);
    useEffect(() => {
        let active = true;
        const seen = revision.current;
        const unsubscribe = api.onChanged(next => {
            revision.current++; if (active) { setValue(next); setError(''); }
        });
        void api.get().then(next => {
            if (active && revision.current === seen) setValue(next);
        }).catch(() => { if (active) setError(`Could not load ${title.toLowerCase()}.`); });
        return () => { active = false; unsubscribe(); };
    }, []);
    const change = async (next: T) => {
        setBusy(true); setError('');
        const seen = revision.current;
        try {
            const result = await api.set(next);
            // Broadcasts are authoritative if another window changed it during this save.
            if (revision.current === seen) setValue(result);
        }
        catch { setError('Could not save. Try again.'); }
        finally { setBusy(false); }
    };
    const select = <select id={controlId} aria-label={title} value={value || options[0].value} disabled={value === null || busy}
        onChange={event => { void change(event.target.value as T); }}
        className="rounded-lg border border-border-subtle bg-bg-primary px-3 py-2 text-sm text-text-primary disabled:opacity-50">
        {options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
    </select>;
    const description = options.find(option => option.value === value)?.description;
    if (compact) return <div className={`mx-2 my-2 border-t pt-2 ${dark ? 'border-white/10 text-white/80' : 'border-black/10 text-slate-700'}`}>
        <div id={controlId} className="mb-1.5 text-[11px] font-medium">{title}</div>
        <div role="group" aria-labelledby={controlId} className="grid grid-cols-2 gap-1">
            {options.map(option => <button key={option.value} type="button" aria-pressed={value === option.value}
                disabled={value === null || busy} onClick={() => { void change(option.value); }}
                className={`rounded-md border px-1 py-1.5 text-[11px] transition-colors disabled:opacity-50 ${value === option.value
                    ? dark ? 'border-white/30 bg-white/15 text-white' : 'border-slate-900/30 bg-slate-900 text-white'
                    : dark ? 'border-white/10 bg-white/5 text-white/75 hover:bg-white/10' : 'border-black/10 bg-black/5 text-slate-700 hover:bg-black/10'}`}>
                {option.label}
            </button>)}
        </div>
        <p className="mt-1 text-[10px] leading-relaxed" role={error ? 'alert' : undefined}>{error || 'Applies to new answers.'}</p>
    </div>;
    return <section className="mt-6 border-t border-border-subtle pt-6">
        <SettingsSectionHeading title={heading.title} subtitle={heading.subtitle} />
        <SettingsRow icon={icon} title={rowTitle} description={description} control={select} />
        <p className="mt-2 text-xs leading-relaxed text-text-secondary">{footnote}</p>
        {error && <p role="alert" className="mt-2 text-xs text-red-400">{error}</p>}
    </section>;
}

export function AnswerLengthControl({ compact = false, dark = false }: { compact?: boolean; dark?: boolean }) {
    return <QuickChoice title="Answer length" options={lengthOptions} compact={compact} dark={dark} icon={<AlignLeft size={20} />}
        api={{ get: () => window.electronAPI.getAnswerLength(), set: v => window.electronAPI.setAnswerLength(v), onChanged: cb => window.electronAPI.onAnswerLengthChanged(cb) }}
        heading={{ title: 'Answer length', subtitle: 'Control how brief or detailed the main AI answer should be.' }}
        rowTitle="Default answer length"
        footnote="Saves immediately and also appears in the meeting quick settings. Applies to new answers. Explicit length requests in a question take precedence; wording still follows Output Style." />;
}

export function FillerWordsControl({ compact = false, dark = false }: { compact?: boolean; dark?: boolean }) {
    return <QuickChoice title="Filler words" options={fillerOptions} compact={compact} dark={dark} icon={<MessageCircle size={20} />}
        api={{ get: () => window.electronAPI.getFillerWords(), set: v => window.electronAPI.setFillerWords(v), onChanged: cb => window.electronAPI.onFillerWordsChanged(cb) }}
        heading={{ title: 'Filler words', subtitle: 'How many spoken filler words like "um" or "yeah" answers use.' }}
        rowTitle="Filler words"
        footnote="The only place that sets this; keep filler wording out of Output Style. Saves immediately and also appears in the meeting quick settings." />;
}
