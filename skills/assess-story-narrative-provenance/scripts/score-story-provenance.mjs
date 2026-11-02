#!/usr/bin/env node
// The StoryScope measure (Russell et al., COLM 2026, arXiv 2604.03136): a story is annotated on the paper's
// 304 narrative features, then the paper's own binary XGBoost classifier gives P(human). Data and model: MIT,
// see STORYSCOPE-LICENSE.txt. Encoding and value matching port storyscope/utils/feature_encoder.py exactly.
import { readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const HERE = dirname(fileURLToPath(import.meta.url));
const MAX_BYTES = 512 * 1024;
const MAX_PAGE_BYTES = 4 * 1024 * 1024;
const TYPESAFE_URL = 'https://api.typesafe.ai/v1/systemone';
// The paper's stories run from about 1,000 to 6,000 words; outside that range the result is unvalidated.
const VALIDATED_WORDS = [1000, 6000];
const TAXONOMY = JSON.parse(readFileSync(join(HERE, 'storyscope-taxonomy.json'), 'utf8')).dimensions;
const FEATURES = TAXONOMY.flatMap((dim) => dim.features);
let model;
const loadModel = () => (model ??= JSON.parse(readFileSync(join(HERE, 'storyscope-model.json'), 'utf8')));

// ---------- value matching (feature_encoder.py `_normalize_str`, `_best_match`) ----------
export const normalizeStr = (s) => String(s).trim().toLowerCase().replace(/\s*\([^)]*\)/g, '').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');

export function bestMatch(raw, allowed, minOverlap) {
  if (!allowed.length) return raw;
  const norm = normalizeStr(raw);
  for (const value of allowed) if (normalizeStr(value) === norm) return value;
  const num = norm.match(/^(\d+)/);
  if (num) for (const value of allowed) if (normalizeStr(value).match(/^(\d+)/)?.[1] === num[1]) return value;
  for (const value of allowed) {
    const c = normalizeStr(value);
    if (norm.startsWith(c) || c.startsWith(norm)) return value;
  }
  const tokens = new Set(norm.split('_'));
  let best = 0;
  let pick = null;
  for (const value of allowed) {
    const c = new Set(normalizeStr(value).split('_'));
    const overlap = [...tokens].filter((t) => c.has(t)).length;
    const score = overlap / Math.max(tokens.size, c.size);
    if (score > best) [best, pick] = [score, value];
  }
  return best >= minOverlap && pick !== null ? pick : raw;
}

// apply_features.py `normalize_features` (threshold 0.5), applied to raw annotator answers.
export function normalizeAnswers(raw) {
  const out = {};
  for (const f of FEATURES) {
    if (!(f.id in raw)) continue;
    const v = raw[f.id];
    const allowed = f.values.map(String);
    if (v === 'n/a' || v === null || v === undefined) out[f.id] = 'n/a';
    else if (f.type === 'multi_select') {
      const seen = new Set();
      out[f.id] = (Array.isArray(v) ? v : [v]).map((x) => bestMatch(String(x), allowed, 0.5)).filter((m) => !seen.has(normalizeStr(m)) && seen.add(normalizeStr(m)));
    } else if (f.type === 'scale') {
      const m = String(v).trim().match(/^(\d+)/);
      out[f.id] = m ? Number(m[1]) : v;
    } else out[f.id] = bestMatch(String(v), allowed, 0.5);
  }
  return out;
}

// feature_encoder.py `encode_features(mode="multi_hot")`: one row of 462 values, NaN for missing, -1 for n/a.
export function encode(answers) {
  const row = [];
  for (const f of FEATURES) {
    const allowed = f.values.map(String);
    const set = valueSet(answers[f.id], allowed, f.type === 'multi_select');
    if (f.type === 'multi_select') {
      for (const value of allowed) row.push(set === null ? NaN : set === 'n/a' ? 0 : Number(set.has(value)));
    } else if (set === null) row.push(NaN);
    else if (set === 'n/a') row.push(-1);
    else {
      const first = allowed.find((value) => set.has(value));
      row.push(first === undefined ? NaN : allowed.indexOf(first));
    }
  }
  return row;
}

function valueSet(x, allowed, splitPipes) {
  if (x === null || x === undefined || (typeof x === 'number' && Number.isNaN(x))) return null;
  let parts = Array.isArray(x) ? x.map(String) : splitPipes ? String(x).split('|') : [String(x)];
  if (parts.length === 1 && parts[0] === 'n/a') return 'n/a';
  parts = parts.filter((p) => p && p !== 'n/a');
  const canonical = (p) => {
    const m = allowed.includes(p) ? p : bestMatch(p, allowed, 0.33);
    return allowed.includes(m) ? m : null;
  };
  return new Set(parts.map(canonical).filter((c) => c !== null));
}

// XGBoost binary:logistic: go left when x < condition, the default branch when x is missing.
export function pHuman(row) {
  const { baseScore, trees } = loadModel();
  let margin = Math.log(baseScore / (1 - baseScore));
  for (const [left, right, feature, condition, defaultLeft] of trees) {
    let node = 0;
    while (left[node] !== -1) {
      const x = row[feature[node]];
      node = Number.isNaN(x) ? (defaultLeft[node] ? left[node] : right[node]) : Math.fround(x) < condition[node] ? left[node] : right[node];
    }
    margin += condition[node];
  }
  return 1 / (1 + Math.exp(-margin));
}

export const scoreAnswers = (raw) => pHuman(encode(normalizeAnswers(raw)));

// Which answers moved this story's score, in log-odds: Saabas path attribution, as XGBoost's
// `pred_contribs(approx_contribs=True)`. A node's value is the hessian-weighted mean of its leaves; each split
// credits its feature with the change in value along the story's path. bias + the sum of all parts = the margin.
const nodeMeans = new WeakMap();
function means(tree) {
  if (!nodeMeans.has(tree)) {
    const [left, right, , value, , hessian] = tree;
    const mean = [];
    const fill = (n) => (mean[n] = left[n] === -1 ? value[n] : (fill(left[n]) * hessian[left[n]] + fill(right[n]) * hessian[right[n]]) / (hessian[left[n]] + hessian[right[n]]));
    fill(0);
    nodeMeans.set(tree, mean);
  }
  return nodeMeans.get(tree);
}

export function explain(row) {
  const { baseScore, features: columns, trees } = loadModel();
  const contrib = new Float64Array(row.length);
  let bias = Math.log(baseScore / (1 - baseScore));
  for (const tree of trees) {
    const [left, right, feature, condition, defaultLeft] = tree;
    const mean = means(tree);
    bias += mean[0];
    let node = 0;
    while (left[node] !== -1) {
      const x = row[feature[node]];
      const next = Number.isNaN(x) ? (defaultLeft[node] ? left[node] : right[node]) : Math.fround(x) < condition[node] ? left[node] : right[node];
      contrib[feature[node]] += mean[next] - mean[node];
      node = next;
    }
  }
  const byFeature = new Map();
  columns.forEach((name, i) => {
    if (contrib[i]) byFeature.set(name.split('__')[0], (byFeature.get(name.split('__')[0]) ?? 0) + contrib[i]);
  });
  return { bias, byFeature };
}

// The answers that pushed hardest each way, named in the paper's words, for a report.
export function drivers(rawRuns, limit = 6) {
  const total = new Map();
  for (const raw of rawRuns) {
    for (const [id, value] of explain(encode(normalizeAnswers(raw))).byFeature) total.set(id, (total.get(id) ?? 0) + value / rawRuns.length);
  }
  const dimOf = new Map(TAXONOMY.flatMap((dim) => dim.features.map((f) => [f.id, dim.name])));
  const answer = (id) => {
    const v = normalizeAnswers(rawRuns[0])[id];
    const f = FEATURES.find((x) => x.id === id);
    // A bare number means nothing in a report: name the scale's ends.
    const numeric = f.values.length > 1 && f.values.every((x) => /^\d+$/.test(String(x)));
    if ((typeof v === 'number' || /^\d+$/.test(String(v))) && numeric) return `${v} on a scale of ${Math.min(...f.values.map(Number))} to ${Math.max(...f.values.map(Number))}`;
    return Array.isArray(v) ? (v.length ? v.join(', ') : 'none') : v === undefined ? 'missing' : String(v);
  };
  const item = ([id, push]) => ({ id, feature: FEATURES.find((f) => f.id === id).name, question: FEATURES.find((f) => f.id === id).question, dimension: dimOf.get(id), answer: answer(id).replace(/_/g, ' '), push: Number(push.toFixed(3)) });
  const sorted = [...total].sort((a, b) => a[1] - b[1]);
  const sum = (sign) => Number(sorted.reduce((a, [, v]) => (Math.sign(v) === sign ? a + Math.abs(v) : a), 0).toFixed(3));
  return { pullAi: sum(-1), pullHuman: sum(1), towardAi: sorted.filter(([, v]) => v < 0).slice(0, limit).map(item), towardHuman: sorted.filter(([, v]) => v > 0).reverse().slice(0, limit).map(item) };
}

// ---------- annotation ----------
// apply_features.py `build_dimension_prompt`, for an agent that annotates without TypeSafe.
export function dimensionPrompt(dim, story) {
  const specs = dim.features.flatMap((f) => {
    const values = f.values.slice(0, 10).map(String).join(', ') + (f.values.length > 10 ? ` (+ ${f.values.length - 10} more)` : '');
    return [`**${f.id}** [${f.type}]: ${f.question}`, `  → Values: ${values}`, ...(f.condition ? [`  → Condition: ${f.condition}`] : [])];
  });
  return `You are a literary analyst specializing in ${dim.name.toLowerCase()}.\n\nExtract structured features about **${dim.name}** from the story below.\nFocus area: ${dim.description}\n\n# FEATURES TO EXTRACT\n\nFor each feature, select the appropriate value(s) from the allowed options.\n\n**Response format rules:**\n- For "binary" features: respond with exactly "yes" or "no"\n- For "categorical" features: respond with exactly ONE value from the list\n- For "ordinal" features: respond with exactly ONE value from the list\n- For "multi_select" features: respond with a JSON array of ALL applicable values\n- For "scale" features: respond with an integer within the specified range\n- ONLY use values from the provided lists\n- If a feature has a condition that is not met, use "n/a"\n- **Never use null or omit a key**: every feature must have a value\n\n${specs.join('\n')}\n\n# STORY TO ANALYZE\n\n<story>\n${story}\n</story>\n\n# OUTPUT\n\nReturn a single JSON object with feature IDs as keys.\n`;
}

// The same features as typed TypeSafe questions: a Choice per single-valued feature, a Noul per multi-select value.
export function typesafeQuestions(dim) {
  const qs = {};
  for (const f of dim.features) {
    const values = f.values.map(String);
    if (f.type === 'multi_select') {
      values.forEach((v, i) => {
        qs[`${f.id}::${i}`] = { type: 'noul', instructions: `${f.name}. ${f.question} Does the value "${v}" apply to the story?`, criteria: { true: `"${v}" applies to this story.`, false: `"${v}" does not apply to this story.` } };
      });
    } else {
      let options = f.type === 'binary' && !values.length ? ['yes', 'no'] : values;
      if (f.condition && !options.includes('n/a')) options = [...options, 'n/a'];
      const cond = f.condition ? ` Answer "n/a" when this does not apply: ${f.condition}.` : '';
      qs[f.id] = { type: 'choice', instructions: `${f.name}. ${f.question}${cond}`, criteria: Object.fromEntries(options.map((o) => [o, o])) };
    }
  }
  return qs;
}

async function annotateWithTypesafe(story, key) {
  const answers = await Promise.all(TAXONOMY.map(async (dim) => {
    const res = await fetch(TYPESAFE_URL, { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'jev-latest', state: { story }, questions: typesafeQuestions(dim) }), signal: AbortSignal.timeout(120000) });
    if (!res.ok) throw new Error(`TypeSafe answered HTTP ${res.status}`);
    return { dim, body: await res.json() };
  }));
  const raw = {};
  let tokens = 0;
  let modelName = null;
  for (const { dim, body } of answers) {
    tokens += body.usage?.input_tokens ?? 0;
    modelName = body.model ?? modelName;
    for (const f of dim.features) {
      raw[f.id] = f.type === 'multi_select'
        ? f.values.map(String).filter((_, i) => body.answers?.[`${f.id}::${i}`]?.noul > 0.5)
        : body.answers?.[f.id]?.choice;
    }
  }
  return { raw, tokens, model: modelName };
}

// Two or more runs: their mean decides; disagreement across the 0.5 line is reported as uncertain.
export function verdict(probabilities) {
  const mean = probabilities.reduce((a, b) => a + b, 0) / probabilities.length;
  const sides = new Set(probabilities.map((p) => p >= 0.5));
  return { mean: Number(mean.toFixed(4)), verdict: sides.size > 1 ? 'uncertain' : mean >= 0.5 ? 'human-like' : 'ai-like' };
}

const words = (text) => (text.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) || []).length;

function readText(path) {
  const real = realpathSync(path);
  if (statSync(real).size > MAX_BYTES) throw new Error(`input exceeds ${MAX_BYTES} bytes`);
  return readFileSync(real, 'utf8');
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', mdash: '\u2014', ndash: '\u2013', hellip: '…' };
const decode = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => e[0] === '#'
  ? String.fromCodePoint(Number.parseInt(e[1].toLowerCase() === 'x' ? e.slice(2) : e.slice(1), e[1].toLowerCase() === 'x' ? 16 : 10))
  : ENTITIES[e.toLowerCase()] ?? m);

// ponytail: regex reader, not a DOM parser. It keeps the first <article>, else <main>, else <body>, and drops
// page chrome. Pages that render text with JavaScript or split a story across pages need the text saved to a file.
export function extractText(html) {
  const title = decode(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '').trim();
  let body = html.replace(/<!--[\s\S]*?-->/g, '').replace(/<(script|style|noscript|svg|template|iframe)\b[\s\S]*?<\/\1>/gi, '');
  body = body.match(/<article\b[\s\S]*?<\/article>/i)?.[0] ?? body.match(/<main\b[\s\S]*?<\/main>/i)?.[0] ?? body.match(/<body\b[\s\S]*<\/body>/i)?.[0] ?? body;
  body = body.replace(/<(nav|header|footer|aside|form)\b[\s\S]*?<\/\1>/gi, '');
  const text = decode(body.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|h[1-6]|li|blockquote|section)>/gi, '\n\n').replace(/<[^>]+>/g, ''))
    .split('\n').map((line) => line.replace(/[ \t ]+/g, ' ').trim()).join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return { title, text };
}

async function readUrl(url) {
  const parsed = new URL(url);
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('--url must be an http or https address');
  const res = await fetch(parsed, { headers: { Accept: 'text/html, text/plain' }, redirect: 'follow', signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`the page answered HTTP ${res.status}`);
  const type = res.headers.get('content-type') ?? '';
  if (!/text\/(html|plain)|application\/xhtml/.test(type)) throw new Error(`the page is ${type || 'of unknown type'}, not HTML or text`);
  const chunks = [];
  let size = 0;
  for await (const chunk of res.body) {
    size += chunk.length;
    if (size > MAX_PAGE_BYTES) throw new Error(`the page exceeds ${MAX_PAGE_BYTES} bytes`);
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  const page = type.includes('text/plain') ? { title: '', text: raw.trim() } : extractText(raw);
  if (Buffer.byteLength(page.text) > MAX_BYTES) throw new Error(`the extracted text exceeds ${MAX_BYTES} bytes`);
  if (!words(page.text)) throw new Error('no readable text on the page (it probably loads its text with JavaScript); save the text to a file and use --text');
  return { text: page.text, source: { type: 'url', url: res.url, title: page.title } };
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// A self-contained report in the youdede.eu visual language: inline styles and one inline script, no fonts or
// remote assets, so it opens offline and is safe to share. Without JavaScript every value is already in place.
const REPORT_CSS = `:root{--canvas:oklch(0.19 0.01 60);--surface:oklch(0.215 0.01 60);--raised:oklch(0.95 0.0015 60 / 0.075);--ink:oklch(0.95 0.003 60);--ink-subtle:oklch(0.798 0.003 60);--ink-muted:oklch(0.684 0.003 60);--hairline:oklch(0.95 0.0015 60 / 0.075);--hairline-strong:oklch(0.95 0.0014 60 / 0.135);--brand:#3ecf8e;--brand-solid:#1d744d;--brand-border:rgba(62,207,142,.3);--sans:'Plus Jakarta Sans',system-ui,-apple-system,'Segoe UI',sans-serif;--mono:'JetBrains Mono',ui-monospace,'SF Mono',Menlo,monospace;--serif:'Palatino Linotype','Book Antiqua',Georgia,serif;--g:clamp(24px,calc(9.14px + 3.81vw),64px);color-scheme:dark}
*,*::before,*::after{box-sizing:border-box}
body{margin:0;background:var(--canvas);color:var(--ink);font:450 14px/22px var(--sans);-webkit-font-smoothing:antialiased;position:relative}
body::before{content:"";position:absolute;inset:0 0 auto;height:520px;pointer-events:none;background-image:radial-gradient(var(--hairline-strong) 1px,transparent 1px);background-size:24px 24px;mask-image:linear-gradient(to bottom,black,transparent)}
main{position:relative;max-width:1040px;margin:0 auto;padding:var(--g) var(--g) calc(var(--g)*1.618)}
.label{font:400 12px/1.5 var(--mono);text-transform:uppercase;letter-spacing:.08em;color:var(--ink-muted);font-variant-numeric:tabular-nums}
.top{display:flex;justify-content:space-between;gap:16px;padding-bottom:20px;border-bottom:1px solid var(--hairline);margin-bottom:calc(var(--g)*1.2)}
.top b{color:var(--ink);font-weight:500}
h1{font-weight:500;font-size:clamp(32px,6.2vw,46px);line-height:1.1;margin:12px 0 16px;letter-spacing:normal}
h1 .dot{display:inline-block;width:.32em;height:.32em;border-radius:999px;background:var(--tone);margin-right:.35em;vertical-align:.18em;box-shadow:0 0 24px var(--tone)}
h2{font-weight:500;font-size:clamp(24px,3.2vw,32px);line-height:1.2;margin:0 0 8px}
h3{font-weight:500;font-size:15px;line-height:22.5px;margin:0}
.lede{font-size:16px;line-height:24px;color:var(--ink-muted);max-width:640px;margin:0}
.source{margin-top:20px;color:var(--ink-subtle)}.source a{color:inherit;text-decoration-color:var(--hairline-strong);text-underline-offset:3px}
section{margin-top:calc(var(--g)*1.2)}
.head{display:flex;justify-content:space-between;align-items:baseline;gap:16px;margin-bottom:20px}.head p{margin:0;color:var(--ink-muted);max-width:560px}
.metrics{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));border:1px solid var(--hairline);border-radius:14px;overflow:hidden;background:var(--surface)}
.metric{padding:20px 22px;border-left:1px solid var(--hairline)}.metric:first-child{border-left:0}
.metric .v{font:500 28px/1.2 var(--sans);margin-top:6px;font-variant-numeric:tabular-nums}.metric .s{color:var(--ink-muted);font-size:13px;margin-top:2px}
.card{background:var(--surface);border:1px solid var(--hairline);border-radius:14px;padding:24px}
.pill{display:inline-flex;align-items:center;gap:6px;border:1px solid var(--hairline-strong);border-radius:999px;padding:2px 10px;font:400 11px/1.6 var(--mono);letter-spacing:.09em;text-transform:uppercase;color:var(--ink-subtle)}
.pill.ok{border-color:var(--brand-border);color:var(--brand)}.pill.warn{color:var(--ink);background:var(--raised)}
.notes{margin:0;padding:0;list-style:none}.notes li{padding:12px 0 12px 24px;border-top:1px solid var(--hairline);color:var(--ink-muted);position:relative}.notes li:first-child{border-top:0}
.notes li::before{content:"";position:absolute;left:4px;top:21px;width:6px;height:6px;border-radius:999px;background:var(--ink-muted)}
.notes li.key{color:var(--ink)}.notes li.key::before{background:var(--brand)}
footer{margin-top:calc(var(--g)*1.2);padding-top:20px;border-top:1px solid var(--hairline);color:var(--ink-muted);font-size:13px;line-height:20px}
footer p{margin:0 0 6px}
@media (max-width:640px){.metric{border-left:0;border-top:1px solid var(--hairline)}.metric:first-child{border-top:0}.top{flex-direction:column}}
@media print{body{background:#fff;color:#141815}body::before{display:none}}
:root{--ease:cubic-bezier(0.22,0.61,0.36,1);--ease-text:cubic-bezier(0.16,1,0.3,1);--spring:cubic-bezier(0.34,1.56,0.64,1)}
.js .rv{opacity:0;transform:translateY(16px);transition:opacity .9s var(--ease-text),transform .9s var(--ease-text);transition-delay:calc(var(--i,0)*80ms)}
.js .rv.in{opacity:1;transform:none}
.js h1 .w{display:inline-block;opacity:0;transform:translateY(.45em);filter:blur(8px);animation:w-in 1s var(--ease-text) forwards;animation-delay:calc(var(--i)*90ms + 120ms)}
@keyframes w-in{to{opacity:1;transform:none;filter:blur(0)}}
h1 .dot{animation:pulse 2.8s var(--ease) infinite}
@keyframes pulse{0%,100%{box-shadow:0 0 0 0 var(--tone),0 0 24px var(--tone)}50%{box-shadow:0 0 0 8px transparent,0 0 36px var(--tone)}}
.js .grow i{transform:scaleX(0);transform-origin:left;transition:transform 1.3s var(--ease-text);transition-delay:calc(var(--i,0)*90ms + 150ms)}
.js .grow.in i{transform:scaleX(1)}
.metric{transition:background .3s var(--ease)}.metric:hover{background:var(--raised)}
.card,.flag{transition:border-color .3s var(--ease),transform .3s var(--ease)}
.toolbar{display:inline-flex;gap:4px;padding:4px;border:1px solid var(--hairline);border-radius:999px;background:var(--surface)}
.toolbar label{cursor:pointer;padding:6px 14px;border-radius:999px;font:400 11px/1.6 var(--mono);letter-spacing:.09em;text-transform:uppercase;color:var(--ink-muted);transition:background .25s var(--ease),color .25s var(--ease)}
.sr{position:absolute;opacity:0;pointer-events:none}
:focus-visible{outline:2px solid var(--brand);outline-offset:3px;border-radius:6px}
@media (prefers-reduced-motion:reduce){.js .rv,.js h1 .w,.js .grow i{opacity:1;transform:none;filter:none;animation:none;transition:none}h1 .dot{animation:none}}
`;
const REPORT_JS = `(function(){var still=matchMedia('(prefers-reduced-motion: reduce)').matches;
function fmt(v,dec){return v.toLocaleString('en',{minimumFractionDigits:dec,maximumFractionDigits:dec})}
function count(el){if(still||el.dataset.done)return;el.dataset.done=1;var to=parseFloat(el.dataset.to),from=parseFloat(el.dataset.from||'0'),dec=+(el.dataset.dec||0),suf=el.dataset.suf||'',t0=performance.now(),dur=1500;
function f(t){var k=Math.min(1,(t-t0)/dur),e=k===1?1:1-Math.pow(2,-10*k);el.textContent=fmt(from+(to-from)*e,dec)+suf;if(k<1)requestAnimationFrame(f);else el.textContent=el.dataset.final||el.textContent}requestAnimationFrame(f)}
if(!still)document.querySelectorAll('[data-to]').forEach(function(el){el.dataset.final=el.textContent;el.textContent=fmt(parseFloat(el.dataset.from||'0'),+(el.dataset.dec||0))+(el.dataset.suf||'')});
var io=new IntersectionObserver(function(es){es.forEach(function(e){if(!e.isIntersecting)return;var t=e.target;t.classList.add('in');if(t.matches('[data-to]'))count(t);t.querySelectorAll('[data-to]').forEach(count);io.unobserve(t)})},{threshold:0,rootMargin:'0px 0px -8% 0px'});
document.querySelectorAll('.rv,.grow,.stage,[data-to]').forEach(function(el){io.observe(el)});
document.querySelectorAll('[data-flag-btn]').forEach(function(b){b.addEventListener('click',function(){var id=b.getAttribute('data-flag-btn'),on=document.body.getAttribute('data-focus')===id;document.body.setAttribute('data-focus',on?'':id);document.querySelectorAll('[data-flag-btn]').forEach(function(x){x.setAttribute('aria-pressed',String(!on&&x===b))});if(!on){var m=document.querySelector('mark[data-flag="'+id+'"]');if(m)m.scrollIntoView({behavior:still?'auto':'smooth',block:'center'})}})});})();
`;

const READING = {
  'human-like': 'In every run, the narrative choices in this story look more like published human fiction than like AI-generated stories.',
  'ai-like': 'In every run, the narrative choices in this story look more like AI-generated stories than like published human fiction.',
  uncertain: 'The runs disagree: some read this story as human-like and some as AI-like, so the check cannot call it.'
};
const words1 = (text) => esc(text).split(' ').map((w, i) => `<span class="w" style="--i:${i}">${w}</span>`).join(' ');

export function renderHtml(r) {
  const label = { 'human-like': 'Human-like', 'ai-like': 'AI-like', uncertain: 'Uncertain' }[r.verdict];
  const tone = { 'human-like': 'var(--brand)', 'ai-like': 'var(--ink)', uncertain: 'var(--ink-muted)' }[r.verdict];
  const pct = (p) => p > 0.999 ? '>99.9%' : p < 0.001 ? '<0.1%' : `${(p * 100).toFixed(1)}%`;
  const pos = (p) => `${(p * 100).toFixed(2)}%`;
  const count = (p) => `data-to="${Math.min(99.9, Math.max(0.1, p * 100)).toFixed(1)}" data-dec="1" data-suf="%"`;
  // No local folders in a report that may be shared: a file shows its title, or its name.
  const title = r.source.title || (r.source.type === 'url' ? new URL(r.source.url).hostname : basename(r.source.path));
  const source = r.source.type === 'url' ? `<a href="${esc(r.source.url)}">${esc(title)}</a> <span class="host">${esc(new URL(r.source.url).hostname)}</span>` : esc(title);
  const inRange = r.words >= VALIDATED_WORDS[0] && r.words <= VALIDATED_WORDS[1];
  const agree = new Set(r.runs.map((p) => p >= 0.5)).size === 1;
  const ticks = r.runs.map((p, i) => `<i class="tick" style="left:${pos(p)};--i:${i}" title="Run ${i + 1}: ${pct(p)}"></i>`).join('');
  const runs = r.runs.map((p, i) => `<div class="run grow" style="--i:${i}"><span class="label">Run ${i + 1}</span><div class="track"><i style="width:${pos(p)}"></i><b></b></div><span class="label" ${count(p)}>${pct(p)}</span></div>`).join('');
  const d = r.drivers;
  let drivers = '';
  if (d && (d.towardAi.length || d.towardHuman.length)) {
    const max = Math.max(1e-9, ...[...d.towardAi, ...d.towardHuman].map((x) => Math.abs(x.push)));
    const share = d.pullHuman / Math.max(1e-9, d.pullHuman + d.pullAi);
    const cell = (x, side, i) => x ? `<details class="drv ${side} grow" style="--i:${i}"><summary><span class="name">${esc(x.feature)}</span><span class="answer">${esc(x.answer)}</span><span class="bar"><i style="width:${(Math.abs(x.push) / max * 100).toFixed(1)}%"></i></span></summary><div class="more"><span class="label">${esc(x.dimension)} / weight ${x.push > 0 ? '+' : ''}${x.push.toFixed(2)}</span><p>${esc(x.question)}</p></div></details>` : '<div></div>';
    const rows = Array.from({ length: Math.max(d.towardAi.length, d.towardHuman.length) }, (_, i) => `${cell(d.towardAi[i], 'ai', i)}${cell(d.towardHuman[i], 'human', i)}`).join('');
    drivers = `<section><div class="head rv"><div><div class="label">Explanation</div><h2>A tug of war between two pulls</h2></div><p>Every answer about the story pulls toward one side. The knot shows where the strongest pulls left it; below are the answers that pulled hardest. Open one to read the question behind it.</p></div>
<div class="card stage rope-card"><div class="rope-head"><div><div class="label">Pull toward AI-like</div><div class="pull" data-to="${d.pullAi}" data-dec="1">${d.pullAi.toFixed(1)}</div></div><div class="right"><div class="label">Pull toward human-like</div><div class="pull human" data-to="${d.pullHuman}" data-dec="1">${d.pullHuman.toFixed(1)}</div></div></div>
<div class="rope" style="--to:${(share * 100).toFixed(1)}%"><span class="line"></span><span class="mid"></span><span class="knot"></span></div></div>
<div class="card drivers"><div class="cols label"><span>Toward AI-like</span><span class="human">Toward human-like</span></div><div class="grid">${rows}</div></div></section>`;
  }
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(label)}: narrative check</title><script>document.documentElement.classList.add('js')</script><style>${REPORT_CSS}
.host{color:var(--ink-muted);margin-left:8px}
.gauge{position:relative;height:10px;border-radius:999px;background:linear-gradient(90deg,var(--hairline-strong),var(--raised) 50%,var(--brand-border));margin:30px 0 12px}
.gauge .mid{position:absolute;left:50%;top:-8px;bottom:-8px;width:1px;background:var(--hairline-strong)}
.gauge .tick{position:absolute;top:-3px;width:2px;height:16px;margin-left:-1px;background:var(--ink-muted);border-radius:2px;transition:opacity .5s var(--ease) calc(1.2s + var(--i)*120ms)}
.gauge .mean{position:absolute;top:-9px;left:${pos(r.mean)};width:28px;height:28px;margin-left:-14px;border-radius:999px;background:var(--canvas);border:2px solid ${tone};box-shadow:0 0 28px ${tone};transition:left 1.8s var(--spring) .25s}
.js .stage:not(.in) .mean{left:50%}.js .stage:not(.in) .tick{opacity:0}
.scale{display:flex;justify-content:space-between}
.run{display:grid;grid-template-columns:64px 1fr 72px;gap:16px;align-items:center;padding:10px 0;border-top:1px solid var(--hairline)}.run:first-of-type{border-top:0}.run .label:last-child{text-align:right;color:var(--ink)}
.track{position:relative;height:6px;border-radius:999px;background:var(--raised)}.track i{position:absolute;inset:0 auto 0 0;border-radius:999px;background:${tone}}.track b{position:absolute;left:50%;top:-5px;bottom:-5px;width:1px;background:var(--hairline-strong)}
.rope-head{display:flex;justify-content:space-between;gap:16px}.rope-head .right{text-align:right}
.pull{font:500 32px/1.2 var(--sans);font-variant-numeric:tabular-nums;margin-top:4px}.pull.human,.cols .human{color:var(--brand)}
.rope{position:relative;height:40px;margin-top:18px}
.rope .line{position:absolute;left:0;right:0;top:50%;height:2px;margin-top:-1px;background:repeating-linear-gradient(90deg,var(--ink-muted) 0 6px,transparent 6px 9px);border-radius:2px}
.rope .mid{position:absolute;left:50%;top:4px;bottom:4px;width:1px;background:var(--hairline-strong)}
.rope .knot{position:absolute;top:50%;left:var(--to);width:18px;height:18px;margin:-9px 0 0 -9px;border-radius:999px;background:${tone};box-shadow:0 0 30px ${tone};transition:left 2.2s var(--spring) .3s}
.js .stage:not(.in) .knot{left:50%}
.js .stage.in .line{animation:tug 1.1s var(--ease) .2s 2}@keyframes tug{0%,100%{transform:none}35%{transform:translateX(-6px)}70%{transform:translateX(5px)}}
.drivers{margin-top:16px;padding:8px 24px 16px}.cols{display:grid;grid-template-columns:1fr 1fr;padding:14px 0}.cols span:first-child{text-align:right;padding-right:24px}.cols span:last-child{padding-left:24px}
.grid{display:grid;grid-template-columns:1fr 1fr;background:linear-gradient(var(--hairline-strong),var(--hairline-strong)) center/1px 100% no-repeat}
.drv{border-top:1px solid var(--hairline);padding:14px 24px}.drv.ai{text-align:right}
.drv summary{list-style:none;cursor:pointer;display:grid;gap:6px}.drv summary::-webkit-details-marker{display:none}
.drv .name{font-weight:500;font-size:15px;line-height:22px}.drv .answer{font:400 17px/1.45 var(--serif);color:var(--ink-subtle)}
.drv .bar{display:block;height:4px;border-radius:999px;background:var(--raised);margin-top:4px}.drv .bar i{display:block;height:100%;border-radius:999px;background:var(--ink-subtle)}
.drv.ai .bar i{margin-left:auto;transform-origin:right}.drv.human .bar i{background:var(--brand)}
.drv summary:hover .name{color:var(--brand)}.drv[open]{background:var(--raised)}
.drv .more{padding-top:12px;color:var(--ink-muted)}.drv .more p{margin:6px 0 0}
@media (max-width:760px){.grid,.cols{grid-template-columns:1fr;background:none}.drv.ai{text-align:left}.drv.ai .bar i{margin-left:0;transform-origin:left}.cols span:first-child{text-align:left}}
</style></head><body><main style="--tone:${tone}">
<div class="top label"><span><b>youdede</b> / Narrative check</span><span>${esc(r.measuredAt.slice(0, 10))}</span></div>
<div class="label rv">Verdict</div><h1><span class="dot"></span>${words1(label)}</h1><p class="lede rv" style="--i:3">${READING[r.verdict]}</p><div class="source label rv" style="--i:4">${source}</div>
<section><div class="metrics">
<div class="metric rv" style="--i:0"><div class="label">Human-likeness</div><div class="v" ${count(r.mean)}>${pct(r.mean)}</div><div class="s">mean of the runs; 50% is the line</div></div>
<div class="metric rv" style="--i:1"><div class="label">Runs</div><div class="v">${r.runs.length}</div><div class="s">${agree ? 'all on the same side' : 'on both sides of the line'}</div></div>
<div class="metric rv" style="--i:2"><div class="label">Words</div><div class="v" data-to="${r.words}">${r.words.toLocaleString('en')}</div><div class="s">${inRange ? 'inside the validated range' : 'outside 1,000 to 6,000'}</div></div>
<div class="metric rv" style="--i:3"><div class="label">Annotator</div><div class="v" style="font-size:17px;line-height:1.35">${esc(r.annotator.split(',')[0])}</div><div class="s">${esc(r.annotator.split(',').slice(1).join(',').trim() || ' ')}</div></div>
</div>
<div class="card stage" style="margin-top:16px"><div class="gauge"><span class="mid"></span>${ticks}<span class="mean"></span></div><div class="scale label"><span>AI-like</span><span>50%</span><span>Human-like</span></div>
<div style="margin-top:24px">${runs}</div></div></section>
${drivers}
<section><div class="head rv"><div><div class="label">Limits</div><h2>Read this before using the result</h2></div></div><div class="card rv"><ul class="notes"><li class="key">The score describes narrative choices in this text. It is not proof of who wrote it and must not be used to accuse anyone.</li>${r.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul></div></section>
<footer><p>Method: an annotator model answers 304 questions about the story's plot, characters, structure, style, and themes; a classifier trained on human-written and AI-generated stories turns the answers into a probability.</p><p>The explanation shows what the classifier weighed, not what a writer should change.</p></footer>
</main><script>${REPORT_JS}</script></body></html>
`;
}

function scope(text) {
  const n = words(text);
  const notes = ['Validated on full English fiction only; nonfiction, excerpts, and other languages are untested.'];
  if (n < VALIDATED_WORDS[0] || n > VALIDATED_WORDS[1]) notes.push(`The text has ${n} words, outside the ${VALIDATED_WORDS[0]}-${VALIDATED_WORDS[1]} words the classifier was trained on.`);
  return { words: n, notes };
}

const USAGE = `usage: score-story-provenance.mjs --key-status
       score-story-provenance.mjs (--text <story> | --url <page>) --extract
       score-story-provenance.mjs (--text <story> | --url <page>) --typesafe [--runs 2] [--format json|html] [--out <file>]
       score-story-provenance.mjs (--text <story> | --url <page>) --prompts
       score-story-provenance.mjs (--text <story> | --url <page>) --answers <run1.json> [--answers <run2.json> ...] [--format json|html] [--out <file>]`;

// The key comes from the user, never from chat: the environment first, then a TYPESAFE_API_KEY line in
// .env.local or .env in the working folder. Only that one line is read; nothing else in those files is loaded.
const NO_KEY = `TypeSafe Jev is the preferred annotator, and no key was found. Get one at https://console.typesafe.ai/keys and set it yourself, as TYPESAFE_API_KEY in your shell or as a TYPESAFE_API_KEY=... line in a .env.local file in this folder that is not committed. Do not paste the key into a chat. Without a key, annotate with an agent model instead: --prompts, then --answers.`;
export function typesafeKey(env = process.env, cwd = process.cwd()) {
  if (env.TYPESAFE_API_KEY?.trim()) return env.TYPESAFE_API_KEY.trim();
  for (const name of ['.env.local', '.env']) {
    let content;
    try { content = readFileSync(join(cwd, name), 'utf8'); } catch { continue; }
    const value = content.match(/^\s*(?:export\s+)?TYPESAFE_API_KEY\s*=\s*(.*)$/m)?.[1].trim().replace(/^(['"])(.*)\1$/, '$2');
    if (value) return value;
  }
  throw new Error(NO_KEY);
}

const OPTIONS = { help: { type: 'boolean' }, extract: { type: 'boolean' }, 'key-status': { type: 'boolean' }, text: { type: 'string' }, url: { type: 'string' }, format: { type: 'string', default: 'json' }, out: { type: 'string' }, typesafe: { type: 'boolean' }, runs: { type: 'string', default: '2' }, prompts: { type: 'boolean' }, answers: { type: 'string', multiple: true } };

async function main(argv) {
  const { values } = parseArgs({ args: argv, strict: true, options: OPTIONS });
  if (values.help) return USAGE;
  if (values['key-status']) {
    try { typesafeKey(); return { typesafeKey: true }; } catch (error) { return { typesafeKey: false, help: error.message }; }
  }
  if (!values.text === !values.url || !['json', 'html'].includes(values.format)) throw new Error(USAGE);
  if (values.typesafe && !values.answers?.length) typesafeKey(); // fail before fetching or sending anything
  const { text, source } = values.url ? await readUrl(values.url) : { text: readText(values.text), source: { type: 'file', path: values.text } };
  // A short first line is usually the title; otherwise the report falls back to the file name.
  if (source.type === 'file') {
    const first = text.split('\n').map((line) => line.trim()).find(Boolean) ?? '';
    source.title = first.length <= 90 ? first : `${first.split(/\s+/).slice(0, 8).join(' ')}\u2026`;
  }
  if (values.extract) return { source, ...scope(text), text };
  if (values.prompts) return { schemaVersion: 1, source, ...scope(text), dimensions: TAXONOMY.map((dim) => ({ key: dim.key, features: dim.features.length, prompt: dimensionPrompt(dim, text) })) };
  let runs;
  let raws = [];
  let annotator;
  if (values.answers?.length) {
    raws = values.answers.map((file) => JSON.parse(readText(file)));
    runs = raws.map(scoreAnswers);
    annotator = 'supplied answers';
  } else if (values.typesafe) {
    const key = typesafeKey();
    const n = Math.min(Math.max(Number.parseInt(values.runs, 10) || 2, 1), 5);
    runs = [];
    raws = [];
    let tokens = 0;
    let name = null;
    for (let i = 0; i < n; i += 1) {
      const result = await annotateWithTypesafe(text, key);
      raws.push(result.raw);
      runs.push(scoreAnswers(result.raw));
      tokens += result.tokens;
      name = result.model;
    }
    annotator = `TypeSafe ${name ?? 'jev-latest'}, ${tokens} input tokens`;
  } else throw new Error(USAGE);
  return { schemaVersion: 1, measure: 'StoryScope binary classifier, P(human)', annotator, source, measuredAt: new Date().toISOString(), runs: runs.map((p) => Number(p.toFixed(4))), ...verdict(runs), ...scope(text), drivers: drivers(raws) };
}

async function cli(argv) {
  const { values } = parseArgs({ args: argv, strict: true, options: OPTIONS });
  const result = await main(argv);
  const body = typeof result === 'string' ? `${result}\n` : values.format === 'html' && result.verdict ? renderHtml(result) : `${JSON.stringify(result, null, 2)}\n`;
  if (values.out) {
    writeFileSync(values.out, body);
    return `${JSON.stringify({ written: values.out, verdict: result.verdict, mean: result.mean })}\n`;
  }
  return body;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  cli(process.argv.slice(2)).then((out) => process.stdout.write(out), (error) => {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  });
}
