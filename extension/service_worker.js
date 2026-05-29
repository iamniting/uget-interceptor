'use strict';

const EXTENSION_VERSION = '1.0.0';
const NATIVE_HOST = 'com.ugetdm.chrome';
const SETTINGS = {
  enabled: 'enabled',
  lastStatus: 'lastStatus',
  lastError: 'lastError',
  lastSentUrl: 'lastSentUrl',
  lastSentAt: 'lastSentAt',
  lastFileName: 'lastFileName',
  hostReachable: 'hostReachable'
};

let hostReadyCache = undefined;
let hostReadyCacheAt = 0;
const HOST_CACHE_TTL_MS = 30_000;
const HEADER_CACHE_TTL_MS = 2 * 60_000;
const CONNECTION_CHECK_ALARM = 'ugetConnectionCheck';
const CONNECTION_CHECK_PERIOD_MINUTES = 1;

const ACTION_ICONS = {
  enabled: {
    32: 'icons/icon32.png',
    48: 'icons/icon48.png',
    64: 'icons/icon64.png',
  },
  disabled: {
    32: 'icons/icon-grey32.png',
  },
  error: {
    32: 'icons/icon-red32.png',
  }
};
const filenameByDownloadId = new Map();
const responseHeadersByUrl = new Map();

function storageGet(defaults) {
  return chrome.storage.local.get(defaults);
}

function storageSet(values) {
  return chrome.storage.local.set(values);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sendNativeMessage(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendNativeMessage(NATIVE_HOST, message, (response) => {
      const err = chrome.runtime.lastError;
      if (err) {
        resolve({ ok: false, error: err.message, response: null });
        return;
      }
      resolve({ ok: response !== null && response !== undefined, error: '', response });
    });
  });
}

function downloadsCancel(downloadId) {
  return new Promise((resolve) => {
    chrome.downloads.cancel(downloadId, () => {
      resolve(!chrome.runtime.lastError);
    });
  });
}

function downloadsErase(downloadId) {
  return new Promise((resolve) => {
    chrome.downloads.erase({ id: downloadId }, () => resolve());
  });
}

function downloadsSearchById(downloadId) {
  return new Promise((resolve) => {
    chrome.downloads.search({ id: downloadId }, (items) => {
      if (chrome.runtime.lastError || !items || !items.length) {
        resolve(null);
        return;
      }
      resolve(items[0]);
    });
  });
}

function showNotification(title, message) {
  chrome.notifications.create({
    type: 'basic',
    iconUrl: 'icons/icon64.png',
    title,
    message
  }, () => void chrome.runtime.lastError);
}

function getDownloadUrl(downloadItem) {
  return downloadItem.finalUrl || downloadItem.url || '';
}

function isHttpDownload(url) {
  return /^https?:\/\//i.test(url || '');
}

function stripQuotes(value) {
  return String(value || '').trim().replace(/^"|"$/g, '').replace(/^'|'$/g, '');
}

function safeDecode(value) {
  if (!value) return '';
  let out = String(value).trim();

  // Some servers send + instead of %20 in query-string based filenames.
  out = out.replace(/\+/g, ' ');

  for (let i = 0; i < 2; i++) {
    try {
      const decoded = decodeURIComponent(out);
      if (decoded === out) break;
      out = decoded;
    } catch (_err) {
      try {
        const decoded = unescape(out);
        if (decoded === out) break;
        out = decoded;
      } catch (_err2) {
        break;
      }
    }
  }

  return out;
}

function sanitizeFileName(name) {
  if (!name) return '';

  let candidate = safeDecode(stripQuotes(name))
    .replace(/\\/g, '/')
    .split('/')
    .pop()
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/["<>|:*?]/g, '_')
    .trim();

  // Avoid Chrome temporary or useless fallback names.
  if (!candidate || /^unconfirmed\s+\d+\.crdownload$/i.test(candidate)) return '';
  if (/^download(?:\.[a-z0-9]{1,8})?$/i.test(candidate)) return '';

  return candidate;
}

function getBaseName(path) {
  return sanitizeFileName(path);
}

function getRootUrl(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}/`;
  } catch (_err) {
    return url;
  }
}

function cacheKeyForUrl(url) {
  try {
    const parsed = new URL(url);
    parsed.hash = '';
    return parsed.toString();
  } catch (_err) {
    return url || '';
  }
}

function cleanupHeaderCache() {
  const now = Date.now();
  for (const [key, value] of responseHeadersByUrl.entries()) {
    if (!value || now - value.time > HEADER_CACHE_TTL_MS) {
      responseHeadersByUrl.delete(key);
    }
  }
}

function getHeaderValue(headers, wantedName) {
  const wanted = wantedName.toLowerCase();
  for (const header of headers || []) {
    if (String(header.name || '').toLowerCase() === wanted) {
      return header.value || '';
    }
  }
  return '';
}

function splitDispositionParts(value) {
  const parts = [];
  let current = '';
  let quoted = false;
  let quoteChar = '';

  for (const char of String(value || '')) {
    if ((char === '"' || char === "'") && !quoted) {
      quoted = true;
      quoteChar = char;
      current += char;
    } else if (char === quoteChar && quoted) {
      quoted = false;
      quoteChar = '';
      current += char;
    } else if (char === ';' && !quoted) {
      parts.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }

  if (current.trim()) parts.push(current.trim());
  return parts;
}

function parseContentDispositionFilename(contentDisposition) {
  if (!contentDisposition) return '';

  const parts = splitDispositionParts(contentDisposition);
  const params = new Map();

  for (const part of parts) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim().toLowerCase();
    const value = stripQuotes(part.slice(eq + 1).trim());
    params.set(key, value);
  }

  // RFC 5987 / RFC 6266 format: filename*=UTF-8''file%20name.iso
  const star = params.get('filename*');
  if (star) {
    const match = star.match(/^([^']*)'[^']*'(.*)$/);
    const encoded = match ? match[2] : star;
    const decoded = sanitizeFileName(encoded);
    if (decoded) return decoded;
  }

  const normal = params.get('filename');
  if (normal) {
    const decoded = sanitizeFileName(normal);
    if (decoded) return decoded;
  }

  return '';
}

function getFilenameFromUrl(url) {
  if (!url) return '';
  try {
    const parsed = new URL(url);

    // Some signed URLs include a content-disposition override in the query string.
    for (const key of ['response-content-disposition', 'content-disposition']) {
      const disposition = parsed.searchParams.get(key);
      const fromDisposition = parseContentDispositionFilename(disposition);
      if (fromDisposition) return fromDisposition;
    }

    // Some file servers use filename/name/file query params instead of Content-Disposition.
    for (const key of ['filename', 'file_name', 'fileName', 'file', 'name', 'download']) {
      const value = parsed.searchParams.get(key);
      const fromParam = sanitizeFileName(value);
      if (fromParam && /\.[a-z0-9]{1,12}$/i.test(fromParam)) return fromParam;
    }

    const fromPath = sanitizeFileName(parsed.pathname);
    if (fromPath) return fromPath;
  } catch (_err) {
    return sanitizeFileName(url.split('?')[0]);
  }
  return '';
}

function getCachedHeadersForUrl(url) {
  cleanupHeaderCache();
  const key = cacheKeyForUrl(url);
  if (responseHeadersByUrl.has(key)) return responseHeadersByUrl.get(key);

  // Redirects or final URL normalization may differ slightly; fall back to exact string prefix match.
  for (const [cachedKey, value] of responseHeadersByUrl.entries()) {
    if (cachedKey === key || cachedKey.startsWith(key) || key.startsWith(cachedKey)) {
      return value;
    }
  }

  return null;
}

function chooseBestFileName(downloadItem) {
  const url = getDownloadUrl(downloadItem);
  const cached = getCachedHeadersForUrl(url) || getCachedHeadersForUrl(downloadItem.url || '');

  const candidates = [
    cached ? parseContentDispositionFilename(cached.contentDisposition) : '',
    getFilenameFromUrl(url),
    filenameByDownloadId.get(downloadItem.id) || '',
    getBaseName(downloadItem.filename),
    getFilenameFromUrl(downloadItem.url || '')
  ];

  for (const candidate of candidates) {
    const clean = sanitizeFileName(candidate);
    if (clean) return clean;
  }

  return '';
}

async function waitForBetterDownloadItem(downloadItem) {
  let latest = downloadItem;

  // Give Chrome a short chance to populate filename/finalUrl before we cancel it.
  for (let i = 0; i < 8; i++) {
    await sleep(125);
    const fresh = await downloadsSearchById(downloadItem.id);
    if (!fresh) break;
    latest = { ...downloadItem, ...fresh };

    const fileName = chooseBestFileName(latest);
    if (fileName) break;
  }

  return latest;
}

async function getCookiesForUrl(url) {
  try {
    const cookies = await chrome.cookies.getAll({ url: getRootUrl(url) });
    return cookies.map((cookie) => {
      // uget-integrator expects Netscape cookie-file-like rows.
      const domain = cookie.domain || '';
      const includeSubdomains = cookie.hostOnly ? 'FALSE' : 'TRUE';
      const path = cookie.path || '/';
      const secure = cookie.secure ? 'TRUE' : 'FALSE';
      const expiry = cookie.expirationDate ? Math.round(cookie.expirationDate) : 0;
      return [domain, includeSubdomains, path, secure, expiry, cookie.name, cookie.value].join('\t');
    }).join('\n');
  } catch (_err) {
    return '';
  }
}

function getBestFileSize(downloadItem) {
  const url = getDownloadUrl(downloadItem);
  const cached = getCachedHeadersForUrl(url) || getCachedHeadersForUrl(downloadItem.url || '');

  if (Number.isFinite(downloadItem.fileSize) && downloadItem.fileSize > 0) {
    return String(downloadItem.fileSize);
  }

  if (cached && /^\d+$/.test(String(cached.contentLength || ''))) {
    return String(cached.contentLength);
  }

  return '';
}

function buildMessage(downloadItem, cookies) {
  const url = getDownloadUrl(downloadItem);
  const fileSize = getBestFileSize(downloadItem);
  const fileName = chooseBestFileName(downloadItem);

  return {
    URL: url,
    Cookies: cookies || '',
    UserAgent: navigator.userAgent || '',
    FileName: fileName,
    FileSize: fileSize,
    fileSize: fileSize,
    Referer: downloadItem.referrer || '',
    PostData: '',
    Batch: false,
    Version: EXTENSION_VERSION
  };
}

function buildPingMessage() {
  return {
    URL: '',
    Cookies: '',
    UserAgent: navigator.userAgent || '',
    FileName: '',
    FileSize: '',
    fileSize: '',
    Referer: '',
    PostData: '',
    Batch: false,
    Version: EXTENSION_VERSION
  };
}

async function checkNativeHost(force = false) {
  const now = Date.now();
  if (!force && hostReadyCache !== undefined && (now - hostReadyCacheAt) < HOST_CACHE_TTL_MS) {
    return hostReadyCache;
  }

  const result = await sendNativeMessage(buildPingMessage());
  hostReadyCache = result.ok;
  hostReadyCacheAt = now;

  await storageSet({
    [SETTINGS.hostReachable]: Boolean(result.ok),
    [SETTINGS.lastStatus]: result.ok ? 'uget-integrator connected' : 'uget-integrator not reachable',
    [SETTINGS.lastError]: result.ok ? '' : (result.error || 'No response from native host')
  });

  updateActionIcon();
  return result.ok;
}

async function updateActionIcon() {
  const state = await storageGet({
    [SETTINGS.enabled]: true,
    [SETTINGS.hostReachable]: true
  });
  const isEnabled = Boolean(state[SETTINGS.enabled]);
  const hostReachable = state[SETTINGS.hostReachable] !== false;

  let iconPath = ACTION_ICONS.disabled;
  if (isEnabled) {
    iconPath = hostReachable ? ACTION_ICONS.enabled : ACTION_ICONS.error;
  }

  chrome.action.setIcon({
    path: iconPath
  }, () => void chrome.runtime.lastError);

  // Keep the toolbar clean: no ON/OFF badge text, only icon color changes.
  chrome.action.setBadgeText({ text: '' }, () => void chrome.runtime.lastError);
  chrome.action.setTitle({ title: 'uGet Download Interceptor' }, () => void chrome.runtime.lastError);
}

function ensureConnectionAlarm() {
  chrome.alarms.create(CONNECTION_CHECK_ALARM, {
    periodInMinutes: CONNECTION_CHECK_PERIOD_MINUTES
  }, () => void chrome.runtime.lastError);
}

async function checkNativeHostAndKeepIconUpdated() {
  await checkNativeHost(true);
}

async function handleDownload(downloadItem) {
  const { enabled } = await storageGet({ [SETTINGS.enabled]: true });
  if (!enabled) return;

  const url = getDownloadUrl(downloadItem);
  if (!isHttpDownload(url)) return;
  if (downloadItem.state && String(downloadItem.state).toLowerCase() !== 'in_progress') return;

  const [hostOk, freshDownloadItem] = await Promise.all([
    checkNativeHost(false),
    waitForBetterDownloadItem(downloadItem)
  ]);

  if (!hostOk) {
    showNotification('uGet is not connected', 'Install/start uGet and uget-integrator, then try again. Chrome download was not cancelled.');
    return;
  }

  const finalUrl = getDownloadUrl(freshDownloadItem);
  const cookies = await getCookiesForUrl(finalUrl);
  const message = buildMessage(freshDownloadItem, cookies);

  // Cancel after filename detection so Chrome does not continue in parallel while uGet takes over.
  await downloadsCancel(freshDownloadItem.id);
  await downloadsErase(freshDownloadItem.id);

  const result = await sendNativeMessage(message);

  await storageSet({
    [SETTINGS.lastSentUrl]: finalUrl,
    [SETTINGS.lastSentAt]: new Date().toISOString(),
    [SETTINGS.lastFileName]: message.FileName || '',
    [SETTINGS.hostReachable]: Boolean(result.ok),
    [SETTINGS.lastStatus]: result.ok ? 'uget-integrator connected' : 'uget-integrator not reachable',
    [SETTINGS.lastError]: result.ok ? '' : (result.error || 'No response from native host')
  });

  filenameByDownloadId.delete(freshDownloadItem.id);

  if (!result.ok) {
    hostReadyCache = false;
    await updateActionIcon();
    showNotification('Could not send download to uGet', result.error || 'No response from uget-integrator.');
  } else {
    hostReadyCache = true;
    hostReadyCacheAt = Date.now();
    await updateActionIcon();
  }
}

chrome.runtime.onInstalled.addListener(async () => {
  ensureConnectionAlarm();
  const current = await storageGet({ [SETTINGS.enabled]: undefined });
  if (current.enabled === undefined) {
    await storageSet({
      [SETTINGS.enabled]: true,
      [SETTINGS.lastStatus]: 'Installed',
      [SETTINGS.lastError]: '',
      [SETTINGS.hostReachable]: true
    });
  }
  updateActionIcon();
  checkNativeHost(true);
});

chrome.runtime.onStartup.addListener(() => {
  ensureConnectionAlarm();
  updateActionIcon();
  checkNativeHost(true);
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm && alarm.name === CONNECTION_CHECK_ALARM) {
    checkNativeHostAndKeepIconUpdated();
  }
});

chrome.downloads.onCreated.addListener((downloadItem) => {
  handleDownload(downloadItem);
});

chrome.downloads.onChanged.addListener((delta) => {
  if (delta && delta.id && delta.filename && delta.filename.current) {
    filenameByDownloadId.set(delta.id, getBaseName(delta.filename.current));
  }
});

chrome.webRequest.onHeadersReceived.addListener((details) => {
  const contentDisposition = getHeaderValue(details.responseHeaders, 'content-disposition');
  const contentLength = getHeaderValue(details.responseHeaders, 'content-length');
  const contentType = getHeaderValue(details.responseHeaders, 'content-type');

  if (contentDisposition || contentLength) {
    responseHeadersByUrl.set(cacheKeyForUrl(details.url), {
      contentDisposition,
      contentLength,
      contentType,
      requestId: details.requestId,
      url: details.url,
      time: Date.now()
    });
  }
}, { urls: ['<all_urls>'] }, ['responseHeaders', 'extraHeaders']);

chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
  (async () => {
    if (request?.type === 'getState') {
      const state = await storageGet({
        [SETTINGS.enabled]: true,
        [SETTINGS.lastStatus]: '',
        [SETTINGS.lastError]: '',
        [SETTINGS.lastSentUrl]: '',
        [SETTINGS.lastSentAt]: '',
        [SETTINGS.lastFileName]: '',
        [SETTINGS.hostReachable]: true
      });
      sendResponse(state);
      return;
    }

    if (request?.type === 'setEnabled') {
      const enabled = Boolean(request.enabled);
      await storageSet({ [SETTINGS.enabled]: enabled });

      // Always check uget-integrator, even when interception is disabled.
      // If disabled, the icon remains grey, but popup status stays accurate.
      const ok = await checkNativeHost(true);
      sendResponse({ ok });
      return;
    }

    if (request?.type === 'checkHost') {
      const ok = await checkNativeHost(true);
      sendResponse({ ok });
      return;
    }

    sendResponse({ ok: false, error: 'Unknown request' });
  })();

  return true;
});
