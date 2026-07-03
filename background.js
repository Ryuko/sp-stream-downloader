// Service worker: capture the SharePoint Stream manifest + auth token + transcript URL
// for the active tab, by observing the requests the player makes.

const KEY = (tabId) => `capture_${tabId}`;
const DBG = true;
const dbg = (...a) => DBG && console.log("[SPSD]", ...a);

async function getCapture(tabId) {
  const o = await chrome.storage.session.get(KEY(tabId));
  return o[KEY(tabId)] || {};
}

async function updateCapture(tabId, patch) {
  const cur = await getCapture(tabId);
  const next = { ...cur, ...patch, ts: Date.now() };
  await chrome.storage.session.set({ [KEY(tabId)]: next });
  const ready = next.manifestUrl && next.token;
  chrome.action.setBadgeText({ tabId, text: ready ? "●" : "" });
  chrome.action.setBadgeBackgroundColor({ tabId, color: "#22c55e" });
  dbg("capture updated tab", tabId, {
    hasManifest: !!next.manifestUrl,
    hasToken: !!next.token,
    hasTranscript: !!next.transcriptUrl,
    isIndex: !!next.manifestIsIndex,
  });
}

// 1) Capture the video manifest URL + X-SPOPacToken (auth) from the player's requests.
//    Broad filter on *.svc.ms, precise matching done in the handler.
chrome.webRequest.onSendHeaders.addListener(
  (d) => {
    if (d.tabId < 0) return;
    if (!/videomanifest/i.test(d.url)) return;
    const h = d.requestHeaders || [];
    const tokHeader = h.find((x) => x.name.toLowerCase() === "x-spopactoken");
    const tok = tokHeader && tokHeader.value;
    dbg("videomanifest seen", { tab: d.tabId, hasToken: !!tok, url: d.url.slice(0, 80) });
    if (!tok) return;
    const isIndex = /[?&]part=index/i.test(d.url);
    getCapture(d.tabId).then((cur) => {
      if (cur.manifestIsIndex && !isIndex) {
        updateCapture(d.tabId, { token: tok }); // refresh token only
        return;
      }
      updateCapture(d.tabId, { manifestUrl: d.url, token: tok, manifestIsIndex: isIndex });
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

// Let the content script learn its own tab id, and let the toolbar icon toggle the overlay.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === "whoami") {
    sendResponse({ tabId: sender.tab ? sender.tab.id : null });
    return true;
  }
});

chrome.action.onClicked.addListener((tab) => {
  chrome.tabs.sendMessage(tab.id, { type: "togglePanel" }).catch(() => {
    dbg("no content script on this tab (not a SharePoint page?)");
  });
});

dbg("service worker ready");
