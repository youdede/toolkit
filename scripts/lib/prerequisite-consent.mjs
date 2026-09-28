// How the CLI asks before installing an artifact's prerequisites (required links), hints at its
// suggestions (suggested links), and asks before removing a prerequisite that installed artifacts
// require. Every text comes from the links' reasons (`relationships.linkReasons`). In an interactive
// terminal the user answers `ask(question, defaultYes)`; otherwise (an agent, CI, a pipe) the install
// goes ahead with a notice and the removal is refused unless forced. At most one question per command.
// tests/prerequisite-consent.test.mjs covers every branch.

const list = (names) => names.join(', ');
const pronoun = (items) => (items.length === 1 ? 'it' : 'them');

// One line per missing prerequisite: the reason of the link that needs it.
const reasons = (subject, prerequisites) => prerequisites.map(({ slug, reason }) => reason ?? `${subject} needs ${slug}.`);

// Whether to install the missing `prerequisites` ({ slug, reason }) of `subject` (an artifact slug, or
// "the <slug> pack"). `skip` is `--no-prerequisites`. `write(line)` prints a notice line.
export async function decidePrerequisites({ subject, prerequisites, interactive, skip, ask, write }) {
  if (!prerequisites.length) return true;
  if (skip) return false;
  if (!interactive) {
    for (const line of reasons(subject, prerequisites)) write(line);
    write(`Installing ${pronoun(prerequisites)} too; pass --no-prerequisites to skip.`);
    return true;
  }
  return ask(`${reasons(subject, prerequisites).join('\n')}\nInstall ${pronoun(prerequisites)} too? [Y/n] `, true);
}

// What is printed after `subject` was installed without its `prerequisites`: their reasons, unless the
// question just showed them (`asked`), then how to add them later, one command per line when there are
// several, since `add` takes one artifact.
export function skippedNotice(subject, prerequisites, { asked = false } = {}) {
  const names = prerequisites.map(({ slug }) => slug);
  const head = `Installed ${subject} without ${list(names)}.`;
  const add = names.length === 1
    ? [`${head} Add it later: youdede-toolkit add ${names[0]}`]
    : [`${head} Add them later:`, ...names.map((name) => `  youdede-toolkit add ${name}`)];
  return [...(asked ? [] : reasons(subject, prerequisites)), ...add].join('\n');
}

// The single hint line for `suggestions` ({ slug, reason }) after an install, or null.
export function suggestionHint(suggestions) {
  if (!suggestions.length) return null;
  return `Tip: ${suggestions.map(({ slug, reason }) => `add ${slug}${reason ? ` ${reason}` : ''}`).join('; ')}.`;
}

// Whether to remove `prerequisite` while the installed `dependents` ({ slug, reason }) require it. Only
// asked in an interactive terminal, default no; elsewhere the removal is refused unless forced.
export async function confirmRemoval({ prerequisite, dependents, interactive, ask }) {
  if (!dependents.length) return true;
  if (!interactive) return false;
  const [only] = dependents;
  const first = dependents.length === 1
    ? only.reason ?? `${only.slug} requires ${prerequisite}.`
    : `${list(dependents.map(({ slug }) => slug))} require ${prerequisite}.`;
  return ask(`${first}\nRemove it anyway? [y/N] `, false);
}

// A terminal answer: empty for the default, y/yes or n/no; null for anything else (ask again).
export function parseAnswer(answer, defaultYes) {
  const text = String(answer ?? '').trim().toLowerCase();
  if (!text) return defaultYes;
  if (text === 'y' || text === 'yes') return true;
  if (text === 'n' || text === 'no') return false;
  return null;
}
