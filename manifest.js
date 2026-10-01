// Manifest helpers shared by the panel (browser) and the unit tests (Node).
// Pure functions only: no chrome.* / DOM access, so everything here is testable.
//
// Background (Sept 2026): the SharePoint Stream player stopped requesting
// `…/videomanifest…`; it now fetches segments straight from
// `…/_api_cached/v2.1/drives/{d}/items/{i}/oneDrive.transcode?…`. The
// videomanifest endpoint itself still answers when asked directly, and its URL
// can be rebuilt from the page's `g_fileInfo` (same trick yt-dlp uses). So we
// no longer depend on sniffing a single request: we build candidate manifest
// URLs from several sources and try them in order, HLS first, then DASH.
(function (global) {
  "use strict";

  // ---------------------------------------------------------------- URL helpers
  const SEGMENT_PARAMS = ["part", "format", "track", "quality", "segmentTime", "wsd", "ppd", "ppst"];

  function splitUrl(u) {
    const h = u.indexOf("#");
    if (h >= 0) u = u.slice(0, h);
    const i = u.indexOf("?");
    return { base: i >= 0 ? u.slice(0, i) : u, query: i >= 0 ? u.slice(i + 1) : "" };
  }
  // String-level (never re-encodes values: signatures / tempauth stay byte-identical).
  function stripParams(url, names) {
    const { base, query } = splitUrl(url);
    const lower = names.map((n) => n.toLowerCase() + "=");
    const keep = query.split("&").filter((kv) => kv && !lower.some((p) => kv.toLowerCase().startsWith(p)));
    return keep.length ? base + "?" + keep.join("&") : base;
  }
  function setParam(url, name, value) {
    const u = stripParams(url, [name]);
    return u + (u.includes("?") ? "&" : "?") + name + "=" + value;
  }
  const AUTH_PARAM = /[?&](tempauth|access_token)=/i;
  const withFormat = (url, fmt) => setParam(url, "format", fmt);
  const toIndexUrl = (url) => setParam(stripParams(url, SEGMENT_PARAMS), "part", "index");

  // Ordered list of manifest "index" URLs (without format) to try.
  //  - capture   : a videomanifest request we saw the player make (legacy path)
  //  - pageToken : the same, authenticated with a drive access token from g_fileInfo
  //  - page      : rebuilt from g_fileInfo['.transformUrl'] (+ cTag, action=Access), like yt-dlp
  //  - transcode : an oneDrive.transcode segment request we saw, turned into part=index (best effort)
  function candidateIndexUrls(cap) {
    cap = cap || {};
    const out = [];
    const push = (source, url) => { if (url && !out.some((c) => c.url === url)) out.push({ source, url }); };

    if (cap.manifestUrl) push("capture", toIndexUrl(cap.manifestUrl));

    const fi = cap.fileInfo;
    if (fi && fi.transformUrl) {
      const { base, query } = splitUrl(fi.transformUrl);
      let url = base.replace(/\/[^/]*$/, "/videomanifest") + (query ? "?" + query : "");
      if (fi.ctag && !/[?&]cTag=/i.test(url)) url = setParam(url, "cTag", encodeURIComponent(fi.ctag));
      url = setParam(url, "action", "Access");
      url = setParam(url, "part", "index");
      // .transformUrl carries no credential: the svc.ms service then needs the
      // X-SPOPacToken header, only seen once playback starts. g_fileInfo also
      // holds drive access tokens, available on load, that the service accepts
      // as `tempauth` (checked Oct 2026: both work; as `access_token`, V21 is refused).
      if (!AUTH_PARAM.test(url)) {
        for (const tok of new Set([fi.driveAccessToken, fi.driveAccessTokenV21].filter(Boolean))) {
          push("pageToken", setParam(url, "tempauth", encodeURIComponent(tok)));
        }
      }
      push("page", url);
    }

    if (cap.transcodeUrl) push("transcode", toIndexUrl(cap.transcodeUrl));
    return out;
  }

  // For logs: hide anything that looks like a credential, keep the shape.
  function redact(url) {
    return String(url).replace(/([?&])(tempauth|access_token|token|P4|sig|signature)=[^&]*/gi, "$1$2=…");
  }

  const looksLikeHls = (t) => /^\s*#EXTM3U/.test(String(t));
  const looksLikeMpd = (t) => /<MPD[\s>]/i.test(String(t));

  // Thrown by any chrome.* call from an extension page that outlived a reload of the extension.
  const isContextInvalidated = (e) => !!(e && /extension context invalidated/i.test(e.message || ""));

  // ---------------------------------------------------------------- shared crypto bits
  function hexToIv(hex) {
    hex = String(hex || "").replace(/^0x/i, "").padStart(32, "0").slice(-32);
    const iv = new Uint8Array(16);
    for (let i = 0; i < 16; i++) iv[i] = parseInt(hex.substr(i * 2, 2), 16);
    return iv;
  }

  // ---------------------------------------------------------------- HLS
  const attr = (line, name) => { const m = line.match(new RegExp(name + '="([^"]*)"')); return m ? m[1] : null; };
  function parseIV(line) {
    const m = line.match(/IV=0x([0-9A-Fa-f]+)/);
    return hexToIv(m ? m[1] : "");
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

  // ---------------------------------------------------------------- DASH (MPD)
  // Minimal XML → tree. Enough for MPDs (no mixed content we care about, no DTD).
  function decodeEntities(s) {
    return s.replace(/&(amp|lt|gt|quot|apos|#(\d+)|#x([0-9a-fA-F]+));/g, (_, n, d, h) =>
      n === "amp" ? "&" : n === "lt" ? "<" : n === "gt" ? ">" : n === "quot" ? '"' : n === "apos" ? "'"
        : d ? String.fromCharCode(+d) : String.fromCharCode(parseInt(h, 16)));
  }
  const localName = (n) => n.slice(n.indexOf(":") + 1);
  function parseXml(xml) {
    xml = String(xml).replace(/<\?[\s\S]*?\?>/g, "").replace(/<!--[\s\S]*?-->/g, "").replace(/<!DOCTYPE[^>]*>/gi, "");
    const root = { name: "#root", attrs: {}, children: [], text: "" };
    const stack = [root];
    const re = /<\/([\w:.-]+)\s*>|<([\w:.-]+)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
    let m;
    while ((m = re.exec(xml))) {
      if (m[1]) { if (stack.length > 1) stack.pop(); }
      else if (m[2]) {
        const attrs = {};
        const ar = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g; let a;
        while ((a = ar.exec(m[3] || ""))) attrs[a[1]] = decodeEntities(a[2] != null ? a[2] : a[3]);
        const node = { name: localName(m[2]), attrs, children: [], text: "" };
        stack[stack.length - 1].children.push(node);
        if (!m[4]) stack.push(node);
      } else if (m[5]) stack[stack.length - 1].text += decodeEntities(m[5]);
    }
    return root;
  }
  const kids = (n, name) => n.children.filter((c) => c.name === name);
  const kid = (n, name) => kids(n, name)[0] || null;
  function descendants(n, name, acc) {
    acc = acc || [];
    for (const c of n.children) { if (c.name === name) acc.push(c); descendants(c, name, acc); }
    return acc;
  }
  function isoDuration(s) {
    const m = String(s || "").match(/^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:([\d.]+)S)?$/);
    if (!m) return 0;
    return (+(m[1] || 0)) * 86400 + (+(m[2] || 0)) * 3600 + (+(m[3] || 0)) * 60 + parseFloat(m[4] || "0");
  }
  function resolveBase(node, base) {
    const b = kid(node, "BaseURL");
    return b && b.text.trim() ? new URL(b.text.trim(), base).href : base;
  }
  function expandTemplate(tpl, repId, bandwidth, number, time) {
    return String(tpl)
      .replace(/\$RepresentationID\$/g, repId)
      .replace(/\$Bandwidth\$/g, bandwidth)
      .replace(/\$Number%0(\d+)d\$/g, (_, w) => String(number).padStart(parseInt(w, 10), "0"))
      .replace(/\$Number\$/g, String(number))
      .replace(/\$Time\$/g, String(time));
  }
  const HARD_DRM = ["edef8ba9-79d6-4ace-a3c8-27dcd51d21ed", "9a04f079-9840-4286-ab92-e65be0885f95", "94ce86fb-07ff-4f43-adb8-93d2fa968ca2"];

  function contentTypeOf(as) {
    const ct = (as.attrs.contentType || "").toLowerCase();
    if (ct) return ct;
    const mime = (as.attrs.mimeType || (kid(as, "Representation") || { attrs: {} }).attrs.mimeType || "").toLowerCase();
    return mime.startsWith("video") ? "video" : mime.startsWith("audio") ? "audio" : "";
  }

  // Returns { video:{init,segments,firstKey}, audio:{…}|null, hardDrm }.
  // Segment objects are { url, key } with key = { uri, iv } | null, same shape as parseMedia().
  function parseMpd(xml, manifestUrl) {
    const root = parseXml(xml);
    const mpd = kid(root, "MPD");
    if (!mpd) throw new Error("Manifeste DASH illisible.");

    const hardDrm = descendants(mpd, "ContentProtection").some((cp) => {
      const s = (cp.attrs.schemeIdUri || "").toLowerCase();
      return HARD_DRM.some((u) => s.includes(u));
    });

    const totalDur = isoDuration(mpd.attrs.mediaPresentationDuration);
    const mpdBase = resolveBase(mpd, manifestUrl);
    const tracks = { video: null, audio: null };

    for (const period of kids(mpd, "Period")) {
      const periodBase = resolveBase(period, mpdBase);
      const periodDur = isoDuration(period.attrs.duration) || totalDur;
      const sets = kids(period, "AdaptationSet");
      for (const as of sets) {
        let type = contentTypeOf(as);
        if (sets.length === 1 && !type) type = "video";
        if (type !== "video" && type !== "audio") continue;
        if (tracks[type]) continue; // first period wins (SharePoint manifests have one)

        const reps = kids(as, "Representation").sort((a, b) => (+b.attrs.bandwidth || 0) - (+a.attrs.bandwidth || 0));
        const rep = reps[0];
        if (!rep) continue;
        const tpl = kid(rep, "SegmentTemplate") || kid(as, "SegmentTemplate");
        if (!tpl) continue;

        const base = resolveBase(rep, resolveBase(as, periodBase));
        const repId = rep.attrs.id || "", bw = rep.attrs.bandwidth || "";
        const startNumber = parseInt(tpl.attrs.startNumber || "1", 10);
        const abs = (u) => new URL(u, base).href;

        // Encryption (DASH-SEA, AES-128-CBC with HTTP-fetchable key).
        let key = null;
        const sea = descendants(as, "ContentProtection").find((cp) => /urn:mpeg:dash:sea/i.test(cp.attrs.schemeIdUri || ""));
        if (sea) {
          const enc = kid(sea, "SegmentEncryption"), cp = kid(sea, "CryptoPeriod");
          const scheme = enc ? enc.attrs.schemeIdUri || "" : "";
          if (cp && cp.attrs.keyUriTemplate && /aes128-cbc/i.test(scheme || "aes128-cbc")) {
            key = { uri: abs(cp.attrs.keyUriTemplate), iv: hexToIv(cp.attrs.IV || "") };
          }
        }

        const init = tpl.attrs.initialization ? abs(expandTemplate(tpl.attrs.initialization, repId, bw, startNumber, 0)) : null;
        const segments = [];
        const media = tpl.attrs.media || "";
        const timeline = kid(tpl, "SegmentTimeline");
        if (timeline) {
          let t = 0, n = startNumber;
          for (const s of kids(timeline, "S")) {
            if (s.attrs.t != null) t = parseInt(s.attrs.t, 10);
            const d = parseInt(s.attrs.d || "0", 10), r = parseInt(s.attrs.r || "0", 10);
            for (let i = 0; i <= r; i++) { segments.push({ url: abs(expandTemplate(media, repId, bw, n, t)), key }); t += d; n++; }
          }
        } else {
          const d = parseInt(tpl.attrs.duration || "0", 10), ts = parseInt(tpl.attrs.timescale || "1", 10);
          const count = d > 0 && periodDur > 0 ? Math.ceil(periodDur / (d / ts)) : 0;
          for (let i = 0; i < count; i++) segments.push({ url: abs(expandTemplate(media, repId, bw, startNumber + i, i * d)), key });
        }
        tracks[type] = { init, segments, firstKey: key };
      }
    }

    if (!tracks.video) throw new Error("Aucun flux vidéo dans le manifeste DASH.");
    return { video: tracks.video, audio: tracks.audio, hardDrm };
  }

  const api = {
    candidateIndexUrls, withFormat, toIndexUrl, stripParams, redact, looksLikeHls, looksLikeMpd,
    parseMaster, parseMedia, parseMpd, hexToIv, isContextInvalidated,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  global.SPManifest = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
