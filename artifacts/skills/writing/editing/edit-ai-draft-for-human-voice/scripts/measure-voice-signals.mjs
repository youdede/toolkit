#!/usr/bin/env node
import { readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const MAX_BYTES = 512 * 1024;
const SHORT_TEXT_WORDS = 300;

// ponytail: heuristic limits, not fitted to StoryScope data (the paper publishes no per-1k-word rates).
// Calibrate them against the author's own human-written samples before treating a flag as a defect.
export const LIMITS = Object.freeze({
  emDashPer1k: 1,
  aiVocabularyPer1k: 1,
  contrastFramePer1k: 0.5,
  sentenceLengthCvMin: 0.45,
  embodiedPerLabelMax: 3,
  olfactoryPer1k: 1.5,
  closingCommentaryMax: 0,
  lengthRatioMin: 0.85,
  // Nonfiction drafts often open and close with filler that carries no fact, so cutting it shortens more.
  lengthRatioMinNonfiction: 0.7,
  lengthRatioMax: 1.15,
  // A revised sentence is traced when some draft sentence pair holds at least this share of its content words.
  traceShareMin: 0.5,
  traceMinWords: 2
});

const LEXICONS = {
  en: {
    aiVocabulary: ['delve', 'delves', 'delving', 'tapestry', 'testament to', 'intricate', 'intricacies', 'nuanced', 'realm', 'embark', 'embarked', 'beacon', 'unwavering', 'palpable', 'symphony of', 'kaleidoscope', 'labyrinthine', 'enigmatic', 'resonated', 'ethereal', 'liminal', 'visceral', 'interplay', 'multifaceted', 'meticulous', 'meticulously', 'pivotal', 'underscores', 'showcasing', 'ever-evolving', 'in the heart of', 'a sense of', "couldn't help but", 'little did', 'hung heavy', 'the weight of', "it's important to note", 'it is important to note', 'it is worth noting', "in today's fast-paced", 'in an ever-changing', 'navigate the complexities', 'seamless', 'seamlessly', 'leverage', 'unlock the', 'game-changer', 'elevate your', 'foster', 'holistic', 'in conclusion', 'at the end of the day'],
    contrastFrames: [String.raw`\bnot (?:just|only|merely|simply)\b`, String.raw`\b(?:it|this|that)(?:'s|’s| is| was) not\b[^.!?\n]{1,80}?[,;:—–]\s*(?:it|this|that)(?:'s|’s| is| was)\b`, String.raw`\bisn['’]t (?:just|only|about)\b`],
    embodied: [String.raw`chest (?:tightened|constricted|ached)`, String.raw`throat (?:tightened|closed|ached)`, String.raw`lump in (?:his|her|their|my|your) throat`, String.raw`breath (?:caught|hitched)`, String.raw`held (?:his|her|their|my) breath`, String.raw`heart (?:pounded|hammered|raced|thudded|lurched|clenched)`, String.raw`pulse (?:quickened|raced|jumped)`, String.raw`stomach (?:dropped|churned|knotted|twisted|clenched)`, String.raw`jaw (?:clenched|tightened)`, String.raw`knuckles (?:whitened|went white)`, 'cold sweat', String.raw`(?:shiver|chill)s? (?:ran|crawled|went)`, String.raw`tears (?:pricked|stung|welled)`, String.raw`eyes (?:stung|burned|prickled)`, String.raw`skin (?:prickled|crawled)`, String.raw`hands (?:trembled|shook)`],
    labels: [String.raw`(?:felt|feel|feels|feeling|was|were|is|am|grew|became) (?:so |very |suddenly |deeply )?(?:afraid|scared|frightened|angry|furious|sad|happy|glad|ashamed|jealous|lonely|anxious|nervous|guilty|relieved|embarrassed|hopeful|miserable|bored|excited|terrified|worried|disappointed|proud|hurt)\b`],
    olfactory: ['smell', 'smelled', 'smelt', 'smells', 'scent', 'scented', 'odor', 'odour', 'aroma', 'reek', 'reeked', 'stench', 'whiff', 'fragrance', 'musty'],
    commentary: [String.raw`(?:realized|realised|understood|knew|learned|learnt) (?:now |then |at last |finally )?that`, String.raw`the truth (?:was|is)`, String.raw`what (?:really |truly )?mattered`, String.raw`(?:perhaps|maybe) that was`, String.raw`and (?:that|this) was enough`, 'for the first time in', 'it was never about', String.raw`had always been about`],
    readerAddress: [String.raw`\byou\b`, String.raw`\byour\b`, 'dear reader'],
    timeJumps: [String.raw`(?:years|months|decades|weeks) (?:earlier|later|before|ago)`, 'back then', 'long before', 'would later', String.raw`(?:he|she|they|i) remembered`],
    conjunctions: ['and', 'or'],
    stopwords: 'the and but then than that this these those with from into onto over under about been being were was are have has had would could should will can may might must shall there here what which who whom whose when where why how all any each every some such own same other very just only also too again once more most much many few one said says say not nor his her hers him she they them their our you your its it\'s'.split(' '),
    stem: (word) => word.replace(/(?:ing|ed|es|s|ly)$/, ''),
    numberWords: ['two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'fifteen', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety', 'hundred', 'hundreds', 'thousand', 'thousands', 'million', 'millions', 'dozen', 'dozens']
  },
  it: {
    aiVocabulary: ['arazzo', 'testimonianza di', 'intricato', 'intricata', 'intricati', 'sfumature', 'intraprendere', 'intraprese', 'faro di', 'incrollabile', 'palpabile', 'sinfonia di', 'caleidoscopio', 'labirintico', 'enigmatico', 'enigmatica', 'risuonò', 'etereo', 'eterea', 'viscerale', 'sfaccettato', 'sfaccettata', 'meticoloso', 'meticolosamente', 'cruciale', 'nel cuore di', 'un senso di', 'non poté fare a meno di', 'il peso di', 'in un mondo in cui', 'è importante sottolineare', 'è importante notare', 'vale la pena sottolineare', 'nel mondo di oggi', 'in continua evoluzione', 'a 360 gradi', 'sinergia', 'sinergie', 'valorizzare', 'fondamentale', 'in conclusione', 'in definitiva', 'un vero e proprio', 'una vera e propria'],
    contrastFrames: [String.raw`\bnon (?:solo|soltanto|semplicemente)\b`, String.raw`\bnon (?:è|era|si tratta|si trattava)\b[^.!?\n]{1,80}?[,;:—–]\s*(?:ma|è|era|bensì)\b`],
    embodied: [String.raw`petto (?:si )?(?:strinse|stringeva|serrò)`, String.raw`nodo (?:alla|in) gola`, String.raw`gola (?:si )?(?:strinse|chiuse|serrò)`, String.raw`respiro (?:si )?(?:fermò|bloccò|spezzò|mozzò)`, 'trattenne il respiro', String.raw`cuore (?:martellava|martellò|batteva forte|accelerò|sobbalzò|perse un colpo)`, String.raw`stomaco (?:si )?(?:strinse|contorse|chiuse|rivoltò)`, String.raw`mascella (?:si )?(?:serrò|contrasse)`, String.raw`nocche (?:sbiancarono|bianche)`, 'sudore freddo', String.raw`brivido (?:corse|percorse|lungo)`, String.raw`occhi (?:bruciavano|pizzicavano)`, String.raw`mani (?:tremavano|tremarono)`],
    labels: [String.raw`(?:si sentiva|si sentì|mi sentivo|era|ero|eri|erano|provava|provò) (?:così |molto |improvvisamente |profondamente )?(?:spaventat[oaie]|arrabbiat[oaie]|trist[ei]|felic[ei]|content[oaie]|imbarazzat[oaie]|gelos[oaie]|sol[oaie]|ansios[oaie]|nervos[oaie]|in colpa|sollevat[oaie]|delus[oaie]|orgoglios[oaie]|ferit[oaie]|terrorizzat[oaie]|preoccupat[oaie]|paura|rabbia|tristezza|vergogna|gioia)\b`],
    olfactory: ['odore', 'odori', 'profumo', 'profumi', 'profumava', 'puzza', 'puzzava', 'tanfo', 'aroma', 'sentore', 'effluvio', 'fragranza', 'olezzo'],
    commentary: [String.raw`(?:capì|comprese|si rese conto|realizzò|imparò|sapeva ora) che`, String.raw`la verità (?:era|è)`, String.raw`ciò che (?:davvero )?contava`, String.raw`forse (?:era|è) questo`, String.raw`e (?:questo|quello) bastava`, 'per la prima volta da', String.raw`non (?:era|si trattava) mai stat[oa]`],
    readerAddress: [String.raw`\b(?:lettore|lettrice|lettori)\b`, String.raw`\b(?:tu|voi|tuo|tua|vostro|vostra)\b`],
    timeJumps: [String.raw`(?:anni|mesi|decenni|settimane) (?:prima|dopo|fa|più tardi)`, 'a quei tempi', 'molto tempo prima', 'più tardi avrebbe', String.raw`ricordò|ricordava`],
    conjunctions: ['e', 'o'],
    // ponytail: 'sei' is left out because it is also 'you are'.
    stopwords: 'il lo la gli le un una uno del della dei delle degli nel nella nei nelle che chi cui non per con tra fra come anche ancora era erano sono stato stata essere aveva avevano ho hai abbiamo questo questa quello quella suo sua suoi sue loro mio mia tuo tua più poi già quando dove perché ogni tutto tutti molto disse dice'.split(' '),
    // ponytail: crude Italian stem, final vowel only; unvalidated.
    stem: (word) => word.replace(/[aeio]$/, ''),
    numberWords: ['due', 'tre', 'quattro', 'cinque', 'sette', 'otto', 'nove', 'dieci', 'undici', 'dodici', 'quindici', 'venti', 'trenta', 'quaranta', 'cinquanta', 'sessanta', 'settanta', 'ottanta', 'novanta', 'cento', 'centinaia', 'mille', 'migliaia', 'milione', 'milioni', 'dozzina', 'dozzine']
  }
};

const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const isPattern = (text) => /[\\(\[]/.test(text);
const compile = (items) => new RegExp(items.map((item) => `(?<![\\p{L}])(?:${isPattern(item) ? item : escape(item)})(?![\\p{L}])`).join('|'), 'giu');
const count = (text, items) => (text.match(compile(items)) || []).length;
const per1k = (value, words) => (words ? Number((value * 1000 / words).toFixed(2)) : 0);
const wordsOf = (text) => text.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) || [];
const cv = (values) => {
  if (values.length < 2) return null;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const sd = Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length);
  return mean ? Number((sd / mean).toFixed(3)) : null;
};

function checkText(text) {
  if (typeof text !== 'string') throw new Error('text must be a string');
  if (Buffer.byteLength(text, 'utf8') > MAX_BYTES) throw new Error(`text exceeds ${MAX_BYTES} bytes`);
  if (!wordsOf(text).length) throw new Error('text contains no words');
}

// Dialogue: curly, straight, and guillemet quotes, plus Italian lines that open with a dash.
function splitDialogue(text) {
  const dialogue = [];
  const narration = text
    .replace(/“[^”]*”|"[^"\n]*"|«[^»]*»/g, (match) => { dialogue.push(match); return ' '; })
    .replace(/^[ \t]*[—–-][^\n]*$/gm, (match) => { dialogue.push(match); return ' '; });
  return { dialogue: dialogue.join(' '), narration };
}

function sentencesOf(text) {
  return text.split(/(?<=[.!?…])["”»]?\s+|\n{2,}/u).map((item) => item.trim()).filter((item) => wordsOf(item).length);
}

// Numbers, written quantities, and capitalized words that do not open a sentence: a proxy for specific, named references.
export function specificsOf(text, lang = 'en') {
  const numbers = new Set((text.match(/\p{N}[\p{N}.,:/]*/gu) || []).map((item) => item.replace(/[.,:/]+$/, '')));
  for (const word of text.match(compile(LEXICONS[lang].numberWords)) || []) numbers.add(word.toLowerCase());
  const plain = text.replace(/[‘’]/g, "'");
  const lower = new Set((plain.match(/[\p{L}][\p{L}'-]*/gu) || []).filter((token) => !/^\p{Lu}/u.test(token)).map((token) => token.toLowerCase()));
  const names = new Set();
  for (const sentence of sentencesOf(plain)) {
    const tokens = sentence.replace(/^[^\p{L}\p{N}]+/u, '').match(/[\p{L}][\p{L}'-]*/gu) || [];
    for (const raw of tokens.slice(1)) {
      const token = raw.replace(/'s$/, '');
      // A name stays capitalized everywhere: a word also written in lowercase is a missed sentence start.
      if (/^\p{Lu}/u.test(token) && token !== 'I' && !token.startsWith("I'") && !lower.has(token.toLowerCase())) names.add(token);
    }
  }
  return { numbers: [...numbers].sort(), names: [...names].sort() };
}

function contentOf(text, lexicon) {
  const stop = new Set(lexicon.stopwords);
  return [...new Set((text.toLowerCase().replace(/[‘’]/g, "'").match(/\p{L}[\p{L}'-]*/gu) || []).map((word) => word.replace(/'s$/, '')).filter((word) => word.length > 2 && !stop.has(word)).map(lexicon.stem))];
}

// Sentences of the revision with no counterpart in the draft, and feelings the draft never names: candidate inventions.
export function traceText(baseline, revised, lang = 'en') {
  const lexicon = LEXICONS[lang];
  const drafted = sentencesOf(baseline).map((sentence) => contentOf(sentence, lexicon));
  const windows = drafted.map((words, index) => new Set([...words, ...(drafted[index + 1] || [])]));
  const untracedSentences = [];
  for (const sentence of sentencesOf(revised)) {
    const words = contentOf(sentence, lexicon);
    if (words.length < LIMITS.traceMinWords) continue;
    const best = Math.max(0, ...windows.map((window) => words.filter((word) => window.has(word)).length));
    if (best / words.length < LIMITS.traceShareMin) untracedSentences.push(sentence.length > 160 ? `${sentence.slice(0, 157)}...` : sentence);
  }
  const draftWords = new Set(contentOf(baseline, lexicon));
  const addedFeelings = [...new Set((revised.match(compile(lexicon.labels)) || []).map((match) => match.toLowerCase()).filter((match) => !contentOf(match, lexicon).slice(-1).every((word) => draftWords.has(word))))];
  return { untracedSentences, addedFeelings };
}

export function measureText(text, { lang = 'en', genre = 'fiction' } = {}) {
  checkText(text);
  const lexicon = LEXICONS[lang];
  if (!lexicon) throw new Error(`unsupported lang: ${lang}`);
  if (!['fiction', 'nonfiction'].includes(genre)) throw new Error(`unsupported genre: ${genre}`);
  const words = wordsOf(text).length;
  const { dialogue, narration } = splitDialogue(text);
  const sentenceLengths = sentencesOf(text).map((item) => wordsOf(item).length);
  const paragraphLengths = text.split(/\n\s*\n/).map((item) => wordsOf(item).length).filter(Boolean);
  const allWords = wordsOf(text);
  const closing = allWords.slice(Math.floor(allWords.length * 0.8)).join(' ');
  const emDashes = (text.replace(/^[ \t]*[—–-][^\n]*$/gm, '').match(/—| – /g) || []).length;
  const embodied = count(text, lexicon.embodied);
  const labels = count(text, lexicon.labels);
  const triad = new RegExp(String.raw`[\p{L}'’-]+(?: [\p{L}'’-]+){0,2}, [\p{L}'’-]+(?: [\p{L}'’-]+){0,2},? (?:${lexicon.conjunctions.join('|')}) [\p{L}'’-]+`, 'giu');
  const specifics = specificsOf(text, lang);
  const metrics = {
    words,
    sentences: sentenceLengths.length,
    emDashPer1k: per1k(emDashes, words),
    aiVocabularyPer1k: per1k(count(text, lexicon.aiVocabulary), words),
    contrastFramePer1k: per1k(count(text, lexicon.contrastFrames), words),
    triadPer1k: per1k((text.match(triad) || []).length, words),
    sentenceLengthCv: cv(sentenceLengths),
    paragraphLengthCv: cv(paragraphLengths),
    dialogueWordShare: Number((wordsOf(dialogue).length / words).toFixed(3)),
    embodiedEmotionCues: embodied,
    explicitEmotionLabels: labels,
    olfactoryPer1k: per1k(count(text, lexicon.olfactory), words),
    thematicCommentary: count(text, lexicon.commentary),
    closingCommentary: count(closing, lexicon.commentary),
    readerAddressOutsideDialogue: count(narration, lexicon.readerAddress),
    timeJumpMarkersPer1k: per1k(count(text, lexicon.timeJumps), words),
    specificsPer1k: per1k(specifics.numbers.length + specifics.names.length, words)
  };
  const flags = [];
  const flag = (id, value, limit, source) => flags.push({ id, value, limit, source });
  if (metrics.emDashPer1k > LIMITS.emDashPer1k) flag('em-dash-density', metrics.emDashPer1k, LIMITS.emDashPer1k, 'surface-heuristic');
  if (metrics.aiVocabularyPer1k > LIMITS.aiVocabularyPer1k) flag('ai-vocabulary-density', metrics.aiVocabularyPer1k, LIMITS.aiVocabularyPer1k, 'surface-heuristic');
  if (metrics.contrastFramePer1k > LIMITS.contrastFramePer1k) flag('contrast-frame-density', metrics.contrastFramePer1k, LIMITS.contrastFramePer1k, 'surface-heuristic');
  if (metrics.sentenceLengthCv !== null && metrics.sentenceLengthCv < LIMITS.sentenceLengthCvMin) flag('uniform-sentence-length', metrics.sentenceLengthCv, LIMITS.sentenceLengthCvMin, 'surface-heuristic');
  if (metrics.closingCommentary > LIMITS.closingCommentaryMax) flag('closing-thematic-commentary', metrics.closingCommentary, LIMITS.closingCommentaryMax, 'storyscope-direction');
  if (genre === 'fiction') {
    if (embodied >= 2 && embodied > labels * LIMITS.embodiedPerLabelMax) flag('embodied-emotion-dominance', `${embodied}:${labels}`, `${LIMITS.embodiedPerLabelMax}:1`, 'storyscope-direction');
    if (metrics.olfactoryPer1k > LIMITS.olfactoryPer1k) flag('olfactory-density', metrics.olfactoryPer1k, LIMITS.olfactoryPer1k, 'storyscope-direction');
  }
  const notes = [];
  if (words < SHORT_TEXT_WORDS) notes.push(`Under ${SHORT_TEXT_WORDS} words: rates and variation are unstable; read flags as hints.`);
  if (lang === 'it') notes.push('Italian lexicons are unvalidated translations; second-person detection misses pro-drop verbs.');
  notes.push('Limits are heuristic: a research-direction flag follows the direction of published findings on AI fiction, not a calibrated threshold.');
  return { schemaVersion: 1, lang, genre, limits: LIMITS, metrics, flags, pass: flags.length === 0, notes };
}

export function compareTexts(baseline, revised, options = {}) {
  const before = measureText(baseline, options);
  const after = measureText(revised, options);
  const delta = Object.fromEntries(Object.keys(before.metrics).filter((key) => typeof before.metrics[key] === 'number' && typeof after.metrics[key] === 'number').map((key) => [key, Number((after.metrics[key] - before.metrics[key]).toFixed(3))]));
  const lang = options.lang ?? 'en';
  const old = specificsOf(baseline, lang);
  const now = specificsOf(revised, lang);
  const missing = (a, b) => a.filter((item) => !b.includes(item));
  // A name counts as kept when it still appears anywhere, even only at a sentence start.
  const tokens = (text) => new Set(text.replace(/[‘’]/g, "'").match(/[\p{L}][\p{L}'-]*/gu)?.map((token) => token.replace(/'s$/, '')) || []);
  const oldTokens = tokens(baseline);
  const nowTokens = tokens(revised);
  const preservation = {
    droppedNumbers: missing(old.numbers, now.numbers),
    droppedNames: old.names.filter((name) => !nowTokens.has(name)),
    addedNumbers: missing(now.numbers, old.numbers),
    addedNames: now.names.filter((name) => !oldTokens.has(name))
  };
  const beforeIds = new Set(before.flags.map((item) => item.id));
  const lengthRatio = Number((after.metrics.words / before.metrics.words).toFixed(3));
  const newFlags = after.flags.filter((item) => !beforeIds.has(item.id)).map((item) => item.id);
  const traceability = traceText(baseline, revised, lang);
  const checks = {
    length: lengthRatio >= (options.genre === 'nonfiction' ? LIMITS.lengthRatioMinNonfiction : LIMITS.lengthRatioMin) && lengthRatio <= LIMITS.lengthRatioMax,
    newFlags: newFlags.length === 0,
    preservation: Object.values(preservation).every((items) => items.length === 0),
    traceability: Object.values(traceability).every((items) => items.length === 0)
  };
  return {
    schemaVersion: 1,
    before,
    after,
    delta,
    resolvedFlags: [...beforeIds].filter((id) => !after.flags.some((item) => item.id === id)),
    newFlags,
    preservation,
    traceability,
    lengthRatio,
    checks,
    // Alerts cleared, not proof that events, quantities, and settled answers survived.
    pass: Object.values(checks).every(Boolean)
  };
}

// StoryScope core features (Russell et al., COLM 2026, Tables 14-16). `ai` and `human` name the
// option the paper found elevated for that source; scales name the direction that leans human.
export const RUBRIC = Object.freeze({
  thematic_explicitness: { question: 'How explicitly does the story articulate its themes or morals?', scale: [1, 5], human: 'low' },
  moral_philosophical_weighting: { question: 'How heavily does the story foreground moral or philosophical questions?', scale: [1, 5], human: 'low' },
  narratorial_thematic_commentary: { question: 'Does the narrator explicitly comment on themes beyond characters’ perspectives?', options: ['no', 'yes'], ai: 'yes' },
  dialogue_function: { question: 'What is the dominant function of dialogue?', options: ['plot', 'character', 'philosophical_debate', 'mixed'], ai: 'philosophical_debate' },
  reference_explicitness: { question: 'Are intertextual gestures explicit or diffuse?', options: ['none', 'explicit_named', 'implicit_echoes', 'balanced_mix'], ai: 'implicit_echoes', human: 'balanced_mix' },
  emotional_expression: { question: 'How are characters’ emotions most commonly conveyed?', options: ['explicit_labels', 'embodied_metaphors', 'behavioral_cues', 'ambiguous'], ai: 'embodied_metaphors', human: 'explicit_labels' },
  setting_as_psychological_mirror: { question: 'How strongly does setting mirror characters’ inner states?', scale: [1, 5], human: 'low' },
  sensory_density: { question: 'How dense is sensory description?', scale: [1, 5], human: 'low' },
  olfactory_imagery: { question: 'Does the story use smell-based imagery?', options: ['no', 'yes'], ai: 'yes' },
  causal_chain_continuity: { question: 'How unbroken is the causal chain from event to event?', scale: [1, 5], human: 'low' },
  agency_in_resolution: { question: 'Is resolution driven by the protagonist’s choices or external events?', options: ['protagonist_choice', 'mixed', 'external_fate'], ai: 'protagonist_choice' },
  character_introduction: { question: 'How are main characters first introduced?', options: ['external_description', 'in_dialogue', 'in_action', 'inner_thought'], ai: 'external_description' },
  subplot_integration: { question: 'How directly do subplots echo the central theme?', options: ['no_subplots', 'thematically_parallel', 'contrasting', 'independent'], ai: 'no_subplots', human: 'thematically_parallel' },
  resolution_mode: { question: 'Is the main event chain resolved through internal acceptance or external action?', options: ['resolved_externally', 'resolved_internally', 'unresolved'], ai: 'resolved_internally' },
  moral_polarity_toward_protagonist: { question: 'Does the narrative frame the protagonist’s choices as morally clear or ambiguous?', options: ['clearly_positive', 'ambivalent', 'clearly_negative'], human: 'ambivalent' },
  intertextual_named_reference: { question: 'Does the story name a specific real text, author, work, brand, or place?', options: ['no', 'yes'], human: 'yes' },
  direct_reader_address: { question: 'How often does the text directly address the reader?', options: ['never', 'occasional', 'frequent'], ai: 'never' },
  fourth_wall_permeability: { question: 'To what extent does the story break the boundary between story-world and reader?', scale: [1, 4], human: 'high' },
  recontextualization_after_surprise: { question: 'How extensively does a revelation force reinterpretation of earlier scenes?', scale: [1, 5], human: 'high' },
  chronological_discontinuity: { question: 'How often does the narrative jump across time?', scale: [1, 5], human: 'high' },
  nonlinear_delayed_disclosure: { question: 'To what extent does the story use time jumps to stage revelations?', scale: [1, 5], human: 'high' },
  dialogue_to_narration: { question: 'What proportion of text is direct dialogue vs. narration?', scale: [1, 5], human: 'high' },
  location_variety: { question: 'How many distinct physical locales does the story inhabit (1 single, 4 many)?', scale: [1, 4], human: 'high' }
});

// Optional diagnostics outside the historical 23-item score (taxonomy ids in brackets). They describe
// choices to inspect, such as a repeated epilogue or doubled emotion channels; they never enter humanLean.
export const DIAGNOSTICS = Object.freeze({
  denouement_length: { question: 'How extended is the narrative after the main climactic event? [PLT_MOR_007]', options: ['none_or_minimal', 'brief', 'extended'] },
  thematic_unity: { question: 'To what extent do subplots, set-pieces, and flourishes serve one central theme? [PLT_THM_008]', scale: [1, 5] },
  explicit_emotion_naming: { question: 'How often does the narration name the central character’s emotions? [AGENT_EMO_001]', options: ['rare_or_never', 'occasional', 'frequent'] },
  emotion_modes: { question: 'Through which modes are the central character’s emotions mainly conveyed? [AGENT_EMO_002]', multi: ['labels', 'physiology', 'metaphor_or_environment', 'actions', 'dialogue'] },
  emotion_cues: { question: 'Which cues most commonly convey what characters feel? [AGENT_EMO_012]', multi: ['physiology', 'face_or_gesture', 'actions', 'metaphor_or_environment', 'dialogue'] }
});

function checkDiagnostic(item, value) {
  if (item.scale) return Number.isInteger(value) && value >= item.scale[0] && value <= item.scale[1];
  if (item.multi) return Array.isArray(value) && value.every((option) => item.multi.includes(option));
  return item.options.includes(value);
}

export function rubricTemplate() {
  return { schemaVersion: 1, genre: 'fiction', instructions: 'Answer every feature with one allowed value, or "n/a" when the text cannot support a judgment. Judge the text only, not the intent behind it.', features: Object.fromEntries(Object.entries(RUBRIC).map(([id, item]) => [id, { question: item.question, allowed: item.scale ? `${item.scale[0]}-${item.scale[1]}` : item.options, value: null }])), diagnostics: Object.fromEntries(Object.entries(DIAGNOSTICS).map(([id, item]) => [id, { question: item.question, allowed: item.scale ? `${item.scale[0]}-${item.scale[1]}` : item.multi ? { anyOf: item.multi } : item.options, value: null }])) };
}

function leanOf(item, value) {
  if (item.scale) {
    const [low, high] = item.scale;
    if (!Number.isInteger(value) || value < low || value > high) return undefined;
    const position = (value - low) / (high - low);
    return item.human === 'high' ? position : 1 - position;
  }
  if (!item.options.includes(value)) return undefined;
  if (value === item.human) return 1;
  if (value === item.ai) return 0;
  // ponytail: an option the paper names for neither source is half-way only when both ends are named.
  return item.human && item.ai ? 0.5 : item.ai ? 1 : 0;
}

export function scoreRubric(annotation) {
  if (!annotation || typeof annotation !== 'object' || annotation.schemaVersion !== 1 || typeof annotation.features !== 'object' || annotation.features === null) throw new Error('rubric must be an object with schemaVersion 1 and features');
  const unknown = Object.keys(annotation.features).filter((id) => !RUBRIC[id]);
  if (unknown.length) throw new Error(`unknown rubric features: ${unknown.join(', ')}`);
  const features = {};
  const errors = [];
  for (const [id, item] of Object.entries(RUBRIC)) {
    const raw = annotation.features[id];
    const value = raw && typeof raw === 'object' ? raw.value : raw;
    if (value === undefined || value === null) { errors.push(`${id}: missing`); continue; }
    if (value === 'n/a') { features[id] = { value, lean: null }; continue; }
    const lean = leanOf(item, value);
    if (lean === undefined) { errors.push(`${id}: ${JSON.stringify(value)} is not allowed`); continue; }
    features[id] = { value, lean: Number(lean.toFixed(3)), side: lean > 0.5 ? 'human' : lean < 0.5 ? 'ai' : 'neutral' };
  }
  const diagnostics = {};
  for (const [id, raw] of Object.entries(annotation.diagnostics ?? {})) {
    const item = DIAGNOSTICS[id];
    const value = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw.value : raw;
    if (!item) errors.push(`${id}: unknown diagnostic`);
    else if (value === null || value === undefined || value === 'n/a') continue;
    else if (!checkDiagnostic(item, value)) errors.push(`${id}: ${JSON.stringify(value)} is not allowed`);
    else diagnostics[id] = value;
  }
  if (errors.length) throw new Error(`invalid rubric values: ${errors.join('; ')}`);
  const scored = Object.values(features).filter((item) => item.lean !== null);
  if (scored.length < Object.keys(RUBRIC).length / 2) throw new Error('rubric needs at least half of the features assessed');
  return {
    schemaVersion: 1,
    humanLean: Number((scored.reduce((a, item) => a + item.lean, 0) / scored.length).toFixed(3)),
    assessed: scored.length,
    aiSide: Object.entries(features).filter(([, item]) => item.side === 'ai').map(([id]) => id),
    features,
    diagnostics,
    note: 'Unweighted mean of feature directions from StoryScope; a corpus description, not the paper’s trained classifier, a quality score, or a target.'
  };
}

export function compareRubrics(baseline, revised) {
  const before = scoreRubric(baseline);
  const after = scoreRubric(revised);
  const both = Object.keys(RUBRIC).filter((id) => before.features[id]?.lean != null && after.features[id]?.lean != null);
  const changed = Object.fromEntries(Object.keys(DIAGNOSTICS).filter((id) => JSON.stringify(before.diagnostics[id]) !== JSON.stringify(after.diagnostics[id])).map((id) => [id, { before: before.diagnostics[id] ?? null, after: after.diagnostics[id] ?? null }]));
  // ponytail: no pass verdict on purpose; a feature may stay put or move either way for a good editorial reason.
  return { schemaVersion: 1, before: before.humanLean, after: after.humanLean, delta: Number((after.humanLean - before.humanLean).toFixed(3)), movedTowardAi: both.filter((id) => after.features[id].lean < before.features[id].lean), movedTowardHuman: both.filter((id) => after.features[id].lean > before.features[id].lean), stillAiSide: after.aiSide, diagnosticsChanged: changed };
}

function readBounded(file) {
  if (statSync(file).size > MAX_BYTES) throw new Error(`${file} exceeds ${MAX_BYTES} bytes`);
  return readFileSync(file, 'utf8');
}

// ---------- web pages ----------
const MAX_PAGE_BYTES = 4 * 1024 * 1024;
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', mdash: '\u2014', ndash: '\u2013', hellip: '…' };
const decode = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => e[0] === '#'
  ? String.fromCodePoint(Number.parseInt(e[1].toLowerCase() === 'x' ? e.slice(2) : e.slice(1), e[1].toLowerCase() === 'x' ? 16 : 10))
  : ENTITIES[e.toLowerCase()] ?? m);

// ponytail: regex reader, not a DOM parser. It keeps the first <article>, else <main>, else <body>, and drops
// page chrome. Pages that render text with JavaScript or split a story across pages need the text saved to a file.
export function extractText(html) {
  const title = decode(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '').trim();
  let body = html.replace(/<!--[\s\S]*?-->/g, '').replace(/<(script|style|noscript|svg|template|iframe)\b[\s\S]*?<\/\1>/gi, '');
  // Pages may carry several <main> (loading skeletons) and nested <article> cards: keep the <main> with the most text.
  const plain = (html) => html.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').length;
  body = (body.match(/<main\b[\s\S]*?<\/main>/gi) ?? []).sort((a, b) => plain(b) - plain(a))[0] ?? body.match(/<body\b[\s\S]*<\/body>/i)?.[0] ?? body;
  body = body.replace(/<(nav|header|footer|aside|form)\b[\s\S]*?<\/\1>/gi, '');
  // Screen-reader-only labels ("opens in a new tab") are not prose; table cells stay on one line per row.
  // Hidden text (glossary popovers, duplicate responsive labels) and footnote markers ("7<sup>2</sup>") are not prose either.
  body = body.replace(/<(span|div)\b[^>]*(class="[^"]*\b(sr-only|visually-hidden)\b[^"]*"|\shidden(=""|(?=[\s>]))|aria-hidden="true")[^>]*>[\s\S]*?<\/\1>/gi, '');
  body = body.replace(/<sup\b[^>]*>([\s\S]*?)<\/sup>/gi, (tag, inner) => (/<a\b/i.test(inner) && /^[\s\d,\[\]*\u2020-]*$/.test(inner.replace(/<[^>]+>/g, '')) ? '' : tag));
  body = body.replace(/<\/t[dh]>\s*(?=<t[dh]\b)/gi, ' \u00b7 ').replace(/<(t[dh])\b[^>]*>([\s\S]*?)<\/\1>/gi, (_, tag, cell) => cell.replace(/<\/?(p|div)\b[^>]*>/gi, ' ')).replace(/<\/tr>/gi, '\n\n');
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
  if (!wordsOf(page.text).length) throw new Error('no readable text on the page (it probably loads its text with JavaScript); save the text to a file and use --text');
  return page;
}


// ---------- editorial review ----------
// The agent reads the text and proposes edits; the helper only accepts edits it can check against the text.
export const REVIEW_KINDS = Object.freeze({
  unclear: 'Hard to follow', generic: 'Says little', unsupported: 'Claim without support', repetitive: 'Repeats itself',
  structure: 'Order or emphasis', tone: 'Tone', inconsistent: 'Inconsistent or wrong',
});
const squash = (t) => t.replace(/\s+/g, ' ').trim();
// Throws unless every quote is verbatim in the text and every suggestion uses only numbers and names the text already has.
export function checkReview(text, review, lang = 'en') {
  const findings = review?.findings;
  if (!Array.isArray(findings) || !findings.length || findings.length > 40) throw new Error('review needs a findings array of 1-40 items');
  const page = squash(text);
  const lower = page.toLowerCase();
  return findings.map((f, i) => {
    const at = `finding ${i + 1}`;
    for (const k of ['quote', 'why', 'suggestion']) if (typeof f?.[k] !== 'string' || !f[k].trim() || f[k].length > 1200) throw new Error(`${at}: ${k} must be a non-empty string up to 1200 characters`);
    if (!(f.kind in REVIEW_KINDS)) throw new Error(`${at}: kind must be one of ${Object.keys(REVIEW_KINDS).join(', ')}`);
    if (!page.includes(squash(f.quote))) throw new Error(`${at}: the quote is not in the text word for word`);
    // ponytail: names come from specificsOf, so a name opening a sentence of the suggestion slips through;
    // a capitalized word the text has in any case ("Banks", "DTA'") is not new.
    const { numbers, names } = specificsOf(f.suggestion, lang);
    const invented = [...numbers.filter((n) => !lower.includes(n.toLowerCase())), ...names.filter((n) => !lower.includes(n.replace(/'+$/, '').toLowerCase()))];
    if (invented.length) throw new Error(`${at}: the suggestion adds ${invented.join(', ')}, which the text never states`);
    return { kind: f.kind, quote: squash(f.quote), why: f.why.trim(), suggestion: f.suggestion.trim() };
  });
}


// ---------- report ----------
// A short first line is usually the title; otherwise the opening words stand in. Never a file path.
export const titleOf = (text) => {
  const first = text.split('\n').map((line) => line.trim()).find(Boolean) ?? '';
  return first.length <= 90 ? first : `${first.split(/\s+/).slice(0, 8).join(' ')}\u2026`;
};
// A self-contained HTML page in the youdede.eu visual language: inline styles and one inline script, no fonts or
// remote assets. Without JavaScript every value and highlight is already in place.
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

// What each flag means and the change the skill recommends. Every change removes or rephrases; none adds content.
export const ADVICE = Object.freeze({
  'em-dash-density': ['Em dashes', 'Replace most dashes with a comma, a colon, parentheses, or a full stop.'],
  'ai-vocabulary-density': ['Stock phrasing', 'Swap stock words and filler phrases for the plain word the sentence means, or cut them.'],
  'contrast-frame-density': ['"Not X, but Y" frames', 'State the point directly instead of setting up a contrast to knock down.'],
  'uniform-sentence-length': ['Even sentence rhythm', 'Vary sentence length where the content allows. Do not split sentences whose parts depend on each other.'],
  'closing-thematic-commentary': ['Closing moral', 'End on the last action, line, or fact instead of explaining what it meant.'],
  'embodied-emotion-dominance': ['Feelings shown only through the body', 'Cut repeated bodily cues such as tight chests and racing hearts; where the draft names a feeling, let that stand.'],
  'olfactory-density': ['Smell in every scene', 'Keep the scents that matter to the story and cut the rest.']
});
const METRIC_LABELS = { words: 'Words', emDashPer1k: 'Em dashes per 1k words', aiVocabularyPer1k: 'Stock phrases per 1k words', contrastFramePer1k: 'Contrast frames per 1k words', sentenceLengthCv: 'Sentence length variation', dialogueWordShare: 'Dialogue share', embodiedEmotionCues: 'Bodily emotion cues', explicitEmotionLabels: 'Named emotions', olfactoryPer1k: 'Smells per 1k words', closingCommentary: 'Closing commentary', specificsPer1k: 'Specifics per 1k words' };
const esc = (value) => String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const paragraphsOf = (html) => html.split(/\n\s*\n/).map((p) => `<p>${p.trim()}</p>`).join('');
const words1 = (text) => esc(text).split(' ').map((w, i) => `<span class="w" style="--i:${i}">${w}</span>`).join(' ');

// Where each flagged habit occurs, so the report can point at it. Same patterns as the measurement.
export function flagSpans(text, lang, ids) {
  const lexicon = LEXICONS[lang];
  const sources = {
    'em-dash-density': /—| – /g,
    'ai-vocabulary-density': compile(lexicon.aiVocabulary),
    'contrast-frame-density': compile(lexicon.contrastFrames),
    'closing-thematic-commentary': compile(lexicon.commentary),
    'embodied-emotion-dominance': compile(lexicon.embodied),
    'olfactory-density': compile(lexicon.olfactory)
  };
  const dialogueDash = /^[ \t]*[—–-]/;
  const spans = [];
  for (const id of ids) {
    if (!sources[id]) continue;
    for (const m of text.matchAll(sources[id])) {
      if (id === 'em-dash-density' && dialogueDash.test(text.slice(text.lastIndexOf('\n', m.index) + 1))) continue;
      if (id === 'closing-thematic-commentary' && m.index < text.length * 0.8) continue;
      spans.push({ start: m.index, end: m.index + m[0].length, id });
    }
  }
  return spans.sort((x, y) => x.start - y.start).filter((span, i, all) => !all.slice(0, i).some((o) => o.end > span.start));
}

function markText(text, spans) {
  let html = '';
  let at = 0;
  for (const { start, end, id } of spans) {
    html += esc(text.slice(at, start)) + `<mark data-flag="${id}">${esc(text.slice(start, end))}</mark>`;
    at = end;
  }
  return paragraphsOf(html + esc(text.slice(at)));
}

// Word-level tracked changes: Myers' O((N+M)D) diff, so long texts with scattered edits stay fast.
// ponytail: past 6,000 edited tokens the view is skipped and the report keeps side by side only.
export function trackChanges(before, after, maxEdits = 6000) {
  const tok = (t) => t.match(/\s+|[\p{L}\p{N}'’-]+|[^\s\p{L}\p{N}]/gu) || [];
  const a = tok(before);
  const b = tok(after);
  const n = a.length;
  const m = b.length;
  const off = maxEdits + 1;
  const v = new Int32Array(2 * off + 1);
  const trace = [];
  let found = -1;
  for (let d = 0; d <= maxEdits && found < 0; d += 1) {
    trace.push(v.slice(off - d - 1, off + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) { x += 1; y += 1; }
      v[off + k] = x;
      if (x >= n && y >= m) { found = d; break; }
    }
  }
  if (found < 0) return null;
  const ops = [];
  let x = n;
  let y = m;
  for (let d = found; d >= 0; d -= 1) {
    const snap = trace[d];
    const at = (k) => snap[k + d + 1];
    const k = x - y;
    const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
    const prevX = d === 0 ? 0 : at(prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) { ops.push(['=', a[x - 1]]); x -= 1; y -= 1; }
    if (d > 0) {
      if (x === prevX) ops.push(['+', b[y - 1]]);
      else ops.push(['-', a[x - 1]]);
      x = prevX;
      y = prevY;
    }
  }
  ops.reverse();
  const merged = [];
  for (const [op, t] of ops) {
    if (merged.at(-1)?.op === op) merged.at(-1).t += t;
    else merged.push({ op, t });
  }
  const changed = merged.filter((o) => o.op !== '=' && o.t.trim()).length;
  const html = merged.map(({ op, t }) => {
    if (!t.trim()) return op === '-' ? ' ' : t;
    return op === '=' ? esc(t) : op === '+' ? `<ins>${esc(t)}</ins>` : `<del>${esc(t)}</del>`;
  }).join('');
  return { html: paragraphsOf(html), changed };
}

const checkIcon = (ok) => ok ? '<svg class="tick-icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10.5"/><path d="M7 12.5l3.2 3.2L17 9"/></svg>' : '<svg class="tick-icon fail" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10.5"/><path d="M12 7v6.5M12 16.6v.4"/></svg>';

export function renderReport(result, { draft, revised, source = '', review = [] } = {}) {
  const comparing = Boolean(result.before);
  const now = comparing ? result.after : result;
  const lang = now.lang;
  const decimals = (v) => (Number.isInteger(v) ? 0 : String(v).split('.')[1].length);
  const flagCard = (f, i, state = '', spans = []) => {
    const [title, advice] = ADVICE[f.id] ?? [f.id, ''];
    const n = spans.filter((x) => x.id === f.id).length;
    const pill = state === 'done' ? '<span class="pill ok">Resolved</span>' : state === 'new' ? '<span class="pill warn">New</span>' : `<span class="pill">${f.source === 'storyscope-direction' ? 'Research-based' : 'Surface'}</span>`;
    const show = n ? `<button type="button" class="show" data-flag-btn="${f.id}" aria-pressed="false">Show ${n} in the text</button>` : '';
    return `<li class="flag rv ${state}" style="--i:${i}"><div class="row"><h3><span class="strike">${esc(title)}</span></h3>${pill}</div><p>${esc(advice)}</p><div class="row"><span class="label">Measured ${esc(f.value)}, limit ${esc(f.limit)}</span>${show}</div></li>`;
  };
  let hero;
  let body;
  let tone;
  if (comparing) {
    const failed = Object.entries(result.checks).filter(([, ok]) => !ok).map(([k]) => k);
    tone = result.pass ? 'var(--brand)' : 'var(--ink)';
    const checkNames = { length: ['Length', `${Math.round(result.lengthRatio * 100)}% of the draft`], newFlags: ['No new signals', `${result.newFlags.length} new`], preservation: ['Facts kept', 'numbers and names'], traceability: ['Nothing invented', 'every sentence traced'] };
    hero = `<div class="label rv">Revision report</div><h1><span class="dot"></span>${words1(result.pass ? 'All checks passed' : `${failed.length} check${failed.length > 1 ? 's' : ''} to review`)}</h1><p class="lede rv" style="--i:3">${result.resolvedFlags.length} habit${result.resolvedFlags.length === 1 ? '' : 's'} of default model prose resolved, ${result.newFlags.length} new. The revision is ${Math.round(result.lengthRatio * 100)}% as long as the draft.</p>`;
    const p = result.preservation;
    const t = result.traceability;
    const issues = [...p.droppedNumbers.map((x) => `Dropped number: ${x}`), ...p.droppedNames.map((x) => `Dropped name: ${x}`), ...p.addedNumbers.map((x) => `Added number: ${x}`), ...p.addedNames.map((x) => `Added name: ${x}`), ...t.untracedSentences.map((x) => `Sentence not traced to the draft: ${x}`), ...t.addedFeelings.map((x) => `Feeling not in the draft: ${x}`)];
    const rows = Object.keys(METRIC_LABELS).filter((k) => typeof result.before.metrics[k] === 'number' && typeof result.after.metrics[k] === 'number').map((k, i) => {
      const [x, y, d] = [result.before.metrics[k], result.after.metrics[k], result.delta[k]];
      const dec = Math.max(decimals(x), decimals(y));
      return `<tr class="rv" style="--i:${i}"><td>${METRIC_LABELS[k]}</td><td class="num">${x}</td><td class="num"><span data-from="${x}" data-to="${y}" data-dec="${dec}">${y}</span></td><td class="num ${d ? 'moved' : ''}">${d > 0 ? '+' : ''}${d}</td></tr>`;
    }).join('');
    const tracked = draft && revised ? trackChanges(draft, revised) : null;
    const textView = draft && revised ? `<section><div class="head rv"><div><div class="label">Text</div><h2>Every change, word by word</h2></div><div class="toolbar" role="radiogroup" aria-label="Text view">${tracked ? '<input class="sr" type="radio" name="view" id="v-track" checked><label for="v-track">Tracked changes</label>' : ''}<input class="sr" type="radio" name="view" id="v-side" ${tracked ? '' : 'checked'}><label for="v-side">Side by side</label></div></div>
${tracked ? `<div class="card text view-track rv"><div class="row"><span class="label">${tracked.changed} edit${tracked.changed === 1 ? '' : 's'}</span><span class="label"><del>removed</del> <ins>added</ins></span></div>${tracked.html}</div>` : ''}
<div class="split view-side"><div class="card text"><div class="label">Draft</div>${paragraphsOf(esc(draft))}</div><div class="card text"><div class="label side">Revision</div>${paragraphsOf(esc(revised))}</div></div></section>` : '';
    body = `<section><div class="metrics">${Object.entries(result.checks).map(([k, ok], i) => `<div class="metric rv check ${ok ? 'ok' : 'no'}" style="--i:${i}">${checkIcon(ok)}<div class="label">${checkNames[k][0]}</div><div class="v">${ok ? 'Pass' : 'Review'}</div><div class="s">${checkNames[k][1]}</div></div>`).join('')}</div></section>
<section><div class="head rv"><div><div class="label">Changes</div><h2>What the revision cleared</h2></div><p>Habits found in the draft, and whether the revision removed them.</p></div><ul class="flags">${[...result.before.flags.map((f, i) => flagCard(f, i, result.resolvedFlags.includes(f.id) ? 'done' : '')), ...result.after.flags.filter((f) => result.newFlags.includes(f.id)).map((f, i) => flagCard(f, i, 'new'))].join('') || '<li class="flag rv"><p>The draft had no signals above the limits.</p></li>'}</ul></section>
<section><div class="head rv"><div><div class="label">Fidelity</div><h2>Facts and inventions</h2></div><p>Numbers and names compared one by one, and every revised sentence traced back to the draft.</p></div><div class="card rv shield ${issues.length ? 'open' : 'clear'}"><ul class="notes">${issues.length ? issues.map((x) => `<li class="key">${esc(x)}</li>`).join('') : '<li class="key">No number or name dropped or added, and every sentence traces to the draft.</li>'}</ul></div></section>
<section><div class="head rv"><div><div class="label">Measurements</div><h2>Before and after</h2></div></div><div class="card"><table><thead><tr><th class="label">Signal</th><th class="label num">Draft</th><th class="label num">Revision</th><th class="label num">Change</th></tr></thead><tbody>${rows}</tbody></table></div></section>
${textView}`;
  } else {
    tone = now.flags.length ? 'var(--ink)' : 'var(--brand)';
    const spans = draft ? flagSpans(draft, lang, now.flags.map((f) => f.id)) : [];
    const marked = draft ? markText(draft, spans) : '';
    const excerpts = marked.split('</p>').filter((p) => p.includes('<mark')).map((p) => `${p}</p>`);
    const words = now.metrics.words;
    const edits = review.length ? `<section><div class="head rv"><div><div class="label">Editorial review</div><h2>Edits, passage by passage</h2></div><p>Each quote is checked word for word against the text, and no suggestion adds a number or a name the text does not already state. The facts still need your check.</p></div><ol class="edits">${review.map((f, i) => `<li class="edit card rv" style="--i:${i % 6}"><div class="row"><span class="label">${String(i + 1).padStart(2, '0')}</span><span class="pill">${esc(REVIEW_KINDS[f.kind])}</span></div><blockquote><del>${esc(f.quote)}</del></blockquote><p class="why">${esc(f.why)}</p><p class="try"><span class="label">Try</span> <ins>${esc(f.suggestion)}</ins></p></li>`).join('')}</ol></section>` : '';
    if (review.length) {
      const kinds = Object.keys(REVIEW_KINDS).map((k) => [k, review.filter((f) => f.kind === k).length]).filter(([, n]) => n).sort((a, b) => b[1] - a[1]);
      hero = `<div class="label rv">Editorial review</div><h1><span class="dot"></span>${words1(`${review.length} edit${review.length > 1 ? 's' : ''} worth making`)}</h1><p class="lede rv" style="--i:3">Mostly: ${esc(kinds.slice(0, 3).map(([k, n]) => `${REVIEW_KINDS[k].toLowerCase()} (${n})`).join(', '))}. ${now.flags.length ? `The text also shows ${now.flags.length} measured habit${now.flags.length > 1 ? 's' : ''} of default model prose.` : 'No measured habit of default model prose crosses its limit.'}</p>`;
    } else hero = `<div class="label rv">Recommended changes</div><h1><span class="dot"></span>${words1(now.flags.length ? `${now.flags.length} habit${now.flags.length > 1 ? 's' : ''} to revise` : 'Nothing above the limits')}</h1><p class="lede rv" style="--i:3">${now.flags.length ? 'Each card names a habit of default model prose found in this text and the change the skill recommends. Every change cuts or rephrases; none adds a fact.' : 'Nothing in this text crosses the measured limits. Structure may still be worth a look.'}</p>`;
    const key = ['words', 'emDashPer1k', 'aiVocabularyPer1k', 'contrastFramePer1k', 'sentenceLengthCv'];
    const limitOf = (k) => (k in now.limits ? now.limits[k] : k === 'sentenceLengthCv' ? now.limits.sentenceLengthCvMin : null);
    const over = (k) => { const l = limitOf(k); const v = now.metrics[k]; return l !== null && v !== null && (k === 'sentenceLengthCv' ? v < l : v > l); };
    body = `${edits}<section><div class="metrics">${key.map((k, i) => `<div class="metric rv ${over(k) ? 'over' : ''}" style="--i:${i}"><div class="label">${METRIC_LABELS[k]}</div><div class="v" ${typeof now.metrics[k] === 'number' ? `data-to="${now.metrics[k]}" data-dec="${decimals(now.metrics[k])}"` : ''}>${now.metrics[k] ?? 'n/a'}</div><div class="s">${limitOf(k) === null ? ' ' : `${k === 'sentenceLengthCv' ? 'at least' : 'limit'} ${limitOf(k)}`}</div></div>`).join('')}</div></section>
${now.flags.length ? `<section><div class="head rv"><div><div class="label">Changes</div><h2>What to change</h2></div><p>Press a card's button to light up every place it occurs in the text below. Surface signals are heuristics; research-based ones follow published findings on AI fiction.</p></div><ul class="flags">${now.flags.map((f, i) => flagCard(f, i, '', spans)).join('')}</ul></section>` : ''}
${draft ? `<section><div class="head rv"><div><div class="label">Text</div><h2>Where the habits are</h2></div><p>${spans.length ? `Only the ${excerpts.length} paragraph${excerpts.length === 1 ? '' : 's'} with a highlight. The full text is below.` : 'No passage to highlight.'}</p></div>${excerpts.length ? `<div class="card text marked rv">${excerpts.join('<p class="gap">\u2026</p>')}</div>` : ''}<details class="card text full rv"><summary class="label">Full text as measured (${words.toLocaleString('en')} words)</summary>${marked}</details></section>` : ''}`;
  }
  return `<!doctype html><html lang="${esc(lang)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${comparing ? 'Revision report' : 'Recommended changes'}: human voice edit</title><script>document.documentElement.classList.add('js')</script><style>${REPORT_CSS}
.flags{list-style:none;margin:0;padding:0;display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:16px}
.flag{background:var(--surface);border:1px solid var(--hairline);border-radius:14px;padding:22px}.flag p{color:var(--ink-muted);margin:8px 0 14px}.flag:hover{border-color:var(--hairline-strong);transform:translateY(-2px)}
.strike{background:linear-gradient(var(--brand),var(--brand)) left 55%/0 1.5px no-repeat;transition:background-size .9s var(--ease-text) .6s}
.flag.done{border-color:var(--brand-border)}.flag.done h3{color:var(--ink-subtle)}.flag.done.in .strike,.flag.done:not(.rv) .strike,html:not(.js) .flag.done .strike{background-size:100% 1.5px}
.row{display:flex;justify-content:space-between;align-items:center;gap:12px}
.show{font:400 11px/1.6 var(--mono);letter-spacing:.09em;text-transform:uppercase;color:var(--brand);background:none;border:1px solid var(--brand-border);border-radius:999px;padding:4px 12px;cursor:pointer;transition:background .25s var(--ease)}
.show:hover,.show[aria-pressed=true]{background:var(--brand-border);color:var(--ink)}
.metric.over .v{color:var(--ink)}.metric.over .s{color:var(--ink)}.metric.over{box-shadow:inset 0 -2px 0 var(--ink-muted)}
.check{position:relative}.tick-icon{width:28px;height:28px;float:right;fill:none;stroke:var(--brand);stroke-width:1.6;stroke-linecap:round;stroke-linejoin:round}.tick-icon.fail{stroke:var(--ink)}
.tick-icon circle{stroke-dasharray:66;stroke-dashoffset:0;opacity:.45}.tick-icon path{stroke-dasharray:20;stroke-dashoffset:0}
.js .check:not(.in) .tick-icon circle{stroke-dashoffset:66}.js .check:not(.in) .tick-icon path{stroke-dashoffset:20}
.js .check .tick-icon circle{transition:stroke-dashoffset .9s var(--ease-text) calc(var(--i)*140ms + .2s)}.js .check .tick-icon path{transition:stroke-dashoffset .6s var(--ease-text) calc(var(--i)*140ms + .8s)}
.shield.clear{border-color:var(--brand-border);background:linear-gradient(120deg,rgba(62,207,142,.07),transparent 60%),var(--surface)}
table{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums}th{text-align:left;font-weight:400;padding:0 0 10px}td{padding:10px 0;border-top:1px solid var(--hairline);color:var(--ink-subtle)}
tbody tr{transition:background .2s var(--ease)}tbody tr:hover{background:var(--raised)}
.num{text-align:right;font-family:var(--mono);font-size:13px}td.moved{color:var(--brand)}
.split{display:grid;grid-template-columns:1fr 1fr;gap:16px}@media (max-width:760px){.split{grid-template-columns:1fr}}
.edits{list-style:none;margin:0;padding:0;display:grid;gap:16px}.edit blockquote{margin:14px 0 0;font:400 17px/1.6 var(--serif)}.edit blockquote del{color:var(--ink-muted)}.edit .why{color:var(--ink-subtle);margin:12px 0 0}.edit .try{font:400 17px/1.6 var(--serif);margin:12px 0 0}.edit .try ins{color:var(--ink)}
.text p{font:400 17px/1.65 var(--serif);color:var(--ink-subtle);margin:14px 0 0}.text .gap{text-align:center;color:var(--ink-muted);margin:10px 0 0}.full{margin-top:14px}.full summary{cursor:pointer;list-style:none}.full summary::before{content:'+ '}.full[open] summary::before{content:'\\2212  '}.side{color:var(--brand)}
ins{text-decoration:none;color:var(--ink);background:rgba(62,207,142,.16);box-shadow:inset 0 -1.5px 0 var(--brand);border-radius:2px}
del{color:var(--ink-muted);text-decoration-color:var(--ink-muted);opacity:.7}
.view-track,.view-side{display:none}
body:has(#v-track:checked) .view-track{display:block}body:has(#v-side:checked) .view-side{display:grid}
html:not(:has(#v-track)) .view-side{display:grid}
body:has(#v-track:checked) label[for=v-track],body:has(#v-side:checked) label[for=v-side]{background:var(--raised);color:var(--ink)}
mark{background:transparent;color:var(--ink);box-shadow:inset 0 -2px 0 var(--ink-muted);border-radius:2px;transition:background .35s var(--ease),box-shadow .35s var(--ease)}
body[data-focus] mark{opacity:.55}body[data-focus=""] mark{opacity:1}
${Object.keys(ADVICE).map((id) => `body[data-focus="${id}"] mark[data-flag="${id}"]`).join(',')}{opacity:1;background:rgba(62,207,142,.18);box-shadow:inset 0 -2px 0 var(--brand)}
</style></head><body><main style="--tone:${tone}">
<div class="top label"><span><b>youdede</b> / Human voice edit</span><span>${esc(source)}</span></div>
${hero}
${body}
<section><div class="head rv"><div><div class="label">Limits</div><h2>How to read this</h2></div></div><div class="card rv"><ul class="notes"><li class="key">These signals describe habits of default model prose. Clearing them does not make a text undetectable, and this report is not a detector result.</li>${now.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul></div></section>
<footer><p>Signals and limits are heuristics built for this skill. Research-based signals follow the direction of published findings on AI-generated fiction, without calibrated thresholds.</p></footer>
</main><script>${REPORT_JS}</script></body></html>
`;
}

const USAGE = 'usage: measure-voice-signals.mjs (--text <file> | --url <page>) --extract\n       measure-voice-signals.mjs (--text <file> | --url <page>) [--baseline <file> | --review <file>] [--lang en|it] [--genre fiction|nonfiction] [--format json|html] [--out <file>]\n       measure-voice-signals.mjs --rubric <file> [--rubric-baseline <file>]\n       measure-voice-signals.mjs --rubric-template';

async function main(argv) {
  const { values } = parseArgs({ args: argv, strict: true, options: { help: { type: 'boolean' }, extract: { type: 'boolean' }, text: { type: 'string' }, url: { type: 'string' }, baseline: { type: 'string' }, review: { type: 'string' }, lang: { type: 'string', default: 'en' }, genre: { type: 'string', default: 'fiction' }, rubric: { type: 'string' }, 'rubric-baseline': { type: 'string' }, 'rubric-template': { type: 'boolean' }, format: { type: 'string', default: 'json' }, out: { type: 'string' } } });
  if (values.help) return process.stdout.write(`${USAGE}\n`);
  if (!['json', 'html'].includes(values.format) || (values.text && values.url) || (values.format === 'html' && !values.text && !values.url)) throw new Error(USAGE);
  const page = values.url ? await readUrl(values.url) : null;
  if (values.extract) {
    const text = page ? page.text : readBounded(values.text ?? '');
    return process.stdout.write(`${JSON.stringify({ title: page?.title || titleOf(text), words: wordsOf(text).length, text }, null, 2)}\n`);
  }
  let result;
  if (values['rubric-template']) result = rubricTemplate();
  else if (values.rubric) {
    const parse = (file) => JSON.parse(readBounded(file));
    result = values['rubric-baseline'] ? compareRubrics(parse(values['rubric-baseline']), parse(values.rubric)) : scoreRubric(parse(values.rubric));
  } else if (values.text || page) {
    const options = { lang: values.lang, genre: values.genre };
    const text = page ? page.text : readBounded(values.text);
    const draft = values.baseline ? readBounded(values.baseline) : null;
    result = draft ? compareTexts(draft, text, options) : measureText(text, options);
    if (values.review) {
      if (draft) throw new Error('--review applies to one text, not to a comparison');
      result.review = checkReview(text, JSON.parse(readBounded(values.review)), values.lang);
    }
    if (values.format === 'html') {
      // A short first line is usually the title; otherwise the file name, never its folders.
      const title = page?.title || titleOf(draft ?? text);
      result = renderReport(result, draft ? { draft, revised: text, source: title } : { draft: text, source: title, review: result.review ?? [] });
    }
  } else throw new Error(USAGE);
  const body = typeof result === 'string' ? result : `${JSON.stringify(result, null, 2)}\n`;
  if (values.out) {
    writeFileSync(values.out, body);
    process.stdout.write(`${JSON.stringify({ written: values.out })}\n`);
  } else process.stdout.write(body);
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2)).catch((error) => { process.stderr.write(`measure-voice-signals: ${error.message}\n`); process.exitCode = 1; });
}
