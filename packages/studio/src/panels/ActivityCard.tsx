import { useEffect, useState } from 'react';
import { activityLines, IDLE_LABELS, mainIdle, type ActivitySession } from '@ait/core';
import { tr } from '@ait/core/i18n';
import { usePlatform } from '../platform';

/** What to do about the biggest cause of idle time. */
function advice(s: ActivitySession): string | null {
  if (s.ollama.loads > 1) return tr('Модель загружалась заново между страницами: читайте и переводите одной моделью и держите её в памяти дольше («Локальные модели» → «Держать в памяти»).');
  switch (mainIdle(s)) {
    case 'picture':
      return tr('Чаще всего модель ждала картинку с сайта: перевод всей страницы сразу («Перевести страницу») качает картинки заранее.');
    case 'prep':
      return tr('Чаще всего модель ждала подготовку картинки: нейросети на видеокарте через движок («Где считать нейросети») ускорят её.');
    case 'context':
      return tr('Чаще всего следующая страница ждала контекст предыдущей — это цена связного перевода серии.');
    case 'finish':
      return tr('Модели было нечего делать, пока страницы стирались и верстались: «Страниц одновременно» больше даст ей следующую страницу раньше.');
    case 'memory':
      return tr('Следующая страница ждала памяти: закройте лишние вкладки или уменьшите «Страниц одновременно».');
    default:
      return null;
  }
}

/** «Куда ушло время» of the last chapter translated in the browser (see the extension's activity.ts). */
export function ActivityCard() {
  const platform = usePlatform();
  const [list, setList] = useState<ActivitySession[] | null>(null);
  useEffect(() => {
    let off = false;
    void platform.db.get<ActivitySession[]>('kv', 'activity').then((v) => !off && setList(v ?? []), () => undefined);
    return () => {
      off = true;
    };
  }, [platform]);
  const last = list?.at(-1);
  if (!last || last.workMs < 5_000) return null;
  const tip = advice(last);
  const top = mainIdle(last);
  return (
    <details className="ait-fine" data-testid="activity">
      <summary>
        {tr('Куда ушло время последней главы')}
        {top ? <span className="ait-muted"> — {tr('больше всего простоя: {0}', IDLE_LABELS[top]())}</span> : null}
      </summary>
      <pre className="ait-activity">{activityLines(last).join('\n')}</pre>
      {tip ? <small>{tip}</small> : null}
      <small className="ait-muted">{tr('Подробнее — в файле для анализа главы (activity.txt).')}</small>
    </details>
  );
}
