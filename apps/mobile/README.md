# AI Translate для Android и iPhone

Одно веб-приложение (React + общая студия) работает в трёх вариантах: как PWA в браузере, внутри Android-приложения и внутри iOS-приложения (Capacitor 8).

## Самостоятельная работа без ПК

На телефоне выполняются очистка текста, вёрстка, редактор и экспорт. Изображение читает vision-модель:

- облачная по вашему ключу (Gemini, Claude, OpenAI, OpenRouter);
- или модель на ПК в той же сети Wi-Fi (Ollama, LM Studio);
- или движок AI Translate на ПК (`python -m app --lan`).

Выбор делается в мастере при первом запуске и меняется в настройках.

## Разработка

```bash
pnpm install
pnpm --filter @ait/mobile dev        # http://localhost:5173 и адрес в сети для телефона
pnpm --filter @ait/mobile build      # → dist/
```

## Android

```bash
pnpm --filter @ait/mobile android    # сборка, cap sync, открыть Android Studio
# или без Android Studio:
cd apps/mobile && pnpm build && npx cap sync android && cd android && ./gradlew assembleDebug
```

APK собирается автоматически в GitHub Actions (`.github/workflows/android.yml`).

Как PWA (без APK): откройте опубликованное приложение в Chrome → «Установить приложение». После этого AI Translate появится в меню «Поделиться» галереи.

## iPhone / iPad

Нужен Mac с Xcode:

```bash
pnpm --filter @ait/mobile ios        # сборка, cap sync, открыть Xcode
```

GitHub Actions (`ios.yml`) собирает проект под симулятор и неподписанный `.ipa`. Как PWA: Safari → «Поделиться» → «На экран Домой».

## Сеть

- Android: разрешён обычный HTTP к компьютеру в локальной сети (`usesCleartextTraffic`, `allowMixedContent`).
- iOS: `NSAllowsLocalNetworking` и описание доступа к локальной сети в `Info.plist`.
- Ollama на ПК: `OLLAMA_HOST=0.0.0.0` и `OLLAMA_ORIGINS=*` (или `capacitor://localhost,https://localhost`).
