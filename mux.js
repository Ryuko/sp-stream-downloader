// Pure-JS fragmented-MP4 remuxer: combine a video-only fMP4 track and an
// audio-only fMP4 track (already distinct track IDs) into one playable MP4.
// No wasm, no SharedArrayBuffer — works in a browser extension page and in Node.
(function (global) {
  "use strict";

  function u32(b, o) { return (b[o] * 0x1000000 + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3]) >>> 0; }
  function setU32(b, o, v) { b[o] = (v >>> 24) & 255; b[o + 1] = (v >>> 16) & 255; b[o + 2] = (v >>> 8) & 255; b[o + 3] = v & 255; }
  function typeAt(b, i) { return String.fromCharCode(b[i + 4], b[i + 5], b[i + 6], b[i + 7]); }

  function header(b, i) {
    let size = u32(b, i), hs = 8;
    if (size === 1) { size = u32(b, i + 8) * 0x100000000 + u32(b, i + 12); hs = 16; }
    else if (size === 0) size = b.length - i;
    return { size: size, hs: hs, type: typeAt(b, i) };
  }
  function topBoxes(b) {
    const out = []; let i = 0;
    while (i + 8 <= b.length) { const h = header(b, i); out.push({ type: h.type, start: i, size: h.size, hs: h.hs }); i += h.size; }
    return out;
  }
  function findChild(b, start, end, type) {
    let i = start;
    while (i + 8 <= end) { const h = header(b, i); if (h.type === type) return { start: i, size: h.size, hs: h.hs }; i += h.size; }
    return null;
  }
  const view = (b, start, size) => b.subarray(start, start + size);
  const copy = (b, start, size) => b.slice(start, start + size);

  function makeBox(type, chunks) {
    let len = 8; for (const c of chunks) len += c.length;
    const out = new Uint8Array(len);
    setU32(out, 0, len);
    out[4] = type.charCodeAt(0); out[5] = type.charCodeAt(1); out[6] = type.charCodeAt(2); out[7] = type.charCodeAt(3);
    let o = 8; for (const c of chunks) { out.set(c, o); o += c.length; }
    return out;
  }
  function concat(parts) {
    let len = 0; for (const p of parts) len += p.length;
    const out = new Uint8Array(len); let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
  }

  // moov children we need
  function moovParts(b) {
    const boxes = topBoxes(b);
    const ftyp = boxes.find((x) => x.type === "ftyp");
    const moov = boxes.find((x) => x.type === "moov");
    if (!moov) throw new Error("moov introuvable dans une piste");
    const ms = moov.start + moov.hs, me = moov.start + moov.size;
    const mvhd = findChild(b, ms, me, "mvhd");
    const trak = findChild(b, ms, me, "trak");
    const mvex = findChild(b, ms, me, "mvex");
    if (!mvhd || !trak || !mvex) throw new Error("Structure moov inattendue (mvhd/trak/mvex)");
    const trex = findChild(b, mvex.start + mvex.hs, mvex.start + mvex.size, "trex");
    return { boxes, ftyp, mvhd, trak, mvex, trex };
  }

  // collect [{moof(copy), mdat(view)}] fragments
  function collectFrags(b, boxes) {
    const frags = [];
    for (let i = 0; i < boxes.length; i++) {
      if (boxes[i].type === "moof") {
        const moof = copy(b, boxes[i].start, boxes[i].size);
        let mdat = null;
        if (i + 1 < boxes.length && boxes[i + 1].type === "mdat") mdat = view(b, boxes[i + 1].start, boxes[i + 1].size);
        frags.push({ moof: moof, mdat: mdat });
      }
    }
    return frags;
  }
  // set mfhd.sequence_number inside a moof copy
  function setSeq(moof, seq) {
    const mfhd = findChild(moof, 8, moof.length, "mfhd");
    if (mfhd) setU32(moof, mfhd.start + 12, seq); // size+type(8)+version/flags(4) => seq at +12
  }

  function remux(video, audio) {
    const V = moovParts(video), A = moovParts(audio);

    // mvhd' : copy of video's, next_track_id = 3 (v0 => last 4 bytes)
    const mvhd = copy(video, V.mvhd.start, V.mvhd.size);
    if (mvhd[8] === 0) setU32(mvhd, mvhd.length - 4, 3);

    const trakV = view(video, V.trak.start, V.trak.size);
    const trakA = view(audio, A.trak.start, A.trak.size);
    const trexV = view(video, V.trex.start, V.trex.size);
    const trexA = view(audio, A.trex.start, A.trex.size);

    const mvex = makeBox("mvex", [trexV, trexA]);
    const moov = makeBox("moov", [mvhd, trakV, trakA, mvex]);
    const ftyp = view(video, V.ftyp.start, V.ftyp.size);

    const vf = collectFrags(video, V.boxes);
    const af = collectFrags(audio, A.boxes);

    const parts = [ftyp, moov];
    let seq = 1;
    const n = Math.max(vf.length, af.length);
    for (let i = 0; i < n; i++) {
      if (i < vf.length) { setSeq(vf[i].moof, seq++); parts.push(vf[i].moof); if (vf[i].mdat) parts.push(vf[i].mdat); }
      if (i < af.length) { setSeq(af[i].moof, seq++); parts.push(af[i].moof); if (af[i].mdat) parts.push(af[i].mdat); }
    }
    return concat(parts);
  }

  const api = { remux: remux };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  global.FMP4Mux = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
