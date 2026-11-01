# AI Translate — rules for Claude

The user writes in Russian. Answer in Russian, short and concrete.

## Always work in ub-mode

For every code change, without being asked:

1. **Make it work**
   - The smallest edit that solves the problem; one decision in one place.
   - Data shape first, then logic.
   - TDD: a failing test first; see it fail for the expected reason; then the smallest fix.
   - Fix root causes: reproduce first. A guard that hides the crash is not a fix.
   - If two fixes on one premise fail, write the premise down and attack it before trying a third.
   - Subtract before you add.
   - Validate data at the boundary; keep business logic in pure functions; don't silence the compiler.
   - Operations must be idempotent.
2. **Make it right**
   - Tests check behaviour the user sees, not implementation.
   - Remove duplication and dead code.
   - When refactoring: pin the behaviour, change the structure, prove the behaviour did not change.
3. **Practice**
   - Small ordered commits. Each commit says why, what changed, and how it was proved.
   - Push to main at the end.
   - Keep a log of actions and reasons, and report it on completion.
   - Never claim something is fixed without verifying it.

## Project constraints

- API keys never go into exported files, reports or logs. No full user content in logs either.
- No copyrighted manga images in the repo: synthetic test pages only.
- Don't remove features without need. No heavy dependencies. No unbounded queues.
- Migrations never delete user data.
- UI strings go through `tr()`. Then run `node packages/core/scripts/i18n-extract.mjs`, translate the new keys in all 9 locales (keep key order, indent 1), and check with `--check`.

## Release

Bump the version in 9 places:

- `package.json` ×5
- `engine/app/__init__.py`
- `engine/pyproject.toml`
- `engine/tests/test_api.py`
- `apps/mobile/src/main.tsx`

Then commit, `git push origin HEAD:main`, wait for CI, and deliver the release zip.
