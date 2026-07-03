"use strict";

const $ = (id) => document.getElementById(id);
const tabId = parseInt((location.hash.match(/tab=(\d+)/) || [])[1], 10);

let JOB = null; // { token } filled from capture

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

$("close").addEventListener("click", () => parent.postMessage("spsd-close", "*"));

// ---------- HTTP (authenticated in-session) ----------
function hdr() { return { "X-SPOPacToken": JOB.token }; }
async function fx(url, kind) {
  const r = await fetch(url, { headers: hdr(), credentials: "include", cache: "no-store" });
  if (!r.ok) throw new Error(`HTTP ${r.status} — ${url.slice(0, 80)}…`);
  return kind === "buf" ? new Uint8Array(await r.arrayBuffer()) : r.text();
}

// ---------- HLS helpers ----------
const attr = (line, name) => { const m = line.match(new RegExp(name + '="([^"]*)"')); return m ? m[1] : null; };
function forceHls(u) {
  if (/[?&]format=dash/i.test(u)) return u.replace(/([?&]format=)dash/i, "$1hls");
  if (/[?&]format=hls/i.test(u)) return u;
  return u + (u.includes("?") ? "&" : "?") + "format=hls";
}
function parseIV(line) {
  const m = line.match(/IV=0x([0-9A-Fa-f]+)/);
  const hex = (m ? m[1] : "").padStart(32, "0").slice(-32);
  const iv = new Uint8Array(16);
  for (let i = 0; i < 16; i++) iv[i] = parseInt(hex.substr(i * 2, 2), 16);
  return iv;
}
function defineResolver(lines, seed) {
  const D = Object.assign({}, seed);
  for (const l of lines) {
    const m = l.match(/#EXT-X-DEFINE:NAME="([^"]+)",\s*VALUE="(.*)"$/);
    if (m) D[m[1]] = m[2];
  }
  return (u) => { for (const k in D) u = u.split("{$" + k + "}").join(D[k]); return u; };
}
function parseMaster(text) {
  const lines = text.split(/\r?\n/);
  let vpk = null; const audio = {};
  for (const l of lines) {
    if (l.startsWith("#EXT-X-DEFINE") && /NAME="commonVpkUrlVariable"/.test(l)) vpk = attr(l, "VALUE");
    if (l.startsWith("#EXT-X-MEDIA") && /TYPE=AUDIO/.test(l)) { const g = attr(l, "GROUP-ID"); if (g && !audio[g]) audio[g] = attr(l, "URI"); }
  }
  let best = null;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith("#EXT-X-STREAM-INF")) {
      const bw = parseInt((lines[i].match(/BANDWIDTH=(\d+)/) || [])[1] || "0", 10);
      const ag = attr(lines[i], "AUDIO");
      let j = i + 1; while (j < lines.length && (lines[j].startsWith("#") || !lines[j].trim())) j++;
      const uri = lines[j] ? lines[j].trim() : null;
      if (uri && (!best || bw > best.bw)) best = { bw, uri, ag };
    }
  }
  if (!best) throw new Error("Aucun flux vidéo dans le manifeste HLS.");
  return { vpk, videoUrl: best.uri, audioUrl: best.ag ? audio[best.ag] : null };
}
function parseMedia(text, vpk) {
  const lines = text.split(/\r?\n/);
  const sub = defineResolver(lines, { commonVpkUrlVariable: vpk });
  let init = null, curKey = null, firstKey = null; const segments = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.startsWith("#EXT-X-MAP")) init = sub(attr(l, "URI"));
    else if (l.startsWith("#EXT-X-KEY")) {
      if (/METHOD=NONE/i.test(l)) curKey = null;
      else { curKey = { uri: sub(attr(l, "URI")), iv: parseIV(l) }; if (!firstKey) firstKey = curKey; }
    } else if (l.startsWith("#EXTINF")) {
      let j = i + 1; while (j < lines.length && (lines[j].startsWith("#") || !lines[j].trim())) j++;
      if (lines[j]) segments.push({ url: sub(lines[j].trim()), key: curKey });
      i = j;
    }
  }
  return { init, segments, firstKey };
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

// ---------- shared ----------
async function getStreamContext() {
  const master = await fx(forceHls(JOB.manifestUrl), "text");
  const m = parseMaster(master);
  const videoMedia = parseMedia(await fx(m.videoUrl, "text"), m.vpk);
  return { m, videoMedia };
}
async function fetchTranscriptJSON(firstKey) {
  const raw = await fx(JOB.transcriptUrl, "buf");
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
  busy(true); log("Lecture du manifeste HLS…");
  const { m, videoMedia } = await getStreamContext();
  const audioMedia = m.audioUrl ? parseMedia(await fx(m.audioUrl, "text"), m.vpk) : null;
  log(`Vidéo : ${videoMedia.segments.length} segments${audioMedia ? `, audio : ${audioMedia.segments.length}` : " (audio inclus)"}`);

  const vShare = audioMedia ? 60 : 90, aShare = audioMedia ? 28 : 0;
  let vP = 0, aP = 0;
  const videoBuf = await buildTrack("vidéo", videoMedia, vShare, (p, s) => { vP = p; setPct(vP + aP); if (s) log(s); });
  let audioBuf = null;
  if (audioMedia) audioBuf = await buildTrack("audio", audioMedia, aShare, (p, s) => { aP = p; setPct(vP + aP); if (s) log(s); });

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
  const { videoMedia } = await getStreamContext();
  if (!videoMedia.firstKey) throw new Error("Clé de déchiffrement introuvable.");
  setPct(45); log("Déchiffrement du transcript…");
  const j = await fetchTranscriptJSON(videoMedia.firstKey);
  setPct(85);
  // Neutral MIME for .srt so Chrome keeps the extension (text/plain would force .txt).
  const map = { vtt: [toVTT(j), ".vtt", "text/vtt"], srt: [toSRT(j), ".srt", "application/octet-stream"], txt: [toTXT(j), ".txt", "text/plain"] };
  const [content, ext, mime] = map[fmt];
  await saveBytes(new TextEncoder().encode(content), base + ext, mime);
  setPct(100); log(`✓ Transcript (${(j.entries || []).length} segments).`, "done"); busy(false);
}

function guard(fn) {
  return async (...a) => {
    try { await fn(...a); }
    catch (e) { $("status").className = "status err"; $("status").textContent = "Échec : " + (e && e.message ? e.message : e);
      log("Astuce : le jeton expire vite — relancez la lecture puis réessayez.", "err"); busy(false); }
  };
}

// ---------- boot & live detection ----------
async function refresh() {
  const store = await chrome.storage.session.get(`capture_${tabId}`);
  const cap = store[`capture_${tabId}`] || {};
  if (!cap.manifestUrl || !cap.token) return false;

  JOB = { manifestUrl: cap.manifestUrl, token: cap.token, transcriptUrl: cap.transcriptUrl || null };
  $("status").className = "status ok";
  $("status").textContent = "✓ Vidéo détectée" + (cap.transcriptUrl ? " (transcript dispo)" : "");
  $("controls").hidden = false;
  $("trBlock").hidden = !cap.transcriptUrl;
  return true;
}

async function main() {
  // Prefill the filename from the SharePoint tab's title (not the panel's).
  try { const t = await chrome.tabs.get(tabId); if (t && t.title) $("fname").value = sanitize(t.title); }
  catch (e) { $("fname").value = "enregistrement"; }

  const ready = await refresh();
  if (!ready) {
    const poll = setInterval(async () => { if (await refresh()) clearInterval(poll); }, 1500);
  }

  $("dlVideo").addEventListener("click", guard(() => runVideo(sanitize($("fname").value))));
  document.querySelectorAll(".seg button").forEach((b) =>
    b.addEventListener("click", guard(() => runTranscript(sanitize($("fname").value), b.dataset.fmt)))
  );
}
main();
