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

// Strong bidi class of a single character, for neighbors-of-a-symbol checks.
export function strongDirOfChar(char) {
  if (RTL_LETTER.test(char)) return 'rtl';
  if (LETTER.test(char)) return 'ltr';
  return null;
}

// Nearest explicitly-set direction an element lives under (applyBidi has put
// `dir` on every prose block, so after it runs this is the effective base
// direction of any text position).
export function effectiveDir(element) {
  for (let p = element; p; p = p.parentElement) {
    const d = p.getAttribute('dir');
    if (d === 'rtl' || d === 'ltr') return d;
  }
  return null;
}

// --- Phrase-level LTR islands in RTL prose ------------------------------
// The Unicode bidi algorithm resolves punctuation between an LTR word and RTL
// text to the paragraph direction, which visually tears mixed phrases apart:
// `"Closed?"` renders as `"?Closed"`, `2024-B Q3` as `B Q3-2024`, `C++` as
// `++C`. Detect such phrases and give each one its own <bdi dir="ltr"> so the
// phrase keeps its internal order while still flowing as a unit in the RTL
// sentence. Deliberately conservative: a lone Latin word, trailing sentence
// punctuation, and Hebrew gershayim acronyms (צה"ל) are left to the browser,
// which already handles them correctly.

// A quoted phrase whose content is purely LTR owns its quotes and internal
// punctuation (`"SET bounded?"` is a label, `?` included).
const QUOTE_PAIRS = [['"', '"'], ['“', '”']];

// Latin/digit tokens joined by short neutral separators (`2024-B Q3`,
// `kernel(x)`, `GPT-4`), plus `C++` / `C#` style suffixes.
const TOKEN_RUN = /[A-Za-z0-9À-ɏ]+(?:[  .,:;/\-+&'’"!?*=%#_@()[\]]{1,3}[A-Za-z0-9À-ɏ]+)*(?:\+\+|#)?/g;

const CLOSERS = [['(', ')'], ['[', ']']];

function overlapsAny(ranges, start, end) {
  return ranges.some((r) => start < r.end && end > r.start);
}

// All [start, end) spans of `text` that should render as isolated LTR phrases.
export function ltrIslandRanges(text) {
  const ranges = [];

  for (const [open, close] of QUOTE_PAIRS) {
    let i = 0;
    while ((i = text.indexOf(open, i)) !== -1) {
      const j = text.indexOf(close, i + 1);
      if (j === -1) break;
      const inner = text.slice(i + 1, j);
      if (inner.length <= 120 && !inner.includes('\n') && /[A-Za-z]/.test(inner) && !RTL_LETTER.test(inner)) {
        ranges.push({ start: i, end: j + 1 });
        i = j + 1;
      } else {
        // Not a pure-LTR quote (gershayim, Hebrew quote, …): retry from the
        // next character so a later real pair can still match.
        i += 1;
      }
    }
  }

  TOKEN_RUN.lastIndex = 0;
  let m;
  while ((m = TOKEN_RUN.exec(text))) {
    const start = m.index;
    let end = start + m[0].length;
    // Absorb a trailing closer whose opener sits inside the run, so
    // `kernel(x)` keeps its closing paren.
    for (const [open, close] of CLOSERS) {
      const body = text.slice(start, end);
      const unbalanced = (body.split(open).length - 1) - (body.split(close).length - 1);
      if (unbalanced > 0 && text[end] === close) end += 1;
    }
    const body = text.slice(start, end);
    // Only isolate when the browser would actually misorder it: digits mixed
    // with letters, ++/# suffixes, or bracket pairs. Anything else (a lone
    // word, letters joined by `.`/`/`) already renders correctly.
    const risky = /[0-9]/.test(body) || /(?:\+\+|#)$/.test(body) || /[()[\]]/.test(body);
    if (!/[A-Za-z]/.test(body) || !risky) continue;
    if (overlapsAny(ranges, start, end)) continue;
    ranges.push({ start, end });
  }

  return ranges.sort((a, b) => a.start - b.start);
}

// Wrap every LTR-phrase range found in RTL-context text nodes in <bdi>.
function isolateLtrPhrases(article) {
  const doc = article.ownerDocument;
  const walker = doc.createTreeWalker(article, 4); // NodeFilter.SHOW_TEXT
  const nodes = [];
  let node;
  while ((node = walker.nextNode())) nodes.push(node);

  for (const textNode of nodes) {
    const parent = textNode.parentElement;
    if (!parent) continue;
    if (parent.closest(FIXED_LTR_SELECTOR)) continue;
    if (effectiveDir(parent) !== 'rtl') continue;
    const ranges = ltrIslandRanges(textNode.data);
    if (!ranges.length) continue;

    const frag = doc.createDocumentFragment();
    let last = 0;
    for (const range of ranges) {
      if (range.start > last) frag.append(doc.createTextNode(textNode.data.slice(last, range.start)));
      const isolate = doc.createElement('bdi');
      isolate.className = 'skim-ltr-phrase';
      isolate.setAttribute('dir', 'ltr');
      isolate.textContent = textNode.data.slice(range.start, range.end);
      frag.append(isolate);
      last = range.end;
    }
    if (last < textNode.data.length) frag.append(doc.createTextNode(textNode.data.slice(last)));
    textNode.parentNode.replaceChild(frag, textNode);
  }
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

  // Finally, isolate mixed LTR phrases (quoted English labels, letter-digit
  // runs) inside RTL prose so their internal punctuation cannot reorder.
  isolateLtrPhrases(article);
}
