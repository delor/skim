import { renderMarkdown } from '../render.js';
import { isFileAccessAllowed } from '../file-access-check.js';

async function watchFileAccess() {
  const status = document.getElementById('file-status');
  const step = document.getElementById('step-file');
  const tick = async () => {
    const ok = await isFileAccessAllowed();
    status.textContent = ok ? '✓ enabled' : 'not enabled yet';
    status.classList.toggle('ok', ok);
    step.classList.toggle('done', ok);
    if (ok) {
      // Access just got granted (this loop stops here), so clear the "!" badge
      // immediately instead of waiting for the next install/startup check.
      chrome.runtime.sendMessage({ type: 'skim-refresh-badge' }).catch(() => {});
    } else {
      setTimeout(tick, 1000);
    }
  };
  tick();
}

document.getElementById('open-settings').addEventListener('click', () => {
  chrome.tabs.create({ url: `chrome://extensions/?id=${chrome.runtime.id}` });
});

fetch(chrome.runtime.getURL('examples/sample.md'))
  .then((r) => r.text())
  .then((src) => { document.getElementById('demo').innerHTML = renderMarkdown(src); })
  .catch(() => { document.getElementById('demo').textContent = 'Sample unavailable.'; });

watchFileAccess();
