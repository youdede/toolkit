#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const result = spawnSync(process.execPath, [path.resolve(here, '..', 'lib', 'command-precondition.mjs'), '--config', path.join(here, 'preconditions.json')], { stdio: 'inherit' });
process.exit(result.status ?? 1);
