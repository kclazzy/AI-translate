// Builds the extension for Chromium (dist/) and Firefox (dist-firefox/).
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const watch = process.argv.includes('--watch');

const { buildManifest, MANIFEST_TEXT } = await import(resolve(root, 'manifest.ts')).catch(async () => {
  // Node cannot import .ts directly on older versions: transpile with esbuild via vite.
  const { transformWithEsbuild } = await import('vite');
  const src = readFileSync(resolve(root, 'manifest.ts'), 'utf8');
  const { code } = await transformWithEsbuild(src, 'manifest.ts', { loader: 'ts', format: 'esm' });
  const tmp = resolve(root, 'node_modules/.manifest.mjs');
  writeFileSync(tmp, code);
  return import(tmp);
});

async function buildTarget(out) {
  process.env.AIT_OUT = out;
  await build({ configFile: resolve(root, 'vite.config.ts'), build: { outDir: out, watch: watch ? {} : null } });
  await build({ configFile: resolve(root, 'vite.content.config.ts'), build: { outDir: out, watch: watch ? {} : null } });
}

await buildTarget('dist');
mkdirSync(resolve(root, 'dist/icons'), { recursive: true });
cpSync(resolve(root, 'public/icons'), resolve(root, 'dist/icons'), { recursive: true });
writeFileSync(resolve(root, 'dist/manifest.json'), JSON.stringify(buildManifest('chrome', pkg.version), null, 2));
// Browser-side texts (name, description, shortcuts) in every interface language.
const localesDir = resolve(root, '../../packages/core/src/i18n/locales');
const codes = ['ru', ...readdirSync(localesDir).map((f) => f.replace(/\.json$/, ''))];
for (const code of codes) {
  const dict = code === 'ru' ? {} : JSON.parse(readFileSync(resolve(localesDir, `${code}.json`), 'utf8'));
  const messages = Object.fromEntries(Object.entries(MANIFEST_TEXT).map(([k, ru]) => [k, { message: dict[ru] ?? ru }]));
  const dir = resolve(root, `dist/_locales/${code === 'zh' ? 'zh_CN' : code === 'pt' ? 'pt_BR' : code}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(resolve(dir, 'messages.json'), JSON.stringify(messages, null, 2));
}

if (!watch) {
  const ff = resolve(root, 'dist-firefox');
  if (existsSync(ff)) rmSync(ff, { recursive: true });
  cpSync(resolve(root, 'dist'), ff, { recursive: true });
  writeFileSync(resolve(ff, 'manifest.json'), JSON.stringify(buildManifest('firefox', pkg.version), null, 2));
}
console.log('Extension built: dist/ (Chrome, Edge, Brave, Opera) and dist-firefox/');
