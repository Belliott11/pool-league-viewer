// Wires the marked highlight/lowlight clips into the League Highlights table on the Leaderboard.
// The clip files themselves were extracted locally (ffmpeg, 5s padding on each side of the
// marked moment) from the real session video files, since video only ever lives in Ben's own
// browser storage and never makes it into a data export. app.js itself is untouched — this file
// loads after it and wraps renderLeagueHighlights() to add a "Watch" toggle per row, only where a
// clip file actually exists for that play's id, so this stays an easy diff against the main
// dashboard rather than a fork of it.
const LEAGUE_CLIP_FILES = {
  "play_mtge4syvnzd1b": "clips/play_mtge4syvnzd1b.mp4",
  "play_mtge6jcbd68cp": "clips/play_mtge6jcbd68cp.mp4",
  "play_mtgeuw2ae2r1i": "clips/play_mtgeuw2ae2r1i.mp4",
  "play_mtge8fwrc3gmb": "clips/play_mtge8fwrc3gmb.mp4",
  "play_mtgebqs0910zz": "clips/play_mtgebqs0910zz.mp4",
  "play_mtbzejnp8i8wz": "clips/play_mtbzejnp8i8wz.mp4",
  "play_mtc1eul7q9jly": "clips/play_mtc1eul7q9jly.mp4",
  "play_mtgeis7xbwnoa": "clips/play_mtgeis7xbwnoa.mp4",
  "play_mtavzjf9nrhbg": "clips/play_mtavzjf9nrhbg.mp4",
  "play_mtarf3hyn9rfn": "clips/play_mtarf3hyn9rfn.mp4"
};

(function () {
  const original = renderLeagueHighlights;
  renderLeagueHighlights = function () {
    original();
    const clips = computeLeagueHighlights();
    const rows = document.querySelectorAll("#leagueHighlightsBody tr");
    clips.forEach((clip, i) => {
      const file = LEAGUE_CLIP_FILES[clip.id];
      const tr = rows[i];
      if (!file || !tr) return;
      const tdBtn = tr.lastElementChild;
      const watchBtn = document.createElement("button");
      watchBtn.type = "button";
      watchBtn.className = "secondary-btn";
      watchBtn.textContent = "▶ Watch";
      watchBtn.style.marginLeft = "6px";
      watchBtn.addEventListener("click", () => {
        const existing = tr.nextElementSibling;
        if (existing && existing.classList.contains("clip-video-row")) {
          existing.remove();
          return;
        }
        document.querySelectorAll(".clip-video-row").forEach(r => r.remove());
        const videoRow = document.createElement("tr");
        videoRow.className = "clip-video-row";
        const td = document.createElement("td");
        td.colSpan = 6;
        td.style.padding = "10px 0";
        td.innerHTML = `<video controls autoplay src="${file}" style="max-width:100%;max-height:70vh;border-radius:var(--radius-sm, 8px);display:block;margin:0 auto;"></video>`;
        videoRow.appendChild(td);
        tr.after(videoRow);
      });
      tdBtn.appendChild(watchBtn);
    });
  };
})();
