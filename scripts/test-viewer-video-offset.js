// Standalone replica of the loadInlineVideo + viewer-videos.js monkeypatch chain, run in plain
// Node (no browser) to verify the offset translation independent of any browser cache quirks.
async function loadInlineVideo(game, videoEl, videoTime) {
  videoEl.src = `blob:master-${game.id}`; // stand-in for the real IndexedDB blob resolution
  videoEl.dataset.loadedUrl = videoEl.src;
  if (videoTime !== null && videoTime !== undefined) videoEl.currentTime = videoTime;
  videoEl.play();
  return true;
}

// ---- viewer-videos.js's own patch, copied verbatim (structure), against a fake videoEl ----
const GAME_VIDEO_FILES = {
  "5gqbi2wxew52g5p": { file: "game-videos/5gqbi2wxew52g5p.mp4", videoStart: 1648.520637 },
};
const originalLoadInlineVideo = loadInlineVideo;
loadInlineVideo = async function (game, videoEl, videoTime) {
  const hosted = GAME_VIDEO_FILES[game.id];
  if (!hosted) return originalLoadInlineVideo(game, videoEl, videoTime);
  if (videoEl.dataset.loadedUrl !== hosted.file) {
    videoEl.src = hosted.file;
    videoEl.dataset.loadedUrl = hosted.file;
  }
  const translated = videoTime === null || videoTime === undefined ? videoTime : Math.max(0, videoTime - hosted.videoStart);
  videoEl.currentTime = translated;
  videoEl.play();
  return true;
};
// ---- end patch ----

async function main() {
  const videoEl = { dataset: {}, currentTime: 0, played: false, play() { this.played = true; } };
  const rawVideoTime = 2026.870307;
  await loadInlineVideo({ id: "5gqbi2wxew52g5p" }, videoEl, rawVideoTime);

  const expected = rawVideoTime - 1648.520637;
  const ok = Math.abs(videoEl.currentTime - expected) < 1e-6
    && videoEl.src === "game-videos/5gqbi2wxew52g5p.mp4"
    && videoEl.played;
  console.log("src:", videoEl.src);
  console.log("currentTime:", videoEl.currentTime, "expected:", expected);
  console.log("played:", videoEl.played);
  console.log(ok ? "PASS" : "FAIL");
  process.exit(ok ? 0 : 1);
}

main();
