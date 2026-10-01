"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const M = require("../manifest.js");

// ---------------------------------------------------------------- URL helpers
const LEGACY_MANIFEST =
  "https://euwe-1.mediap.svc.ms/transform/videomanifest?provider=spo&inputFormat=mp4&cs=fFNQTw" +
  "&docid=https%3A%2F%2Ft-my.sharepoint.com%3A443%2F_api%2Fv2.0%2Fdrives%2Fb!x%2Fitems%2F01Y%3Fversion%3DPublished" +
  "&tempauth=eyJ0eXAi.AAA.BBB&format=dash&part=index&altManifestMetadata=foo";

const TRANSCODE_SEGMENT =
  "https://t-my.sharepoint.com/_api_cached/v2.1/drives/b!x/items/01Y/oneDrive.transcode?version=Published" +
  "&P1=1789744574&P2=545471889&P3=1&P4=dKOV1Lx1%2Fxup5%2BelD%3D%3D&VroomTakeover=1" +
  "&cTag=%22c%3a%7bc3c8baed%7d%2c2%22&format=fmp4&InputFormat=mp4&correlationid=b0e4&pn=hostApp-OnePlayer-spo" +
  "&enableEncryption=1&kid=cd94a5b1f9d.222252.31812&enableCdn=1&part=mediasegment&track=audio&quality=audcopy" +
  "&segmentTime=8951808&wsd=96256&ppd=65385472&ppst=0";

const FILE_INFO = {
  transformUrl:
    "https://euwe-1.mediap.svc.ms/transform/thumbnail?provider=spo&inputFormat=mp4&cs=fFNQTw" +
    "&docid=https%3A%2F%2Ft-my.sharepoint.com%3A443%2F_api%2Fv2.0%2Fdrives%2Fb!x%2Fitems%2F01Y%3Fversion%3DPublished" +
    "&width=800&height=600&tempauth=eyJ0eXAi.AAA.BBB",
  ctag: '"c:{c3c8baed-2c3d-4556-8e79-38ca0132d33f},2"',
};

test("candidateIndexUrls: legacy captured videomanifest keeps its query but drops format and sets part=index", () => {
  const [c] = M.candidateIndexUrls({ manifestUrl: LEGACY_MANIFEST });
  assert.equal(c.source, "capture");
  assert.ok(!/[?&]format=/.test(c.url), "format param must be removed");
  assert.equal((c.url.match(/[?&]part=index(?=&|$)/g) || []).length, 1);
  assert.ok(c.url.includes("&docid=https%3A%2F%2Ft-my.sharepoint.com%3A443"), "docid must stay verbatim");
  assert.ok(c.url.includes("&tempauth=eyJ0eXAi.AAA.BBB"), "tempauth must stay verbatim");
  assert.ok(c.url.includes("&altManifestMetadata=foo"));
});

test("candidateIndexUrls: builds the videomanifest URL from g_fileInfo like yt-dlp does", () => {
  const [c] = M.candidateIndexUrls({ fileInfo: FILE_INFO });
  assert.equal(c.source, "page");
  assert.ok(c.url.startsWith("https://euwe-1.mediap.svc.ms/transform/videomanifest?provider=spo&inputFormat=mp4&cs=fFNQTw&docid="));
  assert.ok(c.url.includes("&tempauth=eyJ0eXAi.AAA.BBB"));
  assert.ok(c.url.includes("&cTag=%22c%3A%7Bc3c8baed-2c3d-4556-8e79-38ca0132d33f%7D%2C2%22"));
  assert.ok(c.url.includes("&action=Access"));
  assert.ok(/&part=index$/.test(c.url));
  assert.ok(!c.url.includes("thumbnail"));
});

test("candidateIndexUrls: g_fileInfo without transformUrl yields nothing", () => {
  assert.deepEqual(M.candidateIndexUrls({ fileInfo: { ctag: "x" } }), []);
  assert.deepEqual(M.candidateIndexUrls({}), []);
});

test("candidateIndexUrls: authenticates the page URL with g_fileInfo's drive tokens (both param names) before the bare one", () => {
  const transformUrl = "https://fc-1.mediap.svc.ms/transform/thumbnail?provider=spo&docid=https%3A%2F%2Ft.sharepoint.com%2Fx";
  const cands = M.candidateIndexUrls({ fileInfo: { transformUrl, driveAccessToken: "v1.AB+c/d=", driveAccessTokenV21: "v1.AB+c/d=" } });
  assert.deepEqual(cands.map((c) => c.source), ["pageToken", "pageToken", "page"]);
  assert.ok(/&part=index&tempauth=v1\.AB%2Bc%2Fd%3D$/.test(cands[0].url), "token must be URL-encoded");
  assert.ok(/&part=index&access_token=v1\.AB%2Bc%2Fd%3D$/.test(cands[1].url));
  assert.ok(!/tempauth|access_token/.test(cands[2].url));
});

test("candidateIndexUrls: a transformUrl that already carries tempauth gets no extra token", () => {
  const cands = M.candidateIndexUrls({ fileInfo: { ...FILE_INFO, driveAccessToken: "tok" } });
  assert.deepEqual(cands.map((c) => c.source), ["page"]);
});

test("candidateIndexUrls: turns a captured oneDrive.transcode segment URL into an index URL", () => {
  const [c] = M.candidateIndexUrls({ transcodeUrl: TRANSCODE_SEGMENT });
  assert.equal(c.source, "transcode");
  for (const p of ["track", "quality", "segmentTime", "wsd", "ppd", "ppst", "format"]) {
    assert.ok(!new RegExp("[?&]" + p + "=").test(c.url), p + " must be removed");
  }
  assert.ok(c.url.includes("&P4=dKOV1Lx1%2Fxup5%2BelD%3D%3D"), "signature must stay verbatim");
  assert.ok(c.url.includes("&cTag=%22c%3a%7bc3c8baed%7d%2c2%22"));
  assert.ok(c.url.includes("&kid=cd94a5b1f9d.222252.31812"));
  assert.ok(/&part=index$/.test(c.url));
});

test("candidateIndexUrls: order is capture, page, transcode and duplicates are removed", () => {
  const all = M.candidateIndexUrls({ manifestUrl: LEGACY_MANIFEST, fileInfo: FILE_INFO, transcodeUrl: TRANSCODE_SEGMENT });
  assert.deepEqual(all.map((c) => c.source), ["capture", "page", "transcode"]);
  const dup = M.candidateIndexUrls({ manifestUrl: LEGACY_MANIFEST, transcodeUrl: LEGACY_MANIFEST });
  assert.equal(dup.length, 1);
});

test("withFormat replaces any existing format param", () => {
  assert.equal(M.withFormat("https://h/x?a=1&format=dash&part=index", "hls"), "https://h/x?a=1&part=index&format=hls");
  assert.equal(M.withFormat("https://h/x", "dash"), "https://h/x?format=dash");
});

test("redact hides signatures and tokens but keeps the shape of the URL", () => {
  const r = M.redact(TRANSCODE_SEGMENT + "&tempauth=SECRET&access_token=SECRET2");
  assert.ok(!r.includes("dKOV1Lx1"), "P4 hidden");
  assert.ok(!r.includes("SECRET"), "tempauth/access_token hidden");
  assert.ok(r.includes("oneDrive.transcode?"));
  assert.ok(r.includes("part=mediasegment"));
});

// ---------------------------------------------------------------- DASH (MPD)
const MPD_BASE = "https://t-my.sharepoint.com/_api_cached/v2.1/drives/b!x/items/01Y/";
const SEA = `
      <ContentProtection schemeIdUri="urn:mpeg:dash:sea:2012" xmlns:sea="urn:mpeg:dash:schema:sea:2012">
        <sea:SegmentEncryption schemeIdUri="urn:mpeg:dash:sea:aes128-cbc:2013"/>
        <sea:CryptoPeriod IV="0x0102030405060708090A0B0C0D0E0F10" keyUriTemplate="https://euwe-1.mediap.svc.ms/transform/videomanifest?provider=spo&amp;part=key&amp;tempauth=T"/>
      </ContentProtection>`;
const MPD = `<?xml version="1.0" encoding="utf-8"?>
<!-- generated -->
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT0H0M25.0S" minBufferTime="PT2S">
  <BaseURL>${MPD_BASE}</BaseURL>
  <Period>
    <AdaptationSet contentType="video" mimeType="video/mp4" segmentAlignment="true">${SEA}
      <SegmentTemplate timescale="10000000" startNumber="1"
        initialization="oneDrive.transcode?version=Published&amp;format=fmp4&amp;part=init&amp;track=video&amp;quality=$RepresentationID$"
        media="oneDrive.transcode?version=Published&amp;format=fmp4&amp;part=mediasegment&amp;track=video&amp;quality=$RepresentationID$&amp;segmentTime=$Time$">
        <SegmentTimeline>
          <S t="0" d="100000000" r="1"/>
          <S d="50000000"/>
        </SegmentTimeline>
      </SegmentTemplate>
      <Representation id="v720p" bandwidth="1500000" width="1280" height="720" codecs="avc1.64001F"/>
      <Representation id="v1080p" bandwidth="3000000" width="1920" height="1080" codecs="avc1.640028"/>
    </AdaptationSet>
    <AdaptationSet contentType="audio" mimeType="audio/mp4">${SEA}
      <Representation id="audcopy" bandwidth="128000" codecs="mp4a.40.2">
        <SegmentTemplate timescale="10000000" startNumber="1"
          initialization="oneDrive.transcode?part=init&amp;track=audio&amp;quality=$RepresentationID$"
          media="oneDrive.transcode?part=mediasegment&amp;track=audio&amp;quality=$RepresentationID$&amp;segmentTime=$Time$">
          <SegmentTimeline><S t="0" d="100000000" r="2"/></SegmentTimeline>
        </SegmentTemplate>
      </Representation>
    </AdaptationSet>
  </Period>
</MPD>`;

test("parseMpd: picks the highest-bandwidth video representation and expands the timeline", () => {
  const r = M.parseMpd(MPD, "https://euwe-1.mediap.svc.ms/transform/videomanifest?x=1&format=dash&part=index");
  assert.equal(r.hardDrm, false);
  assert.equal(r.video.init, MPD_BASE + "oneDrive.transcode?version=Published&format=fmp4&part=init&track=video&quality=v1080p");
  assert.deepEqual(r.video.segments.map((s) => s.url), [0, 100000000, 200000000].map((t) =>
    MPD_BASE + "oneDrive.transcode?version=Published&format=fmp4&part=mediasegment&track=video&quality=v1080p&segmentTime=" + t));
});

test("parseMpd: exposes the SEA AES-128-CBC key (uri + iv) on every segment and as firstKey", () => {
  const r = M.parseMpd(MPD, "https://h/m");
  const key = r.video.firstKey;
  assert.equal(key.uri, "https://euwe-1.mediap.svc.ms/transform/videomanifest?provider=spo&part=key&tempauth=T");
  assert.deepEqual(Array.from(key.iv), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
  assert.ok(r.video.segments.every((s) => s.key === key));
  assert.equal(r.audio.firstKey.uri, key.uri);
});

test("parseMpd: audio track uses its representation-level template (r=2 gives 3 segments)", () => {
  const r = M.parseMpd(MPD, "https://h/m");
  assert.equal(r.audio.init, MPD_BASE + "oneDrive.transcode?part=init&track=audio&quality=audcopy");
  assert.equal(r.audio.segments.length, 3);
  assert.ok(r.audio.segments[2].url.endsWith("&segmentTime=200000000"));
});

test("parseMpd: without SegmentTimeline, derives the segment count from duration/timescale and $Number$", () => {
  const xml = `<MPD mediaPresentationDuration="PT25S"><Period><AdaptationSet contentType="video" mimeType="video/mp4">
    <SegmentTemplate timescale="1000" duration="10000" startNumber="1" initialization="i/$RepresentationID$.mp4" media="s/$RepresentationID$/$Number%03d$.m4s"/>
    <Representation id="v" bandwidth="1"/></AdaptationSet></Period></MPD>`;
  const r = M.parseMpd(xml, "https://h/dir/manifest?format=dash");
  assert.equal(r.video.init, "https://h/dir/i/v.mp4");
  assert.deepEqual(r.video.segments.map((s) => s.url), ["https://h/dir/s/v/001.m4s", "https://h/dir/s/v/002.m4s", "https://h/dir/s/v/003.m4s"]);
  assert.equal(r.video.firstKey, null);
  assert.equal(r.audio, null);
});

test("parseMpd: flags Widevine/PlayReady ContentProtection as hard DRM", () => {
  const xml = `<MPD><Period><AdaptationSet contentType="video" mimeType="video/mp4">
    <ContentProtection schemeIdUri="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"/>
    <SegmentTemplate timescale="1" duration="1" initialization="i" media="m$Number$"/><Representation id="v" bandwidth="1"/>
    </AdaptationSet></Period></MPD>`;
  assert.equal(M.parseMpd(xml, "https://h/m").hardDrm, true);
});

test("parseMpd: throws a clear error when no video adaptation set is present", () => {
  assert.throws(() => M.parseMpd("<MPD><Period></Period></MPD>", "https://h/m"), /Aucun flux vidéo/);
});

// ---------------------------------------------------------------- HLS (moved from panel.js, characterisation)
const MASTER = `#EXTM3U
#EXT-X-DEFINE:NAME="commonVpkUrlVariable",VALUE="https://cdn.svc.ms/vpk?x=1"
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="audio",URI="https://h/audio.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=1000,AUDIO="audio"
https://h/v720.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=3000,AUDIO="audio"
https://h/v1080.m3u8
`;
const MEDIA = `#EXTM3U
#EXT-X-MAP:URI="{$commonVpkUrlVariable}&part=init"
#EXT-X-KEY:METHOD=AES-128,URI="{$commonVpkUrlVariable}&part=key",IV=0x0A
#EXTINF:4.0,
{$commonVpkUrlVariable}&part=mediasegment&segmentTime=0
#EXTINF:4.0,
{$commonVpkUrlVariable}&part=mediasegment&segmentTime=1
`;

test("parseMaster picks the highest bandwidth variant and its audio group", () => {
  const m = M.parseMaster(MASTER);
  assert.equal(m.videoUrl, "https://h/v1080.m3u8");
  assert.equal(m.audioUrl, "https://h/audio.m3u8");
  assert.equal(m.vpk, "https://cdn.svc.ms/vpk?x=1");
});

test("parseMedia resolves {$commonVpkUrlVariable}, init, key and IV", () => {
  const md = M.parseMedia(MEDIA, "https://cdn.svc.ms/vpk?x=1");
  assert.equal(md.init, "https://cdn.svc.ms/vpk?x=1&part=init");
  assert.equal(md.segments.length, 2);
  assert.equal(md.segments[1].url, "https://cdn.svc.ms/vpk?x=1&part=mediasegment&segmentTime=1");
  assert.equal(md.firstKey.uri, "https://cdn.svc.ms/vpk?x=1&part=key");
  assert.equal(md.firstKey.iv[15], 10);
});

test("looksLikeHls / looksLikeMpd sniff the manifest body", () => {
  assert.equal(M.looksLikeHls("#EXTM3U\n#EXT-X-VERSION:6"), true);
  assert.equal(M.looksLikeHls(MPD), false);
  assert.equal(M.looksLikeMpd(MPD), true);
  assert.equal(M.looksLikeMpd("<html>access denied</html>"), false);
});

// ---------------------------------------------------------------- runtime errors
test("isContextInvalidated recognises the error thrown by a stale extension page after a reload", () => {
  assert.equal(M.isContextInvalidated(new Error("Extension context invalidated.")), true);
  assert.equal(M.isContextInvalidated({ message: "extension context invalidated" }), true);
  assert.equal(M.isContextInvalidated(new Error("HTTP 401")), false);
  assert.equal(M.isContextInvalidated(null), false);
});
