const OUTPUT_CONTRACT_HEADING = /^## Output contract\s*$/gmu;
const MARKDOWN_HEADING = /`(##\s+[^`\n]+)`/gu;

const clean = (heading) => heading.replace(/\s+/gu, ' ').trim();

export function extractOutputContract(text) {
  if (typeof text !== 'string') return { sections: 0, headings: [] };
  const matches = [...text.matchAll(OUTPUT_CONTRACT_HEADING)];
  if (matches.length !== 1) return { sections: matches.length, headings: [] };
  const start = matches[0].index + matches[0][0].length;
  const tail = text.slice(start);
  const nextHeading = /^##\s+/mu.exec(tail);
  const sectionBody = nextHeading ? tail.slice(0, nextHeading.index) : tail;
  const paragraphs = sectionBody.trim().split(/\n\s*\n/gu);
  let body = paragraphs[0] || '';
  if (![...body.matchAll(MARKDOWN_HEADING)].length && /\b(?:produce|return) these sections\b/iu.test(body)) {
    body = `${body}\n\n${paragraphs[1] || ''}`;
  }
  return {
    sections: 1,
    body,
    headings: [...body.matchAll(MARKDOWN_HEADING)].map((match) => clean(match[1]))
  };
}

export function responseHeadings(text) {
  if (typeof text !== 'string') return [];
  return [...text.matchAll(/^#{1,6}\s+([^\n]+?)\s*$/gmu)]
    .map((match) => clean(match[1].replace(/\s*(?:\[[^\n]*|\([^\n]*)$/u, '')));
}
