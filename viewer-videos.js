// Full per-game video hosting for the friends viewer, without YouTube — real game video only
// ever lives in Ben's own browser storage and never makes it into a data export, so these files
// were produced separately: each one is that game's own actual segment (game.videoStart through
// game.videoEnd) extracted straight from the real session recording and re-encoded down (720p,
// libx264 CRF 26) to stay well under GitHub's 100MB per-file limit — not the raw, multi-game
// session file, which would blow past that limit for several of these games.
//
// Every stored timestamp in this app (Shot Log's videoTime, a Reel clip's start/end, everything
// Jump buttons seek to) is an ABSOLUTE time within that original, untrimmed session recording —
// exactly what you'd expect, since that's the only video that existed when those timestamps were
// captured. A trimmed file's own timeline starts over at 0 instead, so a Jump button click
// (createJumpButton(videoTime) sets currentVideoEl.currentTime = videoTime directly) needs
// videoTime translated by this game's own videoStart before it means anything on the trimmed
// file. The first version of this tried to do that transparently — wrapping the video element's
// own `currentTime` property via Object.defineProperty so every existing caller kept working
// completely unmodified — but real testing showed that doesn't work: calling a media element's
// native currentTime setter borrowed via Object.getOwnPropertyDescriptor(...).call(el, value)
// updates the reported number but never actually triggers a real seek, so the video silently
// stays wherever it already was. Patched at the one place seeking to an absolute timestamp
// actually happens instead: a capture-phase click listener added onto every Jump button, which
// runs before the original (unaware of any offset) listener and does the correct seek itself,
// then stops the original from also firing with the wrong, untranslated value.
const GAME_VIDEO_FILES = {
  "jmyhhago9gvrteb": { file: "game-videos/jmyhhago9gvrteb.mp4", videoStart: 270.982498 },
  "wurjg3g9xhehuka": { file: "game-videos/wurjg3g9xhehuka.mp4", videoStart: 101.506579 },
  "ctqc73n67cph45y": { file: "game-videos/ctqc73n67cph45y.mp4", videoStart: 341.058676 },
  "spqwa4x7i5ylpdx": { file: "game-videos/spqwa4x7i5ylpdx.mp4", videoStart: 867.127141 },
  "5gqbi2wxew52g5p": { file: "game-videos/5gqbi2wxew52g5p.mp4", videoStart: 1648.520637 },
  "w2gvgk88n6e4had": { file: "game-videos/w2gvgk88n6e4had.mp4", videoStart: 266.796227 },
  "g7ko31w6njargwe": { file: "game-videos/g7ko31w6njargwe.mp4", videoStart: 997.610333 },
  "cmgf3z9rea2l7rc": { file: "game-videos/cmgf3z9rea2l7rc.mp4", videoStart: 1555.610311 },
  "bl46f6scpfe9ib6": { file: "game-videos/bl46f6scpfe9ib6.mp4", videoStart: 335 },
  "yf7wfx0jbtzy468": { file: "game-videos/yf7wfx0jbtzy468.mp4", videoStart: 1128.538937 }
};

(function () {
  const originalRenderVideoPanel = renderVideoPanel;
  renderVideoPanel = function (game) {
    const hosted = GAME_VIDEO_FILES[game.id];
    if (!hosted) { originalRenderVideoPanel(game); return; }

    document.getElementById("videoUrlInput").value = game.videoUrl || "";
    const wrap = document.getElementById("videoPlayerWrap");
    const key = `hosted:${game.id}`;
    if (key === renderedVideoKey && wrap.querySelector("video")) { updateReelButtons(); return; }
    renderedVideoKey = key;
    wrap.innerHTML = `<video controls src="${hosted.file}"></video>`;
    currentVideoEl = wrap.querySelector("video");
    updateReelButtons();
  };

  const originalCreateJumpButton = createJumpButton;
  createJumpButton = function (videoTime) {
    const btn = originalCreateJumpButton(videoTime);
    btn.addEventListener("click", e => {
      const game = state.games.find(g => g.id === currentGameId);
      const hosted = game && GAME_VIDEO_FILES[game.id];
      if (!hosted || !currentVideoEl || videoTime === null || videoTime === undefined) return;
      e.stopImmediatePropagation();
      currentVideoEl.currentTime = Math.max(0, videoTime - hosted.videoStart);
      currentVideoEl.play();
      currentVideoEl.scrollIntoView({ behavior: "smooth", block: "center" });
    }, true); // capture phase — runs before the original's own (offset-unaware) listener
    return btn;
  };
})();
