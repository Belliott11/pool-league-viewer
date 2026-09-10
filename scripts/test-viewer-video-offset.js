// Standalone replica of the openGameAtTime + viewer-videos.js monkeypatch chain, run in plain
// Node (no browser) to verify the offset translation independent of any browser cache quirks.
let currentGameId = null;
let currentVideoEl = null;
const calls = [];

function openGame(gameId) {
  currentGameId = gameId;
  currentVideoEl = { currentTime: 0, played: false, play() { this.played = true; }, scrollIntoView() {} };
  calls.push(`openGame(${gameId})`);
}

function openGameAtTime(gameId, videoTime) {
  openGame(gameId);
  if (videoTime === null || videoTime === undefined) return;
  currentVideoEl.currentTime = videoTime; // synchronous stand-in for the real polling loop
  currentVideoEl.play();
}

// ---- viewer-videos.js's own patch, copied verbatim ----
const GAME_VIDEO_FILES = {
  "5gqbi2wxew52g5p": { file: "game-videos/5gqbi2wxew52g5p.mp4", videoStart: 1648.520637 },
};
const originalOpenGameAtTime = openGameAtTime;
openGameAtTime = function (gameId, videoTime) {
  const hosted = GAME_VIDEO_FILES[gameId];
  if (!hosted || videoTime === null || videoTime === undefined) {
    originalOpenGameAtTime(gameId, videoTime);
    return;
  }
  originalOpenGameAtTime(gameId, Math.max(0, videoTime - hosted.videoStart));
};
// ---- end patch ----

const rawVideoTime = 2026.870307;
openGameAtTime("5gqbi2wxew52g5p", rawVideoTime);

const expected = rawVideoTime - 1648.520637;
const ok = Math.abs(currentVideoEl.currentTime - expected) < 1e-6 && currentGameId === "5gqbi2wxew52g5p" && currentVideoEl.played;
console.log("currentGameId:", currentGameId);
console.log("currentTime:", currentVideoEl.currentTime, "expected:", expected);
console.log("played:", currentVideoEl.played);
console.log(ok ? "PASS" : "FAIL");
process.exit(ok ? 0 : 1);
