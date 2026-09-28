import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { confirmRemoval, decidePrerequisites, parseAnswer, skippedNotice, suggestionHint } from '../scripts/lib/prerequisite-consent.mjs';
import { installArtifact, installedDependentsOf, prerequisiteBlocker, removeArtifact, suggestionsFor } from '../scripts/lib/install.mjs';

// The three link levels at install time. Required (`relationships.prerequisites`): asked once, default
// yes, before installing the missing ones. Suggested (`relationships.suggests`): never asked, one hint
// line after the install. Related (`composesWith`): nothing. Every text comes from the links' reasons.
// The decisions are tested in process with a scripted `ask`; the CLI is tested as a process, which is
// not interactive (its standard input is a pipe), and through a pseudo-terminal where python3 is
// available.

const recorder = (answers) => {
  const asked = [];
  const lines = [];
  return {
    asked, lines, write: (line) => lines.push(line),
    ask: async (question, defaultYes) => { asked.push({ question, defaultYes }); return answers.shift(); }
  };
};
const SHELL_REASON = 'commit-guard cannot see hidden commands (e.g. bash -c "$X"): shell-command-guard stops them.';
const COMMIT = { subject: 'commit-guard', prerequisites: [{ slug: 'shell-command-guard', reason: SHELL_REASON }] };
const TWO = [{ slug: 'a-guard', reason: 'x-guard needs a-guard to read A.' }, { slug: 'b-context', reason: 'x-guard stops without the b-context file.' }];

test('an interactive install asks once with the reasons, default yes', async () => {
  const yes = recorder([true]);
  assert.equal(await decidePrerequisites({ ...COMMIT, interactive: true, skip: false, ask: yes.ask, write: yes.write }), true);
  assert.deepEqual(yes.asked, [{ question: `${SHELL_REASON}\nInstall it too? [Y/n] `, defaultYes: true }]);
  assert.deepEqual(yes.lines, []);

  const no = recorder([false]);
  assert.equal(await decidePrerequisites({ ...COMMIT, interactive: true, skip: false, ask: no.ask, write: no.write }), false);

  // Several prerequisites: one reason line each, one question.
  const several = recorder([true]);
  await decidePrerequisites({ subject: 'x-guard', prerequisites: TWO, interactive: true, skip: false, ask: several.ask, write: several.write });
  assert.deepEqual(several.asked.map(({ question }) => question), ['x-guard needs a-guard to read A.\nx-guard stops without the b-context file.\nInstall them too? [Y/n] ']);
});

test('a non-interactive install notifies and installs; --no-prerequisites skips without asking', async () => {
  const quiet = recorder([]);
  assert.equal(await decidePrerequisites({ ...COMMIT, interactive: false, skip: false, ask: quiet.ask, write: quiet.write }), true);
  assert.equal(quiet.asked.length, 0);
  assert.deepEqual(quiet.lines, [SHELL_REASON, 'Installing it too; pass --no-prerequisites to skip.']);
  const plural = recorder([]);
  await decidePrerequisites({ subject: 'x-guard', prerequisites: TWO, interactive: false, skip: false, ask: plural.ask, write: plural.write });
  assert.equal(plural.lines.at(-1), 'Installing them too; pass --no-prerequisites to skip.');
  for (const interactive of [true, false]) {
    const skipped = recorder([]);
    assert.equal(await decidePrerequisites({ ...COMMIT, interactive, skip: true, ask: skipped.ask, write: skipped.write }), false);
    assert.equal(skipped.asked.length + skipped.lines.length, 0);
  }
  const none = recorder([]);
  assert.equal(await decidePrerequisites({ subject: 'shell-command-guard', prerequisites: [], interactive: true, skip: false, ask: none.ask, write: none.write }), true);
  assert.equal(none.asked.length, 0);
});

test('the skipped notice gives the reason unless just asked, and one working add command each, in the plural', () => {
  assert.equal(skippedNotice('commit-guard', COMMIT.prerequisites),
    `${SHELL_REASON}\nInstalled commit-guard without shell-command-guard. Add it later: youdede-toolkit add shell-command-guard`);
  assert.equal(skippedNotice('commit-guard', COMMIT.prerequisites, { asked: true }),
    'Installed commit-guard without shell-command-guard. Add it later: youdede-toolkit add shell-command-guard');
  assert.equal(skippedNotice('the x pack', TWO, { asked: true }), [
    'Installed the x pack without a-guard, b-context. Add them later:',
    '  youdede-toolkit add a-guard',
    '  youdede-toolkit add b-context'
  ].join('\n'));
  // Each printed command is one the CLI accepts: `add` takes a single artifact.
  for (const line of skippedNotice('the x pack', TWO, { asked: true }).split('\n').slice(1)) assert.match(line, /^ {2}youdede-toolkit add [a-z-]+$/);
});

test('suggestions become one hint line', () => {
  assert.equal(suggestionHint([]), null);
  assert.equal(suggestionHint([{ slug: 'mcp-egress-guard', reason: 'for extra MCP checks' }]), 'Tip: add mcp-egress-guard for extra MCP checks.');
  assert.equal(suggestionHint([{ slug: 'a', reason: 'to do A' }, { slug: 'b', reason: 'to do B' }]), 'Tip: add a to do A; add b to do B.');
});

test('removing a prerequisite others require asks in a terminal, default no, and refuses elsewhere', async () => {
  const confirm = recorder([true]);
  assert.equal(await confirmRemoval({ prerequisite: 'shell-command-guard', dependents: [{ slug: 'commit-guard', reason: SHELL_REASON }], interactive: true, ask: confirm.ask }), true);
  assert.deepEqual(confirm.asked, [{ question: `${SHELL_REASON}\nRemove it anyway? [y/N] `, defaultYes: false }]);
  const decline = recorder([false]);
  assert.equal(await confirmRemoval({ prerequisite: 'shell-command-guard', dependents: [{ slug: 'commit-guard', reason: SHELL_REASON }, { slug: 'outbound-data-guard', reason: 'r.' }], interactive: true, ask: decline.ask }), false);
  assert.equal(decline.asked[0].question, 'commit-guard, outbound-data-guard require shell-command-guard.\nRemove it anyway? [y/N] ');
  const refuse = recorder([]);
  assert.equal(await confirmRemoval({ prerequisite: 'shell-command-guard', dependents: [{ slug: 'commit-guard', reason: SHELL_REASON }], interactive: false, ask: refuse.ask }), false);
  assert.equal(refuse.asked.length, 0);
  assert.equal(await confirmRemoval({ prerequisite: 'shell-command-guard', dependents: [], interactive: true, ask: refuse.ask }), true);
});

test('terminal answers: empty is the default, y/yes and n/no in any case, anything else asks again', () => {
  for (const [answer, defaultYes, expected] of [['', true, true], ['  ', false, false], ['Y', false, true], ['yes', false, true], ['N', true, false], ['No', true, false], ['maybe', true, null], [undefined, true, true]]) {
    assert.equal(parseAnswer(answer, defaultYes), expected, JSON.stringify(answer));
  }
});

test('the installer installs a hook alone on request and removes a required prerequisite only when confirmed', (context) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'youdede-consent-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const hooks = path.join(directory, '.claude', 'hooks', 'youdede');
  const alone = installArtifact('commit-guard', { cwd: directory, prerequisites: false });
  assert.deepEqual(alone.prerequisites, []);
  assert.deepEqual(alone.skippedPrerequisites.map((manifest) => manifest.slug), ['shell-command-guard']);
  assert.equal(existsSync(path.join(hooks, 'shell-command-guard.mjs')), false);
  removeArtifact('commit-guard', { cwd: directory });

  const both = installArtifact('commit-guard', { cwd: directory });
  assert.deepEqual(both.prerequisites.map((manifest) => manifest.slug), ['shell-command-guard']);
  assert.deepEqual(installedDependentsOf('shell-command-guard', { cwd: directory }), [{ slug: 'commit-guard', reason: SHELL_REASON }]);
  assert.throws(() => removeArtifact('shell-command-guard', { cwd: directory }), { message: 'shell-command-guard is needed by commit-guard. Remove commit-guard first, or use --force.' });
  removeArtifact('shell-command-guard', { cwd: directory, confirmedDependents: true });
  assert.equal(existsSync(path.join(hooks, 'shell-command-guard.mjs')), false);
  // The dependency is declared, so commit-guard still names it.
  assert.deepEqual(installedDependentsOf('shell-command-guard', { cwd: directory }).map(({ slug }) => slug), ['commit-guard']);
  removeArtifact('commit-guard', { cwd: directory });
});

test('a command installs its required context, whose rules file its precondition then finds', (context) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'youdede-consent-context-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  // draft-evidenced-plan supports only claude-code project scope, like coding-style-baseline.
  const installed = installArtifact('draft-evidenced-plan', { cwd: directory });
  assert.deepEqual(installed.prerequisites.map((manifest) => manifest.slug), ['coding-style-baseline']);
  assert.ok(existsSync(path.join(directory, '.claude', 'rules', 'youdede', '0100-coding-style-baseline.md')));
  const check = spawnSync(process.execPath, [path.join(directory, '.claude', 'commands', 'youdede', 'draft-evidenced-plan', 'check-preconditions.mjs')], { cwd: directory, encoding: 'utf8' });
  assert.equal(check.status, 0, check.stdout + check.stderr);
  assert.throws(() => removeArtifact('coding-style-baseline', { cwd: directory }), { message: 'coding-style-baseline is needed by draft-evidenced-plan. Remove draft-evidenced-plan first, or use --force.' });
});

test('a prerequisite the installer cannot add with its dependent stops the install with the manual step', () => {
  const record = (slug, kind, adapters = {}) => ({ manifest: { slug, kind }, adapters });
  // Codex keeps hooks in .codex and skills in .agents.
  const skill = record('b-skill', 'skill', { codex: { data: { scopes: ['project'] } } });
  assert.equal(prerequisiteBlocker(record('a-guard', 'hook'), [skill], 'codex', 'project', '/tmp/p'),
    'a-guard needs b-skill, which codex keeps in another directory: install it yourself first (youdede-toolkit add b-skill --target codex --scope project), then add a-guard again');
  assert.match(prerequisiteBlocker(record('a-guard', 'hook'), [record('c', 'hook')], 'codex', 'project', '/tmp/p'), /^a-guard needs c, which does not support codex project scope/);
  assert.equal(prerequisiteBlocker(record('a', 'command'), [record('b', 'context', { 'claude-code': { data: { scopes: ['project'] } } })], 'claude-code', 'project', '/tmp/p'), null);
});

test('suggestions skip what is installed, what the pack includes, and what the target lacks', (context) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'youdede-consent-suggest-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const egress = { id: 'hook/security/network-control/mcp-egress-guard', slug: 'mcp-egress-guard', reason: 'to check browser tool arguments against declared egress (not page requests)' };
  const server = 'mcp-server/development/testing/playwright-local-isolated';
  assert.deepEqual(suggestionsFor([server], { cwd: directory }), [egress]);
  assert.deepEqual(suggestionsFor([server], { cwd: directory, exclude: [egress.id] }), []);
  // migration-safety-guard exists only for claude-code; the two review skills also for cursor.
  const baseline = 'context/data/migrations/database-migration-baseline';
  assert.deepEqual(suggestionsFor([baseline], { cwd: directory }).map(({ slug }) => slug), ['migration-safety-guard', 'review-database-migration-plan', 'review-schema-evolution']);
  assert.deepEqual(suggestionsFor([baseline], { cwd: directory, target: 'cursor' }).map(({ slug }) => slug), ['review-database-migration-plan', 'review-schema-evolution']);
  installArtifact('mcp-egress-guard', { cwd: directory });
  assert.deepEqual(suggestionsFor([server], { cwd: directory }), []);
  // A suggested companion never blocks a removal.
  installArtifact('playwright-local-isolated', { cwd: directory });
  removeArtifact('mcp-egress-guard', { cwd: directory });
  removeArtifact('playwright-local-isolated', { cwd: directory });
});

const CLI = path.resolve('bin/youdede-toolkit.mjs');
test('the CLI without a terminal installs the prerequisite with a notice, skips it on --no-prerequisites, and refuses the removal', (context) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'youdede-consent-cli-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const hooks = path.join(directory, '.claude', 'hooks', 'youdede');
  const cli = (...args) => spawnSync(process.execPath, [CLI, ...args, '--cwd', directory], { encoding: 'utf8', input: '' });

  const flagged = cli('add', 'outbound-data-guard', '--no-prerequisites');
  assert.equal(flagged.status, 0, flagged.stderr);
  assert.match(flagged.stdout, /^Installed hook\/security\/application-security\/outbound-data-guard in .*\noutbound-data-guard cannot see hidden commands \(e\.g\. bash -c "\$X"\): shell-command-guard stops them\.\nInstalled outbound-data-guard without shell-command-guard\. Add it later: youdede-toolkit add shell-command-guard\n/);
  assert.equal(existsSync(path.join(hooks, 'shell-command-guard.mjs')), false);
  assert.match(cli('add', 'commit-guard', '--no-prerequisites', '--dry-run').stdout, /^Would skip prerequisite hook\/security\/application-security\/shell-command-guard\n/);

  const added = cli('add', 'commit-guard');
  assert.equal(added.status, 0, added.stderr);
  assert.match(added.stdout, /^commit-guard cannot see hidden commands \(e\.g\. bash -c "\$X"\): shell-command-guard stops them\.\nInstalling it too; pass --no-prerequisites to skip\.\nInstalled prerequisite shell-command-guard\./);
  assert.doesNotMatch(added.stdout, /Tip:/);
  assert.ok(existsSync(path.join(hooks, 'shell-command-guard.mjs')));

  const refused = cli('remove', 'shell-command-guard');
  assert.equal(refused.status, 1);
  // outbound-data-guard, installed alone above, requires it too.
  assert.equal(refused.stderr, 'shell-command-guard is needed by outbound-data-guard, commit-guard. Remove them first, or use --force.\n');
  assert.ok(existsSync(path.join(hooks, 'shell-command-guard.mjs')));
  const forced = cli('remove', 'shell-command-guard', '--force');
  assert.equal(forced.status, 0, forced.stderr);
  assert.equal(existsSync(path.join(hooks, 'shell-command-guard.mjs')), false);
});

test('each add command of a several-prerequisite notice runs', (context) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'youdede-consent-notice-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const lines = skippedNotice('the x pack', [{ slug: 'shell-command-guard', reason: null }, { slug: 'commit-guard', reason: null }], { asked: true }).split('\n').slice(1);
  assert.equal(lines.length, 2);
  for (const line of lines) {
    const [, ...args] = line.trim().split(' ');
    const ran = spawnSync(process.execPath, [CLI, ...args, '--dry-run', '--no-prerequisites', '--cwd', directory], { encoding: 'utf8', input: '' });
    assert.equal(ran.status, 0, `${line}: ${ran.stderr}`);
  }
});

test('the CLI prints one hint line for suggestions, nothing for what the pack includes or is installed', (context) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'youdede-consent-hint-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const cli = (...args) => spawnSync(process.execPath, [CLI, ...args, '--cwd', directory], { encoding: 'utf8', input: '' });
  const tips = (output) => output.split('\n').filter((line) => line.startsWith('Tip:'));

  const server = cli('add', 'playwright-local-isolated');
  assert.equal(server.status, 0, server.stderr);
  assert.deepEqual(tips(server.stdout), ['Tip: add mcp-egress-guard to check browser tool arguments against declared egress (not page requests).']);
  assert.equal(server.stdout.trimEnd().split('\n').at(-1), tips(server.stdout)[0]);
  assert.doesNotMatch(server.stdout, /\[Y\/n\]|Installing/);

  // remote-review-evidence contains github-readonly, which diagnose-ci-failure suggests; the only hint
  // left is mcp-egress-guard, once, which github-readonly suggests.
  const pack = cli('add-pack', 'remote-review-evidence');
  assert.equal(pack.status, 0, pack.stderr);
  assert.deepEqual(tips(pack.stdout), ["Tip: add mcp-egress-guard to check this server's MCP tool arguments against its declared egress."]);

  assert.equal(cli('add', 'mcp-egress-guard').status, 0);
  const again = cli('add', 'github-readonly', '--force');
  assert.equal(again.status, 0, again.stderr);
  assert.deepEqual(tips(again.stdout), []);
});

// A pseudo-terminal (Python's pty module) runs the CLI with TTY stdin and stdout; the answer is typed
// when the question appears.
const PTY = `
import os, pty, select, sys
answer = sys.stdin.read().encode()
pid, fd = pty.fork()
if pid == 0:
    os.execvp(sys.argv[1], sys.argv[1:])
out, sent = b'', False
while True:
    ready, _, _ = select.select([fd], [], [], 20)
    if not ready:
        break
    try:
        data = os.read(fd, 4096)
    except OSError:
        break
    if not data:
        break
    out += data
    if not sent and (b'[Y/n]' in out or b'[y/N]' in out):
        os.write(fd, answer)
        sent = True
_, status = os.waitpid(pid, 0)
sys.stdout.write(out.decode('utf8', 'replace'))
sys.exit(os.waitstatus_to_exitcode(status))
`;
const inTerminal = (args, answer) => spawnSync('python3', ['-c', PTY, process.execPath, CLI, ...args], { encoding: 'utf8', input: answer, timeout: 60_000 });
const hasPty = process.platform !== 'win32' && spawnSync('python3', ['-c', 'import pty'], { timeout: 10_000 }).status === 0;
const questions = (output) => output.split(/\[Y\/n\]|\[y\/N\]/).length - 1;

test('the CLI in a terminal asks once before installing and before removing a required prerequisite', { skip: !hasPty && 'no python3 pty module for a pseudo-terminal' }, (context) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'youdede-consent-tty-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const hooks = path.join(directory, '.claude', 'hooks', 'youdede');
  const has = (slug) => existsSync(path.join(hooks, `${slug}.mjs`));

  const declined = inTerminal(['add', 'commit-guard', '--cwd', directory], 'n\n');
  assert.equal(declined.status, 0, declined.stdout);
  assert.match(declined.stdout, /commit-guard cannot see hidden commands[^\n]*\r?\nInstall it too\? \[Y\/n\]/);
  assert.equal(questions(declined.stdout), 1);
  // The reason was just shown, so the notice only says how to add it later.
  assert.match(declined.stdout, /\nInstalled commit-guard without shell-command-guard\. Add it later: youdede-toolkit add shell-command-guard/);
  assert.equal(declined.stdout.split('cannot see hidden commands').length - 1, 1);
  assert.equal(has('commit-guard'), true);
  assert.equal(has('shell-command-guard'), false);

  const accepted = inTerminal(['add', 'outbound-data-guard', '--cwd', directory], '\n');
  assert.equal(accepted.status, 0, accepted.stdout);
  assert.match(accepted.stdout, /outbound-data-guard cannot see hidden commands \(e\.g\. bash -c "\$X"\): shell-command-guard stops them\./);
  assert.equal(questions(accepted.stdout), 1);
  assert.equal(has('shell-command-guard'), true);

  const kept = inTerminal(['remove', 'shell-command-guard', '--cwd', directory], '\n');
  assert.equal(kept.status, 0, kept.stdout);
  assert.match(kept.stdout, /commit-guard, outbound-data-guard require shell-command-guard\.\r?\nRemove it anyway\? \[y\/N\][\s\S]*Kept shell-command-guard\./);
  assert.equal(has('shell-command-guard'), true);

  const removed = inTerminal(['remove', 'shell-command-guard', '--cwd', directory], 'y\n');
  assert.equal(removed.status, 0, removed.stdout);
  assert.match(removed.stdout, /Removed hook\/security\/application-security\/shell-command-guard/);
  assert.equal(has('shell-command-guard'), false);

  // A command and its required context: one question, then the context installs first.
  const plan = inTerminal(['add', 'draft-evidenced-plan', '--cwd', directory], '\n');
  assert.equal(plan.status, 0, plan.stdout);
  assert.match(plan.stdout, /draft-evidenced-plan stops without the coding-style-baseline rules file\.\r?\nInstall it too\? \[Y\/n\][\s\S]*Installed prerequisite coding-style-baseline\./);
  assert.equal(questions(plan.stdout), 1);
});
