import { useState } from 'react';
import { isOllama, ollamaWarm, pipelineConfigFromSettings, providerById, type AppSettings } from '@ait/core';
import { fmtNumber, tr } from '@ait/core/i18n';
import samplePage from '../assets/sample-page.png?url';
import { benchmarkOf, compareVariants, fmtSeconds, type Benchmark, type CompareVariant } from '../benchmark';
import { checkOcrNeeds } from '../ocrSetup';
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
    const beforeDetector = service.detector;
    if (lamaModeOf(settings) === 'browser' && platform.inpaint && (await platform.lama?.downloaded().catch(() => false))) service.inpainter = platform.inpaint;
    // So does the text detector.
    if (settings.detectorMode === 'browser' && platform.detector?.detect && (await platform.detector.downloaded().catch(() => false))) service.detector = platform.detector.detect;
    const t0 = performance.now();
    try {
      const { result } = await service.translate(bytes, 'image/png', { title: tr('Замер скорости'), force: true });
      const fallback = (providerById(settings, settings.translationProviderId) ?? providerById(settings, settings.visionProviderId))?.model ?? '';
      setBench(benchmarkOf(result.page, performance.now() - t0, fallback));
    } finally {
      service.inpainter = before;
      service.detector = beforeDetector;
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
            {bench.tps ? ` · ${tr('скорость модели: {0} токенов/с', fmtNumber(Math.round(bench.tps)))}` : ''}
          </small>
          {bench.hint ? <small data-testid="speed-hint">{tr('Быстрее всего ускорит: {0}', bench.hint)}</small> : null}
        </div>
      ) : null}
    </div>
  );
}

interface CompareRow {
  v: CompareVariant;
  ms: number | null;
  readBy?: 'ocr' | 'vision';
  tokens?: { input: number; output: number } | null;
  error?: string;
}

/**
 * «Сравнить скорость»: the sample page (Japanese) translated by the local and the online model, each
 * as usual and with «Сначала распознавание», one after another, past the cache. A local model is
 * loaded first (its loading is not counted). The online model gets the sample picture.
 */
export function SpeedCompare({ settings }: { settings: AppSettings }) {
  const platform = usePlatform();
  const [rows, setRows] = useState<CompareRow[] | null>(null);
  const run = useAction(async () => {
    setRows(null);
    const bytes = new Uint8Array(await (await fetch(samplePage)).arrayBuffer());
    const keyed = new Set<string>();
    for (const p of settings.providers) if (p.apiKey || (await platform.secrets.get(`provider:${p.id}`).catch(() => undefined))) keyed.add(p.id);
    const ja = { ...settings, sourceLang: 'ja' };
    const n = platform.ocr && platform.detector ? await checkOcrNeeds(platform, ja).catch(() => null) : null;
    const variants = compareVariants(settings.providers, { keyed, recognition: !!n && n.det && n.ocr });
    if (!variants.length) throw new Error(tr('Нет модели, которая читает картинки: добавьте локальную или онлайн-модель (с ключом).'));
    const out: CompareRow[] = variants.map((v) => ({ v, ms: null }));
    setRows([...out]);
    const warmed = new Set<string>();
    for (const [i, row] of out.entries()) {
      const over = { ...row.v.settings, sourceLang: 'ja' };
      try {
        const vision = pipelineConfigFromSettings({ ...settings, ...over }).vision;
        if (row.v.local && vision && isOllama(vision) && !warmed.has(row.v.providerId)) {
          warmed.add(row.v.providerId);
          await ollamaWarm(vision);
        }
        const t0 = performance.now();
        const { result } = await platform.service.translate(bytes, 'image/png', { title: tr('Сравнение скорости'), force: true, settings: over });
        const b = benchmarkOf(result.page, performance.now() - t0);
        out[i] = { ...row, ms: b.rows.find((r) => r.stage === 'total')?.ms ?? null, readBy: result.page.timings.readBy, tokens: b.tokens };
      } catch (e) {
        out[i] = { ...row, error: e instanceof Error ? e.message : String(e) };
      }
      setRows([...out]);
    }
  });
  const base = (r: CompareRow) => rows?.find((o) => o.v.providerId === r.v.providerId && !o.v.cascade && o.ms);
  return (
    <div style={{ display: 'grid', gap: 8 }} data-testid="speed-compare">
      <span style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <button type="button" className="ait-btn small" disabled={run.busy} onClick={() => void run.run()}>
          {run.busy ? tr('Сравниваю…') : tr('Сравнить локальную и онлайн-модель')}
        </button>
        <small className="ait-muted">{tr('Пробная страница через каждую модель: как обычно и со «Сначала распознавание». Онлайн-модели уйдёт пробная картинка.')}</small>
      </span>
      <ErrorBox error={run.error} onRetry={() => void run.run()} />
      {rows ? (
        <table style={{ borderCollapse: 'collapse' }} data-testid="speed-compare-table">
          <thead>
            <tr>
              <th style={{ textAlign: 'left', padding: '2px 12px 2px 0' }}>{tr('Модель')}</th>
              <th style={{ textAlign: 'left', padding: '2px 12px 2px 0' }}>{tr('Как')}</th>
              <th style={{ textAlign: 'right', padding: '2px 12px 2px 0' }}>{tr('Время')}</th>
              <th style={{ textAlign: 'right', padding: '2px 0' }}>{tr('Токены')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const b = r.v.cascade ? base(r) : undefined;
              const faster = b?.ms && r.ms ? b.ms / r.ms : null;
              return (
                <tr key={`${r.v.providerId}:${r.v.cascade}`}>
                  <td style={{ padding: '2px 12px 2px 0' }}>{r.v.label}{r.v.local ? '' : ` (${tr('онлайн')})`}</td>
                  <td style={{ padding: '2px 12px 2px 0' }}>
                    {r.v.cascade ? tr('сначала распознавание') : tr('модель читает картинку')}
                    {r.v.cascade && r.readBy === 'vision' ? <small className="ait-muted"> · {tr('прочитано неуверенно — читала модель')}</small> : null}
                  </td>
                  <td style={{ padding: '2px 12px 2px 0', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                    {r.error ? <span className="ait-badge" title={r.error}>{tr('ошибка')}</span> : r.ms === null ? '…' : tr('{0} с', fmtSeconds(r.ms))}
                    {faster ? <small className="ait-muted"> · ×{faster.toFixed(1)}</small> : null}
                  </td>
                  <td style={{ padding: '2px 0', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{r.tokens ? `${fmtNumber(r.tokens.input)} / ${fmtNumber(r.tokens.output)}` : '—'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      ) : null}
    </div>
  );
}
