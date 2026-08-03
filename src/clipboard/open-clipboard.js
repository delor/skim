// Open whatever markdown the reader has copied in the Skim viewer.
//
// The clipboard is read from the popup because that context has the user
// gesture and window focus Chrome wants for navigator.clipboard. The text
// travels to the viewer tab through session storage, never through the URL:
// a hash would put the reader's clipboard into their browser history.
// A failed read is not fatal, the viewer asks for a plain Ctrl+V instead.

export const CLIPBOARD_PAGE = 'src/clipboard/clipboard.html';

export async function readClipboardText() {
  try {
    const text = await navigator.clipboard.readText();
    return text && text.trim() ? text : null;
  } catch {
    return null;
  }
}

export async function openClipboardViewer({ read = readClipboardText } = {}) {
  const text = await read();
  let key = '';
  if (text) {
    key = `clip:${crypto.randomUUID()}`;
    try { await chrome.storage.session.set({ [key]: text }); } catch { key = ''; }
  }
  const url = chrome.runtime.getURL(CLIPBOARD_PAGE) + (key ? `#${encodeURIComponent(key)}` : '');
  return chrome.tabs.create({ url });
}
