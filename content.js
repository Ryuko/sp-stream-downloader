// Injected into SharePoint pages. Renders the download panel as an on-page
// overlay (an extension iframe), so everything stays in the same tab.
// Wrapped in an IIFE with a guard: background.js re-injects this file into
// already-open tabs after an extension reload, and a double injection must be
// harmless (no redeclared bindings, no duplicate listeners).
(() => {
  if (window.__spsdLoaded) return;
  window.__spsdLoaded = true;

  let myTabId = null;
  chrome.runtime.sendMessage({ type: "whoami" }, (r) => {
    if (chrome.runtime.lastError) return;
    if (r) myTabId = r.tabId;
  });

  chrome.runtime.onMessage.addListener((m) => {
    if (m && m.type === "togglePanel") togglePanel();
  });

  // The panel (iframe) asks us to close it via postMessage.
  window.addEventListener("message", (e) => {
    if (e.data === "spsd-close") removePanel();
  });

  function removePanel() {
    const h = document.getElementById("spsd-overlay");
    if (h) h.remove();
  }

  function togglePanel() {
    if (document.getElementById("spsd-overlay")) { removePanel(); return; }

    const host = document.createElement("div");
    host.id = "spsd-overlay";

    const frame = document.createElement("iframe");
    frame.id = "spsd-frame";
    frame.src = chrome.runtime.getURL("panel.html") + "#tab=" + (myTabId != null ? myTabId : "");
    host.appendChild(frame);

    document.documentElement.appendChild(host);
  }
})();
