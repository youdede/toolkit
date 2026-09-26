# Migration safety guard for Claude Code

The hook runs before Bash, Write, or Edit. It blocks narrow, high-confidence destructive operations:

- direct database-drop utilities (`dropdb`, `mysqladmin drop`);
- known ORM or framework reset, drop, purge, truncate, and flush commands, after any path prefix (`./bin/rails`) and package runner (`npx --yes`, `pnpm`, `yarn`, `bun`);
- static `DROP DATABASE`, `DROP SCHEMA ... CASCADE`, `DROP TABLE`, `TRUNCATE`, `ALTER TABLE ... DROP COLUMN`, and unqualified `DELETE FROM` statements proposed in `.sql` files under a migration directory.

Commands are found wherever the shell would run them: inside `sh -c`, `eval`, `sudo`, `env`, `timeout`, `xargs`, `find -exec`, and the body of a Git shell alias defined in the same command. `TRUNCATE(x, d)`, the numeric function, is not a `TRUNCATE` statement. A migration file is inspected wherever it is, including outside the directory Claude has moved to; the project root is `CLAUDE_PROJECT_DIR` when it is set.

The SQL check is intentionally a bounded lexical policy, not a SQL parser. It masks comments and quoted string literals and does not claim coverage of dynamic SQL, stored procedures, dialect extensions, or application-language migration APIs. For Edit, it reads at most 512 KiB from an existing regular file and reconstructs the complete proposed file only when `old_string` has one unambiguous match. An incomplete, oversized, missing, or symlinked edit target is blocked rather than partially inspected.

The installed hook has no runtime approval file, hash allowlist, environment bypass, or inline suppression. A project-writable exception would not prove that a person approved it because the same agent can invoke Bash. Intentional destructive work must be performed by a person outside the guarded agent session, or after that person explicitly disables the exact installed hook entry.

## Refusals and limits

- The hook does not execute, rewrite, roll back, or prove the reversibility of a migration.
- It does not interpret arbitrary SQL, application-language migration code, dynamic SQL, or vendor-specific procedural syntax.
- It does not treat an approval comment, environment variable, command flag, or prompt statement as user approval.
- It does not expose the submitted command in its block message.
- It does not provide an agent-writable approval mechanism or infer approval from prompt text.
