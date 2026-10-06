# Движок AI Translate (Python)

Локальный сервер для ПК с видеокартой: ищет баблы и текст, распознаёт его, переводит через выбранную модель и убирает оригинал с картинки. Расширение и приложение на телефоне подключаются к нему по HTTP.

## Установка и запуск

Windows: двойной щелчок по `scripts\start-engine.bat` (создаст `.venv`, поставит зависимости, скопирует `.env.example` в `.env`).

Linux/macOS: `scripts/start-engine.sh`.

Вручную:

```bash
python -m venv .venv
.venv/bin/pip install -e .
.venv/bin/python -m app            # http://127.0.0.1:8765
.venv/bin/python -m app --lan      # принять телефоны в той же сети Wi-Fi
```

При запуске в окне печатаются адрес и **код сопряжения**. Вставьте их в настройки расширения или приложения (раздел «Где обрабатывать» → «Локальный движок»).

## Дополнительные модели (по желанию)

`scripts\install-gpu-extras.bat` ставит:

- PyTorch для CUDA 12.8 — нужен для RTX 50xx (Blackwell);
- manga-ocr — японский OCR, обученный на манге;
- onnxruntime-gpu — для LaMa.

LaMa: положите `lama_fp32.onnx` в `models/` и задайте `AIT_LAMA_ONNX=models/lama_fp32.onnx` в `.env`. Подробности и лицензии — `models/README.md`.

## Как устроен конвейер

| Этап | Реализации |
| --- | --- |
| Поиск текста | `classic` — баблы и текст классическим CV, без весов; `vision` — vision-модель; `auto` — classic, при пустом результате vision |
| OCR | `manga-ocr`, `paddle`, `vision` (кропы блоков пачкой в одном запросе) |
| Перевод | любой OpenAI-совместимый сервер (Ollama, LM Studio, OpenAI, DeepSeek, OpenRouter, Gemini) или Anthropic |
| Очистка | `fill` (цвет бабла), `telea` (OpenCV), `lama` (ONNX) |

Длинные вебтуны обрабатываются окнами по 4096 px с нахлёстом 512 px и возвращаются тайлами по 4096 px.

## API

| Метод | Путь | Назначение |
| --- | --- | --- |
| GET | `/v1/health` | статус (без токена — только версия) |
| GET | `/v1/capabilities` | доступные детекторы, OCR, очистка, лимиты, расход |
| POST | `/v1/pages/translate` | multipart `image` + `options` → `{jobId}` |
| GET | `/v1/jobs/{id}/events` | SSE: `stage`, `done`, `error` |
| GET/DELETE | `/v1/jobs/{id}` | статус / отмена |
| GET | `/v1/assets/{id}` | очищенный тайл PNG |
| POST | `/v1/ocr/region` | ручной OCR выделенной области |
| POST | `/v1/text/translate` | перевод готовых строк |
| POST | `/v1/inpaint` | очистка по маске |

## Безопасность

- Слушает только `127.0.0.1`; с `--lan` — частные сети, проверка заголовка `Host` защищает от DNS rebinding.
- CORS разрешён только расширениям (`chrome-extension://`, `moz-extension://`) и приложению (`capacitor://localhost`, `http(s)://localhost`). Обычные сайты получают 401.
- Все запросы, кроме `/v1/health`, требуют токен сопряжения.
- Движок не скачивает URL (нет SSRF): клиент присылает байты изображения.
- Лимиты размера загрузки и числа пикселей до декодирования (защита от image bombs).
- Ключи API приходят с запросом и не сохраняются на диск.

## Тесты

```bash
.venv/bin/pip install -e ".[dev]"
.venv/bin/python -m pytest -q
```

Тесты рисуют синтетические страницы манги с вертикальным японским текстом, поднимают поддельный OpenAI-совместимый сервер и проверяют весь путь: детекцию, OCR, перевод, очистку, тайлинг, кэш, API, SSE и правила безопасности.
