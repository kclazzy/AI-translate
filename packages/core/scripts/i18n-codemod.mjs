// Wrap Russian UI strings in t(): 'Текст' → t('Текст'), JSX text → {t('Текст')},
// `Готово ${n} из ${m}` → t('Готово {0} из {1}', n, m). Run with --report to only list them.
// Strings that are data (regex sources, comparisons, call arguments of string methods) are skipped.
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const CYR = /[А-Яа-яЁё]/;
const report = process.argv.includes('--report');
const files = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const SKIP_CALLEES = new Set(['RegExp', 't', 'tr', 'test', 'match', 'replace', 'replaceAll', 'includes', 'startsWith', 'endsWith', 'split', 'indexOf', 'has', 'get']);
let total = 0;

const quote = (s) => `'${JSON.stringify(s).slice(1, -1).replace(/'/g, "\\'").replace(/\\"/g, '"')}'`;

for (const file of files) {
  let src = readFileSync(file, 'utf8');
  const before = total;
  for (let pass = 0; pass < 5; pass++) {
    const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const edits = [];
    const skip = (node) => {
      const p = node.parent;
      if (!p) return false;
      if (ts.isImportDeclaration(p) || ts.isExportDeclaration(p)) return true;
      if (ts.isPropertyAssignment(p) && p.name === node) return true;
      if (ts.isLiteralTypeNode(p)) return true;
      if (ts.isCallExpression(p) || ts.isNewExpression(p)) {
        const e = p.expression;
        const name = ts.isIdentifier(e) ? e.text : ts.isPropertyAccessExpression(e) ? e.name.text : '';
        if (SKIP_CALLEES.has(name)) return true;
      }
      if (ts.isBinaryExpression(p) && [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken].includes(p.operatorToken.kind)) return true;
      if (ts.isCaseClause(p)) return true;
      if (ts.isElementAccessExpression(p) && p.argumentExpression === node) return true;
      return false;
    };
    const visit = (node) => {
      if ((ts.isTemplateExpression(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isStringLiteral(node)) && node.getText(sf).includes('</')) {
        if (CYR.test(node.getText(sf)) && pass === 0) console.error(`MANUAL ${file}:${sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1}`);
        return;
      }
      if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && CYR.test(node.text) && !skip(node)) {
        const repl = `tr(${quote(node.text)})`;
        edits.push([node.getStart(sf), node.end, ts.isJsxAttribute(node.parent) ? `{${repl}}` : repl, node.text]);
        return;
      }
      if (ts.isTemplateExpression(node) && !skip(node)) {
        const parts = [node.head.text, ...node.templateSpans.map((s) => s.literal.text)];
        if (parts.some((p) => CYR.test(p))) {
          let key = node.head.text;
          const args = [];
          node.templateSpans.forEach((s, i) => {
            key += `{${i}}` + s.literal.text;
            args.push(src.slice(s.expression.getStart(sf), s.expression.end));
          });
          const repl = `tr(${quote(key)}, ${args.join(', ')})`;
          edits.push([node.getStart(sf), node.end, ts.isJsxAttribute(node.parent) ? `{${repl}}` : repl, key]);
          return;
        }
      }
      if (ts.isJsxText(node) && CYR.test(node.text)) {
        const raw = node.text;
        const lead = raw.match(/^\s*/)[0];
        const trail = raw.match(/\s*$/)[0];
        const text = raw.trim().replace(/\s+/g, ' ');
        // JSX keeps a space next to an expression on the same line; keep it explicitly.
        const l = lead && !lead.includes('\n') ? "{' '}" : '';
        const r = trail && !trail.includes('\n') ? "{' '}" : '';
        edits.push([node.getStart(sf, true), node.end, `${lead.includes('\n') ? lead : ''}${l}{tr(${quote(text)})}${r}${trail.includes('\n') ? trail : ''}`, text]);
        return;
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
    if (!edits.length) break;
    if (report) {
      for (const e of edits) console.log(`${file}\t${e[3]}`);
      break;
    }
    edits.sort((a, b) => b[0] - a[0]);
    for (const [s, e, r] of edits) src = src.slice(0, s) + r + src.slice(e);
    total += edits.length;
  }
  if (!report && total !== before) {
    if (!/import \{[^}]*\btr\b[^}]*\} from/.test(src)) {
      const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
      const imports = sf.statements.filter((x) => ts.isImportDeclaration(x));
      const at = imports.length ? imports[imports.length - 1].end : 0;
      const core = file.includes('packages/core/src/');
      let from = '@ait/core/i18n';
      if (core) {
        const rel = path.relative(path.dirname(file), path.resolve('packages/core/src/i18n')).replace(/\\/g, '/');
        from = rel.startsWith('.') ? rel : `./${rel}`;
      }
      const line = `import { tr } from '${from}';`;
      src = at ? src.slice(0, at) + '\n' + line + src.slice(at) : line + '\n' + src;
    }
    writeFileSync(file, src);
  }
}
if (!report) console.error(`wrapped ${total}`);
