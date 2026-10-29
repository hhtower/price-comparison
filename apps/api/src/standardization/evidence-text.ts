import { parseFragment } from 'parse5';

type Node = { nodeName: string; value?: string; childNodes?: Node[] };
const blocks = new Set(['address', 'article', 'blockquote', 'br', 'dd', 'div', 'dl', 'dt', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'li', 'ol', 'p', 'pre', 'section', 'table', 'td', 'th', 'tr', 'ul']);

/** Render one source field once, before it is frozen and offered for citation. */
export function visibleEvidenceText(value: string): string {
  const parts: string[] = [];
  const visit = (node: Node): void => {
    if (['script', 'style', 'template', 'noscript'].includes(node.nodeName)) return;
    if (blocks.has(node.nodeName) && node.nodeName !== 'br') parts.push('\n');
    if (node.nodeName === '#text') parts.push(node.value ?? '');
    if (node.nodeName === 'br') parts.push('\n');
    for (const child of node.childNodes ?? []) visit(child);
    if (blocks.has(node.nodeName)) parts.push('\n');
  };
  visit(parseFragment(value) as Node);
  return parts.join('').normalize('NFKC').replace(/[^\S\n]+/gu, ' ').replace(/ *\n */gu, '\n').replace(/\n{2,}/gu, '\n').trim();
}
