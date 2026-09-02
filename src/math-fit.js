// Fit display math to the reading column.
//
// A formula that does not fit used to sit in a horizontally scrolling box,
// which hides half the equation. Reflowing it is better, but only if it breaks
// where a typesetter would break it — never inside a fraction, a radical, or a
// parenthesised group.
//
// KaTeX already splits a display formula into top-level `.base` spans, and the
// browser treats each of those as an atomic box, so `white-space: normal` alone
// makes every boundary a break opportunity. That is too permissive: KaTeX also
// splits at the `-` inside `(1-\beta_1)`, and breaking there looks broken. So
// instead of accepting all of its boundaries we classify them and hand the
// browser only the ones worth using, wrapping everything else in nowrap groups:
//
//   tier 1  after a top-level comma             `m_t = …, \quad v_t = …`
//   tier 2  before a relation at paren depth 0  `A = B`, `A \implies B`
//   tier 3  before a binary operator at depth 0 `A + B`, `A - B`
//
// Fitting escalates one tier at a time and stops as soon as the formula fits,
// so a list of equations breaks between them rather than inside one, and a
// relation is preferred to a `+`. Breaks land *before* the connector, the way
// a continued equation is set on paper: the next line opens with `=` or `+`,
// never leaving `\hat m_t =` dangling at the end of a line.
// Only when even tier 3 leaves a line too wide does the formula get scaled
// down, and only when scaling hits its floor does the scrollbar come back.
// A formula that overflows just slightly skips reflowing altogether and is
// scaled instead: wrapping something that nearly fits yields a lone symbol on
// a second line.
//
// Everything is measurement-driven: nothing is touched unless it overflows at
// the current window size, and every pass re-measures from the unmodified
// formula, so widening the window undoes a shrink.

// Overflow up to this much is fixed by shrinking alone.
const SHRINK_ONLY_RATIO = 1.2;

// Never scale a formula below this fraction of its normal size.
const MIN_SCALE = 0.62;

// Sub-pixel slack: layout widths are fractional, and a hairline "overflow" is
// not worth reformatting an equation over.
const SLACK = 2;

const COMMA_TIER = 1;
const RELATION_TIER = 2;
const OPERATOR_TIER = 3;
const NO_BREAK = Infinity;

const GROUP_CLASS = 'skim-math-group';

// --- classifying KaTeX's own boundaries ---------------------------------

function meaningfulChildren(base) {
  // Struts carry line metrics and spacing spans carry none of the maths; both
  // would otherwise hide the atom a boundary should be judged by.
  return [...base.children].filter((c) => !c.classList.contains('strut') && !c.classList.contains('mspace'));
}

function depthDelta(children) {
  let delta = 0;
  for (const child of children) {
    if (child.classList.contains('mopen')) delta += 1;
    else if (child.classList.contains('mclose')) delta -= 1;
  }
  return delta;
}

function connectorTier(atom) {
  if (!atom) return NO_BREAK;
  if (atom.classList.contains('mrel')) return RELATION_TIER;
  if (atom.classList.contains('mbin')) return OPERATOR_TIER;
  return NO_BREAK;
}

// KaTeX ends a base *with* the relation or operator that follows it, so a break
// at that boundary would leave `\hat m_t =` hanging at the end of a line. Move
// such a trailing connector (with its spacing) to the head of the next base, so
// the break instead opens the continuation line with it. `\left(…\right)`
// groups are a single `.minner`, so nothing nested is ever moved.
function moveConnectorsToNextBase(bases) {
  for (let i = 0; i < bases.length - 1; i++) {
    const children = [...bases[i].children];
    const atom = children.filter((c) => !c.classList.contains('strut') && !c.classList.contains('mspace')).at(-1);
    if (connectorTier(atom) === NO_BREAK) continue;
    // The connector plus whatever spacing KaTeX put around it.
    let from = children.indexOf(atom);
    while (from > 0 && children[from - 1].classList.contains('mspace')) from -= 1;
    const moving = children.slice(from);
    const next = bases[i + 1];
    const anchor = next.querySelector(':scope > .strut');
    if (anchor) anchor.after(...moving);
    else next.prepend(...moving);
  }
}

// --- comma break points --------------------------------------------------
// KaTeX never breaks at punctuation, so a comma-separated list of equations
// lives inside one base. Split such a base after each of its own top-level
// commas; commas nested in a fraction, a matrix or a subscript are not direct
// children and are never seen here.

// `startDepth` is the paren depth this base begins at: KaTeX splits `(1-x)`
// across bases, so a base can legitimately open below zero and its commas are
// only top-level once the running depth is counted from the formula's start.
function splitBaseAtCommas(base, startDepth) {
  const chunks = [[]];
  let depth = startDepth;
  for (const child of [...base.childNodes]) {
    if (child.nodeType === 1) {
      if (child.classList.contains('mopen')) depth += 1;
      else if (child.classList.contains('mclose')) depth -= 1;
    }
    chunks.at(-1).push(child);
    const isComma = child.nodeType === 1
      && child.classList.contains('mpunct')
      && child.textContent.trim() === ','
      && depth === 0;
    if (isComma) chunks.push([]);
  }
  // Spacing that follows a comma (`\quad`) belongs to the line it ends.
  for (let i = 1; i < chunks.length; i++) {
    while (chunks[i][0] && chunks[i][0].nodeType === 1 && chunks[i][0].classList.contains('mspace')) {
      chunks[i - 1].push(chunks[i].shift());
    }
  }
  const parts = chunks.filter((chunk) => chunk.length);
  if (parts.length < 2) return null;

  const strut = base.querySelector(':scope > .strut');
  const pieces = parts.map((chunk) => {
    const piece = base.cloneNode(false);
    if (strut && !chunk.includes(strut)) piece.append(strut.cloneNode(true));
    piece.append(...chunk);
    return piece;
  });
  base.replaceWith(...pieces);
  return pieces;
}

const bases = (html) => [...html.children].filter((child) => child.classList.contains('base'));

// Every base of the formula, with the tier of the break opportunity *before*
// it. Both rewrites (comma splitting and connector moving) happen once, up
// front and only for formulae that need reflowing; whether the resulting
// boundaries are offered to the browser is decided per tier by `applyTier`.
function analyze(node) {
  const html = node.querySelector('.katex-html');
  if (!html) return [];

  if (node.dataset.skimMathBreaks !== '1') {
    node.dataset.skimMathBreaks = '1';
    let depth = 0;
    for (const base of bases(html)) {
      const delta = depthDelta(meaningfulChildren(base));
      const pieces = splitBaseAtCommas(base, depth);
      // The boundary after each piece but the last is a comma boundary, which
      // is recorded on the piece that follows it.
      if (pieces) pieces.slice(1).forEach((piece) => { piece.dataset.skimMathBreak = String(COMMA_TIER); });
      depth += delta;
    }
    moveConnectorsToNextBase(bases(html));
  }

  let depth = 0;
  return bases(html).map((base, i) => {
    const before = depth;
    depth += depthDelta(meaningfulChildren(base));
    const tier = base.dataset.skimMathBreak
      ? Number(base.dataset.skimMathBreak)
      : connectorTier(meaningfulChildren(base)[0]);
    return { base, tier: i === 0 ? NO_BREAK : tier, depth: before };
  });
}

// --- grouping ------------------------------------------------------------

function ungroup(node) {
  node.querySelectorAll(`.${GROUP_CLASS}`).forEach((group) => group.replaceWith(...group.childNodes));
}

// Offer the browser only the boundaries at or below `maxTier` (and only at
// paren depth 0) by fencing every other run of bases inside a nowrap group.
function applyTier(node, parts, maxTier) {
  ungroup(node);
  const html = node.querySelector('.katex-html');
  if (!html) return;

  const runs = [];
  for (const part of parts) {
    // A break is offered only at a boundary of an allowed tier that sits
    // outside every parenthesised group.
    if (!runs.length || (part.tier <= maxTier && part.depth === 0)) runs.push([]);
    runs.at(-1).push(part.base);
  }

  for (const run of runs) {
    if (run.length < 2) continue;   // a lone base is already atomic
    const group = html.ownerDocument.createElement('span');
    group.className = GROUP_CLASS;
    run[0].before(group);
    group.append(...run);
  }
}

// --- fitting -------------------------------------------------------------

// Width of the widest laid-out line, measured from the boxes themselves.
// `scrollWidth` cannot be used here: KaTeX centres display math, so content
// that does not fit spills out of *both* sides of the box while scrollWidth
// sees only the right-hand spill.
// Bases are laid out in document order, so a line ends exactly where the next
// base steps back to the left. Grouping by `top` would not work: a base holding
// a tall fraction starts higher than its neighbours on the very same line.
function contentWidth(node) {
  let widest = 0;
  let line = null;
  let previousLeft = -Infinity;
  for (const base of node.querySelectorAll('.base')) {
    const rect = base.getBoundingClientRect();
    if (!rect.width) continue;
    // Compare against the previous base, not the line's own left edge: lines
    // are centred, so a new line can start well to the right of where the
    // previous one began.
    if (line && rect.left >= previousLeft - 1) {
      line.left = Math.min(line.left, rect.left);
      line.right = Math.max(line.right, rect.right);
    } else {
      line = { left: rect.left, right: rect.right };
    }
    previousLeft = rect.left;
    widest = Math.max(widest, line.right - line.left);
  }
  return widest;
}

function overflow(node) {
  return contentWidth(node) - node.clientWidth;
}

function scaleToFit(node) {
  const available = node.clientWidth;
  const needed = contentWidth(node);
  if (!available || !needed) return 1;
  return Math.max(MIN_SCALE, Math.min(1, (available - SLACK) / needed));
}

function shrink(node) {
  node.style.setProperty('--skim-math-scale', String(scaleToFit(node)));
  node.classList.add('skim-math-scaled');
}

function reset(node) {
  ungroup(node);
  node.classList.remove('skim-math-wrapped', 'skim-math-scaled');
  node.style.removeProperty('--skim-math-scale');
}

function fitOne(node) {
  reset(node);
  // An error fallback, a hidden block, or a not-yet-laid-out node has nothing
  // to measure.
  if (!node.clientWidth || !node.querySelector('.katex-display')) return;
  const natural = contentWidth(node);
  if (natural - node.clientWidth <= SLACK) return;

  if (natural / node.clientWidth <= SHRINK_ONLY_RATIO) {
    shrink(node);
    return;
  }

  const parts = analyze(node);
  if (parts.length > 1) {
    node.classList.add('skim-math-wrapped');
    for (const tier of [COMMA_TIER, RELATION_TIER, OPERATOR_TIER]) {
      applyTier(node, parts, tier);
      if (overflow(node) <= SLACK) return;
    }
  }

  // Some line still has no usable break point in it — a wide matrix, say.
  // Scale down as far as allowed; beyond that the scrolling box remains.
  shrink(node);
}

// Fit every display formula in `article`.
export function fitDisplayMath(article) {
  article.querySelectorAll('.skim-math-display').forEach(fitOne);
}

// KaTeX's own fonts arrive asynchronously, and a formula measured in a fallback
// font is far wider than the one the reader ends up seeing — enough to reflow
// and shrink a formula that always fit. Measure again once the real fonts are
// in, which is a no-op for anything already correct.
function refitWhenFontsLoad(article) {
  document.fonts?.ready?.then(() => {
    if (article.isConnected) fitDisplayMath(article);
  }).catch(() => {});
}

// Re-fit on column-width changes (window resize, TOC mount/unmount, zoom).
// Returns a teardown, mirroring enhanceTables' listener contract.
export function watchDisplayMath(article) {
  const controller = new AbortController();
  let frame = 0;
  const schedule = () => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => fitDisplayMath(article));
  };
  refitWhenFontsLoad(article);
  window.addEventListener('resize', schedule, { passive: true, signal: controller.signal });
  return () => {
    cancelAnimationFrame(frame);
    controller.abort();
  };
}
