// Repair the loose inline content markdown rendering can leave directly under
// the article.
//
// Display math renders as a <div>, and a <div> inside a <p> is not legal HTML:
// the parser closes the paragraph, drops the div in as a sibling, and leaves
// everything that followed in that paragraph as bare text and inline spans
// parented straight to the article. Those orphans look fine, but nothing
// downstream treats them as prose: Tab navigation stepped onto each one
// individually, so a lone inline $R^2$ became its own "block" to get stuck on.
//
// Wrapping each run of orphans back into a paragraph puts the document into the
// shape the rest of the pipeline assumes: one block per line of prose.

// Inline-level tags markdown can realistically emit. Anything else counts as a
// block and ends the current run.
export const INLINE_TAGS = new Set([
  'A', 'ABBR', 'B', 'BDI', 'BDO', 'BR', 'CITE', 'CODE', 'DEL', 'DFN', 'EM', 'I',
  'IMG', 'INPUT', 'INS', 'KBD', 'LABEL', 'MARK', 'Q', 'RUBY', 'S', 'SAMP',
  'SMALL', 'SPAN', 'STRONG', 'SUB', 'SUP', 'TIME', 'U', 'VAR', 'WBR',
]);

export function isInlineElement(node) {
  return node?.nodeType === 1 && INLINE_TAGS.has(node.tagName);
}

export function wrapOrphanInlines(article) {
  let run = [];

  const flush = () => {
    // Whitespace alone is just the gap between two blocks, not a paragraph.
    if (run.some((n) => n.nodeType === 1 || n.textContent.trim())) {
      const p = article.ownerDocument.createElement('p');
      run[0].before(p);
      p.append(...run);
    }
    run = [];
  };

  for (const node of Array.from(article.childNodes)) {
    if (node.nodeType === 3) {
      // Whitespace continues a run but never starts one.
      if (node.textContent.trim() || run.length) run.push(node);
    } else if (isInlineElement(node)) {
      run.push(node);
    } else if (node.nodeType !== 8) { // comments are neutral
      flush();
    }
  }
  flush();
}
