import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { bestMatch, dimensionPrompt, encode, extractText, normalizeAnswers, renderHtml, typesafeKey, scoreAnswers, typesafeQuestions, verdict } from '../artifacts/skills/writing/editing/assess-story-narrative-provenance/scripts/score-story-provenance.mjs';

const script = 'artifacts/skills/writing/editing/assess-story-narrative-provenance/scripts/score-story-provenance.mjs';
const taxonomy = JSON.parse(readFileSync('artifacts/skills/writing/editing/assess-story-narrative-provenance/scripts/storyscope-taxonomy.json', 'utf8')).dimensions;
// P(human) for each fixture comes from the paper's Python pipeline; the port must reproduce it.
const { cases } = JSON.parse(readFileSync('tests/fixtures/storyscope-answers.json', 'utf8'));
const run = (...args) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', env: { ...process.env, TYPESAFE_API_KEY: '' } });

test('story provenance scores a human story as human-like, matching the paper pipeline', () => {
  const p = scoreAnswers(cases.human_public_domain_jev.answers);
  assert.ok(Math.abs(p - cases.human_public_domain_jev.pHuman) < 1e-5, `${p}`);
  assert.equal(verdict([p, p]).verdict, 'human-like');
});

test('story provenance scores an AI story as ai-like, including fuzzy annotator values', () => {
  const p = scoreAnswers(cases.ai_story_jev.answers);
  assert.ok(Math.abs(p - cases.ai_story_jev.pHuman) < 1e-5, `${p}`);
  assert.equal(verdict([p, p]).verdict, 'ai-like');
  assert.ok(Math.abs(scoreAnswers(cases.fuzzy_claude_values.answers) - cases.fuzzy_claude_values.pHuman) < 1e-5);
  assert.equal(bestMatch('3 (moderate)', ['1_low', '3_moderate', '5_high'], 0.5), '3_moderate');
});

test('story provenance rejects malformed and oversized input', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'story-provenance-'));
  try {
    assert.equal(run().status, 1);
    const story = path.join(dir, 'story.txt');
    writeFileSync(story, 'A short story.');
    // cwd is the empty temp folder, so a developer's own .env.local cannot turn this into a real call.
    const keyless = spawnSync(process.execPath, [path.resolve(script), '--text', story, '--typesafe'], { cwd: dir, encoding: 'utf8', env: { ...process.env, TYPESAFE_API_KEY: '' } });
    assert.equal(keyless.status, 1);
    assert.match(keyless.stderr, /preferred annotator.*console\.typesafe\.ai\/keys.*Do not paste/);
    writeFileSync(path.join(dir, '.env.local'), 'OTHER=1\nexport TYPESAFE_API_KEY="ts-test"\n');
    assert.deepEqual(JSON.parse(spawnSync(process.execPath, [path.resolve(script), '--key-status'], { cwd: dir, encoding: 'utf8', env: { ...process.env, TYPESAFE_API_KEY: '' } }).stdout), { typesafeKey: true });
    assert.equal(typesafeKey({}, dir), 'ts-test');
    assert.equal(typesafeKey({ TYPESAFE_API_KEY: 'from-env' }, dir), 'from-env');
    const big = path.join(dir, 'big.txt');
    writeFileSync(big, 'x'.repeat(512 * 1024 + 1));
    assert.match(run('--text', big, '--prompts').stderr, /exceeds/);
    const broken = path.join(dir, 'answers.json');
    writeFileSync(broken, '{not json');
    assert.equal(run('--text', story, '--answers', broken).status, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('story provenance reports disagreeing runs as uncertain and flags texts outside the validated range', () => {
  assert.equal(verdict([0.7, 0.3]).verdict, 'uncertain');
  const dir = mkdtempSync(path.join(os.tmpdir(), 'story-provenance-'));
  try {
    const story = path.join(dir, 'story.txt');
    writeFileSync(story, 'A short story about a harbor.');
    const answers = path.join(dir, 'answers.json');
    writeFileSync(answers, JSON.stringify(cases.ai_story_jev.answers));
    const out = JSON.parse(run('--text', story, '--answers', answers, '--answers', answers).stdout);
    assert.equal(out.verdict, 'ai-like');
    assert.equal(out.runs.length, 2);
    assert.ok(out.notes.some((note) => /outside the 1000-6000 words/.test(note)));
    const prompts = JSON.parse(run('--text', story, '--prompts').stdout).dimensions;
    assert.equal(prompts.length, 10);
    assert.equal(prompts.reduce((n, d) => n + d.features, 0), 304);
    assert.match(prompts[0].prompt, /A short story about a harbor\./);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('story provenance encodes 462 columns and asks one TypeSafe question per value of a multi-select feature', () => {
  assert.equal(encode(normalizeAnswers({})).length, 462);
  const dim = taxonomy.find((d) => d.features.some((f) => f.type === 'multi_select'));
  const multi = dim.features.find((f) => f.type === 'multi_select');
  const qs = typesafeQuestions(dim);
  assert.equal(Object.keys(qs).filter((k) => k.startsWith(`${multi.id}::`)).length, multi.values.length);
  assert.match(dimensionPrompt(dim, 'Story.'), /Return a single JSON object with feature IDs as keys\./);
});

test('story provenance reads a story from a web page and writes an escaped, self-contained HTML report', async () => {
  const page = '<html><head><title>The Harbor &amp; Me</title><script>alert(1)</script></head><body><nav>Home | About</nav><article><h1>The Harbor</h1><p>She counted the boats&nbsp;at dawn.</p><p>He said &#8220;stay&#8221;.</p></article><footer>Cookies</footer></body></html>';
  assert.deepEqual(extractText(page), { title: 'The Harbor & Me', text: 'The Harbor\n\nShe counted the boats at dawn.\n\nHe said “stay”.' });
  const server = createServer((req, res) => {
    if (req.url === '/pdf') return res.writeHead(200, { 'content-type': 'application/pdf' }).end('%PDF');
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(page);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const cli = (...args) => new Promise((resolve) => execFile(process.execPath, [script, ...args], { env: { ...process.env, TYPESAFE_API_KEY: '' } }, (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout, stderr })));
  const dir = mkdtempSync(path.join(os.tmpdir(), 'story-provenance-'));
  try {
    const answers = path.join(dir, 'answers.json');
    writeFileSync(answers, JSON.stringify(cases.ai_story_jev.answers));
    const json = JSON.parse((await cli('--url', `${base}/story`, '--answers', answers, '--answers', answers)).stdout);
    assert.equal(json.verdict, 'ai-like');
    assert.equal(json.source.title, 'The Harbor & Me');
    assert.equal(JSON.parse((await cli('--url', `${base}/story`, '--prompts')).stdout).words, 11);
    const out = path.join(dir, 'report.html');
    const written = JSON.parse((await cli('--url', `${base}/story`, '--answers', answers, '--answers', answers, '--format', 'html', '--out', out)).stdout);
    assert.equal(written.verdict, 'ai-like');
    const html = readFileSync(out, 'utf8');
    assert.match(html, />AI-like<\/span><\/h1>/);
    assert.match(html, /tug of war/);
    assert.doesNotMatch(html, /StoryScope|paper/i);
    assert.match(html, /The Harbor &amp; Me/);
    assert.doesNotMatch(html, /<script[^>]+src|<link|@import|url\(|https?:\/\/(?!127\.0\.0\.1)/);
    assert.match((await cli('--url', `${base}/pdf`, '--prompts')).stderr, /not HTML or text/);
    assert.match((await cli('--url', 'file:///etc/passwd', '--prompts')).stderr, /http or https/);
    assert.match((await cli('--text', answers, '--url', base, '--prompts')).stderr, /usage/);
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
  assert.doesNotMatch(renderHtml({ verdict: 'uncertain', mean: 0.5, runs: [0.6, 0.4], words: 3, annotator: '<b>x</b>', measuredAt: 'now', notes: [], source: { type: 'file', path: 'a"<.txt' } }), /<b>x<\/b>|a"</);
});
