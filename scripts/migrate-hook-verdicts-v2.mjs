#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Youdede

// One-shot migration of quality/hook-verdicts.json from schema 1 (one row per case and hook) to
// schema 2 (one case with a result per hook). Kept until schema 1 support is removed;
// tests/hook-verdicts-format.test.mjs proves the expansion equals the schema 1 rows.
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { compactSnapshot, serializeCompactSnapshot } from './lib/hook-verdict-format.mjs';

const file = path.resolve(process.argv[2] ?? 'quality/hook-verdicts.json');
const document = JSON.parse(readFileSync(file, 'utf8'));
if (document.schemaVersion !== 1 || !Array.isArray(document.entries)) throw new Error('migration requires a schemaVersion 1 flat snapshot');
const migrated = compactSnapshot(document);
writeFileSync(file, serializeCompactSnapshot(document));
const results = migrated.cases.reduce((total, item) => total + Object.keys(item.results).length, 0);
process.stdout.write(`${document.entries.length} rows became ${migrated.cases.length} cases and ${results} case-hook results\n`);
