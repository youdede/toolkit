#!/usr/bin/env node
// Find objective rendering defects in published pages: markdown left visible, unresolved placeholders,
// double-escaped entities, paragraphs cut after an abbreviation, duplicated paragraphs, and probable
// untranslated passages. Reads a page, a sitemap, or a folder of saved HTML. Never writes to a site.
import { readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const MAX_PAGE_BYTES = 4 * 1024 * 1024;
const MAX_PAGES = 5000;
const USER_AGENT = 'audit-published-content-defects/1.0 (read-only content check)';

// ---------- extraction ----------
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“' };
// One decoding pass, as a browser does: "&amp;amp;" becomes a visible "&amp;", which is the defect we look for.
const decode = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
  if (e[0] === '#') { const n = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : Number(e.slice(1)); return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m; }
  return ENTITIES[e.toLowerCase()] ?? m;
});
const BLOCKED = /<title>[^<]*(Security Checkpoint|Just a moment|Attention Required|Access denied|Are you a robot)[^<]*<\/title>|cf-chl-|challenge-platform/i;

// Visible text of the main content, one block per paragraph. Hidden text (popovers, duplicate responsive
// labels, screen-reader labels) and linked footnote markers are dropped: a reader never sees them.
export function extractPage(html) {
  const title = decode(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '').trim();
  const lang = (html.match(/<html\b[^>]*\blang="([^"]+)"/i)?.[1] ?? '').toLowerCase();
  let body = html.replace(/<!--[\s\S]*?-->/g, '').replace(/<(script|style|noscript|svg|template|iframe)\b[\s\S]*?<\/\1>/gi, '');
  // Pages may carry several <main> (loading skeletons): keep the one with the most text.
  const plain = (h) => h.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').length;
  body = (body.match(/<main\b[\s\S]*?<\/main>/gi) ?? []).sort((a, b) => plain(b) - plain(a))[0] ?? body.match(/<body\b[\s\S]*<\/body>/i)?.[0] ?? body;
  body = body.replace(/<(nav|header|footer|aside|form)\b[\s\S]*?<\/\1>/gi, '');
  body = body.replace(/<(span|div)\b[^>]*(class="[^"]*\b(sr-only|visually-hidden)\b[^"]*"|\shidden(=""|(?=[\s>]))|aria-hidden="true")[^>]*>[\s\S]*?<\/\1>/gi, '');
  body = body.replace(/<sup\b[^>]*>([\s\S]*?)<\/sup>/gi, (tag, inner) => (/<a\b/i.test(inner) && /^[\s\d,[\]*†-]*$/.test(inner.replace(/<[^>]+>/g, '')) ? '' : tag));
  body = body.replace(/<\/t[dh]>\s*(?=<t[dh]\b)/gi, ' · ').replace(/<\/tr>/gi, '\n\n');
  const text = decode(body.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|h[1-6]|li|blockquote|section|dd|dt|figcaption)>/gi, '\n\n').replace(/<[^>]+>/g, ''))
    .split('\n').map((line) => line.replace(/[ \t ]+/g, ' ').trim()).join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return { title, lang, text, blocked: BLOCKED.test(html) };
}

// ---------- checks ----------
// Abbreviations that are never a sentence end when a number or a lowercase word follows.
const ABBREVIATIONS = ['Art', 'Arts', 'Abs', 'Nr', 'No', 'Nos', 'para', 'paras', 'Sec', 'sec', 'cf', 'ca', 'vs', 'approx', 'incl', 'lit', 'Ziff', 'al', 'art', 'n', 'nº', 'núm', 'pag', 'pp', 'p', 'ch', 'Bd', 'Kap', 'Rn', 'Dr', 'Mr', 'Mrs', 'Ms', 'St', 'Prof', 'Fig', 'fig', 'vol', 'Vol', 'e.g', 'i.e', 'z.B', 'bzw', 'ggf'];
const ABBR_END = new RegExp(`(?:^|[\\s(*_"'\u00ab\u201c])(?:${ABBREVIATIONS.map((a) => a.replace(/\./g, '\\.')).join('|')})\\.$`, 'u');
const NEXT_CONTINUES = /^(?:\d|\p{Ll})/u;
const EN_STOP = new Set('the and of to in is that for it with as are on be this by you your or from at not have an can will if they which their more there when but has was all also any one may other than these into its only must about after before each should would does do'.split(' '));

export const DEFECTS = Object.freeze({
  'markdown-emphasis': 'Markdown emphasis left visible (** or __)',
  'markdown-link': 'Markdown link left visible ([text](url))',
  'markdown-heading': 'Markdown heading marker left visible (# at line start)',
  'markdown-code': 'Backtick left visible',
  placeholder: 'Unresolved placeholder or template value',
  'double-escaped-entity': 'HTML entity shown as text (&amp; and similar)',
  'split-after-abbreviation': 'Paragraph cut after an abbreviation',
  'duplicate-paragraph': 'Paragraph repeated on the same page',
  'possible-untranslated': 'Passage that looks English on a page in another language',
});
const PATTERNS = {
  'markdown-emphasis': /\*\*|(?<![\w_])__(?=\S)|(?<=\S)__(?![\w_])/g,
  'markdown-link': /\[[^\]\n]{1,160}\]\((?:https?:\/\/|\/|#|mailto:)[^)\s]*\)/g,
  'markdown-heading': /^#{1,6} \S/gm,
  'markdown-code': /`/g,
  placeholder: /\{\{\s*[\w.-]+\s*\}\}|\{[a-z][a-z0-9]*(?:_[a-z0-9]+)+\}|\$\{[^}\n]{1,60}\}|\[object Object\]|\bundefined\b|\bNaN\b|%\([a-z_]+\)s|(?<![\w%])%[sd](?![\w%])/g,
  'double-escaped-entity': /&(?:amp|lt|gt|quot|apos|nbsp|#\d{2,6}|#x[0-9a-f]{2,5});/gi,
};

const around = (text, start, end, width = 70) => text.slice(Math.max(0, start - width), Math.min(text.length, end + width)).replace(/\n+/g, ' ⏎ ').trim();

export function checkText(text, lang = '') {
  const found = [];
  for (const [kind, re] of Object.entries(PATTERNS)) for (const m of text.matchAll(re)) found.push({ kind, context: around(text, m.index, m.index + m[0].length) });
  const paras = text.split(/\n\n/).map((p) => p.trim()).filter(Boolean);
  paras.forEach((para, i) => {
    const next = paras[i + 1];
    if (next && ABBR_END.test(para) && NEXT_CONTINUES.test(next)) found.push({ kind: 'split-after-abbreviation', context: `${para.slice(-70)} ⏎ ${next.slice(0, 50)}` });
  });
  const seen = new Map();
  for (const para of paras) {
    if (para.length < 80) continue;
    seen.set(para, (seen.get(para) ?? 0) + 1);
    if (seen.get(para) === 2) found.push({ kind: 'duplicate-paragraph', context: para.slice(0, 140) });
  }
  if (lang && !lang.startsWith('en')) for (const para of paras) {
    const words = para.toLowerCase().match(/\p{L}+/gu) ?? [];
    if (words.length >= 12 && words.filter((w) => EN_STOP.has(w)).length / words.length >= 0.3) found.push({ kind: 'possible-untranslated', context: para.slice(0, 140) });
  }
  return found;
}

// ---------- sources ----------
async function fetchText(url, accept) {
  const parsed = new URL(url);
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error(`${url} is not an http or https address`);
  const res = await fetch(parsed, { headers: { Accept: accept, 'User-Agent': USER_AGENT }, redirect: 'follow', signal: AbortSignal.timeout(30000) });
  const chunks = [];
  let size = 0;
  for await (const chunk of res.body ?? []) {
    size += chunk.length;
    if (size > MAX_PAGE_BYTES) throw new Error(`${url} exceeds ${MAX_PAGE_BYTES} bytes`);
    chunks.push(chunk);
  }
  return { status: res.status, type: res.headers.get('content-type') ?? '', body: Buffer.concat(chunks).toString('utf8') };
}

// Page URLs from a sitemap or a sitemap index, filtered by a substring.
export async function sitemapUrls(url, match = '', limit = MAX_PAGES) {
  const out = [];
  const queue = [url];
  while (queue.length && out.length < limit) {
    const { status, body } = await fetchText(queue.shift(), 'application/xml, text/xml');
    if (status >= 400) throw new Error(`sitemap answered HTTP ${status}`);
    const locs = [...body.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) => decode(m[1]));
    if (/<sitemapindex\b/i.test(body)) queue.push(...locs);
    else for (const loc of locs) if (loc.includes(match) && out.length < limit) out.push(loc);
  }
  return [...new Set(out)];
}

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

// ---------- audit ----------
export function summarize(pages, source) {
  const defects = {};
  for (const page of pages) for (const d of page.defects ?? []) {
    const entry = (defects[d.kind] ??= { label: DEFECTS[d.kind], pages: new Set(), hits: 0, examples: [] });
    entry.pages.add(page.url);
    entry.hits += 1;
    if (entry.examples.length < 5 && !entry.examples.some((e) => e.url === page.url)) entry.examples.push({ url: page.url, context: d.context });
  }
  const sorted = Object.entries(defects).sort((a, b) => b[1].pages.size - a[1].pages.size)
    .map(([kind, e]) => ({ kind, label: e.label, pages: e.pages.size, hits: e.hits, examples: e.examples }));
  const status = (s) => pages.filter((p) => p.status === s).map((p) => ({ url: p.url, reason: p.reason }));
  return {
    schemaVersion: 1,
    measure: 'published-content-defects',
    source,
    auditedAt: new Date().toISOString(),
    pages: { checked: status('checked').length, withDefects: pages.filter((p) => p.defects?.length).length, blocked: status('blocked'), unreadable: status('unreadable') },
    defects: sorted,
    byPage: pages.filter((p) => p.defects?.length).map((p) => ({ url: p.url, lang: p.lang, defects: p.defects })),
    notes: [
      'Only text present in the served HTML is checked; text loaded later by JavaScript is reported as unreadable.',
      'Each kind is a pattern match: confirm an example on the live page before changing code.',
      'possible-untranslated is a heuristic based on common English words and needs a human look.',
    ],
  };
}

export async function auditUrls(urls, { delay = 1500, onPage } = {}) {
  const pages = [];
  let blockedRun = 0;
  for (const [i, url] of urls.entries()) {
    let page;
    try {
      const { status, type, body } = await fetchText(url, 'text/html');
      if (status === 403 || status === 429 || BLOCKED.test(body)) page = { url, status: 'blocked', reason: `HTTP ${status}, bot check or rate limit` };
      else if (status >= 400) page = { url, status: 'unreadable', reason: `HTTP ${status}` };
      else if (!/html/.test(type)) page = { url, status: 'unreadable', reason: `not HTML (${type || 'unknown type'})` };
      else page = pageFrom(url, body);
    } catch (error) { page = { url, status: 'unreadable', reason: error.message }; }
    pages.push(page);
    onPage?.(page, i + 1, urls.length);
    blockedRun = page.status === 'blocked' ? blockedRun + 1 : 0;
    // ponytail: three bot checks in a row means the site is throttling us; stop instead of hammering it.
    if (blockedRun >= 3) {
      for (const rest of urls.slice(i + 1)) pages.push({ url: rest, status: 'blocked', reason: 'not fetched: the site started blocking requests' });
      break;
    }
    if (i < urls.length - 1) await sleep(delay);
  }
  return pages;
}

function pageFrom(url, html) {
  const { title, lang, text, blocked } = extractPage(html);
  if (blocked) return { url, status: 'blocked', reason: 'bot check page' };
  const words = (text.match(/\p{L}+/gu) ?? []).length;
  if (words < 30) return { url, status: 'unreadable', reason: 'almost no text in the HTML (probably rendered by JavaScript)' };
  return { url, title, lang, words, status: 'checked', defects: checkText(text, lang) };
}

export function auditDir(dir) {
  const files = readdirSync(dir).filter((f) => /\.html?$/i.test(f)).sort().slice(0, MAX_PAGES);
  return files.map((f) => {
    const file = join(dir, f);
    if (statSync(file).size > MAX_PAGE_BYTES) return { url: f, status: 'unreadable', reason: 'file too large' };
    return pageFrom(f, readFileSync(file, 'utf8'));
  });
}

// ---------- reports ----------
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function renderMarkdown(r) {
  const lines = [`# Published content defects`, '', `Source: ${r.source}. Checked ${r.pages.checked} pages; ${r.pages.withDefects} have at least one defect. Blocked: ${r.pages.blocked.length}. Unreadable: ${r.pages.unreadable.length}.`, ''];
  if (!r.defects.length) lines.push('No defect found in the checked pages.', '');
  for (const d of r.defects) {
    lines.push(`## ${d.label}`, '', `${d.pages} pages, ${d.hits} occurrences. Examples:`, '');
    for (const e of d.examples) lines.push(`- ${e.url}`, `  \`${e.context.replace(/`/g, "'")}\``);
    lines.push('');
  }
  lines.push('## What to do', '', 'Confirm one example per kind on the live page. Look for the cause in the renderer or the content generator before editing content: a kind that hits many pages almost always has one cause. Rerun this audit after the fix and compare the counts.', '');
  if (r.pages.unreadable.length || r.pages.blocked.length) lines.push('## Not checked', '', ...[...r.pages.blocked, ...r.pages.unreadable].slice(0, 50).map((p) => `- ${p.url}: ${p.reason}`), '');
  return lines.join('\n');
}

export function renderHtml(r) {
  const card = (d, i) => `<details class="kind" style="--i:${i}"${i === 0 ? ' open' : ''}><summary><span class="n">${d.pages}</span><span class="t">${esc(d.label)}</span><span class="h">${d.hits} occurrence${d.hits === 1 ? '' : 's'}</span></summary><ul>${d.examples.map((e) => `<li><a href="${esc(/^https?:/.test(e.url) ? e.url : '#')}">${esc(e.url)}</a><code>${esc(e.context)}</code></li>`).join('')}</ul></details>`;
  const skipped = [...r.pages.blocked, ...r.pages.unreadable];
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Published content defects</title><style>
:root{--bg:oklch(0.19 0.01 60);--card:oklch(0.215 0.01 60);--ink:oklch(0.95 0.003 60);--sub:oklch(0.8 0.003 60);--mute:oklch(0.68 0.003 60);--line:oklch(0.95 0.0015 60 / .1);--brand:#3ecf8e;color-scheme:dark}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.6 'Plus Jakarta Sans',system-ui,sans-serif}main{max-width:980px;margin:0 auto;padding:56px 24px 80px}
.label{font:500 11px/1.4 ui-monospace,'SF Mono',Menlo,monospace;letter-spacing:.1em;text-transform:uppercase;color:var(--mute)}h1{font-size:clamp(30px,5vw,52px);line-height:1.08;font-weight:600;margin:14px 0 10px;letter-spacing:-.02em}
.lede{color:var(--sub);max-width:640px}.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;margin:36px 0}.stat{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:18px}.stat b{display:block;font-size:30px;font-weight:600}
.kind{background:var(--card);border:1px solid var(--line);border-radius:14px;margin:12px 0;animation:in .5s cubic-bezier(.2,.8,.2,1) both;animation-delay:calc(var(--i)*60ms)}summary{display:flex;gap:16px;align-items:baseline;padding:18px 20px;cursor:pointer;list-style:none}
.n{font:600 26px/1 ui-monospace,Menlo,monospace;color:var(--brand);min-width:3ch}.t{flex:1;font-weight:500}.h{color:var(--mute);font-size:13px}ul{list-style:none;margin:0;padding:0 20px 18px}li{border-top:1px solid var(--line);padding:12px 0}li a{color:var(--sub);font-size:13px;word-break:break-all}
code{display:block;margin-top:6px;font:13px/1.6 ui-monospace,Menlo,monospace;color:var(--ink);white-space:pre-wrap;word-break:break-word}.clean{color:var(--brand)}footer{color:var(--mute);font-size:13px;margin-top:40px}
@keyframes in{from{opacity:0;transform:translateY(10px)}}@media (prefers-reduced-motion:reduce){.kind{animation:none}}</style></head><body><main>
<div class="label">youdede / Published content defects</div>
<h1>${r.defects.length ? `${r.pages.withDefects} of ${r.pages.checked} pages need a fix` : '<span class="clean">No defect found</span>'}</h1>
<p class="lede">${esc(r.source)}. Each group is one kind of defect a reader can see: the count is the number of pages it appears on. A kind that hits many pages usually has one cause in the renderer or the generator.</p>
<div class="stats"><div class="stat"><b>${r.pages.checked}</b><span class="label">pages checked</span></div><div class="stat"><b>${r.defects.length}</b><span class="label">defect kinds</span></div><div class="stat"><b>${r.defects.reduce((s, d) => s + d.hits, 0)}</b><span class="label">occurrences</span></div><div class="stat"><b>${skipped.length}</b><span class="label">not checked</span></div></div>
${r.defects.map(card).join('\n')}
${skipped.length ? `<details class="kind" style="--i:${r.defects.length}"><summary><span class="n">${skipped.length}</span><span class="t">Pages not checked</span><span class="h">blocked or no text in the HTML</span></summary><ul>${skipped.slice(0, 100).map((p) => `<li>${esc(p.url)}<code>${esc(p.reason)}</code></li>`).join('')}</ul></details>` : ''}
<footer>${r.notes.map(esc).join(' ')}</footer>
</main></body></html>
`;
}

// ---------- cli ----------
const USAGE = 'usage: audit-content-defects.mjs (--url <page> | --sitemap <url> [--match <text>] [--limit <n>] | --dir <folder>) [--delay <ms>] [--list] [--format json|html|md] [--out <file>]';

async function main(argv) {
  const { values } = parseArgs({ args: argv, strict: true, options: { help: { type: 'boolean' }, url: { type: 'string' }, sitemap: { type: 'string' }, match: { type: 'string', default: '' }, limit: { type: 'string', default: String(MAX_PAGES) }, dir: { type: 'string' }, delay: { type: 'string', default: '1500' }, list: { type: 'boolean' }, format: { type: 'string', default: 'json' }, out: { type: 'string' } } });
  if (values.help) return process.stdout.write(`${USAGE}\n`);
  const sources = ['url', 'sitemap', 'dir'].filter((k) => values[k]);
  const limit = Number(values.limit);
  const delay = Number(values.delay);
  if (sources.length !== 1 || !['json', 'html', 'md'].includes(values.format) || !(limit >= 1 && limit <= MAX_PAGES) || !(delay >= 0)) throw new Error(USAGE);
  let pages;
  let source;
  if (values.dir) { pages = auditDir(values.dir); source = `saved HTML in ${values.dir.split(/[\\/]/).filter(Boolean).pop()}`; } else {
    const urls = values.url ? [values.url] : await sitemapUrls(values.sitemap, values.match, limit);
    if (values.list) return process.stdout.write(`${JSON.stringify({ pages: urls.length, urls }, null, 2)}\n`);
    if (!urls.length) throw new Error('the sitemap lists no page that matches');
    source = values.url ?? `${values.sitemap}${values.match ? ` (pages containing "${values.match}")` : ''}`;
    pages = await auditUrls(urls, { delay, onPage: (p, i, n) => process.stderr.write(`${i}/${n} ${p.status} ${p.url}\n`) });
  }
  const result = summarize(pages, source);
  const body = values.format === 'html' ? renderHtml(result) : values.format === 'md' ? renderMarkdown(result) : `${JSON.stringify(result, null, 2)}\n`;
  if (values.out) {
    writeFileSync(values.out, body);
    process.stdout.write(`${JSON.stringify({ written: values.out, checked: result.pages.checked, withDefects: result.pages.withDefects })}\n`);
  } else process.stdout.write(body);
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2)).catch((error) => { process.stderr.write(`audit-content-defects: ${error.message}\n`); process.exitCode = 1; });
}
