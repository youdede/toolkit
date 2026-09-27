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
  ['python3 -c "import os; os.system(\'aws ec2 terminate-instances --instance-ids i-1\')"', ['aws ec2 terminate-instances --instance-ids i-1', 'AMBIGUOUS']],
  ['python -uc "import subprocess; subprocess.run(\'npm publish\', shell=True)"', ['npm publish', 'AMBIGUOUS']],
  ['node -e "require(\'child_process\').execSync(\'npm publish\')"', ['child_process', 'npm publish', 'AMBIGUOUS']],
  ['ruby -e \'system("crontab -r")\'', ['crontab -r', 'AMBIGUOUS']],
  ['perl -e \'system("systemctl restart nginx")\'', ['systemctl restart nginx', 'AMBIGUOUS']],
  ['php -r \'exec("docker push reg.io/app:1");\'', ['docker push reg.io/app:1', 'AMBIGUOUS']],
  ['deno eval "Deno.run({cmd: [\'ls\']})"', ['ls', 'AMBIGUOUS']],
  // The shell block unwraps PowerShell itself, so its payload is an ordinary command, not an inline one.
  ["pwsh -c 'Restart-Service spooler'", []],
  ['powershell -Command Stop-Service spooler', []],
  ['cmd /c "sc stop spooler"', ['sc stop spooler']],
  // Attached program options run the program too (PR38-CODEX-1).
  ['python3 -c"import os; os.system(\'npm publish\')"', ['npm publish', 'AMBIGUOUS']],
  ['python3 -Ic"import subprocess; subprocess.run(\'npm publish\', shell=True)"', ['npm publish', 'AMBIGUOUS']],
  ['node --eval="require(\'child_process\').execSync(\'npm publish\')"', ['child_process', 'npm publish', 'AMBIGUOUS']],
  ['node -e"require(\'child_process\').execSync(\'npm publish\')"', ['child_process', 'npm publish', 'AMBIGUOUS']],
  ['bun --print=\'Bun.spawnSync(["sh", "-c", "npm publish"])\'', ['AMBIGUOUS', '-c', 'npm publish', 'AMBIGUOUS']],
  ['ruby -e"system(\'npm publish\')"', ['npm publish', 'AMBIGUOUS']],
  ['ruby -we \'%x(npm publish)\'', ['npm publish', 'AMBIGUOUS']],
  ['perl -e"system(\'npm publish\')"', ['npm publish', 'AMBIGUOUS']],
  ['perl -lnE\'qx{npm publish}\'', ['npm publish', 'AMBIGUOUS']],
  ['perl -e 1 -e \'system("npm publish")\'', ['npm publish', 'AMBIGUOUS']],
  ['php -r"exec(\'npm publish\');"', ['npm publish', 'AMBIGUOUS']],
  ['deno repl --eval="Deno.run({cmd: [\'ls\']})"', ['ls', 'AMBIGUOUS']],
  ['cmd /c"sc stop spooler"', ['sc stop spooler']],
  // Without a call that runs commands, the literals are data (PR38-CODEX-4).
  ['sudo python3 -c "print(\'x\')"', []],
  ['python3 -c "print(\'npm publish\')"', []],
  ['node -e "console.log(\'systemctl restart nginx\')"', []],
  ['perl -e \'print "crontab -r"\'', []],
  // Static Ruby and Perl literals with their own delimiters (PR38-CODEX2-1).
  ["ruby -e 'system %q{npm publish}'", ['npm publish', 'AMBIGUOUS']],
  ["ruby -e 'system %Q<npm publish>'", ['npm publish', 'AMBIGUOUS']],
  ["ruby -e 'system %{npm {x} publish}'", ['npm {x} publish', 'AMBIGUOUS']],
  ["ruby -e 'system %(npm publish)'", ['npm publish', 'AMBIGUOUS']],
  ["perl -e 'system q{npm publish}'", ['npm publish', 'AMBIGUOUS']],
  ["perl -e 'system qq(npm publish)'", ['npm publish', 'AMBIGUOUS']],
  ["perl -e 'system q!npm publish!'", ['npm publish', 'AMBIGUOUS']],
  ["perl -e '$q = 1; system(\"npm publish\")'", ['npm publish', 'AMBIGUOUS']],
  ["ruby -e 'puts %q{hello}'", []],
  // The call check reads code only: a call name inside a literal or a comment is data (PR38-CODEX2-2).
  ['python3 -c "print(\'system\', \'npm publish\')"', []],
  ['python3 -c "print(\'system\')"', []],
  ['python3 -c "print(\'x\')  # os.system(\'npm publish\')"', []],
  ["ruby -e 'puts \"#{system(%q{npm publish})}\"'", ['#{system', '%q{npm publish}', 'npm publish', 'AMBIGUOUS']],
  ['python3 -c "import os; getattr(os, \'system\')(\'npm publish\')"', ['system', 'npm publish', 'AMBIGUOUS']],
  ["ruby -e '`npm publish`'", ['npm publish', 'AMBIGUOUS']],
  ["perl -e 'print qx{npm publish}'", ['npm publish', 'AMBIGUOUS']],
  // Design PR38-CODEX3: without a capable name the literals are data; with one they are commands, and a
  // program the reader cannot follow (literal bound, heredoc, deep interpolation, dynamic name) is ambiguous.
  ['python3 -c "import subprocess; print(\'npm publish\')"', ['npm publish', 'AMBIGUOUS']],
  ['node -e "console.log(/execSync\\(\'npm publish\'\\)/.test(\'x\'))"', []],
  ['python3 -c "import json; print(json.dumps({\'a\': 1}))"', []],
  ['python3 -c "import os; getattr((os), \'system\')(\'npm publish\')"', ['system', 'npm publish', 'AMBIGUOUS']],
  ['ruby -e "system <<~CMD\nnpm publish\nCMD\n"', ['AMBIGUOUS']],
  ['perl -e \'system <<"CMD";\nnpm publish\nCMD\n\'', ['CMD', 'AMBIGUOUS']],
  [`python3 -c '${'"x";'.repeat(256)}import os; os.system("npm publish")'`, [...Array(256).fill('x'), 'AMBIGUOUS']],
  [`python3 -c '${'"x";'.repeat(256)}print(1)'`, []],
  // A program option followed by another option keeps both candidate words (PR38-CODEX4-2).
  ['node -p -e "require(\'child_process\').execSync(\'npm publish\')"', ['child_process', 'npm publish', 'AMBIGUOUS']],
  ['node -e -p "require(\'child_process\').execSync(\'npm publish\')"', ['child_process', 'npm publish', 'AMBIGUOUS']],
  ["perl -n -e 'system(\"npm publish\")'", ['npm publish', 'AMBIGUOUS']],
  // Reaching a reader limit is ambiguous even when the read part is not capable (PR38-CODEX4-3).
  [`ruby -e '${'"x";'.repeat(256)}%x{npm publish}'`, ['AMBIGUOUS']],
  ['ruby -e "puts %Q{#{%Q{#{%Q{#{%x{npm publish}}}}}}}"', ['AMBIGUOUS']],
  ['python3 -c "print(\'unterminated)"', ['AMBIGUOUS']],
  // A capable program is always ambiguous; its literals still give concrete commands (PR38-CODEX5-1).
  ['python3 -c "import os; os.system(\'npm \' \'publish\')"', ['npm', 'publish', 'AMBIGUOUS']],
  ['python3 -c "import subprocess; subprocess.run([\'ls\', \'-l\'])"', ['ls', '-l', 'AMBIGUOUS']],
  // Perl word delimiters after whitespace and Python triple quotes are literals (PR38-CODEX5-2).
  ["perl -e 'system q Xnpm publishX'", ['npm publish', 'AMBIGUOUS']],
  ["perl -e 'system qq {npm publish}'", ['npm publish', 'AMBIGUOUS']],
  ['python3 -c \'print(\"\"\"the publish \" command\"\"\")\'', []],
  ['python3 -c "print(\'\'\'it\'s npm publish\'\'\')"', []],
  ['python3 -c "import os; os.system(r\'\'\'npm publish\'\'\')"', ['npm publish', 'AMBIGUOUS']],
  // Static escapes decode per language; raw and non-interpolating literals keep them (PR38-CODEX6-2).
  ['python3 -c "import os; os.system(\'npm pu\\x62lish\')"', ['npm publish', 'AMBIGUOUS']],
  ['python3 -c "import os; os.system(\'\\u0074erraform apply\')"', ['terraform apply', 'AMBIGUOUS']],
  ['python3 -c "import os; os.system(r\'npm pu\\x62lish\')"', ['npm pux62lish', 'AMBIGUOUS']],
  ['node -e "require(\'child_process\').execSync(\'npm pu\\u{62}lish\')"', ['child_process', 'npm publish', 'AMBIGUOUS']],
  ["ruby -e 'system \"\\x6epm publish\"'", ['npm publish', 'AMBIGUOUS']],
  ["ruby -e 'system %q{npm pu\\x62lish}'", ['npm pux62lish', 'AMBIGUOUS']],
  ["perl -e 'system \"npm pu\\x{62}lish\"'", ['npm publish', 'AMBIGUOUS']],
  ["php -r 'exec(\"npm pu\\142lish\");'", ['npm publish', 'AMBIGUOUS']],
  // `open` runs a command only where it can open a pipe (PR38-CODEX6-3).
  ['python3 -c "open(\'/tmp/x.txt\', \'w\').write(\'done\')"', []],
  ["ruby -e 'open(\"|npm publish\")'", ['npm publish', 'AMBIGUOUS']],
  // The option region ends at the first operand or `--`; later words belong to the script (PR38-CODEX9-2).
  ['node app.js --eval "require(\'child_process\').execSync(\'npm publish\')"', []],
  ['node --eval "require(\'child_process\').execSync(\'npm publish\')" app.js', ['child_process', 'npm publish', 'AMBIGUOUS']],
  ['node -r ./hook.js -e "require(\'child_process\').execSync(\'npm publish\')"', ['child_process', 'npm publish', 'AMBIGUOUS']],
  ['node -- app.js -e "require(\'child_process\').execSync(\'npm publish\')"', []],
  ['python3 script.py -c "import os; os.system(\'npm publish\')"', []],
  ['python3 -W ignore -c "import os; os.system(\'npm publish\')"', ['npm publish', 'AMBIGUOUS']],
  ['python3 -m mod -c "import os; os.system(\'npm publish\')"', []],
  ["ruby -I lib -e 'system(\"npm publish\")'", ['npm publish', 'AMBIGUOUS']],
  ["ruby app.rb -e 'system(\"npm publish\")'", []],
  ["perl -I lib -e 'system(\"npm publish\")'", ['npm publish', 'AMBIGUOUS']],
  ["php -f a.php -r 'exec(\"npm publish\");'", []],
  ['deno run app.ts --eval "Deno.run({cmd: [\'ls\']})"', []],
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
  // An escape the reader does not decode makes a capable program relevant to every hook (PR38-CODEX6-2).
  const undecoded = parseShellCommands('python3 -c "import os; os.system(\'\\N{LATIN SMALL LETTER N}pm x\')"').commands.flatMap((item) => inlineShellCommands(item));
  assert.equal(undecoded.at(-1).relevant, true);
  assert.equal(inlineShellCommands(parseShellCommands('node -e "require(\'fs\').writeFileSync(\'x\', \'y\')"').commands[0]).at(-1).relevant, false);
  // In a capable program only certain escapes are trusted; any other escape or a here-document makes it
  // relevant to every hook (PR38-CODEX7-2, PR38-CODEX7-3). Programs that are not capable are unchanged.
  const relevance = (command) => parseShellCommands(command).commands.flatMap((item) => inlineShellCommands(item)).at(-1)?.relevant ?? null;
  for (const command of [
    'perl -e \'system "npm \\o{160}ublish"\'',
    'python3 -c "import os; os.system(\'npm \\160ublish\')"',
    'node -e "require(\'child_process\').execSync(\'npm pu\\u{62}lish\')"',
    'ruby -e "system <<~CMD\nnpm pu\\x62lish\nCMD\n"',
    'perl -e \'system <<"EOF";\nnpm publish\nEOF\n\''
  ]) assert.equal(relevance(command), true, command);
  for (const command of [
    'python3 -c "import os; os.system(\'npm pu\\x62lish\')"',
    'perl -e \'system "echo \\$HOME\\n"\'',
    'ruby -e \'system("ls\\t-l")\''
  ]) assert.equal(relevance(command), false, command);
  for (const command of ['python3 -c "print(\'a\\tb\')"', 'ruby -e \'puts "hello\\n"\'', 'perl -e \'print "x\\n"\'']) {
    assert.deepEqual(parseShellCommands(command).commands.flatMap((item) => inlineShellCommands(item)), [], command);
  }
});

test('inline-script ends quickly on adversarial programs', () => {
  for (const program of ["'\\".repeat(100000), '"'.repeat(200001), "'a".repeat(100000), 'x'.repeat(250000)]) {
    const started = performance.now();
    inlineShellCommands({ tokens: [{ value: 'python3' }, { value: '-c' }, { value: program }], wrappers: [] });
    const elapsed = performance.now() - started;
    assert.ok(elapsed < 2000, `${JSON.stringify(program.slice(0, 20))} took ${Math.round(elapsed)} ms`);
  }
});
