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

The file stores each case once (schema 2): its input (`raw` or `input`), `fixture`, `via`, `env`, an `id` (the first 16 hex digits of the SHA-256 of those fields), and a `results` map keyed by hook, whose values hold the `expected` verdict and the hook's `expectation`, `change`, and `nodeVariants`. A `source` shared by every hook of the case is stored on the case. `scripts/lib/hook-verdict-format.mjs` expands the cases into one entry per case and hook when the snapshot is read, and groups them again when it is written, one case per line; the recorder, the tests, and the quarantine gate work on the entries. `scripts/migrate-hook-verdicts-v2.mjs` converted the schema 1 file, which stored one entry per case and hook, and `tests/hook-verdicts-format.test.mjs` proves that the expansion of the migrated file equals those entries, from digests stored in the test, so the proof needs no Git history.

The snapshot records current behavior, including behavior known to be wrong. Such entries carry `expectation`, for example `should-block per A-hooks-security-1 shell-command-guard.mjs:325`, naming the finding that describes the correct verdict.

`tests/hook-verdicts.test.mjs` (run by `npm test`, so by `npm run check` in the CI `verify` job) recomputes every verdict and fails on any difference. To keep it fast, most cases run in process: long-lived worker processes, one per core but one (at least one), so the timing tests that run beside them keep a core, take the case's environment and working directory, call the staged hook's exported `evaluate`, and write what the hook's own main would write (`scripts/lib/hook-verdict-inline.mjs`, one adapter per hook). Each worker reuses its own copy of a fixture for these cases; no adapted hook writes a file. Real hook processes still run the cases about the process itself (`raw` stdin, `via: "symlink"`, size limits, non-object input, rows from process-level tests), the first other case of every hook, so every payload's entrypoint runs, and every case of the four session and compaction hooks, whose mains call the session ledger or write a receipt. A parity sample (every 20th case that can run in process, and each hook's first) runs both ways and fails the test when the two verdicts differ; a case the worker cannot run (the hook throws, or takes longer than a hook process may) runs as a process. `npm run check:hook-verdicts` runs every case as a hook process; the release workflow runs it after `npm run check`, and `npm run hook-verdicts` always records with processes. A verdict may change only on purpose, in the same change that fixes the hook:

1. Add to the affected entry `"change": { "reason": "...", "finding": "<finding or fact id>" }`. Leave `exit`, `ruleId`, and `output` as they are: they stay the baseline.
2. Run `npm run hook-verdicts`. It writes the new verdict into `change` and refuses any other difference, so an unintended regression cannot be recorded by accident.
3. When the fix makes an `expectation` true, keep it: the entry now documents before, after, and why.

An `expectation` is a correctness claim, not a comment. `tests/hook-verdict-gate.test.mjs` fails when an entry's recorded verdict (or its `change`) contradicts its `should-allow` or `should-block` expectation, unless `quality/hook-verdict-quarantine.json` holds a reviewed entry for it: a `hook`, a `reason`, and a `followUp` reference, keyed by the SHA-256 of `[hook, raw, input, fixture, via, env, expectation]`, so reordering keeps the key and any edit of the case or the expectation invalidates it. A stale quarantine entry fails too, and the quarantine may not grow past its reviewed size. A wrong expectation is removed, not quarantined. `node scripts/record-hook-verdicts.mjs --summary [--base REF]` prints the verdicts changed since `REF` (default `HEAD`), grouped by direction, hook, rule, and class; it fails when a change from allow to block names no `REDO-…` class in `change.finding`.

The snapshot does not depend on the operating system or the Git version: it gives the same result on macOS with Git 2.54 and on Linux with Git 2.39. When a hook's verdict depends on the Node.js release, the entry records the other verdict under `nodeVariants`, keyed by Node major version, for example `"nodeVariants": {"20": {"ruleId": "mcp-egress-url-invalid"}}`: the WHATWG URL parser of Node 20 and 22 rejects an invalid punycode label that Node 24 accepts. Record the snapshot with the newest Node.js release the CI tests.

To extend the corpus, add a case, or a hook to the `results` of a case, without `expected` (and a fixture if needed), then run `npm run hook-verdicts`; it fills the verdict of new entries only. Every hook must have at least one entry. A fix to a Bash hook adds at least one sequence that combines the fix with a change of branch, directory, or staging in the same command.

## Shared hook modules

Hooks that read Bash commands share one parser instead of each carrying its own lexer. The modules live in `scripts/lib/shared-hook/`. `shell-items.mjs` (`parseShell`) reads a command the way Bash splits it and returns the items it would run, in order: a command with its executable, words, wrappers, assignments, redirections, and standard-input source; an `unseen` program (one that only exists at run time: fetched from the network, produced by another command, or held in a variable); or a `limit` where the parser stopped (nesting deeper than 3, more than 256 KiB, more than 16 wrappers, unbalanced syntax). Every word is `static`, a `pattern` with known and unknown parts, or `opaque`, so a hook never mistakes an expansion for text. The parser removes the wrappers `sudo`, `doas`, `env` (with `-C` and `-S`), `nice`, `timeout`, `xargs`, `exec`, `time`, `noglob`, `command`, `builtin`, `nohup`, `setsid`, `stdbuf`, `ionice`, `chrt`, `taskset`, `flock`, `caffeinate`, `unbuffer`, and `chronic`, and reads assignment prefixes as facts (`PATH=/tmp rm -rf /` is `rm -rf /`). It reads static `sh -c`/`bash -c`/`eval` programs, PowerShell `-Command` programs, `find -exec` actions, the commands of `$(…)`, backtick, and `<(…)` substitutions, functions defined and called in the same command, `for` loops over static words, and known bytes fed to a shell (`echo WORDS | sh`, a static here-document); a nested program runs under the wrappers of the command that runs it. A network producer's output is an unseen `network` program when a shell or an interpreter without its own script reads it from standard input or `<(…)`, and when a later command of the same call runs the file it wrote (its redirection, `-o`/`-O`/`--output` file, the URL's file name for `curl -O` and `wget`, or a `tee` of it). An interpreter program option with dynamic text is unseen in every attached and `=` form (`python3 -c"$CODE"`), and so is a shell with no script and no `-c` whose standard input is not a static feed. Brace expansion is static; an unquoted glob is a pattern word. A shell given a script file (`bash scripts/dev.sh`) is judged like `./scripts/dev.sh`, whose file no hook reads. Every loop advances or is capped.

Hooks inspect a command before it runs, and they never execute any part of it. A hook with the `commit-content` block reads what a commit will take from the index, the working tree, and the Git configuration as they are when the hook runs. A command earlier in the same command line changes them only later, so the hook does not see that change: `echo "$KEY" > a.sh && git commit -am x` passes commit-guard when `a.sh` was clean at check time, `chmod +x metadata.json && git commit -am x` passes executable-permission-guard, and `git config commit.gpgSign false && git commit -m x` passes commit-signature-intent-guard in a repository that signs by default. This is a declared limit, not a block: run the change and the commit as separate tool calls, so the second check sees the changed state.

`capability.mjs` is the matcher of the capability model that replaces the shared `relevant` flag: a hook declares the commands it protects as data (`CAPABILITY`: families of executables, paths, options that take a value (`values`) or none (`flags`), ordered safe modes, decisive options, and evidence for a dynamic executable), and the matcher returns a concrete rule id, `U` (the hook's uninspectable rule), or not the hook's. Every option role it relies on must be listed in `tests/cli-options.mjs` with its source, because a wrong entry can hide a verb.

A hook judges the items against its own `CAPABILITY` with `capability.mjs`: a static word is compared as text, and any other word with `canMatch`, which asks whether the word can spell a protected literal. An npm command is read as npm resolves it: any unique abbreviation of a command or alias, or its camelCase form, is that command (`npm pu` is `npm publish`, `npm rum dev` is `npm run dev`; the table is npm 11's `lib/utils/cmd-list.js`, compared with the installed npm by `tests/review-findings.test.mjs`); pnpm and Yarn 1 do not abbreviate. The six operation guards, shell-command-guard, and four other hooks also judge the command a package runner starts (`npx npm@10 publish`, `pnpm dlx`, `npm exec`, `uv run`, `poetry run`, `bundle exec`). So `npm pub[l]ish` and `terraform state r[m]` are uninspectable while `npm --no-progress test src/*.test.js` passes, and a dynamic executable is a family's only with evidence among its words (`$CMD -rf /`). An unseen program belongs to shell-command-guard, which refuses it unless it is reviewed shell setup output (`eval "$(pyenv init -)"`); the other hooks refuse one only when its text names a phrase they declare as visible. A limit is uninspectable in every hook. `tests/shared-hook-items.test.mjs` holds the parser contract and its scaling tests, and `tests/shared-hook-capability.test.mjs` judges every critique case, prototype row, and everyday command (`quality/everyday-commands.txt`) through the 31 hook payloads, and checks that exactly those 31 declare a capability.

An installed hook stays one self-contained file. `npm run shared-hooks` (`scripts/generate-shared-hooks.mjs`) copies a shared module into each payload that declares its `// <youdede:shared <name>>` and `// </youdede:shared>` markers, dropping imports between sibling modules. `npm run check:shared-hooks`, part of `npm run check`, fails when a copy is stale or a marker is malformed, nested, duplicated, unknown, or missing a block it depends on. Edit the module, never the copy. The markers identify adopters of `capability`, `shell-items`, `inline`, and `commit-content`; this document does not maintain a payload list. `tests/shared-hook-payloads.test.mjs` runs process probes against every payload that embeds `shell-items`; the module contract suites test the parser, capability matcher, inline programs, and commit intent. `commit-content` builds a typed `CommitIntent` from the same items; an alias definition, forced add, shell alias, or alias of an alias in the same command as a commit is `unsupported`. A capability with `runners: true` also judges the command a package runner starts, including `npx`, `bunx`, `pnpx`, `pnpm exec`, `yarn exec`, `npm exec`, `bundle exec`, `uv run`, and `poetry run`. `inline.mjs` reads interpreter one-liners whose program can run a command: when the program text, or a string literal joined and decoded, concerns what the hook protects, the verdict is the hook's uninspectable rule because the program may not run the string.

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
