import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { auditDir, auditUrls, checkText, extractPage, renderHtml, renderMarkdown, sitemapUrls, summarize } from '../artifacts/skills/writing/editing/audit-published-content-defects/scripts/audit-content-defects.mjs';

const helper = 'artifacts/skills/writing/editing/audit-published-content-defects/scripts/audit-content-defects.mjs';
const filler = 'This guide explains the steps a newcomer takes in the first weeks, with the documents, the offices and the order that works best for most people.';
const page = (main, lang = 'en') => `<!doctype html><html lang="${lang}"><head><title>Guide</title></head><body><nav>Menu</nav><main><p>${filler}</p>${main}</main><footer>Footer</footer></body></html>`;
const kinds = (text, lang) => checkText(text, lang).map((d) => d.kind).sort();

test('content defects finds visible markdown, placeholders, entities, abbreviation cuts and duplicates', () => {
  assert.deepEqual(kinds('Taxable where you live (**Art.\n\n18), while the rest is not.'), ['markdown-emphasis', 'split-after-abbreviation']);
  assert.deepEqual(kinds('See [the form](https://example.org/form) and `code`.'), ['markdown-code', 'markdown-code', 'markdown-link']);
  assert.deepEqual(kinds('A {discount_percentage}% discount, {{ price }} and undefined.'), ['placeholder', 'placeholder', 'placeholder']);
  assert.deepEqual(kinds('Tom &amp; Jerry\n\n## Heading'), ['double-escaped-entity', 'markdown-heading']);
  const para = 'Some of these are partner links. If you use them, the site may earn a commission, at no extra cost to you.';
  assert.deepEqual(kinds(`${para}\n\nMiddle.\n\n${para}`), ['duplicate-paragraph']);
  assert.deepEqual(kinds('Die Anmeldung erfolgt beim Amt. You should register with the office before you start your job in the city.', 'de'), ['possible-untranslated']);
});

test('content defects stays quiet on clean prose and on ordinary sentence ends', () => {
  assert.deepEqual(kinds('Prices start at 5% off. The office opens at 9. Bring the form No. 2 if asked.\n\nThen wait.'), []);
  assert.deepEqual(kinds('Under Art. 21 the rule applies.\n\nThe next step is easy.'), []);
  assert.deepEqual(kinds('Snake_case words like file_name are fine, and so is a__b.'), []);
});

test('content defects extraction keeps visible text only', () => {
  const html = page('<p>Pick up to 7<sup><a role="doc-noteref">2</a></sup> schools for <span>Gemeinde</span><span hidden="">Glossary: commune</span><span aria-hidden="true">dup</span> today, 10 m<sup>2</sup>.</p><script>var x="**"</script>');
  const { text, lang, blocked } = extractPage(html);
  assert.match(text, /Pick up to 7 schools for Gemeinde today, 10 m2\./);
  assert.doesNotMatch(text, /Menu|Footer|Glossary|dup|\*\*/);
  assert.equal(lang, 'en');
  assert.equal(blocked, false);
  assert.equal(extractPage('<html><head><title>Vercel Security Checkpoint</title></head><body></body></html>').blocked, true);
});

test('content defects reads a sitemap index, skips blocked and script-only pages, and reports', async (t) => {
  const pages = {
    '/sitemap.xml': ['application/xml', '<sitemapindex><sitemap><loc>{base}/s1.xml</loc></sitemap></sitemapindex>'],
    '/s1.xml': ['application/xml', '<urlset><url><loc>{base}/en/guides/a</loc></url><url><loc>{base}/en/guides/b</loc></url><url><loc>{base}/en/guides/c</loc></url><url><loc>{base}/en/about</loc></url></urlset>'],
    '/en/guides/a': ['text/html', page('<p>Cost: **CHF 335** a year, then {fee_annual} later.</p>')],
    '/en/guides/b': ['text/html', '<html><head><title>Just a moment...</title></head><body>checking</body></html>'],
    '/en/guides/c': ['text/html', '<html><body><main><div id="root"></div></main></body></html>'],
  };
  const server = createServer((req, res) => {
    const hit = pages[req.url];
    if (!hit) { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'Content-Type': hit[0] }).end(hit[1].replaceAll('{base}', `http://127.0.0.1:${server.address().port}`));
  });
  await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const urls = await sitemapUrls(`${base}/sitemap.xml`, '/guides/');
  assert.deepEqual(urls.map((u) => u.replace(base, '')), ['/en/guides/a', '/en/guides/b', '/en/guides/c']);
  const result = summarize(await auditUrls(urls, { delay: 0 }), 'test site');
  assert.equal(result.pages.checked, 1);
  assert.equal(result.pages.blocked.length, 1);
  assert.equal(result.pages.unreadable.length, 1);
  assert.deepEqual(result.defects.map((d) => d.kind).sort(), ['markdown-emphasis', 'placeholder']);
  const html = renderHtml(result);
  assert.match(html, /1 of 1 pages need a fix/);
  assert.doesNotMatch(html, /<link\b|src="http|@import|url\(http/);
  assert.match(renderMarkdown(result), /## Unresolved placeholder or template value[\s\S]*fee_annual/);
});

test('content defects stops after repeated bot checks instead of hammering the site', async () => {
  const blocked = '<html><head><title>Attention Required</title></head></html>';
  const server = createServer((req, res) => res.writeHead(200, { 'Content-Type': 'text/html' }).end(blocked));
  await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const pages = await auditUrls(['/1', '/2', '/3', '/4', '/5'].map((p) => base + p), { delay: 0 });
  server.close();
  assert.equal(pages.length, 5);
  assert.equal(pages.filter((p) => p.reason?.startsWith('not fetched')).length, 2);
});

test('content defects CLI audits a folder, rejects bad arguments and non-http sources', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'defects-'));
  try {
    writeFileSync(path.join(dir, 'a.html'), page('<p>See [the form](/form) today.</p>'));
    writeFileSync(path.join(dir, 'b.html'), page('<p>Nothing wrong here at all.</p>'));
    assert.equal(auditDir(dir).length, 2);
    const ok = spawnSync(process.execPath, [helper, '--dir', dir, '--format', 'md'], { encoding: 'utf8' });
    assert.equal(ok.status, 0, ok.stderr);
    assert.match(ok.stdout, /Checked 2 pages; 1 have at least one defect/);
    assert.notEqual(spawnSync(process.execPath, [helper], { encoding: 'utf8' }).status, 0);
    assert.notEqual(spawnSync(process.execPath, [helper, '--dir', dir, '--url', 'https://x.org'], { encoding: 'utf8' }).status, 0);
    const local = spawnSync(process.execPath, [helper, '--url', 'file:///etc/passwd'], { encoding: 'utf8' });
    assert.equal(local.status, 0);
    assert.match(local.stdout, /not an http or https address/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
