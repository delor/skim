// Post-render glyph decoration applied to the rendered article DOM:
//   1. Star ratings   — runs of ★ colored by count (3+ important, 2 common, 1 minor).
//   2. Pretty symbols — ⇒ and friends rendered through KaTeX to match math type.
//   3. Emoji presentation — normalize text-default dingbats to color emoji.
// Each pass walks text nodes, skipping code, existing math, and our own output.
import katex from 'katex';
import { strongDirOfChar, effectiveDir } from './bidi.js';

// --- shared text walking ----------------------------------------------
const SKIP_TAGS = new Set(['PRE', 'CODE', 'SCRIPT', 'STYLE', 'TEXTAREA']);
const SKIP_CLASSES = ['skim-math', 'katex', 'skim-stars', 'skim-sym'];

function isSkipped(node) {
  for (let p = node.parentElement; p; p = p.parentElement) {
    if (SKIP_TAGS.has(p.tagName)) return true;
    if (p.classList && SKIP_CLASSES.some((c) => p.classList.contains(c))) return true;
    if (p.tagName === 'ARTICLE') return false;
  }
  return false;
}

// All non-empty text nodes under `root` not inside code/math/our own output.
function eligibleTextNodes(root) {
  const out = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
  let n;
  while ((n = walker.nextNode())) {
    if (n.nodeValue && n.nodeValue.trim() && !isSkipped(n)) out.push(n);
  }
  return out;
}

// Replace every match of the global `regex` in eligible text nodes with the
// element returned by make(matchText, node, matchIndex).
export function replaceInTextNodes(root, regex, make) {
  for (const node of eligibleTextNodes(root)) {
    const text = node.nodeValue;
    regex.lastIndex = 0;
    if (!regex.test(text)) continue;
    regex.lastIndex = 0;
    const frag = document.createDocumentFragment();
    let last = 0; let m;
    while ((m = regex.exec(text))) {
      if (m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)));
      frag.appendChild(make(m[0], node, m.index));
      last = m.index + m[0].length;
      if (m[0].length === 0) regex.lastIndex++;
    }
    if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
    node.parentNode.replaceChild(frag, node);
  }
}

// --- 1. Star ratings ---------------------------------------------------
// 3+ stars -> important, 2 -> common, 1 -> good-to-know.
export function starTier(count) {
  if (count >= 3) return 3;
  if (count === 2) return 2;
  return 1;
}

const STAR_RUN = /★(?:\s*★)*/g;

export function decorateStars(root) {
  replaceInTextNodes(root, STAR_RUN, (match) => {
    const count = (match.match(/★/g) || []).length;
    const span = document.createElement('span');
    span.className = `skim-stars skim-stars-${starTier(count)}`;
    span.textContent = match;
    return span;
  });
}

// --- 2. Pretty symbols via KaTeX --------------------------------------
export const SYMBOLS = {
  '⇒': '\\Rightarrow', '⇐': '\\Leftarrow', '⇔': '\\Leftrightarrow',
  '→': '\\rightarrow', '←': '\\leftarrow',
  '≤': '\\leq', '≥': '\\geq', '≠': '\\neq', '≈': '\\approx', '×': '\\times',
};
const SYMBOL_RUN = new RegExp('[' + Object.keys(SYMBOLS).join('') + ']', 'g');

// Unicode does not bidi-mirror arrows, so in RTL flow `רציפה ⇒ סגורה` renders
// with the arrow pointing at the antecedent instead of the consequent. When an
// arrow sits in RTL flow, render the mirrored glyph so it keeps pointing at
// its logical target. Only rightward arrows mirror: an author who typed ⇐
// inside Hebrew text already chose the visual direction they wanted.
const RTL_MIRROR = { '⇒': '\\Leftarrow', '→': '\\leftarrow' };

// Nearest strong direction scanning from `start` by `step` within one text
// node. Digits count as RTL here: the bidi algorithm resolves a neutral
// between a number and RTL text to the paragraph direction (UAX#9 N1/N2).
function sideStrongDir(text, start, step) {
  for (let k = start; k >= 0 && k < text.length; k += step) {
    const d = strongDirOfChar(text[k]);
    if (d) return d;
    if (/[0-9]/.test(text[k])) return 'rtl';
  }
  return null;
}

// An arrow flows RTL unless both of its nearest strong neighbors are LTR
// (then the bidi algorithm keeps the whole fragment LTR, e.g. `A ⇒ B`).
function flowsRtl(node, index) {
  if (effectiveDir(node.parentElement) !== 'rtl') return false;
  const before = sideStrongDir(node.nodeValue, index - 1, -1);
  const after = sideStrongDir(node.nodeValue, index + 1, +1);
  return !(before === 'ltr' && after === 'ltr');
}

const symbolCache = new Map();
function renderSymbol(latex, fallback) {
  if (!symbolCache.has(latex)) {
    let html;
    try {
      html = katex.renderToString(latex, { throwOnError: false, output: 'htmlAndMathml' });
    } catch {
      html = fallback;
    }
    symbolCache.set(latex, html);
  }
  return symbolCache.get(latex);
}

export function decorateSymbols(root) {
  replaceInTextNodes(root, SYMBOL_RUN, (ch, node, index) => {
    const latex = RTL_MIRROR[ch] && flowsRtl(node, index) ? RTL_MIRROR[ch] : SYMBOLS[ch];
    const span = document.createElement('span');
    span.className = 'skim-sym';
    span.dataset.sym = ch;            // original char, for copy-as-Markdown
    span.innerHTML = renderSymbol(latex, ch);
    return span;
  });
}

// --- 3. Emoji presentation ---------------------------------------------
// System emoji fonts handle color; we only normalize text-default dingbats
// (✔ ☀ …) to emoji presentation by appending VS16, and alias glyphs with no
// emoji form. (Twemoji images were dropped: 17MB for what every OS now ships.)
// Some text-default dingbats lack their own emoji form; map them to a close
// glyph that does.
const EMOJI_ALIAS = { '✎': '✏', '✐': '✏' }; // ✎ ✐ -> ✏
// Pictographic dingbats that are text-presentation by default in Unicode.
// Forcing VS16 renders them as color emoji. (Typographic marks like © ® ™
// and card suits are deliberately excluded so prose is left alone.)
const VS16 = '️';
const FORCE_EMOJI = new Set(Array.from(
  '✏✂✉✈✌✒✔✖❄❤☀☁☂☃☄☎☑☔☕☘☝☠☢☣☮☯☺♻♿⚠⚡✅✨'
));

function normalizeEmoji(text) {
  const chars = Array.from(text);
  let out = '';
  for (let i = 0; i < chars.length; i++) {
    const ch = EMOJI_ALIAS[chars[i]] || chars[i];
    out += ch;
    if (FORCE_EMOJI.has(ch) && chars[i + 1] !== VS16) out += VS16;
  }
  return out;
}

export function decorateEmoji(root) {
  for (const node of eligibleTextNodes(root)) {
    const fixed = normalizeEmoji(node.nodeValue);
    if (fixed !== node.nodeValue) node.nodeValue = fixed;
  }
}

export function decorateGlyphs(article) {
  decorateStars(article);
  decorateSymbols(article);
  decorateEmoji(article);
}
