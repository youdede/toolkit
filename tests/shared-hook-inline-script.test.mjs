import test from 'node:test';
import assert from 'node:assert/strict';

import { parseShellCommands } from '../scripts/lib/shared-hook/shell.mjs';
import { inlineProgram, inlineShellCommands } from '../scripts/lib/shared-hook/inline-script.mjs';

// Probes for the shared `inline-script` block: shell commands written inside interpreter one-liners.
// Each command renders as its tokens; the probes cover every interpreter the module knows.
function render(command) {
  return parseShellCommands(command).commands.flatMap((entry) => inlineShellCommands(entry))
    .map((entry) => entry.tokens.map((token) => token.value).join(' '));
}

const PROBES = [
  ['python3 -c "import os; os.system(\'aws ec2 terminate-instances --instance-ids i-1\')"', ['aws ec2 terminate-instances --instance-ids i-1']],
  ['python -uc "import subprocess; subprocess.run(\'npm publish\', shell=True)"', ['npm publish']],
  ['node -e "require(\'child_process\').execSync(\'npm publish\')"', ['child_process', 'npm publish']],
  ['ruby -e \'system("crontab -r")\'', ['crontab -r']],
  ['perl -e \'system("systemctl restart nginx")\'', ['systemctl restart nginx']],
  ['php -r \'exec("docker push reg.io/app:1");\'', ['docker push reg.io/app:1']],
  ['deno eval "Deno.run({cmd: [\'ls\']})"', ['ls']],
  ["pwsh -c 'Restart-Service spooler'", ['Restart-Service spooler']],
  ['powershell -Command Stop-Service spooler', ['Stop-Service spooler']],
  ['cmd /c "sc stop spooler"', ['sc stop spooler']],
  ['sudo python3 -c "print(\'x\')"', ['x']],
  ['python3 script.py', []],
  ['node --version', []],
  ['python3 -c', []],
  ['echo "python3 -c \'rm -rf /\'"', []]
];

test('inline-script finds shell commands in interpreter one-liners', () => {
  for (const [command, expected] of PROBES) assert.deepEqual(render(command).sort(), [...expected].sort(), command);
  const [entry] = parseShellCommands('python3 -c "$CODE"').commands;
  assert.equal(inlineProgram(entry).dynamic, true);
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
