// List tr() calls evaluated when a module loads (outside any function).
import { readFileSync } from 'node:fs';
import ts from 'typescript';
for (const file of process.argv.slice(2)) {
  const src = readFileSync(file, 'utf8');
  if (!src.includes('tr(')) continue;
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const visit = (n, inFn) => {
    const fn = inFn || ts.isFunctionLike(n);
    if (!fn && ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'tr') console.log(`${file}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}`);
    ts.forEachChild(n, (c) => visit(c, fn));
  };
  visit(sf, false);
}
