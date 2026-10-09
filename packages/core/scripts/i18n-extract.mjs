// Collect every interface string (the Russian source) used in the code:
//   tr('…') / t('…') first arguments, values of lazyStrings({…}) tables, `ru:` texts of error messages.
// Writes packages/core/src/i18n/keys.json. `--check` fails when a locale misses a key.
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../..');
const DIRS = ['packages/core/src', 'packages/studio/src', 'apps/extension/src', 'apps/mobile/src', 'apps/extension/manifest.ts'];
const OUT = path.join(ROOT, 'packages/core/src/i18n/keys.json');

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (/\.tsx?$/.test(name) && !name.endsWith('.d.ts')) yield p;
  }
}

const keys = new Set();
const lit = (n) => (n && (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) ? n.text : null);
for (const dir of DIRS) {
  const abs = path.join(ROOT, dir);
  for (const file of statSync(abs).isDirectory() ? walk(abs) : [abs]) {
    const src = readFileSync(file, 'utf8');
    const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const visit = (n) => {
      if (ts.isCallExpression(n) && ts.isIdentifier(n.expression)) {
        const name = n.expression.text;
        if (name === 'tr' || name === 't' || name === 'N_') {
          const k = lit(n.arguments[0]);
          if (k && /[А-Яа-яЁё]/.test(k)) keys.add(k);
        }
        if (name === 'trp') for (const a of n.arguments.slice(1, 4)) if (lit(a)) keys.add(lit(a));
        if (name === 'lazyStrings' && n.arguments[0] && ts.isObjectLiteralExpression(n.arguments[0])) {
          for (const p of n.arguments[0].properties) if (ts.isPropertyAssignment(p) && lit(p.initializer)) keys.add(lit(p.initializer));
        }
      }
      if (file.endsWith('errors.ts') && ts.isPropertyAssignment(n) && ts.isIdentifier(n.name) && n.name.text === 'ru' && lit(n.initializer)) keys.add(lit(n.initializer));
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
}
const list = [...keys].sort();
if (process.argv.includes('--check')) {
  const dir = path.join(ROOT, 'packages/core/src/i18n/locales');
  let bad = 0;
  const saved = JSON.parse(readFileSync(OUT, 'utf8'));
  if (JSON.stringify(saved) !== JSON.stringify(list)) {
    bad++;
    console.error('keys.json is out of date: run node packages/core/scripts/i18n-extract.mjs and translate the new strings');
  }
  for (const f of readdirSync(dir)) {
    const d = JSON.parse(readFileSync(path.join(dir, f), 'utf8'));
    const missing = list.filter((k) => !d[k]);
    if (missing.length) {
      bad++;
      console.error(`${f}: ${missing.length} missing`, missing.slice(0, 5));
    }
  }
  process.exit(bad ? 1 : 0);
}
writeFileSync(OUT, JSON.stringify(list, null, 1) + '\n');
console.log(`${list.length} strings → ${path.relative(ROOT, OUT)}`);
