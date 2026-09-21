#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const bridge = path.resolve(here, '..', 'lib', 'command-precondition.mjs');
const config = path.join(here, 'preconditions.json');
const result = spawnSync(process.execPath, [bridge, '--config', config], { stdio: 'inherit' });
process.exit(result.status ?? 1);
