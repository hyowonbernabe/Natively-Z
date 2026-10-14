// Personal build (Natively Z): Settings → AI Providers → Backup order.
// If the model answering fails (error, usage limit, silent too long), the answer moves down this list.
// Your picks first, in your order; then every other connected model, fastest first.
// Logic lives in electron/llm/backupChain.ts. Styling reuses the provider cards' primitives
// (aip-card, aip-well model rows, aip-btn pills, AipSwitch, AipBadge) so it reads as part of the page.
import { ChevronDown, ChevronUp, Plus, RotateCcw, X } from 'lucide-react';
import React, { useEffect, useState } from 'react';
import { AipBadge, AipSwitch } from './AIProvidersSettings';

type Opt = { id: string; name: string };
type Cfg = { enabled: boolean; pinned: string[]; cooling: Array<{ id: string; kind: string; until: number }> };

const KIND_LABEL: Record<string, string> = {
  quota: 'Usage limit', gone: 'Unavailable', auth: 'Sign-in problem', timeout: 'Too slow', error: 'Error',
};

export const BackupOrderCard: React.FC<{ allOptions: Opt[]; activeModelId?: string }> = ({ allOptions, activeModelId }) => {
  const [cfg, setCfg] = useState<Cfg | null>(null);

  // Re-read on focus too, so "skipped" badges stay current.
  useEffect(() => {
    const load = () => { void window.electronAPI.getBackupConfig?.().then(setCfg).catch(() => {}); };
    load();
    window.addEventListener('focus', load);
    return () => window.removeEventListener('focus', load);
  }, []);

  // Tell main which models are connected, so "everything else" can include them.
  const key = allOptions.map((o) => o.id).join(',');
  useEffect(() => {
    if (allOptions.length) void window.electronAPI.setBackupKnown?.(allOptions.map((o) => o.id)).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  if (!cfg) return null;
  const nameOf = (id: string) => allOptions.find((o) => o.id === id)?.name ?? id;
  // Edits work on the FULL saved list; models missing right now (Ollama off, key not loaded) are only
  // hidden on screen, never dropped from the saved order.
  const isShown = (id: string) => allOptions.some((o) => o.id === id);
  const pinned = cfg.pinned.filter(isShown);
  const rest = allOptions.filter((o) => !cfg.pinned.includes(o.id));
  const coolingOf = (id: string) => cfg.cooling.find((c) => c.id === id);

  const savePinned = (ids: string[]) => {
    setCfg({ ...cfg, pinned: ids });
    void window.electronAPI.setBackupPinned?.(ids).then(setCfg).catch(() => {});
  };
  // Swap with the nearest VISIBLE neighbour inside the full saved list.
  const move = (i: number, d: -1 | 1) => {
    const other = pinned[i + d];
    if (!other) return;
    const ids = [...cfg.pinned];
    const a = ids.indexOf(pinned[i]);
    const b = ids.indexOf(other);
    [ids[a], ids[b]] = [ids[b], ids[a]];
    savePinned(ids);
  };
  const retry = (id: string) => { void window.electronAPI.clearBackupCooling?.(id).then(setCfg).catch(() => {}); };

  const row = (id: string, actions: React.ReactNode, n?: number) => {
    const c = coolingOf(id);
    return (
      <div key={id} className="aip-model-row aip-row aip-backup-row">
        {n !== undefined && <span className="aip-meta tabular-nums shrink-0" style={{ width: 18, textAlign: 'right' }}>{n}</span>}
        <span className="aip-model-name truncate flex-1" title={id}>{nameOf(id)}</span>
        {id === activeModelId && <AipBadge tone="info" label="Active" />}
        {c && c.until > Date.now() && (
          <span title={`Skipped until ${new Date(c.until).toLocaleTimeString()}`}>
            <AipBadge tone="warn" label={`Skipped · ${KIND_LABEL[c.kind] ?? c.kind}`} />
          </span>
        )}
        <div className="aip-row-actions flex items-center gap-1 shrink-0">
          {c && c.until > Date.now() && (
            <button type="button" className="aip-btn" data-size="sm" onClick={() => retry(id)} aria-label={`Retry ${nameOf(id)}`} title="Try this model again now">
              <RotateCcw size={11} /> Retry
            </button>
          )}
          {actions}
        </div>
      </div>
    );
  };

  return (
    <section className="aip-card aip-feature-card" aria-label="Backup Order">
      <div className="aip-feature-head">
        <div className="aip-feature-copy">
          <h3 className="block text-xs font-medium uppercase tracking-wide mb-0 aip-hero">Backup Order</h3>
          <p className="aip-meta mt-1">
            Keep answers coming when the active model is unavailable or slow to respond.
          </p>
        </div>
        <AipSwitch
          checked={cfg.enabled}
          label="Backup order"
          onChange={(v) => { setCfg({ ...cfg, enabled: v }); void window.electronAPI.setBackupEnabled?.(v).then(setCfg).catch(() => {}); }}
        />
      </div>

      {cfg.enabled && (
        <>
          <div className="aip-feature-list">
            <div className="aip-feature-toolbar">
              <span className="aip-label">Your picks</span>
              <span className="aip-meta">Tried first, top to bottom, after the active model</span>
            </div>
            <div className="aip-well" style={{ padding: 4 }}>
              {pinned.length === 0
                ? <p className="aip-meta px-2 py-3 text-center">None yet. Add models from the list below.</p>
                : pinned.map((id, i) => row(id, (
                  <>
                    <button type="button" className="aip-btn" data-size="sm" disabled={i === 0} onClick={() => move(i, -1)} aria-label={`Move ${nameOf(id)} up`} title="Move up"><ChevronUp size={12} /></button>
                    <button type="button" className="aip-btn" data-size="sm" disabled={i === pinned.length - 1} onClick={() => move(i, 1)} aria-label={`Move ${nameOf(id)} down`} title="Move down"><ChevronDown size={12} /></button>
                    <button type="button" className="aip-btn" data-size="sm" onClick={() => savePinned(cfg.pinned.filter((x) => x !== id))} aria-label={`Remove ${nameOf(id)} from backups`} title="Remove from picks"><X size={12} /></button>
                  </>
                ), i + 1))}
            </div>
          </div>

          <div className="aip-feature-list">
            <div className="aip-feature-toolbar">
              <span className="aip-label">Everything else</span>
              <span className="aip-meta">Tried automatically, fastest first</span>
            </div>
            <div className="aip-well aip-scroll-y custom-scrollbar aip-models-well">
              {rest.length === 0
                ? <p className="aip-meta px-2 py-3 text-center">Every connected model is in your picks.</p>
                : rest.map((o) => row(o.id, (
                  <button type="button" className="aip-btn" data-size="sm" onClick={() => savePinned([...cfg.pinned, o.id])} aria-label={`Add ${nameOf(o.id)} to backups`} title="Add to your picks">
                    <Plus size={11} /> Add
                  </button>
                )))}
            </div>
            <p className="aip-meta">Use the Filler Model speed test to measure these models and improve the automatic order.</p>
          </div>
        </>
      )}
    </section>
  );
};
