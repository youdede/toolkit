import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const workflow = readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');

test('release is manual-only and requires an exact package-and-tag confirmation', () => {
  assert.match(workflow, /^  workflow_dispatch:/m);
  assert.doesNotMatch(workflow, /^  push:/m);
  assert.match(workflow, /^      confirmation:/m);
  assert.match(workflow, /test "\$CONFIRMATION" = "publish @youdede\/toolkit \$TAG"/);
  assert.match(workflow, /\^v\(0\|\[1-9\]\[0-9\]\*\)/);
});

test('release fails closed when provenance or the trusted-publishing runtime is unavailable', () => {
  assert.match(workflow, /Require a public source repository for provenance/);
  assert.match(workflow, /test "\$REPOSITORY_PRIVATE" = false/);
  assert.equal((workflow.match(/node-version: 24/g) ?? []).length, 2);
  assert.doesNotMatch(workflow, /node-version: 20/);
  assert.match(workflow, /Require the npm trusted-publishing runtime/);
  assert.match(workflow, /minor === 5 && patch < 1/);
});

test('release scans reachable history and never references a stored npm token', () => {
  assert.match(workflow, /npm run check:secrets:history/);
  assert.match(workflow, /git merge-base --is-ancestor "\$TAG\^\{commit\}" "origin\/\$DEFAULT_BRANCH"/);
  assert.match(workflow, /git show "origin\/\$DEFAULT_BRANCH:\.github\/allowed-signers"/);
  assert.match(workflow, /npm publish --access public --provenance/);
  assert.match(workflow, /id-token: write/);
  assert.doesNotMatch(workflow, /secrets\.(?:NPM|NODE_AUTH)_?TOKEN/i);
  assert.doesNotMatch(workflow, /NODE_AUTH_TOKEN/);
});
