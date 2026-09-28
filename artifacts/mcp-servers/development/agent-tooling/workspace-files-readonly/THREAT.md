# Workspace Files Readonly — threat note

The server reads only existing regular files beneath the canonical current workspace. It refuses
absolute paths, traversal, backslashes, symlink escapes, files above 128 KiB, and unbounded walks.
It has no network or secret-variable authority. File content remains untrusted model input: this
profile limits authority and size, but cannot make repository text safe from prompt injection.

Credential files recognised by `sensitive-file-access-guard` are refused by `read_file` and omitted
from `search_files` and `list_directory`.
