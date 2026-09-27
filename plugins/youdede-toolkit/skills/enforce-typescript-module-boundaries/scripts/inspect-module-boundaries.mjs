#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const rootIndex = args.indexOf('--root');
if (rootIndex < 0 || !args[rootIndex + 1]) {
  process.stderr.write('usage: inspect-module-boundaries.mjs --root <packages-root> [--tests-as-consumers]\n');
  process.exit(2);
}
const packagesRoot = path.resolve(args[rootIndex + 1]);
if (!existsSync(packagesRoot)) { process.stderr.write('packages root does not exist\n'); process.exit(2); }
const testsAsConsumers = args.includes('--tests-as-consumers');
const files = [];
function walk(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'build') continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(absolute);
    else if (/\.(?:[cm]?ts|tsx)$/.test(entry.name) && !/\.d\.ts$/.test(entry.name)) files.push(absolute);
  }
}
walk(packagesRoot);
const findings = [];
const unresolvedAliases = new Set();
const expression = /(?:import|export)\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]|require\(\s*['"]([^'"]+)['"]\s*\)|import\(\s*['"]([^'"]+)['"]\s*\)/g;
for (const file of files) {
  const sourceRelative = path.relative(packagesRoot, file).split(path.sep);
  const sourcePackage = sourceRelative[0];
  const sourceIsTest = sourceRelative.slice(1).some((part) => /^(?:tests?|__tests__)$/.test(part));
  const raw = readFileSync(file, 'utf8');
  for (const match of raw.matchAll(expression)) {
    const specifier = match[1] || match[2] || match[3];
    if (!specifier.startsWith('.')) { if (!specifier.startsWith('node:')) unresolvedAliases.add(specifier); continue; }
    const target = path.resolve(path.dirname(file), specifier);
    const relative = path.relative(packagesRoot, target);
    if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) continue;
    const targetParts = relative.split(path.sep);
    const targetPackage = targetParts[0];
    // A package's own root index (`<pkg>` or `<pkg>/index`) is its entry point; any other path inside it is deep.
    const targetIsDeep = targetParts.length > 2 || (targetParts.length === 2 && !/^index(?:\.[cm]?[jt]sx?)?$/.test(targetParts[1]));
    const crossPackage = targetPackage !== sourcePackage;
    const testPrivateAccess = testsAsConsumers && sourceIsTest && targetPackage === sourcePackage && targetIsDeep;
    if ((crossPackage && targetIsDeep) || testPrivateAccess) findings.push({ file: path.relative(process.cwd(), file), specifier, sourcePackage, targetPackage, reason: crossPackage ? 'cross-package-deep-import' : 'test-private-import' });
  }
}
process.stdout.write(JSON.stringify({ valid: findings.length === 0, packagesRoot, filesScanned: files.length, findings, unresolvedAliases: [...unresolvedAliases].sort() }, null, 2) + '\n');
if (findings.length) process.exit(1);
