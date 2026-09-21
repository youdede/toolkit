#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Youdede

// Thin installed wrapper: resolves the shared precondition bridge installed next to it and
// evaluates this command's declared preconditions.json. Installed layout:
//   commands/youdede/lib/command-precondition.mjs
//   commands/youdede/<slug>/{check-preconditions.mjs, preconditions.json}

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const bridge = path.resolve(here, '..', 'lib', 'command-precondition.mjs');
const config = path.join(here, 'preconditions.json');

const result = spawnSync(process.execPath, [bridge, '--config', config], { stdio: 'inherit' });
process.exit(result.status ?? 1);
