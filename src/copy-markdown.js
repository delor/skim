// Copy-as-Markdown: when the user copies a selection from the rendered article,
// put the equivalent Markdown source on the clipboard instead of the rendered
// text. Math comes back as $latex$ (from the stored source), emoji as their
// character, prettified symbols (⇒ etc.) as their original character.
import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';
import { b64decode } from './render.js';

let service = null;

function getService() {
  if (service) return service;
  service = new TurndownService({
    headingStyle: 'atx',
    bulletListMarker: '-',
    codeBlockStyle: 'fenced',
    fence: '```',
    emDelimiter: '*',
    strongDelimiter: '**',
    linkStyle: 'inlined',
  });
  service.use(gfm);

  // Strip UI-only bits that may fall inside a selection.
  service.remove((node) => node.classList && (
    node.classList.contains('skim-table-copy') ||
    node.classList.contains('skim-sort-ind') ||
    node.classList.contains('skim-copy-btn')
  ));

  // Rendered math -> $latex$ / $$latex$$ from the stored source.
  service.addRule('skim-math', {
    filter: (node) => node.classList && node.classList.contains('skim-math'),
    replacement: (content, node) => {
      let src = '';
      try { src = b64decode(node.getAttribute('data-latex') || ''); } catch { src = ''; }
      if (!src) return content;
      return node.classList.contains('skim-math-display') ? `\n\n$$\n${src}\n$$\n\n` : `$${src}$`;
    },
  });

  // Prettified symbols (⇒, ≤, …) -> their original character.
  service.addRule('skim-sym', {
    filter: (node) => node.classList && node.classList.contains('skim-sym'),
    replacement: (content, node) => node.getAttribute('data-sym') || content,
  });

  // Emoji rendered as <img class="skim-emoji" alt="..."> -> the emoji
  // character from its alt text. Skim renders emoji natively (no image-based
  // emoji font), so this is defensive/legacy handling in case any img with
  // this class and an alt character ever reaches the selection.
  service.addRule('skim-emoji', {
    filter: (node) => node.nodeName === 'IMG' && node.classList && node.classList.contains('skim-emoji'),
    replacement: (_content, node) => node.getAttribute('alt') || '',
  });

  return service;
}

// Convert a rendered-HTML fragment to Markdown.
export function htmlToMarkdown(html) {
  return getService().turndown(html).trim();
}

// Intercept copy within `article` and replace the clipboard text with Markdown.
export function setupMarkdownCopy(article, getSource) {
  document.addEventListener('copy', (e) => {
    const sel = window.getSelection && window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return;

    // Select-all (browser Ctrl+A anchors at <body>; ours selects the article
    // node): the whole document is selected, so the faithful clipboard payload
    // is the raw markdown source, never the toolbar/TOC chrome around it.
    // Boundary-point comparison, not containsNode: Chrome reports a range that
    // sits exactly on the node's own boundaries as "not fully containing" it.
    let coversArticle = false;
    try {
      const contents = document.createRange();
      contents.selectNodeContents(article);
      for (let i = 0; i < sel.rangeCount; i++) {
        const r = sel.getRangeAt(i);
        if (r.compareBoundaryPoints(Range.START_TO_START, contents) <= 0
          && r.compareBoundaryPoints(Range.END_TO_END, contents) >= 0) {
          coversArticle = true;
          break;
        }
      }
    } catch { /* detached/foreign nodes */ }
    if (coversArticle && e.clipboardData) {
      const source = typeof getSource === 'function' ? getSource() : null;
      e.clipboardData.setData('text/plain', source ?? htmlToMarkdown(article.innerHTML));
      e.preventDefault();
      return;
    }

    // Only handle selections that live inside the rendered article.
    if (!article.contains(sel.anchorNode) && !article.contains(sel.focusNode)) return;

    const container = document.createElement('div');
    for (let i = 0; i < sel.rangeCount; i++) {
      container.appendChild(sel.getRangeAt(i).cloneContents());
    }
    const md = htmlToMarkdown(container.innerHTML);
    if (!md || !e.clipboardData) return;
    e.clipboardData.setData('text/plain', md);
    e.preventDefault();
  });

  // Ctrl/Cmd+A selects the document, not the viewer chrome: the rendered
  // article (or the raw-source view when it is the one showing). Inputs and
  // editable fields keep their native select-all.
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'a' || !(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return;
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    // The raw view hides via CSS, not the hidden attribute — ask the style.
    const raw = document.querySelector('.skim-raw');
    const rawVisible = raw && getComputedStyle(raw).display !== 'none';
    const target = rawVisible ? raw : article;
    const sel = window.getSelection && window.getSelection();
    if (!sel) return;
    const range = document.createRange();
    range.selectNode(target);
    sel.removeAllRanges();
    sel.addRange(range);
    e.preventDefault();
  });
}
