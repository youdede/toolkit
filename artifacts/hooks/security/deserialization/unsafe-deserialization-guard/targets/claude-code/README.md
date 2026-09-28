# unsafe-deserialization-guard

Scans bounded proposed source content after masking comments and quoted text, then blocks net-new calls to known unsafe deserializers across common languages. Strings are masked before comments, so a `//` inside a string does not hide the rest of the line; Python and Ruby comments start with `#`.

The covered APIs are:

- Python: `pickle.load` and `pickle.loads` (also through `import pickle as x` and `from pickle import loads`), `yaml.load` without `SafeLoader` or `safe_load`, and `yaml.unsafe_load`/`unsafe_load_all` (also through `from yaml import`);
- Ruby: `Marshal.load` and `Marshal.restore`, with or without parentheses;
- PHP: `unserialize(`;
- C#: creating a `BinaryFormatter` (`new BinaryFormatter(` or `new BinaryFormatter {`);
- Java and Kotlin: `new ObjectInputStream(` and `.readObject(`.

A relative file path resolves against `CLAUDE_PROJECT_DIR`, else the hook input `cwd`. A path inside that directory that leaves it through a symbolic-link ancestor is blocked as unverified. A file outside that directory is inspected the same way as one inside; a target that is a symbolic link or larger than 512 KiB is not read and the edit is blocked as unverified.

The hook is deterministic, reads at most 1 MiB from stdin, emits exit code 0 to allow and 2 to block, and never repeats submitted content in a diagnostic. It has no project-writable exception file.

## Refusals and limits

- It does not deserialize supplied data or execute parser code.
- It does not replace a threat model for custom protocols.
- It does not treat safe parser names inside documentation as executable calls.
- It does not call an LLM, execute submitted shell text, or transmit inspected content.
