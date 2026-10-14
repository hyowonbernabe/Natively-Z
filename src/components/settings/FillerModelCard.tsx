// Personal build (Natively Z): Settings → AI Providers → Filler model.
// A fast model streams a short acknowledgement line while the main answer is generated.
// Same model list as the Active Model picker (filtered to what the filler can run), plus Auto and Off,
// and a real speed test per model. Logic lives in electron/llm/filler.ts.
import { Gauge } from 'lucide-react';
import React, { useEffect, useState } from 'react';
import { AipBadge } from './AIProvidersSettings';

type Opt = { id: string; name: string };
type Result = { modelId: string; ok: boolean; firstTokenMs?: number; totalMs?: number; wordsPerSec?: number; text?: string; error?: string };

export const FillerModelCard: React.FC<{
  allOptions: Opt[];
  renderSelect: (value: string, options: Opt[], onChange: (v: string) => void) => React.ReactNode;
}> = ({ allOptions, renderSelect }) => {
  const [model, setModel] = useState('auto');
  const [usable, setUsable] = useState<Opt[]>([]);
  const [results, setResults] = useState<Result[]>([]);
  const [testing, setTesting] = useState<string | null>(null);

  useEffect(() => {
    void window.electronAPI.getFillerConfig?.().then((c) => { setModel(c.model); }).catch(() => {});
  }, []);

  const key = allOptions.map((o) => o.id).join(',');
  useEffect(() => {
    let cancelled = false;
    void window.electronAPI.filterFillerCandidates?.(allOptions.map((o) => o.id))
      .then((ids) => { if (!cancelled) setUsable(allOptions.filter((o) => ids.includes(o.id))); })
      .catch(() => {});
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const options: Opt[] = [{ id: 'auto', name: 'Auto (fastest)' }, ...usable, { id: 'off', name: 'Off' }];
  if (!options.some((o) => o.id === model)) options.splice(1, 0, { id: model, name: `${model} (not available)` });

  const choose = (v: string) => {
    const prev = model;
    setModel(v);
    void window.electronAPI.setFillerModel?.(v).then((c) => setModel(c.model)).catch(() => setModel(prev));
  };

  const runTests = async (ids: string[]) => {
    setResults([]);
    const out: Result[] = [];
    for (const id of ids) {
      setTesting(id);
      // One at a time: parallel calls would compete for bandwidth and skew the numbers.
      const r = await window.electronAPI.testFillerSpeed?.(id).catch((e: any) => ({ modelId: id, ok: false, error: String(e?.message ?? e) }));
      if (r) out.push(r);
      setResults([...out].sort((a, b) => (a.ok === b.ok ? (a.firstTokenMs ?? 1e9) - (b.firstTokenMs ?? 1e9) : a.ok ? -1 : 1)));
    }
    setTesting(null);
  };

  const nameOf = (id: string) => allOptions.find((o) => o.id === id)?.name ?? id;
  const secs = (ms?: number) => (ms === undefined ? '—' : `${(ms / 1000).toFixed(2)}s`);
  const fastest = results.find((r) => r.ok)?.modelId;

  return (
    <section className="aip-card aip-feature-card" aria-label="Filler Model">
      <div className="aip-feature-head">
        <div className="aip-feature-copy">
          <h3 className="block text-xs font-medium uppercase tracking-wide mb-0 aip-hero">Filler Model</h3>
          <p className="aip-meta mt-1">
            Runs alongside the main model and shows a complete opening sentence. Auto chooses your fastest available model.
          </p>
        </div>
        {renderSelect(model, options, choose)}
      </div>

      <div className="aip-feature-list">
        <div className="aip-feature-toolbar">
          <span className="aip-label">Speed test</span>
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" className="aip-btn" data-size="sm" disabled={!!testing || model === 'off' || model === 'auto'} onClick={() => void runTests([model])} title="Time the selected model">
              <Gauge size={11} /> Test selected
            </button>
            <button type="button" className="aip-btn" data-size="sm" disabled={!!testing || !usable.length} onClick={() => void runTests(usable.map((o) => o.id))} title="Time every model, one at a time">
              <Gauge size={11} /> Test all ({usable.length})
            </button>
          </div>
        </div>
        <div role="status" aria-live="polite" className="aip-meta">
          {testing ? <AipBadge tone="info" busy label={`Testing ${nameOf(testing)}…`} /> : results.length ? `${results.length} models tested. Results sorted by first response.` : 'Compare response times to choose a model for opening lines and backups.'}
        </div>
        {results.length > 0 && (
          <div className="aip-well aip-scroll-y aip-speed-scroll custom-scrollbar aip-models-well" tabIndex={0} role="region" aria-label="Model speed results">
            <table className="aip-speed-table">
            <thead><tr><th scope="col">Model</th><th scope="col">First word</th><th scope="col">Total</th><th scope="col">Words/s</th><th scope="col"><span className="sr-only">Selection</span></th></tr></thead>
            <tbody>
            {results.map((r) => (
              <tr key={r.modelId} title={r.text || r.error || ''}>
                <td><div className="aip-speed-name"><span>{nameOf(r.modelId)}</span>
                {r.modelId === fastest && <AipBadge tone="ok" label="Fastest" />}</div></td>
                {r.ok ? (
                  <>
                    <td>{secs(r.firstTokenMs)}</td>
                    <td>{secs(r.totalMs)}</td>
                    <td title={r.wordsPerSec === undefined ? 'Arrived all at once, not streamed' : undefined}>{r.wordsPerSec ?? '—'}</td>
                    <td>
                      {r.modelId === model
                        ? <span className="aip-meta">In use</span>
                        : <button type="button" className="aip-btn" data-size="sm" aria-label={`Use ${nameOf(r.modelId)} for opening lines`} onClick={() => choose(r.modelId)}>Use</button>}
                    </td>
                  </>
                ) : (
                  <td colSpan={4} title={r.error}><AipBadge tone="danger" label="Failed" /><span className="aip-meta ml-2">{(r.error || 'No response').slice(0, 80)}</span></td>
                )}
              </tr>
            ))}
            </tbody></table>
          </div>
        )}
      </div>
    </section>
  );
};
