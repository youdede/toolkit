# Piano: audit completo e correzioni di youdede-toolkit

> **Per chi esegue (agenti):** SUB-SKILL OBBLIGATORIA: usare superpowers:subagent-driven-development (consigliato) oppure superpowers:executing-plans per eseguire il piano task per task. I passi usano checkbox (`- [ ]`). L'esecuzione multi-agente parte solo quando l'utente lo dice esplicitamente.

**Obiettivo:** correggere i difetti verificati nella review del 2026-09-26, leggere e validare integralmente tutti i 315 artifact, i 13 pack e tutti i testi del repository (cosa si dice, cosa si fornisce), e verificare il comportamento su Linux, macOS e Windows, senza introdurre regressioni.

**Architettura:** cinque ondate. Ondata 0 fissa una baseline misurata. Ondata 1 corregge i difetti già verificati con test scritti prima (TDD). Ondata 2 è un audit in sola lettura, parallelo, a lotti, con una rubrica fissa e un formato di output fisso. Ondata 3 corregge ciò che l'audit trova, dopo il triage con l'utente. Ondata 4 riduce il boilerplate delle skill solo dove un test A/B dimostra che non si perde informazione utile. Ondata 5 (condizionata) alleggerisce il pacchetto npm.

**Tech stack:** Node.js >= 20 (ESM, `node:test`, nessuna dipendenza runtime), git, GitHub Actions. Gli hook sono script Node autonomi, copiati uno per uno nei progetti degli utenti.

**Spec:** la sezione "Fatti verificati" di questo documento. Ogni riga ha il comando che la riproduce. Nessun task si basa su qualcosa che non sia in quella tabella, in una decisione dell'utente, o in un passo di verifica esplicito del task stesso.

## Vincoli globali

- Node.js `>=20` (`package.json` `engines`); la CI prova 20, 22, 24.
- Zero dipendenze runtime: `package-lock.json` non contiene pacchetti e deve restare così.
- Ogni hook resta un file autonomo: nessun hook può importare codice condiviso, perché l'installer copia solo i file dichiarati nell'adapter.
- Branch: prefissi ammessi `feat/ fix/ docs/ refactor/ test/ ci/ chore/ security/ release/ codex/ agent/` (`CONTRIBUTING.md`).
- Commit: Conventional Commits, header <= 72 caratteri, riassunto minuscolo, niente punto finale, righe del body <= 100 (`scripts/validate-change-policy.mjs`). Mai il carattere em dash (istruzione utente). Chiudere il messaggio con `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- `main` accetta solo PR squash con check `quality-gate` verde e commit firmati (`CONTRIBUTING.md`). Push, PR, tag e pubblicazioni sono azioni esterne: servono l'ok esplicito dell'utente ogni volta.
- Dopo ogni modifica a un artifact, a `scripts/runtime/` o a un pack, rigenerare con la sequenza "REGEN" qui sotto e poi eseguire `npm run check`.
- Output dell'audit solo in `.youdede-workbench/audit/` (già in `.gitignore`, escluso dal pacchetto da `scripts/verify-package.mjs`).
- Nessun testo di test o di documentazione può contenere un segreto contiguo: costruire le fixture con `['AKIA', 'ABCDEFGHIJKLMNOP'].join('')`, come fanno i test esistenti. `npm run check:secrets` scansiona anche i file del pacchetto.
- Voci CHANGELOG sotto `## Unreleased`, nelle sezioni `### Added`, `### Changed` o `### Fixed`.

Importante: `scripts/lib/install.mjs:189-199` verifica `catalog/integrity.json` prima di ogni installazione, anche nei test. Dopo aver modificato un file coperto dall integrità (artifact o `scripts/runtime/`), eseguire `npm run integrity` PRIMA di qualunque step che esegue test di installazione (`tests/install.test.mjs`, `tests/multi-target.test.mjs`, `tests/packs.test.mjs`, `tests/mcp-trust.test.mjs`, `tests/cli.test.mjs`). Senza, falliscono con `failed published integrity verification`. Errore del piano segnalato dall agente del Task 1.

Sequenza **REGEN** (corretta dopo i rapporti dei Task 4 e 7: `npm run mcp` copia `scripts/runtime/readonly-mcp-server.mjs` dentro le cartelle degli artifact MCP, coperte da `catalog/integrity.json` e copiate da `npm run marketplaces`; quindi i generatori che scrivono in `artifacts/` vanno prima di `marketplaces` e `integrity`):

```bash
npm run contexts && npm run mcp && npm run prompt-evaluations && npm run pack-evaluations && npm run marketplaces && npm run catalog && npm run integrity && npm run catalog:docs && npm run capability:docs && npm run docs:stats
```

## Review Focus

1. Un progetto con `.env` non ignorato da git e un comando `npm test && git commit -m x`: deve restare permesso (nessuno staging nello stesso comando). Il test è nel Task 1.
2. `git push` su un branch di feature con upstream sullo stesso branch: deve essere permesso; con upstream su `main` deve essere bloccato. Il test è nel Task 2.
3. `grep -r foo src` in un progetto che ha `.env` solo nella root: deve essere permesso (la cartella cercata non lo contiene). Il test è nel Task 3.
4. `read_file` MCP su `.env.example`: deve restare permesso (è un template, non un segreto). Il test è nel Task 4.
5. Reinstallare subito dopo aver rimosso l'ultimo artifact (la cartella `.youdede-toolkit` non esiste più): l'installazione deve riuscire e `doctor` non deve segnalare nulla. Il test è nel Task 8. La gara tra due processi concorrenti non è riproducibile in modo deterministico con `node:test`: il Task 8 la gestisce nel codice (nuovo tentativo su ENOENT) e lo dichiara, senza un test che finga di coprirla.

---

## Fatti verificati (baseline del 2026-09-26)

Ambiente di verifica: macOS Darwin 25.6.0, Node v24.21.0, git 2.54.0, commit `93d55df`.

| ID | Fatto | Come riprodurlo |
| --- | --- | --- |
| F1 | `npm run check` esce con 0; 358 test, 0 falliti, circa 316 s di test. | `npm run check` |
| F2 | `npm run check:readiness` fallisce: `SEMANTIC_BENCHMARK_DIGEST_MISMATCH`, `SEMANTIC_EVIDENCE_STALE`, coperture statica e dinamica incomplete. | `npm run check:readiness` |
| F3 | `commit-guard` permette (exit 0) `git add .env && git commit -m x`, `git commit -am x` e `git commit -m x app.txt` con una chiave AWS finta nel file. Blocca solo se il file è già in staging. | fixture in un repo temporaneo, input JSON su stdin a `commit-guard.mjs` |
| F4 | `protected-branch-guard` permette `git config alias.ship "push --force origin feature:main"` seguito da `git ship`; il push arriva davvero su `main` di un remote bare locale. | vedi Task 2, test |
| F5 | Stessa cosa con `git config remote.origin.push refs/heads/feature:refs/heads/main` + `git push origin feature`. | vedi Task 2 |
| F6 | Il guard permette `git send-pack`, `echo x \| xargs git push origin` e `find ... -exec git push ...`. | input JSON al guard |
| F7 | `git push` senza argomenti è sempre bloccato, anche su un branch di feature; un test lo richiede (`tests/hook-repository-boundaries.test.mjs`, caso `['git push', 'protected-git-command-uninspectable']`). | idem |
| F8 | `git rev-parse --symbolic-full-name @{push}` restituisce la destinazione reale: `refs/remotes/origin/feature/config` con upstream feature; `refs/remotes/origin/main` con `push.default=upstream` e upstream main, e con `remote.origin.push` che mappa su main; fallisce (exit 128) senza upstream o con `simple` non risolvibile. `git for-each-ref --format='%(push:remotename)' refs/heads/<b>` restituisce `origin`. `%(push:remoteref)` è vuoto nei casi comuni, quindi non va usato. `git config --get-regexp` esce con 1 quando non trova chiavi. | script in un repo temporaneo |
| F9 | `sensitive-file-access-guard` permette `grep -r K= .` e `python3 -c "print(open('.env').read())"`; il secondo caso è documentato come limite, il primo no. `grep -r`/`-R`/`-d recurse` leggono `.env`; `rg` senza opzioni no; `rg --hidden` e `rg -uu` sì. | fixture + input JSON; `rg`/`grep` in una cartella con `.env` |
| F10 | Il matcher dell'adapter Claude Code di `sensitive-file-access-guard` è `Read\|Write\|Edit\|MultiEdit\|NotebookEdit\|Grep\|Bash\|PowerShell`: non copre i tool MCP. | `artifacts/hooks/security/secrets/sensitive-file-access-guard/adapters/claude-code.json:17` |
| F11 | L'MCP `workspace-files-readonly` dichiara `secretAccess: ["none"]` ma `read_file` su `.env` restituisce il contenuto. Il pack `mcp-baseline` lo include. | server avviato con il suo `server.json` come profilo |
| F12 | Il server MCP risponde con qualunque `protocolVersion` riceve (provato `1999-01-01`) e usa `-32600` anche per JSON non parsabile. | `scripts/runtime/readonly-mcp-server.mjs:176-181,209-213` |
| F13 | `verify-integrity commit-guard` dice "No integrity drift found" dopo aver manomesso l'hook installato; `doctor` invece segnala `modified`. README riga 103 dice che `verify-integrity` confronta "what you installed". `docs/integrity.md:12` è corretto. | add, modifica il file, esegui entrambi |
| F14 | Dopo `add` + `remove` il `settings.json` dell'utente ha lo stesso contenuto JSON ma formattazione diversa, e resta `.claude/.youdede-toolkit/state.json` con `installs: {}`. README riga 122 dice "restores exactly what it replaced". | add/remove in una dir temporanea, `diff` |
| F15 | `docs/governance.md:27` dice che la CI gira su Linux, macOS e Windows. `validate.yml` gira solo su `ubuntu-latest`. macOS e Windows c'erano in `45f754e` e sono stati tolti in `aa1ae5c` (#5). | `git log -S"windows-latest" -- .github/workflows/validate.yml` |
| F16 | `npm view @youdede/toolkit` risponde 404 e il repo GitHub è privato; il README istruisce `npx @youdede/toolkit ...`. | `npm view @youdede/toolkit`; `gh repo view udede/toolkit --json isPrivate` |
| F17 | Il CHANGELOG ha le sezioni 0.2.0 e 0.3.0 con data, ma esiste solo il tag `v0.1.0` (locale e remoto). L'intestazione del CHANGELOG dice che le release sono verificate contro il tag. | `git ls-remote --tags origin` |
| F18 | In `release.yml` il job `publish` rifà il checkout con `ref: ${{ inputs.tag }}` senza lo SHA verificato nel job `verify`. | `.github/workflows/release.yml` |
| F19 | 20 script di hook contengono ciascuno un proprio lexer della shell; nessun hook importa codice condiviso. | `grep -lE "function (lexShell\|tokenizeShell\|...)"` sugli script degli hook |
| F20 | 143 dei 167 `SKILL.md` contengono le stesse 348 parole; le righe presenti in almeno 10 skill sono 2796 su 6031 righe non vuote. Nessuno script o test richiede quel testo (`git grep` in `scripts/` e `tests/` senza risultati). Il parser dei contratti (`scripts/lib/output-contract.mjs`) legge solo il primo paragrafo dopo `## Output contract`. | `uniq -c` sui `SKILL.md` |
| F21 | Le evaluation di command e context (18 file, 72 casi) sono generate da un template in cui cambia solo lo slug; 41 subagent condividono lo stesso prompt "boundary". I casi non vengono eseguiti su un modello; il README lo dice correttamente in `docs/evaluations.md`. | `scripts/generate-prompt-evaluations.mjs` |
| F22 | Nessuno script del repo chiama un modello; le evidenze semantiche (`quality/release-evidence/semantic-release-evidence.json`, 2026-08-26) sono prodotte da un processo esterno. | `grep` su `scripts/` |
| F23 | Tarball npm: 4,76 MB compressi, 15,06 MB scompattati, 3734 file. Contiene `docs/assets/cover.png` (2,59 MB), `docs/assets/social-preview.jpg` (0,35 MB), `skills/` (0,92 MB) e `plugins/` (1,43 MB). Nessun percorso di `bin/` o `scripts/lib/` legge `skills/` o `plugins/` della root. `scripts/verify-package.mjs` non li richiede. | `npm pack --dry-run --json` |
| F24 | Per il target Codex, scope project, `.codex/hooks.json` contiene il percorso assoluto della macchina. Cosa fa Codex se il file non esiste più: non verificato. | `add commit-guard --target codex` in una dir con spazi |
| F25 | `withStateLock` (`scripts/lib/install.mjs:156-160`) cancella un lock scaduto per nome: due processi possono entrambi riprenderlo. Dedotto dal codice, non riprodotto. | lettura del codice |
| F26 | I corpi dei subagent sono identici tra i target Claude Code, Gemini CLI e OpenCode; Copilot aggiunge la riga "Complete the brief within N turns...". Oggi 0 divergenze su 62 subagent, ma nessun validatore lo controlla (`scripts/lib/catalog.mjs:805-837` controlla solo frontmatter e rifiuti). | script di confronto nel Task 9 |
| F27 | Cose fatte bene e da non rompere: scritture atomiche e anti-symlink dell'installer; `--dry-run` non scrive file; flag sconosciuti rifiutati; hook fail-closed su input malformato; `GIT_*` rimossi; segreti mai ristampati; action CI fissate per SHA; input non fidati passati via `env`. | test esistenti |
| F28 | Con 10 suite complete in parallelo (carico della macchina circa 150), `tests/install.test.mjs` gira fino a 1248 s e fallisce come file intero; fallisce anche il test "concurrency: simultaneous appenders receive unique monotonic sequence numbers" del session ledger. Il ledger rieseguito da solo passa (`fail 0`, branch di T1); la riprova isolata di `install.test.mjs` era ancora in corso quando è stato scritto. Da capire se è solo lentezza o una dipendenza reale dai tempi (timeout del lock a 30 s, soglia del lock scaduto a 120 s). | log `.youdede-workbench/*-check.log` nei worktree dell'Ondata 1 |

## Decisioni

Decise dall'utente il 2026-09-26:

- **D1** "Device" significa sistemi operativi: Linux, macOS, Windows.
- **D5** (2026-09-26, dopo la stima dei costi di Actions fatta dall'agente del Task 5) La CI resta com'è oggi: solo `ubuntu-latest`, Node 20, 22, 24. Il Task 5 è annullato. Il comportamento su macOS si verifica in locale; quello su Windows resta non verificato finché non c'è una macchina Windows.
- **D2** Le ricerche e copie ricorsive che includono un file con segreti vanno bloccate; l'agente può escludere il file (`--exclude`) o restringere il percorso.
- **D3** `git push` senza argomenti: chiedere a git la destinazione reale e bloccare solo se è protetta.
- **D4** Ridurre il boilerplate delle skill e correggere i difetti, senza togliere informazioni utili. "Utile" va dimostrato: vedi Ondata 4.

Decise dall'utente il 2026-09-26, seconda risposta:

- **P1** Alleggerire il tarball npm (Task 14): approvato, a condizione che non rompa nulla. Il Task 14 si ferma e riporta se lo Step 1 trova un consumatore, o se `npm run check` fallisce dopo la modifica.
- **P2** Tag mancanti v0.2.0 e v0.3.0 (F17) e **P3** evidenze semantiche (F2, F22): li gestisce l'utente con il suo processo automatico. Fuori dal perimetro degli agenti; nessun task li tocca.

---

## Ondata 0: baseline e regole di esecuzione

### Task 0: baseline misurata

**File:**
- Create: `.youdede-workbench/audit/baseline/` (non tracciato)

- [ ] **Step 1: registrare lo stato di partenza**

```bash
mkdir -p .youdede-workbench/audit/baseline
git rev-parse HEAD > .youdede-workbench/audit/baseline/commit.txt
node --version > .youdede-workbench/audit/baseline/node.txt
npm run check > .youdede-workbench/audit/baseline/check.log 2>&1; echo "exit=$?" >> .youdede-workbench/audit/baseline/check.log
npm pack --dry-run --json > .youdede-workbench/audit/baseline/pack.json 2>/dev/null
cp catalog/integrity.json .youdede-workbench/audit/baseline/integrity.json
```

Atteso: `check.log` termina con `exit=0` e contiene `ℹ pass 358`. Se il numero è diverso, il repo è cambiato dopo questa review: aggiornare la tabella dei fatti prima di proseguire.

- [ ] **Step 2: regole per l'esecuzione multi-agente**

1. Un worktree git per agente (superpowers:using-git-worktrees), un branch per task.
2. I file generati (`catalog/*.json`, `plugins/**`, `skills/**`, `.claude-plugin/**`, `.codex-plugin/**`, `.agents/**`, `docs/catalog/**`, `docs/capability-matrix.md`, i contatori nel README) li rigenera solo l'integratore, dopo ogni merge, con REGEN. Gli agenti eseguono REGEN solo nel proprio worktree per far passare `npm run check`, e l'integratore lo riesegue dopo il rebase.
3. Ordine dei merge nell'Ondata 1: Task 1, 2, 3, 4, 7 (hook e runtime), poi 8, 9, 6, 5, infine 10 (documentazione, che dipende da 5 e 8).
4. Dopo ogni merge l'integratore esegue `npm run check` sul branch integrato. Un fallimento blocca i merge successivi.

---

## Ondata 1: correzioni dei difetti verificati (parallelizzabili)

### Task 1: commit-guard ispeziona anche il working tree quando il commit lo include

Risolve F3.

**File:**
- Modify: `artifacts/hooks/security/secrets/commit-guard/targets/claude-code/commit-guard.mjs`
- Modify: `artifacts/hooks/security/secrets/commit-guard/targets/claude-code/README.md`
- Test: `tests/hooks.test.mjs`
- Modify: `CHANGELOG.md`

**Interfacce:**
- Consuma: `evaluate(input, cwd)`, `inspectStaged(cwd)`, `scanText`, `isSensitivePath` già presenti nel file.
- Produce: `export function commitReadsWorkingTree(tokens): boolean`, `export function inspectWorkingTree(cwd): { files: string[], findings: string[] }`, `export const MAX_WORKTREE_FILES = 5000`. Firma di `evaluate` invariata (gli adapter Codex, Cursor, Gemini e OpenCode copiano lo stesso file come `commit-guard.core.mjs`).

- [ ] **Step 1: scrivere il test che fallisce** (in fondo a `tests/hooks.test.mjs`)

```js
test('commit guard inspects content that the same command stages or commits from the working tree', (context) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'youdede-commit-worktree-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  git(directory, ['init', '-q']);
  git(directory, ['config', 'user.email', 'tests@youdede.invalid']);
  git(directory, ['config', 'user.name', 'youdede tests']);
  writeFileSync(path.join(directory, 'app.js'), 'export const value = 1;\n');
  git(directory, ['add', 'app.js']);
  git(directory, ['commit', '-qm', 'baseline']);

  const fixtureKey = ['AKIA', 'ABCDEFGHIJKLMNOP'].join('');
  writeFileSync(path.join(directory, 'app.js'), `export const key = "${fixtureKey}";\n`);
  for (const command of [
    'git commit -am x',
    'git commit -a -m x',
    'git commit --all -m x',
    'git commit -m x app.js',
    'git commit -m x -- app.js',
    'git commit -i -m x app.js',
    'git add app.js && git commit -m x',
    'git add -A; git commit -m x',
    'git stage . && git commit -m x'
  ]) {
    const verdict = evaluateCommit({ cwd: directory, tool_input: { command } });
    assert.equal(verdict.exitCode, 2, command);
    assert.match(verdict.message, /AWS access key id/, command);
    assert.doesNotMatch(verdict.message, /AKIA/, command);
  }

  writeFileSync(path.join(directory, 'app.js'), 'export const value = 2;\n');
  writeFileSync(path.join(directory, '.env'), `KEY=${fixtureKey}\n`);
  const env = evaluateCommit({ cwd: directory, tool_input: { command: 'git add .env && git commit -m x' } });
  assert.equal(env.exitCode, 2);
  assert.match(env.message, /\.env: sensitive file type/);

  // Unchanged: without a staging step or a working-tree commit form, only the index is inspected.
  assert.equal(evaluateCommit({ cwd: directory, tool_input: { command: 'git commit -m x' } }).exitCode, 0);
  assert.equal(evaluateCommit({ cwd: directory, tool_input: { command: 'npm test && git commit -m x' } }).exitCode, 0);
  assert.equal(evaluateCommit({ cwd: directory, tool_input: { command: 'git commit -S -m x' } }).exitCode, 0);
});

test('commit working-tree detection follows commit option syntax', () => {
  const tokens = (text) => text.split(' ').map((value) => ({ value, dynamic: false }));
  for (const args of ['-am x', '-a -m x', '--all -m x', '-m x app.js', '-m x -- app.js', '--only -m x', '--include -m x', '-p', '--interactive', '--pathspec-from-file=list.txt']) {
    assert.equal(commitReadsWorkingTree(tokens(args)), true, args);
  }
  for (const args of ['-m x', '-F msg.txt', '--amend --no-edit', '-S -m x', '-Sdeadbeef -m x', '-C HEAD', '--author=me -m x', '-s -m x', '-uno -m x']) {
    assert.equal(commitReadsWorkingTree(tokens(args)), false, args);
  }
});
```

Aggiungere `commitReadsWorkingTree` all'import esistente da `commit-guard.mjs` in cima al file di test.

- [ ] **Step 2: eseguire il test e vederlo fallire**

Run: `node --test --test-name-pattern "working tree|working-tree detection" tests/hooks.test.mjs`
Atteso: FAIL (`commitReadsWorkingTree` non esportata; `git commit -am x` restituisce exitCode 0).

- [ ] **Step 3: implementare**

In `commit-guard.mjs`, sostituire la riga di import `import { realpathSync } from 'node:fs';` con:

```js
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
```

Dopo `export const MAX_COMMAND_BYTES = 256 * 1024;` aggiungere:

```js
export const MAX_WORKTREE_FILES = 5000;

// Git subcommands that can change what the index holds before a later `git commit` in the same
// command runs. The hook sees the index before any of them execute.
const STAGING_SUBCOMMANDS = new Set([
  'add', 'stage', 'rm', 'mv', 'apply', 'update-index', 'restore', 'checkout', 'switch', 'reset',
  'read-tree', 'stash', 'merge', 'pull', 'cherry-pick', 'revert', 'am'
]);
const COMMIT_VALUE_OPTIONS = new Set([
  '-m', '--message', '-F', '--file', '-C', '--reuse-message', '-c', '--reedit-message', '--author',
  '--date', '--fixup', '--squash', '-t', '--template', '--cleanup', '--trailer'
]);
const COMMIT_WORKTREE_OPTION = /^--(?:all|include|only|interactive|patch|pathspec-from-file(?:=.*)?)$/;
const SHORT_WORKTREE_FLAGS = new Set(['a', 'i', 'o', 'p']);
const SHORT_VALUE_NEXT = new Set(['m', 'F', 'C', 'c', 't']);
const SHORT_VALUE_ATTACHED = new Set(['S', 'u']);

// True when the commit takes content from the working tree rather than only from the index:
// -a/--all, --include, --only, --interactive, --patch, --pathspec-from-file, or a pathspec.
export function commitReadsWorkingTree(tokens) {
  for (let index = 0; index < tokens.length; index += 1) {
    const value = tokens[index].value;
    if (value === '--') return index + 1 < tokens.length;
    if (COMMIT_VALUE_OPTIONS.has(value)) { index += 1; continue; }
    if (COMMIT_WORKTREE_OPTION.test(value)) return true;
    if (value.startsWith('--')) continue;
    if (/^-[A-Za-z]/.test(value)) {
      for (let cursor = 1; cursor < value.length; cursor += 1) {
        const flag = value[cursor];
        if (SHORT_WORKTREE_FLAGS.has(flag)) return true;
        if (SHORT_VALUE_ATTACHED.has(flag)) break;
        if (SHORT_VALUE_NEXT.has(flag)) {
          if (cursor === value.length - 1) index += 1;
          break;
        }
      }
      continue;
    }
    return true;
  }
  return false;
}
```

Sostituire l'intera funzione `analyzeCommit` con:

```js
function analyzeCommit(command) {
  const normalized = normalizeShellCommands(command);
  if (normalized.error || normalized.commands.some((entry) => entry.ambiguous)) return { ambiguous: true };
  let changedDirectory = false;
  let stagedEarlier = false;
  for (const entry of normalized.commands) {
    if (!entry.tokens?.length) continue;
    const executable = executableName(entry.tokens[0]);
    if (executable === 'cd' || executable === 'pushd') { changedDirectory = true; continue; }
    if (executable !== 'git') continue;
    let index = 1;
    let unsupportedScope = changedDirectory;
    while (index < entry.tokens.length) {
      const token = entry.tokens[index];
      if (token.dynamic) return { ambiguous: true };
      const value = token.value;
      if (value === '--') { index += 1; break; }
      if (!value.startsWith('-')) break;
      if (/^(?:-C|--git-dir|--work-tree)(?:=|$)/.test(value)) unsupportedScope = true;
      const takesValue = ['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env', '--exec-path'].includes(value);
      index += takesValue ? 2 : 1;
    }
    const subcommand = entry.tokens[index];
    if (subcommand?.dynamic) return { ambiguous: true };
    if (subcommand?.value === 'commit') {
      const tokens = entry.tokens.slice(index + 1);
      return { found: true, unsupportedScope, tokens, worktree: stagedEarlier || commitReadsWorkingTree(tokens) };
    }
    if (STAGING_SUBCOMMANDS.has(subcommand?.value)) stagedEarlier = true;
  }
  return { found: false };
}
```

Dopo la funzione `inspectStaged` aggiungere:

```js
// A superset of what the commit can contain: tracked files with unstaged changes plus untracked,
// non-ignored files. Deleted files cannot add content and are skipped.
export function inspectWorkingTree(cwd) {
  const raw = git(['ls-files', '-z', '--modified', '--others', '--exclude-standard'], cwd);
  const files = [...new Set(raw.split('\0').filter(Boolean).map(normalizeRelative))];
  if (files.length > MAX_WORKTREE_FILES) {
    return { files, findings: [`working tree has ${files.length} candidate files; limit is ${MAX_WORKTREE_FILES}. Stage explicitly in a separate command or ignore generated files`] };
  }
  const findings = [];
  for (const file of files) {
    if (isSensitivePath(file)) findings.push(`${file}: sensitive file type is present in the working tree`);
    let data;
    try {
      const absolute = path.join(cwd, file);
      const metadata = lstatSync(absolute);
      if (!metadata.isFile()) continue;
      if (metadata.size > DEFAULT_MAX_FILE_BYTES) {
        findings.push(`${file}: working-tree file is ${metadata.size} bytes; limit is ${DEFAULT_MAX_FILE_BYTES}`);
        continue;
      }
      data = readFileSync(absolute);
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      findings.push(`${file}: working-tree file could not be inspected (${error?.code || 'unknown error'})`);
      continue;
    }
    if (data.includes(0)) continue;
    findings.push(...scanText(file, data.toString('utf8')));
  }
  return { files, findings };
}
```

In `evaluate`, sostituire:

```js
    const result = inspectStaged(input?.cwd || cwd);
    if (result.findings.length === 0) return { exitCode: 0, message: '' };
    const visible = result.findings.slice(0, 20).map((finding) => `- ${finding}`).join('\n');
    const remainder = result.findings.length > 20 ? `\n- …and ${result.findings.length - 20} more` : '';
```

con:

```js
    const root = input?.cwd || cwd;
    const staged = inspectStaged(root);
    const worktree = intent.worktree ? inspectWorkingTree(root) : { findings: [] };
    const findings = [...new Set([...staged.findings, ...worktree.findings])];
    if (findings.length === 0) return { exitCode: 0, message: '' };
    const visible = findings.slice(0, 20).map((finding) => `- ${finding}`).join('\n');
    const remainder = findings.length > 20 ? `\n- …and ${findings.length - 20} more` : '';
```

- [ ] **Step 4: eseguire i test del file**

Run: `node --test tests/hooks.test.mjs tests/multi-target.test.mjs`
Atteso: PASS, inclusi i test preesistenti.

- [ ] **Step 5: documentare il comportamento e i limiti**

In `targets/claude-code/README.md`, dopo il primo paragrafo, aggiungere:

```markdown
When the same command stages content before the commit (`git add … && git commit`, `git stage`, `git rm`, and similar) or the commit reads the working tree (`-a`, `--all`, `--include`, `--only`, `--patch`, `--interactive`, `--pathspec-from-file`, or a pathspec), the hook also scans tracked files with unstaged changes and untracked, non-ignored files. That set is larger than what the commit can contain, so an unrelated untracked file with a secret also blocks; add it to `.gitignore` or stage explicitly in a separate command. More than 5000 candidate files block instead of being scanned partially.
```

Nella lista "Refusals and limits" aggiungere:

```markdown
- It does not detect staging performed by a script, interpreter, or alias that the same command runs.
```

Voce CHANGELOG sotto `## Unreleased` → `### Fixed`:

```markdown
- `commit-guard` now scans the working tree when the same command stages content or the commit takes content from the working tree (`-a`, pathspecs, `--include`, `--only`). Before, `git add .env && git commit` and `git commit -am` were allowed because the index was inspected before the staging ran.
```

- [ ] **Step 6: REGEN, check completo, commit**

```bash
npm run contexts && npm run mcp && npm run prompt-evaluations && npm run pack-evaluations && npm run marketplaces && npm run catalog && npm run integrity && npm run catalog:docs && npm run capability:docs && npm run docs:stats
npm run check
git add -A && git commit -m "fix(hooks): scan working tree when a commit stages or reads it"
```

Atteso: `npm run check` esce con 0. Se `check:catalog` o un altro check chiede un aumento di versione dell'artifact, seguire esattamente il messaggio e ripetere lo step.

### Task 2: protected-branch-guard risolve destinazione del push, alias, mapping e runner

Risolve F4, F5, F6, F7 secondo la decisione D3.

**File:**
- Modify: `artifacts/hooks/operations/git/protected-branch-guard/targets/claude-code/protected-branch-guard.mjs`
- Modify: il README accanto allo script (`targets/claude-code/`), se presente; altrimenti la voce `description` resta invariata
- Test: `tests/hook-repository-boundaries.test.mjs`
- Modify: `CHANGELOG.md`

**Interfacce:**
- Consuma: `collectContext(input, options)`, `evaluate(input, context)`, `normalizeShell`, `parseGitInvocation`, `isProtected`, `block`.
- Produce: nuovi campi del contesto `aliases: Map<string,string>`, `pushConfiguredRemotes: Set<string>`, `pushRemote: string|null`, `pushBranch: string|null`. Nuova funzione interna `expandAlias(parsed, context, depth)`.

- [ ] **Step 1: scrivere il test che fallisce** (in fondo a `tests/hook-repository-boundaries.test.mjs`)

```js
test('protected branch resolves push destinations, aliases, push mappings, and command runners', (context) => {
  const parent = temporary(context, 'youdede-branch-config-');
  const remote = path.join(parent, 'remote.git');
  const root = path.join(parent, 'work');
  mkdirSync(root);
  git(parent, ['init', '-q', '--bare', remote]);
  initRepository(root, 'main');
  git(root, ['remote', 'add', 'origin', remote]);
  git(root, ['push', '-q', '-u', 'origin', 'main']);
  git(root, ['switch', '-qc', 'feature/config']);
  git(root, ['push', '-q', '-u', 'origin', 'feature/config']);
  const decide = (command) => branchDecision({ tool_name: 'Bash', cwd: root, tool_input: { command } }, root);

  assert.equal(decide('git push').exitCode, 0);
  assert.equal(decide('git push origin').exitCode, 0);
  assert.equal(decide('git push --force').exitCode, 0);

  git(root, ['branch', '-q', '-u', 'origin/main']);
  git(root, ['config', 'push.default', 'upstream']);
  assert.equal(decide('git push').ruleId, 'protected-branch-direct-push');
  git(root, ['config', '--unset', 'push.default']);
  git(root, ['branch', '-q', '-u', 'origin/feature/config']);

  git(root, ['config', 'alias.ship', 'push --force origin feature/config:main']);
  assert.equal(decide('git ship').ruleId, 'protected-branch-direct-push');
  git(root, ['config', 'alias.st', 'status']);
  assert.equal(decide('git st').exitCode, 0);
  git(root, ['config', 'alias.run', '!git push origin feature/config:main']);
  assert.equal(decide('git run').ruleId, 'protected-git-command-uninspectable');

  git(root, ['config', 'remote.origin.push', 'refs/heads/feature/config:refs/heads/main']);
  assert.equal(decide('git push origin feature/config').ruleId, 'protected-git-command-uninspectable');
  assert.equal(decide('git push').ruleId, 'protected-branch-direct-push');
  assert.equal(decide('git push origin feature/config:feature/config').exitCode, 0);
  git(root, ['config', '--unset', 'remote.origin.push']);

  assert.equal(decide(`git send-pack ${remote} feature/config:main`).ruleId, 'protected-git-command-uninspectable');
  assert.equal(decide('echo main | xargs git push origin').ruleId, 'protected-command-uninspectable');
  assert.equal(decide('find . -maxdepth 0 -exec git push origin feature/config:main \\;').ruleId, 'protected-command-uninspectable');
  assert.equal(decide('find . -name "*.md" -exec git status \\;').exitCode, 0);
});
```

- [ ] **Step 2: eseguire e vedere fallire**

Run: `node --test --test-name-pattern "push destinations" tests/hook-repository-boundaries.test.mjs`
Atteso: FAIL alla prima asserzione (`git push` oggi è bloccato, F7).

- [ ] **Step 3: implementare la raccolta del contesto**

In `collectContext`, sostituire la riga finale `return { repo: true, inspectionError: false, currentBranch, defaultBranch, detached };` con:

```js
  const config = git(['config', '--get-regexp', '^(alias\\..*|remote\\..*\\.push)$']);
  if (config.error || ![0, 1].includes(config.status)) return { repo: true, inspectionError: true };
  const aliases = new Map();
  const pushConfiguredRemotes = new Set();
  for (const line of config.status === 0 ? config.stdout.split('\n') : []) {
    const separator = line.indexOf(' ');
    const key = separator < 0 ? line : line.slice(0, separator);
    const value = separator < 0 ? '' : line.slice(separator + 1);
    if (key.startsWith('alias.')) aliases.set(key.slice('alias.'.length).toLowerCase(), value);
    else if (/^remote\..+\.push$/.test(key)) pushConfiguredRemotes.add(key.slice('remote.'.length, -'.push'.length));
  }

  // `@{push}` is Git's own answer to "where would a bare `git push` write"; it honours push.default,
  // upstream, and remote.<name>.push, and fails when the answer is not a single destination.
  let pushRemote = null;
  let pushBranch = null;
  if (currentBranch) {
    const remoteName = git(['for-each-ref', '--format=%(push:remotename)', `refs/heads/${currentBranch}`]);
    const destination = git(['rev-parse', '--symbolic-full-name', '@{push}']);
    if (remoteName.error || destination.error) return { repo: true, inspectionError: true };
    const prefix = `refs/remotes/${remoteName.stdout}/`;
    if (remoteName.status === 0 && remoteName.stdout && destination.status === 0 && destination.stdout.startsWith(prefix)) {
      pushRemote = remoteName.stdout;
      pushBranch = destination.stdout.slice(prefix.length);
    }
  }

  return { repo: true, inspectionError: false, currentBranch, defaultBranch, detached, aliases, pushConfiguredRemotes, pushRemote, pushBranch };
```

- [ ] **Step 4: implementare la valutazione**

Prima di `function inspectGit` aggiungere:

```js
const RELEVANT_SUBCOMMANDS = new Set(['push', 'send-pack', 'http-push', 'branch', 'update-ref', 'checkout', 'switch', 'symbolic-ref', 'remote', ...HISTORY_MUTATIONS]);
const COMMAND_RUNNERS = new Set(['xargs', 'find', 'parallel', 'watch']);

// Git runs an alias only when no built-in command has that name, so a configured alias is
// expanded once and re-inspected. Shell aliases (`!…`) and aliases of aliases are not expanded.
function expandAlias(parsed, context, depth = 0) {
  const alias = context.aliases?.get(parsed.subcommand);
  if (alias === undefined) return parsed;
  if (depth > 0 || alias.trimStart().startsWith('!')) return { ambiguous: true };
  const normalized = normalizeShell(`git ${alias}`);
  if (normalized.error || normalized.invocations.length !== 1) return { ambiguous: true };
  const expanded = parseGitInvocation([...normalized.invocations[0], ...parsed.args]);
  if (!expanded || expanded.ambiguous) return { ambiguous: true };
  return expandAlias(expanded, context, depth + 1);
}
```

All'inizio di `inspectGit`, subito dopo `if (parsed.ambiguous) return block(...)`, aggiungere:

```js
  if (parsed.subcommand === 'send-pack' || parsed.subcommand === 'http-push') {
    return block('protected-git-command-uninspectable', 'a low-level push command can update a protected branch');
  }
```

In `inspectPush`, sostituire il blocco da `const refspecs = remoteFromOption ? operands : operands.slice(1);` fino alla chiusura del ciclo `for (const refspec of refspecs)` con:

```js
  const remote = remoteFromOption ? null : (operands[0] ?? null);
  const refspecs = remoteFromOption ? operands : operands.slice(1);
  if (refspecs.length === 0) {
    if (context.pushBranch && (remote === null || remote === context.pushRemote)) {
      return isProtected(context.pushBranch, context)
        ? block('protected-branch-direct-push', 'the configured push destination is a protected branch')
        : null;
    }
    const rule = context.currentBranch && protectedBranches(context).has(context.currentBranch)
      ? 'protected-branch-direct-push' : 'protected-git-command-uninspectable';
    return block(rule, 'the configured upstream push destination cannot be verified statically');
  }
  const mapped = remote === null ? (context.pushConfiguredRemotes?.size ?? 0) > 0 : Boolean(context.pushConfiguredRemotes?.has(remote));
  for (const refspec of refspecs) {
    if (/[*?[]/.test(refspec)) return block('protected-git-command-uninspectable', 'a wildcard refspec can include a protected branch');
    const separator = refspec.lastIndexOf(':');
    if (separator < 0 && mapped) {
      return block('protected-git-command-uninspectable', 'the remote has a configured push mapping that can redirect this refspec');
    }
    const destination = separator >= 0 ? refspec.slice(separator + 1) : refspec;
    if (!destination) return block('protected-git-command-uninspectable', 'a push destination is empty or ambiguous');
    if (isProtected(destination, context)) {
      return block(deleting || refspec.startsWith(':') ? 'protected-branch-delete' : 'protected-branch-direct-push', deleting || refspec.startsWith(':')
        ? 'the push deletes a protected remote branch'
        : 'the push writes directly to a protected remote branch');
    }
  }
```

Nel ciclo di `evaluate`, subito dopo `if (['cd', 'pushd', 'popd'].includes(name)) { scopeChanged = true; continue; }`, aggiungere:

```js
    if (COMMAND_RUNNERS.has(name)) {
      const gitIndex = invocation.findIndex((token) => executable(token) === 'git');
      if (gitIndex >= 0) {
        const next = invocation.slice(gitIndex + 1).find((token) => !token.value.startsWith('-'));
        if (!next || next.dynamic || RELEVANT_SUBCOMMANDS.has(next.value.toLowerCase())) {
          return block('protected-command-uninspectable', 'a command runner can start a Git mutation with arguments the guard cannot see');
        }
      }
      continue;
    }
```

Sostituire:

```js
    const parsed = parseGitInvocation(invocation);
    if (!parsed) continue;
```

con:

```js
    const raw = parseGitInvocation(invocation);
    if (!raw) continue;
    const parsed = raw.ambiguous ? raw : expandAlias(raw, context);
```

e nella riga `const relevant = [...]` usare `RELEVANT_SUBCOMMANDS.has(parsed.subcommand)`.

- [ ] **Step 5: eseguire i test**

Run: `node --test tests/hook-repository-boundaries.test.mjs`
Atteso: PASS, inclusi i casi preesistenti `['git push', 'protected-git-command-uninspectable']` e `['git push origin', ...]`: nella loro fixture non c'è un remote, quindi `@{push}` fallisce e il blocco resta.

- [ ] **Step 6: misurare il costo aggiunto**

Il guard ora esegue 3 comandi git in più per ogni chiamata Bash. Misurare su questo repo:

```bash
S=artifacts/hooks/operations/git/protected-branch-guard/targets/claude-code/protected-branch-guard.mjs
for i in 1 2 3 4 5; do /usr/bin/time -p sh -c "printf '%s' '{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"ls\"}}' | node $S" 2>&1 | grep real; done
```

Riportare i tempi nel messaggio di PR (prima e dopo, con `git stash` di una copia del file originale in `/tmp`). Nessuna soglia inventata: il dato va solo mostrato all'utente.

- [ ] **Step 7: documentare, REGEN, check, commit**

Voce CHANGELOG `### Fixed`:

```markdown
- `protected-branch-guard` resolves a bare `git push` through Git's own `@{push}` and blocks only a protected destination; it expands Git aliases once, treats refspecs on remotes with a `remote.<name>.push` mapping as uninspectable, and blocks `send-pack` and command runners (`xargs`, `find -exec`) that start a relevant Git subcommand. Before, an alias or a push mapping could force-push to `main`.
```

Aggiornare il README dell'hook con gli stessi punti e con il limite: "Shell aliases (`!…`) and aliases of aliases are blocked as uninspectable".

```bash
npm run contexts && npm run mcp && npm run prompt-evaluations && npm run pack-evaluations && npm run marketplaces && npm run catalog && npm run integrity && npm run catalog:docs && npm run capability:docs && npm run docs:stats
npm run check
git add -A && git commit -m "fix(hooks): resolve push destinations and git aliases in branch guard"
```

### Task 3: sensitive-file-access-guard blocca letture ricorsive che includono segreti

Risolve F9 secondo la decisione D2.

**File:**
- Modify: `artifacts/hooks/security/secrets/sensitive-file-access-guard/targets/claude-code/sensitive-file-access-guard.mjs`
- Modify: il README accanto allo script
- Test: `tests/hook-data-boundaries.test.mjs`
- Create: `.youdede-workbench/audit/grep-tool.md` (non tracciato)
- Modify: `CHANGELOG.md`

**Interfacce:**
- Consuma: `collectCandidates`, `pathOperands`, `inspectPath`, `isSensitivePath`, `collectRuntimeContext`, `evaluate`.
- Produce: `export const MAX_RECURSIVE_ENTRIES = 20000`, `export function globToRegExp(glob): RegExp|null`, `export function directoryHoldsSensitive(root, options): { sensitive?: true, error?: true }`. I candidati possono avere `recursive: { hidden: boolean, excludes: RegExp[], excludeDirs: RegExp[], includes: RegExp[] }`. Nuovo ruleId `sensitive-path-recursive`.

- [ ] **Step 1: verificare il comportamento del tool Grep di Claude Code** (passo manuale, non si deduce)

In una sessione Claude Code aperta su una cartella temporanea con `.env` contenente `YOUDEDE_MARKER_1` e `src/a.txt` contenente `YOUDEDE_MARKER_1`, chiedere di usare il tool Grep con pattern `YOUDEDE_MARKER_1`, `output_mode: "content"`, senza `path`. Registrare in `.youdede-workbench/audit/grep-tool.md` la versione di Claude Code (`claude --version`) e se `.env` compare nei risultati. Ripetere con `path: "."`.

Esito atteso: un booleano `GREP_TOOL_READS_HIDDEN`, osservato.

- [ ] **Step 2: scrivere il test che fallisce** (in fondo a `tests/hook-data-boundaries.test.mjs`)

```js
test('sensitive file guard blocks recursive reads whose tree contains a credential file', (context) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'youdede-sensitive-recursive-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(path.join(directory, 'src'));
  writeFileSync(path.join(directory, 'src', 'app.js'), 'export {};\n');
  writeFileSync(path.join(directory, '.env'), 'RECURSIVE_SECRET=never-print-this\n');
  const decide = (command) => {
    const input = { cwd: directory, tool_name: 'Bash', tool_input: { command } };
    return evaluateSensitive(input, collectRuntimeContext(input));
  };

  for (const command of [
    'grep -r KEY .',
    'grep -R KEY',
    'grep -rn KEY .',
    'grep --recursive KEY .',
    'grep -d recurse KEY .',
    'rg --hidden KEY',
    'rg -uu KEY .',
    'tar -cf /tmp/youdede-unused.tar .',
    'cp -r . /tmp/youdede-unused-copy',
    'zip -r /tmp/youdede-unused.zip .'
  ]) {
    const result = decide(command);
    assert.equal(result.ruleId, 'sensitive-path-recursive', command);
    assert.doesNotMatch(result.message, /\.env|RECURSIVE_SECRET|never-print-this/, command);
  }

  for (const command of [
    'grep -r KEY src',
    "grep -r --exclude='.env*' KEY .",
    'grep -r --exclude=.env KEY .',
    'rg KEY',
    'rg KEY .',
    "rg --hidden -g '!.env' KEY",
    'grep KEY src/app.js',
    'cp src/app.js /tmp/youdede-unused-file'
  ]) {
    assert.equal(decide(command).exitCode, 0, command);
  }
});

test('sensitive file guard fails closed when a recursive tree exceeds the analysis bound', (context) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'youdede-sensitive-bound-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  for (let index = 0; index < 20001; index += 1) writeFileSync(path.join(directory, `f${index}.txt`), '');
  const input = { cwd: directory, tool_name: 'Bash', tool_input: { command: 'grep -r KEY .' } };
  assert.equal(evaluateSensitive(input, collectRuntimeContext(input)).ruleId, 'sensitive-path-uninspectable');
});

test('glob translation covers the exclusion forms the guard honours', () => {
  assert.equal(globToRegExp('.env*').test('.env'), true);
  assert.equal(globToRegExp('.env*').test('.env.local'), true);
  assert.equal(globToRegExp('*.{ts,tsx}').test('a.tsx'), true);
  assert.equal(globToRegExp('*.{ts,tsx}').test('a.js'), false);
  assert.equal(globToRegExp('file?.md').test('file1.md'), true);
  assert.equal(globToRegExp('{unbalanced'), null);
});
```

Aggiungere `globToRegExp` all'import dal modulo del guard.

- [ ] **Step 3: eseguire e vedere fallire**

Run: `node --test --test-name-pattern "recursive|glob translation" tests/hook-data-boundaries.test.mjs`
Atteso: FAIL (`globToRegExp` non esportata; `grep -r KEY .` restituisce exitCode 0).

- [ ] **Step 4: implementare**

Sostituire la riga di import `import { lstatSync, realpathSync } from 'node:fs';` con:

```js
import { lstatSync, readdirSync, realpathSync, statSync } from 'node:fs';
```

Dopo la definizione di `OPTION_PATHS` aggiungere:

```js
export const MAX_RECURSIVE_ENTRIES = 20000;
// Options whose value is the next token; without this the value would be read as a path operand.
const VALUE_OPTIONS = new Map([
  ['grep', new Set(['--exclude', '--exclude-dir', '--include', '-d', '--directories', '-m', '--max-count', '-A', '-B', '-C', '--context'])],
  ['rg', new Set(['-g', '--glob', '-t', '--type', '-T', '--type-not', '-m', '--max-count', '-A', '-B', '-C', '-j', '--threads'])]
]);

export function globToRegExp(glob) {
  let source = '';
  let braces = 0;
  for (const character of glob) {
    if (character === '*') source += '[^/]*';
    else if (character === '?') source += '[^/]';
    else if (character === '{') { braces += 1; source += '(?:'; }
    else if (character === '}' && braces > 0) { braces -= 1; source += ')'; }
    else if (character === ',' && braces > 0) source += '|';
    else source += character.replace(/[.+^$()|[\]\\]/g, '\\$&');
  }
  return braces === 0 ? new RegExp(`^${source}$`) : null;
}

// A glob that cannot be translated is dropped, so nothing is excluded by it: the walk then sees
// more files, never fewer.
function compileGlobs(values) {
  return values.map((value) => globToRegExp(value.split('/').at(-1))).filter(Boolean);
}

function optionValues(tokens, names) {
  const values = [];
  for (let index = 1; index < tokens.length; index += 1) {
    const value = tokens[index].value;
    const equals = value.indexOf('=');
    const name = equals < 0 ? value : value.slice(0, equals);
    if (!names.has(name)) continue;
    if (equals >= 0) values.push(value.slice(equals + 1));
    else if (tokens[index + 1]) values.push(tokens[index + 1].value);
  }
  return values;
}

function recursiveReadMode(executable, tokens) {
  const values = tokens.slice(1).map((token) => token.value);
  if (executable === 'grep') {
    const recursive = values.some((value) => /^-[A-Za-z]*[rR][A-Za-z]*$/.test(value)
      || ['--recursive', '--dereference-recursive', '--directories=recurse'].includes(value))
      || values.some((value, index) => value === '-d' && values[index + 1] === 'recurse');
    if (!recursive) return null;
    return {
      hidden: true,
      excludes: compileGlobs(optionValues(tokens, new Set(['--exclude']))),
      excludeDirs: compileGlobs(optionValues(tokens, new Set(['--exclude-dir']))),
      includes: compileGlobs(optionValues(tokens, new Set(['--include'])))
    };
  }
  if (executable === 'rg') {
    const globs = optionValues(tokens, new Set(['-g', '--glob']));
    return {
      hidden: values.some((value) => value === '--hidden' || value === '-.' || /^-u{2,}$/.test(value)),
      excludes: compileGlobs(globs.filter((glob) => glob.startsWith('!')).map((glob) => glob.slice(1))),
      excludeDirs: [],
      includes: compileGlobs(globs.filter((glob) => !glob.startsWith('!')))
    };
  }
  if (executable === 'tar') {
    return { hidden: true, excludes: compileGlobs(optionValues(tokens, new Set(['--exclude']))), excludeDirs: [], includes: [] };
  }
  if (executable === 'cp') {
    const recursive = values.some((value) => /^-[A-Za-z]*[rRa][A-Za-z]*$/.test(value) || ['--recursive', '--archive'].includes(value));
    return recursive ? { hidden: true, excludes: [], excludeDirs: [], includes: [] } : null;
  }
  if (executable === 'zip') {
    const recursive = values.some((value) => /^-[A-Za-z]*[rR][A-Za-z]*$/.test(value) || value === '--recurse-paths');
    return recursive ? { hidden: true, excludes: [], excludeDirs: [], includes: [] } : null;
  }
  return null;
}

export function directoryHoldsSensitive(root, options) {
  const pending = [root];
  let visited = 0;
  while (pending.length) {
    const directory = pending.pop();
    let entries;
    try { entries = readdirSync(directory, { withFileTypes: true }); } catch { return { error: true }; }
    for (const entry of entries) {
      visited += 1;
      if (visited > MAX_RECURSIVE_ENTRIES) return { error: true };
      if (!options.hidden && entry.name.startsWith('.')) continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        // ponytail: .git is skipped for speed; its config can hold a credential URL, which this
        // guard never listed as a protected path. Add it here if that list grows.
        if (entry.name === '.git' || options.excludeDirs.some((pattern) => pattern.test(entry.name))) continue;
        if (isSensitivePath(absolute)) return { sensitive: true };
        pending.push(absolute);
        continue;
      }
      if (options.excludes.some((pattern) => pattern.test(entry.name))) continue;
      if (options.includes.length && !options.includes.some((pattern) => pattern.test(entry.name))) continue;
      if (isSensitivePath(absolute)) return { sensitive: true };
    }
  }
  return { sensitive: false };
}
```

In `pathOperands`, nel ciclo sui token, subito dopo il blocco che gestisce `['-e', '--regexp', '--expression']`, aggiungere:

```js
    if (VALUE_OPTIONS.get(executable)?.has(token.value)) { index += 1; continue; }
```

e sostituire la parte finale della funzione, da `if (SEARCH_COMMANDS.has(executable) || SCRIPT_COMMANDS.has(executable)) {` fino a `return { candidates, ambiguous: false };`, con:

```js
  let operands = [];
  if (SEARCH_COMMANDS.has(executable) || SCRIPT_COMMANDS.has(executable)) operands = positionals.slice(explicitPattern ? 0 : 1);
  else if (SIMPLE_FILE_COMMANDS.has(executable)) operands = positionals;
  const recursive = recursiveReadMode(executable, tokens);
  if (recursive && operands.length === 0 && SEARCH_COMMANDS.has(executable)) operands = [{ value: '.', dynamic: false }];
  candidates.push(...(recursive ? operands.map((token) => ({ ...token, recursive })) : operands));
  return { candidates, ambiguous: false };
```

`zip` non è in `SIMPLE_FILE_COMMANDS`: aggiungerlo all'elenco, altrimenti il codice sopra non lo raggiunge.

In `collectCandidates`, nella deduplicazione, sostituire la chiave con:

```js
    const key = `${candidate.dynamic ? '1' : '0'}:${candidate.recursive ? 'r' : ''}:${candidate.value}`;
```

Sostituire `collectRuntimeContext` con:

```js
export function collectRuntimeContext(input) {
  const analysis = collectCandidates(input);
  const cwd = typeof input?.cwd === 'string' && input.cwd ? input.cwd : process.cwd();
  return {
    pathFacts: analysis.candidates.map((candidate) => {
      if (candidate.dynamic) return null;
      const fact = inspectPath(candidate.value, cwd);
      if (!candidate.recursive || fact.error || !fact.exists) return fact;
      let metadata;
      try { metadata = statSync(fact.resolvedPath); } catch { return { error: true }; }
      if (!metadata.isDirectory()) return fact;
      return { ...fact, recursive: directoryHoldsSensitive(fact.resolvedPath, candidate.recursive) };
    })
  };
}
```

In `evaluate`, subito dopo il controllo `sensitive-path-alias`, aggiungere:

```js
    if (fact?.recursive?.error) return blocked('sensitive-path-uninspectable', 'a recursive file operation covers more entries than the bounded analyzer can verify');
    if (fact?.recursive?.sensitive) {
      return blocked('sensitive-path-recursive', 'a recursive file operation would include a high-confidence credential or secret file; exclude it or narrow the path');
    }
```

- [ ] **Step 5: applicare l'esito dello Step 1 al tool Grep**

Solo se `GREP_TOOL_READS_HIDDEN` è `true`: in `collectCandidates`, nel ramo `DIRECT_TOOLS`, quando `name === 'grep'`, sostituire i candidati con:

```js
    const grepTargets = direct.values.length ? direct.values : [{ value: '.', dynamic: false }];
    const include = typeof data?.glob === 'string' ? compileGlobs([data.glob]) : [];
    const candidates = grepTargets.map((candidate) => ({ ...candidate, recursive: { hidden: true, excludes: [], excludeDirs: [], includes: include } }));
```

e aggiungere al test dello Step 2:

```js
  const grepTool = { cwd: directory, tool_name: 'Grep', tool_input: { pattern: 'KEY' } };
  assert.equal(evaluateSensitive(grepTool, collectRuntimeContext(grepTool)).ruleId, 'sensitive-path-recursive');
  const grepTyped = { cwd: directory, tool_name: 'Grep', tool_input: { pattern: 'KEY', glob: '*.js' } };
  assert.equal(evaluateSensitive(grepTyped, collectRuntimeContext(grepTyped)).exitCode, 0);
```

Se è `false`, non cambiare il ramo del tool Grep e aggiungere al README dell'hook: "The Claude Code Grep tool skips hidden files (observed with Claude Code <versione> on <data>), so a recursive Grep does not read `.env`."

- [ ] **Step 6: eseguire i test**

Run: `node --test tests/hook-data-boundaries.test.mjs`
Atteso: PASS, inclusi i casi esistenti (`grep '.env' README.md` resta permesso: `README.md` è un file, non una cartella).

- [ ] **Step 7: documentare, REGEN, check, commit**

README dell'hook, nuovo paragrafo:

```markdown
Recursive reads (`grep -r`/`-R`/`--recursive`/`-d recurse`, `rg --hidden` or `-uu`, `tar`, `cp -r`/`-a`, `zip -r`) are blocked when the searched directory contains a protected file. `--exclude`, `--exclude-dir`, `--include` (grep), `--exclude` (tar), and `-g`/`--glob` (rg) are honoured for file and directory names. Plain `rg` skips hidden files and is checked the same way. `.git` is not walked. A tree larger than 20000 entries is blocked as uninspectable; narrow the path or exclude large directories.
```

Voce CHANGELOG `### Fixed`:

```markdown
- `sensitive-file-access-guard` blocks recursive searches, archives, and copies whose directory contains a protected file. Before, `grep -r KEY .` printed `.env`.
```

```bash
npm run contexts && npm run mcp && npm run prompt-evaluations && npm run pack-evaluations && npm run marketplaces && npm run catalog && npm run integrity && npm run catalog:docs && npm run capability:docs && npm run docs:stats
npm run check
git add -A && git commit -m "fix(hooks): block recursive reads that include credential files"
```

### Task 4: il runtime MCP read-only rifiuta i file con credenziali

Risolve F11 (la dichiarazione `secretAccess: ["none"]` diventa vera anche per i file).

**File:**
- Modify: `scripts/runtime/readonly-mcp-server.mjs`
- Modify: `artifacts/mcp-servers/development/agent-tooling/workspace-files-readonly/THREAT.md`
- Modify: `artifacts/mcp-servers/development/agent-tooling/repository-git-readonly/THREAT.md`
- Test: `tests/mcp-trust.test.mjs`
- Modify: `CHANGELOG.md`

**Interfacce:**
- Produce: `export function isSensitiveWorkspacePath(relative: string): boolean`, con regole identiche a `isSensitivePath` di `sensitive-file-access-guard` (verificate da un test).

- [ ] **Step 1: scrivere il test che fallisce** (in fondo a `tests/mcp-trust.test.mjs`)

```js
import { isSensitiveWorkspacePath } from '../scripts/runtime/readonly-mcp-server.mjs';
import { isSensitivePath as guardIsSensitive } from '../artifacts/hooks/security/secrets/sensitive-file-access-guard/targets/claude-code/sensitive-file-access-guard.mjs';

test('workspace MCP runtime refuses credential files it declares no access to', (context) => {
  const workspace = mkdtempSync(path.join(os.tmpdir(), 'youdede-mcp-secret-'));
  context.after(() => rmSync(workspace, { recursive: true, force: true }));
  writeFileSync(path.join(workspace, 'profile.json'), readFileSync('artifacts/mcp-servers/development/agent-tooling/workspace-files-readonly/server.json'));
  writeFileSync(path.join(workspace, '.env'), 'API_KEY=never-return-this\n');
  writeFileSync(path.join(workspace, '.env.example'), 'API_KEY=\n');
  mkdirSync(path.join(workspace, 'config'));
  writeFileSync(path.join(workspace, 'config', 'id_ed25519'), 'PRIVATE-KEY-BODY\n');
  writeFileSync(path.join(workspace, 'notes.txt'), 'public\n');
  const call = (id, name, args) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
  const requests = [
    call(1, 'read_file', { path: '.env' }),
    call(2, 'read_file', { path: 'config/id_ed25519' }),
    call(3, 'read_file', { path: '.env.example' }),
    call(4, 'read_file', { path: 'notes.txt' }),
    call(5, 'search_files', { query: 'env' }),
    call(6, 'list_directory', { path: '.' })
  ];
  const run = spawnSync(process.execPath, [path.resolve('scripts/runtime/readonly-mcp-server.mjs'), '--profile', 'profile.json'], {
    cwd: workspace,
    input: `${requests.map((request) => JSON.stringify(request)).join('\n')}\n`,
    encoding: 'utf8'
  });
  assert.equal(run.status, 0, run.stderr);
  const results = new Map(run.stdout.trim().split('\n').map((line) => JSON.parse(line)).map((message) => [message.id, message.result]));
  assert.doesNotMatch(run.stdout, /never-return-this|PRIVATE-KEY-BODY/);
  assert.equal(results.get(1).isError, true);
  assert.equal(results.get(2).isError, true);
  assert.equal(results.get(3).content[0].text, 'API_KEY=\n');
  assert.equal(results.get(4).content[0].text, 'public\n');
  assert.doesNotMatch(results.get(5).content[0].text, /(^|\n)\.env(\n|$)/);
  assert.match(results.get(5).content[0].text, /\.env\.example/);
  assert.doesNotMatch(results.get(6).content[0].text, /\t\.env(\n|$)/);
});

test('workspace MCP credential rules match the sensitive file guard', () => {
  for (const relative of ['.env', '.env.local', '.env.example', 'app/.env.production.sample', 'id_rsa', 'keys/id_ed25519', '.ssh/config', '.ssh/deploy', '.aws/credentials', '.aws', '.kube/config', '.npmrc', '.netrc', '.pypirc', '.docker/config.json', '.config/gh/hosts.yml', 'src/app.js', 'README.md']) {
    assert.equal(isSensitiveWorkspacePath(relative), guardIsSensitive(`/${relative}`), relative);
  }
});
```

Spostare i due `import` nella sezione import in cima al file (i moduli ESM non accettano import dopo il codice).

- [ ] **Step 2: eseguire e vedere fallire**

Run: `node --test tests/mcp-trust.test.mjs`
Atteso: FAIL (`isSensitiveWorkspacePath` non esportata).

- [ ] **Step 3: implementare**

In `readonly-mcp-server.mjs`, dopo `const isPrivateDirectory = ...` aggiungere le costanti copiate byte per byte dal guard (`SAFE_ENV_SUFFIXES`, `SENSITIVE_DIRECTORY_SUFFIXES`, `SAFE_SSH_FILES`, `EXACT_CREDENTIAL_SUFFIXES`, `SSH_PRIVATE_KEY`, righe 37-52 di `sensitive-file-access-guard.mjs`) e:

```js
// Same rules as sensitive-file-access-guard; tests/mcp-trust.test.mjs compares the two. The
// runtime is copied alone into user projects, so it cannot import the guard.
export function isSensitiveWorkspacePath(relative) {
  const normalized = `/${String(relative).replaceAll('\\', '/').split('/').filter((part) => part && part !== '.').join('/')}`.toLowerCase();
  const basename = normalized.split('/').at(-1);
  if (basename.startsWith('.env') && SAFE_ENV_SUFFIXES.some((suffix) => basename.endsWith(suffix))) return false;
  if (basename === '.env' || basename.startsWith('.env.')) return true;
  if (SSH_PRIVATE_KEY.test(normalized)) return true;
  if (normalized.includes('/.ssh/') && !basename.endsWith('.pub') && !SAFE_SSH_FILES.has(basename)) return true;
  if (SENSITIVE_DIRECTORY_SUFFIXES.some((suffix) => normalized.endsWith(suffix))) return true;
  return EXACT_CREDENTIAL_SUFFIXES.some((suffix) => normalized.endsWith(suffix));
}

function rejectSensitivePath(workspace, candidate) {
  if (isSensitiveWorkspacePath(path.relative(workspace, candidate))) {
    throw new Error('path is a credential file that this profile declares no access to');
  }
}
```

Prima di scrivere il codice, confrontare `isSensitiveWorkspacePath` con `isSensitivePath` del guard riga per riga: il guard gestisce anche forme `@file` e `<file` (`embedded`), che qui non servono perché l'input è un percorso. Il test dello Step 1 fissa l'equivalenza sui percorsi.

In `existingWorkspacePath`, dopo ciascuna delle due chiamate `rejectPrivatePath(...)`, aggiungere la chiamata corrispondente `rejectSensitivePath(workspace, target)` e `rejectSensitivePath(workspace, resolved)`.

In `walk`, subito dopo `const relative = ...`, aggiungere:

```js
    if (isSensitiveWorkspacePath(relative)) continue;
```

In `list_directory`, nel `.filter(...)`, aggiungere la condizione:

```js
      .filter((entry) => !isPrivateDirectory(entry.name) && !isSensitiveWorkspacePath(path.relative(workspace, path.join(resolved, entry.name))))
```

In `git_diff`, dopo `args.push('--');` e l'eventuale percorso, aggiungere le esclusioni:

```js
    const CREDENTIAL_PATHSPECS = ['**/.env', '**/.env.*', '**/id_rsa', '**/id_dsa', '**/id_ecdsa', '**/id_ed25519', '**/.ssh/**', '**/.aws/**', '**/.azure/**', '**/.kube/**', '**/.config/gcloud/**', '**/.git-credentials', '**/.netrc', '**/.npmrc', '**/.pypirc', '**/.docker/config.json', '**/.config/gh/hosts.yml'];
    args.push(...CREDENTIAL_PATHSPECS.map((pattern) => `:(exclude,glob)${pattern}`));
```

Aggiungere al test dello Step 1 un caso git che lo verifica davvero:

```js
test('repository MCP diff omits tracked credential files', (context) => {
  const workspace = mkdtempSync(path.join(os.tmpdir(), 'youdede-mcp-diff-'));
  context.after(() => rmSync(workspace, { recursive: true, force: true }));
  const git = (args) => assert.equal(spawnSync('git', args, { cwd: workspace, env: cleanGitEnvironment() }).status, 0, args.join(' '));
  git(['init', '-q']);
  git(['config', 'user.email', 'tests@youdede.invalid']);
  git(['config', 'user.name', 'youdede tests']);
  writeFileSync(path.join(workspace, '.env'), 'A=1\n');
  writeFileSync(path.join(workspace, 'app.txt'), 'one\n');
  git(['add', '.']);
  git(['commit', '-qm', 'baseline']);
  writeFileSync(path.join(workspace, '.env'), 'A=never-return-this\n');
  writeFileSync(path.join(workspace, 'app.txt'), 'two\n');
  writeFileSync(path.join(workspace, 'profile.json'), readFileSync('artifacts/mcp-servers/development/agent-tooling/repository-git-readonly/server.json'));
  const request = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'git_diff', arguments: {} } };
  const run = spawnSync(process.execPath, [path.resolve('scripts/runtime/readonly-mcp-server.mjs'), '--profile', 'profile.json'], { cwd: workspace, input: `${JSON.stringify(request)}\n`, encoding: 'utf8' });
  const text = JSON.parse(run.stdout.trim()).result.content[0].text;
  assert.match(text, /\+two/);
  assert.doesNotMatch(text, /never-return-this/);
});
```

(importare `cleanGitEnvironment` da `./git-env.mjs`). Nota: `profile.json` è un file non tracciato nella fixture e non entra in `git diff`.

- [ ] **Step 4: eseguire i test**

Run: `node --test tests/mcp-trust.test.mjs`
Atteso: PASS. Se il caso `git_diff` fallisce perché git rifiuta una pathspec di sola esclusione, riportare l'errore esatto e fermarsi: non cambiare approccio senza l'utente.

- [ ] **Step 5: aggiornare i THREAT.md, REGEN, check, commit**

In entrambi i THREAT.md aggiungere: "Credential files recognised by `sensitive-file-access-guard` are refused by `read_file`, omitted from `search_files` and `list_directory`, and excluded from `git_diff`." (nel secondo solo la parte `git_diff`).

Voce CHANGELOG `### Fixed`:

```markdown
- The read-only MCP runtime refuses credential files (`.env`, private keys, cloud credentials) that its profiles declare no access to. Before, `read_file` returned `.env` content.
```

```bash
npm run contexts && npm run mcp && npm run prompt-evaluations && npm run pack-evaluations && npm run marketplaces && npm run catalog && npm run integrity && npm run catalog:docs && npm run capability:docs && npm run docs:stats
npm run check:mcp && npm run check
git add -A && git commit -m "fix(mcp): refuse credential files in the read-only runtime"
```

`check:mcp` verifica gli hash delle descrizioni dei tool: le descrizioni non cambiano, quindi deve passare. Se fallisce, riportare l'output.

### Task 5: CI su Linux, macOS e Windows (ANNULLATO, decisione D5)

Non eseguire. Resta qui solo come riferimento.

Risolve F15 secondo la decisione D1.

**File:**
- Modify: `.github/workflows/validate.yml`
- Modify: file che falliscono su macOS o Windows (sconosciuti finché la CI non gira; vedi Step 3)

- [ ] **Step 1: estendere la matrice**

In `validate.yml`, nel job `verify`, sostituire il blocco `matrix: include: ...` con:

```yaml
      matrix:
        os: [ubuntu-latest, macos-latest, windows-latest]
        node: [20, 22, 24]
```

Il job `quality-gate` richiede già `needs.verify.result == success`, quindi copre i nove job senza modifiche al ruleset.

- [ ] **Step 2: far girare la CI**

Serve un push del branch e una PR: azione esterna, chiedere l'ok all'utente. Poi: `gh run watch` sul run della PR. Salvare i log dei job falliti in `.youdede-workbench/audit/os/<os>-<node>.log` con `gh run view <id> --log-failed`.

- [ ] **Step 3: correggere un fallimento alla volta**

Per ogni test fallito, usare superpowers:systematic-debugging. Due soli esiti ammessi:
1. È un difetto reale sul sistema operativo: correggere il codice con un test che fallisce prima.
2. Il comportamento non esiste su quel sistema (per esempio permessi POSIX su Windows): aggiungere `{ skip: process.platform === 'win32' }` come fanno già 7 test del repo, e una riga in `docs/targets.md` che dice cosa non è coperto su Windows e perché.

Vietato: aumentare timeout senza misurare, saltare test su un OS senza la riga in `docs/targets.md`.

Casi già noti da controllare per primi (dedotti dal codice, non ancora osservati): i test che usano `symlinkSync` (`tests/install.test.mjs`, `tests/hook-data-boundaries.test.mjs`, `tests/repository-governance.test.mjs`) e il controllo del bit di esecuzione in `scripts/lib/catalog.mjs:852`, che è già escluso su `win32`.

- [ ] **Step 4: commit**

```bash
git add -A && git commit -m "ci: run the check suite on linux, macos, and windows"
```

Con un commit separato per ogni correzione dello Step 3.

### Task 6: il job di publish usa lo SHA verificato

Risolve F18.

**File:**
- Modify: `.github/workflows/release.yml`
- Test: `tests/release-workflow.test.mjs`

- [ ] **Step 1: test che fallisce**

```js
test('publish checks out the exact commit that verify inspected', () => {
  assert.match(workflow, /^    outputs:\n      sha: \$\{\{ steps\.tag-commit\.outputs\.sha \}\}/m);
  assert.match(workflow, /echo "sha=\$\(git rev-parse "\$TAG\^\{commit\}"\)" >> "\$GITHUB_OUTPUT"/);
  assert.match(workflow, /ref: \$\{\{ needs\.verify\.outputs\.sha \}\}/);
});
```

Run: `node --test tests/release-workflow.test.mjs` → atteso FAIL.

- [ ] **Step 2: implementare**

Nel job `verify`, sotto `timeout-minutes: 15`, aggiungere:

```yaml
    outputs:
      sha: ${{ steps.tag-commit.outputs.sha }}
```

Dopo lo step "Require a signed, annotated tag" aggiungere:

```yaml
      - name: Record the verified tag commit
        id: tag-commit
        env:
          TAG: ${{ inputs.tag }}
        run: echo "sha=$(git rev-parse "$TAG^{commit}")" >> "$GITHUB_OUTPUT"
```

Nel job `publish`, nel checkout, sostituire `ref: ${{ inputs.tag }}` con `ref: ${{ needs.verify.outputs.sha }}`.

- [ ] **Step 3: test e commit**

Run: `node --test tests/release-workflow.test.mjs` → PASS.

```bash
git add -A && git commit -m "ci(release): publish the commit the verify job inspected"
```

### Task 7: versione del protocollo e codici di errore del server MCP

Risolve F12.

**File:**
- Modify: `scripts/runtime/readonly-mcp-server.mjs`
- Test: `tests/mcp-trust.test.mjs`

- [ ] **Step 1: verificare le versioni del protocollo** (passo di ricerca, non si deduce)

Leggere la pagina ufficiale delle versioni della specifica MCP su `modelcontextprotocol.io` e registrare in `.youdede-workbench/audit/mcp-versions.md` l'URL, la data di lettura e l'elenco delle versioni pubblicate. Il server usa solo `initialize`, `tools/list`, `tools/call` con contenuto testuale e `isError`: annotare per ogni versione se queste parti sono invariate. Tenere solo le versioni per cui la risposta è sì.

- [ ] **Step 2: test che fallisce**

```js
test('MCP runtime negotiates a supported protocol version and reports parse errors', (context) => {
  const workspace = mkdtempSync(path.join(os.tmpdir(), 'youdede-mcp-protocol-'));
  context.after(() => rmSync(workspace, { recursive: true, force: true }));
  writeFileSync(path.join(workspace, 'profile.json'), readFileSync('artifacts/mcp-servers/development/agent-tooling/workspace-files-readonly/server.json'));
  const input = [
    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '1999-01-01' } }),
    JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: SUPPORTED_PROTOCOL_VERSIONS.at(-1) } }),
    'not json'
  ].join('\n');
  const run = spawnSync(process.execPath, [path.resolve('scripts/runtime/readonly-mcp-server.mjs'), '--profile', 'profile.json'], { cwd: workspace, input: `${input}\n`, encoding: 'utf8' });
  const [first, second, third] = run.stdout.trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(first.result.protocolVersion, SUPPORTED_PROTOCOL_VERSIONS[0]);
  assert.equal(second.result.protocolVersion, SUPPORTED_PROTOCOL_VERSIONS.at(-1));
  assert.equal(third.error.code, -32700);
});
```

Importare `SUPPORTED_PROTOCOL_VERSIONS` dal runtime.

- [ ] **Step 3: implementare**

```js
// Newest first. Only versions whose initialize, tools/list, and tools/call shapes this server
// implements unchanged; the source and date are in the pull request.
export const SUPPORTED_PROTOCOL_VERSIONS = Object.freeze([/* elenco dello Step 1, dalla più recente */]);
```

L'elenco è un dato osservato nello Step 1: va scritto con i valori letti, non lasciato vuoto. In `handleMessage`, per `initialize`:

```js
      protocolVersion: SUPPORTED_PROTOCOL_VERSIONS.includes(message.params?.protocolVersion)
        ? message.params.protocolVersion
        : SUPPORTED_PROTOCOL_VERSIONS[0],
```

In `main`, sostituire il `try/catch` del ciclo con:

```js
    let message;
    try { message = JSON.parse(line); } catch { errorResponse(null, -32700, 'Parse error'); continue; }
    try { await handleMessage(state, message); }
    catch { errorResponse(message?.id ?? null, -32600, 'Invalid request'); }
```

- [ ] **Step 4: test, REGEN, check, commit**

```bash
node --test tests/mcp-trust.test.mjs
npm run contexts && npm run mcp && npm run prompt-evaluations && npm run pack-evaluations && npm run marketplaces && npm run catalog && npm run integrity && npm run catalog:docs && npm run capability:docs && npm run docs:stats
npm run check
git add -A && git commit -m "fix(mcp): negotiate protocol versions and report parse errors"
```

### Task 8: stato di installazione pulito dopo l'ultima rimozione

Risolve la seconda metà di F14 e documenta F25.

**File:**
- Modify: `scripts/lib/install.mjs`
- Test: `tests/install.test.mjs`

- [ ] **Step 1: test che fallisce**

```js
test('removing the last artifact leaves no installer state behind', (context) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'youdede-install-cleanup-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  installArtifact('commit-guard', { cwd: directory });
  removeArtifact('commit-guard', { cwd: directory });
  assert.equal(existsSync(path.join(directory, '.claude', '.youdede-toolkit')), false);
  installArtifact('commit-guard', { cwd: directory });
  assert.equal(doctor({ cwd: directory }).findings.length, 0);
});
```

Run: `node --test --test-name-pattern "no installer state" tests/install.test.mjs` → atteso FAIL.

- [ ] **Step 2: implementare**

In `removeArtifactLocked`, sostituire `writeState(configRoot, state);` (quello dopo `delete state.installs[key];`) con:

```js
    if (Object.keys(state.installs).length === 0) rmSync(statePath(configRoot), { force: true });
    else writeState(configRoot, state);
```

In `withStateLock`, nel ramo `catch` dell'apertura del lock, prima di `if (error.code !== 'EEXIST') throw error;` aggiungere:

```js
      if (error.code === 'ENOENT') { mkdirSync(path.dirname(file), { recursive: true }); continue; }
```

e nel `finally`, dopo la rimozione del lock:

```js
    // Drop the directory once nothing is left in it; a concurrent installer recreates it.
    try { rmdirSync(path.dirname(file)); } catch {}
```

Sopra `if (age > STATE_LOCK_STALE_MS) {` aggiungere il commento sul limite noto (F25):

```js
      // ponytail: stale reclaim removes by name, so two processes that both saw the same stale
      // lock can both proceed. It needs a lock older than 120 s; replace with an OS advisory
      // lock if concurrent installs ever become routine.
```

- [ ] **Step 3: tutti i test dell'installer e dei pack**

Run: `node --test tests/install.test.mjs tests/packs.test.mjs tests/mcp-trust.test.mjs tests/cli.test.mjs`
Atteso: PASS. Il test esistente sulla modalità `0o600` di `state.json` installa senza rimuovere, quindi non cambia.

- [ ] **Step 4: commit**

```bash
npm run check
git add -A && git commit -m "fix(installer): remove empty installer state after the last removal"
```

### Task 9: validatore contro la divergenza dei subagent tra target

Previene la regressione descritta in F26.

**File:**
- Modify: `scripts/lib/catalog.mjs`
- Test: `tests/catalog.test.mjs`

- [ ] **Step 1: test che fallisce**

```js
import { subagentBodyDrift } from '../scripts/lib/catalog.mjs';

test('subagent bodies must match across targets apart from the Copilot turn budget line', () => {
  const body = '---\nname: x\n---\n\nYou review.\n\n## Refusals\n- a\n';
  assert.deepEqual(subagentBodyDrift({ 'claude-code': body, 'gemini-cli': body }), []);
  const copilot = body.replace('You review.\n', 'Complete the brief within 10 turns. Stop and return partial evidence instead of expanding the scope when that budget is exhausted.\n\nYou review.\n');
  assert.deepEqual(subagentBodyDrift({ 'claude-code': body, 'github-copilot': copilot }), []);
  assert.deepEqual(subagentBodyDrift({ 'claude-code': body, opencode: body.replace('You review.', 'You approve.') }), ['opencode']);
});
```

(aggiungere l'import alla sezione import esistente).

- [ ] **Step 2: implementare**

In `catalog.mjs` aggiungere ed esportare:

```js
const TURN_BUDGET_LINE = /^Complete the brief within \d+ turns\. Stop and return partial evidence instead of expanding the scope when that budget is exhausted\.$/;

function subagentBody(raw) {
  const lines = raw.split('\n');
  const end = lines[0] === '---' ? lines.indexOf('---', 1) : -1;
  return lines.slice(end + 1).filter((line) => line.trim() && !TURN_BUDGET_LINE.test(line.trim())).join('\n');
}

export function subagentBodyDrift(rawByTarget) {
  const reference = rawByTarget['claude-code'];
  if (reference === undefined) return [];
  const expected = subagentBody(reference);
  return Object.entries(rawByTarget)
    .filter(([target, raw]) => target !== 'claude-code' && subagentBody(raw) !== expected)
    .map(([target]) => target);
}
```

Nel blocco `if (manifest.kind === 'subagent')`, raccogliere `raw` per target nel ciclo esistente in un oggetto `bodies[target] = raw`, e dopo il ciclo:

```js
    for (const target of subagentBodyDrift(bodies)) errors.push(`${target}: subagent body differs from the claude-code payload`);
```

- [ ] **Step 3: verificare che il catalogo attuale passi**

Run: `node --test tests/catalog.test.mjs && npm run validate`
Atteso: PASS, perché oggi le divergenze sono 0 (F26). Se `npm run validate` segnala divergenze, elencarle all'utente: significa che la normalizzazione non coincide con quella della verifica del 2026-09-26.

- [ ] **Step 4: commit**

```bash
npm run check
git add -A && git commit -m "test(catalog): reject subagent body drift across targets"
```

### Task 10: allineare i testi alle verifiche (dopo i Task 5 e 8)

Risolve F13, la prima metà di F14, F15, F16, F24.

**File:**
- Modify: `README.md`, `docs/governance.md`, `docs/install.md`, `CHANGELOG.md`

- [ ] **Step 1: README, integrità**

Riga 103, sostituire la frase su `verify-integrity` con:

```markdown
`npx @youdede/toolkit verify-integrity` checks the package's own artifacts against it; `npx @youdede/toolkit doctor` checks the files you installed against what was recorded at install time.
```

- [ ] **Step 2: README, rimozione**

Riga 122, sostituire "and `remove` restores exactly what it replaced" con:

```markdown
and `remove` restores the files and settings entries it replaced (JSON settings are rewritten with two-space indentation, so formatting can change while content is preserved)
```

- [ ] **Step 3: README, disponibilità su npm** (condizione deterministica)

Eseguire `npm view @youdede/toolkit version`. Se risponde 404, aggiungere sotto "Try one in thirty seconds":

```markdown
> The package is not on npm yet. Until the first publication, run the same commands from a checkout with `node bin/youdede-toolkit.mjs` in place of `npx @youdede/toolkit`.
```

Se risponde con una versione, non modificare.

- [ ] **Step 4: governance**

Per la decisione D5, sostituire in `docs/governance.md:27` la cella "Linux, macOS, and Windows check runs on supported Node versions" con "Linux (ubuntu-latest) check runs on Node 20, 22, and 24; macOS and Windows are not run in CI". Verificare prima che `validate.yml` non sia cambiato.

- [ ] **Step 5: install.md, Codex**

Nella sezione "## Scope" aggiungere:

```markdown
Codex project-scope hooks are written to `.codex/hooks.json` with the absolute path of the project on the installing machine. Do not commit that file for other machines; reinstall on each machine instead.
```

- [ ] **Step 6: verificare e commit**

```bash
npm run check:doc-stats && npm run check
git add -A && git commit -m "docs: align readme and install claims with verified behavior"
```

---

## Ondata 2: audit in sola lettura (parallelo, a lotti)

Ogni agente legge **integralmente** ogni file del proprio lotto: `artifact.json`, payload (`SKILL.md`, `COMMAND.md`, subagent per ogni target, script degli hook, `server.json`, `THREAT.md`), tutti gli adapter, `evaluations/behavioral.json`, README del target, e le voci corrispondenti in `catalog/narratives.{it,nl}.json` e `catalog/reasons.{it,nl}.json`. Non modifica file del repo.

### Formato di output (identico per tutti i lotti)

File `.youdede-workbench/audit/findings/<lotto>.json`:

```json
{
  "batch": "skills-marketing-1",
  "auditor": "nome dell'agente",
  "commit": "SHA letto con git rev-parse HEAD",
  "artifacts": [
    {
      "artifactId": "skill/marketing/...",
      "filesRead": ["percorso", "percorso"],
      "checks": [
        { "id": "R1", "status": "pass | fail | unverifiable", "evidence": "citazione file:riga oppure comando e output" }
      ],
      "findings": [
        {
          "severity": "high | medium | low",
          "claim": "cosa dice il testo",
          "reality": "cosa risulta",
          "file": "percorso",
          "line": 12,
          "evidence": "citazione o output",
          "verification": "comando eseguito o URL con data di lettura",
          "proposedFix": "testo o codice sostitutivo"
        }
      ]
    }
  ]
}
```

Regole: una critica senza `evidence` e `verification` non entra nel file. Ciò che non si può verificare va in `checks` con `unverifiable` e il motivo, mai in `findings`.

### Rubrica

Per ogni artifact:
- **R1** Coerenza manifest/payload: `summary`, `description`, `refuses`, `risk_reason`, `operational.latency_reason` corrispondono a ciò che il payload fa davvero.
- **R2** Correttezza tecnica: ogni comando, flag, API, nome di tool o fatto di dominio citato esiste e fa ciò che il testo dice. Verificare con `--help`, `man`, o la documentazione ufficiale (URL e data). Se non verificabile: `unverifiable`.
- **R3** Utilità: i passi sono eseguibili da un agente senza contesto aggiuntivo; nominare ogni passo generico che non cambia il comportamento, citandolo.
- **R4** Rifiuti concreti: ogni rifiuto nomina un'azione verificabile.
- **R5** Contratto di output coerente con il resto del payload (`npm run check:contracts` lo fa in parte; qui si controlla il senso).
- **R6** Evaluation: i `sourceAnchors` esistono nel payload; i prompt testano questo artifact e non un modello generico; segnalare i casi identici ad altri artifact (F21).
- **R7** Adapter per target: frontmatter e campi conformi alla documentazione ufficiale del runtime (Claude Code, Codex, Gemini CLI, GitHub Copilot, Cursor, OpenCode). Citare URL e data. `limitations` e `stability` veritieri.
- **R8** Traduzioni: narrative e reasons in italiano e olandese dicono la stessa cosa dell'inglese (nessuna aggiunta, nessuna omissione).
- **R9** Solo hook: eseguire le sonde elencate sotto e confrontare con il README dell'hook.
- **R10** Solo command: eseguire `scripts/check-preconditions.mjs` su un caso che passa e su uno che fallisce.
- **R11** Solo MCP: avviare il server con il profilo e confrontare ogni affermazione di `THREAT.md` e di `server.json` con il comportamento.
- **R12** Solo pack: ogni membro esiste, ogni outcome ha un membro che lo produce, i ruoli corrispondono ai kind.

Sonde R9 per gli hook su comandi Bash (adattare al dominio dell'hook, riportare exit code e ruleId per ognuna): forma base; forma con wrapper (`env X=1`, `sudo`, `bash -c '...'`, `eval`); concatenazione (`;`, `&&`, `|`); alias git o funzione shell definita nello stesso comando; runner (`xargs`, `find -exec`); interprete (`python -c`, `node -e`), da confrontare con i limiti dichiarati; input malformato e sopra limite; percorso con symlink; cartella invece di file. Per gli hook su file: `Write`, `Edit`, `MultiEdit`, `NotebookEdit` con traversal (`../`), percorso assoluto fuori progetto, symlink.

### Lotti

| Lotto | Contenuto | Artifact |
| --- | --- | --- |
| A-skills-marketing-1 | skill marketing, prima metà in ordine alfabetico | 23 |
| A-skills-marketing-2 | skill marketing, seconda metà | 23 |
| A-skills-development-1 | skill development, prima metà | 17 |
| A-skills-development-2 | skill development, seconda metà | 16 |
| A-skills-operations-1 | skill operations, prima metà | 15 |
| A-skills-operations-2 | skill operations, seconda metà | 14 |
| A-skills-design | skill design | 25 |
| A-skills-writing | skill writing | 18 |
| A-skills-small | skill data, research, security | 16 |
| A-subagents-1 | subagent development, design | 22 |
| A-subagents-2 | subagent operations, security | 24 |
| A-subagents-3 | subagent data, marketing, research, writing | 16 |
| A-hooks-security-1 | hook security, prima metà | 12 |
| A-hooks-security-2 | hook security, seconda metà | 12 |
| A-hooks-operations | hook operations | 22 |
| A-hooks-other | hook development, data, design | 17 |
| A-commands-contexts-mcp | command, context, MCP server | 23 |
| A-packs | 13 pack, `catalog/taxonomy.json`, `catalog/packs.json` | 13 |

Totale: 315 artifact e 13 pack. Il comando per ottenere l'elenco esatto di un lotto, per esempio il primo:

```bash
git ls-files 'artifacts/skills/marketing/**/artifact.json' | sort | head -23
```

### Lotto C: affermazioni dei testi del repository

File da leggere per intero: `README.md`, `CONTRIBUTING.md`, `SECURITY.md`, `SUPPORT.md`, `NOTICE`, `CITATION.cff`, `CHANGELOG.md` (Unreleased e 0.3.0), tutti i `docs/*.md`, `docs/decisions/*.md`, `docs/audits/*.md`, `docs/plans/*.md` escluso questo file, `quality/release-evidence/README.md`, `.github/pull_request_template.md`, `.github/ISSUE_TEMPLATE/*.yml`.

Output `.youdede-workbench/audit/claims/<file>.json`: una riga per ogni frase che afferma un fatto (numero, comportamento, garanzia di sicurezza, processo, fatto esterno).

```json
{ "file": "README.md", "line": 103, "claim": "testo", "type": "count | behavior | security | process | external", "verdict": "true | false | partly | unverifiable", "evidence": "comando e output, oppure file:riga, oppure URL con data" }
```

Le affermazioni già verificate in "Fatti verificati" si riportano con il riferimento F.

### Lotto O: comportamento per sistema operativo

1. Linux: dai log CI esistenti di `validate` (`gh run list`, `gh run view --log`), Node 20, 22, 24.
2. macOS: `npm run check` completo in locale con Node 20, 22 e 24 (F1 copre già Node 24), eseguito da solo sulla macchina, senza altre suite in parallelo (F28).
3. Windows: nessuna CI (D5). Se l'utente ha una macchina Windows, `npm ci && npm run check` lì; altrimenti tutto Windows è `unverifiable`.
4. Per ogni target con hook (Claude Code, Codex, Gemini CLI, Cursor, OpenCode) leggere la documentazione ufficiale su come il runtime esegue il comando dell'hook su Windows (quale shell, come espande `${CLAUDE_PROJECT_DIR}`, `${HOME}`, `${GEMINI_PROJECT_DIR}`). Registrare URL e data. Se la documentazione non lo dice: `unverifiable`, e aggiungere al lotto la voce "prova manuale su una macchina Windows", che richiede l'utente.
5. Esaminare F28: eseguire `node --test tests/install.test.mjs` e il test del ledger sotto carico controllato (per esempio 8 processi `yes > /dev/null` in parallelo) e da soli, e riportare se il fallimento viene da un timeout nel codice (`STATE_LOCK_TIMEOUT_MS`, `STATE_LOCK_STALE_MS`, timeout del ledger) o dal solo tempo di esecuzione.
6. Elencare ogni `skip: process.platform === 'win32'` (oggi 7) con il motivo e verificare che `docs/targets.md` lo dichiari.

Output: `.youdede-workbench/audit/os/report.json`, nello stesso formato del lotto C.

---

## Ondata 3: triage e correzioni dall'audit

- [ ] **Step 1: consolidare**

```bash
node -e '
const fs = require("fs");
const dir = ".youdede-workbench/audit/findings";
const all = fs.readdirSync(dir).flatMap((f) => JSON.parse(fs.readFileSync(`${dir}/${f}`)).artifacts.flatMap((a) => a.findings.map((x) => ({ artifactId: a.artifactId, ...x }))));
const order = { high: 0, medium: 1, low: 2 };
all.sort((a, b) => order[a.severity] - order[b.severity]);
fs.writeFileSync(".youdede-workbench/audit/triage.json", JSON.stringify(all, null, 2));
console.log(all.length, "findings");'
```

- [ ] **Step 2: rivedere con l'utente**

Mostrare all'utente la lista ordinata per gravità, con l'evidenza di ciascuna voce. L'utente decide quali correggere. Nessuna correzione parte senza questa scelta.

- [ ] **Step 3: correggere**

Ogni correzione accettata diventa un task con la stessa forma dei Task 1-10: test che fallisce (per codice) oppure citazione della fonte (per testo), modifica, REGEN, `npm run check`, commit. Correzioni allo stesso artifact vanno nello stesso branch.

---

### Ondata 3, esecuzione (decisa il 2026-09-26: l'utente chiede tutti i gruppi G0-G9 del triage, con attenzione esplicita alle regressioni)

Triage: `.youdede-workbench/audit/triage.md` e `triage.json` nel worktree del thread padre. Base di tutti i branch: `chore/audit-remediation-wave-1`.

**Regole anti-regressione (valgono per ogni task dell'Ondata 3)**

1. **Snapshot dei verdetti degli hook (task W3-A0, prima di ogni modifica a un hook).** Un corpus di comandi e input per tutti i 63 hook: tutti i comandi già presenti nei test, tutte le sonde dell'audit, sequenze di più comandi (per esempio `git switch main && git merge x && git push`), e un corpus di comandi legittimi di uso quotidiano (`git status`, `git commit -m x`, `npm test`, `grep -r foo src`, `ls`, `docker ps`, `kubectl get pods`, `git push -u origin feature`, `tar czf out.tgz src`, ...). Uno script registra, per ogni coppia hook × input, exit code e ruleId in `quality/hook-verdicts.json`; un test (`tests/hook-verdicts.test.mjs`) ricalcola e confronta. Ogni cambio di verdetto voluto aggiorna lo snapshot e aggiunge, nella stessa voce, un campo `change` con il motivo e l'ID del finding. Un cambio senza `change` fa fallire il test.
2. **Tabella dei cambi di comportamento.** Ogni rapporto di agente che tocca un hook include la tabella dei verdetti cambiati (prima, dopo, motivo). Il padre la confronta con il diff dello snapshot.
3. **Sequenze, non solo comandi singoli.** Ogni correzione a un hook su comandi Bash aggiunge al corpus almeno una sequenza che combina la correzione con un cambio di branch, di cartella o di staging nello stesso comando.
4. **Controllo del pacchetto.** Dopo ogni integrazione il padre rieseguirà il confronto della CLI sul pacchetto estratto (15 comandi) contro il pacchetto di `f59331f`.
5. **Integrazione seriale.** Un branch alla volta, `npm run check` completo da solo dopo ogni merge.
6. Gli agenti eseguono i test mirati, la catena dei 19 controlli (tutto `npm run check` tranne `npm test`) e `node --test tests/hook-verdicts.test.mjs` quando esiste; non la suite completa.

**Fasi e task**

| Fase | Task | Contenuto | File toccati |
| --- | --- | --- | --- |
| A | W3-A0 | Snapshot dei verdetti (regola 1). Nessuna modifica agli hook. | `scripts/record-hook-verdicts.mjs`, `quality/hook-verdicts.json`, `tests/hook-verdicts.test.mjs`, `package.json` (script `hook-verdicts`, `check:hook-verdicts` nella catena) |
| A | W3-G4 | Adapter dei 4 context (`.cursor/.cursor`, `.github/.github`) con test di installazione sul percorso finale; `resume-session-work` ritirato dai 4 target senza runtime (come Codex) con limitazione in `docs/targets.md`; `plan-and-verify-loop` installabile e usabile; `mobile-release-readiness`: affermazione `safe-publication` resa vera nei testi del pack (i guard si correggono in fase B). | `artifacts/contexts/**/adapters`, `artifacts/skills/operations/session/resume-session-work/adapters`, `packs/**`, test di installazione |
| A | W3-G8 | Testi falsi o parziali del repo (claims `false` e `partly`), `--dry-run` che elenca `NOTICE.md` (codice + test). | `README.md`, `docs/**`, `SECURITY.md`, `SUPPORT.md`, `CONTRIBUTING.md`, `CHANGELOG.md`, `.github/ISSUE_TEMPLATE/config.yml`, `scripts/lib/install.mjs`, `bin/` |
| A | W3-G5 | Finding medi e alti su skill e subagent (payload, script helper, contratti). Nessuna modifica a `evaluations/` salvo `sourceAnchors` rotte. Riporta ogni testo cambiato in `refuses`, `summary`, `description`, `risk_reason`, `latency_reason` (servirà a G6). | `artifacts/skills/**`, `artifacts/subagents/**` (esclusi adapter e evaluations) |
| A | W3-G9 | Metadati dei runtime, solo dopo aver letto la fonte ufficiale (URL e data): stability/limitations Gemini e Copilot, `NotebookRead`, `git -c core.fsmonitor=false` e nessuna scrittura dell'indice nel runtime MCP (con test). | `artifacts/**/adapters/*.json`, `artifacts/subagents/**` (solo frontmatter tools), `scripts/runtime/readonly-mcp-server.mjs` |
| B (dopo A0) | W3-G0 | Regressione T2: cambio di branch nello stesso comando rende push e storia uninspectable. | `protected-branch-guard.mjs`, test, snapshot |
| B (dopo A0) | W3-G1core | Modulo condiviso di analisi della shell e modulo "contenuto del commit", in `scripts/lib/shared-hook/`, con generatore che li copia tra marcatori `// <youdede:shared name>` ... `// </youdede:shared>` negli hook (`npm run shared-hooks`, `--check` nella catena). Migra 2 hook pilota: `shell-command-guard` e `commit-guard`. | `scripts/lib/shared-hook/**`, `scripts/generate-shared-hooks.mjs`, 2 hook, test |
| C (dopo G1core e G0) | W3-H1..H4 | Migrazione dei restanti hook al modulo condiviso e correzione di tutti i finding G1/G2/G3 dei propri hook, per lotto: H1 hook security 1, H2 hook security 2, H3 hook operations, H4 hook development/data/design. | solo gli hook del proprio lotto, i loro test, lo snapshot |
| D (dopo A e C) | W3-G6 | Traduzioni IT/NL: tutti i finding R8 più ogni testo cambiato da G4, G5, G8, H1-H4; `sourceHash` aggiornato. Revisore cieco: un secondo agente ritraduce 30 voci a caso senza vedere le attuali e confronta. | `catalog/narratives.*.json`, `catalog/reasons.*.json` |
| D (dopo G5) | W3-G7 | Evaluation: casi specifici per artifact al posto del template, ancore sul testo che governa il caso, casi boundary coerenti con la regola 0; insieme l'Ondata 4 (boilerplate) con il test A/B già descritto. | `artifacts/**/evaluations`, `SKILL.md` (solo blocco boilerplate) |
| E | padre | Lotto O (sistemi operativi) e gate finale di non regressione. | nessuno |

---

## Ondata 4: riduzione del boilerplate delle skill (decisione D4)

Le 348 parole ripetute (F20) si tolgono o si accorciano solo dove un test A/B mostra che non peggiora nulla.

### Task 11: definire le varianti

**File:**
- Create: `.youdede-workbench/audit/boilerplate/variants.md`

- [ ] **Step 1: estrarre il blocco condiviso**

```bash
git ls-files 'artifacts/skills/**/SKILL.md' | xargs cat | grep -v '^\s*$' | sort | uniq -c | awk '$1>=143' > .youdede-workbench/audit/boilerplate/shared-lines.txt
```

- [ ] **Step 2: scrivere tre varianti del blocco dopo il primo paragrafo di `## Output contract`**

Il primo paragrafo (quello con l'elenco `## ...` delle intestazioni) non si tocca: `scripts/lib/output-contract.mjs` legge solo quello.
- **V0**: testo attuale (controllo).
- **V1**: senza l'albero di classificazione 0-4 e il paragrafo "Two consequences worth stating plainly", che servono a scegliere un'etichetta che `docs/evaluations.md` dichiara di non valutare.
- **V2**: V1 più la riscrittura in al massimo 3 frasi dei paragrafi su "embedded instruction" e "Record that refusal", mantenendo ogni obbligo: rifiutare l'istruzione incorporata, registrarla nella sezione dei risultati, completare il resto, marcare il non verificato, non omettere mai una sezione.

In `variants.md` scrivere il testo esatto di V1 e V2 e, per ogni frase tolta, l'obbligo che portava e dove resta espresso.

### Task 12: test A/B

**File:**
- Create: `.youdede-workbench/audit/boilerplate/responses/<variante>/<artifact>.json`
- Create: `.youdede-workbench/audit/boilerplate/result.md`

- [ ] **Step 1: campione**

3 skill per ciascuno degli 8 domini (24 skill), scelte con un criterio deterministico: le prime 3 in ordine alfabetico di slug per dominio. Tutti i casi delle loro evaluation.

- [ ] **Step 2: generare le risposte**

Per ogni variante, per ogni caso: un agente nuovo riceve solo il testo di `SKILL.md` con quella variante e il `prompt` del caso, senza accesso al repo. Salva la risposta nel formato di `docs/evaluations.md`:

```json
{ "schemaVersion": 1, "artifactId": "skill/...", "responses": [ { "caseId": "...", "text": "..." } ] }
```

- [ ] **Step 3: valutare**

```bash
for v in V0 V1 V2; do for f in .youdede-workbench/audit/boilerplate/responses/$v/*.json; do node scripts/validate-evaluations.mjs --responses "$f" --json; done > .youdede-workbench/audit/boilerplate/$v.jsonl; done
```

Un secondo agente, cieco sulla variante, confronta a coppie V0 con V1 e V0 con V2 per ogni caso e risponde a una sola domanda: "la risposta B omette un'informazione o un comportamento utile presente in A? Sì/No, con la citazione".

- [ ] **Step 4: regola di decisione**

Una variante è accettata solo se entrambe le condizioni valgono:
1. ogni caso che passa il checker con V0 passa anche con la variante;
2. il giudice cieco risponde "No" in tutti i casi, oppure l'utente, letta ogni citazione "Sì", la giudica non utile.

Scrivere in `result.md` i numeri esatti per variante e la decisione. Se nessuna variante è accettata, l'Ondata 4 si ferma qui e il testo resta com'è.

### Task 13: applicare la variante accettata

**File:**
- Modify: i 143 `artifacts/skills/**/SKILL.md` che contengono il blocco
- Modify: `CHANGELOG.md`

- [ ] **Step 1: sostituzione meccanica e verificata**

Uno script in `.youdede-workbench/` sostituisce il blocco V0 esatto con la variante accettata, solo nei file che contengono il blocco V0 identico; stampa l'elenco dei file toccati e di quelli saltati. Nessuna modifica a mano.

- [ ] **Step 2: REGEN e check**

```bash
npm run contexts && npm run mcp && npm run prompt-evaluations && npm run pack-evaluations && npm run marketplaces && npm run catalog && npm run integrity && npm run catalog:docs && npm run capability:docs && npm run docs:stats
npm run check
```

- [ ] **Step 3: commit**

```bash
git add -A && git commit -m "refactor(skills): shorten the shared output contract guidance"
```

Nota per l'utente: questa modifica rende obsolete le evidenze semantiche (P3), che oggi lo sono già (F2).

---

## Ondata 5 (condizionata a P1): alleggerire il pacchetto npm

### Task 14: togliere dal tarball ciò che nessun consumatore del pacchetto usa

**File:**
- Modify: `package.json` (`files`)
- Test: `tests/repository-governance.test.mjs`

- [ ] **Step 1: verificare i consumatori**

```bash
git grep -n "docs/assets\|'skills/\|\"skills/\|'plugins/\|\"plugins/" -- bin scripts tests
```

Per ciascun risultato stabilire se legge dal pacchetto installato. Controllare anche la documentazione dei marketplace (`docs/native-marketplaces.md`) per l'uso di npm come sorgente. Se qualcosa legge `skills/` o `plugins/` dal pacchetto, fermarsi e riportarlo.

- [ ] **Step 2: test che fallisce**

```js
test('the npm package excludes repository-only assets and marketplace copies', () => {
  const manifest = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(manifest.files.includes('skills'), false);
  assert.equal(manifest.files.includes('plugins'), false);
  assert.ok(manifest.files.includes('!docs/assets'));
});
```

- [ ] **Step 3: implementare**

In `package.json` `files`: togliere `"skills"` e `"plugins"`, aggiungere `"!docs/assets"`. Se lo Step 1 mostra che `.agents`, `.claude-plugin` o `.codex-plugin` puntano a `./plugins/...`, toglierli anche loro dal pacchetto.

- [ ] **Step 4: misurare e verificare**

```bash
npm pack --dry-run --json | node -e 'const d=JSON.parse(require("fs").readFileSync(0))[0];console.log(d.entryCount, d.size, d.unpackedSize)'
npm run check
```

Riportare prima e dopo (prima: 3734 file, 4,76 MB, 15,06 MB, F23).

- [ ] **Step 5: commit**

```bash
git add -A && git commit -m "chore(package): exclude marketplace copies and readme images from npm"
```

---

## Chiusura: gate di non regressione

- [ ] `npm run check` verde sul branch integrato e su tutti i 9 job CI del Task 5.
- [ ] Rieseguire tutte le sonde di F3, F4, F5, F6, F9, F11, F12, F13, F14 e allegare gli exit code: devono essere tutte bloccate o corrette, tranne i casi che la documentazione aggiornata dichiara come limiti.
- [ ] Confronto con la baseline: nessun test scomparso (`ℹ tests` >= 358 più quelli aggiunti), `npm pack` senza file inattesi.
- [ ] Review dell'intero branch con un reviewer nuovo (superpowers:requesting-code-review).
- [ ] Riepilogo per l'utente: cosa è cambiato, cosa resta aperto (P2, P3, voci `unverifiable`).

## Auto-revisione

- Copertura: ogni fatto F3-F26 ha un task (F3→T1; F4-F8→T2; F9, F10→T3; F11→T4; F12→T7; F13, F14→T8, T10; F15→T10 (D5); F16→T10; F17→P2; F18→T6; F19→lotti hook, R9, perché unificare il lexer violerebbe il vincolo "hook autonomi"; F20→Ondata 4; F21, F22→R6 e P3; F23→T14; F24→T10; F25→T8; F26→T9). F1, F2 e F27 sono la baseline da non rompere.
- Segnaposto: l'elenco `SUPPORTED_PROTOCOL_VERSIONS` (Task 7) e `GREP_TOOL_READS_HIDDEN` (Task 3) sono dati osservati in un passo di verifica esplicito dello stesso task, non lasciati da scrivere.
- Nomi coerenti: `commitReadsWorkingTree`, `inspectWorkingTree`, `expandAlias`, `globToRegExp`, `directoryHoldsSensitive`, `isSensitiveWorkspacePath`, `subagentBodyDrift`, `SUPPORTED_PROTOCOL_VERSIONS` sono usati con la stessa firma in codice e test.
- Review Focus: le cinque condizioni hanno un test nel task proprietario (T1 ultime asserzioni, T2 prime tre, T3 `grep -r KEY src`, T4 `.env.example`, T8 reinstallazione dopo la pulizia; la gara concorrente è dichiarata non testabile).
