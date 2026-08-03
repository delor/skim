// Standards-based bidirectional text setup.
//
// HTML's `dir` attribute is the semantic switch for the Unicode Bidirectional
// Algorithm. Its automatic base-direction rule uses the first strong character.
// That needs one Markdown-specific accommodation: exercise/list labels such as
// "(a)" are metadata, not prose, and must not make "(a) הסבר בעברית..." LTR.
// Ignore such a leading label, choose the first strong prose character, then let
// the browser's bidi implementation order all mixed inline runs.

const LETTER = /\p{Letter}/u;
const RTL_LETTER = /[\p{Script=Hebrew}\p{Script=Arabic}\p{Script=Syriac}\p{Script=Thaana}\p{Script=Nko}\p{Script=Samaritan}\p{Script=Mandaic}\p{Script=Adlam}\p{Script=Hanifi_Rohingya}\p{Script=Yezidi}]/u;

const BLOCK_SELECTOR = [
  'address',
  'aside',
  'blockquote',
  'caption',
  'dd',
  'div',
  'dt',
  'figcaption',
  'figure',
  'footer',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'header',
  'li',
  'ol',
  'p',
  'section',
  'summary',
  'td',
  'th',
  'ul',
].join(', ');

const FIXED_LTR_SELECTOR = [
  'code',
  'kbd',
  'pre',
  'samp',
  '.skim-math',
  '.katex',
].join(', ');

// Code and rendered formulae are independent LTR runs, not evidence about the
// surrounding prose's language.
function proseText(node) {
  let text = '';
  for (const child of node.childNodes) {
    if (child.nodeType === 3) {
      text += child.data;
    } else if (
      child.nodeType === 1
      && !child.matches(FIXED_LTR_SELECTOR)
      && child.getAttribute('aria-hidden') !== 'true'
    ) {
      text += proseText(child);
    }
  }
  return text;
}

// Same length as textContent (in UTF-16 code units), but code/math is blanked
// so it cannot choose a prose sentence's direction. Keeping the length makes
// Intl.Segmenter's offsets map directly back onto DOM text nodes.
function directionalText(node) {
  let text = '';
  for (const child of node.childNodes) {
    if (child.nodeType === 3) {
      text += child.data;
    } else if (child.nodeType === 1) {
      if (child.matches(FIXED_LTR_SELECTOR) || child.getAttribute('aria-hidden') === 'true') {
        text += ' '.repeat(child.textContent.length);
      } else {
        text += directionalText(child);
      }
    }
  }
  return text;
}

// Strip only an unambiguous exercise/list label. Do not skip ordinary opening
// words such as "Note" or "DataFrame": those are actual paragraph content.
function withoutLeadingLabel(text) {
  return String(text).replace(
    /^\s*(?:(?:\(\s*(?:[a-z]|\d+|[ivxlcdm]+)\s*\))|(?:[a-z]|\d+|[ivxlcdm]+)[.)])\s*/i,
    ''
  );
}

// Return null for punctuation/numbers-only content so it inherits the nearest
// meaningful block direction. This mirrors the Unicode bidi first-strong rule
// after the leading-label accommodation above.
export function textDirection(text) {
  for (const char of withoutLeadingLabel(text)) {
    if (!LETTER.test(char)) continue;
    return RTL_LETTER.test(char) ? 'rtl' : 'ltr';
  }
  return null;
}

function sentenceParts(text) {
  if (globalThis.Intl?.Segmenter) {
    const segmenter = new Intl.Segmenter(undefined, { granularity: 'sentence' });
    return [...segmenter.segment(text)].map(({ segment, index }) => ({
      start: index,
      end: index + segment.length,
      direction: textDirection(segment),
    }));
  }

  // Old-browser fallback: retain trailing whitespace with each sentence so
  // extracting a segment from the DOM does not concatenate neighboring words.
  const parts = [];
  const re = /.*?(?:[.!?…]+(?=\s|$)\s*|$)/gs;
  let match;
  while ((match = re.exec(text)) && match[0]) {
    parts.push({
      start: match.index,
      end: match.index + match[0].length,
      direction: textDirection(match[0]),
    });
  }
  return parts;
}

function pointAtTextOffset(root, wanted) {
  const walker = root.ownerDocument.createTreeWalker(root, 4); // NodeFilter.SHOW_TEXT
  let seen = 0;
  let node;
  while ((node = walker.nextNode())) {
    const end = seen + node.data.length;
    if (wanted <= end) return { node, offset: wanted - seen };
    seen = end;
  }
  return { node: root, offset: root.childNodes.length };
}

// A long opposite-direction sentence cannot safely wrap inside its surrounding
// bidi paragraph: continuation lines and terminal punctuation follow the outer
// base direction. Group consecutive opposite-direction sentences into a
// semantic <bdi> block so each language gets its own base direction and line
// alignment. This is generic; "Gloss:" is not a special case.
function isolateSentenceDirectionChanges(block) {
  const baseDirection = block.getAttribute('dir');
  if (baseDirection !== 'rtl' && baseDirection !== 'ltr') return;

  const text = directionalText(block);
  const parts = sentenceParts(text);
  if (parts.length < 2) return;

  // Neutral sentences inherit the preceding direction (or the block base).
  let previous = baseDirection;
  parts.forEach((part) => {
    part.direction ||= previous;
    previous = part.direction;
  });

  const groups = [];
  for (const part of parts) {
    const last = groups.at(-1);
    if (last && last.direction === part.direction) last.end = part.end;
    else groups.push({ ...part });
  }

  const opposite = groups
    .filter((group) => group.direction !== baseDirection)
    .map((group) => ({
      ...group,
      startPoint: pointAtTextOffset(block, group.start),
      endPoint: pointAtTextOffset(block, group.end),
    }));

  // Work backwards so extracting a later range cannot invalidate earlier DOM
  // boundary points in a shared text node.
  opposite.reverse().forEach((group) => {
    const range = block.ownerDocument.createRange();
    range.setStart(group.startPoint.node, group.startPoint.offset);
    range.setEnd(group.endPoint.node, group.endPoint.offset);
    if (range.collapsed) return;

    const isolate = block.ownerDocument.createElement('bdi');
    isolate.className = 'skim-bidi-segment';
    isolate.setAttribute('dir', group.direction);
    isolate.append(range.extractContents());
    range.insertNode(isolate);
  });
}

export function applyBidi(article) {
  // The article supplies a sensible inherited direction for neutral-only
  // blocks. Its child blocks still choose independently, so bilingual
  // documents do not get forced into one global direction.
  const articleDirection = textDirection(proseText(article));
  if (articleDirection) article.setAttribute('dir', articleDirection);
  else article.removeAttribute('dir');

  article.querySelectorAll(BLOCK_SELECTOR).forEach((node) => {
    // Respect explicit direction supplied by trusted/sanitized Markdown HTML.
    if (node.hasAttribute('dir')) return;
    const direction = textDirection(proseText(node));
    if (direction) node.setAttribute('dir', direction);
  });

  // Inline `dir` establishes a bidi isolate in HTML, which prevents source code
  // and formula punctuation from reordering adjacent Hebrew/Arabic prose.
  article.querySelectorAll(FIXED_LTR_SELECTOR).forEach((node) => {
    if (!node.hasAttribute('dir')) node.setAttribute('dir', 'ltr');
  });

  // Leaf prose blocks can contain multiple actual-language paragraphs even
  // when Markdown put them in one <p> (for example, a Hebrew answer followed by
  // an English gloss). Give sustained sentence-level switches their own bidi
  // paragraph so wrapping stays readable.
  article.querySelectorAll('p, summary, dd, dt, figcaption, td, th').forEach((node) => {
    isolateSentenceDirectionChanges(node);
  });
}
