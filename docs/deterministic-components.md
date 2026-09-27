# Deterministic components

The toolkit uses AI judgment only where the task genuinely depends on context. Stable parsing, inspection, validation, normalization, and policy decisions should become bundled deterministic code when that improves repeatability without narrowing valid use cases.

## Execution modes

Every `artifact.json` declares an execution contract:

- `prompt`: procedural judgment with no bundled executable entrypoint;
- `hybrid`: an agent-directed workflow that invokes one or more deterministic helpers for stable steps;
- `deterministic`: the artifact's decision boundary is executable code, as with hooks.

Each entrypoint declares its relative path, runtime, purpose, and side-effect class. Repository validation rejects missing or unsafe paths, empty hybrid contracts, prompt artifacts that secretly declare code, non-deterministic hooks, and adapters that fail to package an entrypoint.

## Selection rule

Convert a step into code when all of these are true:

1. the same operation would otherwise be rewritten repeatedly;
2. correct behavior has observable inputs and outputs;
3. generalization does not require guessing project intent;
4. failure can be detected and reported without hidden fallback;
5. the helper can be bounded, tested, and packaged without extra installation work.

Keep a step in the prompt when it depends on product intent, ambiguous evidence, prioritization, or a choice among several valid outcomes. Do not automate merely to increase the deterministic percentage.

## Script contract

Bundled helpers must:

- accept explicit inputs and avoid personal absolute paths;
- use the least side effects possible and never hide network or credential access;
- cap untrusted input, time, subprocess output, and recursion where applicable;
- emit machine-readable or stable plain output and a non-zero status on failure;
- avoid executing data as code;
- have positive, negative, malformed, and boundary tests proportional to risk;
- remain useful across repositories rather than encoding one client's structure.

## One-command installation

Deterministic helpers do not add a second setup step. The artifact adapter maps the `scripts/` directory alongside the skill payload, and the existing installer copies directories recursively. Validation proves that every declared entrypoint is included by every supported adapter.

For example:

> The package is not on npm yet. Until the first publication, run the same command from a checkout with `node bin/youdede-toolkit.mjs` in place of `npx @youdede/toolkit`.

```bash
npx @youdede/toolkit add extract-youtube-captions --target claude-code --scope project
```

installs both `SKILL.md` and its caption normalizer. The skill resolves the helper from its own installed directory; it never assumes where the toolkit repository was cloned.

## Hook gate contract

Every enforceable hook has one protected boundary and a deterministic policy core. Its payload exports a pure `evaluate(input, context?)` function; filesystem or Git collection is isolated in a bounded context collector. Command-hook runtimes use a thin stdin/process wrapper, while OpenCode uses a bounded in-process plugin bridge that invokes the same isolated core before tool execution.

Relevant malformed, oversized, ambiguous, incomplete, or failed inspections block when the artifact explicitly promises that boundary. Irrelevant events and absent optional inputs allow. No hook executes submitted shell text, calls an LLM, downloads a runtime dependency, relies on hook ordering, or reads an agent-writable exception file as proof of human approval.

Claude Code, Codex, Gemini CLI, and Cursor adapters use target-native event names, matchers, time units, ownership markers, and blocking semantics; [targets.md](targets.md) records each runtime's registration format. OpenCode adapters are limited to the verified `tool.execute.before` shell tranche. Repository validation rejects wildcard enforcement matchers, unbounded timeouts, unsupported events, and commands that do not resolve the installed payload. Tests exercise the pure decision, native-shaped envelopes, real process or plugin blocking, malformed input, false-positive controls, and independent install/uninstall.

## Hook verdict snapshot

`quality/hook-verdicts.json` records, for every Claude Code hook and every input of its corpus, the verdict the hook returns today: `exit`, `ruleId` (the `[rule-id]` printed by the hook, or `text:` plus the first detail line when a block has no rule id), and `output` (the keys of the stdout JSON, with decision values). The corpus holds every input the tests feed to each hook, the probes of the repository audit, multi-command sequences (branch change, `cd`, staging, alias in the same command), and a set of everyday developer commands and edits. Each entry names a `fixture`: a list of declarative steps (`write`, `mkdir`, `rm`, `symlink`, `chmod`, `git`, `repo`, `remote`) that `scripts/record-hook-verdicts.mjs` builds in a temporary directory, with a bare remote when the entry needs one. Hooks run as real processes from a staged install layout. `via: "symlink"` runs the hook through a symlinked path. Secrets in fixtures are tokens such as `{{AWS_ACCESS_KEY}}`, assembled at run time.

The snapshot records current behavior, including behavior known to be wrong. Such entries carry `expectation`, for example `should-block per A-hooks-security-1 shell-command-guard.mjs:325`, naming the finding that describes the correct verdict.

`tests/hook-verdicts.test.mjs` (run by `npm test`) recomputes every verdict and fails on any difference; `npm run check:hook-verdicts` runs the same comparison on its own. A verdict may change only on purpose, in the same change that fixes the hook:

1. Add to the affected entry `"change": { "reason": "...", "finding": "<finding or fact id>" }`. Leave `exit`, `ruleId`, and `output` as they are: they stay the baseline.
2. Run `npm run hook-verdicts`. It writes the new verdict into `change` and refuses any other difference, so an unintended regression cannot be recorded by accident.
3. When the fix makes an `expectation` true, keep it: the entry now documents before, after, and why.

The snapshot does not depend on the operating system or the Git version: it gives the same result on macOS with Git 2.54 and on Linux with Git 2.39. When a hook's verdict depends on the Node.js release, the entry records the other verdict under `nodeVariants`, keyed by Node major version, for example `"nodeVariants": {"20": {"ruleId": "mcp-egress-url-invalid"}}`: the WHATWG URL parser of Node 20 and 22 rejects an invalid punycode label that Node 24 accepts. Record the snapshot with the newest Node.js release the CI tests.

To extend the corpus, append an entry without verdict fields (and a fixture if needed), then run `npm run hook-verdicts`; it fills the verdict of new entries only. Every hook must have at least one entry. A fix to a Bash hook adds at least one sequence that combines the fix with a change of branch, directory, or staging in the same command.

## Shared hook modules

Hooks that read Bash commands share one shell analysis instead of each carrying its own lexer. The modules live in `scripts/lib/shared-hook/`: `shell.mjs` splits a command into segments with the operator that follows each (`&&`, `||`, `;`, `|`, `&`, newline), drops a backslash-newline as bash does, expands unquoted brace words statically as bash does (`n{p..p}m` is `npm`), removes quoting (ANSI-C `$'…'` decoded; `$"…"`, translated by the locale at run time, and a word with a glued pattern group such as `r@(m)` or zsh `n(p)m` are dynamic) and the wrappers `sudo`, `doas`, `env`, `nice`, `timeout`, `xargs`, `exec`, `time`, `noglob`, `command`, `builtin`, `nohup`, `setsid`, `stdbuf`, `ionice`, `chrt`, `taskset`, `flock`, `caffeinate`, `unbuffer`, and `chronic`, reads static `sh -c`/`bash -c`/`eval` layers (options and `--` after `-c` included) and `find -exec` actions, reads the commands of `$(…)`, backtick, and `<(…)` substitutions (also inside double quotes, `${…}`, and assignments), skips here-document bodies as data (an unquoted delimiter still runs its substitutions), resolves `$name` after `for name in words`, marks commands after `cd`/`pushd`/`popd`, and parses Git global options (`-C`, `-c`, `--no-pager`, `--git-dir`, `--work-tree`). A shell without `-c` (`curl … | sh`, `sh -s < x`, `bash script.sh`) runs text the hook cannot see, so it is ambiguous; a segment made only of assignments (`x=1`, `SHA=$(git rev-parse HEAD)`) runs no command, and only its substitutions are judged. A command behind a wrapper that is not listed (for example `watch`, `parallel`, `script -c`, `su -c`, `ssh`) is seen as that wrapper, not as the command it runs; `commit-content.mjs` tells what the `git commit` calls of a command will take (`git add -f`, `-a`, pathspecs, `--no-verify` forms, Git aliases); `inline-script.mjs` reads the shell commands written as string literals inside interpreter one-liners (`python -c`, `node -e`, `ruby -e`, `perl -e`, `php -r`, `deno eval`) and whole PowerShell or cmd programs (`pwsh -c`, `cmd /c`). A shell that reads its standard input (`curl … | bash`, `sh -s < file`, `bash` alone) is ambiguous; a shell given a script file (`bash scripts/dev.sh`) is judged like `./scripts/dev.sh` or `make`, whose files no hook reads. An unquoted glob is a file name known only at run time: as the executable (`n[p]m`) it makes the command ambiguous and relevant to every hook, and among the words or options that decide a command a hook protects (`npm pub[l]ish`, `rm -r[f]`) it makes that command uninspectable; a glob after a static verb (`npm test -- src/*.test.js`, `rm -f dist/*.js`) is judged as written. Brace expansion drops unquoted null words (`{,npm} publish` is `npm publish`). Anything the analysis cannot follow is reported as ambiguous, with its segment's text minus the run-time parts, so a word split by an expansion (`n${x}pm`) is still judged whole, and the hook fails closed. Every loop advances or is capped, and nested shells stop at depth 3.

Hooks inspect a command before it runs, and they never execute any part of it. A hook that reads what a commit will take (`commit-guard`, `lockfile-origin-guard`, `executable-permission-guard`, `symlink-publication-guard`, `large-diff-review-guard`, `debug-artifact-guard`, `dependency-change-guard`, `commit-signature-intent-guard`: every hook with the `commit-content` block) reads the index, the working tree, and the Git configuration as they are when the hook runs. A command earlier in the same command line changes them only later, so the hook does not see that change: `echo "$KEY" > a.sh && git commit -am x` passes commit-guard when `a.sh` was clean at check time, `chmod +x metadata.json && git commit -am x` passes executable-permission-guard, and `git config commit.gpgSign false && git commit -m x` passes commit-signature-intent-guard in a repository that signs by default. This is a declared limit, not a block: run the change and the commit as separate tool calls, so the second check sees the changed state.

An installed hook stays one self-contained file. `npm run shared-hooks` (`scripts/generate-shared-hooks.mjs`) copies each module into every payload under `artifacts/` between `// <youdede:shared <name>>` and `// </youdede:shared>`, dropping the imports between sibling modules. `npm run check:shared-hooks`, part of `npm run check`, fails when a copy is stale or a marker is malformed, nested, duplicated, unknown, or missing a block it depends on. Edit the module, never the copy. `tests/shared-hook-shell.test.mjs` holds the probes of the shell and commit-content modules and `tests/shared-hook-inline-script.test.mjs` those of inline-script; its process probes run against every payload that embeds the `shell` block, so a hook that adopts the module is covered without new test code. `shell-command-guard` and `commit-guard` use the modules today.

## Current hybrid skills

Twelve skills are hybrid today:

- `extract-youtube-captions`: deterministic json3 entity decoding and rolling-caption de-duplication;
- `write-session-handoff`: read-only Git revision and working-state collection;
- `author-effective-agent-skill`: structural, metadata, placeholder, and local-link validation;
- `review-database-migration-plan`: bounded, comment-aware classification of conservative SQL risk signals;
- `review-ci-workflow-change`: line-level workflow signal collection without parsing or executing YAML;
- `write-release-notes-from-evidence`: bounded read-only Git range, commit, and changed-file collection;
- `review-schema-evolution`: bounded JSON Schema structural signals with an explicit `not-assessed` verdict;
- `review-supply-chain-change`: offline inventory of bounded manifest, lockfile, lifecycle-script, and workflow-reference signals;
- `enforce-typescript-module-boundaries`: static scan of cross-package deep-import forms under a caller-supplied package root;
- `decompose-dependent-work-slices`: work-item identifier, dependency, acyclicity, order, and ready-frontier validation;
- `author-guided-setup-wizard`: static validation of Bash syntax, secret-handling hazards, confirmation gates, and declared stage count;
- `build-progressive-learning-exercises`: section and exercise identifier, prerequisite, sequence, variant, and objective validation.

Hooks are deterministic by definition. Subagents remain prompt-mode until a reusable checker can cover part of their brief without reducing review quality; their ordinary tool calls alone do not count as bundled deterministic execution.
