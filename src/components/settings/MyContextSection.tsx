// Personal build (Natively Z): Settings â†’ Intelligence â†’ My Context.
// The file itself lives in the main process (electron/llm/myContext.ts); this is only the switch and the
// buttons that open it.
import { FileText, FolderOpen, UserRound } from 'lucide-react';
import React, { useEffect, useState } from 'react';
import { SETTINGS_BTN, SettingsRow, SettingsSectionHeading, SettingsSwitch } from './SettingsRow';
import type { StoryPriorities, StoryPriority } from '../../../electron/llm/myContext';
import { OutputStyleSection } from './OutputStyleSection';

type Status = { path: string | null; enabled: boolean; exists: boolean; chars: number };

export const MyContextSection: React.FC = () => {
  const [s, setS] = useState<Status | null>(null);
  const [stories, setStories] = useState<string[]>([]);
  const [priorities, setPriorities] = useState<StoryPriorities>({});
  const [saved, setSaved] = useState<StoryPriorities>({});
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const dirty = JSON.stringify(priorities) !== JSON.stringify(saved);
  useEffect(() => {
    let active = true;
    void window.electronAPI.getStoryPriorities().then(result => {
      if (active) { setStories(result.stories); setPriorities(result.priorities); setSaved(result.priorities); }
    }).catch(() => { if (active) setMessage('Could not load story priorities.'); });
    return () => { active = false; };
  }, [s?.chars, s?.enabled]);
  const savePriorities = async () => {
    setSaving(true); setMessage('');
    try {
      const result = await window.electronAPI.setStoryPriorities(priorities);
      setSaved(result.priorities); setPriorities(result.priorities); setStories(result.stories); setMessage('Saved.');
    } catch { setMessage('Could not save story priorities. Please try again.'); }
    finally { setSaving(false); }
  };
  const refresh = () => { void window.electronAPI.getMyContext?.().then(setS).catch(() => {}); };

  // Re-read when the window regains focus, so the size updates after editing the file.
  useEffect(() => {
    refresh();
    window.addEventListener('focus', refresh);
    return () => window.removeEventListener('focus', refresh);
  }, []);

  const toggle = () => {
    if (!s) return;
    setS({ ...s, enabled: !s.enabled });
    void window.electronAPI.setMyContextEnabled?.(!s.enabled).then(setS).catch(refresh);
  };

  const state = !s ? '' : !s.exists ? 'No file yet. Click "Edit file" to create one from a template.'
    : s.chars === 0 ? 'File is empty, so answers behave as normal.'
    : `${s.chars.toLocaleString()} characters loaded.`;

  return (
    <>
    <section>
      <SettingsSectionHeading
        title="My Context"
        subtitle="Your personal information, background, experiences and real examples."
      />
      <SettingsRow
        icon={<UserRound size={20} />}
        title="Use My Context"
        description={state}
        control={<SettingsSwitch checked={Boolean(s?.enabled)} disabled={!s} onChange={toggle} label="Use My Context" />}
      />
      <SettingsRow
        icon={<FileText size={20} />}
        title="Context file"
        description={<span className="break-all">{s?.path ?? 'Loading file locationâ€¦'}</span>}
      >
          <div className="flex flex-wrap gap-2 pb-3">
            <button type="button" className={SETTINGS_BTN} onClick={() => { void window.electronAPI.openMyContext?.().then(refresh).catch(() => {}); }}>
              <FileText size={14} /> Edit file
            </button>
            <button type="button" className={SETTINGS_BTN} onClick={() => { void window.electronAPI.showMyContext?.(); }}>
              <FolderOpen size={14} /> Show in folder
            </button>
          </div>
      </SettingsRow>
    </section>
    <section>
      <SettingsSectionHeading title="Story priorities" subtitle="Choose the projects and experiences you want to showcase. Preferences are saved separately from your context file." />
      <p className="mb-3 text-xs leading-relaxed text-text-secondary">Preferred stories get more emphasis when they fit the question. Lower priority stories are used less often. A question about a specific project still takes precedence. Each row comes from a ?## Story:? heading in My Context.</p>
      {!s?.enabled && <p className="text-sm text-text-secondary">Enable My Context to use story priorities.</p>}
      {s?.enabled && !stories.length && <p className="text-sm text-text-secondary">Add ?## Story: Project or experience? sections to your context file to set their priorities.</p>}
      <div className="max-h-80 overflow-y-auto">
        {stories.map(title => <SettingsRow key={title} icon={<FileText size={18} />} title={title} control={
          <select aria-label={`Priority for ${title}`} className="rounded-lg border border-border-subtle bg-bg-primary px-2 py-2 text-sm text-text-primary" disabled={saving || !s?.enabled} value={priorities[title] || 'normal'} onChange={event => { setPriorities({ ...priorities, [title]: event.target.value as StoryPriority }); setMessage(''); }}>
            <option value="preferred">Preferred</option><option value="normal">Normal</option><option value="lower">Lower priority</option>
          </select>
        } />)}
      </div>
      <div className="mt-3 flex items-center gap-3"><button type="button" className={SETTINGS_BTN} disabled={!dirty || saving} onClick={() => { void savePriorities(); }}>{saving ? 'Saving?' : 'Save priorities'}</button><span className="text-xs text-text-secondary" role="status">{message || (dirty ? 'Unsaved changes' : '')}</span></div>
    </section>
    <OutputStyleSection />
    </>
  );
};
