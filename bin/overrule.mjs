#!/usr/bin/env node
/**
 * `overrule` bin — runnable Node entry that delegates to the TypeScript CLI
 * (src/cli.ts) via the tsx loader. No build step: this is an offline dev tool.
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const result = spawnSync(process.execPath, ['--import', 'tsx', cli, ...process.argv.slice(2)], {
  stdio: 'inherit',
});
process.exit(result.status ?? 1);
