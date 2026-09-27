import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { SHELL_MAX_COMMAND_BYTES, gitInvocation, globDecides, parseShellCommands } from '../scripts/lib/shared-hook/shell.mjs';
import { analyzeCommitContent, commitReadsWorkingTree, commitSkipsHooks, parseGitAliases, readGitAliases } from '../scripts/lib/shared-hook/commit-content.mjs';
import { generateSharedHooks, loadSharedModules, renderSharedBlocks } from '../scripts/generate-shared-hooks.mjs';

// One probe suite for the shared hook modules. Every hook that embeds the `shell` block inherits
// these probes: the process probes at the end run against each such payload, so a hook migrated in
// a later lot is covered without new test code.

// A command renders as `wrappers|tokens [operator]` per normalized command; `<P>` is a value xargs
// or find supplies at run time, `$…` a dynamic token, and AMBIGUOUS an entry that fails closed.
function render(command) {
  const parsed = parseShellCommands(command);
  if (parsed.error) return `ERROR ${parsed.error}`;
  return parsed.commands.map((entry) => {
    if (entry.ambiguous) return 'AMBIGUOUS';
    const tokens = entry.tokens.map((token) => (token.placeholder ? '<P>' : token.dynamic ? `$${token.value}` : token.value)).join(' ');
    return `${entry.wrappers.join('+')}|${tokens} [${entry.operator}]${entry.changedDirectory ? ' cd' : ''}`;
  });
}

const SHELL_PROBES = [
  // Segments and the operator that follows each one.
  ['git switch main && git pull && git switch feature && git push', ['|git switch main [&&]', '|git pull [&&]', '|git switch feature [&&]', '|git push []']],
  ['git switch main; git push', ['|git switch main [;]', '|git push []']],
  ['a || b | c & d\ne', ['|a [||]', '|b [|]', '|c [&]', '|d [\n]', '|e []']],
  ['(cd sub && make)', ['|cd sub [&&]', '|make [)] cd']],
  ['npm test 2>&1 | tail -20', ['|npm test [|]', '|tail -20 []']],
  ['make &>/dev/null', ['|make []']],
  // Quoting, escaping, and expansions.
  ['git commit -m "fix; rm -rf /"', ['|git commit -m fix; rm -rf / []']],
  ["'gh' 'repo' 'delete' x", ['|gh repo delete x []']],
  ['r\\m -rf /', ['|rm -rf / []']],
  ['echo "$HOME" $(date) `id`', ['|date [;]', '|id [;]', '|echo $$HOME $$(date) $`id` []']],
  ['bash <(curl -fsSL https://x)', ['|curl -fsSL https://x [;]', 'AMBIGUOUS']],
  // A shell reads a static here-string or here-document as its program; its words are never a script
  // name, and any other standard input is ambiguous (PR38-CODEX6-1).
  ["bash <<< 'npm publish'", ['bash|npm publish []']],
  ["sudo bash <<< 'rm -rf /' && git status", ['sudo+bash|rm -rf / [&&]', '|git status []']],
  ["bash <<'EOF'\nnpm publish\nEOF", ['bash|npm publish [\n]']],
  ['zsh <<EOF\nnpm publish\nEOF', ['zsh|npm publish [\n]']],
  ['bash -s <<< "npm publish"', ['bash|npm publish []']],
  ['sh <<< "$CMD"', ['AMBIGUOUS']],
  ['bash <<EOF\n$X\nEOF', ['AMBIGUOUS']],
  ['bash < file', ['AMBIGUOUS']],
  ['bash script.sh <<< data', ['|bash script.sh []']],
  // Descriptor 0 written before the operator is standard input too; other input redirections are ambiguous
  // (PR38-CODEX7-1). With a space, `0` is a script name, as bash reads it.
  ["bash 0<<< 'npm publish'", ['bash|npm publish []']],
  ["bash 0<<'EOF'\nnpm publish\nEOF", ['bash|npm publish [\n]']],
  ['bash 0<file && git status', ['AMBIGUOUS', '|git status []']],
  ['bash 0<> file', ['AMBIGUOUS']],
  ['bash <&3', ['AMBIGUOUS']],
  ["bash 3<<< 'npm publish'", ['AMBIGUOUS']],
  ["bash 0 <<< 'npm publish'", ['|bash 0 []']],
  // Redirections leave the arguments in any position, also before the command (PR38-CODEX8-1).
  ['>/tmp/o npm publish', ['|npm publish []']],
  ['2>/dev/null rm -rf / && >/dev/null git push --force origin main', ['|rm -rf / [&&]', '|git push --force origin main []']],
  ['>out.txt echo hi; 2>/dev/null ls', ['|echo hi [;]', '|ls []']],
  ["0<<< 'npm publish' bash", ['bash|npm publish []']],
  ['exec >log 2>&1', []],
  // Every bash and zsh precommand modifier and reserved word is read before the command (PR38-CODEX9-1).
  ["zsh -c 'coproc npm publish'", ['zsh|npm publish []']],
  ["zsh -c 'nocorrect npm publish'", ['zsh|npm publish []']],
  ['coproc NAME { npm publish; } && git status', ['|npm publish [;]', '|git status []']],
  ['- npm publish', ['|npm publish []']],
  ['repeat 3 npm publish', ['|npm publish []']],
  ['nocorrect noglob npm publish', ['noglob|npm publish []']],
  ['time -p ! npm publish', ['time|npm publish []']],
  ['exec -cl npm publish', ['exec|npm publish []']],
  ['[[ -f .env ]] && npm test', ['|npm test []']],
  ['sudo nocorrect rm -rf /', ['AMBIGUOUS']],
  ['coproc NAME (npm publish)', ['AMBIGUOUS', '|npm publish [)]']],
  // ANSI-C quoting `$'…'` is a decoded fragment of its word; an escape
  // not decoded for certain makes the word dynamic (PR38-CODEX12-1).
  ["n$'\\x70'm pu$'\\x62'lish", ['|npm publish []']],
  ["n$''pm pu$''blish && git status", ['|npm publish [&&]', '|git status []']],
  ["git switch -c tmp; $'\\x61'ws ec2 $'\\164\\145rminate-instances' --instance-ids i-1", ['|git switch -c tmp [;]', '|aws ec2 terminate-instances --instance-ids i-1 []']],
  ["d$'\\u006f'cker pu$'\\U00000073'h x", ['|docker push x []']],
  ["echo $'a\\tb\\n\\e\\cA\\'\\\"\\?\\\\'", ['|echo a\tb\n\x1b\x01\'"?\\ []']],
  // `$"…"` is translated by the locale at run time: dynamic, its source text kept (PR38-CODEX13-2).
  ['$"np"m publish', ['AMBIGUOUS']],
  ['echo $"hello"', ['|echo $hello []']],
  // A `(` glued to word text opens a pattern group of that word, never a subshell (PR38-CODEX13-1).
  ['n@(p)m publish', ['AMBIGUOUS']],
  ["bash -O extglob -c 'r@(m) -rf /'", ['AMBIGUOUS']],
  ['cd src && n(p|x)m pu+(b)lish; git status', ['|cd src [&&]', 'AMBIGUOUS', '|git status [] cd']],
  ['rm -rf !(keep) *(.) ?(a)b', ['|rm -rf $!(keep) $*(.) $?(a)b []']],
  ['echo @($(npm publish))', ['|npm publish [;]', '|echo $@($(npm publish)) []']],
  ['diff =(ls) =(crontab -r)', ['|ls [;]', '|crontab -r [;]', '|diff $=(ls) $=(crontab -r) []']],
  ['if(true); then ls; fi', ['|true [)]', '|ls [;]']],
  ['!(false) && a&&(b)', ['|false [)]', '|a [&&]', '|b [)]']],
  ['n@(p', 'ERROR unterminated pattern group'],
  ["$'\\x00'npm publish", ['AMBIGUOUS']],
  ["$'\\u00e9' $'\\z' $'\\c1'", ['AMBIGUOUS']],
  ['echo "$\'x\'"', ["|echo $$'x' []"]],
  ["$'abc", 'ERROR unterminated quote'],
  // A function defined in a `( … )` or `$( … )` subshell ends with it; a `{ … }` group shares the scope
  // (PR38-CODEX13-3).
  ['( npm(){ npm publish; }; ); npm --version', ['|npm --version []']],
  ['( f(){ npm publish; }; f )', ['|npm publish [)]']],
  ['f(){ npm publish; }; ( cd src && f )', ['|cd src [&&]', '|npm publish [)] cd']],
  ['( f(){ npm publish; } ); ( f )', ['|f [)]']],
  ['echo $(f(){ npm publish; }); f', ['|echo $$(f(){ npm publish; }) [;]', '|f []']],
  ['f(){ npm publish; }; echo $(f)', ['|npm publish [;]', '|echo $$(f) []']],
  ['{ f(){ npm publish; }; }; git switch -c tmp && f', ['|git switch -c tmp [&&]', '|npm publish []']],
  // A here-string on a `{name}` descriptor does not feed the shell's standard input (PR38-CODEX11-1).
  ["{fd}<<< 'npm publish' bash", ['AMBIGUOUS']],
  ['{fd}>/tmp/out npm publish && git status', ['|npm publish [&&]', '|git status []']],
  ['cd src; {fd}>&- git push --force origin main', ['|cd src [;]', '|git push --force origin main [] cd']],
  ['echo {a,b} {x..y}', ['|echo a b x y []']],
  // Brace expansion is static, as in bash: each result is its own word (PR38-CODEX14-1).
  ['n{p..p}m pub{l..l}ish', ['|npm publish []']],
  ['git switch -c tmp && a{w..w}s e{c..c}2 ter{m..m}inate-instances --instance-ids i-1', ['|git switch -c tmp [&&]', '|aws ec2 terminate-instances --instance-ids i-1 []']],
  ['cd src; {npm,x} publish', ['|cd src [;]', '|npm x publish [] cd']],
  ['echo n{p,x}m a{b,{c,d}e}f {a,b}{1,2}', ['|echo npm nxm abf acef adef a1 a2 b1 b2 []']],
  ['echo {1..10..3} {05..1..2} {a..e..2} {-3..-1} x{,y}', ['|echo 1 4 7 10 05 03 01 a c e -3 -2 -1 x xy []']],
  ['echo {a} {} {x..} {1..a} stash@{0} {a,b}*', ['|echo {a} {} {x..} {1..a} stash@{0} a* b* []']],
  ['echo "{a,b}" {"a",b} {a",",b} \\{a,b\\} ${x:-{a,b}}', ['|echo {a,b} a b a, b {a,b} $${x:-{a,b}} []']],
  ['x={a,b} git status; echo x={a,b}', ['|git status [;]', '|echo x=a x=b []']],
  ['echo {1..100} {1..3..0} n{p..p}m$x', ['|echo ${1..100} ${1..3..0} $n{p..p}m$x []']],
  ['{ npm publish; }', ['|npm publish [;]']],
  // An unquoted null word from a brace expansion is removed; a quoted empty word stays (PR38-CODEX15-1).
  ['{,npm} publish', ['|npm publish []']],
  ['git switch -c tmp && npm {,publish}', ['|git switch -c tmp [&&]', '|npm publish []']],
  ["cd src; npm {,''} x {\"\",y} a{,}b {,}", ['|cd src [;]', '|npm  x  y ab ab [] cd']],
  // A glob executable may spell any command: ambiguous and relevant to every hook (PR38-CODEX15-2).
  ['n[p]m pub[l]ish', ['AMBIGUOUS']],
  ['cd src && n@(x|p)m publish', ['|cd src [&&]', 'AMBIGUOUS']],
  ['sudo r[m] -rf /', ['AMBIGUOUS']],
  ['[ -f x ] && ls *.md [Rr]eadme*', ['|[ -f x ] [&&]', '|ls *.md [Rr]eadme* []']],
  // A function definition runs nothing; each later call stands for its body (PR38-CODEX10-2).
  ['function deploy { npm publish; }', []],
  ['deploy() { npm publish; }', []],
  ['function deploy () { npm publish; }', []],
  ['f(){ rm -rf /;}', []],
  ['deploy() { npm publish; }; git switch -c tmp && deploy', ['|git switch -c tmp [&&]', '|npm publish []']],
  ['deploy() {\n  { cd src; npm publish; }\n}\ndeploy', ['|cd src [;]', '|npm publish [] cd']],
  ['if true; then f() { npm publish; }; fi; f', ['|true [;]', '|npm publish []']],
  ["g() { npm publish; }; bash -c 'g'", ['|npm publish []']],
  ['echo $(f() { npm publish; }; f)', ['|npm publish [;]', '|echo $$(f() { npm publish; }; f) []']],
  ['f() { echo $(npm publish); }', []],
  ['f() { npm publish', ['|npm publish []']],
  ['f() ( npm publish )', ['|npm publish [)]']],
  // Only a call that looks up functions in bash or zsh runs the body (PR38-CODEX11-2). `command f` and
  // `builtin f` find no function in either shell; zsh `exec f`, `nocorrect f`, and `- f` do, so the
  // body stands in there, whatever bash does with `exec f` (PR38-CODEX12-2).
  ['f(){ npm publish; }; command f; builtin f', ['command|f [;]', 'builtin|f []']],
  ["zsh -c 'f(){ npm publish; }; exec f'", ['zsh|npm publish []']],
  ['f(){ npm publish; }; exec -c f', ['|npm publish []']],
  ['f(){ npm publish; }; cd src && nocorrect f; - f', ['|cd src [&&]', '|npm publish [;] cd', '|npm publish [] cd']],
  ['f(){ npm publish; }; env f; nice f; nohup f; timeout 1 f; sudo f', ['env|f [;]', 'nice|f [;]', 'nohup|f [;]', 'timeout|f [;]', 'sudo|f []']],
  ['f(){ npm publish; }; echo a | xargs f; find . -exec f {} +', ['|echo a [|]', 'xargs|f <P> [;]', '|find . -exec f {} + []', 'find|f <P> []']],
  ['f(){ npm publish; }; ! f && time f; noglob f; if f; then :; fi', ['|npm publish [&&]', '|npm publish [;]', '|npm publish [;]', '|npm publish [;]', '|: [;]']],
  ['git switch -c tmp && f(){ npm publish; } && f', ['|git switch -c tmp [&&]', '|npm publish []']],
  // `function NAME` keeps its header across newlines before `{` (PR38-CODEX11-3).
  ['function deploy\n{\nnpm publish\n}', []],
  ['function deploy\n\n\n{ npm publish; }\ncd src && deploy', ['|cd src [&&]', '|npm publish [] cd']],
  ['function deploy()\n{\nnpm publish\n}', []],
  ['deploy ()\n\n{\nnpm publish\n}', []],
  // Parentheses after `name=` or `name+=` hold array elements, which are data (PR38-CODEX10-3).
  ['arr=(npm publish)', []],
  ['cd src && arr=(npm publish) && echo "${arr[@]}"', ['|cd src [&&]', '|echo $${arr[@]} [] cd']],
  ['declare -a x=(npm publish)', ['|declare -a x=(npm publish) []']],
  ["local x=('npm' \"publish\"); readonly y=(a b); typeset z=(c)", ['|local x=(npm publish) [;]', '|readonly y=(a b) [;]', '|typeset z=(c) []']],
  ['x+=(npm publish) git status', ['|git status []']],
  ['arr=(a $(npm publish) `rm -rf /` <(crontab -r))', ['|npm publish [;]', '|rm -rf / [;]', '|crontab -r [;]']],
  ['arr=(a; npm publish)', 'ERROR invalid array'],
  ['PATH+=:/tmp npm publish', ['AMBIGUOUS']],
  ['a[1]=x npm test', ['|npm test []']],
  // Between double quotes bash keeps a backslash before other characters (PR38-CODEX6-2).
  ['echo "C:\\Users" "a\\$b"', ['|echo C:\\Users a$b []']],
  ['diff <(sort a) <(sort b)', ['|sort a [;]', '|sort b [;]', '|diff $<(sort a) $<(sort b) []']],
  // Substitutions run before their command, also inside quotes and `${…}` (W3-REVIEW-2).
  ['echo "$(git commit -m x)"', ['|git commit -m x [;]', '|echo $$(git commit -m x) []']],
  ['echo `rm -rf /` && git status', ['|rm -rf / [;]', '|echo $`rm -rf /` [&&]', '|git status []']],
  ['echo ${x:-$(npm publish)}', ['|npm publish [;]', '|echo $${x:-$(npm publish)} []']],
  // A process substitution in the word of `${…}` runs too (PR38-CODEX-2); in `$((…))` `<(` is a comparison.
  ['echo ${x:-<(npm publish)}', ['|npm publish [;]', '|echo $${x:-<(npm publish)} []']],
  ['echo ${x:->(rm -rf /)} && echo ${y:-${z:-<(crontab -r)}}', ['|rm -rf / [;]', '|echo $${x:->(rm -rf /)} [&&]', '|crontab -r [;]', '|echo $${y:-${z:-<(crontab -r)}} []']],
  ['echo ${HOME:-/tmp}', ['|echo $${HOME:-/tmp} []']],
  // Between quotes in `${…}`, `<(…)` is text; `$(…)` and backticks still run (PR38-CODEX2-3).
  ["echo ${x:-'<(npm publish)'}", ["|echo $${x:-'<(npm publish)'} []"]],
  ['echo ${x:-"<(npm publish)"} && echo "${x:-default}"', ['|echo $${x:-"<(npm publish)"} [&&]', '|echo $${x:-default} []']],
  ['echo ${x:-"$(npm publish)"}', ['|npm publish [;]', '|echo $${x:-"$(npm publish)"} []']],
  ['echo ${x:-"`npm publish`"}', ['|npm publish [;]', '|echo $${x:-"`npm publish`"} []']],
  ['echo $((a<(b)))', ['|echo $$((a<(b))) []']],
  ['echo $((1 << 2))', ['|echo $$((1 << 2)) []']],
  ['echo $(echo $(echo $(echo $(npm publish))))', ['AMBIGUOUS', '|echo $$(npm publish) [;]', '|echo $$(echo $(npm publish)) [;]', '|echo $$(echo $(echo $(npm publish))) [;]', '|echo $$(echo $(echo $(echo $(npm publish)))) []']],
  // A backslash-newline is removed before the analysis, as bash does (W3-REVIEW-2).
  ['git com\\\nmit -m x', ['|git commit -m x []']],
  ['git commit "-m\\\nx"', ['|git commit -mx []']],
  // Here-document bodies are data; an unquoted delimiter still runs its substitutions (W3-REVIEW-3).
  ["cat > notes.md <<'EOF'\nDon't forget\nEOF", ['|cat [\n]']],
  ['cat <<EOF > deploy.sh\nnpm publish\nEOF\ngit switch main && git push', ['|cat [\n]', '|git switch main [&&]', '|git push []']],
  ['cat <<-EOF\n\tit\'s $(npm publish)\n\tEOF', ['|npm publish [;]', '|cat [\n]']],
  ["gh pr create --body \"$(cat <<'EOF'\nit's fine\nEOF\n)\"", ["|cat [;]", "|gh pr create --body $$(cat <<'EOF'\nit's fine\nEOF\n) []"]],
  // Assignments alone run nothing; their substitutions do (W3-REVIEW-4).
  ['x=1', []],
  ['x=1; echo $x', ['|echo $$x []']],
  ['SHA=$(git rev-parse HEAD) && git switch main', ['|git rev-parse HEAD [;]', '|git switch main []']],
  ['g{it,noop} push', ['|git gnoop push []']],
  ['echo {a..c} stash@{0} {}', ['|echo a b c stash@{0} {} []']],
  ['echo "unterminated', 'ERROR unterminated quote'],
  ['echo $(date', 'ERROR unterminated expansion'],
  ['echo \\', 'ERROR trailing escape'],
  // Executable paths and globs.
  ['/bin/rm -rf /', ['|/bin/rm -rf / []']],
  ['/usr/bin/git --no-pager push', ['|/usr/bin/git --no-pager push []']],
  ['r* -rf /', ['AMBIGUOUS']],
  ['[ -f .env ] && echo present', ['|[ -f .env ] [&&]', '|echo present []']],
  // Wrappers.
  ['sudo --', ['AMBIGUOUS']],
  ['sudo -- rm -rf /', ['sudo|rm -rf / []']],
  ['sudo -u root -E rm x', ['sudo|rm x []']],
  ['sudo -D /tmp rm x', ['AMBIGUOUS']],
  ['sudo -- sudo -- sudo -- git commit -m x', ['sudo+sudo+sudo|git commit -m x []']],
  ['doas -u root systemctl restart nginx', ['doas|systemctl restart nginx []']],
  ['doas -C /etc/doas.conf rm x', ['AMBIGUOUS']],
  ['setsid -f npm run dev', ['setsid|npm run dev []']],
  ['env FOO=1 -u BAR git status', ['env|git status []']],
  ['env PATH=/tmp rm x', ['AMBIGUOUS']],
  ['GIT_DIR=/x git commit', ['AMBIGUOUS']],
  ['env -C / rm -rf /', ['AMBIGUOUS']],
  ['nice rm -rf /', ['nice|rm -rf / []']],
  ['nice -n 10 npm run build', ['nice|npm run build []']],
  ['nice -5 make', ['nice|make []']],
  ['timeout 5 rm -rf /', ['timeout|rm -rf / []']],
  ['timeout -s KILL --preserve-status 1m npm test', ['timeout|npm test []']],
  ['timeout', ['AMBIGUOUS']],
  ['echo x | xargs git commit -am', ['|echo x [|]', 'xargs|git commit -am <P> []']],
  ['xargs -0 -n1 -P4 rm -f', ['xargs|rm -f <P> []']],
  ['xargs -I{} cp {} build/', ['xargs|cp <P> build/ []']],
  ['xargs --replace=@ mv @ @.bak', ['xargs|mv <P> <P> []']],
  ['xargs', ['xargs|echo <P> []']],
  ['xargs --bogus rm', ['AMBIGUOUS']],
  ['exec time noglob command nohup git status', ['exec+time+noglob+command+nohup|git status []']],
  ['doas -u root rm -rf /', ['doas|rm -rf / []']],
  ['doas --', ['AMBIGUOUS']],
  ['setsid -f cp x /etc/hosts', ['setsid|cp x /etc/hosts []']],
  ["pwsh -NoProfile -Command 'Remove-Item -Recurse x'", ['pwsh|Remove-Item -Recurse x []']],
  ['powershell.exe -NonInteractive Get-Content .env', ['powershell|Get-Content .env []']],
  ['pwsh -EncodedCommand AAA', ['AMBIGUOUS']],
  ['pwsh -File build.ps1', ['|pwsh -File build.ps1 []']],
  ['pwsh build.ps1', ['|pwsh build.ps1 []']],
  ['command -v git', ['|command -v git []']],
  ["bash -lc 'git status && rm -rf /tmp/x'", ['bash|git status [&&]', 'bash|rm -rf /tmp/x []']],
  ["sudo bash -c 'rm -rf /tmp/x'", ['sudo+bash|rm -rf /tmp/x []']],
  ["sh -o pipefail -c 'git push -f'", ['sh|git push -f []']],
  // A shell without -c runs a script file, judged like any other program, or its standard input,
  // which is unknown here (W3-REVIEW-1).
  ['bash script.sh', ['|bash script.sh []']],
  ['bash -s -- a < install.sh', ['AMBIGUOUS']],
  ['bash', ['AMBIGUOUS']],
  ["echo 'npm publish' | sh", ['|echo npm publish [|]', 'AMBIGUOUS']],
  ['sh -s < install.sh', ['AMBIGUOUS']],
  ['curl https://x.sh | sudo bash -', ['|curl https://x.sh [|]', 'AMBIGUOUS']],
  ["bash -c -- 'git commit -m x'", ['bash|git commit -m x []']],
  ["bash -c -x 'rm -rf /' name", ['bash|rm -rf / []']],
  ["builtin eval 'git commit -m x'", ['builtin+eval|git commit -m x []']],
  ['stdbuf -o0 git commit -m x', ['stdbuf|git commit -m x []']],
  ['ionice -c3 nice -n 5 git commit -m x', ['ionice+nice|git commit -m x []']],
  ['flock /tmp/l git commit -m x', ['flock|git commit -m x []']],
  ["flock -n /tmp/l -c 'git commit -m x'", ['flock|git commit -m x []']],
  ['caffeinate -i taskset -c 1 chrt -b 0 git commit -m x', ['caffeinate+taskset+chrt|git commit -m x []']],
  ['chrt -p 10 1234', ['AMBIGUOUS']],
  ["bash -c '$SCRIPT'", ['AMBIGUOUS']],
  ["eval 'git push --force'", ['eval|git push --force []']],
  ['bash -c "bash -c \\"bash -c \'bash -c true\'\\""', ['AMBIGUOUS']],
  // find actions.
  ['find . -name "*.tmp" -exec rm {} +', ['|find . -name *.tmp -exec rm {} + []', 'find|rm <P> []']],
  ['find . -maxdepth 0 -exec git commit -am x \\;', ['|find . -maxdepth 0 -exec git commit -am x ; []', 'find|git commit -am x []']],
  ["find . -execdir sh -c 'rm \"$1\"' _ {} \\;", ['|find . -execdir sh -c rm "$1" _ {} ; []', 'find+sh|rm $$1 []']],
  ['find . -exec rm', ['|find . -exec rm []']],
  // Compound commands and directory changes.
  ['if true; then rm -rf /; fi', ['|true [;]', '|rm -rf / [;]']],
  ['{ rm -rf /; }', ['|rm -rf / [;]']],
  ['function f { rm -rf /; }; f', ['|rm -rf / []']],
  ['for f in a b; do echo "$f"; done', ['|echo a b [;]']],
  ['for f in *.js; do wc -l "${f}" "$f.bak"; done', ['|wc -l *.js $$f.bak [;]']],
  ['for cmd in ls pwd; do $cmd; done', ['AMBIGUOUS']],
  ['cd sub && git commit -m x', ['|cd sub [&&]', '|git commit -m x [] cd']],
  ['pushd sub; git status; popd', ['|pushd sub [;]', '|git status [;] cd', '|popd [] cd']]
];

test('the shell module normalizes segments, operators, quoting, wrappers, and compound commands', () => {
  for (const [command, expected] of SHELL_PROBES) assert.deepEqual(render(command), expected, command);
  assert.deepEqual(parseShellCommands(undefined), { commands: [] });
  const segmentText = (command) => parseShellCommands(command).commands.map((entry) => entry.segment?.map((token) => token.value).join(' ') ?? null);
  assert.deepEqual(segmentText('git status && sudo -D /tmp rm x; npm test'), [null, 'sudo -D /tmp rm x', null]);
  assert.deepEqual(segmentText("bash -c 'ls; env -C / rm tests/a.py'"), [null, 'env -C / rm tests/a.py']);
  // An ambiguous entry's `text` drops run-time text, so a word split by it is whole again (PR38-CODEX12-1).
  const bareText = (command) => parseShellCommands(command).commands.map((entry) => entry.text ?? null);
  assert.deepEqual(bareText('n${x}pm pu$(true)blish'), [null, 'npm publish']);
  assert.deepEqual(bareText("cd src && sys\"$e\"temctl res`:`tart nginx"), [null, null, 'systemctl restart nginx']);
  // A glob executable's entry is relevant; so is one with a glob argument that may match anything.
  const relevance = (command) => parseShellCommands(command).commands.map((entry) => entry.relevant ?? false);
  assert.deepEqual(relevance('n[p]m pub[l]ish; $CMD pub[l]ish; $CMD *.md; ls *.md'), [true, false, true, false]);
  assert.deepEqual(bareText('$CMD pub[l]ish n[px]m'), [' publish npm nxm']);
  assert.deepEqual(parseShellCommands('g[i]t commit').commands[0].glob, true);
  // A cap always leaves an ambiguous, relevant entry: a brace word past its bound or not known for
  // certain, wrappers past SHELL_MAX_WRAPPERS, shells and substitutions past the depth cap (PR38-CODEX16-1).
  const hide = (text) => `{${','.repeat(65)}${text}}`;
  assert.deepEqual(relevance(`${hide('n{p..p}m')} ${hide('pub{l..l}ish')}`), [true]);
  assert.deepEqual(relevance(`${hide('npm')} test; {1..3..0}x run`), [true, true]);
  assert.deepEqual(relevance(`${'x'.repeat(1030)}{a,b} run`), [true]);
  assert.deepEqual(relevance(`${'nice '.repeat(20)}npm publish`), [true]);
  assert.deepEqual(relevance(`bash -c "bash -c 'bash -c \\"bash -c true\\"'"`), [true]);
  assert.deepEqual(relevance('echo $(echo $(echo $(echo $(npm publish))))'), [true, false, false, false, false]);
  // `globDecides`: a glob among the deciding words or options of a protected command (PR38-CODEX15-2).
  const decides = (command, words, flags) => globDecides(parseShellCommands(command).commands[0], words, flags);
  assert.equal(decides('npm pub[l]ish', 1), true);
  assert.equal(decides('npm --prefix dir pub*', 1), true);
  assert.equal(decides('npm test -- src/*.test.js', 1), false);
  assert.equal(decides('npm publish *.tgz', 1), false);
  assert.equal(decides('aws ec2 ter[m]inate-instances', 2), true);
  assert.equal(decides('rm -r[f] /', 0), true);
  assert.equal(decides('rm -f dist/*.js', 0), false);
  assert.equal(decides('crontab x*', Infinity), true);
  // `--` ends options, not the deciding words; boolean flags take no value (PR38-CODEX16-2, PR38-CODEX16-3).
  assert.equal(decides('npm -- pub[l]ish', 1), true);
  assert.equal(decides('npm -- -*', 1), true);
  assert.equal(decides('npm test -- src/*.test.js', 1), false);
  assert.equal(decides('npm --silent test src/*.test.js', 1, ['--silent']), false);
  assert.equal(decides('npm --silent test src/*.test.js', 1), true);
  assert.equal(decides('aws --no-cli-pager s3 ls logs/*.json', 2, ['--no-cli-pager']), false);
  assert.equal(decides('aws --profile p ec2 ter[m]inate-instances', 2, ['--no-cli-pager']), true);
  // A capped brace word may be any result it did not list (PR38-CODEX16-1).
  assert.equal(decides(`npm {${','.repeat(65)}publish}`, 1), true);
  // A locale string keeps its source text (PR38-CODEX13-1, PR38-CODEX13-2).
  // Every alternative of a glob's bracket sets and groups; `+(…)` repeats, so it may match anything (PR38-CODEX15-2).
  assert.deepEqual(bareText('n@(p|x)m pu+(b)lish'), ['npm nxm pulish']);
  assert.deepEqual(bareText('cron(t)ab -r'), ['crontab -r']);
  // A brace word not expanded for certain keeps its expansions, up to the bound (PR38-CODEX14-1).
  assert.deepEqual(bareText('n{p..p}m$x pub{l..l}ish'), ['npm publish']);
  assert.match(bareText('{npm,x}{1..100} publish')[0], /^npm1 npm2 .* npm65 publish$/);
  assert.deepEqual(bareText('$"safe" $"go"'), ['safe go']);
  assert.deepEqual(bareText("$'\\x00'npm publish"), ['npm publish']);
  assert.equal(parseShellCommands('x'.repeat(SHELL_MAX_COMMAND_BYTES + 1)).error, 'command exceeds analysis limit');
});

test('the shell module marks unquoted globs and, on request, separates redirections', () => {
  const [wc] = parseShellCommands("wc -l src/*.js 'a*' b\\? [x]").commands;
  assert.deepEqual(wc.tokens.map((token) => Boolean(token.glob)), [false, false, true, false, false, true]);
  assert.equal(parseShellCommands('echo x > /etc/hosts').commands[0].redirections, undefined, 'redirections are opt-in');
  const redirected = (command) => {
    const parsed = parseShellCommands(command, 0, [], { redirections: true });
    if (parsed.error) return `ERROR ${parsed.error}`;
    return parsed.commands.map((entry) => `${entry.tokens.map((token) => token.value).join(' ')} {${(entry.redirections ?? []).map((item) => `${item.operator}${item.target.value}`).join(' ')}}`);
  };
  assert.deepEqual(redirected('echo x>/etc/hosts'), ['echo x {>/etc/hosts}']);
  assert.deepEqual(redirected('npm test 2>&1 | tail -5'), ['npm test {2>&1}', 'tail -5 {}']);
  assert.deepEqual(redirected('make &>>log; cat <.env'), ['make {&>>log}', 'cat {<.env}']);
  assert.deepEqual(redirected('echo "a>b" "2">f 3<>g x >|h'), ['echo a>b 2 x {>f 3<>g >|h}']);
  assert.deepEqual(redirected('> /etc/hosts'), [' {>/etc/hosts}']);
  assert.deepEqual(redirected("bash -c 'cat .env > out' 2>err"), ['cat .env {>out 2>err}']);
  assert.deepEqual(redirected('cat <<-EOF'), ['cat {<<-EOF}']);
  assert.deepEqual(redirected('diff <(sort a) b'), ['sort a {}', 'diff <(sort a) b {}']);
  assert.deepEqual(redirected("cat > f 2<<'EOF'\nit's > /etc/hosts\nEOF\ncd sub"), ['cat {>f 2<<EOF}', 'cd sub {}']);
  for (const broken of ['echo >', 'echo > ; ls', 'cat < < x']) assert.equal(redirected(broken), 'ERROR redirection without target', broken);
  // Bash's `{name}` descriptor belongs to its redirection in any position; the operator stays plain (PR38-CODEX11-1).
  const named = (command) => parseShellCommands(command, 0, [], { redirections: true }).commands
    .map((entry) => `${entry.tokens.map((token) => token.value).join(' ')} {${(entry.redirections ?? []).map((item) => `${item.variable ?? ''}:${item.operator}${item.target.value}`).join(' ')}}`);
  assert.deepEqual(named('{fd}>/tmp/out npm publish'), ['npm publish {fd:>/tmp/out}']);
  assert.deepEqual(named('npm {fd}>>log publish {in}<file'), ['npm publish {fd:>>log in:<file}']);
  assert.deepEqual(named('rm -rf / {fd}<>x {a}>&- {b}<&0 {c}>&2'), ['rm -rf / {fd:<>x a:>&- b:<&0 c:>&2}']);
  assert.deepEqual(named("{fd}<<'EOF' git push --force\nx\nEOF"), ['git push --force {fd:<<EOF}']);
  assert.deepEqual(named('echo {fd} >out "{fd}">q {a,b}>r'), ['echo {fd} {fd} a b {:>out :>q :>r}']);
  // A redirection target with several brace words stays one dynamic word; with one it is that word.
  assert.deepEqual(named('ls >{a,b} 2>{c..c}'), ['ls {:>{a,b} :2>c}']);
  assert.deepEqual(named('{ npm publish; }'), ['npm publish {}']);
});

test('the shell module reads Git global options before the subcommand', () => {
  const git = (command) => gitInvocation(parseShellCommands(command).commands[0].tokens);
  const plain = git('/usr/bin/git -C sub --no-pager -c core.hooksPath=/dev/null -c alias.ci=commit --git-dir=.git --work-tree . push -f');
  assert.equal(plain.name, 'push');
  assert.deepEqual(plain.args.map((token) => token.value), ['-f']);
  assert.equal(plain.scoped, true);
  assert.deepEqual(plain.globals.directories, ['sub']);
  assert.equal(plain.globals.gitDir, '.git');
  assert.equal(plain.globals.workTree, '.');
  assert.deepEqual(plain.globals.config, [{ key: 'core.hookspath', value: '/dev/null' }, { key: 'alias.ci', value: 'commit' }]);
  assert.equal(git('git --no-pager log -1').scoped, false);
  assert.equal(git('git --config-env=core.hooksPath=HOOKS commit').globals.config[0].key, 'core.hookspath');
  assert.equal(git('git -C "$DIR" push').ambiguous, true);
  assert.equal(git('git "$SUB"').ambiguous, true);
  assert.equal(git('git -C').ambiguous, true);
  assert.equal(git('git --version').name, undefined);
});

const COMMIT_PROBES = [
  // [command, expected fields]
  ['git commit -m x', { found: true, worktree: false, noVerify: false, unsupportedScope: false, ignored: null }],
  ['npm test', { found: false }],
  ['echo "git commit"', { found: false }],
  ['git log --grep commit', { found: false }],
  ['git commit -am x', { worktree: true }],
  ['git commit -m x app.js', { worktree: true }],
  ['git add app.js && git commit -m x', { worktree: true }],
  ['git commit -m a && git add -A && git commit -m b', { worktree: true }],
  ['git add -f .env && git commit -m x', { worktree: true, ignored: { all: false, pathspecs: ['.env'] } }],
  ['git add --force -- .env secrets/ && git commit -m x', { ignored: { all: false, pathspecs: ['.env', 'secrets/'] } }],
  ['git add -fA && git commit -m x', { ignored: { all: true, pathspecs: [] } }],
  ['git add -f "$FILE" && git commit -m x', { ignored: { all: true, pathspecs: [] } }],
  ['git add .env && git commit -m x', { ignored: null }],
  ['git commit -nm x', { noVerify: true }],
  ['git commit -mn', { noVerify: false }],
  ['git commit app.js -n', { noVerify: true }],
  ['git commit --no-verify -m x', { noVerify: true }],
  ['git commit --no-ver -m x', { noVerify: true }],
  ['git -c core.hooksPath=/dev/null commit -m x', { noVerify: true }],
  ['git -C ../other commit -m x', { unsupportedScope: true }],
  ['cd sub && git commit -m x', { unsupportedScope: true }],
  ['echo x | xargs git commit -am', { found: true, worktree: true }],
  ['echo msg | xargs git commit -m', { found: true, worktree: true }],
  ['find . -maxdepth 0 -exec git commit -am x \\;', { found: true, worktree: true }],
  ["bash -lc 'git commit -m ok'", { found: true }],
  ['/usr/bin/git --no-pager commit -m x', { found: true }],
  // Aliases: configured, defined in the command, or passed with -c.
  ['git ci -am x', { found: true, worktree: true }],
  ['git config alias.ci commit && git ci -am x', { found: true, worktree: true }],
  ['git config --local alias.cm "commit -n" && git cm -m x', { found: true, noVerify: true }],
  ['git -c alias.zz=commit zz -m x', { found: true, worktree: false }],
  ['git config alias.ship "push --force origin feature:main" && git ship', { found: false }],
  ['git st', { found: false }],
  ['git unknown-tool', { found: false }],
  ['git sh', { found: true, unsupportedScope: true }],
  ['git config alias.q "$X" && git q', { ambiguous: true }],
  ['git config "$KEY" commit && git q', { ambiguous: true }],
  ['git loop', { ambiguous: true }],
  ['git config alias.status commit && git status', { found: false }],
  ['bash -c "$SCRIPT"', { ambiguous: true }],
  ['env GIT_DIR=$DIR git commit -m x', { ambiguous: true }]
];
const CONFIGURED = new Map([['ci', 'commit'], ['st', 'status'], ['sh', '!git commit -m shell'], ['loop', 'loop']]);

test('the commit-content module tells what the commands will commit', () => {
  for (const [command, expected] of COMMIT_PROBES) {
    const actual = analyzeCommitContent(command, { aliases: CONFIGURED });
    for (const [key, value] of Object.entries(expected)) assert.deepEqual(actual[key], value, `${command}: ${key}`);
  }
  let reads = 0;
  analyzeCommitContent('git status && git commit -m x && npm test', { aliases: () => { reads += 1; return new Map(); } });
  assert.equal(reads, 0, 'built-in subcommands never read aliases');
  analyzeCommitContent('git st && git st', { aliases: () => { reads += 1; return CONFIGURED; } });
  assert.equal(reads, 1, 'aliases are read once per command');
});

test('commit option parsing follows git commit syntax', () => {
  const tokens = (text) => text.split(' ').map((value) => ({ value, dynamic: false }));
  for (const args of ['-am x', '-a -m x', '--all -m x', '-m x app.js', '-m x -- app.js', '--only -m x', '--include -m x', '-p', '--interactive', '--pathspec-from-file=list.txt']) {
    assert.equal(commitReadsWorkingTree(tokens(args)), true, args);
  }
  for (const args of ['-m x', '-F msg.txt', '--amend --no-edit', '-S -m x', '-Sdeadbeef -m x', '-C HEAD', '--author=me -m x', '-s -m x', '-uno -m x']) {
    assert.equal(commitReadsWorkingTree(tokens(args)), false, args);
  }
  for (const args of ['-n', '-nm x', '-anm x', 'file -n', '--no-verify', '--no-v']) assert.equal(commitSkipsHooks(tokens(args)), true, args);
  for (const args of ['-m -n', '-mn', '-m x', '--no-edit', '-F -n', '-- -n']) assert.equal(commitSkipsHooks(tokens(args)), false, args);
});

test('Git aliases are read with git config --get-regexp and fail closed', () => {
  assert.deepEqual([...parseGitAliases('alias.ci\ncommit\0alias.LG\nlog --graph\nx\0alias.empty\0')], [['ci', 'commit'], ['lg', 'log --graph\nx'], ['empty', '']]);
  const calls = [];
  const aliases = readGitAliases((args) => { calls.push(args); return { status: 0, stdout: 'alias.ci\ncommit\0' }; });
  assert.deepEqual(calls, [['config', '-z', '--get-regexp', '^alias\\.']]);
  assert.equal(aliases.get('ci'), 'commit');
  assert.equal(readGitAliases(() => ({ status: 1, stdout: '' })).size, 0);
  assert.throws(() => readGitAliases(() => ({ status: 128, stdout: '', stderr: 'fatal: bad config' })), /bad config/);
  assert.throws(() => readGitAliases(() => ({ error: new Error('spawn git ENOENT') })), /ENOENT/);
});

// Inputs that once stalled hooks (`sudo --`) or that stress every loop of the analysis.
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
  `x=${'y'.repeat(SHELL_MAX_COMMAND_BYTES - 2)}`,
  'cat <<a '.repeat(30000) + '\n' + 'x\n'.repeat(30000),
  '$(cat <<a\n'.repeat(30000),
  '\\\n'.repeat(100000),
  '$(a) `b` <(c) '.repeat(15000),
  `cat <<E\n${'$(x) '.repeat(40000)}\nE`
];
const TIME_LIMIT_MS = 2000;

test('the analysis terminates quickly on adversarial input', () => {
  const loops = new Map([...Array.from({ length: 50 }, (_, index) => [`a${index}`, `a${index + 1}`]), ['a50', 'a0'], ['self', 'self']]);
  for (const command of [...ADVERSARIAL, 'git a0', 'git self']) {
    const started = performance.now();
    parseShellCommands(command);
    parseShellCommands(command, 0, [], { redirections: true });
    analyzeCommitContent(command, { aliases: loops });
    const elapsed = performance.now() - started;
    assert.ok(elapsed < TIME_LIMIT_MS, `${JSON.stringify(command.slice(0, 40))} took ${Math.round(elapsed)} ms`);
  }
  assert.deepEqual(analyzeCommitContent('git a0', { aliases: loops }), { ambiguous: true });
});

function sharedShellPayloads() {
  const files = [];
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const next = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(next);
      else if (entry.name.endsWith('.mjs') && readFileSync(next, 'utf8').includes('// <youdede:shared shell>')) files.push(next);
    }
  };
  walk(path.resolve('artifacts'));
  return files;
}

test('every hook with the shared shell block ends in bounded time as a process', { timeout: 10 * 60 * 1000 }, (context) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'youdede-shared-shell-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const payloads = sharedShellPayloads();
  assert.ok(payloads.length >= 2, 'the pilot hooks embed the shared shell block');
  for (const script of payloads) {
    for (const command of ['sudo --', 'sudo -- sudo -- git commit -m x', 'sudo -- '.repeat(20000), '$('.repeat(100000), 'find . -exec '.repeat(15000)]) {
      const started = performance.now();
      const result = spawnSync(process.execPath, [script], {
        input: JSON.stringify({ tool_name: 'Bash', tool_input: { command }, cwd: directory }),
        cwd: directory,
        encoding: 'utf8',
        timeout: 10_000
      });
      const label = `${path.basename(script)} ${JSON.stringify(command.slice(0, 30))}`;
      assert.equal(result.signal, null, `${label} was killed after ${Math.round(performance.now() - started)} ms`);
      assert.ok([0, 2].includes(result.status), `${label} exited ${result.status}`);
    }
  }
});

test('the generator keeps every shared block in sync and rejects broken markers', () => {
  const { problems, stale, embedded } = generateSharedHooks({ check: true });
  assert.deepEqual(problems, []);
  assert.deepEqual(stale, []);
  assert.ok(embedded >= 2);

  const modules = loadSharedModules();
  const block = (name) => `// <youdede:shared ${name}>\n// </youdede:shared>`;
  const rendered = renderSharedBlocks(`a\n${block('shell')}\n${block('commit-content')}\nb\n`, modules);
  assert.deepEqual(rendered.errors, []);
  assert.equal(renderSharedBlocks(rendered.text, modules).text, rendered.text, 'rendering is idempotent');
  assert.ok(rendered.text.includes('export function parseShellCommands'));
  assert.doesNotMatch(rendered.text, /^import /m);

  const errors = (source) => renderSharedBlocks(source, modules).errors.join('\n');
  assert.match(errors(`${block('shell')}\n${block('shell')}`), /duplicate shared block shell/);
  assert.match(errors('// <youdede:shared shell>\nx'), /shell is not closed/);
  assert.match(errors('x\n// </youdede:shared>'), /closes without an opening marker/);
  assert.match(errors('// <youdede:shared shell>\n// <youdede:shared commit-content>\n// </youdede:shared>'), /opens inside shell/);
  assert.match(errors(block('nope')), /unknown shared module nope/);
  assert.match(errors('// <youdede:shared shell >\n// </youdede:shared>'), /malformed shared marker/);
  assert.match(errors('//<youdede:shared shell>'), /malformed shared marker/);
  assert.match(errors(block('commit-content')), /commit-content requires the shell block/);
});
