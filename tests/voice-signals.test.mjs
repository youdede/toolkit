import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { checkReview, compareRubrics, compareTexts, DIAGNOSTICS, extractText, flagSpans, renderReport, trackChanges, traceText, measureText, RUBRIC, rubricTemplate, scoreRubric } from '../artifacts/skills/writing/editing/edit-ai-draft-for-human-voice/scripts/measure-voice-signals.mjs';

const script = 'artifacts/skills/writing/editing/edit-ai-draft-for-human-voice/scripts/measure-voice-signals.mjs';

const aiDraft = [
  'Mara reached Ostia on 14 August 1998 — a day that would later feel significant. Her chest tightened as she opened the door. Her heart pounded. The air smelled of salt, a scent that seemed to hold the weight of every memory.',
  'It was not just a house — it was a promise. The tapestry of her grief seemed to loosen. Her breath caught. The scent of wet stone filled the hallway, mingling with the aroma of coffee.',
  'In the end, she realized that grief was not something to escape, but something to carry. And that was enough.'
].join('\n\n');

const revised = [
  'Mara reached Ostia on 14 August 1998. She was afraid of the house, and said so to nobody.',
  '“You kept the key,” her brother said on the phone. She had. She didn’t tell him she’d used it twice already, both times at night, both times leaving before the lights came on in the flat across the street.',
  'The kitchen still had their mother’s calendar on it. August. Someone had crossed out the fourteenth and written nothing underneath.'
].join('\n\n');

test('voice helper flags AI-default surface and narrative signals', () => {
  const result = measureText(aiDraft);
  const ids = result.flags.map((item) => item.id);
  for (const id of ['em-dash-density', 'ai-vocabulary-density', 'contrast-frame-density', 'closing-thematic-commentary', 'embodied-emotion-dominance', 'olfactory-density']) assert.ok(ids.includes(id), id);
  assert.equal(result.pass, false);
  assert.equal(result.metrics.closingCommentary > 0, true);
});

test('voice helper finds no flags in a plain, specific revision', () => {
  const result = measureText(revised);
  assert.deepEqual(result.flags.filter((item) => item.id !== 'uniform-sentence-length'), []);
  assert.ok(result.metrics.dialogueWordShare > 0);
  assert.equal(result.metrics.explicitEmotionLabels, 1);
});

test('voice comparison resolves flags and keeps supplied specifics', () => {
  const result = compareTexts(aiDraft, revised);
  assert.ok(result.resolvedFlags.includes('closing-thematic-commentary'));
  assert.deepEqual(result.preservation.droppedNumbers, []);
  assert.ok(!result.preservation.droppedNames.includes('Ostia'));
  assert.deepEqual(result.preservation.addedNumbers, []);
});

test('voice comparison fails when a revision invents a number or a name', () => {
  const result = compareTexts(aiDraft, `${revised}\n\nShe had read Calvino there in 2003.`);
  assert.deepEqual(result.preservation.addedNumbers, ['2003']);
  assert.ok(result.preservation.addedNames.includes('Calvino'));
  assert.equal(result.pass, false);
});

test('voice helper excludes Italian dash dialogue from the em-dash count', () => {
  const result = measureText('— Vieni? — chiese lui.\n— No — disse lei. Non era solo stanchezza, era paura.', { lang: 'it' });
  assert.equal(result.metrics.emDashPer1k, 0);
  assert.ok(result.metrics.dialogueWordShare > 0);
  assert.ok(result.metrics.contrastFramePer1k > 0);
});

test('voice rubric scores direction and rejects values outside the closed options', () => {
  const answers = (lean) => ({ schemaVersion: 1, features: Object.fromEntries(Object.entries(RUBRIC).map(([id, item]) => [id, item.scale ? (lean === 'human' ? (item.human === 'high' ? item.scale[1] : item.scale[0]) : (item.human === 'high' ? item.scale[0] : item.scale[1])) : (lean === 'human' ? (item.human ?? item.options.find((option) => option !== item.ai)) : (item.ai ?? item.options.find((option) => option !== item.human)))])) });
  assert.equal(scoreRubric(answers('human')).humanLean, 1);
  assert.equal(scoreRubric(answers('ai')).humanLean, 0);
  const comparison = compareRubrics(answers('ai'), answers('human'));
  assert.equal(comparison.pass, undefined);
  assert.deepEqual(comparison.movedTowardAi, []);
  assert.equal(comparison.movedTowardHuman.length, Object.keys(RUBRIC).length);
  assert.equal(compareRubrics(answers('human'), answers('ai')).movedTowardAi.length, Object.keys(RUBRIC).length);
  assert.throws(() => scoreRubric({ schemaVersion: 1, features: { thematic_explicitness: 9 } }), /not allowed/);
  assert.throws(() => scoreRubric({ schemaVersion: 1, features: { invented_feature: 1 } }), /unknown rubric features/);
  assert.throws(() => scoreRubric({ schemaVersion: 1, features: { thematic_explicitness: 2 } }), /moral_philosophical_weighting: missing/);
  assert.throws(() => scoreRubric({ schemaVersion: 1, features: Object.fromEntries(Object.keys(RUBRIC).map((id) => [id, 'n/a'])) }), /at least half/);
  assert.equal(Object.keys(rubricTemplate().features).length, Object.keys(RUBRIC).length);
  assert.equal(Object.keys(rubricTemplate().diagnostics).length, Object.keys(DIAGNOSTICS).length);
});

test('voice rubric diagnostics are validated, compared, and kept out of humanLean', () => {
  const base = { schemaVersion: 1, features: Object.fromEntries(Object.entries(RUBRIC).map(([id, item]) => [id, item.scale ? item.scale[0] : item.options[0]])) };
  const before = { ...base, diagnostics: { denouement_length: 'extended', emotion_modes: ['physiology', 'metaphor_or_environment'] } };
  const after = { ...base, diagnostics: { denouement_length: 'brief', emotion_modes: ['physiology', 'metaphor_or_environment'] } };
  assert.equal(scoreRubric(before).humanLean, scoreRubric(base).humanLean);
  assert.deepEqual(compareRubrics(before, after).diagnosticsChanged, { denouement_length: { before: 'extended', after: 'brief' } });
  assert.throws(() => scoreRubric({ ...base, diagnostics: { denouement_length: 'long' } }), /not allowed/);
  assert.throws(() => scoreRubric({ ...base, diagnostics: { emotion_modes: ['smell'] } }), /not allowed/);
  assert.throws(() => scoreRubric({ ...base, diagnostics: { invented: 1 } }), /unknown diagnostic/);
});

test('voice helper rejects malformed and oversized input', () => {
  assert.throws(() => measureText(''), /no words/);
  assert.throws(() => measureText(42), /must be a string/);
  assert.throws(() => measureText('words here', { lang: 'fr' }), /unsupported lang/);
  assert.throws(() => measureText('x '.repeat(256 * 1024 + 1)), /exceeds/);
});

test('voice helper CLI prints JSON and exits non-zero on bad arguments', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'voice-signals-'));
  try {
    const draft = path.join(directory, 'draft.txt');
    const after = path.join(directory, 'after.txt');
    writeFileSync(draft, aiDraft);
    writeFileSync(after, revised);
    const ok = spawnSync(process.execPath, [script, '--text', after, '--baseline', draft], { encoding: 'utf8' });
    assert.equal(ok.status, 0, ok.stderr);
    assert.equal(JSON.parse(ok.stdout).schemaVersion, 1);
    const bad = spawnSync(process.execPath, [script, '--unknown'], { encoding: 'utf8' });
    assert.notEqual(bad.status, 0);
    const none = spawnSync(process.execPath, [script], { encoding: 'utf8' });
    assert.match(none.stderr, /usage/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('voice specifics ignore apostrophe style and words also written in lowercase', () => {
  const result = compareTexts('“Stay,” said Kade. I’m sure. Then Kade asked us to stay.', '"Stay," said Kade. I\'m sure. Then Kade asked us to stay.');
  assert.deepEqual(result.preservation, { droppedNumbers: [], droppedNames: [], addedNumbers: [], addedNames: [] });
  assert.deepEqual(compareTexts('Harry met Tommy at Everest.', 'Harry left.').preservation.droppedNames, ['Everest', 'Tommy']);
});

test('voice comparison fails when a revision cuts more than the length limit', () => {
  const draft = 'She walked to the harbor and counted the boats. '.repeat(40);
  const result = compareTexts(draft, 'She walked to the harbor and counted the boats. '.repeat(20));
  assert.equal(result.lengthRatio, 0.5);
  assert.deepEqual(result.checks, { length: false, newFlags: true, preservation: true, traceability: true });
  assert.equal(result.pass, false);
  const filler = 'We counted the boats at the harbor. ';
  assert.equal(compareTexts(filler.repeat(10), filler.repeat(8), { genre: 'nonfiction' }).checks.length, true);
  assert.equal(compareTexts(filler.repeat(10), filler.repeat(8)).checks.length, false);
});

test('voice comparison catches written quantities and keeps names that move to a sentence start', () => {
  const result = compareTexts('He met Tommy at the dock. They waited.', 'Tommy met him at the dock. He had spent four years on it.');
  assert.deepEqual(result.preservation, { droppedNumbers: [], droppedNames: [], addedNumbers: ['four'], addedNames: [] });
  assert.deepEqual(compareTexts('Ci vollero tre giorni.', 'Ci volle tempo.', { lang: 'it' }).preservation.droppedNumbers, ['tre']);
});

test('voice comparison passes when a flag the author kept is still present', () => {
  const draft = 'In the end she realized that the house was hers. '.repeat(20);
  const result = compareTexts(draft, draft);
  assert.ok(result.after.flags.length > 0);
  assert.equal(result.pass, true);
});

test('voice traceability lists invented sentences and feelings but not rephrasings', () => {
  const draft = 'Mara opened the door of the house in Ostia. The kitchen was cold and the calendar still hung by the window. Her brother called at noon.';
  const revised = 'Mara opened the door of the Ostia house. She was afraid. Dr Mayhew folded his handkerchief and refolded it twice. The calendar still hung by the window, and the kitchen was cold.';
  assert.deepEqual(traceText(draft, revised), { untracedSentences: ['Dr Mayhew folded his handkerchief and refolded it twice.'], addedFeelings: ['was afraid'] });
  assert.equal(compareTexts(draft, revised).checks.traceability, false);
  assert.deepEqual(traceText(`${draft} She was afraid of the phone.`, revised).addedFeelings, []);
});

test('voice report points at each flagged habit, tracks word changes, and stays self-contained', () => {
  const spans = flagSpans(aiDraft, 'en', measureText(aiDraft).flags.map((item) => item.id));
  assert.ok(spans.some((span) => span.id === 'em-dash-density' && aiDraft.slice(span.start, span.end) === '—'));
  assert.ok(spans.some((span) => span.id === 'closing-thematic-commentary'));
  assert.deepEqual(trackChanges('She ran home.', 'She walked home.').changed, 2);
  assert.match(trackChanges('She ran home.', 'She walked home.').html, /<del>ran<\/del>.*<ins>walked<\/ins>|<ins>walked<\/ins>.*<del>ran<\/del>/);
  const recommended = renderReport(measureText(aiDraft), { draft: aiDraft, source: 'Draft' });
  assert.match(recommended, /<mark data-flag="em-dash-density">/);
  assert.match(recommended, /data-flag-btn="closing-thematic-commentary"/);
  const revision = renderReport(compareTexts(aiDraft, revised), { draft: aiDraft, revised, source: '<x>' });
  assert.match(revision, /Tracked changes/);
  assert.match(revision, /&lt;x&gt;/);
  for (const html of [recommended, revision]) assert.doesNotMatch(html, /<script[^>]+src|<link|@import|url\(|https?:\/\/|StoryScope/);
});

test('voice page extraction drops screen-reader labels and keeps table rows on one line', () => {
  const { text } = extractText('<main><p>Source: FAQ <span class="sr-only">— opens in a new tab</span></p><table><tr><th>Country</th><th>Days</th></tr><tr><td><p>Germany</p></td><td>14</td></tr></table></main>');
  assert.equal(text, 'Source: FAQ\n\nCountry · Days\n\nGermany · 14');
  assert.equal(extractText('<main><p>Pick up to 7<sup><a role="doc-noteref">2</a></sup> schools for <span>Gemeinde</span><span hidden="">Glossary: commune</span> and <span aria-hidden="true">x</span>m<sup>2</sup>.</p></main>').text, 'Pick up to 7 schools for Gemeinde and m2.');
});

test('voice editorial review accepts only verbatim quotes and suggestions without new facts', () => {
  const text = 'Germany sets a 14-day rule.\n\nThe groups count destinations.';
  const ok = checkReview(text, { findings: [{ kind: 'unclear', quote: 'The groups  count destinations.', why: 'Vague.', suggestion: 'Germany sets the shortest rule.' }] });
  assert.equal(ok[0].quote, 'The groups count destinations.');
  assert.match(renderReport(measureText(text, { genre: 'nonfiction' }), { draft: text, review: ok }), /Editorial review.*The groups count destinations/s);
  assert.throws(() => checkReview(text, { findings: [{ kind: 'unclear', quote: 'Not in the text.', why: 'x', suggestion: 'y' }] }), /not in the text/);
  assert.throws(() => checkReview(text, { findings: [{ kind: 'unclear', quote: 'Germany sets a 14-day rule.', why: 'x', suggestion: 'Like Austria, it sets a 30-day rule.' }] }), /adds 30, Austria/);
  assert.equal(checkReview(text, { findings: [{ kind: 'generic', quote: 'Germany sets a 14-day rule.', why: 'x', suggestion: "Keep 'Germany' and say who Sets it." }] }).length, 1);
  assert.throws(() => checkReview(text, { findings: [{ kind: 'style', quote: 'Germany sets a 14-day rule.', why: 'x', suggestion: 'y' }] }), /kind must be/);
});

test('voice helper reads a public web page with --url and keeps only its main text', async () => {
  const server = createServer((req, res) => res.writeHead(200, { 'content-type': 'text/html' }).end(`<title>Harbor</title><nav>Menu</nav><main><p>${aiDraft.replace(/\n\n/g, '</p><p>')}</p></main><footer>Cookies</footer>`));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const out = await new Promise((resolve) => execFile(process.execPath, [script, '--url', `http://127.0.0.1:${server.address().port}/`], (error, stdout) => resolve(JSON.parse(stdout))));
    assert.equal(out.metrics.words, measureText(aiDraft).metrics.words);
    assert.ok(out.flags.some((item) => item.id === 'em-dash-density'));
  } finally {
    server.close();
  }
});
