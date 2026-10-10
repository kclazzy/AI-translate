#!/usr/bin/env node
/**
 * Golden set with a real model (run by hand, needs the model server running):
 *
 *   node scripts/golden-real.mjs --base http://127.0.0.1:11434 --model qwen3.5:9b-q4_K_M
 *   node scripts/golden-real.mjs --provider openai --base https://api.openai.com --model gpt-4.1-mini --key sk-…
 *   node scripts/golden-real.mjs --provider anthropic --model claude-haiku-4-5-20251001 --key sk-ant-…
 *   node scripts/golden-real.mjs … --page en-oval        (only pages whose name contains this)
 *
 * Runs packages/core/test/golden.test.ts in real mode (GOLDEN_REAL=1) through vitest and writes
 * .test-output/golden/report.html: checks per page, translation similarity, time, before/after.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(`--${name}`);
  if (i >= 0) return args[i + 1];
  const eq = args.find((a) => a.startsWith(`--${name}=`));
  return eq ? eq.slice(name.length + 3) : undefined;
};

if (args.includes('--help') || args.includes('-h')) {
  console.log('node scripts/golden-real.mjs --base <url> --model <name> [--provider ollama|openai|anthropic] [--key <api key>] [--page <name>]');
  process.exit(0);
}

const env = { ...process.env, GOLDEN_REAL: '1' };
for (const [flag, key] of [['base', 'GOLDEN_BASE'], ['model', 'GOLDEN_MODEL'], ['provider', 'GOLDEN_PROVIDER'], ['key', 'GOLDEN_KEY']]) {
  const v = opt(flag);
  if (v) env[key] = v;
}
if (env.GOLDEN_PROVIDER && !['ollama', 'openai', 'anthropic'].includes(env.GOLDEN_PROVIDER)) {
  console.error(`--provider must be ollama, openai or anthropic (got ${env.GOLDEN_PROVIDER})`);
  process.exit(2);
}
if (!env.GOLDEN_MODEL) console.warn('No --model given: the provider preset default is used.');

const core = join(root, 'packages', 'core');
if (!existsSync(join(core, 'node_modules'))) {
  console.error('Install the dependencies first: pnpm install');
  process.exit(2);
}
const page = opt('page');
const vitestArgs = ['vitest', 'run', 'test/golden.test.ts', ...(page ? ['-t', page] : [])];
console.log(`Golden set: ${env.GOLDEN_MODEL ?? '(preset model)'} at ${env.GOLDEN_BASE ?? '(preset address)'} …`);
const child = spawn('npx', vitestArgs, { cwd: core, env, stdio: 'inherit', shell: process.platform === 'win32' });
child.on('exit', (code) => {
  const report = join(root, '.test-output', 'golden', 'report.html');
  if (existsSync(report)) console.log(`\nReport: ${report}`);
  process.exit(code ?? 1);
});
