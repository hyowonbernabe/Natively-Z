// Personal build (Natively Z): Settings → Intelligence → My Context.
// The file itself lives in the main process (electron/llm/myContext.ts); this is only the switch and the
// buttons that open it.
import { FileText, FolderOpen, UserRound } from 'lucide-react';
import React, { useEffect, useState } from 'react';
import { SETTINGS_BTN, SettingsRow, SettingsSectionHeading, SettingsSwitch } from './SettingsRow';
import { OutputStyleSection } from './OutputStyleSection';

type Status = { path: string | null; enabled: boolean; exists: boolean; chars: number };

export const MyContextSection: React.FC = () => {
  const [s, setS] = useState<Status | null>(null);
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
        description={<span className="break-all">{s?.path ?? 'Loading file location…'}</span>}
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
    <OutputStyleSection />
    </>
  );
};
