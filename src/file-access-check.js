// One trustworthy answer to "can we read file:// URLs?".
//
// chrome.extension.isAllowedFileSchemeAccess() is the documented API, but it is
// not dependable everywhere we ask: chrome.extension is absent in MV3 service
// workers on some Chrome versions and on Firefox, and every call site used to
// wrap it in a try/catch that fell back to "not allowed". The result was the
// nag that would not go away: the popup CTA and the "!" badge kept telling
// readers to flip a switch they had already flipped.
//
// So: gather independent signals and let ANY yes win. Only when every signal
// says no do we report "not allowed" and nag.
//   1. the deprecated API (cheap, authoritative when it answers),
//   2. chrome.permissions.contains for the file:///* origin — the same switch
//      read through a separate, non-deprecated API surface,
//   3. actually reading a file:// URL. That read is ground truth: only an
//      extension with file access granted can do it (a denied fetch rejects).

// Any file:// URL will do; the filesystem root exists on every platform and
// Chrome serves it as a directory listing.
const PROBE_URL = 'file:///';

export async function probeFileRead(fetchImpl = fetch) {
  try {
    const res = await fetchImpl(PROBE_URL, { cache: 'no-store' });
    // Chrome answers a permitted directory-listing fetch with an opaque-but-
    // successful response: ok=false, status=0, body present. A denied fetch
    // rejects instead, so status 0 still means "readable".
    return !!res && (res.ok || res.status === 0);
  } catch {
    return false;
  }
}

// `api`, `perm` and `probe` are injectable for tests; production callers pass nothing.
export async function isFileAccessAllowed({ api, perm, probe = probeFileRead } = {}) {
  for (const ask of [api ?? nativeApi(), perm ?? nativePerm()]) {
    if (!ask) continue;
    try {
      if (await ask() === true) return true;
    } catch { /* signal unavailable here: try the next one */ }
  }
  return probe();
}

function nativeApi() {
  if (typeof chrome === 'undefined') return null;
  const fn = chrome.extension?.isAllowedFileSchemeAccess;
  return typeof fn === 'function' ? () => chrome.extension.isAllowedFileSchemeAccess() : null;
}

function nativePerm() {
  if (typeof chrome === 'undefined') return null;
  const fn = chrome.permissions?.contains;
  return typeof fn === 'function' ? () => chrome.permissions.contains({ origins: ['file:///*'] }) : null;
}
