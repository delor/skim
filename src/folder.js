// Skim folder view — replaces Chrome's bare-bones file:// directory listing
// with a themed, filterable, keyboard-friendly index of the folder.
// Runs on every file:// page (see manifest), so the guard must be first and cheap.
//
// How Chrome's listing works: the generated page streams
// <script>addRow(name, url, isdir, size, size_string, date_modified,
// date_modified_string)</script> chunks that build a <table>; each row's cells
// carry the raw values in data-value (Chrome's own column sort reads them).
// This script runs at document_idle — after DOMContentLoaded, so every inline
// addRow has executed — and reads the rows back out of the DOM. The original
// listing is hidden (folder.css keys on <html data-skim-folder="1">) but left
// in the document so any late inline script still finds its elements; a
// MutationObserver picks up straggler rows defensively.
import { DEFAULTS, getSettings, setSetting, onSettingsChanged } from './settings.js';

const MD_RE = /\.(md|markdown|mdown|mkd|mkdn|mdx)$/i;

// Chrome only generates a listing for file:// URLs ending in "/", and the
// generated page carries these well-known ids.
function isDirectoryListing() {
  return location.protocol === 'file:'
    && location.pathname.endsWith('/')
    && !!document.querySelector('#parentDirLinkBox, #theader, #tbody');
}

// Tiny DOM helper (mirrors ui.js's el(); nodeType check instead of instanceof
// so it also runs under jsdom in tests).
function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  Object.assign(node, props);
  for (const c of [].concat(children)) {
    node.append(c && c.nodeType ? c : document.createTextNode(c));
  }
  return node;
}

// skim.css keys every palette (dark/light × each color scheme) on
// :root[data-skim-md="1"]. Nothing else acts on that attribute on a directory
// page (the viewer bundle only matches *.md URLs), so borrow it to reuse the
// viewer's exact tokens instead of duplicating fifteen palettes here.
function applyThemeAttrs(settings) {
  const root = document.documentElement;
  root.setAttribute('data-theme', settings.theme === 'light' ? 'light' : 'dark');
  if (settings.scheme && settings.scheme !== 'none') root.setAttribute('data-scheme', settings.scheme);
  else root.removeAttribute('data-scheme');
}

function injectExtensionStylesheet(path) {
  try {
    const href = chrome.runtime.getURL(path);
    if (document.querySelector(`link[href="${href}"]`)) return;
    (document.head || document.documentElement).append(el('link', { rel: 'stylesheet', href }));
  } catch { /* no extension context (tests) — folder.css carries fallback tokens */ }
}

// One <tr> of Chrome's table -> an entry, or null for anything that isn't one
// (the header row, the parent link, malformed rows).
function parseRow(tr) {
  const cells = tr.cells;
  if (!cells || !cells.length) return null;
  const link = cells[0].querySelector('a[href]');
  if (!link) return null;
  const isDir = link.classList.contains('dir');
  let name = cells[0].dataset.value ?? link.textContent ?? '';
  if (isDir) name = name.replace(/\/+$/, '');
  if (!name || name === '.' || name === '..') return null;
  const rawSize = Number(cells[1]?.dataset.value);
  const rawDate = Number(cells[2]?.dataset.value);
  return {
    name,
    lname: name.toLowerCase(),
    href: link.href,
    isDir,
    isMd: !isDir && MD_RE.test(name),
    size: !isDir && Number.isFinite(rawSize) ? rawSize : null, // dirs report no size
    dateVal: Number.isFinite(rawDate) ? rawDate : 0,
    dateStr: (cells[2]?.textContent || '').trim(), // Chrome's locale-formatted string
    row: null,
  };
}

function formatSize(bytes) {
  if (bytes === null || !Number.isFinite(bytes)) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v >= 10 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

// natural sort ("ch2" before "ch10"), case-insensitive.
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

// Directories always group first. Within a name sort, markdown files pin above
// other files — this is a markdown viewer, .md files are the point.
function makeCompare(key, dir) {
  return (a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    if (key === 'name') {
      if (!a.isDir && a.isMd !== b.isMd) return a.isMd ? -1 : 1;
      return dir * collator.compare(a.name, b.name);
    }
    if (key === 'size') return dir * ((a.size ?? -1) - (b.size ?? -1)) || collator.compare(a.name, b.name);
    return dir * (a.dateVal - b.dateVal) || collator.compare(a.name, b.name);
  };
}

// location.pathname is percent-encoded; keep the encoded slices for hrefs and
// decode per-segment for display.
function buildCrumbs() {
  const parts = location.pathname.split('/').filter(Boolean);
  const crumbs = [{ label: '/', href: 'file:///' }];
  let acc = '';
  for (const part of parts) {
    acc += `/${part}`;
    let label;
    try { label = decodeURIComponent(part); } catch { label = part; }
    crumbs.push({ label, href: `file://${acc}/` });
  }
  return crumbs;
}

async function run() {
  if (!isDirectoryListing()) return;
  const root = document.documentElement;
  if (root.dataset.skimFolder === '1') return; // never double-mount

  let settings;
  try { settings = await getSettings(); } catch { settings = { ...DEFAULTS }; }

  root.dataset.skimMd = '1'; // token source: skim.css palettes key on this
  applyThemeAttrs(settings);
  injectExtensionStylesheet('src/skim.css');
  injectExtensionStylesheet('vendor/fonts.css');

  // ---- read Chrome's data out of its table --------------------------------
  let sourceRows = document.querySelectorAll('#tbody tr');
  if (!sourceRows.length) sourceRows = document.querySelectorAll('table tr');
  const entries = [];
  for (const tr of sourceRows) {
    const entry = parseRow(tr);
    if (entry) entries.push(entry);
  }

  const state = { entries, key: 'name', dir: 1, filter: '' };

  // ---- header: eyebrow, breadcrumb path bar, stats ------------------------
  const crumbs = buildCrumbs();
  const pathNav = el('nav', { className: 'skim-folder-path' });
  pathNav.setAttribute('aria-label', 'Folder path');
  if (crumbs.length === 1) {
    pathNav.append(el('span', { className: 'skim-folder-crumb is-current', textContent: '/' }));
  } else {
    pathNav.append(el('a', { className: 'skim-folder-crumb skim-folder-crumb-root', href: crumbs[0].href, textContent: '/', title: 'Filesystem root' }));
    for (let i = 1; i < crumbs.length; i++) {
      const c = crumbs[i];
      const last = i === crumbs.length - 1;
      const node = last
        ? el('span', { className: 'skim-folder-crumb is-current', textContent: c.label })
        : el('a', { className: 'skim-folder-crumb', href: c.href, textContent: c.label });
      node.setAttribute('dir', 'auto');
      if (last) node.setAttribute('aria-current', 'page');
      pathNav.append(node, el('span', { className: 'skim-folder-sep', textContent: '/' }));
    }
  }

  const statsEl = el('p', { className: 'skim-folder-stats' });

  // ---- controls: filter + theme toggle ------------------------------------
  const filterInput = el('input', { className: 'skim-folder-filter', type: 'search', placeholder: 'filter' });
  filterInput.setAttribute('aria-label', 'Filter entries');
  filterInput.setAttribute('autocomplete', 'off');
  filterInput.setAttribute('spellcheck', 'false');

  const themeBtn = el('button', { className: 'skim-folder-theme', type: 'button' });
  const syncThemeBtn = () => {
    const light = root.getAttribute('data-theme') === 'light';
    themeBtn.textContent = light ? '🌙 Dark' : '🌞 Light';
    themeBtn.title = light ? 'Switch to dark theme' : 'Switch to light theme';
  };
  themeBtn.addEventListener('click', () => {
    settings.theme = root.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
    applyThemeAttrs(settings);
    syncThemeBtn();
    setSetting('theme', settings.theme).catch(() => {});
  });
  syncThemeBtn();

  // ---- list: column head, parent row, entry rows --------------------------
  const head = el('div', { className: 'skim-folder-head' });
  const colBtns = new Map();
  for (const [key, label] of [['name', 'Name'], ['size', 'Size'], ['date', 'Modified']]) {
    const b = el('button', { className: 'skim-folder-col', type: 'button', title: `Sort by ${label.toLowerCase()}` },
      [label, el('span', { className: 'skim-folder-ind' })]);
    b.dataset.key = key;
    b.addEventListener('click', () => {
      if (state.key === key) state.dir = -state.dir;
      else { state.key = key; state.dir = 1; }
      applySort();
    });
    colBtns.set(key, b);
    head.append(b);
  }

  function buildRow(entry) {
    const icon = el('span', { className: 'skim-folder-icon' });
    icon.setAttribute('aria-hidden', 'true');
    const label = el('span', { className: 'skim-folder-label', textContent: entry.name });
    label.setAttribute('dir', 'auto'); // names can be Hebrew/Arabic
    const name = el('span', { className: 'skim-folder-name' }, [icon, label]);
    // ls -F idiom: the trailing slash IS the "this is a folder" signal. A real
    // sibling span (not ::after on the label) so it stays put next to RTL names.
    if (entry.isDir) name.append(el('span', { className: 'skim-folder-slash', textContent: '/' }));
    return el('a', {
      className: `skim-folder-row ${entry.isDir ? 'is-dir' : entry.isMd ? 'is-md' : 'is-file'}${entry.name.startsWith('.') ? ' is-dot' : ''}`,
      href: entry.href,
    }, [
      name,
      el('span', { className: 'skim-folder-size', textContent: entry.isDir ? '—' : formatSize(entry.size) }),
      el('span', { className: 'skim-folder-date', textContent: entry.dateStr || '—' }),
    ]);
  }
  for (const entry of entries) entry.row = buildRow(entry);

  let upRow = null;
  const parentHref = new URL('..', location.href).href;
  if (parentHref !== location.href) {
    const icon = el('span', { className: 'skim-folder-icon' });
    icon.setAttribute('aria-hidden', 'true');
    upRow = el('a', { className: 'skim-folder-row is-up', href: parentHref, title: 'Parent folder' }, [
      el('span', { className: 'skim-folder-name' }, [icon, el('span', { className: 'skim-folder-label', textContent: '..' })]),
      el('span', { className: 'skim-folder-size' }),
      el('span', { className: 'skim-folder-date' }),
    ]);
  }

  const rowsEl = el('div', { className: 'skim-folder-rows' });
  const emptyEl = el('p', { className: 'skim-folder-empty', hidden: true });

  // ---- keyboard cursor ----------------------------------------------------
  let cursorRow = null;
  const setCursor = (row) => {
    if (cursorRow) cursorRow.classList.remove('is-cursor');
    cursorRow = row || null;
    if (cursorRow) {
      cursorRow.classList.add('is-cursor');
      cursorRow.scrollIntoView?.({ block: 'nearest' });
    }
  };
  // On-screen order: parent row first, then the sorted entries. O(n) per
  // keypress, no per-row listeners — fine into the thousands.
  const visibleRows = () => {
    const vis = [];
    if (upRow) vis.push(upRow);
    for (const entry of state.entries) if (!entry.row.hidden) vis.push(entry.row);
    return vis;
  };
  const moveCursor = (delta) => {
    const vis = visibleRows();
    if (!vis.length) return;
    const idx = cursorRow ? vis.indexOf(cursorRow) : -1;
    const next = idx === -1
      ? (delta > 0 ? 0 : vis.length - 1)
      : Math.min(vis.length - 1, Math.max(0, idx + delta));
    setCursor(vis[next]);
  };

  // requestAnimationFrame when available (browser), setTimeout under jsdom.
  const schedule = typeof requestAnimationFrame === 'function'
    ? requestAnimationFrame
    : (fn) => setTimeout(fn, 0);

  // ---- stats / filter / sort ----------------------------------------------
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  function updateStats(shown) {
    statsEl.replaceChildren();
    const q = state.filter.trim();
    if (q) {
      statsEl.append(`${shown} of ${state.entries.length} match`);
      return;
    }
    let dirs = 0, files = 0, md = 0, bytes = 0;
    for (const entry of state.entries) {
      if (entry.isDir) dirs++;
      else {
        files++;
        if (entry.isMd) md++;
        if (entry.size) bytes += entry.size;
      }
    }
    statsEl.append(`${plural(dirs, 'folder')} · ${plural(files, 'file')}`);
    if (md) statsEl.append(' · ', el('b', { textContent: `${md} markdown` }));
    if (bytes) statsEl.append(` · ${formatSize(bytes)}`);
  }

  function applyFilter() {
    const q = state.filter.trim().toLowerCase();
    let shown = 0;
    for (const entry of state.entries) {
      const hit = !q || entry.lname.includes(q);
      entry.row.hidden = !hit;
      if (hit) shown++;
    }
    emptyEl.hidden = shown !== 0;
    if (!shown) {
      emptyEl.textContent = state.entries.length ? `No matches for “${state.filter.trim()}”.` : 'Empty folder.';
    }
    updateStats(shown);
    setCursor(null); // the row under the cursor may just have been hidden
  }

  function applySort() {
    state.entries.sort(makeCompare(state.key, state.dir));
    const frag = document.createDocumentFragment();
    for (const entry of state.entries) frag.append(entry.row); // append() moves
    rowsEl.append(frag);
    for (const [key, b] of colBtns) {
      b.classList.toggle('sorted', key === state.key);
      b.classList.toggle('desc', key === state.key && state.dir === -1);
    }
  }

  // Coalesce filter passes to one per frame even while typing fast.
  let filterQueued = false;
  filterInput.addEventListener('input', () => {
    state.filter = filterInput.value;
    if (filterQueued) return;
    filterQueued = true;
    schedule(() => { filterQueued = false; applyFilter(); });
  });

  // ---- keyboard: / focuses filter, type-anywhere filters, arrows/jk move,
  // Enter opens, Escape clears --------------------------------------------
  document.addEventListener('keydown', (e) => {
    const target = e.target;
    const inFilter = target === filterInput;
    if (e.key === 'Escape') {
      if (filterInput.value || inFilter) {
        filterInput.value = '';
        state.filter = '';
        applyFilter();
        filterInput.blur();
      } else setCursor(null);
      return;
    }
    if (e.key === 'Enter') {
      // A row or button focused by Tab keeps its native Enter behavior.
      if (!inFilter && target && target.nodeType === 1 && target.closest?.('a, button')) return;
      const row = cursorRow || (inFilter ? visibleRows().find((r) => r !== upRow) : null);
      if (row) { e.preventDefault(); location.href = row.href; }
      return;
    }
    if (e.key === 'ArrowDown' || (!inFilter && e.key === 'j')) { e.preventDefault(); moveCursor(1); return; }
    if (e.key === 'ArrowUp' || (!inFilter && e.key === 'k')) { e.preventDefault(); moveCursor(-1); return; }
    if (inFilter) return;
    if (target && target.nodeType === 1 && target.closest?.('input, textarea, select, button, [contenteditable]')) return;
    if (e.key === '/') { e.preventDefault(); filterInput.focus(); return; }
    // Any bare printable character drops focus into the filter; the keystroke
    // itself lands there (the default action runs after keydown handlers).
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) filterInput.focus();
  });

  // ---- mount --------------------------------------------------------------
  const header = el('header', { className: 'skim-folder-header' }, [
    el('div', { className: 'skim-folder-eyebrow', textContent: '## index of' }),
    pathNav,
    statsEl,
  ]);
  const filterWrap = el('div', { className: 'skim-folder-filterwrap' }, [
    filterInput,
    el('kbd', { className: 'skim-folder-key', textContent: '/' }),
  ]);
  const controls = el('div', { className: 'skim-folder-controls' }, [filterWrap, themeBtn]);
  const list = el('section', { className: 'skim-folder-list' }, [head]);
  if (upRow) list.append(upRow);
  list.append(rowsEl, emptyEl);
  document.body.append(el('div', { className: 'skim-folder' }, [header, controls, list]));
  root.dataset.skimFolder = '1'; // folder.css now hides Chrome's own listing

  applySort();
  applyFilter();

  const lastCrumb = crumbs[crumbs.length - 1];
  document.title = `${crumbs.length > 1 ? `${lastCrumb.label}/` : '/'} — Skim`;

  // Straggler rows (defensive: a listing still streaming past document_idle).
  const tbody = document.getElementById('tbody');
  if (tbody) {
    new MutationObserver((mutations) => {
      let added = false;
      for (const m of mutations) {
        for (const node of m.addedNodes) {
          if (node.nodeName !== 'TR') continue;
          const entry = parseRow(node);
          if (entry) {
            entry.row = buildRow(entry);
            state.entries.push(entry);
            added = true;
          }
        }
      }
      if (added) schedule(() => { applySort(); applyFilter(); });
    }).observe(tbody, { childList: true });
  }

  // Live-sync theme/scheme changes made from the popup or another tab.
  onSettingsChanged((patch) => {
    if (patch.theme) settings.theme = patch.theme;
    if (patch.scheme !== undefined) settings.scheme = patch.scheme;
    if (patch.theme || patch.scheme !== undefined) {
      applyThemeAttrs(settings);
      syncThemeBtn();
    }
  });
}

function runSafely() {
  run().catch((e) => console.error('Skim: folder view failed', e));
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', runSafely, { once: true });
else runSafely();
