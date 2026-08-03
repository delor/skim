// One trustworthy answer to "can we read file:// URLs?".
//
// chrome.extension.isAllowedFileSchemeAccess() is the documented API, but it is
// not dependable everywhere we ask: chrome.extension is absent in MV3 service
// workers and on Firefox, and every call site used to wrap it in a try/catch
// that fell back to "not allowed". The result was the nag that would not go
// away: the popup CTA and the "!" badge kept telling readers to flip a switch
// they had already flipped.
//
// So: ask the API first (cheap, authoritative when it answers), and only if it
// says no, or is not there at all, verify by actually reading a file:// URL.
// That read is ground truth. Only an extension with file access granted can do
// it, so a success means the API was wrong and we must not nag.

// Any file:// URL will do; the filesystem root exists on every platform and
// Chrome serves it as a directory listing.
const PROBE_URL = 'file:///';

export async function probeFileRead(fetchImpl = fetch) {
  try {
    const res = await fetchImpl(PROBE_URL, { cache: 'no-store' });
    // status 0 is an opaque-but-successful response; treat it as readable.
    return !!res && (res.ok || res.status === 0);
  } catch {
    return false;
  }
}

// `api` and `probe` are injectable for tests; production callers pass nothing.
export async function isFileAccessAllowed({ api, probe = probeFileRead } = {}) {
  const ask = api ?? nativeApi();
  if (ask) {
    try {
      if (await ask() === true) return true;
    } catch { /* API present but unusable here: fall through to the probe */ }
  }
  return probe();
}

function nativeApi() {
  if (typeof chrome === 'undefined') return null;
  const fn = chrome.extension?.isAllowedFileSchemeAccess;
  return typeof fn === 'function' ? () => chrome.extension.isAllowedFileSchemeAccess() : null;
}
