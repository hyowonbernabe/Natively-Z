// Personal build (Natively Z): ElevenLabs Scribe v2 Realtime options. Main process: electron/audio/scribeOptions.ts.
import React, { useEffect, useState } from 'react';
import type { ScribeSettings } from '../../../electron/audio/scribeOptions';
import { SETTINGS_BTN, SettingsSwitch } from './SettingsRow';

type Payload = { settings: ScribeSettings; terms: string[] };

export function ScribeOptionsSection() {
    const [data, setData] = useState<Payload | null>(null);
    const [terms, setTerms] = useState('');
    const [message, setMessage] = useState('');
    const load = (p: Payload) => { setData(p); setTerms(p.settings.customTerms); };
    useEffect(() => { void window.electronAPI.getScribeOptions().then(load).catch(() => setMessage('Could not load Scribe options.')); }, []);
    if (!data) return null;
    // A switch saves only itself: unsaved words in the box stay put.
    const save = (next: ScribeSettings, words = false) => window.electronAPI.setScribeOptions(next)
        .then(p => { if (words) load(p); else setData(p); setMessage('Saved. Applies from the next meeting.'); })
        .catch(() => setMessage('Could not save. Try again.'));
    const s = data.settings;
    const row = (title: string, description: string, on: boolean, key: keyof ScribeSettings) => (
        <div className="flex items-start justify-between gap-4">
            <div><div className="text-sm font-medium text-text-primary">{title}</div><p className="text-xs text-text-secondary">{description}</p></div>
            <SettingsSwitch checked={on} label={title} onChange={() => { void save({ ...s, [key]: !on }); }} />
        </div>
    );
    return (
        <div className="bg-bg-card rounded-xl border border-border-subtle p-4 space-y-4">
            <div className="text-xs font-medium text-text-secondary">ElevenLabs Scribe options</div>
            {row('Clean transcript', 'Leaves out stutters and false starts ("nung na-- nung").', s.clean, 'clean')}
            {row('Turn prediction', 'Ends a sentence when the speaker seems finished, not after a fixed pause. Falls back automatically if Scribe refuses it.', s.turnPrediction, 'turnPrediction')}
            {row('Word list', 'Helps Scribe spell your names and projects right (up to 50 words, 20 characters each). Adds about $0.08 per hour for each audio channel (your mic and the call), so about $0.16 per hour.', s.keyterms, 'keyterms')}
            {s.keyterms && <div className="space-y-2">
                <label htmlFor="scribe-terms" className="block text-xs text-text-secondary">Your words, one per line. Leave empty to use these from My Context:</label>
                <p className="text-xs text-text-tertiary break-words">{data.terms.join(', ') || '(none found)'}</p>
                <textarea id="scribe-terms" rows={4} value={terms} onChange={e => { setTerms(e.target.value); setMessage(''); }}
                    className="w-full resize-y rounded-xl border border-border-subtle bg-bg-primary px-3 py-2 text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-accent-primary" />
                <button type="button" className={SETTINGS_BTN} disabled={terms === s.customTerms} onClick={() => { void save({ ...s, customTerms: terms }, true); }}>Save words</button>
            </div>}
            <p role="status" aria-live="polite" className="min-h-4 text-xs text-text-secondary">{message}</p>
        </div>
    );
}
