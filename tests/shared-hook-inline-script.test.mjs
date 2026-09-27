import test from 'node:test';
import assert from 'node:assert/strict';

import { parseShellCommands } from '../scripts/lib/shared-hook/shell.mjs';
import { inlineProgram, inlineShellCommands } from '../scripts/lib/shared-hook/inline-script.mjs';

// Probes for the shared `inline-script` block: shell commands written inside interpreter one-liners.
// Each command renders as its tokens; the probes cover every interpreter the module knows.
function render(command) {
  return parseShellCommands(command).commands.flatMap((entry) => inlineShellCommands(entry))
    .map((entry) => (entry.ambiguous ? 'AMBIGUOUS' : entry.tokens.map((token) => token.value).join(' ')));
}

const PROBES = [
  ['python3 -c "import os; os.system(\'aws ec2 terminate-instances --instance-ids i-1\')"', ['aws ec2 terminate-instances --instance-ids i-1']],
  ['python -uc "import subprocess; subprocess.run(\'npm publish\', shell=True)"', ['npm publish']],
  ['node -e "require(\'child_process\').execSync(\'npm publish\')"', ['child_process', 'npm publish', 'AMBIGUOUS']],
  ['ruby -e \'system("crontab -r")\'', ['crontab -r']],
  ['perl -e \'system("systemctl restart nginx")\'', ['systemctl restart nginx']],
  ['php -r \'exec("docker push reg.io/app:1");\'', ['docker push reg.io/app:1', 'AMBIGUOUS']],
  ['deno eval "Deno.run({cmd: [\'ls\']})"', ['ls']],
  // The shell block unwraps PowerShell itself, so its payload is an ordinary command, not an inline one.
  ["pwsh -c 'Restart-Service spooler'", []],
  ['powershell -Command Stop-Service spooler', []],
  ['cmd /c "sc stop spooler"', ['sc stop spooler']],
  // Attached program options run the program too (PR38-CODEX-1).
  ['python3 -c"import os; os.system(\'npm publish\')"', ['npm publish']],
  ['python3 -Ic"import subprocess; subprocess.run(\'npm publish\', shell=True)"', ['npm publish']],
  ['node --eval="require(\'child_process\').execSync(\'npm publish\')"', ['child_process', 'npm publish', 'AMBIGUOUS']],
  ['node -e"require(\'child_process\').execSync(\'npm publish\')"', ['child_process', 'npm publish', 'AMBIGUOUS']],
  ['bun --print=\'Bun.spawnSync(["sh", "-c", "npm publish"])\'', ['AMBIGUOUS', '-c', 'npm publish']],
  ['ruby -e"system(\'npm publish\')"', ['npm publish']],
  ['ruby -we \'%x(npm publish)\'', ['npm publish']],
  ['perl -e"system(\'npm publish\')"', ['npm publish']],
  ['perl -lnE\'qx{npm publish}\'', ['npm publish']],
  ['perl -e 1 -e \'system("npm publish")\'', ['npm publish']],
  ['php -r"exec(\'npm publish\');"', ['npm publish', 'AMBIGUOUS']],
  ['deno repl --eval="Deno.run({cmd: [\'ls\']})"', ['ls']],
  ['cmd /c"sc stop spooler"', ['sc stop spooler']],
  // Without a call that runs commands, the literals are data (PR38-CODEX-4).
  ['sudo python3 -c "print(\'x\')"', []],
  ['python3 -c "print(\'npm publish\')"', []],
  ['node -e "console.log(\'systemctl restart nginx\')"', []],
  ['perl -e \'print "crontab -r"\'', []],
  // Static Ruby and Perl literals with their own delimiters (PR38-CODEX2-1).
  ["ruby -e 'system %q{npm publish}'", ['npm publish']],
  ["ruby -e 'system %Q<npm publish>'", ['npm publish']],
  ["ruby -e 'system %{npm {x} publish}'", ['npm {x} publish']],
  ["ruby -e 'system %(npm publish)'", ['npm publish']],
  ["perl -e 'system q{npm publish}'", ['npm publish']],
  ["perl -e 'system qq(npm publish)'", ['npm publish']],
  ["perl -e 'system q!npm publish!'", ['npm publish']],
  ["perl -e '$q = 1; system(\"npm publish\")'", ['npm publish']],
  ["ruby -e 'puts %q{hello}'", []],
  // The call check reads code only: a call name inside a literal or a comment is data (PR38-CODEX2-2).
  ['python3 -c "print(\'system\', \'npm publish\')"', []],
  ['python3 -c "print(\'system\')"', []],
  ['python3 -c "print(\'x\')  # os.system(\'npm publish\')"', []],
  ["ruby -e 'puts \"#{system(%q{npm publish})}\"'", ['#{system', '%q{npm publish}', 'npm publish']],
  ['python3 -c "import os; getattr(os, \'system\')(\'npm publish\')"', ['system', 'npm publish', 'AMBIGUOUS']],
  ["ruby -e '`npm publish`'", ['npm publish']],
  ["perl -e 'print qx{npm publish}'", ['npm publish']],
  // Design PR38-CODEX3: without a capable name the literals are data; with one they are commands, and a
  // program the reader cannot follow (literal bound, heredoc, deep interpolation, dynamic name) is ambiguous.
  ['python3 -c "import subprocess; print(\'npm publish\')"', ['npm publish']],
  ['node -e "console.log(/execSync\\(\'npm publish\'\\)/.test(\'x\'))"', []],
  ['python3 -c "import json; print(json.dumps({\'a\': 1}))"', []],
  ['python3 -c "import os; getattr((os), \'system\')(\'npm publish\')"', ['system', 'npm publish', 'AMBIGUOUS']],
  ['ruby -e "system <<~CMD\nnpm publish\nCMD\n"', ['AMBIGUOUS']],
  ['perl -e \'system <<"CMD";\nnpm publish\nCMD\n\'', ['CMD', 'AMBIGUOUS']],
  [`python3 -c '${'"x";'.repeat(256)}import os; os.system("npm publish")'`, [...Array(256).fill('x'), 'AMBIGUOUS']],
  [`python3 -c '${'"x";'.repeat(256)}print(1)'`, []],
  ['python3 script.py', []],
  ['node --version', []],
  ['python3 -c', []],
  ['echo "python3 -c \'rm -rf /\'"', []]
];

test('inline-script finds shell commands in interpreter one-liners', () => {
  for (const [command, expected] of PROBES) assert.deepEqual(render(command).sort(), [...expected].sort(), command);
  const [entry] = parseShellCommands('python3 -c "$CODE"').commands;
  assert.equal(inlineProgram(entry).dynamic, true);
  // A program known only at run time is ambiguous, attached or supplied by xargs.
  for (const command of ['python3 -c "$CODE"', 'node --eval="$CODE"', 'printf x | xargs python3 -c']) {
    assert.deepEqual(parseShellCommands(command).commands.flatMap((item) => inlineShellCommands(item)).map((item) => item.ambiguous), [true], command);
  }
  assert.equal(inlineProgram(parseShellCommands('ls -c x').commands[0]), null);
});

test('inline-script ends quickly on adversarial programs', () => {
  for (const program of ["'\\".repeat(100000), '"'.repeat(200001), "'a".repeat(100000), 'x'.repeat(250000)]) {
    const started = performance.now();
    inlineShellCommands({ tokens: [{ value: 'python3' }, { value: '-c' }, { value: program }], wrappers: [] });
    const elapsed = performance.now() - started;
    assert.ok(elapsed < 2000, `${JSON.stringify(program.slice(0, 20))} took ${Math.round(elapsed)} ms`);
  }
});
