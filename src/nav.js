import { isInlineElement } from './normalize.js';
import { createSmoothScroller } from './smooth-scroll.js';

// Vim-style j/k scrolling plus Tab / Shift+Tab navigation through markdown
// blocks ("lines"), with smooth scrolling and a current-block indicator. Works
// from anywhere on the page and resyncs to wherever you've scrolled or clicked.

// Flatten the article into navigable blocks. Lists expand to their items so
// stepping feels line-by-line; everything else is a top-level block.
export function getBlocks(article) {
  const blocks = [];
  for (const child of article.children) {
    const tag = child.tagName;
    // Inline leftovers (a stray $R^2$ span orphaned by a display-math div) are
    // part of a line, not a line. normalize.js re-wraps them into paragraphs;
    // this keeps the cursor off anything that slips through.
    if (isInlineElement(child)) {
      // skip
    } else if (tag === 'UL' || tag === 'OL') {
      child.querySelectorAll(':scope > li').forEach((li) => blocks.push(li));
    } else if (tag === 'SCRIPT' || tag === 'STYLE') {
      // skip
    } else {
      // Tables (wrapped in .skim-table-wrap) step row by row, not as one block.
      const table = tag === 'TABLE' ? child : child.querySelector(':scope > table');
      if (table) {
        table.querySelectorAll('tr').forEach((tr) => blocks.push(tr));
      } else {
        blocks.push(child);
      }
    }
  }
  // Skip empty/whitespace-only blocks (blank lines); keep dividers and media.
  return blocks.filter((b) => (
    b.tagName === 'HR' ||
    b.textContent.trim().length > 0 ||
    b.querySelector('img, video, iframe, .skim-math')
  ));
}

function isInteractiveTarget(target) {
  return target?.nodeType === 1 && !!target.closest([
    'a[href]',
    'button',
    'input',
    'select',
    'summary',
    'textarea',
    '[contenteditable]:not([contenteditable="false"])',
    '[role="button"]',
    '[role="dialog"]',
    '[role="textbox"]',
  ].join(', '));
}

// One Vim j/k step corresponds to one rendered prose line. CSS may expose
// line-height as pixels, a unitless multiplier, or "normal".
function scrollLineHeight(article) {
  const style = window.getComputedStyle(article);
  const fontSize = Number.parseFloat(style.fontSize) || 16.5;
  const raw = Number.parseFloat(style.lineHeight);
  if (!Number.isFinite(raw)) return Math.round(fontSize * 1.72);
  return Math.round(raw <= 4 ? raw * fontSize : raw);
}

// Sets up Tab/Shift+Tab block navigation for `article` and registers exactly
// one document-level keydown listener (never re-registered). Auto-reload
// replaces article.innerHTML wholesale, which detaches every block we bound
// listeners to and snapshotted — call the returned `refresh()` afterwards to
// re-snapshot blocks and rebind them without stacking another keydown
// listener.
export function setupBlockNavigation(article, { scroller = createSmoothScroller() } = {}) {
  let blocks = [];
  let current = -1;
  let pendingG = false;   // a lone g waiting to become gg
  let gTimer = null;

  // Eased scrolling, unless the reader asked the system for less motion, in
  // which case every jump is instant.
  const reduceMotion = () => !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const maxScroll = () => Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
  const scrollBy = (delta) => {
    if (reduceMotion()) window.scrollBy({ top: delta, left: 0, behavior: 'auto' });
    else scroller.by(delta);
  };
  const scrollTo = (y) => {
    if (reduceMotion()) window.scrollTo({ top: y, left: 0, behavior: 'auto' });
    else scroller.to(y);
  };

  // Index of the topmost block still within the viewport (resync anchor).
  const topmost = () => {
    for (let i = 0; i < blocks.length; i++) {
      if (blocks[i].getBoundingClientRect().bottom > 90) return i;
    }
    return blocks.length - 1;
  };
  const inView = (el) => {
    const r = el.getBoundingClientRect();
    return r.bottom > window.innerHeight * 0.1 && r.top < window.innerHeight * 0.9;
  };

  function setCurrent(i, scroll = true) {
    if (!blocks.length) return;
    i = Math.max(0, Math.min(blocks.length - 1, i));
    if (current >= 0 && blocks[current]) blocks[current].classList.remove('skim-current');
    current = i;
    const el = blocks[current];
    el.classList.add('skim-current');
    try { el.focus({ preventScroll: true }); } catch { /* ignore */ }
    if (scroll) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  // (Re)snapshot the blocks and bind their per-node listeners. Nodes are
  // brand new after an innerHTML replacement, so there's no risk of
  // double-binding a listener onto an already-bound node.
  function bindBlocks() {
    blocks = getBlocks(article);
    current = -1;
    blocks.forEach((b, i) => {
      b.classList.add('skim-block');
      b.tabIndex = -1;
      // Clicking into the doc sets the cursor there, so Tab continues from it.
      b.addEventListener('mousedown', () => setCurrent(i, false));
    });
  }

  bindBlocks();

  document.addEventListener('keydown', (e) => {
    // A vim key only counts when nothing else is claiming the keystroke.
    const vimKey = !e.defaultPrevented
      && !e.altKey
      && !e.ctrlKey
      && !e.metaKey
      && !e.isComposing
      && !isInteractiveTarget(e.target)
      && !document.documentElement.classList.contains('skim-lightbox-open');

    if (vimKey && !e.shiftKey && (e.key === 'j' || e.key === 'k')) {
      e.preventDefault();
      pendingG = false;
      scrollBy((e.key === 'j' ? 1 : -1) * scrollLineHeight(article));
      return;
    }

    // G to the end, gg to the start, the way vim and less do it.
    if (vimKey && (e.key === 'g' || e.key === 'G')) {
      e.preventDefault();
      const toTop = e.key === 'g' && pendingG;
      clearTimeout(gTimer);
      pendingG = e.key === 'g' && !pendingG;
      if (pendingG) {
        // Wait for the second g, but not forever.
        gTimer = setTimeout(() => { pendingG = false; }, 900);
      } else {
        scrollTo(toTop ? 0 : maxScroll());
      }
      return;
    }

    // Escape backs out: a half-typed g, and the Tab cursor with it.
    if (vimKey && e.key === 'Escape') {
      pendingG = false;
      clearTimeout(gTimer);
      if (current >= 0 && blocks[current]) blocks[current].classList.remove('skim-current');
      current = -1;
      return;
    }

    if (e.key !== 'Tab' || e.altKey || e.ctrlKey || e.metaKey) return;
    // Let the toolbar handle its own focus traversal.
    if (e.target && e.target.closest && e.target.closest('.skim-toolbar')) return;
    if (!blocks.length) return;
    e.preventDefault();
    const dir = e.shiftKey ? -1 : 1;
    if (current === -1) { setCurrent(topmost()); return; }
    const base = inView(blocks[current]) ? current : topmost();
    setCurrent(base + dir);
  });

  return { refresh: bindBlocks };
}
