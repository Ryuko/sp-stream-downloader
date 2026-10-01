// Background script (service worker on Chrome, event page on Firefox): collect,
// per tab, everything the panel needs to rebuild the video manifest URL and
// authenticate:
//  - g_fileInfo from the page (read via chrome.scripting in the MAIN world).
//    Primary source since Sept 2026: the player no longer requests
//    `…/videomanifest…`, but that endpoint still answers when asked directly.
//  - videomanifest / oneDrive.transcode requests the player makes, plus the
//    X-SPOPacToken header when present (needed by the *.svc.ms CDN).
//  - the transcript URL.

const KEY = (tabId) => `capture_${tabId}`;
const DBG = true;
const dbg = (...a) => DBG && console.log("[SPSD]", ...a);

const isReady = (c) => !!(c.manifestUrl || c.transcodeUrl || (c.fileInfo && c.fileInfo.transformUrl));

async function getCapture(tabId) {
  const o = await chrome.storage.session.get(KEY(tabId));
  return o[KEY(tabId)] || {};
}

function setBadge(tabId, on) {
  chrome.action.setBadgeText({ tabId, text: on ? "●" : "" }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ tabId, color: "#22c55e" }).catch(() => {});
}

async function updateCapture(tabId, patch) {
  const cur = await getCapture(tabId);
  const next = { ...cur, ...patch, ts: Date.now() };
  await chrome.storage.session.set({ [KEY(tabId)]: next });
  setBadge(tabId, isReady(next));
  dbg("capture updated tab", tabId, {
    hasFileInfo: !!(next.fileInfo && next.fileInfo.transformUrl),
    hasManifest: !!next.manifestUrl,
    hasTranscode: !!next.transcodeUrl,
    hasToken: !!next.token,
    hasTranscript: !!next.transcriptUrl,
  });
}

async function clearCapture(tabId) {
  await chrome.storage.session.remove(KEY(tabId));
  setBadge(tabId, false);
}

// 0) Read g_fileInfo from the page (inline in the HTML, so it is there as soon as
//    the document is loaded — no playback needed).
async function probeFileInfo(tabId) {
  try {
    const res = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: () => {
        const g = window.g_fileInfo;
        if (!g || typeof g !== "object") return null;
        return {
          transformUrl: g[".transformUrl"] || g[".providerCdnTransformUrl"] || null,
          ctag: g[".ctag"] || null,
          spItemUrl: g[".spItemUrl"] || null,
          driveAccessToken: g[".driveAccessToken"] || null,
          driveAccessTokenV21: g[".driveAccessTokenV21"] || null,
          name: g.displayName || g.name || g.title || null,
          hasTranscripts: !!g.hasTranscripts,
        };
      },
    });
    const info = res && res[0] && res[0].result;
    if (info && info.transformUrl) {
      await updateCapture(tabId, { fileInfo: info });
      return true;
    }
    dbg("probe: no g_fileInfo/.transformUrl on tab", tabId, info);
  } catch (e) {
    dbg("probe failed on tab", tabId, e && e.message);
  }
  return false;
}

// Identity of the item shown by a Stream page URL (its `id=` param), so that
// opening another recording in the same tab drops the previous capture.
function pageIdOf(url) {
  try { const u = new URL(url); return u.searchParams.get("id") || u.pathname; } catch (e) { return url; }
}

chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (!tab || !tab.url || !/^https:\/\/[^/]+\.sharepoint\.com\//i.test(tab.url)) return;
  if (info.url) {
    const id = pageIdOf(info.url);
    getCapture(tabId).then(async (cur) => {
      if (cur.pageId && cur.pageId !== id) { dbg("tab", tabId, "moved to another item, clearing capture"); await clearCapture(tabId); }
      if (cur.pageId !== id) await updateCapture(tabId, { pageId: id });
    });
  }
  if (info.status === "complete") probeFileInfo(tabId);
});

// Chrome only exposes some request headers when "extraHeaders" is asked for;
// Firefox exposes them all and rejects that option, so retry without it.
function onSendHeaders(listener, urls) {
  try { chrome.webRequest.onSendHeaders.addListener(listener, { urls }, ["requestHeaders", "extraHeaders"]); }
  catch (e) { chrome.webRequest.onSendHeaders.addListener(listener, { urls }, ["requestHeaders"]); }
}

// 1) Observe the player's media requests: legacy `videomanifest` and the newer
//    `oneDrive.transcode` endpoint. Keep the URL (index preferred over a segment)
//    and refresh the X-SPOPacToken whenever we see one.
onSendHeaders(
  (d) => {
    if (d.tabId < 0) return;
    const isVM = /videomanifest/i.test(d.url);
    const isTC = /oneDrive\.transcode/i.test(d.url);
    if (!isVM && !isTC) return;
    const h = d.requestHeaders || [];
    const tokHeader = h.find((x) => x.name.toLowerCase() === "x-spopactoken");
    const tok = tokHeader && tokHeader.value;
    const isIndex = /[?&]part=index/i.test(d.url);
    getCapture(d.tabId).then((cur) => {
      const patch = {};
      if (tok && tok !== cur.token) patch.token = tok;
      if (isVM) {
        if (isIndex || !cur.manifestIsIndex) { patch.manifestUrl = d.url; patch.manifestIsIndex = isIndex; }
      } else if (isIndex || !cur.transcodeUrl || !cur.transcodeIsIndex) {
        patch.transcodeUrl = d.url; patch.transcodeIsIndex = isIndex;
      }
      if (!Object.keys(patch).length) return;
      dbg(isVM ? "videomanifest seen" : "transcode seen", { tab: d.tabId, hasToken: !!tok, isIndex, url: d.url.slice(0, 100) });
      updateCapture(d.tabId, patch);
    });
  },
  ["https://*.svc.ms/*", "https://*.sharepoint.com/*"]
);

// 2) Capture the transcript URL (encrypted JSON, same key as the video).
onSendHeaders(
  (d) => {
    if (d.tabId < 0) return;
    if (!/cdnmedia\/transcripts/i.test(d.url)) return;
    dbg("transcript seen", { tab: d.tabId, url: d.url.slice(0, 80) });
    updateCapture(d.tabId, { transcriptUrl: d.url });
  },
  ["https://*.sharepoint.com/*"]
);

chrome.tabs.onRemoved.addListener((tabId) => chrome.storage.session.remove(KEY(tabId)));

// Messages: content script asks its tab id; the panel asks for a fresh g_fileInfo
// probe and for the capture (it can't read storage.session itself on Firefox).
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === "getCapture") {
    if (typeof msg.tabId !== "number") { sendResponse({}); return true; }
    getCapture(msg.tabId).then(sendResponse);
    return true;
  }
  if (msg && msg.type === "whoami") {
    sendResponse({ tabId: sender.tab ? sender.tab.id : null });
    return true;
  }
  if (msg && msg.type === "probe") {
    const id = typeof msg.tabId === "number" ? msg.tabId : sender.tab && sender.tab.id;
    if (typeof id !== "number") { sendResponse({ ok: false }); return true; }
    probeFileInfo(id).then((ok) => sendResponse({ ok }));
    return true;
  }
});

// Give an already-open tab a live content script (harmless if it has one:
// content.js guards against double injection).
async function injectInto(tabId) {
  try {
    await chrome.scripting.insertCSS({ target: { tabId }, files: ["content.css"] });
    await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
    dbg("content script injected into existing tab", tabId);
  } catch (e) { dbg("could not inject into tab", tabId, e && e.message); }
}

// After an install/reload, SharePoint tabs that are already open have no (live)
// content script: inject it so the toolbar icon works without a page reload,
// and read their g_fileInfo right away.
chrome.runtime.onInstalled.addListener(async () => {
  let tabs = [];
  try { tabs = await chrome.tabs.query({ url: "https://*.sharepoint.com/*" }); } catch (e) { return; }
  for (const t of tabs) {
    if (typeof t.id !== "number") continue;
    await injectInto(t.id);
    probeFileInfo(t.id);
  }
});

// Host access can be withheld by the user (Firefox MV3 treats host_permissions
// as revocable; Chrome has "on click" site access). Without it neither the
// content script nor the capture runs, so the toolbar click asks for it.
// permissions.request() only counts as a user action when called synchronously
// from the click handler, hence the grant is tracked ahead of time.
const HOSTS = chrome.runtime.getManifest().host_permissions;
let hostsGranted = true;
const checkHosts = () => chrome.permissions.contains({ origins: HOSTS }).then((ok) => { hostsGranted = ok; }).catch(() => {});
checkHosts();
chrome.permissions.onAdded.addListener(checkHosts);
chrome.permissions.onRemoved.addListener(checkHosts);

const togglePanel = (tabId) => chrome.tabs.sendMessage(tabId, { type: "togglePanel", tabId }).catch(() => {
  dbg("no content script on this tab (not a SharePoint page?)");
});

chrome.action.onClicked.addListener((tab) => {
  if (hostsGranted) { togglePanel(tab.id); return; }
  chrome.permissions.request({ origins: HOSTS }).then(async (ok) => {
    hostsGranted = ok;
    if (!ok) { dbg("host access refused"); return; }
    await injectInto(tab.id);
    probeFileInfo(tab.id);
    togglePanel(tab.id);
  }).catch((e) => dbg("permission request failed", e && e.message));
});

dbg("background ready");
