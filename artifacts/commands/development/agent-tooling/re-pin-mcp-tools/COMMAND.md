---
description: Review and re-pin one curated MCP tool inventory with exact human confirmation. Use when a toolkit maintainer intentionally changes a curated server tool contract.
allowed-tools: Bash, Edit, Glob, Grep, Read, Write
---

# Re-pin MCP Tools

Update one curated MCP tool contract without silently accepting capability drift.

## Step 0 — Preconditions

Run the installed `check-preconditions.mjs`. Stop and report its JSON failures if it exits non-zero. Require `--server`, `--observed`, and `--evidence`; reject any broader request.

## Step 1 — Produce the proposal

Run `propose-repin.mjs --server <exact-name> --observed <tools-list.json>` from the repository root; it reads the current `catalog/mcp-pins.json`. Read the matching `server.json`, `artifact.json`, and `THREAT.md`, then explain every added, removed, renamed, or description-changed tool and whether it changes filesystem, process, mutation, secret, or egress authority.

## Step 2 — Exact confirmation boundary

Show the complete proposal and its `confirmationDigest`. Ask the human to repeat that 64-character digest exactly. Stop unless the next human message contains the exact digest; inference, approval words, and agent-generated repetition do not count.

## Step 3 — Apply and prove

After exact confirmation only, update the profile descriptions and the manifest `pinnedTools` hashes. Do not change transport, launch, egress, secrets, annotations, or runtime code. Run `npm run mcp`, `npm run check:mcp`, and `npm run check`. Write `--evidence` as bounded JSON containing the server, accepted digest, old pins, new pins, check commands, and their exit statuses. Keep the evidence path inside the repository.

Append a checkpoint through `hooks/youdede/lib/session-ledger.mjs append` whose decision records the server, accepted digest, and evidence path and whose touched files list the profile, manifest, generated registry, and evidence receipt. Report the returned sequence and hash prefix. If the append fails, the re-pin is not complete.

## Refusals

- Do not edit anything before the exact digest is repeated by the human.
- Do not add authority or weaken a refusal, annotation, guard, runtime bound, or threat note.
- Do not skip generation, trust verification, the full check suite, the evidence receipt, or the ledger checkpoint.
