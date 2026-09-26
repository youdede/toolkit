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

To extend the corpus, append an entry without verdict fields (and a fixture if needed), then run `npm run hook-verdicts`; it fills the verdict of new entries only. Every hook must have at least one entry. A fix to a Bash hook adds at least one sequence that combines the fix with a change of branch, directory, or staging in the same command.

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
