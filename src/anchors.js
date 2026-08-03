// In-document anchors and internal links.
//   - Define a target anywhere with `{#my-id}` (becomes an invisible anchor).
//   - Headings take a trailing `{#my-id}` as their id (handled in ui.js).
//   - Jump to one with a normal Markdown link: `[label](#my-id)`.
// Internal links get smooth scrolling and a distinct underline (see skim.css).
import { replaceInTextNodes } from './glyphs.js';

const ANCHOR_RE = /\{#([A-Za-z0-9_-]+)\}/g;

// Turn `{#id}` tokens in body text into empty <a id="id"> anchor targets.
export function createAnchorMarkup(root) {
  replaceInTextNodes(root, ANCHOR_RE, (match) => {
    const a = document.createElement('a');
    a.className = 'skim-anchor';
    a.id = match.slice(2, -1);          // strip "{#" and "}"
    a.setAttribute('aria-hidden', 'true');
    return a;
  });
}

// Smooth-scroll to whatever the current #hash points at (or back to the top
// when the hash is empty). Shared by internal-link clicks and Back/Forward.
export function scrollToHash() {
  const id = decodeURIComponent(location.hash.slice(1));
  if (!id) { window.scrollTo({ top: 0, behavior: 'smooth' }); return; }
  const target = document.getElementById(id);
  if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// Smooth-scroll clicks on in-page links (href="#id") and push a history entry
// so the browser Back/Forward buttons retrace the jumps (scrolling back to
// where you were). A `popstate` listener re-scrolls whenever the user walks
// the history.
//
// Auto-reload calls setupAnchors again on the same `article` node each time
// the file changes on disk (Task 8); since the article element itself is
// reused (only its innerHTML is replaced), a plain addEventListener here
// would stack a new click/popstate listener per pass. Tie both to an
// AbortController whose abort function is exposed as
// `article.skimAnchorsTeardown` (mirroring `toc.skimTeardown` in ui.js); the
// caller (main.js) tears down the previous pass before invoking this again.
export function enableInternalLinks(article) {
  const controller = new AbortController();
  article.skimAnchorsTeardown = () => controller.abort();
  article.addEventListener('click', (e) => {
    const a = e.target.closest && e.target.closest('a[href^="#"]');
    if (!a || !article.contains(a)) return;
    const id = decodeURIComponent(a.getAttribute('href').slice(1));
    const target = id && document.getElementById(id);
    if (!target) return;
    e.preventDefault();
    target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    // Push (not replace) so each jump becomes its own Back/Forward step. Guard
    // against pushing a duplicate entry when the hash is already this target.
    try {
      if (location.hash.slice(1) !== id) history.pushState(null, '', `#${id}`);
    } catch { /* ignore */ }
  }, { signal: controller.signal });

  // Back/Forward through the jump history: scroll to wherever the hash now
  // points. Bound to window (hash changes are document-global), torn down with
  // the same controller so auto-reload never stacks duplicates.
  window.addEventListener('popstate', scrollToHash, { signal: controller.signal });
}

export function setupAnchors(article) {
  createAnchorMarkup(article);
  enableInternalLinks(article);
}
