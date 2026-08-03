// The clipboard page: an extension page that renders copied markdown with the
// exact same pipeline, theme and toolbar a real .md file gets.
//
// It does that by staging the text the way Chrome's own plaintext view does (a
// lone <pre> in the body) and then loading the content bundle with the force
// flag, so there is no second renderer to keep in sync with the first.
//
// Reloading the tab re-reads the clipboard, so this URL behaves like a live
// window onto whatever you last copied: copy, hit refresh, read. It never polls
// anything; auto-reload is for real files on disk.
//
// Plain script on purpose: no imports, nothing to bundle.

// The popup hands its clipboard read over through session storage, because the
// popup has the focus and user gesture Chrome wants and this page may not.
// The key is one-shot, so a refresh always falls through to a live read.
const HANDOFF_KEY = decodeURIComponent(location.hash.slice(1));

// Match the reader's theme before anything paints, or the empty state flashes
// dark on a light setup. render() re-applies the same attributes right after.
async function applyStoredTheme() {
  try {
    const { theme, scheme } = await chrome.storage.sync.get(['theme', 'scheme']);
    document.documentElement.setAttribute('data-theme', theme === 'light' ? 'light' : 'dark');
    if (scheme) document.documentElement.setAttribute('data-scheme', scheme);
  } catch { /* the defaults in the markup are fine */ }
}

function boot(text) {
  const pre = document.createElement('pre');
  pre.textContent = text;
  document.body.replaceChildren(pre); // the shape detect.js looks for
  window.__skimForce = true;
  const script = document.createElement('script');
  script.src = chrome.runtime.getURL('dist/content.bundle.js');
  document.head.append(script); // the body has to stay "just the <pre>"
}

function showPasteBox() {
  const box = document.createElement('div');
  box.className = 'skim-paste';
  box.innerHTML = `
    <h1>Nothing to render yet</h1>
    <p>Your clipboard is empty, or Chrome would not hand it over.</p>
    <p>Press <kbd>Ctrl</kbd><kbd>V</kbd> (<kbd>⌘</kbd><kbd>V</kbd> on a Mac) to paste markdown here,
       or copy something and reload this tab.</p>
  `;
  document.body.replaceChildren(box);
  document.addEventListener('paste', (e) => {
    const text = e.clipboardData?.getData('text/plain');
    if (text && text.trim()) { e.preventDefault(); boot(text); }
  });
}

async function fromHandoff() {
  if (!HANDOFF_KEY) return null;
  try {
    const got = await chrome.storage.session.get(HANDOFF_KEY);
    // Consume it: the next load of this tab reads the clipboard itself.
    chrome.storage.session.remove(HANDOFF_KEY).catch(() => {});
    const text = got?.[HANDOFF_KEY];
    return typeof text === 'string' && text.trim() ? text : null;
  } catch {
    return null;
  }
}

async function fromClipboard() {
  try {
    const text = await navigator.clipboard.readText();
    return text && text.trim() ? text : null;
  } catch {
    return null;
  }
}

(async () => {
  await applyStoredTheme();
  const text = (await fromHandoff()) ?? (await fromClipboard());
  if (text) boot(text);
  else showPasteBox();
})();
