#!/usr/bin/env node

import { readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const MAX_INPUT_BYTES = 64 * 1024 * 1024;

function decodeEntities(value) {
  const named = { amp: '&', apos: "'", gt: '>', lt: '<', quot: '"', nbsp: ' ' };
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity) => {
    if (entity[0] !== '#') return named[entity.toLowerCase()] ?? match;
    const hexadecimal = entity[1]?.toLowerCase() === 'x';
    const codePoint = Number.parseInt(entity.slice(hexadecimal ? 2 : 1), hexadecimal ? 16 : 10);
    try { return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : match; } catch { return match; }
  });
}

function clean(value) {
  return decodeEntities(value).replace(/\s+/g, ' ').trim();
}

function overlap(left, right) {
  const maximum = Math.min(left.length, right.length);
  for (let size = maximum; size > 0; size -= 1) {
    const tail = left.slice(-size).map((token) => token.toLowerCase());
    const head = right.slice(0, size).map((token) => token.toLowerCase());
    if (tail.every((token, index) => token === head[index])) return size;
  }
  return 0;
}

export function normalizeJson3(data) {
  if (!data || !Array.isArray(data.events)) throw new Error('json3 input requires an events array');
  const output = [];
  for (const event of data.events) {
    if (!Array.isArray(event?.segs)) continue;
    const chunk = clean(event.segs.map((segment) => typeof segment?.utf8 === 'string' ? segment.utf8 : '').join(''));
    if (!chunk) continue;
    const words = chunk.split(' ');
    output.push(...words.slice(overlap(output, words)));
  }
  return clean(output.join(' '));
}

export function normalizeFile(file) {
  const absolute = path.resolve(file);
  const size = statSync(absolute).size;
  if (size > MAX_INPUT_BYTES) throw new Error(`input is ${size} bytes; limit is ${MAX_INPUT_BYTES}`);
  return normalizeJson3(JSON.parse(readFileSync(absolute, 'utf8')));
}

function main() {
  const file = process.argv[2];
  if (!file || process.argv.length !== 3) throw new Error('usage: normalize-json3.mjs <captions.json3>');
  process.stdout.write(`${normalizeFile(file)}\n`);
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  try { main(); } catch (error) {
    process.stderr.write(`normalize-json3: ${error.message}\n`);
    process.exitCode = 1;
  }
}
