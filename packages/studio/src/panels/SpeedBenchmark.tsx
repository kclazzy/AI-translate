import { useState } from 'react';
import { providerById, type AppSettings } from '@ait/core';
import { fmtNumber, tr } from '@ait/core/i18n';
import samplePage from '../assets/sample-page.png?url';
import { benchmarkOf, fmtSeconds, type Benchmark } from '../benchmark';
import { lamaModeOf } from '../lama';
import { usePlatform } from '../platform';
import { ErrorBox, useAction } from '../ui';

/**
 * «Замерить скорость»: translates a bundled sample page (two bubbles with Japanese text) through the
 * normal pipeline, past the cache, and shows how long each stage took and what would speed it up.
 */
export function SpeedBenchmark({ settings }: { settings: AppSettings }) {
  const platform = usePlatform();
  const [bench, setBench] = useState<Benchmark | null>(null);
  const run = useAction(async () => {
    setBench(null);
    const bytes = new Uint8Array(await (await fetch(samplePage)).arrayBuffer());
    const service = platform.service;
    // LaMa in this browser takes part like on a real page (the studio's own service has none by default).
    const before = service.inpainter;
    if (lamaModeOf(settings) === 'browser' && platform.inpaint && (await platform.lama?.downloaded().catch(() => false))) service.inpainter = platform.inpaint;
    const t0 = performance.now();
    try {
      const { result } = await service.translate(bytes, 'image/png', { title: tr('Замер скорости'), force: true });
      const fallback = (providerById(settings, settings.translationProviderId) ?? providerById(settings, settings.visionProviderId))?.model ?? '';
      setBench(benchmarkOf(result.page, performance.now() - t0, fallback));
    } finally {
      service.inpainter = before;
    }
  });
  return (
    <div style={{ display: 'grid', gap: 8 }} data-testid="speed-benchmark">
      <span style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <button type="button" className="ait-btn small" disabled={run.busy} onClick={() => void run.run()}>
          {run.busy ? tr('Замеряю…') : tr('Замерить скорость')}
        </button>
        <small className="ait-muted">{run.busy ? tr('Перевожу пробную страницу…') : tr('Переведёт пробную страницу с двумя баблами (без кэша) и покажет, какой этап занимает больше всего времени.')}</small>
      </span>
      <ErrorBox error={run.error} onRetry={() => void run.run()} />
      {bench ? (
        <div style={{ display: 'grid', gap: 6 }} data-testid="speed-result">
          <table style={{ borderCollapse: 'collapse', maxWidth: 360 }}>
            <tbody>
              {bench.rows.map((r) => (
                <tr key={r.stage} style={r.stage === 'total' ? { fontWeight: 700, borderTop: '1px solid var(--line, #ccc)' } : r.stage === bench.slowest ? { color: 'var(--magenta, inherit)' } : undefined}>
                  <td style={{ padding: '2px 12px 2px 0' }}>{r.label}</td>
                  <td style={{ padding: '2px 0', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{r.ms === null ? '—' : tr('{0} с', fmtSeconds(r.ms))}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <small className="ait-muted">
            {tr('Модель: {0}', bench.model || '—')}
            {bench.tokens ? ` · ${tr('токенов: {0} на входе, {1} на выходе', fmtNumber(bench.tokens.input), fmtNumber(bench.tokens.output))}` : ''}
          </small>
          {bench.hint ? <small data-testid="speed-hint">{tr('Быстрее всего ускорит: {0}', bench.hint)}</small> : null}
        </div>
      ) : null}
    </div>
  );
}
