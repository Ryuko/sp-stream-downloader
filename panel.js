"use strict";

const $ = (id) => document.getElementById(id);
const tabId = parseInt((location.hash.match(/tab=(\d+)/) || [])[1], 10);

let JOB = null; // { cap } — everything background.js captured for this tab

function showLog() { $("log").hidden = false; }
function log(msg, cls) {
  showLog();
  const d = document.createElement("div");
  if (cls) d.className = cls;
  d.textContent = msg;
  $("log").appendChild(d);
  $("log").scrollTop = $("log").scrollHeight;
}
function setPct(p) {
  $("progress").hidden = false;
  p = Math.max(0, Math.min(100, p));
  $("fill").style.width = p + "%";
  $("pct").textContent = Math.round(p) + " %";
}
function busy(on) {
  $("dlVideo").disabled = on;
  document.querySelectorAll(".seg button").forEach((b) => (b.disabled = on));
}
function sanitize(n) {
  let s = (n || "video").replace(/[\/\\:*?"<>|]+/g, " ").replace(/\s+/g, " ")
    .replace(/ - Microsoft Stream.*/i, "").trim();
  // Remove any trailing known extension(s) so we don't end up with "name.mp4.mp4".
  s = s.replace(/(\.(mp4|m4a|mov|vtt|srt|txt))+$/i, "").trim();
  return s.slice(0, 120) || "video";
}
// Host + path + the few query params that matter, never credentials.
function short(url) {
  const m = String(url).match(/[?&](part|format|track)=[^&]*/g) || [];
  return String(url).split("?")[0].replace(/^https:\/\//, "") + "?" + m.map((x) => x.slice(1)).join("&");
}

$("close").addEventListener("click", () => parent.postMessage("spsd-close", "*"));

// ---------- HTTP (authenticated in-session) ----------
// Session cookies always go along. The X-SPOPacToken header is added only when
// one was captured: the *.svc.ms CDN requires it, the tenant's *.sharepoint.com
// hosts accept the cookies alone.
function hdr() { return JOB && JOB.cap.token ? { "X-SPOPacToken": JOB.cap.token } : {}; }
async function fx(url, kind) {
  const r = await fetch(url, { headers: hdr(), credentials: "include", cache: "no-store" });
  if (!r.ok) {
    const ec = r.headers.get("x-errorcode") || r.headers.get("x-ms-error-code") || "";
    throw new Error(`HTTP ${r.status}${ec ? " (" + ec + ")" : ""} — ${short(url)}`);
  }
  return kind === "buf" ? new Uint8Array(await r.arrayBuffer()) : r.text();
}

// ---------- crypto ----------
const keyCache = {};
function importKey(uri) {
  if (!keyCache[uri]) keyCache[uri] = fx(uri, "buf").then((raw) => crypto.subtle.importKey("raw", raw, { name: "AES-CBC" }, false, ["decrypt"]));
  return keyCache[uri];
}
async function decryptSeg(data, key) {
  const k = await importKey(key.uri);
  return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-CBC", iv: key.iv }, k, data));
}

// ---------- build a track ----------
async function buildTrack(name, media, weight, prog) {
  const parts = new Array(media.segments.length + 1);
  parts[0] = media.init ? await fx(media.init, "buf") : new Uint8Array();
  const total = media.segments.length;
  let done = 0, idx = 0;
  async function worker() {
    while (true) {
      const i = idx++; if (i >= total) break;
      const s = media.segments[i];
      let d = await fx(s.url, "buf");
      if (s.key) d = await decryptSeg(d, s.key);
      parts[i + 1] = d; done++;
      if (done % 8 === 0 || done === total) prog(weight * (done / total), `${name} ${done}/${total}`);
    }
  }
  await Promise.all(Array.from({ length: 12 }, worker));
  let len = 0; for (const p of parts) len += p.length;
  const out = new Uint8Array(len); let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

// ---------- transcript ----------
const offToTs = (o, sep) => {
  const m = String(o || "").match(/(\d+):(\d+):(\d+)[.,](\d+)/);
  if (!m) return "00:00:00" + sep + "000";
  return `${m[1].padStart(2, "0")}:${m[2]}:${m[3]}${sep}${(m[4] + "000").slice(0, 3)}`;
};
function toVTT(j) {
  let s = "WEBVTT\n\n";
  (j.entries || []).forEach((e, i) => { s += `${i + 1}\n${offToTs(e.startOffset, ".")} --> ${offToTs(e.endOffset, ".")}\n`; if (e.speakerDisplayName) s += `<v ${e.speakerDisplayName}>`; s += `${(e.text || "").trim()}\n\n`; });
  return s;
}
function toSRT(j) {
  let s = "";
  (j.entries || []).forEach((e, i) => { s += `${i + 1}\n${offToTs(e.startOffset, ",")} --> ${offToTs(e.endOffset, ",")}\n`; if (e.speakerDisplayName) s += `${e.speakerDisplayName}: `; s += `${(e.text || "").trim()}\n\n`; });
  return s;
}
function toTXT(j) {
  let s = "", last = null;
  (j.entries || []).forEach((e) => { if (e.speakerDisplayName && e.speakerDisplayName !== last) { s += `\n${e.speakerDisplayName} :\n`; last = e.speakerDisplayName; } s += (e.text || "").trim() + " "; });
  return s.trim() + "\n";
}

// ---------- manifest discovery ----------
// Try every candidate URL (see SPManifest.candidateIndexUrls), HLS first because
// the pipeline was built for it, then DASH. Each attempt is logged so a failure
// leaves a usable diagnostic in the panel.
const SRC = { capture: "requête du lecteur", page: "g_fileInfo de la page", transcode: "segment oneDrive.transcode" };

async function fromHls(master) {
  const m = SPManifest.parseMaster(master);
  const video = SPManifest.parseMedia(await fx(m.videoUrl, "text"), m.vpk);
  const audio = m.audioUrl ? SPManifest.parseMedia(await fx(m.audioUrl, "text"), m.vpk) : null;
  return { kind: "HLS", video, audio };
}
function fromMpd(xml, url) {
  const r = SPManifest.parseMpd(xml, url);
  if (r.hardDrm) throw new Error("Contenu protégé par DRM (Widevine/PlayReady) : non pris en charge.");
  return { kind: "DASH", video: r.video, audio: r.audio };
}
async function getStreamContext() {
  const cands = SPManifest.candidateIndexUrls(JOB.cap);
  if (!cands.length) throw new Error("Aucune source de manifeste disponible.");
  let tries = 0;
  for (const c of cands) {
    for (const fmt of ["hls", "dash"]) {
      const url = SPManifest.withFormat(c.url, fmt);
      tries++;
      log(`Manifeste ${fmt.toUpperCase()} (${SRC[c.source]}) : ${short(url)}`);
      let text;
      try { text = await fx(url, "text"); }
      catch (e) { log("  ✗ " + e.message, "err"); continue; }
      try {
        if (fmt === "hls" && SPManifest.looksLikeHls(text)) return await fromHls(text);
        if (fmt === "dash" && SPManifest.looksLikeMpd(text)) return fromMpd(text, url);
        log("  ✗ réponse inattendue : " + text.slice(0, 100).replace(/\s+/g, " "), "err");
      } catch (e) {
        if (/DRM/.test(e.message)) throw e;
        log("  ✗ " + e.message, "err");
      }
    }
  }
  throw new Error(`Aucun manifeste exploitable après ${tries} tentative(s) — copiez le journal pour diagnostic.`);
}

async function fetchTranscriptJSON(firstKey) {
  const raw = await fx(JOB.cap.transcriptUrl, "buf");
  const k = await importKey(firstKey.uri);
  const dec = await crypto.subtle.decrypt({ name: "AES-CBC", iv: firstKey.iv }, k, raw);
  return JSON.parse(new TextDecoder().decode(dec));
}
function saveBytes(bytes, filename, mime) {
  const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
  return chrome.downloads.download({ url, filename, saveAs: true }).finally(() => setTimeout(() => URL.revokeObjectURL(url), 60000));
}

// ---------- flows ----------
async function runVideo(base) {
  busy(true); log("Recherche du manifeste…");
  const ctx = await getStreamContext();
  const { video, audio } = ctx;
  log(`${ctx.kind} — vidéo : ${video.segments.length} segments${audio ? `, audio : ${audio.segments.length}` : " (audio inclus)"}${video.firstKey ? ", chiffré AES-128" : ""}`);

  const vShare = audio ? 60 : 90, aShare = audio ? 28 : 0;
  let vP = 0, aP = 0;
  const videoBuf = await buildTrack("vidéo", video, vShare, (p, s) => { vP = p; setPct(vP + aP); if (s) log(s); });
  let audioBuf = null;
  if (audio) audioBuf = await buildTrack("audio", audio, aShare, (p, s) => { aP = p; setPct(vP + aP); if (s) log(s); });

  let out;
  if (audioBuf) { log("Remux vidéo + audio (JS)…"); setPct(94); out = FMP4Mux.remux(videoBuf, audioBuf); }
  else { out = videoBuf; }
  setPct(98);
  log(`Fichier : ${(out.length / 1048576).toFixed(1)} Mo`);
  await saveBytes(out, base + ".mp4", "video/mp4");
  setPct(100); log("✓ Terminé.", "done"); busy(false);
}

async function runTranscript(base, fmt) {
  busy(true); log("Récupération de la clé…");
  const { video } = await getStreamContext();
  if (!video.firstKey) throw new Error("Clé de déchiffrement introuvable.");
  setPct(45); log("Déchiffrement du transcript…");
  const j = await fetchTranscriptJSON(video.firstKey);
  setPct(85);
  // Neutral MIME for .srt so Chrome keeps the extension (text/plain would force .txt).
  const map = { vtt: [toVTT(j), ".vtt", "text/vtt"], srt: [toSRT(j), ".srt", "application/octet-stream"], txt: [toTXT(j), ".txt", "text/plain"] };
  const [content, ext, mime] = map[fmt];
  await saveBytes(new TextEncoder().encode(content), base + ext, mime);
  setPct(100); log(`✓ Transcript (${(j.entries || []).length} segments).`, "done"); busy(false);
}

let holdStatus = false; // keep an error message on screen until the next action
function guard(fn) {
  return async (...a) => {
    holdStatus = false;
    try { await fn(...a); }
    catch (e) {
      holdStatus = true;
      $("status").className = "status err"; $("status").textContent = "Échec : " + (e && e.message ? e.message : e);
      log("Astuce : lancez la lecture quelques secondes (cela capture un jeton frais), puis réessayez. Si l'erreur persiste, copiez ce journal.", "err");
      busy(false);
    }
  };
}

// ---------- boot & live detection ----------
async function refresh() {
  // Asked from the background script: Firefox doesn't expose storage.session
  // to an extension page framed inside a web page (this panel).
  const cap = (await chrome.runtime.sendMessage({ type: "getCapture", tabId })) || {};
  const cands = SPManifest.candidateIndexUrls(cap);
  if (!cands.length) return false;

  JOB = { cap }; // refreshed continuously so a fresher token is picked up mid-download
  $("controls").hidden = false;
  $("trBlock").hidden = !cap.transcriptUrl;
  if (!holdStatus && !$("dlVideo").disabled) { // don't clobber an error or a running job
    const srcs = [...new Set(cands.map((c) => c.source))].map((s) => SRC[s]).join(", ");
    $("status").className = "status ok";
    $("status").textContent = `✓ Vidéo détectée (${srcs})` + (cap.transcriptUrl ? " · transcript dispo" : "") + (cap.token ? "" : " · jeton non capturé");
  }
  return true;
}

async function main() {
  // Prefill the filename from the SharePoint tab's title (not the panel's).
  try { const t = await chrome.tabs.get(tabId); if (t && t.title) $("fname").value = sanitize(t.title); }
  catch (e) { $("fname").value = "enregistrement"; }

  // Ask the service worker to (re)read g_fileInfo now, then keep the view in
  // sync with whatever gets captured later (token, transcript URL…).
  try { await chrome.runtime.sendMessage({ type: "probe", tabId }); } catch (e) { /* worker asleep or no tab */ }
  // When the extension is reloaded while this panel is open, every chrome.* call
  // throws "Extension context invalidated": stop polling and tell the user.
  const timer = setInterval(safeRefresh, 1500);
  async function safeRefresh() {
    try { await refresh(); }
    catch (e) {
      if (!SPManifest.isContextInvalidated(e)) { console.warn("[SPSD]", e); return; }
      clearInterval(timer);
      holdStatus = true; busy(true);
      $("status").className = "status err";
      $("status").textContent = "Extension rechargée : rechargez la page (Cmd/Ctrl+R) puis rouvrez le panneau.";
    }
  }
  await safeRefresh();

  $("dlVideo").addEventListener("click", guard(() => runVideo(sanitize($("fname").value))));
  document.querySelectorAll(".seg button").forEach((b) =>
    b.addEventListener("click", guard(() => runTranscript(sanitize($("fname").value), b.dataset.fmt)))
  );
}
main();
