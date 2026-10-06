// Packs the three release files: desktop (extension + engine), Android and iOS.
// Run after building the extension and the mobile web app.
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, relative } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const require = createRequire(join(ROOT, 'packages/core/package.json'));
const JSZip = require('jszip');
const version = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
const OUT = join(ROOT, 'release');
mkdirSync(OUT, { recursive: true });

const SKIP = new Set(['node_modules', '.venv', 'venv', '__pycache__', '.pytest_cache', 'data', '.gradle', 'build', 'DerivedData', 'Pods', '.test-output', 'release', '.git']);

function addDir(zip, dir, prefix, extraSkip = new Set()) {
  if (!existsSync(dir)) throw new Error(`Missing ${dir} — build it first`);
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name) || extraSkip.has(name)) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) addDir(zip, p, `${prefix}/${name}`, extraSkip);
    else zip.file(`${prefix}/${name}`, readFileSync(p), { unixPermissions: st.mode });
  }
}

async function write(zip, name) {
  const data = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE', compressionOptions: { level: 6 }, platform: 'UNIX' });
  writeFileSync(join(OUT, name), data);
  console.log(`${name}: ${(data.length / 1024 / 1024).toFixed(1)} MB`);
}

function mobileSource(zip, prefix, platform) {
  for (const f of ['package.json', 'pnpm-lock.yaml', 'tsconfig.base.json', 'LICENSE']) zip.file(`${prefix}/${f}`, readFileSync(join(ROOT, f)));
  zip.file(`${prefix}/pnpm-workspace.yaml`, 'packages:\n  - "packages/*"\n  - "apps/mobile"\nonlyBuiltDependencies:\n  - esbuild\n');
  addDir(zip, join(ROOT, 'packages/core'), `${prefix}/packages/core`, new Set(['test']));
  addDir(zip, join(ROOT, 'packages/studio'), `${prefix}/packages/studio`);
  addDir(zip, join(ROOT, 'apps/mobile'), `${prefix}/apps/mobile`, new Set(['dist', platform === 'android' ? 'ios' : 'android']));
}

// 1. Desktop
{
  const zip = new JSZip();
  addDir(zip, join(ROOT, 'apps/extension/dist'), 'extension-chrome');
  addDir(zip, join(ROOT, 'apps/extension/dist-firefox'), 'extension-firefox');
  addDir(zip, join(ROOT, 'engine'), 'engine', new Set(['models']));
  zip.file('engine/models/README.md', readFileSync(join(ROOT, 'engine/models/README.md')));
  zip.file(
    'README-RU.txt',
    `AI Translate ${version} — версия для компьютера

1. РАСШИРЕНИЕ
   Chrome / Edge / Brave / Opera: откройте chrome://extensions, включите «Режим разработчика»,
   нажмите «Загрузить распакованное» и выберите папку extension-chrome.
   Firefox 128+: about:debugging → «Этот Firefox» → «Загрузить временное дополнение» →
   extension-firefox/manifest.json.

2. МОДЕЛЬ
   Откройте настройки расширения и выберите модель, которая понимает изображения.
   Локально: установите Ollama, выполните «ollama pull qwen2.5vl:7b» и задайте переменную
   OLLAMA_ORIGINS=chrome-extension://*,moz-extension://* (затем перезапустите Ollama).
   Облако: добавьте провайдера (Gemini, Claude, OpenAI, OpenRouter) и вставьте ключ.

3. ЛОКАЛЬНЫЙ ДВИЖОК (по желанию, для видеокарты)
   Нужен Python 3.11+. Запустите engine\\scripts\\start-engine.bat.
   В окне появятся адрес и код сопряжения — вставьте их в настройках расширения
   («Где обрабатывать» → «Локальный движок»).
   Для RTX 50xx и японского OCR: engine\\scripts\\install-gpu-extras.bat.
   Для телефонов в той же сети: start-engine.bat --lan

Подробности: README.md в репозитории https://github.com/kclazzy/AI-translate
`,
  );
  await write(zip, `ai-translate-desktop-v${version}.zip`);
}

// 2. Android
{
  const zip = new JSZip();
  addDir(zip, join(ROOT, 'apps/mobile/dist'), 'web-app');
  mobileSource(zip, 'source', 'android');
  zip.file(
    'README-RU.txt',
    `AI Translate ${version} — Android

web-app/   готовое веб-приложение. Разместите его на любом HTTPS-хостинге (GitHub Pages
           делает это автоматически) и откройте в Chrome на телефоне → «Установить приложение».
           После установки AI Translate появится в меню «Поделиться» галереи.
source/    исходники приложения и проект Android (Capacitor).

СОБРАТЬ APK (нужны Node.js 20+, pnpm, Android Studio или Android SDK + JDK 21):
   cd source
   pnpm install
   pnpm --filter @ait/mobile build
   cd apps/mobile && npx cap sync android
   cd android && gradlew assembleDebug        (Windows)   |   ./gradlew assembleDebug
   Готовый файл: android/app/build/outputs/apk/debug/app-debug.apk
   Или: pnpm --filter @ait/mobile android  — откроет проект в Android Studio.

Также APK собирается автоматически в GitHub Actions при каждом коммите (workflow «Android APK»).

ПЕРВЫЙ ЗАПУСК: выберите, где работает модель — облачный сервис по ключу, Ollama/LM Studio
на ПК в той же сети или движок AI Translate на ПК (python -m app --lan).
`,
  );
  await write(zip, `ai-translate-android-v${version}.zip`);
}

// 3. iOS
{
  const zip = new JSZip();
  addDir(zip, join(ROOT, 'apps/mobile/dist'), 'web-app');
  mobileSource(zip, 'source', 'ios');
  zip.file(
    'README-RU.txt',
    `AI Translate ${version} — iPhone и iPad

web-app/   готовое веб-приложение. Разместите на HTTPS-хостинге (GitHub Pages делает это
           автоматически), откройте в Safari → «Поделиться» → «На экран Домой».
source/    исходники и проект Xcode (Capacitor, Swift Package Manager).

СОБРАТЬ ПРИЛОЖЕНИЕ (нужен Mac с Xcode 16+, Node.js 20+, pnpm):
   cd source
   pnpm install
   pnpm --filter @ait/mobile ios      — соберёт веб-часть и откроет Xcode
   В Xcode выберите свою команду (Apple ID) в Signing & Capabilities и нажмите Run.

Без Mac: GitHub Actions (workflow «iOS build») собирает неподписанный .ipa.
Его можно подписать своим Apple ID через Sideloadly или AltStore.

Ограничение iOS: нельзя рисовать поверх других приложений, поэтому переводите страницы
в приложении или скриншоты через меню «Поделиться».
`,
  );
  await write(zip, `ai-translate-ios-v${version}.zip`);
}

console.log(`Release files in ${relative(process.cwd(), OUT) || OUT}`);
