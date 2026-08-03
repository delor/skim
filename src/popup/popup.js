import { getSettings, setSetting } from '../settings.js';
import { isFileAccessAllowed } from '../file-access-check.js';
import { openClipboardViewer } from '../clipboard/open-clipboard.js';

const $ = (id) => document.getElementById(id);

// Bind one control, tolerating its absence: the popup and the options page share
// this script but are separate markup files, so one can lack a control the other
// has. Without this a single missing id threw and left *every* control unbound.
function bind(id, value, event, handler) {
  const node = $(id);
  if (!node) return;
  if (node.type === 'checkbox') node.checked = value;
  else node.value = String(value);
  node.addEventListener(event, handler);
}

async function init() {
  // Show the controls right away: the file-access check can end up reading a
  // file:// URL to be sure of its answer, and the popup must not wait on that.
  $('controls').hidden = false;
  try {
    const [settings, allowed, [tab]] = await Promise.all([
      getSettings(),
      isFileAccessAllowed(),
      chrome.tabs.query({ active: true, currentWindow: true }),
    ]);

    if (!allowed) {
      $('file-cta').hidden = false;
      if (tab?.url?.startsWith('file:') && /\.(md|markdown|mdown|mkd|mkdn|mdx)([?#].*)?$/i.test(tab.url)) {
        $('file-cta-msg').innerHTML = 'This tab <em>is</em> a markdown file. Flip one switch and Skim will render it beautifully:';
      }
      $('open-settings').addEventListener('click', () => {
        chrome.tabs.create({ url: `chrome://extensions/?id=${chrome.runtime.id}` });
        window.close();
      });
    }

    if (location.pathname.endsWith('/options.html')) {
      $('force-render').hidden = true;
    }

    bind('theme', settings.theme, 'change', (e) => setSetting('theme', e.target.value));
    bind('scheme', settings.scheme, 'change', (e) => setSetting('scheme', e.target.value));
    bind('zoom', settings.readingZoom, 'change', (e) => setSetting('readingZoom', Number(e.target.value)));
    bind('print-margin', settings.printMargin, 'change', (e) => setSetting('printMargin', e.target.value));
    bind('autoreload', settings.autoReload, 'change', (e) => setSetting('autoReload', e.target.checked));
    bind('mermaid', settings.mermaid, 'change', (e) => setSetting('mermaid', e.target.checked));

    $('clip-render')?.addEventListener('click', async () => {
      const btn = $('clip-render');
      btn.disabled = true;
      try {
        await openClipboardViewer();
        window.close();
      } catch (err) {
        console.error('Skim: clipboard render failed', err);
        btn.disabled = false;
        btn.textContent = "Couldn't open the clipboard";
      }
    });

    $('force-render').addEventListener('click', async () => {
      if (!tab?.id) return;
      try {
        await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ['src/skim.css'] });
        await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => { window.__skimForce = true; } });
        await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['dist/content.bundle.js'] });
        window.close();
      } catch (err) {
        console.error('Skim: force-render failed', err);
        $('force-render').textContent = "Can't render this page";
      }
    });

    chrome.runtime.sendMessage({ type: 'skim-refresh-badge' }).catch(() => {});
  } catch (err) {
    console.error('Skim: popup init failed', err);
    $('controls').hidden = false;
  }
}
init();
