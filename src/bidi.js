// Standards-based bidirectional text setup.
//
// HTML's `dir` attribute is the semantic switch for the Unicode Bidirectional
// Algorithm. Its automatic base-direction rule (`dir="auto"`) uses the first
// strong character, which is wrong far too often for technical Hebrew/Arabic
// writing: "softmax לוקחת וקטור logits שרירותי ומחזירה התפלגות" is a Hebrew
// sentence that happens to open with an English term, and first-strong renders
// the whole thing left-aligned and LTR. So instead of the first strong
// character we take the first *sentence* and ask which language it is actually
// written in, counting strong words (see `dominantDirection`). Two further
// Markdown-specific accommodations: exercise/list labels such as "(a)" are
// metadata and must not decide direction, and code/formulae are blanked out
// before counting. The browser's bidi implementation still orders all mixed
// inline runs inside the resulting paragraph.

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

// Words, classified by their own first strong letter. Counting words rather
// than characters keeps the comparison fair: Hebrew spells the same content in
// far fewer letters than Latin script does.
// Hyphenated and apostrophised compounds count once: "self-attention" and
// "fine-tuning" are single terms, and splitting them would inflate the Latin
// side of every technical sentence.
const WORD = /\p{Letter}[\p{Letter}\p{Mark}]*(?:[-'’][\p{Letter}\p{Mark}]+)*/gu;

// An RTL sentence carrying untranslated Latin jargon ("softmax", "logits",
// "cross-entropy") is the common case in technical Hebrew/Arabic writing; a
// mostly-English sentence quoting a Hebrew term or two is much rarer. So RTL
// wins on a strong minority of the words, LTR needs a clear majority. The
// threshold is deliberately below half, and asymmetric for that reason.
const RTL_SHARE_THRESHOLD = 0.4;

// Which language a run of prose is actually written in, or null when it holds
// no strong characters at all (digits, punctuation) and should inherit.
export function dominantDirection(text) {
  let rtl = 0;
  let ltr = 0;
  for (const [word] of String(text).matchAll(WORD)) {
    if (RTL_LETTER.test(word[0])) rtl += 1;
    else ltr += 1;
  }
  if (!rtl && !ltr) return null;
  return rtl / (rtl + ltr) >= RTL_SHARE_THRESHOLD ? 'rtl' : 'ltr';
}

// Sentence spans, lazily — used to pick the opening sentence without segmenting
// a whole article. Newlines end a span too: block text concatenated from
// several elements has no sentence punctuation between the pieces.
function* sentenceSpans(text) {
  const re = /.*?(?:[.!?…]+(?=\s|$)\s*|\n+|$)/gs;
  let match;
  while ((match = re.exec(text)) && match[0]) {
    yield { start: match.index, end: match.index + match[0].length, text: match[0] };
  }
}

// How much text a decision needs. A paragraph very often opens with a bare term
// as its own sentence ("BatchNorm.", "RAG.", "NLL / Cross-Entropy.") before the
// prose starts; such an opener is a heading in disguise and must not decide the
// paragraph, so keep reading sentences until enough words have accumulated.
const MIN_DECIDING_WORDS = 4;

function countWords(text) {
  return [...String(text).matchAll(WORD)].length;
}

// Base direction of a block: the language of its opening prose. Once there is
// enough of it the rest gets no vote, so a Hebrew paragraph followed by a long
// English gloss stays RTL and the gloss gets its own bidi paragraph below.
// Returns null for punctuation/numbers-only content so it inherits the nearest
// meaningful block direction.
export function textDirection(text) {
  const stripped = withoutLeadingLabel(text);
  const whole = dominantDirection(stripped);
  if (whole === null) return null;

  let opening = '';
  for (const sentence of sentenceSpans(stripped)) {
    opening += sentence.text;
    if (countWords(opening) >= MIN_DECIDING_WORDS) break;
  }
  // Either signal is enough to earn RTL: an opening in Hebrew/Arabic (even when
  // a long English gloss follows and outweighs it), or a block that is Hebrew
  // overall (even when it opens on a file name, an acronym or a Latin term).
  // Only when both read as LTR is the block really written in a LTR language.
  return dominantDirection(opening) === 'rtl' || whole === 'rtl' ? 'rtl' : 'ltr';
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

// Balanced bracket groups, outermost first, as [start, end) spans covering the
// brackets themselves.
function bracketGroups(text) {
  const groups = [];
  for (const [open, close] of CLOSERS) {
    const stack = [];
    for (let i = 0; i < text.length; i++) {
      if (text[i] === open) stack.push(i);
      else if (text[i] === close && stack.length) {
        const start = stack.pop();
        if (!stack.length) groups.push({ start, end: i + 1 });
      }
    }
  }
  return groups;
}

// A parenthetical written in the other language — `knob (temperature,
// smoothing, שיעור dropout)` inside Hebrew prose — is a unit, and the bidi
// algorithm resolves its brackets and commas to the surrounding paragraph
// direction, which strands the closing bracket in the middle of the phrase.
// Give the whole group its own base direction instead. Judged by the same
// word-count rule as a block, so a Hebrew aside inside Hebrew prose (or the odd
// Latin term inside a Hebrew parenthetical) is left alone.
function oppositeDirectionBrackets(text, baseDirection) {
  const ranges = [];
  for (const { start, end } of bracketGroups(text)) {
    const inner = text.slice(start + 1, end - 1);
    if (!inner || inner.length > 200 || inner.includes('\n')) continue;
    if (!LETTER.test(inner)) continue;
    const direction = dominantDirection(inner);
    if (direction && direction !== baseDirection) ranges.push({ start, end, direction });
  }
  return ranges;
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

// Every span of a text node that needs its own base direction: the phrase-level
// LTR islands above (RTL context only) plus opposite-direction parentheticals
// (either context).
function isolationRanges(text, baseDirection) {
  const brackets = oppositeDirectionBrackets(text, baseDirection);
  const phrases = baseDirection === 'rtl'
    ? ltrIslandRanges(text).filter((r) => !overlapsAny(brackets, r.start, r.end))
    : [];
  return [...brackets, ...phrases].sort((a, b) => a.start - b.start);
}

// Wrap every such range in a <bdi> carrying its own direction.
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
    const baseDirection = effectiveDir(parent);
    if (baseDirection !== 'rtl' && baseDirection !== 'ltr') continue;
    const ranges = isolationRanges(textNode.data, baseDirection);
    if (!ranges.length) continue;

    const frag = doc.createDocumentFragment();
    let last = 0;
    for (const range of ranges) {
      if (range.start > last) frag.append(doc.createTextNode(textNode.data.slice(last, range.start)));
      const isolate = doc.createElement('bdi');
      isolate.className = 'skim-ltr-phrase';
      isolate.setAttribute('dir', range.direction || 'ltr');
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
  return [...sentenceSpans(text)].map(({ start, end, text: segment }) => ({
    start,
    end,
    direction: textDirection(segment),
  }));
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

  // Tables keep a LTR column order regardless of the prose around them: a
  // Markdown table's first column is written first in the source, and readers
  // expect column 1 on the left and a 1..5 row to read left-to-right even in a
  // Hebrew document. Cell *contents* still pick their own direction below.
  article.querySelectorAll('table').forEach((node) => {
    if (!node.hasAttribute('dir')) node.setAttribute('dir', 'ltr');
  });

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
