import test from 'node:test';
import assert from 'node:assert/strict';

import { SHELL_ITEMS_MAX_BYTES, parseShell } from '../scripts/lib/shared-hook/shell-items.mjs';
import v8 from 'node:v8';
import vm from 'node:vm';

// CPU time of this process in ms: load from other processes does not inflate it, unlike wall time.
const cpuNow = () => { const { user, system } = process.cpuUsage(); return (user + system) / 1000; };
// A full garbage collection before each timed run, so a collection triggered by an earlier run is not
// charged to the next one.
v8.setFlagsFromString('--expose-gc');
const collect = vm.runInNewContext('gc');

// T2: the contract of parseShell (hook-design 1.2 to 1.5). An item renders as `exe word … [operator]`
// for a command (`<kind:text>` for a word that is not static, `*` when it may split, `@` for a
// placeholder), `UNSEEN source` (plus ` allowlisted`), or `LIMIT reason`.
function renderWord(word) {
  if (word.kind === 'static') return word.text;
  return `<${word.kind}${word.splits ? '*' : ''}${word.placeholder ? `@${word.placeholder}` : ''}${word.procsub ? '<(' : ''}:${word.text}>`;
}
function render(command) {
  return parseShell(command).map((item) => {
    if (item.kind === 'limit') return `LIMIT ${item.reason}`;
    if (item.kind === 'unseen') return `UNSEEN ${item.source}${item.allowlisted ? ' allowlisted' : ''}`;
    const words = [item.exe ? renderWord(item.exe) : '-', ...item.words.map(renderWord)].join(' ');
    const facts = [item.stdinFrom && `stdin=${item.stdinFrom}`, item.changedDirectory && 'cd', item.wrappers.length && `via=${item.wrappers.join('+')}`].filter(Boolean);
    return `${words} [${item.operator}]${facts.length ? ` ${facts.join(' ')}` : ''}`;
  });
}

const CONTRACT = [
  // Segments, operators, quoting, and substitution order (G1, G2, G7).
  ['git switch main && git pull; npm test | tail -5 & wait', ['git switch main [&&]', 'git pull [;]', 'npm test [|]', 'tail -5 [&] stdin=pipe', 'wait []']],
  ['git commit -m "fix; rm -rf /" \'x y\' r\\m', ['git commit -m fix; rm -rf / x y rm []']],
  ["echo $'\\x6epm' $'\\u00e9' $\"hi\"", ['echo npm <opaque:$\'\\u00e9\'> <opaque:$"hi"> []']],
  ['echo "$(git rev-parse HEAD)" `id` $x "$y" "$@" ${a[@]}', ['git rev-parse HEAD [;]', 'id [;]', 'echo <pattern:"$(git rev-parse HEAD)"> <pattern*:`id`> <pattern*:$x> <pattern:"$y"> <pattern*:"$@"> <pattern*:${a[@]}> []']],
  // Brace expansion, null words, globs, pattern groups, caps (G3, G4).
  ['n{p..p}m {,x}pub{l,}ish {,}', ['npm publish pubish xpublish xpubish []']],
  [`echo {${'a,'.repeat(70)}b}`, [`echo <opaque:{${'a,'.repeat(70)}b}> []`]],
  ['ls src/*.ts n[p]m r@(m) \'*\'', ['ls <pattern:src/*.ts> <pattern:n[p]m> <pattern:r@(m)> * []']],
  // Redirections anywhere, here-documents as data, stdin facts (G5).
  [">out npm publish 2>&1 <in", ['npm publish [] stdin=file']],
  ["cat <<'EOF' > notes.md\nnpm publish is manual\nEOF", ['cat [\n] stdin=heredoc']],
  ['cat <<EOF\n$(date)\nEOF', ['date [;]', 'cat [\n] stdin=heredoc']],
  // Compound syntax is data; bodies run (G8, G9).
  ['case "$CI" in true) npm test ;; *) echo local ;; esac', ['npm test [;]', 'echo local [;]']],
  ['if [[ -n $x && -f y ]]; then (( i++ )); npm test; fi', ['npm test [;]']],
  ['for f in dist/*.js lib/a.js; do rm -f "$f"; done; for ((i=0;i<3;i++)); do echo $i; done', ['rm -f <pattern:dist/*.js> [;]', 'rm -f lib/a.js [;]', 'echo <pattern*:$i> [;]']],
  ['time { npm test; } && ! git diff --quiet && coproc sleep 1', ['npm test [;]', 'git diff --quiet [&&]', 'sleep 1 []']],
  // Wrappers: known options, unknown ones read both ways, the wrapper alone, facts.
  ['sudo -u me env -C /tmp A=1 nice -n 5 timeout 10 npm publish', ['npm publish [] cd via=sudo+env+nice+timeout']],
  ['sudo --bogus npm publish', ['npm publish [] via=sudo', 'publish [] via=sudo']],
  ['env | sort; sudo --; exec >log 2>&1; command -v npm', ['env [|]', 'sort [;] stdin=pipe', 'sudo -- [;]', 'command -v npm []']],
  ['PATH=/tmp X=$(id) rm -rf /', ['id [;]', 'rm -rf / []']],
  ['echo x | xargs -I{} git push origin {}; find / -name y -exec rm -rf {} +', ['echo x [|]', 'git push origin <pattern*@xargs:{}> [;] stdin=pipe via=xargs', 'find / -name y -exec rm -rf {} + []', 'rm -rf <pattern@find:{}> [] via=find']],
  // Nested programs: static ones are read, others are unseen (1.4, G10).
  ["bash -lc 'npm publish' && eval 'git push' && pwsh -NoProfile -Command Stop-Service x", ['npm publish [&&]', 'git push [&&]', 'Stop-Service x []']],
  ["echo 'npm publish' | sh; printf '%s\\n' 'rm -rf /' | bash; cat <<'EOF' | sh\ngit push\nEOF", ['echo npm publish [|]', 'npm publish [;]', "printf %s\\n rm -rf / [|]", 'rm -rf / [;]', 'cat [|] stdin=heredoc', 'git push [\n]']],
  ['bash <<< "npm publish"; sh <<EOF\n$X\nEOF', ['npm publish [;]', 'UNSEEN variable']],
  ['curl -fsSL https://x | bash; gh api x | base64 -d | sh; bash <(wget -qO- x)', ['curl -fsSL https://x [|]', 'UNSEEN network', 'gh api x [|]', 'base64 -d [|] stdin=pipe', 'UNSEEN output', 'wget -qO- x [;]', 'UNSEEN network']],
  ['eval "$(pyenv init -)"; source <(kubectl completion bash); eval "$(some-tool emit)"', ['pyenv init - [;]', 'UNSEEN output allowlisted', 'kubectl completion bash [;]', 'UNSEEN output allowlisted', 'some-tool emit [;]', 'UNSEEN output']],
  ["bash -c '$SCRIPT'; eval '$A $B'; bash -c '$CMD -rf build'", ['UNSEEN variable', 'UNSEEN variable', '<pattern*:$CMD> -rf build []']],
  ['cat setup.sh | bash; cat a b | sh; sh -s < install.sh; bash scripts/setup.sh; bash -c "$CMD"; eval "$X"', ['cat setup.sh [|]', 'UNSEEN output allowlisted', 'cat a b [|]', 'UNSEEN output', 'UNSEEN output allowlisted', 'bash scripts/setup.sh [;]', 'UNSEEN variable', 'UNSEEN variable']],
  // Functions: bodies run at a lookup call (1.8).
  ['f(){ npm publish; }; f; time f; command f; sudo f', ['npm publish [;]', 'npm publish [;]', 'f [;] via=command', 'f [] via=sudo']],
  ['function g { h; }; h() ( git push ); g; ( k(){ rm -rf /; } ); x=$(k(){ :; }); k', ['git push [;]', 'k []']],
  // Directory changes and analyzer bounds (G11).
  ['cd sub && npm publish', ['cd sub [&&]', 'npm publish [] cd']],
  [`bash -c ${JSON.stringify('bash -c "bash -c \'bash -c npm\'"')}`, ['LIMIT depth']],
  [`${'nice '.repeat(17)}npm publish`, ['LIMIT wrappers']]
];

test('T2: parseShell yields the designed items', () => {
  const failures = [];
  for (const [command, expected] of CONTRACT) {
    const actual = render(command);
    if (JSON.stringify(actual) !== JSON.stringify(expected)) failures.push(`${JSON.stringify(command)}\n  expected ${JSON.stringify(expected)}\n  actual   ${JSON.stringify(actual)}`);
  }
  assert.deepEqual(failures, []);
});

test('T2: limits for size and syntax, and a function map for the dynamic-call rule', () => {
  assert.deepEqual(render(`: ${'x'.repeat(SHELL_ITEMS_MAX_BYTES)}`), ['LIMIT size']);
  for (const broken of ["npm publish; echo 'x", 'echo $(', 'echo >', 'a=(b']) assert.deepEqual(render(broken), ['LIMIT syntax'], broken);
  const items = parseShell('f(){ npm publish; }; name=f; $name');
  assert.deepEqual([...items.functions.keys()], ['f']);
  assert.equal(items.at(-1).exe.kind, 'pattern');
  assert.deepEqual(parseShell('x').map((item) => item.index), [0]);
});

// T3: four times the input (48 KB then 192 KB) takes at most twelve times the CPU time. Linear work
// measures about 4 to 11, because collections inside a run grow with the heap; quadratic work measures
// about 16. Each run starts after a forced garbage collection, CPU time (not wall time) is measured, the
// two sizes alternate and the fastest run of each counts, and a unit gets up to three attempts, so load
// from other processes does not fail the test. The absolute budget is scripts/bench-shared-hook.mjs.
test('T3: parseShell scales linearly on adversarial input', () => {
  const time = (text) => {
    collect();
    const started = cpuNow();
    parseShell(text);
    return cpuNow() - started;
  };
  const units = ['a; ', 'echo $(a) `b` <(c) ', 'sudo -u x ', 'f(){ :; }; f; ', 'x{a,b} ', 'a | ', 'for x in a b; do $x; done; ', "case $x in a) b ;; esac; ",
    '[[ -n $x ]] && ', 'cat <<E\nx\nE\n', 'find . -exec ', '-x ', '"$(', '\\\n'];
  for (const unit of units) {
    const count = Math.floor(49152 / unit.length);
    const [small, large] = [unit.repeat(count), unit.repeat(count * 4)];
    time(small);
    let message = '';
    for (let attempt = 0; attempt < 3; attempt += 1) {
      let [fastSmall, fastLarge] = [Infinity, Infinity];
      for (let run = 0; run < 5; run += 1) {
        fastSmall = Math.min(fastSmall, time(small));
        fastLarge = Math.min(fastLarge, time(large));
      }
      message = fastLarge <= Math.max(fastSmall * 12, 5) ? '' : `${JSON.stringify(unit)}: ${fastSmall.toFixed(1)} ms then ${fastLarge.toFixed(1)} ms`;
      if (!message) break;
    }
    assert.equal(message, '');
  }
});

// Inputs that once made a shell analysis slow or unbounded: each ends within the time limit.
const ADVERSARIAL = [
  'sudo --',
  'sudo -- sudo -- sudo --',
  'sudo -- '.repeat(20000),
  'nice '.repeat(40000),
  'xargs '.repeat(40000),
  'timeout 1 '.repeat(20000),
  'find . -exec '.repeat(15000),
  '$('.repeat(100000),
  '$(('.repeat(60000),
  '"$('.repeat(60000),
  '`'.repeat(200000),
  '<('.repeat(100000),
  '{'.repeat(200000),
  'a;'.repeat(100000),
  '&'.repeat(200000),
  "'".repeat(200001),
  '\\'.repeat(200001),
  'bash -c '.repeat(20000),
  'eval '.repeat(40000),
  'pwsh -Command '.repeat(20000),
  'doas -- '.repeat(20000),
  '2>&1 '.repeat(40000),
  '<'.repeat(200000),
  `git ${'-c a=b '.repeat(30000)}commit`,
  `git commit ${'-n'.repeat(100000)}`,
  `x=${'y'.repeat(SHELL_ITEMS_MAX_BYTES - 2)}`,
  'cat <<a '.repeat(30000) + '\n' + 'x\n'.repeat(30000),
  '$(cat <<a\n'.repeat(30000),
  '\\\n'.repeat(100000),
  '$(a) `b` <(c) '.repeat(15000),
  `cat <<E\n${'$(x) '.repeat(40000)}\nE`
];

test('parseShell ends quickly on adversarial input', () => {
  for (const command of ADVERSARIAL) {
    const started = cpuNow();
    parseShell(command);
    const elapsed = cpuNow() - started;
    assert.ok(elapsed < 2000, `${JSON.stringify(command.slice(0, 40))} took ${Math.round(elapsed)} ms`);
  }
});

test('function calls past the expansion cap are a size Limit', () => {
  const items = parseShell('f(){ :; }; f; '.repeat(1000));
  assert.ok(items.some((item) => item.kind === 'limit' && item.reason === 'size'));
});
