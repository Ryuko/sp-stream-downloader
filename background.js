// Service worker: collect, per tab, everything the panel needs to rebuild the
// video manifest URL and authenticate:
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

// 1) Observe the player's media requests: legacy `videomanifest` and the newer
//    `oneDrive.transcode` endpoint. Keep the URL (index preferred over a segment)
//    and refresh the X-SPOPacToken whenever we see one.
chrome.webRequest.onSendHeaders.addListener(
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
  { urls: ["https://*.svc.ms/*", "https://*.sharepoint.com/*"] },
  ["requestHeaders", "extraHeaders"]
);

// 2) Capture the transcript URL (encrypted JSON, same key as the video).
chrome.webRequest.onSendHeaders.addListener(
  (d) => {
    if (d.tabId < 0) return;
    if (!/cdnmedia\/transcripts/i.test(d.url)) return;
    dbg("transcript seen", { tab: d.tabId, url: d.url.slice(0, 80) });
    updateCapture(d.tabId, { transcriptUrl: d.url });
  },
  { urls: ["https://*.sharepoint.com/*"] },
  ["requestHeaders", "extraHeaders"]
);

chrome.tabs.onRemoved.addListener((tabId) => chrome.storage.session.remove(KEY(tabId)));

// Messages: content script asks its tab id; the panel asks for a fresh g_fileInfo probe.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
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

// After an install/reload, SharePoint tabs that are already open have no (live)
// content script: inject it so the toolbar icon works without a page reload,
// and read their g_fileInfo right away.
chrome.runtime.onInstalled.addListener(async () => {
  let tabs = [];
  try { tabs = await chrome.tabs.query({ url: "https://*.sharepoint.com/*" }); } catch (e) { return; }
  for (const t of tabs) {
    if (typeof t.id !== "number") continue;
    try {
      await chrome.scripting.insertCSS({ target: { tabId: t.id }, files: ["content.css"] });
      await chrome.scripting.executeScript({ target: { tabId: t.id }, files: ["content.js"] });
      dbg("content script injected into existing tab", t.id);
    } catch (e) { dbg("could not inject into tab", t.id, e && e.message); }
    probeFileInfo(t.id);
  }
});

chrome.action.onClicked.addListener((tab) => {
  chrome.tabs.sendMessage(tab.id, { type: "togglePanel" }).catch(() => {
    dbg("no content script on this tab (not a SharePoint page?)");
  });
});

dbg("service worker ready");
