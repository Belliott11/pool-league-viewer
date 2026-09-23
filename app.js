// Pool League Stat Tracker
// All data lives in localStorage under STORAGE_KEY. See README.md for the JSON schema.
// Teams are picked fresh each game (pickup-style), so the roster is one league-wide list
// of players, and each game assigns players to "Team A" / "Team B" for that game only.

const STORAGE_KEY = "poolLeagueStatTracker";
const THEME_KEY = "poolLeagueTheme"; // "light" | "dark" — absent means "follow system"
const UI_STATE_KEY = "poolLeagueUiState"; // last tab + game/player in view, so a reload lands back where you were
// By the time you've reacted and clicked to log a play, playback is already a few seconds past
// it — so every captured timestamp is backed up this many seconds, landing Jump a beat before
// the play instead of right on top of (or after) it.
const TIMESTAMP_LEAD_SECONDS = 5;
// How far a single Left/Right arrow key press seeks the loaded video.
const SEEK_STEP_SECONDS = 5;
const STAT_FIELDS = ["pts", "oreb", "dreb", "ast", "stl", "blk", "tov", "pf"];
const STAT_LABELS = { pts: "PTS", oreb: "OREB", dreb: "DREB", ast: "AST", stl: "STL", blk: "BLK", tov: "TOV", pf: "PF" };

// A game only counts toward the app's own computed stats (Leaderboard rates, awards, per-player
// trend charts, League Shot Heatmap, Matchup Grid, and every other comparative panel) when its
// two rosters are the same size — a 3-on-2 (or any other imbalanced) game changes the game's own
// competitive shape enough that pooling its per-player numbers into an otherwise-comparable "per
// 20 combined points" rate isn't a fair mix. Hidden behind a toggle rather than silently and
// permanently dropped — default excluded, same reversible-choice spirit as the advanced-columns
// toggle. Imbalanced games stay fully visible everywhere that isn't a season/league comparison —
// the Games list, Stat Entry, Game Log, CSV exports, Highlights & Lowlights — this only gates the
// app's own computed comparisons, never the underlying record of what actually happened.
const INCLUDE_IMBALANCED_KEY = "poolLeagueIncludeImbalancedGames";
let includeImbalancedGames = localStorage.getItem(INCLUDE_IMBALANCED_KEY) === "true";
function isBalancedGame(game) {
  return game.teamA.length === game.teamB.length;
}

// A game also only counts toward the current season by default — Start New Season (Export →
// Data Management) never deletes games, it just sets state.currentSeasonStartedAt to the day
// it was clicked, archiving everything before that behind a boundary rather than losing it.
// Hidden behind its own toggle, same reversible-choice pattern as the imbalanced-games one
// above — off by default (a new season should start clean), on to blend archived seasons back
// into every computed comparison. A tracker that's never had a season closed has
// currentSeasonStartedAt === null, so every game counts as "current" and this is a no-op.
const INCLUDE_PAST_SEASONS_KEY = "poolLeagueIncludePastSeasons";
// Per-browser backup bookkeeping (see Backups below); up here because saveState() uses it and can run during page load.
const BACKUP_META_KEY = "poolLeagueBackupMeta";
const BACKUP_NUDGE_DAYS = 7;
let includePastSeasons = localStorage.getItem(INCLUDE_PAST_SEASONS_KEY) === "true";
function isCurrentSeasonGame(game) {
  return !state.currentSeasonStartedAt || (game.date || "") >= state.currentSeasonStartedAt;
}
function isQualifyingGame(game) {
  return game.scoringEvents.length > 0
    && (includeImbalancedGames || isBalancedGame(game))
    && (includePastSeasons || isCurrentSeasonGame(game));
}

// On by default (unlike the two toggles above) — outliers being included is the original,
// always-been-true behavior, so "on" here means "same as before this toggle existed," not an
// opt-in change. Named/phrased to match the other two anyway ("Include X"): checked = included
// (normal), unchecked = excluded. This one can't live inside isQualifyingGame() itself, though,
// since "outlier" is inherently a per-player question (a wild game for Player A might be a
// totally normal one for Player B who shared it), not a blanket per-game one. Every per-player
// stat computation that used to inline its own `state.games.filter(g => isQualifyingGame(g) &&
// (g.teamA.includes(playerId) || g.teamB.includes(playerId)))` now goes through
// qualifyingGamesForPlayer(playerId) below instead, so this toggle reaches computeLeaderboard(),
// Two-Way Trend, Teammate Synergy/Quality, and both Matchup Difficulty charts — everywhere a
// player's own rate stats get built game by game. It deliberately does NOT reach panels that pool
// many players' shots within the same game (League Heatmap, Matchup Grid, Assist Connections,
// Head-to-Head, Balance Teams' chemistry/win-rate maps, etc.) — those have no single player to
// compute an outlier bound against, and excluding a whole game from them because it was an
// outlier for one specific player would silently drop other players' perfectly normal data too.
const INCLUDE_OUTLIER_GAMES_KEY = "poolLeagueIncludeOutlierGames";
let includeOutlierGames = localStorage.getItem(INCLUDE_OUTLIER_GAMES_KEY) !== "false";

// Linear-interpolation quantile (the same method most stats software defaults to for Q1/Q3).
function quantile(sortedValues, q) {
  const pos = (sortedValues.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  return sortedValues[base + 1] !== undefined
    ? sortedValues[base] + rest * (sortedValues[base + 1] - sortedValues[base])
    : sortedValues[base];
}

// Below this many qualifying games, IQR bounds are too noisy to mean anything (Q1/Q3 on 2-3
// points are basically just the points themselves) — nothing gets excluded and every game counts,
// same as the toggle being off.
const OUTLIER_MIN_GAMES = 4;

// The classic 1.5×IQR rule, applied to a player's own per-game Two-Way/20 — computed fresh from
// their own games every time, never a stored/cached bound, so it can't go stale as new games get
// logged. Bounds are computed once against the *full* qualifying set, not recomputed after each
// exclusion, since iteratively tightening the bounds would just keep eating into legitimately
// normal games.
function qualifyingGamesForPlayer(playerId) {
  const base = state.games.filter(g => isQualifyingGame(g) && (g.teamA.includes(playerId) || g.teamB.includes(playerId)));
  if (includeOutlierGames || base.length < OUTLIER_MIN_GAMES) return base;
  const withTwoWay = base.map(g => ({ game: g, twoWay: computeRateSummaryForGames(playerId, [g]).twoWayPer20 }));
  const sorted = [...withTwoWay.map(x => x.twoWay)].sort((a, b) => a - b);
  const q1 = quantile(sorted, 0.25);
  const q3 = quantile(sorted, 0.75);
  const iqr = q3 - q1;
  const lowerBound = q1 - 1.5 * iqr;
  const upperBound = q3 + 1.5 * iqr;
  return withTwoWay.filter(x => x.twoWay >= lowerBound && x.twoWay <= upperBound).map(x => x.game);
}

// STL/TOV/PF each tag the one opponent involved — single-select, unlike shot defenders,
// since these are inherently one-on-one events. Drives both the box score picker and the
// event log. A steal is always also a turnover for whoever it was stolen from, so logging a
// steal requires an opponent (no "No one tagged") and auto-creates the paired turnover —
// see the STL branch in the picker below. Turnover stays independently loggable for the
// (more common) cases with no steal involved: travels, bad passes, offensive fouls, etc.
const TAGGED_STAT_CONFIG = [
  { field: "tov", eventsKey: "turnoverEvents", label: "TOV", prompt: "Who forced/recovered it, if anyone?", verb: "Turnover", requireOpponent: false },
  { field: "stl", eventsKey: "stealEvents", label: "STL", prompt: "Who did they steal it from?", verb: "Steal", requireOpponent: true },
  { field: "pf", eventsKey: "foulEvents", label: "PF", prompt: "Who was fouled?", verb: "Foul", requireOpponent: false }
];

// ---------- Theme ----------
function effectiveTheme() {
  const stored = localStorage.getItem(THEME_KEY);
  if (stored === "light" || stored === "dark") return stored;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function applyTheme() {
  const stored = localStorage.getItem(THEME_KEY);
  if (stored === "light" || stored === "dark") {
    document.documentElement.setAttribute("data-theme", stored);
  } else {
    document.documentElement.removeAttribute("data-theme");
  }
  const btn = document.getElementById("themeToggleBtn");
  if (btn) btn.textContent = effectiveTheme() === "dark" ? "☀️" : "🌙";
}

document.getElementById("themeToggleBtn").addEventListener("click", () => {
  localStorage.setItem(THEME_KEY, effectiveTheme() === "dark" ? "light" : "dark");
  applyTheme();
});

document.getElementById("shareSiteBtn").addEventListener("click", function () {
  shareOrCopy({
    title: "Pool League Stat Tracker",
    text: "Check out this season's stats",
    url: `${location.origin}${location.pathname}`
  }, this);
});

applyTheme();

let state = loadState();
let currentGameId = null;
const localVideoBlobUrls = {}; // gameId -> object URL, cached per page load

// ---------- Local video storage (IndexedDB) ----------
// Game videos are usually a downloaded file, not a link, so we keep the actual file
// in this browser's IndexedDB (localStorage can't hold anything that big) — it stays
// loaded across visits on this machine, but never leaves the browser and isn't exported.
const VIDEO_DB_NAME = "poolLeagueVideos";
const VIDEO_STORE = "videos";

function openVideoDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(VIDEO_DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(VIDEO_STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function storeVideoFile(gameId, file) {
  const db = await openVideoDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(VIDEO_STORE, "readwrite");
    tx.objectStore(VIDEO_STORE).put(file, gameId);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function getVideoFile(gameId) {
  const db = await openVideoDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(VIDEO_STORE, "readonly");
    const req = tx.objectStore(VIDEO_STORE).get(gameId);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

async function deleteVideoFile(gameId) {
  const db = await openVideoDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(VIDEO_STORE, "readwrite");
    tx.objectStore(VIDEO_STORE).delete(gameId);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function getAllStoredVideoIds() {
  const db = await openVideoDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(VIDEO_STORE, "readonly");
    const req = tx.objectStore(VIDEO_STORE).getAllKeys();
    req.onsuccess = () => resolve(new Set(req.result));
    req.onerror = () => reject(req.error);
  });
}

function loadState() {
  const raw = localStorage.getItem(STORAGE_KEY);
  let s = { players: [], games: [], masterVideos: [] };
  if (raw) {
    try { s = JSON.parse(raw); } catch (e) { console.error("Corrupt data, starting fresh", e); }
  }
  s.masterVideos = s.masterVideos || [];
  // fileName is the original uploaded file's name, immutable — distinct from `name`, which
  // Ben can freely retype to something less specific ("Aug 10 games"), losing the one thing
  // that actually disambiguates it from another recording of the same night.
  s.masterVideos.forEach(m => { if (m.fileName === undefined) m.fileName = null; });
  (s.games || []).forEach(normalizeGame);
  // seasonHistory: closed-out seasons, oldest first — [{ label, startedAt, endedAt }]. A game
  // with date <= the last entry's endedAt is a past season; currentSeasonStartedAt (the day
  // Start New Season was last clicked, or null if it never has been) marks where "current"
  // begins. Games themselves are never deleted on a season close — only archived behind this
  // boundary — so past-season numbers stay live-recomputed forever, never a frozen snapshot
  // that could drift out of sync with a formula change later.
  s.seasonHistory = s.seasonHistory || [];
  s.currentSeasonStartedAt = s.currentSeasonStartedAt || null;
  // Per-player edits to the hand-transcribed PLAYER_PHYSICAL_DATA below, made from the Players
  // tab UI. Keyed by player id, same shape as a PLAYER_PHYSICAL_DATA entry ({ heightIn, build,
  // roles, note }) — a full replacement when present, not a partial merge, so there's never a
  // question of which fields came from the sheet vs. the UI. Lets Ben correct or extend a
  // read without editing app.js by hand.
  s.playerPhysicalOverrides = s.playerPhysicalOverrides || {};
  // Who said they'd show up, per date — [{ id, date, playerIds }], at most one entry per date
  // (saving again for a date already RSVP'd overwrites that entry rather than duplicating it).
  // This is a plan, not a record of what happened — actual attendance is still derived from
  // whoever ends up rostered on a real logged game for that date (computeFlakeStats() below
  // compares the two). A date with an RSVP but no logged game yet is left unresolved rather than
  // counted as a flake — the session may just not be entered yet, not actually a no-show.
  s.rsvps = s.rsvps || [];
  return s;
}

// Fills in fields that may be missing on games created before a feature existed
// (older saved data, or an imported file from an earlier version).
function normalizeGame(game) {
  game.teamA = game.teamA || [];
  game.teamB = game.teamB || [];
  game.stats = game.stats || [];
  game.matchups = game.matchups || [];
  game.scoringEvents = game.scoringEvents || [];
  game.turnoverEvents = game.turnoverEvents || [];
  game.stealEvents = game.stealEvents || [];
  game.foulEvents = game.foulEvents || [];
  game.plays = game.plays || [];
  if (game.winner !== "A" && game.winner !== "B") game.winner = null;
  // Which screen-side hoop Team A shoots at this game (Team B is always the other one) — lets
  // shots split by facing direction (e.g. sun/glare effects: does a player shoot worse staring
  // into it one way than the other). null means not set (most existing games, before this field
  // existed). Deliberately doesn't touch shotLocation's own x/y meaning at all — that stays
  // exactly what it's always been, so heatmaps and shot charts are unaffected either way.
  if (game.teamADirection !== "left" && game.teamADirection !== "right") game.teamADirection = null;
  // Human-confirmed only (see poolean-stopped-early-spec.md), same "can't be inferred from the
  // box score" reasoning as dunk -- defaults false for every game logged before this field
  // existed, exactly like dunk defaults to undefined until reviewed, except here "not yet
  // reviewed" and "wasn't stopped early" are the same starting assumption, so false is fine as
  // the default rather than needing its own three-state backlog like dunk's undefined/true/false.
  game.stoppedEarly = game.stoppedEarly === true;
  // A game can either have its own video, or point into a shared "session" recording that
  // covers several games back-to-back — masterVideoId + videoStart/videoEnd cover that second
  // case. videoStart always has a value (playback needs somewhere to seek to); videoEnd is
  // optional — null means "runs to the end of the recording" rather than a real bound.
  game.masterVideoId = game.masterVideoId || null;
  game.videoStart = game.videoStart || 0;
  if (game.videoEnd === undefined) game.videoEnd = null;
  // Migrate the old single-defender field (from before double-teams were supported) into
  // the array form used everywhere now.
  game.scoringEvents.forEach(ev => {
    if (!ev.defenderIds) {
      ev.defenderIds = ev.defenderId ? [ev.defenderId] : [];
      delete ev.defenderId;
    }
    if (ev.assistId === undefined) ev.assistId = null;
    if (ev.blockerId === undefined) ev.blockerId = null;
    if (ev.turnoverEventId === undefined) ev.turnoverEventId = null;
    if (ev.rebounderId === undefined) ev.rebounderId = null;
    // Who was contesting position against the rebounder specifically -- the rebound equivalent
    // of defenderIds, see poolean-rebound-battles-spec.md. A real, new per-play tagging step
    // (who was actually matched up on the rebounder at the moment of the rebound), not inferred
    // from anything already logged -- defaults empty (not yet tagged).
    if (!ev.reboundContesterIds) ev.reboundContesterIds = [];
    if (ev.shotType === undefined) ev.shotType = null;
    // Migrate the old field name ("reboundNoBoxOut") from before this got renamed to match the
    // rest of the feature's own "contest" terminology.
    if (ev.reboundNoBoxOut !== undefined) {
      ev.reboundNoContest = ev.reboundNoBoxOut;
      delete ev.reboundNoBoxOut;
    }
    // Distinct from "not yet reviewed" (empty contesterIds, reboundNoContest false): this is the
    // explicit, reviewed answer "nobody was actually contesting this rebound at all" -- a real,
    // informative tag in its own right (an uncontested/leaked-out rebound), not the same as
    // "didn't look." Needed so the backfill panel can tell the two apart and stop re-surfacing a
    // shot that's genuinely been reviewed and had nothing to tag.
    if (ev.reboundNoContest === undefined) ev.reboundNoContest = false;
    if (ev.shotLocation === undefined) ev.shotLocation = null;
  });
  // Turnovers logged before steals (or misses ruled out of bounds) auto-created a linked one
  // won't have these fields.
  game.turnoverEvents.forEach(ev => {
    if (ev.stealEventId === undefined) ev.stealEventId = null;
    if (ev.missEventId === undefined) ev.missEventId = null;
  });
  // Events logged before video-timestamp capture won't have this field — null just means
  // "no timestamp available," same as one logged with no video loaded.
  const allTimedEvents = [...game.scoringEvents, ...game.turnoverEvents, ...game.stealEvents, ...game.foulEvents, ...game.matchups];
  allTimedEvents.forEach(ev => {
    if (ev.videoTime === undefined) ev.videoTime = null;
  });
  // One-time backdate of every timestamp captured before TIMESTAMP_LEAD_SECONDS existed, so
  // old entries jump to the same few-seconds-early spot as new ones instead of landing right on
  // the play (or after it). Flagged so this never runs twice on the same game.
  if (!game.timestampsBackdated) {
    allTimedEvents.forEach(ev => {
      if (ev.videoTime !== null) ev.videoTime = Math.max(0, ev.videoTime - TIMESTAMP_LEAD_SECONDS);
    });
    game.timestampsBackdated = true;
  }
  recomputeDerivedStats(game);
}

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  invalidateComputedCaches();
  noteEditForBackup();
}

// The Leaderboard table, Win Shares fit and calibrated thresholds are expensive (about a second
// together) and only change when game data changes (saveState) or when a switch changes which
// games count (Include Imbalanced / Past Seasons / Outlier Games). Everything else reuses them.
function invalidateComputedCaches() {
  leaderboardCache = null;
  winSharesWeightsCache = null;
  calibrationCache = null;
}

function uid(prefix) {
  return prefix + "_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

// Displays an ISO date ("2026-07-05") as "Sun, Jul 5" for readability; falls back to
// the raw string for anything that isn't a plain ISO date (e.g. legacy text dates).
function formatDateDisplay(dateStr) {
  if (!dateStr) return "No date";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return dateStr;
  const [y, m, d] = dateStr.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  return date.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}

// ---------- Tabs ----------
document.querySelectorAll(".tab-btn").forEach(btn => {
  btn.addEventListener("click", () => showTab(btn.dataset.tab));
});

// A back-target for each drill-in panel that sits outside the top tab strip (Stat Entry is
// opened per-game from Games, Player Detail is opened per-player from Leaderboard) — swiping
// right anywhere in one of these acts like tapping its own Back button.
const SWIPE_BACK_TARGETS = { "tab-stats": "backToGamesBtn", "tab-player": "backToLeaderboardBtn" };

// iOS-style swipe navigation on touch devices: swipe left/right to move between the visible top
// tabs, or (while inside a drill-in panel like Stat Entry or Player Detail, neither of which is
// one of those top tabs) swipe right to leave it the same way its own Back button does. Reads touchstart/
// touchend only and never calls preventDefault, so it rides alongside normal vertical scrolling
// instead of fighting it. A swipe that starts inside a table's own horizontal scroll strip, on a
// video (native scrubbing), or on any form control is left alone entirely — those already own
// horizontal drag gestures of their own.
(function () {
  let touchStartX = null, touchStartY = null, touchStartTarget = null;
  const MIN_SWIPE = 60;
  const MAX_OFF_AXIS = 60;
  document.addEventListener("touchstart", e => {
    if (e.touches.length !== 1) { touchStartX = null; return; }
    touchStartX = e.touches[0].clientX;
    touchStartY = e.touches[0].clientY;
    touchStartTarget = e.target;
  }, { passive: true });
  document.addEventListener("touchend", e => {
    if (touchStartX === null) return;
    const touch = e.changedTouches[0];
    const dx = touch.clientX - touchStartX;
    const dy = touch.clientY - touchStartY;
    const startTarget = touchStartTarget;
    touchStartX = null;
    if (Math.abs(dx) < MIN_SWIPE || Math.abs(dy) > MAX_OFF_AXIS) return;
    if (startTarget && startTarget.closest && startTarget.closest(".table-scroll, video, input, select, textarea, button, a")) return;

    const activePanel = document.querySelector(".tab-panel.active");
    const backBtnId = activePanel && SWIPE_BACK_TARGETS[activePanel.id];
    if (backBtnId) {
      if (dx > 0) {
        const backBtn = document.getElementById(backBtnId);
        if (backBtn) backBtn.click();
      }
      return;
    }

    const visibleTabs = Array.from(document.querySelectorAll(".tab-btn")).filter(b => b.offsetParent !== null);
    const idx = visibleTabs.indexOf(document.querySelector(".tab-btn.active"));
    if (idx === -1) return;
    if (dx < 0 && idx < visibleTabs.length - 1) showTab(visibleTabs[idx + 1].dataset.tab);
    else if (dx > 0 && idx > 0) showTab(visibleTabs[idx - 1].dataset.tab);
  }, { passive: true });
})();

// Collapsible sidebar (Games/Leaderboard tabs) — collapsed state persists per sidebar (keyed by
// its wrapper id) across reloads, same toggle-remembers-itself pattern as everything else in this
// file. The toggle strip (.sidebar-toggle-btn) stays visible either way, collapsed or not, so it's
// never a dead end — only .tab-sidebar-inner (the actual content) hides.
const SIDEBAR_COLLAPSE_KEY = "poolLeagueSidebarCollapsed";
function loadSidebarCollapseState() {
  try { return JSON.parse(localStorage.getItem(SIDEBAR_COLLAPSE_KEY)) || {}; } catch (e) { return {}; }
}
function applySidebarCollapseState() {
  const collapsed = loadSidebarCollapseState();
  document.querySelectorAll("[data-sidebar-toggle]").forEach(btn => {
    const wrap = document.getElementById(btn.dataset.sidebarToggle);
    if (wrap) wrap.classList.toggle("sidebar-collapsed", !!collapsed[btn.dataset.sidebarToggle]);
  });
}
document.querySelectorAll("[data-sidebar-toggle]").forEach(btn => {
  btn.addEventListener("click", () => {
    const wrapId = btn.dataset.sidebarToggle;
    const wrap = document.getElementById(wrapId);
    if (!wrap) return;
    const isCollapsed = wrap.classList.toggle("sidebar-collapsed");
    const collapsed = loadSidebarCollapseState();
    collapsed[wrapId] = isCollapsed;
    localStorage.setItem(SIDEBAR_COLLAPSE_KEY, JSON.stringify(collapsed));
  });
});
applySidebarCollapseState();

// Compact "at a glance" standings widget for the Games/Leaderboard sidebars — rank + avatar +
// name + record + Two-Way/20, sorted by Two-Way/20 same as the Leaderboard's own default sort.
// Reuses computeLeaderboard() directly rather than a separate query, so it can never drift from
// the main table's own numbers.
function renderStandingsSidebar(containerId) {
  const wrap = document.getElementById(containerId);
  if (!wrap) return;
  const rows = computeLeaderboard().filter(r => r.gp > 0).sort((a, b) => b.twoWayPer20 - a.twoWayPer20);
  if (rows.length === 0) {
    wrap.innerHTML = '<p class="empty-state">No games with players yet.</p>';
    return;
  }
  wrap.innerHTML = `
    <table class="standings-mini-table">
      <thead><tr><th>#</th><th>Player</th><th>W-L</th><th>Two-Way/20</th></tr></thead>
      <tbody>
        ${rows.map((r, i) => `
          <tr>
            <td>${i + 1}</td>
            <td class="standings-mini-name"><button type="button" class="icon-btn standings-mini-player-btn" data-player-id="${r.player.id}">${renderPlayerAvatar(r.player)}${escapeHtml(r.player.name)}</button></td>
            <td>${r.wins}-${r.losses}${r.ties ? `-${r.ties}` : ""}</td>
            <td class="num-cell">${r.twoWayPer20.toFixed(1)}</td>
          </tr>
        `).join("")}
      </tbody>
    </table>
  `;
  wrap.querySelectorAll(".standings-mini-player-btn").forEach(btn => {
    btn.addEventListener("click", () => openPlayerDetail(btn.dataset.playerId));
  });
}

// Second card in the Games sidebar, below Standings — the last 5 games logged, most recent
// first, so jumping back into a game you were mid-review on (or checking whether last night's
// game still needs its shots logged) doesn't require scrolling down through the whole games list
// in .tab-main to find it. A game with no scoringEvents yet shows "Not reviewed" instead of a
// score, since it has no real score to show — same "has real shots logged" bar isQualifyingGame()
// uses, just without the balanced-teams/current-season filters, since a not-yet-reviewed game is
// exactly the kind of thing this card exists to surface, not filter out.
function renderGamesSidebarRecent() {
  const wrap = document.getElementById("gamesSidebarRecent");
  if (!wrap) return;
  const games = [...state.games].sort((a, b) => (b.date || "").localeCompare(a.date || "")).slice(0, 5);
  if (games.length === 0) {
    wrap.innerHTML = '<p class="empty-state">No games logged yet.</p>';
    return;
  }
  wrap.innerHTML = `
    <ul class="sidebar-recent-games-list">
      ${games.map(g => {
        const reviewed = g.scoringEvents.length > 0;
        const scoreLine = reviewed ? `${teamScore(g, g.teamA)}–${teamScore(g, g.teamB)}` : "Not reviewed";
        return `
          <li>
            <button type="button" class="icon-btn sidebar-recent-game-btn" data-game-id="${g.id}">
              <span class="sidebar-recent-game-date">${escapeHtml(formatDateDisplay(g.date))}</span>
              <span class="${reviewed ? "sidebar-recent-game-score" : "sidebar-recent-game-unreviewed"}">${scoreLine}</span>
            </button>
          </li>
        `;
      }).join("")}
    </ul>
  `;
  wrap.querySelectorAll(".sidebar-recent-game-btn").forEach(btn => {
    btn.addEventListener("click", () => openGame(btn.dataset.gameId));
  });
}

// Leaderboard sidebar shows "highlights" instead of the standings table Games' sidebar uses —
// that would just repeat the full Season Rates table sitting right next to it. These cards
// surface things that aren't obvious from the main table's own default sort: who's actually
// trending up over their last 5 games (not just who has a high Last 5 number), who's the steadiest
// night to night, who shoots best specifically in close games, the league's top assist duo, and
// who's the top defender. Each has its own minimum sample size before showing a leader, so an
// early-season fluke doesn't get top billing just because nobody else qualifies yet.
function renderLeaderboardHighlights() {
  const wrap = document.getElementById("leaderboardSidebarHighlights");
  if (!wrap) return;
  const board = computeLeaderboard().filter(r => r.gp > 0);
  const cards = [];

  // Biggest positive Last 5 vs. season Two-Way/20 gap, not just the highest raw Last 5 number —
  // a great player having a normal week shouldn't outrank someone actually trending up. Needs at
  // least 3 of their last 5 games logged to count as a real trend, and a real ▲ (same >0.5
  // threshold the Last 5 column itself uses), not just noise around a flat week.
  const hotStreak = board
    .filter(r => r.last5Gp >= 3)
    .map(r => ({ player: r.player, delta: r.last5TwoWayPer20 - r.twoWayPer20, last5: r.last5TwoWayPer20, season: r.twoWayPer20 }))
    .filter(r => r.delta > 0.5)
    .sort((a, b) => b.delta - a.delta)[0];
  if (hotStreak) {
    cards.push({ icon: "🔥", label: "Hot Streak", player: hotStreak.player,
      detail: `${hotStreak.last5.toFixed(1)} Two-Way/20 over their last 5, up from ${hotStreak.season.toFixed(1)} on the season` });
  }

  // Same ranking as the full Consistency panel, just the #1 surfaced here.
  const consistent = computeConsistencyStandings()[0];
  if (consistent) {
    cards.push({ icon: "🧊", label: "Most Consistent", player: consistent.player,
      detail: `±${consistent.stdDev.toFixed(1)} Two-Way/20 std dev across ${consistent.gp} games` });
  }

  // Best TS% in games decided by the calibrated close-game margin or fewer — needs at least 5
  // combined FGA+FTA in those games so one hot make doesn't read as a real clutch performer.
  const clutch = computeCloseGameShooting().filter(r => r.attempts >= 5).sort((a, b) => b.ts - a.ts)[0];
  if (clutch) {
    cards.push({ icon: "🧯", label: "Clutch", player: clutch.player,
      detail: `${clutch.ts}% TS in ${clutch.gp} close game${clutch.gp === 1 ? "" : "s"} (${clutch.attempts} att)` });
  }

  // The single most-repeated passer-to-scorer connection, league-wide — same data as the
  // Assist Connections panel, just its #1 row surfaced here.
  const topDuo = computeAssistConnections()[0];
  if (topDuo) {
    cards.push({ icon: "🤝", label: "Top Assist Duo", player: topDuo.passer,
      detail: `${topDuo.count} assist${topDuo.count === 1 ? "" : "s"} to ${playerLink(topDuo.scorer.id, topDuo.scorer.name)}` });
  }

  // League's top Def Rating/20 — every other card here leans offense/situational, so this rounds
  // things out with a defense-focused one. Same formula and column as the main table's own
  // Def Rating/20, just the #1 surfaced here instead of requiring a sort click.
  const bestDefender = [...board]
    .map(r => ({ player: r.player, defRating: defensiveRating(r.rate, r.rateDefense) }))
    .sort((a, b) => b.defRating - a.defRating)[0];
  if (bestDefender) {
    cards.push({ icon: "🛡️", label: "Best Defender", player: bestDefender.player,
      detail: `${bestDefender.defRating.toFixed(1)} Def Rating/20` });
  }

  if (cards.length === 0) {
    wrap.innerHTML = '<p class="empty-state">Not enough games logged yet for any highlight to qualify.</p>';
    return;
  }

  wrap.innerHTML = cards.map(c => `
    <div class="sidebar-highlight-card">
      <div class="sidebar-highlight-label">${c.icon} ${escapeHtml(c.label)}</div>
      <button type="button" class="icon-btn standings-mini-player-btn sidebar-highlight-player" data-player-id="${c.player.id}">${renderPlayerAvatar(c.player)}${escapeHtml(c.player.name)}</button>
      <div class="sidebar-highlight-detail">${c.detail}</div>
    </div>
  `).join("");
  wrap.querySelectorAll(".sidebar-highlight-player").forEach(btn => {
    btn.addEventListener("click", () => openPlayerDetail(btn.dataset.playerId));
  });
}

function showTab(tab) {
  document.querySelectorAll(".tab-panel").forEach(p => p.classList.remove("active"));
  document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
  document.getElementById("tab-" + tab).classList.add("active");
  const btn = document.querySelector(`.tab-btn[data-tab="${tab}"]`);
  if (btn) btn.classList.add("active");
  if (tab === "export") { renderExportGameSelect(); renderMasterVideoList(); renderBrokenVideoLinks(); renderBackfillShotLocations(); renderFlaggedShotMismatches(); renderDunkReview(); renderShotTypeReview(); renderSameMomentReview(); renderStoppedEarlyReview(); renderReboundBattleReview(); renderRealSiteCheck(); }
  if (tab === "leaderboard") renderLeaderboard();
  // Refreshes the attendee picker against the current roster — cheap, and a player added while
  // on a different tab shouldn't require a page reload to show up here.
  if (tab === "games") {
    renderBalanceAttendeePicker();
    renderBalanceRsvpDateSelect();
    renderPlannerAttendeePicker();
    renderMatchupPredictor();
    renderLiveGamePanel();
    renderGamesFilterPlayerPicker();
    renderGamesFilterStatPlayerSelect();
    renderRsvpAttendeePicker();
    renderRsvpRecentList();
  }
  // currentGameId/currentPlayerId are always set before showTab() is called for "stats"/"player"
  // (see openGame/openPlayerDetail), so this always captures the right context alongside the tab.
  localStorage.setItem(UI_STATE_KEY, JSON.stringify({ tab, gameId: currentGameId, playerId: currentPlayerId }));
}

// ---------- Players (league-wide roster) ----------
document.getElementById("addPlayerForm").addEventListener("submit", e => {
  e.preventDefault();
  const nameInput = document.getElementById("playerNameInput");
  const name = nameInput.value.trim();
  if (!name) return;
  state.players.push({ id: uid("player"), name });
  saveState();
  nameInput.value = "";
  renderPlayers();
});

// One entry per role a player has — each tagged with its own `kind` so the renderer can
// color-code it (see .profile-tag-* in style.css). Build/height stay real fields (still feed the
// Balance Teams tiebreak, still editable below) but aren't surfaced as their own tag here, per
// direct feedback that a roster scan doesn't need a "Strong"/"Skinny" chip alongside role.
function physicalProfileTags(phys) {
  if (!phys) return [];
  return phys.roles.map(r => ({ label: PHYSICAL_ROLE_LABELS[r], kind: r }));
}

// Only one player's tag editor open at a time — renderPlayers() rebuilds the whole list on every
// call (add/remove/edit), so this needs to survive that rebuild rather than living as local state
// inside it.
let editingPhysicalProfileId = null;

// Which role chips are picked, above the roster list — OR semantics (any selected role matches,
// not all of them), same as picking any other multi-select filter. Empty set = show everyone,
// same "no filter active" convention as the Games tab's own advanced filters.
let playersRoleFilter = new Set();

function renderPlayersRoleFilter() {
  const wrap = document.getElementById("playersRoleFilter");
  if (!wrap) return;
  wrap.innerHTML = Object.entries(PHYSICAL_ROLE_LABELS).map(([key, label]) => {
    const active = playersRoleFilter.has(key);
    return `<button type="button" class="profile-tag profile-tag-${key} role-filter-chip${active ? " active" : ""}" data-role="${key}">${escapeHtml(label)}</button>`;
  }).join("");
  wrap.querySelectorAll(".role-filter-chip").forEach(chip => {
    chip.addEventListener("click", () => {
      const role = chip.dataset.role;
      if (playersRoleFilter.has(role)) playersRoleFilter.delete(role);
      else playersRoleFilter.add(role);
      renderPlayers();
    });
  });
}

// Real photos Ben supplied (poolean-player-photos.zip), one file per player id — filenames match
// this app's own player ids exactly (the zip's own players.json confirms this is deliberate, not
// a coincidence), living in the `photos/` folder alongside index.html. A player missing here just
// falls back to the colored-initial circle below, same as anyone missing from
// PLAYER_PHYSICAL_DATA falls back to no tags — a photo is a nice-to-have, never required.
const PLAYER_PHOTO_FILES = {
  adam: "adam.jpg", alex: "alex.png", ben: "ben.png", evan: "evan.jpg",
  "g-danny": "g-danny.jpg", "g-ian": "g-ian.jpg", "g-lukas": "g-lukas.jpg",
  "g-michael-k": "g-michael-k.jpg", "g-michael-t": "g-michael-t.jpg",
  jason: "jason.jpg", kayla: "kayla.jpg", "logan-hoskins": "logan-hoskins.jpg",
  "logan-watson": "logan-watson.jpg", michael: "michael.png", phillip: "phillip.jpg",
  reilly: "reilly.jpg", ryder: "ryder.png", sean: "sean.jpg", viraj: "viraj.png",
  will: "will.png", zach: "zach.jpg"
};

// A small circle wherever a player's name shows up as a list item (roster, Leaderboard, Player
// Detail header) — a real photo when one exists (PLAYER_PHOTO_FILES), otherwise the player's
// first initial on a color deterministic from their id (a simple string hash into a hue), not
// tied to role/build/effort tag colors elsewhere so it never implies a second meaning on top of
// an actual stat — same player always gets the same color, different players usually land on
// visibly different ones, that's the whole job. `size` lets the Player Detail header use a bigger
// version of the same thing instead of a separate component.
function avatarHueForPlayer(id) {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  return hash % 360;
}
function renderPlayerAvatar(player, size = "normal", ringClass = "") {
  if (!player) return "";
  const ring = ringClass ? ` ${ringClass}` : "";
  const photoFile = PLAYER_PHOTO_FILES[player.id];
  if (photoFile) {
    return `<img src="photos/${photoFile}" alt="" class="player-avatar player-avatar-${size}${ring}">`;
  }
  const initial = (player.name.trim().charAt(0) || "?").toUpperCase();
  const hue = avatarHueForPlayer(player.id);
  return `<span class="player-avatar player-avatar-${size}${ring}" style="background:hsl(${hue}, 55%, 42%)">${escapeHtml(initial)}</span>`;
}

// The CSS class for a player's avatar ring (Poolean Awards UI spec): color by highest current-
// season tier they've actually won, thick+glow since every award this app knows about is this
// season's (no past-season history to compare against yet — see computePlayerAwardTier()).
// Empty string when they've never won a tiered award, which leaves the avatar's plain border.
function playerAvatarRingClass(playerId) {
  const t = computePlayerAwardTier(playerId);
  return t ? `player-avatar-ring-${t.color}-${t.isCurrent ? "current" : "past"}` : "";
}

function renderPlayers() {
  renderPlayersRoleFilter();
  const list = document.getElementById("playersList");
  list.innerHTML = "";
  if (state.players.length === 0) {
    list.innerHTML = '<p class="empty-state">No players yet. Add one above.</p>';
    return;
  }
  const sortedPlayers = [...state.players].sort((a, b) => a.name.localeCompare(b.name));
  const visiblePlayers = playersRoleFilter.size === 0
    ? sortedPlayers
    : sortedPlayers.filter(p => (getPlayerPhysicalData(p.id)?.roles || []).some(r => playersRoleFilter.has(r)));
  if (visiblePlayers.length === 0) {
    list.innerHTML = '<p class="empty-state">No players match the selected role filter.</p>';
    return;
  }
  visiblePlayers.forEach(p => {
    const row = document.createElement("div");
    row.className = "roster-row";
    // Notable things from Ben's own Player Profiles scouting — role(s) plus build, but only when
    // build is notable (skinny/strong end of the scale, not "Average") — a quick visual scan of
    // who's who on the roster, same profile data the Balance Teams tiebreak already reads, just
    // surfaced here too, editable from this tab (see renderPhysicalProfileEditor() below). Hover
    // any tag for Ben's original scouting sentence.
    const phys = getPlayerPhysicalData(p.id);
    const tags = physicalProfileTags(phys);
    // Effort deliberately never becomes its own tag pill (see PLAYER_PHYSICAL_DATA's own
    // comment) — this hover title is the one place it's visible on this row.
    const tagsTitleText = phys?.effort !== undefined
      ? `Effort: ${EFFORT_LABELS[phys.effort]}${phys.note ? " (" + phys.note + ")" : ""}`
      : (phys?.note || "");
    const tagsTitle = tagsTitleText ? ` title="${escapeHtml(tagsTitleText)}"` : "";
    const tagsHtml = tags.length > 0
      ? `<span class="profile-tags"${tagsTitle}>${tags.map(t => `<span class="profile-tag profile-tag-${t.kind}">${escapeHtml(t.label)}</span>`).join("")}</span>`
      : "";
    row.innerHTML = `<span class="roster-row-name">${renderPlayerAvatar(p)}${playerLink(p.id, p.name, false)}${tagsHtml}</span>`;

    const editBtn = document.createElement("button");
    editBtn.className = "icon-btn";
    editBtn.textContent = editingPhysicalProfileId === p.id ? "Close" : "Edit Tags";
    editBtn.addEventListener("click", () => {
      editingPhysicalProfileId = editingPhysicalProfileId === p.id ? null : p.id;
      renderPlayers();
    });
    row.appendChild(editBtn);

    const delBtn = document.createElement("button");
    delBtn.className = "icon-btn";
    delBtn.textContent = "Remove";
    delBtn.addEventListener("click", () => {
      if (!confirm(`Remove ${p.name} from the roster? Their recorded stats stay in past games.`)) return;
      state.players = state.players.filter(pl => pl.id !== p.id);
      saveState();
      renderPlayers();
    });
    row.appendChild(delBtn);
    list.appendChild(row);

    if (editingPhysicalProfileId === p.id) {
      list.appendChild(renderPhysicalProfileEditor(p, phys));
    }
  });
}

// Inline height/build/role/note editor for one player, appended right under their roster row.
// Always writes a full replacement object to state.playerPhysicalOverrides[id] on Save — never a
// partial merge — so a saved profile is always internally consistent rather than mixing an
// edited role with a stale hardcoded height. "Reset to Default" clears the override outright,
// falling back to the hand-transcribed PLAYER_PHYSICAL_DATA (or to no profile at all, for a
// player who was never in the original sheet) rather than leaving an empty override behind.
function renderPhysicalProfileEditor(p, phys) {
  const wrap = document.createElement("div");
  wrap.className = "physical-profile-editor";
  const heightFt = phys ? Math.floor(phys.heightIn / 12) : 5;
  const heightIn = phys ? phys.heightIn % 12 : 10;
  const build = phys?.build ?? 3;
  const effort = phys?.effort ?? 2;
  const roles = phys?.roles ?? [];
  const note = phys?.note ?? "";
  const hasOverride = !!state.playerPhysicalOverrides[p.id];

  wrap.innerHTML = `
    <div class="physical-profile-editor-row">
      <label>Height
        <span class="physical-profile-height-inputs">
          <input type="number" min="3" max="8" class="physHeightFt" value="${heightFt}"> ft
          <input type="number" min="0" max="11" class="physHeightIn" value="${heightIn}"> in
        </span>
      </label>
      <label>Build
        <select class="physBuild">
          ${Object.entries(BUILD_LABELS).map(([v, label]) => `<option value="${v}" ${Number(v) === build ? "selected" : ""}>${escapeHtml(label)}</option>`).join("")}
        </select>
      </label>
      <label>Effort
        <select class="physEffort">
          ${Object.entries(EFFORT_LABELS).map(([v, label]) => `<option value="${v}" ${Number(v) === effort ? "selected" : ""}>${escapeHtml(label)}</option>`).join("")}
        </select>
      </label>
      <label class="physical-profile-note-label">Note
        <input type="text" class="physNote" value="${escapeHtml(note)}" placeholder="e.g. Lockdown defender on top opponent">
      </label>
    </div>
    <div class="physical-profile-editor-row physical-profile-roles">
      ${Object.entries(PHYSICAL_ROLE_LABELS).map(([key, label]) => `
        <label class="physical-profile-role-check">
          <input type="checkbox" class="physRole" value="${key}" ${roles.includes(key) ? "checked" : ""}>
          ${escapeHtml(label)}
        </label>
      `).join("")}
    </div>
    <div class="physical-profile-editor-actions">
      <button type="button" class="secondary-btn physSaveBtn">Save</button>
      <button type="button" class="icon-btn physCancelBtn">Cancel</button>
      ${hasOverride ? '<button type="button" class="icon-btn physResetBtn">Reset to Default</button>' : ""}
    </div>
  `;

  wrap.querySelector(".physSaveBtn").addEventListener("click", () => {
    const ft = parseInt(wrap.querySelector(".physHeightFt").value, 10) || 0;
    const inches = parseInt(wrap.querySelector(".physHeightIn").value, 10) || 0;
    const buildVal = parseInt(wrap.querySelector(".physBuild").value, 10);
    const effortVal = parseInt(wrap.querySelector(".physEffort").value, 10);
    const selectedRoles = Array.from(wrap.querySelectorAll(".physRole:checked")).map(cb => cb.value);
    const noteVal = wrap.querySelector(".physNote").value.trim();
    state.playerPhysicalOverrides[p.id] = { heightIn: ft * 12 + inches, build: buildVal, effort: effortVal, roles: selectedRoles, note: noteVal };
    saveState();
    editingPhysicalProfileId = null;
    renderPlayers();
  });
  wrap.querySelector(".physCancelBtn").addEventListener("click", () => {
    editingPhysicalProfileId = null;
    renderPlayers();
  });
  const resetBtn = wrap.querySelector(".physResetBtn");
  if (resetBtn) {
    resetBtn.addEventListener("click", () => {
      delete state.playerPhysicalOverrides[p.id];
      saveState();
      editingPhysicalProfileId = null;
      renderPlayers();
    });
  }
  return wrap;
}

// ---------- Games ----------

// "Who's Coming?" RSVP tracker — a plan for a date, separate from any game's actual roster (see
// the s.rsvps comment in loadState()). rsvpSelectedIds mirrors whichever date is currently shown
// in the date input; switching dates reloads it from any existing saved entry for that date.
let rsvpSelectedIds = new Set();

function renderRsvpAttendeePicker() {
  const wrap = document.getElementById("rsvpAttendeePicker");
  if (!wrap) return;
  wrap.innerHTML = "";
  [...state.players].sort((a, b) => a.name.localeCompare(b.name)).forEach(p => {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "attendee-chip" + (rsvpSelectedIds.has(p.id) ? " selected" : "");
    chip.textContent = p.name;
    chip.addEventListener("click", () => {
      if (rsvpSelectedIds.has(p.id)) rsvpSelectedIds.delete(p.id);
      else rsvpSelectedIds.add(p.id);
      renderRsvpAttendeePicker();
    });
    wrap.appendChild(chip);
  });
}

function loadRsvpForDate(date) {
  const existing = state.rsvps.find(r => r.date === date);
  rsvpSelectedIds = new Set(existing ? existing.playerIds : []);
  renderRsvpAttendeePicker();
}

document.getElementById("rsvpDateInput").addEventListener("change", e => {
  loadRsvpForDate(e.target.value);
});

document.getElementById("saveRsvpBtn").addEventListener("click", () => {
  const date = document.getElementById("rsvpDateInput").value;
  if (!date) { alert("Pick a date first."); return; }
  const playerIds = [...rsvpSelectedIds];
  const existingIndex = state.rsvps.findIndex(r => r.date === date);
  // Saving with nobody checked deletes any existing entry for that date rather than storing an
  // empty one — "cleared then saved" reads as "no RSVP for this date" either way.
  if (playerIds.length === 0) {
    if (existingIndex !== -1) state.rsvps.splice(existingIndex, 1);
  } else if (existingIndex !== -1) {
    state.rsvps[existingIndex].playerIds = playerIds;
  } else {
    state.rsvps.push({ id: uid("rsvp"), date, playerIds });
  }
  saveState();
  renderRsvpRecentList();
});

document.getElementById("clearRsvpBtn").addEventListener("click", () => {
  rsvpSelectedIds = new Set();
  renderRsvpAttendeePicker();
});

function renderRsvpRecentList() {
  renderBalanceRsvpDateSelect();
  const wrap = document.getElementById("rsvpRecentList");
  if (!wrap) return;
  if (state.rsvps.length === 0) {
    wrap.innerHTML = '<p class="empty-state">No RSVPs saved yet.</p>';
    return;
  }
  const sorted = [...state.rsvps].sort((a, b) => (b.date || "").localeCompare(a.date || ""));
  wrap.innerHTML = sorted.map(r => {
    const names = r.playerIds.map(id => state.players.find(p => p.id === id)?.name).filter(Boolean);
    const hasGame = state.games.some(g => g.date === r.date);
    let statusHtml;
    if (!hasGame) {
      statusHtml = ' <span class="badge">Pending: no game logged yet</span>';
    } else {
      const missed = r.playerIds.filter(id => !playerAttendedDate(id, r.date));
      statusHtml = missed.length === 0
        ? ' <span class="badge badge-highlight">Everyone showed</span>'
        : ` <span class="badge badge-lowlight">${missed.length} missed: ${escapeHtml(missed.map(id => state.players.find(p => p.id === id)?.name || "?").join(", "))}</span>`;
    }
    return `<div class="roster-row">
      <span>${escapeHtml(formatDateDisplay(r.date))}: ${escapeHtml(names.join(", ") || "nobody")}${statusHtml}</span>
      <button type="button" class="icon-btn" data-delete-rsvp="${r.id}">Delete</button>
    </div>`;
  }).join("");
  wrap.querySelectorAll("[data-delete-rsvp]").forEach(btn => {
    btn.addEventListener("click", () => {
      state.rsvps = state.rsvps.filter(r => r.id !== btn.dataset.deleteRsvp);
      saveState();
      renderRsvpRecentList();
    });
  });
}

document.getElementById("addGameForm").addEventListener("submit", e => {
  e.preventDefault();
  const date = document.getElementById("gameDateInput").value;
  const videoUrl = document.getElementById("gameVideoInput").value.trim();
  const notes = document.getElementById("gameNotesInput").value.trim();
  const game = { id: uid("game"), date, videoUrl, notes, winner: null, teamA: [], teamB: [], stats: [], matchups: [], scoringEvents: [], plays: [] };
  normalizeGame(game);
  state.games.push(game);
  saveState();
  document.getElementById("addGameForm").reset();
  renderGames();
  openGame(game.id);
});

let gamesFilterText = "";
document.getElementById("gameFilterInput").addEventListener("input", e => {
  gamesFilterText = e.target.value.trim().toLowerCase();
  renderGames();
});

// Matches on date, notes, or any rostered player's name — enough to find one game in a
// growing list without needing to remember its exact date.
function gameMatchesFilter(game, filterText) {
  if (!filterText) return true;
  const playerNames = [...game.teamA, ...game.teamB]
    .map(id => state.players.find(p => p.id === id))
    .filter(Boolean)
    .map(p => p.name.toLowerCase());
  const haystack = [game.date || "", formatDateDisplay(game.date).toLowerCase(), (game.notes || "").toLowerCase(), ...playerNames].join(" ");
  return haystack.includes(filterText);
}

// ---- Advanced Filters (Games tab) ----
// Additive to the free-text box above (AND'd together, not a replacement) — collapsed behind
// its own toggle so the common case (typing a name or date) stays a one-line control, and this
// more deliberate "find a specific kind of game" tool only appears when asked for.
let gamesFilterPlayerIds = new Set();
let gamesFilterTeamMode = "either"; // "either" | "together" | "against"
let gamesFilterDateFrom = "";
let gamesFilterDateTo = "";
let gamesFilterStat = { playerId: "", field: "pts", op: "gte", value: "" };

function renderGamesFilterPlayerPicker() {
  const wrap = document.getElementById("gamesFilterPlayerPicker");
  if (!wrap) return;
  wrap.innerHTML = "";
  [...state.players].sort((a, b) => a.name.localeCompare(b.name)).forEach(p => {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "attendee-chip" + (gamesFilterPlayerIds.has(p.id) ? " selected" : "");
    chip.textContent = p.name;
    chip.addEventListener("click", () => {
      if (gamesFilterPlayerIds.has(p.id)) gamesFilterPlayerIds.delete(p.id);
      else gamesFilterPlayerIds.add(p.id);
      renderGamesFilterPlayerPicker();
      renderGames();
    });
    wrap.appendChild(chip);
  });
}

function renderGamesFilterStatPlayerSelect() {
  const sel = document.getElementById("gamesFilterStatPlayer");
  if (!sel) return;
  const prev = sel.value;
  sel.innerHTML = '<option value="">Any player…</option>' +
    [...state.players].sort((a, b) => a.name.localeCompare(b.name)).map(p => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join("");
  sel.value = prev;
}

// This player's box-score value for this specific game, for whichever field the stat-line
// filter is set to — reads off the same per-game helpers Game Stats itself uses (getOrCreate
// PlayerStats, shootingStats, gameDefenseStats), not a stored/derived season number, so it's
// always exactly what that one game's own box score shows.
function getGameStatValue(game, playerId, field) {
  const s = getOrCreatePlayerStats(game, playerId);
  if (["pts", "oreb", "dreb", "ast", "stl", "blk", "tov", "pf"].includes(field)) return s[field];
  const sh = shootingStats(game, playerId);
  if (field === "offRtg") return offensiveRating(s, sh);
  if (field === "twoWay") {
    const def = gameDefenseStats(game, playerId);
    return twoWayScore(s, sh, def);
  }
  return null;
}

function gameMatchesAdvancedFilters(game) {
  const rosterIds = [...game.teamA, ...game.teamB];

  if (gamesFilterPlayerIds.size > 0) {
    const selected = [...gamesFilterPlayerIds];
    if (!selected.every(id => rosterIds.includes(id))) return false;
    if (gamesFilterTeamMode === "together") {
      const allOnA = selected.every(id => game.teamA.includes(id));
      const allOnB = selected.every(id => game.teamB.includes(id));
      if (!allOnA && !allOnB) return false;
    } else if (gamesFilterTeamMode === "against") {
      const anyOnA = selected.some(id => game.teamA.includes(id));
      const anyOnB = selected.some(id => game.teamB.includes(id));
      if (!anyOnA || !anyOnB) return false;
    }
  }

  if (gamesFilterDateFrom && (game.date || "") < gamesFilterDateFrom) return false;
  if (gamesFilterDateTo && (game.date || "") > gamesFilterDateTo) return false;

  if (gamesFilterStat.playerId && gamesFilterStat.value !== "") {
    if (!rosterIds.includes(gamesFilterStat.playerId)) return false;
    const val = getGameStatValue(game, gamesFilterStat.playerId, gamesFilterStat.field);
    const threshold = parseFloat(gamesFilterStat.value);
    if (val === null || Number.isNaN(threshold)) return false;
    if (gamesFilterStat.op === "gte" && !(val >= threshold)) return false;
    if (gamesFilterStat.op === "lte" && !(val <= threshold)) return false;
    if (gamesFilterStat.op === "eq" && !(Math.abs(val - threshold) < 0.05)) return false;
  }

  return true;
}

document.getElementById("toggleGamesAdvancedFilterBtn").addEventListener("click", () => {
  const panel = document.getElementById("gamesAdvancedFilters");
  panel.hidden = !panel.hidden;
  document.getElementById("toggleGamesAdvancedFilterBtn").textContent = panel.hidden ? "Advanced Filters" : "Hide Advanced Filters";
});
document.getElementById("gamesFilterTeamMode").addEventListener("change", e => {
  gamesFilterTeamMode = e.target.value;
  renderGames();
});
document.getElementById("gamesFilterDateFrom").addEventListener("change", e => {
  gamesFilterDateFrom = e.target.value;
  renderGames();
});
document.getElementById("gamesFilterDateTo").addEventListener("change", e => {
  gamesFilterDateTo = e.target.value;
  renderGames();
});
["gamesFilterStatPlayer", "gamesFilterStatField", "gamesFilterStatOp", "gamesFilterStatValue"].forEach(id => {
  document.getElementById(id).addEventListener("input", () => {
    gamesFilterStat = {
      playerId: document.getElementById("gamesFilterStatPlayer").value,
      field: document.getElementById("gamesFilterStatField").value,
      op: document.getElementById("gamesFilterStatOp").value,
      value: document.getElementById("gamesFilterStatValue").value
    };
    renderGames();
  });
});
document.getElementById("clearGamesFiltersBtn").addEventListener("click", () => {
  gamesFilterPlayerIds = new Set();
  gamesFilterTeamMode = "either";
  gamesFilterDateFrom = "";
  gamesFilterDateTo = "";
  gamesFilterStat = { playerId: "", field: "pts", op: "gte", value: "" };
  document.getElementById("gameFilterInput").value = "";
  gamesFilterText = "";
  document.getElementById("gamesFilterTeamMode").value = "either";
  document.getElementById("gamesFilterDateFrom").value = "";
  document.getElementById("gamesFilterDateTo").value = "";
  document.getElementById("gamesFilterStatPlayer").value = "";
  document.getElementById("gamesFilterStatField").value = "pts";
  document.getElementById("gamesFilterStatOp").value = "gte";
  document.getElementById("gamesFilterStatValue").value = "";
  renderGamesFilterPlayerPicker();
  renderGames();
});

// Shared by every "Share" button in this file (games, players, and the site-wide one in the
// header) — tries the native OS share sheet first (navigator.share(), the thing that actually
// makes a site "feel shareable" on a phone: it hands off straight to iMessage/WhatsApp/whatever
// instead of silently filling the clipboard and hoping the person notices), then falls back to
// the async Clipboard API, then to a temporary off-screen textarea + document.execCommand("copy")
// for a browser or non-HTTPS context where neither of those is available. `title`/`text`/`url`
// match navigator.share()'s own parameter names; the clipboard fallbacks just concatenate them
// into one block, same as a share sheet's own preview usually renders it.
function shareOrCopy({ title, text, url }, btn) {
  const flash = (label) => {
    const original = btn.textContent;
    btn.textContent = label;
    btn.disabled = true;
    setTimeout(() => { btn.textContent = original; btn.disabled = false; }, 1500);
  };
  const fullText = `${text}\n${url}`;
  const copyFallback = () => {
    const onFail = () => {
      const textarea = document.createElement("textarea");
      textarea.value = fullText;
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      document.body.appendChild(textarea);
      textarea.select();
      try {
        document.execCommand("copy");
        flash("Copied!");
      } catch (e) {
        flash("Copy failed");
      }
      document.body.removeChild(textarea);
    };
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(fullText).then(() => flash("Copied!"), onFail);
    } else {
      onFail();
    }
  };
  if (navigator.share) {
    // A user-cancelled share sheet rejects with an AbortError — that's not a failure needing a
    // clipboard fallback, just someone changing their mind, so it's the one rejection this
    // swallows silently instead of falling through to copyFallback().
    navigator.share({ title, text, url }).catch(err => { if (err?.name !== "AbortError") copyFallback(); });
  } else {
    copyFallback();
  }
}

function buildGameShareText(game) {
  const scoreA = teamScore(game, game.teamA);
  const scoreB = teamScore(game, game.teamB);
  const teamANames = game.teamA.map(id => state.players.find(p => p.id === id)?.name).filter(Boolean).join(", ") || "Team A";
  const teamBNames = game.teamB.map(id => state.players.find(p => p.id === id)?.name).filter(Boolean).join(", ") || "Team B";
  return `${formatDateDisplay(game.date)}: ${teamANames} ${scoreA} - ${scoreB} ${teamBNames}`;
}
function copyGameShareLink(game, btn) {
  shareOrCopy({
    title: "Pool League Stat Tracker",
    text: buildGameShareText(game),
    url: `${location.origin}${location.pathname}#game=${encodeURIComponent(game.id)}`
  }, btn);
}

function renderGames() {
  renderNeedsReviewSummary();
  renderRealSiteCheck();
  renderBackupReminder();
  renderShotLocationGapSummary();
  // A game being created/deleted can resolve (or un-resolve) a pending RSVP entry for that same
  // date, so the recent-RSVP list's Pending/Everyone showed/missed status needs to stay in sync
  // with whatever renderGames() itself is reacting to.
  renderRsvpRecentList();
  renderStandingsSidebar("gamesSidebarStandings");
  renderGamesSidebarRecent();
  const list = document.getElementById("gamesList");
  list.innerHTML = "";
  if (state.games.length === 0) {
    list.innerHTML = '<p class="empty-state">No games yet. Create one above.</p>';
    return;
  }
  const filtered = [...state.games]
    .sort((x, y) => (x.date || "").localeCompare(y.date || ""))
    .filter(game => gameMatchesFilter(game, gamesFilterText) && gameMatchesAdvancedFilters(game));
  if (filtered.length === 0) {
    list.innerHTML = '<p class="empty-state">No games match that filter.</p>';
    return;
  }
  filtered.forEach(game => {
    const liveOnly = isLiveScoreOnly(game);
    const scoreA = liveOnly ? liveScoreOf(game, game.teamA) : teamScore(game, game.teamA);
    const scoreB = liveOnly ? liveScoreOf(game, game.teamB) : teamScore(game, game.teamB);
    const card = document.createElement("div");
    card.className = "game-card";
    card.dataset.gameId = game.id;
    const hasKnownVideo = !!(game.videoUrl || game.masterVideoId);
    const videoBadge = hasKnownVideo ? ' <span class="badge badge-video">🎥 Video</span>' : '<span class="video-badge-slot"></span>';
    const needsReview = game.scoringEvents.length === 0;
    // "Needs Review" only means anything once there's actually a video to review — a game with
    // no video at all just hasn't reached that point yet, not fallen behind. Local-video-only
    // games don't know their video status synchronously, so they get a slot too (resolved
    // alongside the video badge itself in markGamesWithLocalVideo).
    const reviewBadge = hasKnownVideo && needsReview
      ? ' <span class="badge badge-review">📝 Needs Review</span>'
      : (needsReview ? '<span class="review-badge-slot"></span>' : '');
    const imbalancedBadge = isBalancedGame(game)
      ? ""
      : ` <span class="badge badge-imbalanced" title="Team A has ${game.teamA.length}, Team B has ${game.teamB.length}. Excluded from Leaderboard rates and every other computed comparison unless the Include Imbalanced Games toggle on the Leaderboard is on.">⚖️ ${game.teamA.length}v${game.teamB.length}</span>`;
    const pastSeasonBadge = isCurrentSeasonGame(game)
      ? ""
      : ` <span class="badge badge-past-season" title="From a season closed out before this one. Excluded from Leaderboard rates and every other computed comparison unless the Include Past Seasons toggle on the Leaderboard is on. See Closed Seasons in This App on each player's page for that season's final numbers.">📅 Past Season</span>`;
    const liveBadge = game.liveInProgress
      ? ' <span class="badge badge-review" title="Being scored live right now.">📣 Live now</span>'
      : liveOnly ? ' <span class="badge badge-review" title="Only who scored was tracked live. Log it from film in Stat Entry for it to count toward stats.">📣 Live score only</span>' : "";
    const stoppedEarlyBadge = game.stoppedEarly
      ? ` <span class="badge badge-lowlight" title="This game ended early. Not comparable to a complete game -- excluded from Best/Worst Games, Power Ranking vs. Performance, Shot Attempt Differential, Pace/PPP, and Win Shares. Season-total rates still include it.">🛑 Stopped Early</span>`
      : "";
    // Best/worst-of-the-game badge — same Two-Way score Best & Worst Individual Games ranks by
    // (Off Rating + Def Rating for that one game, not a per-20 rate or season number), just
    // scoped to this specific game's own roster instead of pooled across the whole season. Only
    // meaningful once there's real data to rank and at least two players to compare, so an
    // unreviewed game or a lone-player roster gets neither badge rather than a trivial or
    // misleading one.
    const rosterIds = [...game.teamA, ...game.teamB];
    let starBadge = "", coldBadge = "";
    if (game.scoringEvents.length > 0 && rosterIds.length >= 2) {
      const performances = rosterIds.map(pid => {
        const player = state.players.find(p => p.id === pid);
        if (!player) return null;
        const s = getOrCreatePlayerStats(game, pid);
        const sh = shootingStats(game, pid);
        const def = gameDefenseStats(game, pid);
        return { player, twoWay: twoWayScore(s, sh, def) };
      }).filter(Boolean);
      if (performances.length >= 2) {
        const best = performances.reduce((a, b) => b.twoWay > a.twoWay ? b : a);
        const worst = performances.reduce((a, b) => b.twoWay < a.twoWay ? b : a);
        starBadge = ` <span class="badge badge-highlight" title="Best individual performance this game by Two-Way score.">🔥 ${playerLink(best.player.id, best.player.name)} ${best.twoWay >= 0 ? "+" : ""}${best.twoWay.toFixed(1)}</span>`;
        if (worst.player.id !== best.player.id) {
          coldBadge = ` <span class="badge badge-lowlight" title="Worst individual performance this game by Two-Way score.">👎 ${playerLink(worst.player.id, worst.player.name)} ${worst.twoWay >= 0 ? "+" : ""}${worst.twoWay.toFixed(1)}</span>`;
        }
      }
    }
    const teamANames = game.teamA.map(id => state.players.find(p => p.id === id)?.name).filter(Boolean).join(", ") || "Team A";
    const teamBNames = game.teamB.map(id => state.players.find(p => p.id === id)?.name).filter(Boolean).join(", ") || "Team B";
    card.innerHTML = `
      <div>
        <div class="matchup-line">${escapeHtml(teamANames)} ${scoreA} - ${scoreB} ${escapeHtml(teamBNames)}</div>
        <div class="date-line">${formatDateDisplay(game.date)} · ${game.teamA.length + game.teamB.length} players${game.notes ? " · " + escapeHtml(game.notes) : ""}${videoBadge}${reviewBadge}${liveBadge}${imbalancedBadge}${pastSeasonBadge}${stoppedEarlyBadge}${starBadge}${coldBadge}</div>
      </div>
    `;
    const shareBtn = document.createElement("button");
    shareBtn.className = "icon-btn game-share-btn";
    shareBtn.textContent = "Share";
    shareBtn.title = "Copy a link straight to this game";
    shareBtn.addEventListener("click", ev => {
      ev.stopPropagation();
      copyGameShareLink(game, shareBtn);
    });
    card.appendChild(shareBtn);

    const delBtn = document.createElement("button");
    delBtn.className = "icon-btn game-delete-btn";
    delBtn.textContent = "Delete";
    delBtn.addEventListener("click", ev => {
      ev.stopPropagation();
      if (!confirm("Delete this game and all its stats?")) return;
      state.games = state.games.filter(g => g.id !== game.id);
      saveState();
      renderGames();
    });
    card.appendChild(delBtn);
    card.addEventListener("click", () => openGame(game.id));
    list.appendChild(card);
  });

  markGamesWithLocalVideo();
}

// Local video files live in IndexedDB, not `state`, so the "has video" badge (and the "Needs
// Review" badge that depends on it) for those needs a separate async pass after the
// (synchronous) game list has already rendered.
async function markGamesWithLocalVideo() {
  const ids = await getAllStoredVideoIds();
  ids.forEach(gameId => {
    const card = document.querySelector(`.game-card[data-game-id="${gameId}"]`);
    if (!card) return;
    const videoSlot = card.querySelector(".video-badge-slot");
    if (videoSlot) videoSlot.outerHTML = ' <span class="badge badge-video">🎥 Video</span>';
    const reviewSlot = card.querySelector(".review-badge-slot");
    if (reviewSlot) reviewSlot.outerHTML = ' <span class="badge badge-review">📝 Needs Review</span>';
  });
}

// Backlog indicator: how many games actually have video to watch but no shots logged yet —
// the same "reviewable" gate the per-card badge above uses, just totaled up. Independent of
// the games filter box, since the point is to surface the backlog regardless of what's shown.
async function renderNeedsReviewSummary() {
  const el = document.getElementById("needsReviewSummary");
  if (!el) return;
  const localVideoIds = new Set(await getAllStoredVideoIds());
  const count = state.games.filter(g => g.scoringEvents.length === 0 && (g.videoUrl || g.masterVideoId || localVideoIds.has(g.id))).length;
  el.textContent = count > 0
    ? `📝 ${count} game${count === 1 ? "" : "s"} with video still need${count === 1 ? "s" : ""} review.`
    : "";
}

// A game that's been reviewed (real shots logged) but still has field goals with no marked shot
// chart location was previously only visible on Export → Backfill Shot Locations, a tab nobody
// but Ben opens — surfacing the same gap right on Games (where he's already looking after
// reviewing a game) instead of leaving it to be found by accident later. Same missing-location
// condition renderBackfillShotLocations() itself uses (a 2 or 3 point field goal with no
// shotLocation); free throws are excluded since they have no shot chart location to mark.
function renderShotLocationGapSummary() {
  const el = document.getElementById("shotLocationGapSummary");
  if (!el) return;
  const gamesWithGaps = state.games.filter(g =>
    g.scoringEvents.length > 0 &&
    g.scoringEvents.some(ev => (ev.points === 2 || ev.points === 3) && !ev.shotLocation)
  ).length;
  el.innerHTML = gamesWithGaps > 0
    ? `📍 ${gamesWithGaps} reviewed game${gamesWithGaps === 1 ? "" : "s"} still missing shot locations on some makes/misses. <button type="button" class="icon-btn" id="jumpToBackfillBtn" style="padding:2px 8px">Fill them in</button>`
    : "";
  document.getElementById("jumpToBackfillBtn")?.addEventListener("click", () => {
    showTab("export");
    document.getElementById("backfillShotLocations")?.scrollIntoView({ behavior: "smooth", block: "start" });
  });
}

// ---------- Balance Teams ----------
// Real season-average power-ranking percentile per player, pulled from Ben's own
// poolean_player_profiles.xlsx ("Power Rankings & Awards" sheet) — a frozen external snapshot,
// same hand-edited-historical-record pattern as AWARD_RESULTS/PARTY_RANKINGS, not derived from
// anything in state. Covers every player who's attended at least one real-life party, including
// the many with zero dashboard stats logged (no film reviewed yet) — exactly the gap Balance
// Teams' quality estimate needs filling, since defaulting a player with no games to a flat 0.0
// treats a real MVP-caliber player and a total beginner identically. Only ever used as a
// *fallback* below, for a player with no dashboard stats — anyone with real logged games keeps
// using their own Two-Way/20, untouched. Deliberately doesn't fold in anything from the
// spreadsheet's "Player Profiles" sheet (attitude, effort, preferred role, shooting tendency,
// free-text notes) — that's Ben's own subjective scouting, not something to silently encode into
// a numeric fairness score. Update this table by hand if a newer export exists.
const PLAYER_REPUTATION_DATA = [
  { slug: "phillip", avgPercentile: 100, parties: 4 },
  { slug: "logan-hoskins", avgPercentile: 88.9, parties: 1 },
  { slug: "ben", avgPercentile: 73.3, parties: 15 },
  { slug: "reilly", avgPercentile: 73, parties: 7 },
  { slug: "evan", avgPercentile: 65.1, parties: 4 },
  { slug: "adam", avgPercentile: 63.2, parties: 15 },
  { slug: "sean", avgPercentile: 63, parties: 3 },
  { slug: "jason", avgPercentile: 52.9, parties: 3 },
  { slug: "zach", avgPercentile: 42.1, parties: 15 },
  { slug: "alex", avgPercentile: 35.6, parties: 9 },
  { slug: "will", avgPercentile: 35.5, parties: 6 },
  { slug: "g-ian", avgPercentile: 20.8, parties: 3 },
  { slug: "logan-watson", avgPercentile: 16.2, parties: 3 },
  { slug: "viraj", avgPercentile: 15.3, parties: 3 },
  { slug: "g-lukas", avgPercentile: 8.3, parties: 3 },
  { slug: "ryder", avgPercentile: 0, parties: 2 },
  { slug: "kayla", avgPercentile: 0, parties: 2 },
  { slug: "g-michael-t", avgPercentile: 0, parties: 1 },
  { slug: "g-danny", avgPercentile: 0, parties: 1 }
  // "michael" and "g-michael-k" have no parties logged in the source sheet at all, so they get
  // no reputation fallback either — same neutral 0.0 default as anyone with truly no signal.
];
const PLAYER_REPUTATION_BY_ID = {};
PLAYER_REPUTATION_DATA.forEach(r => { PLAYER_REPUTATION_BY_ID[r.slug] = r; });

// Ben's own subjective scouting from poolean_player_profiles.xlsx's "Player Profiles" sheet —
// same source PLAYER_REPUTATION_DATA draws from, hand-transcribed the same way, at his explicit
// request (this was deliberately left out until asked for — see the comment above
// PLAYER_REPUTATION_DATA). heightIn is parsed from the sheet's "Height/Build" column's
// feet/inches (e.g. `6'0", 175 lbs` -> 72). build is Claude's own 1-5 read of that same column's
// qualitative half (1 skinny/very skinny, 2 skinny-leaning, 3 average/unstated, 4 strong/bigger,
// 5 very muscular or bigger-and-physical) — the numeric weight when given (e.g. "175 lbs") isn't
// itself used, just folded into the same 1-5 judgment call, since a bare pounds figure means
// nothing without a frame to compare it against. roles is Claude's own read of the "Preferred
// Role" column's free text, bucketed into five rough categories (scorer / defender / physical /
// playmaker / role-player) purely so there's something to spread evenly across teams below —
// mostly Claude's own read, though a few (e.g. Adam/Zach's defense) are now Ben's own explicit
// added qualifiers straight from the sheet. Most players get one role; a few whose notes clearly
// describe a second *genuine strength*, not just a mention, carry a second (e.g. Ben: "lockdown
// defender" AND "facilitator/passer"; Adam: "strong defender"; Lukas: "a pest on defense") — a
// player with two roles counts toward both when roleImbalance is tallied, so listing both here
// can only ever make more of a team's coverage visible, never invent a role a player doesn't
// have. Hedging language ("mediocre", "average", "below-average", "fine", "modest") is
// deliberately NOT enough to earn a role on its own (e.g. Zach and Alex's defense is explicitly
// "mediocre" per Ben, Reilly's is "fine") — the whole point of a role tag is a real
// specialization to spread across teams, and mediocre-at-something isn't that. `note` used to
// keep the original scouting sentence behind each categorization (so a tag that read wrong was
// obvious at a glance, hovering a chip); cleared to "" at Ben's explicit request, so tags stand
// on their own now with no hover text. Still a real field — the Players tab editor still writes
// to it — just empty by default here. effort is hand-transcribed from the sheet's own "Effort"
// column (Low/Medium/High/Very High) on a 1-4 scale, added per direct request that it factor in
// as a tiebreaker WITHOUT becoming a visible tag — unlike height/build/role it never shows as a
// .profile-tag pill anywhere (physicalProfileTags() doesn't read it at all); it only surfaces in
// the Players tab editor and Balance Teams' plain-text "Avg effort" line, same treatment as
// height/build get there. Reilly's sheet entry is irregular prose ("Starts high, varies by
// teammates — will sometimes bail mid-session") rather than a clean tier, bucketed to Medium (2)
// as the closest fit for "inconsistent, not reliably high." All four (height/build/roles/effort)
// are only ever a *tiebreaker* (see scorePhysicalBalance()) — real
// Two-Way spread always wins when the two disagree. A player missing here (no Player Profiles
// row) just doesn't contribute to any part of the tiebreak.
const PLAYER_PHYSICAL_DATA = {
  ben: { heightIn: 72, build: 3, effort: 4, roles: ["defender", "playmaker"], note: "" },
  adam: { heightIn: 64, build: 5, effort: 4, roles: ["scorer", "defender"], note: "" },
  zach: { heightIn: 67, build: 1, effort: 4, roles: ["scorer"], note: "" },
  alex: { heightIn: 72, build: 3, effort: 4, roles: ["scorer"], note: "" },
  evan: { heightIn: 69, build: 4, effort: 3, roles: ["scorer"], note: "" },
  "g-ian": { heightIn: 70, build: 4, effort: 3, roles: ["physical"], note: "" },
  "g-michael-t": { heightIn: 70, build: 2, effort: 2, roles: ["scorer"], note: "" },
  "g-lukas": { heightIn: 67, build: 3, effort: 3, roles: ["physical", "defender"], note: "" },
  reilly: { heightIn: 71, build: 3, effort: 2, roles: ["scorer"], note: "" },
  viraj: { heightIn: 69, build: 2, effort: 2, roles: ["role-player"], note: "" },
  sean: { heightIn: 72, build: 4, effort: 3, roles: ["defender", "scorer"], note: "" },
  will: { heightIn: 68, build: 4, effort: 3, roles: ["physical"], note: "" },
  phillip: { heightIn: 73, build: 4, effort: 4, roles: ["scorer", "defender"], note: "" },
  jason: { heightIn: 70, build: 2, effort: 3, roles: ["defender"], note: "" },
  "logan-hoskins": { heightIn: 72, build: 4, effort: 1, roles: ["defender", "scorer"], note: "" },
  "logan-watson": { heightIn: 69, build: 3, effort: 3, roles: ["role-player"], note: "" },
  kayla: { heightIn: 67, build: 3, effort: 2, roles: ["role-player"], note: "" },
  ryder: { heightIn: 70, build: 2, effort: 3, roles: ["playmaker"], note: "" },
  "g-danny": { heightIn: 70, build: 5, effort: 2, roles: ["physical"], note: "" },
  "g-michael-k": { heightIn: 70, build: 2, effort: 2, roles: ["scorer"], note: "" }
};
function formatHeightIn(totalInches) {
  const rounded = Math.round(totalInches);
  return `${Math.floor(rounded / 12)}'${rounded % 12}"`;
}
const PHYSICAL_ROLE_LABELS = { scorer: "Scorer", defender: "Defender", physical: "Physical", playmaker: "Playmaker", "role-player": "Role Player" };
const BUILD_LABELS = { 1: "Very Skinny", 2: "Skinny", 3: "Average", 4: "Strong", 5: "Very Strong" };
const EFFORT_LABELS = { 1: "Low", 2: "Medium", 3: "High", 4: "Very High" };

// Every reader of a player's physical/role profile goes through here, never straight at
// PLAYER_PHYSICAL_DATA — state.playerPhysicalOverrides (edited from the Players tab) wins
// whole-object when present, so an edited player's entry never accidentally blends a UI-edited
// role with a stale hardcoded height. undefined (not null) when neither has an entry, matching
// PLAYER_PHYSICAL_DATA[id]'s own lookup-miss behavior everywhere this used to be called directly.
function getPlayerPhysicalData(id) {
  return state.playerPhysicalOverrides?.[id] || PLAYER_PHYSICAL_DATA[id];
}

// Converts a season-average power-ranking percentile (0-100, 50 = exactly average that night)
// into a Two-Way/20-equivalent estimate. Calibrated against the real spread of this roster's own
// Two-Way/20 values (roughly -5 to +5.5): 10 percentile points above/below league-average maps
// to about 1 point of Two-Way/20. A single adjustable constant, not a UI setting, same pattern as
// every other judgment-call threshold in this tool (the close-game margin,
// the second-chance window, etc.) — revisit if it turns out to under- or over-weight
// reputation once more of these players actually get logged film.
//
// A CLEAN_SWEEP_BONUS on top of that linear mapping, for the specific case of a real 100th
// percentile average across multiple parties (rank 1 *every single night*, not just "above
// average") — a genuinely different, rarer claim than a merely-high percentile, and the plain
// linear formula alone was underselling it: Phillip's own 100th-percentile/4-party reputation
// landed at only +5.0, barely ahead of (and sometimes behind) real logged players' own measured
// Two-Way/20 in the high-3s/4s. Gated at 2+ parties so a single lucky night at 100th percentile
// doesn't trigger the same bonus a real multi-party sweep earns.
const CLEAN_SWEEP_BONUS = 1.2;
function estimatedQualityFromReputation(avgPercentile, parties) {
  const base = (avgPercentile - 50) / 10;
  return avgPercentile === 100 && parties >= 2 ? base + CLEAN_SWEEP_BONUS : base;
}

// Every attendee's balancing quality plus where it came from, computed once per generate/render
// pass so the attendee picker, the results, and the search itself all agree with each other.
function computeBalanceQualityMap() {
  const board = computeLeaderboard();
  const map = {};
  board.forEach(r => {
    if (r.gp > 0) {
      map[r.player.id] = { quality: r.twoWayPer20, source: "stats" };
    } else {
      const rep = PLAYER_REPUTATION_BY_ID[r.player.id];
      map[r.player.id] = rep
        ? { quality: estimatedQualityFromReputation(rep.avgPercentile, rep.parties), source: "reputation", avgPercentile: rep.avgPercentile, parties: rep.parties }
        : { quality: 0, source: "none" };
    }
  });
  return map;
}

// Not tied to a specific game — this is a "who's here today, how should we split them up"
// planning tool, so its own selection state lives outside any one game's record and isn't
// persisted (picking attendees is a one-time, throwaway decision each session, not data worth
// saving). balanceResults holds the last generated shortlist so it survives a re-render of the
// attendee picker (e.g. toggling a chip) without wiping the results the user is looking at.
let balanceAttendeeIds = new Set();
let balanceResults = [];

function renderBalanceAttendeePicker() {
  const wrap = document.getElementById("balanceAttendeePicker");
  if (!wrap) return;
  wrap.innerHTML = "";
  if (state.players.length === 0) {
    wrap.innerHTML = '<p class="empty-state">No players yet. Add players in the Players tab.</p>';
    return;
  }
  const qualityMap = computeBalanceQualityMap();
  [...state.players].sort((a, b) => a.name.localeCompare(b.name)).forEach(p => {
    const q = qualityMap[p.id];
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "attendee-chip" + (balanceAttendeeIds.has(p.id) ? " selected" : "");
    chip.textContent = q.source === "reputation" ? `${p.name} *` : p.name;
    chip.title = q.source === "stats"
      ? `${q.quality.toFixed(1)} season Two-Way/20`
      : q.source === "reputation"
        ? `No dashboard stats yet: estimated from a ${q.avgPercentile}th percentile power ranking (${q.parties} part${q.parties === 1 ? "y" : "ies"}), not logged film`
        : "No dashboard stats or power ranking data: counted as a neutral average";
    chip.addEventListener("click", () => {
      if (balanceAttendeeIds.has(p.id)) balanceAttendeeIds.delete(p.id);
      else balanceAttendeeIds.add(p.id);
      renderBalanceAttendeePicker();
      updateBalanceGenerateBtnState();
    });
    wrap.appendChild(chip);
  });
}

function updateBalanceGenerateBtnState() {
  const btn = document.getElementById("generateBalancedTeamsBtn");
  if (btn) btn.disabled = balanceAttendeeIds.size < 2;
}

// Lets Balance Teams pull its attendee list straight from a saved "Who's Coming?" RSVP instead
// of re-clicking through the whole roster by hand — a separate action from picking a date for
// the game itself, since you might balance teams for a date before creating any game for it.
function renderBalanceRsvpDateSelect() {
  const sel = document.getElementById("balanceRsvpDateSelect");
  const btn = document.getElementById("loadRsvpToBalanceBtn");
  if (!sel || !btn) return;
  const sorted = [...state.rsvps].sort((a, b) => (b.date || "").localeCompare(a.date || ""));
  if (sorted.length === 0) {
    sel.innerHTML = '<option value="">No RSVPs saved yet</option>';
    sel.disabled = true;
    btn.disabled = true;
    return;
  }
  sel.disabled = false;
  btn.disabled = false;
  sel.innerHTML = sorted.map(r => `<option value="${r.id}">${escapeHtml(formatDateDisplay(r.date))} (${r.playerIds.length})</option>`).join("");
}
document.getElementById("loadRsvpToBalanceBtn").addEventListener("click", () => {
  const sel = document.getElementById("balanceRsvpDateSelect");
  const entry = state.rsvps.find(r => r.id === sel.value);
  if (!entry) return;
  // Filters out any id that isn't a current roster player, in case someone RSVP'd who's since
  // been removed — the picker below can only ever select real current players anyway.
  balanceAttendeeIds = new Set(entry.playerIds.filter(id => state.players.some(p => p.id === id)));
  renderBalanceAttendeePicker();
  updateBalanceGenerateBtnState();
});

// Deals a quality-sorted list of ids out across `targetSizes.length` teams in serpentine
// ("snake draft") order — 0,1,2,...,K-1,K-1,...,2,1,0,0,1,2,... — skipping a team once it's
// reached its own target size (teams can differ by one player when attendee count doesn't
// divide evenly by the requested team size). The standard no-search way to keep total quality
// close across groups: the strongest and weakest players each round land on different teams,
// and the team that "loses" the top pick in a round gets first pick of the next one.
function snakeOrderIndices(targetSizes, totalCount) {
  const numTeams = targetSizes.length;
  const counts = new Array(numTeams).fill(0);
  const order = [];
  let i = 0, dir = 1;
  while (order.length < totalCount) {
    if (counts[i] < targetSizes[i]) {
      order.push(i);
      counts[i]++;
    }
    const next = i + dir;
    if (next < 0 || next >= numTeams) dir = -dir;
    else i = next;
  }
  return order;
}

function snakeDraftTeams(sortedIds, targetSizes) {
  const order = snakeOrderIndices(targetSizes, sortedIds.length);
  const teams = targetSizes.map(() => []);
  sortedIds.forEach((id, i) => teams[order[i]].push(id));
  return teams;
}

// One randomized candidate: shuffle the attendee order, then greedily assign each in turn to
// whichever team (among those with room left) currently has the lowest running average quality
// — a fast heuristic, not an exhaustive search, but running it many times over different random
// orders and keeping the best few results turns up a genuinely varied shortlist rather than one
// "optimal" answer, which is the point (there's often more than one fair way to split a group,
// and the search here surfaces several instead of picking one for you).
function randomGreedyTeams(attendeeIds, targetSizes, qualityById) {
  const shuffled = [...attendeeIds].sort(() => Math.random() - 0.5);
  const teams = targetSizes.map(() => []);
  const totals = targetSizes.map(() => 0);
  shuffled.forEach(id => {
    let best = -1, bestAvg = Infinity;
    teams.forEach((team, i) => {
      if (team.length >= targetSizes[i]) return;
      const avg = team.length > 0 ? totals[i] / team.length : -Infinity;
      if (avg < bestAvg) { bestAvg = avg; best = i; }
    });
    teams[best].push(id);
    totals[best] += qualityById[id] || 0;
  });
  return teams;
}

function teamSetSignature(teams) {
  return teams.map(t => [...t].sort().join(",")).sort().join("|");
}

// Balance is judged by each team's *average* quality, not its total — the two can differ by a
// player when the attendee count doesn't divide evenly by the team size, and comparing totals
// would then unfairly read a bigger team as "stronger" even at equal per-player quality. Each
// team's average also gets nudged by two independent real-history signals — teamChemistryAdjustment()
// (how these specific players have actually performed individually with each other) and
// teamWinRateAdjustment() (whether teams built around these pairings have actually won) — so
// this is where past games feed the *primary* ranking, unlike height/build/role below, which
// only ever tiebreak. Summed rather than averaged together deliberately: a pairing that's both
// shown a real individual lift *and* a real winning record is doubly-confirmed, not
// double-counted, and each is independently dampened by its own sample size already.
//
// That per-pair sample-size damping (min(1, gp/3) in both functions) is a different thing from
// bounding by scale, and isn't enough on its own: a raw per-20 rate difference is just a big
// number, confident or not, and on this roster the two signals combined run roughly -8 to +7 per
// team (checked directly against this browser's own real games) while the actual gap between two
// well-balanced teams' plain average quality is routinely under a point. Left unclamped, "nudge"
// is the wrong word for what these terms do — the search ends up ranking splits by whichever one
// chemistry/win-rate happened to favor, not by which one is actually the closest talent-wise, and
// nothing about that failure is visible from the output alone (every answer still looks
// reasonable). `nudgeCap` bounds the combined chemistry+win-rate adjustment to a fraction of
// *this specific group's* own quality spread (attendeeIds, not the whole roster) — so it can
// still break a near-tie or tip a genuinely close call, but can never outweigh a real talent gap
// or manufacture one out of a mostly-even group. undefined disables the cap entirely (existing
// callers that don't pass one), which is only used by code paths measuring the raw, unclamped
// signal itself rather than actually building teams with it.
function scoreTeamSet(teams, qualityById, liftMap, winRateMap, nudgeCap) {
  const avgs = teams.map(team => {
    const base = team.reduce((sum, id) => sum + (qualityById[id] || 0), 0) / team.length;
    const nudge = teamChemistryAdjustment(team, liftMap).value + teamWinRateAdjustment(team, winRateMap).value;
    const cappedNudge = nudgeCap === undefined ? nudge : Math.max(-nudgeCap, Math.min(nudgeCap, nudge));
    return base + cappedNudge;
  });
  return { avgs, spread: Math.max(...avgs) - Math.min(...avgs), physicalScore: scorePhysicalBalance(teams) };
}

// Real chemistry, not just summed individual quality — for every attendee, how their own
// Two-Way/20 actually changed with each other attendee on their team vs. not, straight from
// computeTeammateSynergy() (the same "with vs. without" split Player Detail's own Teammate
// Synergy panel shows). Precomputed once per generateBalancedTeamSets() call, not per candidate,
// since it's the same lookup for every split tried — computeTeammateSynergy() itself re-scans
// every game, so calling it once per attendee here (not once per pair per candidate) keeps this
// affordable. Each pair's lift is dampened by how many games they've actually shared
// (min(1, withGp / 3)), so a single shared game's swing isn't treated as a settled pattern the
// way 3+ games together would be — and a pair with zero shared games contributes nothing at all
// (unknown, never assumed neutral or negative). Asymmetric on purpose: A's lift from playing
// with B is stored separately from B's lift from playing with A, since those are different
// facts about different players' games, same reasoning the Teammate Lift Matrix already uses.
function computeChemistryLiftMap(attendeeIds) {
  const map = {};
  attendeeIds.forEach(playerId => {
    computeTeammateSynergy(playerId).forEach(r => {
      if (!attendeeIds.includes(r.teammate.id)) return;
      if (r.with.gp === 0 || r.without.gp === 0) return;
      const lift = r.with.twoWayPer20 - r.without.twoWayPer20;
      const confidence = Math.min(1, r.with.gp / 3);
      map[`${playerId}|${r.teammate.id}`] = { value: lift * confidence, gp: r.with.gp };
    });
  });
  return map;
}

// Average of every known pairwise lift among this team's own players (both directions counted
// separately — A-with-B and B-with-A are different lookups). A team with no known pairs (nobody
// on it has ever shared a qualifying game with anybody else on it) gets 0, not a penalty for
// being an untested combination. minGp (the weakest-tested pair's own game count, not an
// average) is carried alongside the blended value specifically so the UI can show how much to
// trust it — a team's overall chemistry read is only as solid as its least-tested pairing.
function teamChemistryAdjustment(team, liftMap) {
  if (team.length < 2) return { value: 0, minGp: null };
  let sum = 0, count = 0, minGp = null;
  team.forEach(a => team.forEach(b => {
    if (a === b) return;
    const entry = liftMap[`${a}|${b}`];
    if (entry !== undefined) {
      sum += entry.value;
      count++;
      minGp = minGp === null ? entry.gp : Math.min(minGp, entry.gp);
    }
  }));
  return { value: count > 0 ? sum / count : 0, minGp };
}

// Win/loss is a team fact, not an individual one — unlike Two-Way/20 lift, a pair's record while
// playing together is the same number for both of them, so this map is symmetric (one entry per
// unordered pair, "a|b" with a < b) instead of chemistry's directional one. Scans every
// qualifying game once (not once per pair), bucketing by every attendee pair that shared a
// side, and converts win% to a Two-Way/20-scale adjustment with the same (pct - 50) / 10 formula
// estimatedQualityFromReputation() already uses (10 percentage points of win rate ≈ 1 point of
// Two-Way/20) — reusing an established calibration rather than inventing a new one. A tie counts
// as half a win, matching how win% is computed everywhere else in this tool. Dampened by
// min(1, gp / 3), same confidence curve as chemistry, for the same reason: 1-2 shared games
// isn't a settled record yet. A pair who's never shared a team contributes nothing.
// Prefers the real Poolean site's own full pairwise history (POOLEAN_TOGETHER, every game the
// site has ever recorded — usually a much bigger sample than this browser's own locally logged
// subset) when it has that pair, since a bigger real sample is a strictly better estimate of the
// same fact; falls back to this app's own locally logged games otherwise, or when no export has
// been loaded at all (see build_poolean_data.py). Same confidence damping and Two-Way/20-scale
// conversion either way, so which source answered a given pair is invisible downstream.
function computeTeamWinRateMap(attendeeIds) {
  const map = {};
  const qualifyingGames = state.games.filter(isQualifyingGame);
  const hasRealTogether = typeof POOLEAN_TOGETHER !== "undefined";
  for (let i = 0; i < attendeeIds.length; i++) {
    for (let j = i + 1; j < attendeeIds.length; j++) {
      const [a, b] = [attendeeIds[i], attendeeIds[j]];
      let gp, winPct;
      const real = hasRealTogether ? POOLEAN_TOGETHER[[a, b].sort().join("|")] : null;
      if (real) {
        gp = real.gp;
        winPct = (real.w / real.gp) * 100;
      } else {
        let wins = 0, losses = 0, ties = 0;
        qualifyingGames.forEach(g => {
          const together = (g.teamA.includes(a) && g.teamA.includes(b)) || (g.teamB.includes(a) && g.teamB.includes(b));
          if (!together) return;
          const result = playerGameResult(g, a); // same team, so same result for b
          if (result === "W") wins++;
          else if (result === "L") losses++;
          else if (result === "T") ties++;
        });
        gp = wins + losses + ties;
        if (gp === 0) continue;
        winPct = ((wins + ties * 0.5) / gp) * 100;
      }
      const confidence = Math.min(1, gp / 3);
      map[`${a}|${b}`] = { value: ((winPct - 50) / 10) * confidence, gp, real: !!real };
    }
  }
  return map;
}

// Average of every known pairwise win-rate adjustment among this team's own players — symmetric
// lookup, so unlike teamChemistryAdjustment() this only needs each unordered pair once. minGp
// carried the same way and for the same reason as teamChemistryAdjustment()'s own.
function teamWinRateAdjustment(team, winRateMap) {
  if (team.length < 2) return { value: 0, minGp: null, anyReal: false };
  let sum = 0, count = 0, minGp = null, anyReal = false;
  for (let i = 0; i < team.length; i++) {
    for (let j = i + 1; j < team.length; j++) {
      const key = team[i] < team[j] ? `${team[i]}|${team[j]}` : `${team[j]}|${team[i]}`;
      const entry = winRateMap[key];
      if (entry !== undefined) {
        sum += entry.value;
        count++;
        minGp = minGp === null ? entry.gp : Math.min(minGp, entry.gp);
        if (entry.real) anyReal = true;
      }
    }
  }
  return { value: count > 0 ? sum / count : 0, minGp, anyReal };
}

// A one-sided real head-to-head is a different fact than the "Past record" win-rate adjustment
// above: that adjustment only ever looks at two players who've shared a TEAM, and folds their
// combined record into a single team's average quality. This instead looks across teams, at every
// opposing pair in a candidate split, and flags any real matchup lopsided enough to be worth
// knowing about -- e.g. one player who's 8-0 against another -- purely as a surfaced fact, never
// folded into the quality/ranking math itself (unlike win-rate/chemistry, "who tends to guard or
// outscore whom individually" isn't the same thing as "which team wins," so this doesn't try to
// re-rank candidate splits by it).
const REAL_AGAINST_WARNING_MIN_GP = 4;
const REAL_AGAINST_WARNING_THRESHOLD = 0.75;
function computeCrossTeamRivalryWarnings(teams) {
  if (typeof POOLEAN_AGAINST === "undefined") return [];
  const warnings = [];
  for (let i = 0; i < teams.length; i++) {
    for (let j = i + 1; j < teams.length; j++) {
      teams[i].forEach(a => {
        teams[j].forEach(b => {
          const v = POOLEAN_AGAINST[`${a}|${b}`];
          if (!v || v.gp < REAL_AGAINST_WARNING_MIN_GP) return;
          if (v.w / v.gp >= REAL_AGAINST_WARNING_THRESHOLD) warnings.push({ dominant: a, dominated: b, w: v.w, l: v.l });
        });
      });
    }
  }
  return warnings;
}

// ---------- Real matchup predictor ----------
// Win odds for any two teams, from a small logistic model trained on every real game in every
// imported season (not just this browser's own logged subset). Three inputs, each measured only
// from what was known BEFORE that game, so the model never learns from a game's own result:
//   1. power rankings: each side's average percentile from earlier party nights that season
//      (last season's final number for someone not ranked yet this season, else 50)
//   2. extra player: team size difference
//   3. history: how these exact players have done together (each side's pairs) and against each
//      other (every cross pair), each record pulled toward .500 by 5 phantom games so a 2-0 pair
//      doesn't count as a sure thing
// No intercept, so swapping which side is "A" just flips the odds (both sides always sum to 100%).
// Tested by leave-one-out: refit without each game in turn, then ask it to call that game.
const REAL_MATCHUP_MIN_GAMES = 15;
const REAL_MATCHUP_L2 = 0.05;
const REAL_MATCHUP_FACTOR_LABELS = ["Power rankings", "Extra player", "History together and against"];
let realMatchupModelCache = null;

function realSeasonsInOrder() {
  if (typeof POOLEAN_SEASONS === "undefined" || typeof POOLEAN_SEASON_LIST === "undefined") return [];
  return POOLEAN_SEASON_LIST.map(y => POOLEAN_SEASONS[String(y)]).filter(Boolean);
}

const sigmoid = z => 1 / (1 + Math.exp(-z));
// Real play order: by date, then game number. Game numbers alone aren't chronological, since the
// site numbers games as they're entered and some nights were entered after later ones.
const byPlayOrder = (x, y) => x.date.localeCompare(y.date) || x.n - y.n;
const shrunkEdge = rec => rec ? (rec.w + 2.5) / (rec.gp + 5) - 0.5 : 0;

function realMatchupFeatures(a, b, pctOf, togetherOf, againstOf) {
  const avg = ids => ids.reduce((sum, id) => sum + pctOf(id), 0) / ids.length;
  const chem = ids => {
    let sum = 0, n = 0;
    for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) { sum += shrunkEdge(togetherOf(ids[i], ids[j])); n++; }
    return n ? sum / n : 0;
  };
  let h2h = 0, n = 0;
  a.forEach(x => b.forEach(y => { h2h += shrunkEdge(againstOf(x, y)); n++; }));
  return [(avg(a) - avg(b)) / 10, a.length - b.length, 10 * (chem(a) - chem(b) + (n ? h2h / n : 0))];
}

function buildRealMatchupRows() {
  const rows = [];
  const together = {}, against = {};
  const bump = (map, key, won) => { const r = map[key] || (map[key] = { w: 0, gp: 0 }); r.gp++; if (won) r.w++; };
  let prevCards = null;
  realSeasonsInOrder().forEach(season => {
    const nightPcts = {};
    const rankings = [...season.rankings].sort((x, y) => x.date.localeCompare(y.date));
    let ri = 0;
    [...season.games].sort(byPlayOrder).forEach(g => {
      while (ri < rankings.length && rankings[ri].date < g.date) {
        rankings[ri].players.forEach(p => (nightPcts[p.slug] = nightPcts[p.slug] || []).push(p.pct));
        ri++;
      }
      const pctOf = id => {
        const v = nightPcts[id];
        if (v && v.length) return v.reduce((x, y) => x + y, 0) / v.length;
        return prevCards && prevCards[id] ? prevCards[id].powerPct : 50;
      };
      const x = realMatchupFeatures(g.a, g.b, pctOf, (p, q) => together[[p, q].sort().join("|")], (p, q) => against[`${p}|${q}`]);
      const aWon = g.w === "A";
      rows.push({ x, y: aWon ? 1 : 0 });
      const pairs = ids => ids.flatMap((p, i) => ids.slice(i + 1).map(q => [p, q].sort().join("|")));
      pairs(g.a).forEach(k => bump(together, k, aWon));
      pairs(g.b).forEach(k => bump(together, k, !aWon));
      g.a.forEach(p => g.b.forEach(q => { bump(against, `${p}|${q}`, aWon); bump(against, `${q}|${p}`, !aWon); }));
    });
    prevCards = season.cards;
  });
  return rows;
}

function fitRealMatchupWeights(rows, start = [0, 0, 0], iterations = 1500) {
  const w = [...start];
  const lr = 0.1;
  for (let it = 0; it < iterations; it++) {
    const g = [0, 0, 0];
    rows.forEach(r => {
      const err = sigmoid(w[0] * r.x[0] + w[1] * r.x[1] + w[2] * r.x[2]) - r.y;
      for (let k = 0; k < 3; k++) g[k] += err * r.x[k];
    });
    for (let k = 0; k < 3; k++) w[k] -= lr * (g[k] / rows.length + REAL_MATCHUP_L2 * w[k]);
  }
  return w;
}

// Where everyone stands right now: latest season's power ranking % (earlier season's for anyone
// not ranked this season), and every season's together/against records summed.
function realMatchupLookups() {
  const pct = {}, together = {}, against = {};
  const add = (map, src) => Object.entries(src).forEach(([k, v]) => { const r = map[k] || (map[k] = { w: 0, gp: 0 }); r.w += v.w; r.gp += v.gp; });
  realSeasonsInOrder().forEach(season => {
    Object.entries(season.cards).forEach(([slug, c]) => { pct[slug] = c.powerPct; });
    add(together, season.together);
    add(against, season.against);
  });
  return {
    pctOf: id => pct[id] ?? 50,
    hasPct: id => id in pct,
    togetherOf: (p, q) => together[[p, q].sort().join("|")],
    againstOf: (p, q) => against[`${p}|${q}`]
  };
}

function getRealMatchupModel() {
  if (realMatchupModelCache !== null) return realMatchupModelCache || null;
  const rows = buildRealMatchupRows();
  if (rows.length < REAL_MATCHUP_MIN_GAMES) { realMatchupModelCache = false; return null; }
  const w = fitRealMatchupWeights(rows);
  let looCorrect = 0, looN = 0;
  rows.forEach((r, i) => {
    // Starting from the full fit: dropping one game barely moves the answer, so a short refit
    // lands in the same place as a from-scratch one at a fraction of the cost.
    const wi = fitRealMatchupWeights(rows.filter((_, j) => j !== i), w, 150);
    const p = sigmoid(wi[0] * r.x[0] + wi[1] * r.x[1] + wi[2] * r.x[2]);
    if (p === 0.5) return;
    looN++;
    if ((p > 0.5) === (r.y === 1)) looCorrect++;
  });
  realMatchupModelCache = { w, n: rows.length, looCorrect, looN, lookups: realMatchupLookups() };
  return realMatchupModelCache;
}

// Team A's chance to win, plus how much each input leans the game on its own (in percentage
// points above 50, positive toward A). null until there are enough real games to train on.
function predictRealMatchup(teamA, teamB) {
  const model = getRealMatchupModel();
  if (!model || teamA.length === 0 || teamB.length === 0) return null;
  const L = model.lookups;
  const x = realMatchupFeatures(teamA, teamB, L.pctOf, L.togetherOf, L.againstOf);
  const pA = sigmoid(model.w[0] * x[0] + model.w[1] * x[1] + model.w[2] * x[2]);
  const factors = x.map((v, k) => ({ label: REAL_MATCHUP_FACTOR_LABELS[k], lean: (sigmoid(model.w[k] * v) - 0.5) * 100 }));
  const unranked = [...teamA, ...teamB].filter(id => !L.hasPct(id));
  return { pA, factors, unranked, model };
}

function realMatchupAccuracyText(model) {
  return model.looN ? `Tested on real games it wasn't trained on, it picked the winner in ${model.looCorrect} of ${model.looN} (${Math.round(model.looCorrect / model.looN * 100)}%).` : "";
}

// Every player the predictor can use: the local roster plus every real-site player, by name.
function realMatchupPlayerPool() {
  const ids = new Set(state.players.map(p => p.id));
  if (typeof POOLEAN_SEASONS !== "undefined") realSeasonsInOrder().forEach(s => Object.keys(s.names || {}).forEach(id => ids.add(id)));
  return [...ids].map(id => ({ id, name: poolNameOf(id) })).sort((a, b) => a.name.localeCompare(b.name));
}

// Leaderboard panel: tap a chip once for Team A, again for Team B, again to clear.
const matchupPredictorSides = {};
function renderMatchupPredictor() {
  const picker = document.getElementById("matchupPredictorPicker");
  const result = document.getElementById("matchupPredictorResult");
  if (!picker || !result) return;
  const model = getRealMatchupModel();
  if (!model) {
    picker.innerHTML = "";
    result.innerHTML = `<p class="empty-state">Needs at least ${REAL_MATCHUP_MIN_GAMES} real games imported before it can predict anything.</p>`;
    return;
  }
  picker.innerHTML = realMatchupPlayerPool().map(p => {
    const side = matchupPredictorSides[p.id];
    return `<button type="button" class="attendee-chip${side ? ` selected matchup-chip-${side.toLowerCase()}` : ""}" data-matchup-id="${escapeHtml(p.id)}">${side ? `${side} · ` : ""}${escapeHtml(p.name)}</button>`;
  }).join("");
  picker.querySelectorAll("[data-matchup-id]").forEach(btn => btn.addEventListener("click", () => {
    const id = btn.dataset.matchupId;
    const next = { undefined: "A", A: "B", B: undefined }[matchupPredictorSides[id]];
    if (next) matchupPredictorSides[id] = next; else delete matchupPredictorSides[id];
    renderMatchupPredictor();
  }));
  renderMatchupTrackRecord();
  const teamA = Object.keys(matchupPredictorSides).filter(id => matchupPredictorSides[id] === "A");
  const teamB = Object.keys(matchupPredictorSides).filter(id => matchupPredictorSides[id] === "B");
  const pred = predictRealMatchup(teamA, teamB);
  if (!pred) {
    result.innerHTML = `<p class="hint" style="margin:10px 0 0">Put at least one player on each team. ${realMatchupAccuracyText(model)}</p>`;
    return;
  }
  result.innerHTML = renderMatchupOddsHtml(teamA, teamB, pred) +
    `<p class="hint" style="margin:10px 0 0">${realMatchupAccuracyText(model)} Trained on ${model.n} real games.</p>`;
}

// Track record: before each party night, refit on only the games played before it and call that
// night's games. An honest out-of-time test, and it shows whether the odds improve as the model
// sees more games. Nights before it has REAL_MATCHUP_MIN_GAMES to learn from are skipped.
let realMatchupTrackCache = null;
function computeRealMatchupTrackRecord() {
  if (realMatchupTrackCache) return realMatchupTrackCache;
  const rows = buildRealMatchupRows();
  const games = realSeasonsInOrder().flatMap(season => [...season.games].sort(byPlayOrder));
  const nights = [];
  let i = 0;
  while (i < games.length) {
    let j = i;
    while (j < games.length && games[j].date === games[i].date) j++;
    if (i >= REAL_MATCHUP_MIN_GAMES) {
      const w = fitRealMatchupWeights(rows.slice(0, i));
      let correct = 0, called = 0;
      for (let k = i; k < j; k++) {
        const p = sigmoid(w[0] * rows[k].x[0] + w[1] * rows[k].x[1] + w[2] * rows[k].x[2]);
        if (p === 0.5) continue;
        called++;
        if ((p > 0.5) === (rows[k].y === 1)) correct++;
      }
      nights.push({ date: games[i].date, correct, called });
    }
    i = j;
  }
  const sum = list => list.reduce((acc, n) => ({ correct: acc.correct + n.correct, called: acc.called + n.called }), { correct: 0, called: 0 });
  const half = Math.floor(nights.length / 2);
  realMatchupTrackCache = { nights, total: sum(nights), early: sum(nights.slice(0, half)), late: sum(nights.slice(half)) };
  return realMatchupTrackCache;
}

function renderMatchupTrackRecord() {
  const wrap = document.getElementById("matchupTrackRecord");
  if (!wrap) return;
  const t = computeRealMatchupTrackRecord();
  if (t.nights.length === 0 || t.total.called === 0) { wrap.innerHTML = ""; return; }
  const pctOf = x => x.called ? Math.round(x.correct / x.called * 100) : 0;
  const trend = t.nights.length >= 4 && t.early.called && t.late.called
    ? ` First half of those nights: ${pctOf(t.early)}%. Second half: ${pctOf(t.late)}%.` : "";
  const rows = [...t.nights].reverse().map((n, idx) =>
    `<li>${escapeHtml(formatDateDisplay(n.date))}${idx === 0 ? ' <span class="real-data-tag">Latest</span>' : ""} <span class="hint" style="margin:0">called ${n.correct} of ${n.called}</span></li>`).join("");
  wrap.innerHTML = `<details class="matchup-track">
    <summary>Track record: ${t.total.correct} of ${t.total.called} (${pctOf(t.total)}%) called right before they were played</summary>
    <p class="hint" style="margin:8px 0">Before each party night, the model is retrained on only the games before it, then asked to call that night's games.${trend}</p>
    <ul class="player-tips-list" style="display:block">${rows}</ul>
  </details>`;
}

function renderMatchupOddsHtml(teamA, teamB, pred) {
  const pA = Math.round(pred.pA * 100), pB = 100 - pA;
  const names = ids => ids.map(poolPlayerLink).join(", ");
  const factorHtml = pred.factors.filter(f => Math.abs(f.lean) >= 1).map(f =>
    `<li>${escapeHtml(f.label)}: leans ${f.lean > 0 ? "Team A" : "Team B"} +${Math.round(Math.abs(f.lean))}%</li>`).join("");
  const unranked = pred.unranked.length ? `<p class="hint" style="margin:6px 0 0">No power ranking yet for ${pred.unranked.map(id => escapeHtml(poolNameOf(id))).join(", ")}, counted as average.</p>` : "";
  return `<div class="matchup-odds">
      <div class="matchup-odds-side"><span class="matchup-odds-pct">${pA}%</span><span class="matchup-odds-label">Team A</span><span class="matchup-odds-names">${names(teamA)}</span></div>
      <div class="matchup-odds-side matchup-odds-side-b"><span class="matchup-odds-pct">${pB}%</span><span class="matchup-odds-label">Team B</span><span class="matchup-odds-names">${names(teamB)}</span></div>
    </div>
    <div class="matchup-odds-bar" role="img" aria-label="Team A ${pA} percent, Team B ${pB} percent"><span style="width:${pA}%"></span></div>
    ${factorHtml ? `<ul class="matchup-odds-factors">${factorHtml}</ul>` : `<p class="hint" style="margin:8px 0 0">Nothing separates these two teams: a coin flip.</p>`}
    ${unranked}`;
}

// ---------- Balance Teams: win chances ----------
// Each team's chance to win, from the Matchup Predictor. Two teams play one game, so the two
// chances sum to 100%. With three or more teams, each team's number is its average chance
// against every other team in the split. null until the predictor has enough real games.
function predictTeamWinChances(teams) {
  if (teams.length < 2 || !getRealMatchupModel()) return null;
  const vs = teams.map(() => []);
  for (let i = 0; i < teams.length; i++) {
    for (let j = i + 1; j < teams.length; j++) {
      const p = predictRealMatchup(teams[i], teams[j]).pA;
      vs[i].push(p);
      vs[j].push(1 - p);
    }
  }
  return vs.map(v => v.reduce((a, b) => a + b, 0) / v.length);
}

// How far the least even pairing in a split sits from 50/50, in percentage points.
function worstPairingGap(teams) {
  let worst = 0;
  for (let i = 0; i < teams.length; i++) {
    for (let j = i + 1; j < teams.length; j++) {
      worst = Math.max(worst, Math.abs(predictRealMatchup(teams[i], teams[j]).pA - 0.5) * 100);
    }
  }
  return worst;
}

// Tiebreaker only, by design (Two-Way spread is the real, measured/estimated signal and always
// wins — see the sort in generateBalancedTeamSets()). Three components, summed: how far apart
// each team's *average* height is in inches (mirrors scoreTeamSet()'s own average-not-total
// logic, same reasoning), how far apart each team's *average* build is on PLAYER_PHYSICAL_DATA's
// 1-5 scale (weighted down to 0.75x, not up — build is the softest signal of the three, Claude's
// own coarse read of vague prose like "decently sized", so it should carry less say than either
// height, a real parsed number, or role), and how unevenly the five role tags land across teams —
// for each role, the variance of its per-team count, summed across all five roles, weighted 1.5x.
// Role variance carries the most weight of the three: a couple of inches or a build-point of
// average difference matters less than one team getting every defender-tagged player on the
// roster and the other getting none.
function scorePhysicalBalance(teams) {
  const avgOf = field => {
    const vals = teams
      .map(team => team.map(id => getPlayerPhysicalData(id)?.[field]).filter(v => v !== undefined))
      .filter(known => known.length > 0)
      .map(known => known.reduce((a, b) => a + b, 0) / known.length);
    return vals.length >= 2 ? Math.max(...vals) - Math.min(...vals) : 0;
  };
  const heightSpread = avgOf("heightIn");
  const buildSpread = avgOf("build");
  const effortSpread = avgOf("effort");

  // A player with two roles (see PLAYER_PHYSICAL_DATA) counts toward both here — the goal is
  // "does each team have coverage of this role," which a two-role player satisfies for either.
  let roleImbalance = 0;
  Object.keys(PHYSICAL_ROLE_LABELS).forEach(role => {
    const countsPerTeam = teams.map(team => team.filter(id => (getPlayerPhysicalData(id)?.roles || []).includes(role)).length);
    const total = countsPerTeam.reduce((a, b) => a + b, 0);
    if (total === 0) return;
    const mean = total / teams.length;
    roleImbalance += countsPerTeam.reduce((sum, c) => sum + Math.pow(c - mean, 2), 0) / teams.length;
  });

  // role(0.75x) == height(0.75x) == build(0.75x) == effort(0.75x) — all four tied at the same,
  // deliberately light weight (on top of the separate, still-real height-floor guideline below;
  // role was originally weighted 1.5x, walked down to match the other three per direct
  // feedback). Effort never surfaces as a .profile-tag pill anywhere (unlike the other three) —
  // it factors into balancing without becoming a visible label on a player.
  return heightSpread * 0.75 + buildSpread * 0.75 + effortSpread * 0.75 + roleImbalance * 0.75;
}

// Season Two-Way/20 — or, for a player with no games logged yet, a reputation-based estimate
// from PLAYER_REPUTATION_DATA (real power-ranking percentile, not a flat neutral 0) — is the
// balancing currency: Two-Way/20 is already this tool's single "how good, overall" number, used
// the same way for MVP-style comparisons elsewhere. Team count is whichever integer is closest
// to attendees/teamSize (at least 2, since a "team" needs an opponent) — for example 7 attendees
// at a team size of 3 rounds to 2 teams (sizes 4 and 3) rather than 3 (sizes 3,2,2), matching how
// an odd number out in real pickup usually just makes one side's bench thicker instead of
// spinning up a third team. Runs one seeded snake-draft candidate plus 300 randomized ones,
// dedupes identical team compositions, and returns the 5 lowest-spread survivors.
// Average height across whichever of today's attendees have a PLAYER_PHYSICAL_DATA entry — the
// relevant baseline for "above average" is this specific group showing up today, not the whole
// league roster. null when nobody in the group has height data at all (the height-floor
// constraint below is a no-op in that case, same as it would be for any group with zero signal).
function averageAttendeeHeight(attendeeIds) {
  const heights = attendeeIds.map(id => getPlayerPhysicalData(id)?.heightIn).filter(h => h !== undefined);
  return heights.length > 0 ? heights.reduce((a, b) => a + b, 0) / heights.length : null;
}
function teamHasAboveAverageHeight(team, avgHeight) {
  if (avgHeight === null) return true;
  return team.some(id => (getPlayerPhysicalData(id)?.heightIn ?? -Infinity) > avgHeight);
}

// Hill-climb refinement so chemistry/win-rate can actually shape which team compositions come
// out of the search, not just rank whatever randomGreedyTeams() happened to generate on
// individual quality alone. Tries `iterations` random single-player swaps between two of this
// candidate's own teams, keeping a swap only when it lowers scoreTeamSet()'s own spread (the
// full quality + chemistry + win-rate blend) — a simple "keep what works" local search, not an
// exhaustive one, same spirit as the randomized generation it's refining. Never looks at
// physicalScore; height/build/role stay a pure tiebreak applied after this step, not something
// this search optimizes for.
function localSearchRefine(teams, qualityById, liftMap, winRateMap, iterations, nudgeCap) {
  if (teams.length < 2) return teams;
  let current = teams.map(t => [...t]);
  let currentSpread = scoreTeamSet(current, qualityById, liftMap, winRateMap, nudgeCap).spread;
  for (let iter = 0; iter < iterations; iter++) {
    const ti = Math.floor(Math.random() * current.length);
    let tj = Math.floor(Math.random() * current.length);
    if (tj === ti) tj = (tj + 1) % current.length;
    if (current[ti].length === 0 || current[tj].length === 0) continue;
    const pi = Math.floor(Math.random() * current[ti].length);
    const pj = Math.floor(Math.random() * current[tj].length);
    const candidate = current.map(t => [...t]);
    [candidate[ti][pi], candidate[tj][pj]] = [candidate[tj][pj], candidate[ti][pi]];
    const candidateSpread = scoreTeamSet(candidate, qualityById, liftMap, winRateMap, nudgeCap).spread;
    if (candidateSpread < currentSpread) {
      current = candidate;
      currentSpread = candidateSpread;
    }
  }
  return current;
}

function generateBalancedTeamSets(attendeeIds, teamSize) {
  const qualityMap = computeBalanceQualityMap();
  const qualityById = {};
  Object.entries(qualityMap).forEach(([id, v]) => { qualityById[id] = v.quality; });
  const liftMap = computeChemistryLiftMap(attendeeIds);
  const winRateMap = computeTeamWinRateMap(attendeeIds);
  // Bounds the combined chemistry+win-rate nudge (see scoreTeamSet()'s own comment) to a fifth of
  // *tonight's specific attendees'* own quality spread, not the whole roster's — so the cap scales
  // with how spread-out this particular group actually is instead of one fixed number that's too
  // loose for a lopsided group and too tight for an even one.
  const attendeeQualities = attendeeIds.map(id => qualityById[id] || 0);
  const nudgeCap = (Math.max(...attendeeQualities) - Math.min(...attendeeQualities)) / 5;

  const numTeams = Math.max(2, Math.round(attendeeIds.length / Math.max(1, teamSize)));
  const base = Math.floor(attendeeIds.length / numTeams);
  const remainder = attendeeIds.length % numTeams;
  const targetSizes = Array.from({ length: numTeams }, (_, i) => base + (i < remainder ? 1 : 0));

  const sortedByQuality = [...attendeeIds].sort((a, b) => (qualityById[b] || 0) - (qualityById[a] || 0));
  const candidates = [snakeDraftTeams(sortedByQuality, targetSizes)];
  for (let i = 0; i < 300; i++) candidates.push(randomGreedyTeams(attendeeIds, targetSizes, qualityById));

  const seen = new Set();
  const scored = [];
  candidates.forEach(teams => {
    const sig = teamSetSignature(teams);
    if (seen.has(sig)) return;
    seen.add(sig);
    scored.push({ teams, ...scoreTeamSet(teams, qualityById, liftMap, winRateMap, nudgeCap) });
  });
  scored.sort((a, b) => a.spread - b.spread);

  // randomGreedyTeams() above only ever optimized individual quality while building a candidate
  // — chemistry/win-rate only entered the picture just now, when scoring what it happened to
  // generate. That means a genuinely great chemistry- or win-rate-driven split could
  // theoretically never get generated in the first place if it looked mediocre on individual
  // quality alone. Local-search refinement closes that gap: take the best 30 candidates by the
  // (quality + chemistry + win-rate) spread just computed, and hill-climb each one with random
  // pairwise player swaps between two of its own teams, keeping any swap that lowers that same
  // spread. Refining already-decent starting points instead of far-from-balanced random ones
  // keeps this cheap and focused. Deliberately targets spread only, never physicalScore — height/
  // build/role stay a pure post-hoc tiebreak, untouched by this step.
  const refinedSeen = new Set();
  const refined = [];
  scored.slice(0, 30).forEach(entry => {
    const improvedTeams = localSearchRefine(entry.teams, qualityById, liftMap, winRateMap, 25, nudgeCap);
    const sig = teamSetSignature(improvedTeams);
    if (refinedSeen.has(sig)) return;
    refinedSeen.add(sig);
    refined.push({ teams: improvedTeams, ...scoreTeamSet(improvedTeams, qualityById, liftMap, winRateMap, nudgeCap) });
  });
  refined.sort((a, b) => a.spread - b.spread);

  // How much of this group is a reputation-based guess rather than a real measured Two-Way
  // number decides how much slack the physical/role tiebreaker gets: a spread built entirely on
  // real stats shouldn't get second-guessed over hundredths of a point, but a spread that's
  // mostly reputation estimates is itself mostly a guess, so two options within a full point of
  // each other are practically indistinguishable on quality alone — physical/role should get
  // real say in picking between them. 0.1 (near-zero slack) at 0% reputation-estimated up to 1.0
  // at 100%. Re-sorting only the best-spread slice (not the full 300+ pool) keeps this tolerance
  // check from producing weird orderings between options that were never close to begin with.
  const reputationShare = attendeeIds.length > 0
    ? attendeeIds.filter(id => qualityMap[id]?.source !== "stats").length / attendeeIds.length
    : 0;
  const tieTolerance = 0.1 + reputationShare * 0.9;
  const avgAttendeeHeight = averageAttendeeHeight(attendeeIds);
  const tallFirst = (a, b) => {
    const aTall = a.teams.every(team => teamHasAboveAverageHeight(team, avgAttendeeHeight));
    const bTall = b.teams.every(team => teamHasAboveAverageHeight(team, avgAttendeeHeight));
    return aTall === bTall ? 0 : aTall ? -1 : 1;
  };

  // With enough real games for the Matchup Predictor: rank by its odds instead of the quality
  // spread, closest to 50/50 first (for 3+ teams, by the least even pairing in the split). The predictor was tested against real results;
  // the spread wasn't, and the two can disagree (a "most balanced" 30/70). Quality, chemistry and
  // past record still build every candidate above. Adding quality to the predictor as a fourth
  // input was tried and didn't hold up: its gain matched what the predictor gets from seeing the
  // whole season's results in advance, and the film-only part didn't help. Options within
  // ODDS_TIE_POINTS of each other count as tied and fall to height, physical, then spread.
  if (getRealMatchupModel()) {
    const ODDS_TIE_POINTS = 2;
    const gapOf = worstPairingGap;
    const all = new Map();
    [...scored, ...refined].forEach(e => all.set(teamSetSignature(e.teams), { ...e, oddsGap: gapOf(e.teams) }));
    // Swap-based refinement on the predictor's own number, same idea as localSearchRefine().
    [...all.values()].sort((a, b) => a.oddsGap - b.oddsGap).slice(0, 10).forEach(entry => {
      let teams = entry.teams.map(t => [...t]), gap = entry.oddsGap;
      for (let it = 0; it < 40; it++) {
        const ta = Math.floor(Math.random() * teams.length);
        const tb = (ta + 1 + Math.floor(Math.random() * (teams.length - 1))) % teams.length;
        const i = Math.floor(Math.random() * teams[ta].length), j = Math.floor(Math.random() * teams[tb].length);
        const cand = teams.map(t => [...t]);
        [cand[ta][i], cand[tb][j]] = [cand[tb][j], cand[ta][i]];
        const g = gapOf(cand);
        if (g < gap) { teams = cand; gap = g; }
      }
      const sig = teamSetSignature(teams);
      if (!all.has(sig)) all.set(sig, { teams, ...scoreTeamSet(teams, qualityById, liftMap, winRateMap, nudgeCap), oddsGap: gap });
    });
    return [...all.values()].sort((a, b) => {
      if (Math.abs(a.oddsGap - b.oddsGap) > ODDS_TIE_POINTS) return a.oddsGap - b.oddsGap;
      return tallFirst(a, b) || a.physicalScore - b.physicalScore || a.spread - b.spread;
    }).slice(0, 5);
  }

  // "Every team needs someone above today's average height" is a strong guideline, not a hard
  // rule — it only gets to decide between options that are already practically tied on quality
  // (the same tolerance window physical/role uses), and even there it's checked before
  // physicalScore, not folded into it, since it's the more important of the two. A genuinely
  // better-balanced split outside that tolerance window still wins even if it fails the height
  // check — this never excludes a candidate outright, just ranks it behind an equally-fair one
  // that also clears the bar.
  const pool = refined.slice(0, 30);
  pool.sort((a, b) => {
    if (Math.abs(a.spread - b.spread) <= tieTolerance) return tallFirst(a, b) || a.physicalScore - b.physicalScore;
    return a.spread - b.spread;
  });
  return pool.slice(0, 5);
}

// Real head-to-head history between two specific rosters about to face each other — reuses
// computeMatchupGrid()'s own per-pair FG data rather than re-deriving it, scoped down to just
// the cross-team pairs relevant to this specific matchup (a teammate never guards a teammate in
// the game about to happen, so same-team pairs are skipped entirely rather than shown as
// meaningless dashes). Both directions count: team A shooting on team B's defenders, and team B
// shooting on team A's. Sorted by attempts, most-tested pairings first, so it reads as "this is
// what we actually know" rather than a wall of mostly-empty cells for pairs with no history yet.
function computeCrossTeamMatchups(teamA, teamB) {
  const { cellFor } = computeMatchupGrid();
  const rows = [];
  const addPairs = (scorers, defenders) => {
    scorers.forEach(scorerId => {
      defenders.forEach(defenderId => {
        const cell = cellFor(scorerId, defenderId);
        if (cell) rows.push({ scorerId, defenderId, fgm: cell.fgm, fga: cell.fga });
      });
    });
  };
  addPairs(teamA, teamB);
  addPairs(teamB, teamA);
  return rows.sort((a, b) => b.fga - a.fga);
}

function renderMatchupPreviewTable(teamA, teamB) {
  const rows = computeCrossTeamMatchups(teamA, teamB);
  if (rows.length === 0) {
    return '<p class="empty-state" style="margin:0">No head-to-head history between these two teams yet.</p>';
  }
  const rowsHtml = rows.map(r => {
    const scorer = state.players.find(p => p.id === r.scorerId)?.name || "?";
    const defender = state.players.find(p => p.id === r.defenderId)?.name || "?";
    return `<tr><td>${escapeHtml(scorer)}</td><td>${escapeHtml(defender)}</td><td>${r.fgm}/${r.fga}</td><td>${pct(r.fgm, r.fga)}%</td></tr>`;
  }).join("");
  return `
    <div class="table-scroll">
      <table class="matchup-table balance-preview-table">
        <thead><tr><th>Scorer</th><th>Defender</th><th>FG</th><th>FG%</th></tr></thead>
        <tbody>${rowsHtml}</tbody>
      </table>
    </div>
  `;
}

function renderBalanceResults() {
  const wrap = document.getElementById("balanceTeamsResults");
  if (!wrap) return;
  if (balanceResults.length === 0) {
    wrap.innerHTML = "";
    return;
  }
  const qualityMap = computeBalanceQualityMap();
  const anyEstimated = Object.values(qualityMap).some(v => v.source === "reputation");
  const liftMap = computeChemistryLiftMap([...balanceAttendeeIds]);
  const winRateMap = computeTeamWinRateMap([...balanceAttendeeIds]);
  wrap.innerHTML = balanceResults.map((r, i) => {
    const winProbs = predictTeamWinChances(r.teams);
    const realPred = r.teams.length === 2 && winProbs ? predictRealMatchup(r.teams[0], r.teams[1]) : null;
    // Surfaces the height/build/role tiebreak's own reasoning per team, not just its effect on
    // ranking — a player's name is titled with their height/build/role/original note straight
    // from PLAYER_PHYSICAL_DATA (hover to see exactly what drove a categorization), and each
    // team gets a one-line summary underneath its roster. A team's chemistry adjustment (real
    // "with this teammate vs. without" lift, already folded into its avg above) gets its own
    // small callout when it's large enough to matter, so that part of the ranking isn't hidden
    // inside one blended number either.
    const teamsHtml = r.teams.map((team, ti) => {
      const heights = team.map(id => getPlayerPhysicalData(id)?.heightIn).filter(h => h !== undefined);
      const avgHeightLabel = heights.length > 0 ? formatHeightIn(heights.reduce((a, b) => a + b, 0) / heights.length) : null;
      const builds = team.map(id => getPlayerPhysicalData(id)?.build).filter(b => b !== undefined);
      const avgBuildLabel = builds.length > 0 ? BUILD_LABELS[Math.round(builds.reduce((a, b) => a + b, 0) / builds.length)] : null;
      const efforts = team.map(id => getPlayerPhysicalData(id)?.effort).filter(e => e !== undefined);
      const avgEffortLabel = efforts.length > 0 ? EFFORT_LABELS[Math.round(efforts.reduce((a, b) => a + b, 0) / efforts.length)] : null;
      const roleCounts = {};
      team.forEach(id => {
        (getPlayerPhysicalData(id)?.roles || []).forEach(role => {
          roleCounts[role] = (roleCounts[role] || 0) + 1;
        });
      });
      // Same colored .profile-tag pills as the Players tab (physicalProfileTags()), not a plain
      // text list — one glance at a team card now shows the same role colors used everywhere
      // else a role shows up, instead of two different visual languages for the same data.
      const roleTagsHtml = Object.keys(roleCounts).length > 0
        ? `<span class="profile-tags">${Object.entries(roleCounts).map(([role, count]) => `<span class="profile-tag profile-tag-${role}">${count} ${PHYSICAL_ROLE_LABELS[role]}${count > 1 ? "s" : ""}</span>`).join("")}</span>`
        : "";
      const avgText = [
        avgHeightLabel ? `Avg height: ${avgHeightLabel}` : "",
        avgBuildLabel ? `Avg build: ${avgBuildLabel}` : "",
        avgEffortLabel ? `Avg effort: ${avgEffortLabel}` : ""
      ].filter(Boolean).join(" · ");
      const physicalLine = avgText || roleTagsHtml
        ? `<div class="balance-team-physical">${avgText ? `<div>${avgText}</div>` : ""}${roleTagsHtml}</div>`
        : "";
      const chem = teamChemistryAdjustment(team, liftMap);
      const chemGamesNote = chem.minGp !== null ? ` (min ${chem.minGp} game${chem.minGp === 1 ? "" : "s"} together)` : "";
      const chemLine = Math.abs(chem.value) >= 0.1
        ? `<div class="balance-team-physical" title="Average Two-Way/20 lift from real past games with these specific teammates, already included in the avg above.">Chemistry: ${chem.value >= 0 ? "+" : ""}${chem.value.toFixed(1)}${chemGamesNote}</div>`
        : "";
      const winAdj = teamWinRateAdjustment(team, winRateMap);
      const winGamesNote = winAdj.minGp !== null ? ` (min ${winAdj.minGp} game${winAdj.minGp === 1 ? "" : "s"} together${winAdj.anyReal ? ", real site record" : ""})` : "";
      const winLine = Math.abs(winAdj.value) >= 0.1
        ? `<div class="balance-team-physical" title="Two-Way/20-scale adjustment from this pairing's actual win rate in past games together, already included in the avg above. Uses the real Poolean site's full game history when it has these two as teammates, not just this browser's own logged subset.">Past record: ${winAdj.value >= 0 ? "+" : ""}${winAdj.value.toFixed(1)}${winGamesNote}</div>`
        : "";
      const winProbTitle = winProbs
        ? `Matchup Predictor, trained on ${getRealMatchupModel().n} real games: ${r.teams.length > 2 ? "this team's average chance against each of the other teams" : "this team's chance against the team across from it"}. ${realMatchupAccuracyText(getRealMatchupModel())}`
        : "";
      const winProbLabel = winProbs
        ? `<span class="balance-team-winprob" title="${escapeHtml(winProbTitle)}">${Math.round(winProbs[ti] * 100)}% win</span>`
        : "";
      return `
        <div class="balance-team-card">
          <h5><span>Team ${String.fromCharCode(65 + ti)}</span><span class="balance-team-metrics"><span class="balance-team-avg">${r.avgs[ti].toFixed(1)} avg</span>${winProbLabel}</span></h5>
          <ul>${team.map(id => {
            const name = state.players.find(p => p.id === id)?.name || "?";
            const marker = qualityMap[id]?.source === "reputation" ? " *" : "";
            const phys = getPlayerPhysicalData(id);
            const roleLabel = phys ? phys.roles.map(r => PHYSICAL_ROLE_LABELS[r]).join("/") : "";
            const effortLabel = phys?.effort !== undefined ? `${EFFORT_LABELS[phys.effort]} effort, ` : "";
            const titleText = phys ? `${formatHeightIn(phys.heightIn)}, ${BUILD_LABELS[phys.build]}, ${effortLabel}${roleLabel}${phys.note ? " (" + phys.note + ")" : ""}` : "";
            const title = phys ? ` title="${escapeHtml(titleText)}"` : "";
            return `<li${title}>${escapeHtml(name)}${marker}</li>`;
          }).join("")}</ul>
          ${physicalLine}
          ${chemLine}
          ${winLine}
        </div>
      `;
    }).join("");
    const buttonsHtml = r.teams.length === 2
      ? `<button type="button" class="secondary-btn balance-preview-btn" data-index="${i}">Preview Matchups</button>
         <button type="button" class="secondary-btn balance-use-btn" data-index="${i}">Use These Teams &rarr; Create Game</button>${liveGameEnabled() ? `
         <button type="button" class="secondary-btn balance-live-btn" data-index="${i}">Play Live</button>` : ""}`
      : "";
    const previewHtml = r.teams.length === 2
      ? `<div class="balance-preview-wrap" id="balancePreview${i}" hidden>${renderMatchupPreviewTable(r.teams[0], r.teams[1])}</div>`
      : "";
    const rivalryWarnings = computeCrossTeamRivalryWarnings(r.teams);
    const rivalryHtml = rivalryWarnings.length === 0 ? "" : `<div class="balance-rivalry-warnings">${rivalryWarnings.map(w => `
      <div class="balance-rivalry-warning" title="Real Poolean site record, not this browser's own logged games.">⚔️ ${poolPlayerLink(w.dominant)} is ${w.w}-${w.l} against ${poolPlayerLink(w.dominated)} in real games, on opposite teams tonight</div>`).join("")}</div>`;
    return `
      <div class="balance-option ${i === 0 ? "balance-option-best" : ""}">
        <div class="balance-option-header">
          <strong>${i === 0 ? "🏆 Most Balanced" : `Option ${i + 1}`}</strong>
          <span class="balance-spread">${realPred ? `Predicted ${Math.round(realPred.pA * 100)}% / ${100 - Math.round(realPred.pA * 100)}% · ` : ""}Δ${r.spread.toFixed(1)} Two-Way/20 between strongest and weakest team</span>
        </div>
        <div class="balance-teams-row">${teamsHtml}</div>
        ${rivalryHtml}
        ${buttonsHtml}
        ${previewHtml}
      </div>
    `;
  }).join("") + (anyEstimated
    ? '<p class="hint" style="margin:0">* No dashboard stats yet: quality estimated from real power-ranking reputation (see the attendee picker above for each one\'s percentile), not logged film.</p>'
    : "");
  wrap.querySelectorAll(".balance-live-btn").forEach(btn => btn.addEventListener("click", () => {
    const r = balanceResults[Number(btn.dataset.index)];
    startLiveGame(r.teams[0], r.teams[1]);
  }));
  wrap.querySelectorAll(".balance-use-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const r = balanceResults[Number(btn.dataset.index)];
      applyBalancedTeamsToNewGame(r.teams[0], r.teams[1]);
    });
  });
  wrap.querySelectorAll(".balance-preview-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const panel = document.getElementById(`balancePreview${btn.dataset.index}`);
      if (!panel) return;
      panel.hidden = !panel.hidden;
      btn.textContent = panel.hidden ? "Preview Matchups" : "Hide Matchups";
    });
  });
}

// Creates a real game with the chosen split pre-filled as teamA/teamB, same shape addGameForm's
// own submit handler builds, reusing whatever date is currently set in that form.
function applyBalancedTeamsToNewGame(teamA, teamB) {
  const date = document.getElementById("gameDateInput").value;
  const game = { id: uid("game"), date, videoUrl: "", notes: "", winner: null, teamA: [...teamA], teamB: [...teamB], stats: [], matchups: [], scoringEvents: [], plays: [] };
  normalizeGame(game);
  state.games.push(game);
  saveState();
  renderGames();
  openGame(game.id);
}

// ---------- Live Game ----------
// A who-scored tracker for party night: pick two teams, tap +1/+2/+3 on whoever scored. Scores
// go in game.liveScores, not the shot log, so a live game never feeds any stat (no misses,
// defenders or assists were tracked); it counts once it's logged from film in Stat Entry, like
// any other unreviewed game. Saved after every tap, so a locked phone or closed tab loses
// nothing. Only on the dashboard (needs #liveGamePanel).
const LIVE_TARGETS = [16, 21];
let liveSetupSides = {};
let liveWakeLock = null;

function liveGameEnabled() {
  return !!document.getElementById("liveGamePanel");
}
function liveGameInProgress() {
  return state.games.find(g => g.liveInProgress) || null;
}
function liveScoreOf(game, team) {
  return (game.liveScores || []).filter(s => team.includes(s.pid)).reduce((sum, s) => sum + s.points, 0);
}
// A game with only a live score (nothing logged from film yet).
function isLiveScoreOnly(game) {
  return game.scoringEvents.length === 0 && (game.liveScores || []).length > 0;
}

function startLiveGame(teamA, teamB) {
  if (!liveGameEnabled() || teamA.length === 0 || teamB.length === 0) return;
  const existing = liveGameInProgress();
  if (existing && !confirm("A live game is already going. Finish it and start this one?")) { openLiveGameOverlay(); return; }
  if (existing) finishLiveGame(existing, false);
  const targetSel = document.getElementById("liveTargetSelect");
  const date = document.getElementById("gameDateInput").value || new Date().toISOString().slice(0, 10);
  const game = { id: uid("game"), date, videoUrl: "", notes: "", winner: null, teamA: [...teamA], teamB: [...teamB], stats: [], matchups: [], scoringEvents: [], plays: [],
    liveScores: [], liveInProgress: true, liveTarget: Number(targetSel?.value) || 21 };
  normalizeGame(game);
  state.games.push(game);
  saveState();
  renderGames();
  openLiveGameOverlay();
}

function liveAddScore(game, pid, points) {
  game.liveScores.push({ pid, points });
  saveState();
  renderLiveGameOverlay();
}

function finishLiveGame(game, rerender = true) {
  const a = liveScoreOf(game, game.teamA), b = liveScoreOf(game, game.teamB);
  game.winner = a > b ? "A" : b > a ? "B" : null;
  delete game.liveInProgress;
  delete game.liveTarget;
  saveState();
  closeLiveGameOverlay();
  if (rerender) { renderGames(); renderLiveGamePanel(); }
}

function openLiveGameOverlay() {
  let el = document.getElementById("liveGameOverlay");
  if (!el) {
    el = document.createElement("div");
    el.id = "liveGameOverlay";
    el.className = "live-overlay";
    el.setAttribute("role", "dialog");
    el.setAttribute("aria-label", "Live game");
    document.body.appendChild(el);
  }
  el.hidden = false;
  document.body.classList.add("live-open");
  try { navigator.wakeLock?.request("screen").then(l => { liveWakeLock = l; }).catch(() => {}); } catch (e) { /* not supported */ }
  renderLiveGameOverlay();
}

function closeLiveGameOverlay() {
  const el = document.getElementById("liveGameOverlay");
  if (el) el.hidden = true;
  document.body.classList.remove("live-open");
  try { liveWakeLock?.release(); } catch (e) { /* already released */ }
  liveWakeLock = null;
}

function renderLiveGameOverlay() {
  const el = document.getElementById("liveGameOverlay");
  const game = liveGameInProgress();
  if (!el || !game) { closeLiveGameOverlay(); return; }
  const score = { A: liveScoreOf(game, game.teamA), B: liveScoreOf(game, game.teamB) };
  const pred = predictRealMatchup(game.teamA, game.teamB);
  const reached = score.A >= game.liveTarget || score.B >= game.liveTarget;
  const line = pid => {
    const pts = liveScoreOf(game, [pid]);
    return `<div class="live-player">
      <span class="live-player-name">${escapeHtml(poolNameOf(pid))} <span class="live-player-line">${pts} pts</span></span>
      <span class="live-player-btns">
        <button type="button" data-live-score="${escapeHtml(pid)}" data-pts="1">+1</button>
        <button type="button" data-live-score="${escapeHtml(pid)}" data-pts="2">+2</button>
        <button type="button" data-live-score="${escapeHtml(pid)}" data-pts="3">+3</button>
      </span>
    </div>`;
  };
  const last = game.liveScores[game.liveScores.length - 1];
  const lastText = last ? `Last: ${escapeHtml(poolNameOf(last.pid))} +${last.points}` : "No scores yet";
  el.innerHTML = `
    <div class="live-inner">
      <div class="live-top">
        <button type="button" class="secondary-btn" data-live-close>Hide</button>
        <span class="live-meta">Game to ${game.liveTarget}${pred ? ` · tip-off odds ${Math.round(pred.pA * 100)}% / ${100 - Math.round(pred.pA * 100)}%` : ""}</span>
      </div>
      <div class="live-score">
        <div class="live-side live-side-a"><span class="live-side-label">Team A</span><span class="live-side-score">${score.A}</span></div>
        <span class="live-dash">–</span>
        <div class="live-side live-side-b"><span class="live-side-label">Team B</span><span class="live-side-score">${score.B}</span></div>
      </div>
      ${reached ? `<p class="live-reached">Someone hit ${game.liveTarget}. Tap Finish when the game's over.</p>` : ""}
      <div class="live-team live-team-a">${game.teamA.map(line).join("")}</div>
      <div class="live-team live-team-b">${game.teamB.map(line).join("")}</div>
      <div class="live-bottom">
        <span class="live-last" aria-live="polite">${lastText}</span>
        <button type="button" class="secondary-btn" data-live-undo ${last ? "" : "disabled"}>Undo</button>
        <button type="button" data-live-finish>Finish Game</button>
      </div>
      <button type="button" class="icon-btn live-discard" data-live-discard>Discard this game</button>
    </div>`;
  el.querySelectorAll("[data-live-score]").forEach(btn => btn.addEventListener("click", () =>
    liveAddScore(game, btn.dataset.liveScore, Number(btn.dataset.pts))));
  el.querySelector("[data-live-undo]").addEventListener("click", () => {
    game.liveScores.pop();
    saveState();
    renderLiveGameOverlay();
  });
  el.querySelector("[data-live-finish]").addEventListener("click", () => {
    finishLiveGame(game);
    if (autoBackupAfterLiveGame()) downloadBackup();
  });
  el.querySelector("[data-live-close]").addEventListener("click", () => { closeLiveGameOverlay(); renderLiveGamePanel(); });
  el.querySelector("[data-live-discard]").addEventListener("click", () => {
    if (!confirm("Delete this live game and its score?")) return;
    state.games = state.games.filter(g => g.id !== game.id);
    saveState();
    closeLiveGameOverlay();
    renderGames();
    renderLiveGamePanel();
  });
}

// Games tab panel: resume a game in progress, or pick teams (tap once for A, again for B).
function renderLiveGamePanel() {
  const wrap = document.getElementById("liveGamePanel");
  if (!wrap) return;
  const live = liveGameInProgress();
  if (live) {
    wrap.innerHTML = `<p class="hint" style="margin:0 0 10px">A live game is going: ${live.teamA.map(id => escapeHtml(poolNameOf(id))).join(", ")} vs. ${live.teamB.map(id => escapeHtml(poolNameOf(id))).join(", ")}, ${liveScoreOf(live, live.teamA)}-${liveScoreOf(live, live.teamB)}.</p>
      <button type="button" id="liveResumeBtn">Resume Live Game</button>`;
    document.getElementById("liveResumeBtn").addEventListener("click", openLiveGameOverlay);
    return;
  }
  const chips = [...state.players].sort((a, b) => a.name.localeCompare(b.name)).map(p => {
    const side = liveSetupSides[p.id];
    return `<button type="button" class="attendee-chip${side ? ` selected matchup-chip-${side.toLowerCase()}` : ""}" data-live-pick="${escapeHtml(p.id)}">${side ? `${side} · ` : ""}${escapeHtml(p.name)}</button>`;
  }).join("");
  const teamA = Object.keys(liveSetupSides).filter(id => liveSetupSides[id] === "A");
  const teamB = Object.keys(liveSetupSides).filter(id => liveSetupSides[id] === "B");
  wrap.innerHTML = `<div class="attendee-picker">${chips || '<p class="empty-state">No players yet. Add players in the Players tab.</p>'}</div>
    <div class="balance-controls">
      <label>Game to <select id="liveTargetSelect">${LIVE_TARGETS.map(t => `<option value="${t}"${t === 21 ? " selected" : ""}>${t}</option>`).join("")}</select></label>
      <button type="button" id="liveStartBtn" ${teamA.length && teamB.length ? "" : "disabled"}>Start Live Game</button>
    </div>
    <label class="live-backup-toggle"><input type="checkbox" id="liveAutoBackup" ${autoBackupAfterLiveGame() ? "checked" : ""}> Save a backup file after each live game</label>`;
  document.getElementById("liveAutoBackup").addEventListener("change", e => writeBackupMeta({ autoAfterLive: e.target.checked }));
  wrap.querySelectorAll("[data-live-pick]").forEach(btn => btn.addEventListener("click", () => {
    const id = btn.dataset.livePick;
    const next = { undefined: "A", A: "B", B: undefined }[liveSetupSides[id]];
    if (next) liveSetupSides[id] = next; else delete liveSetupSides[id];
    renderLiveGamePanel();
  }));
  document.getElementById("liveStartBtn").addEventListener("click", () => {
    liveSetupSides = {};
    startLiveGame(teamA, teamB);
  });
}

// ---------- Check against the real site ----------
// Every game in this app with a result (logged from film, or a finished live score) is matched
// to the real site's game from the same night with the same two rosters, and the winners are
// compared. Rematches between identical teams on one night are paired up in order. A game whose
// night has real games but no roster match is listed too (usually a roster or date typo on one
// side); a night the real site has no games for yet is just counted.
function localGameResult(game) {
  if (game.liveInProgress) return null;
  if (game.scoringEvents.length > 0) {
    const a = teamScore(game, game.teamA), b = teamScore(game, game.teamB);
    return a > b ? "A" : b > a ? "B" : null;
  }
  return (game.liveScores || []).length ? game.winner : null;
}

function computeRealSiteCheck() {
  if (typeof POOLEAN_SEASONS === "undefined") return null;
  const realGames = realSeasonsInOrder().flatMap(season => [...season.games].sort(byPlayOrder));
  const realDates = new Set(realGames.map(g => g.date));
  const sameSet = (x, y) => x.length === y.length && x.every(id => y.includes(id));
  const used = new Set();
  const out = { agree: [], disagree: [], unmatched: [], noRealNight: 0 };
  [...state.games].sort((x, y) => (x.date || "").localeCompare(y.date || "")).forEach(game => {
    const result = localGameResult(game);
    if (!result) return;
    if (!realDates.has(game.date)) { out.noRealNight++; return; }
    const match = realGames.find(g => !used.has(g) && g.date === game.date &&
      ((sameSet(g.a, game.teamA) && sameSet(g.b, game.teamB)) || (sameSet(g.a, game.teamB) && sameSet(g.b, game.teamA))));
    if (!match) { out.unmatched.push({ game }); return; }
    used.add(match);
    const realWinnerIsA = sameSet(match.a, game.teamA) ? match.w === "A" : match.w === "B";
    (realWinnerIsA === (result === "A") ? out.agree : out.disagree).push({ game, real: match });
  });
  return out;
}

function renderRealSiteCheck() {
  const wrap = document.getElementById("realSiteCheck");
  const summary = document.getElementById("realSiteMismatchSummary");
  const check = computeRealSiteCheck();
  const problems = check ? check.disagree.length + check.unmatched.length : 0;
  if (summary) {
    summary.innerHTML = problems
      ? `⚠️ ${problems} game${problems === 1 ? "" : "s"} here ${problems === 1 ? "doesn't" : "don't"} match the real site. <button type="button" class="secondary-btn" id="jumpToRealSiteCheckBtn">Review</button>`
      : "";
    document.getElementById("jumpToRealSiteCheckBtn")?.addEventListener("click", () => {
      showTab("export");
      document.getElementById("realSiteCheck")?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }
  if (!wrap) return;
  if (!check) { wrap.innerHTML = '<p class="empty-state">No real-site data loaded yet.</p>'; return; }
  const names = ids => ids.map(id => escapeHtml(poolNameOf(id))).join(", ");
  const gameLine = (game, extra) => `<li><button type="button" class="secondary-btn" data-open-game="${escapeHtml(game.id)}">Open</button>
    ${escapeHtml(formatDateDisplay(game.date))}: ${names(game.teamA)} vs. ${names(game.teamB)} ${extra}</li>`;
  const winnerText = (game, isA) => `${isA ? "Team A" : "Team B"} (${names(isA ? game.teamA : game.teamB)})`;
  const disagreeHtml = check.disagree.map(({ game, real }) => {
    const realA = real.a.every(id => game.teamA.includes(id)) ? real.w === "A" : real.w === "B";
    return gameLine(game, `<span class="hint" style="margin:0">here: ${winnerText(game, localGameResult(game) === "A")} won; real site: ${winnerText(game, realA)} won</span>`);
  }).join("");
  const unmatchedHtml = check.unmatched.map(({ game }) => gameLine(game, `<span class="hint" style="margin:0">no real game that night with these teams</span>`)).join("");
  wrap.innerHTML = `<p class="hint" style="margin:0 0 10px">${check.agree.length} match${check.agree.length === 1 ? "es" : ""} the real site.${check.noRealNight ? ` ${check.noRealNight} ${check.noRealNight === 1 ? "is" : "are"} from nights the real site has no games for yet.` : ""}</p>
    ${disagreeHtml ? `<h4 style="margin:10px 0 6px">Different winner</h4><ul class="real-check-list">${disagreeHtml}</ul>` : ""}
    ${unmatchedHtml ? `<h4 style="margin:10px 0 6px">No matching real game</h4><ul class="real-check-list">${unmatchedHtml}</ul>` : ""}
    ${!disagreeHtml && !unmatchedHtml ? '<p class="empty-state">Nothing to fix.</p>' : ""}`;
  wrap.querySelectorAll("[data-open-game]").forEach(btn => btn.addEventListener("click", () => openGame(btn.dataset.openGame)));
}

// ---------- Party Night Planner ----------
// A whole night's schedule at once. Each game: whoever has played the fewest games so far plays
// (random among ties), then the best of 300 random splits of them, scored on three things:
//   repeat teammates (2 points per earlier game each pair already shared a side),
//   repeat opponents (1 point per earlier game each cross pair already faced each other),
//   closeness (40 points per 100% the Matchup Predictor's odds sit away from 50/50).
// Not saved anywhere: a plan for tonight, rerolled with Reshuffle.
let plannerAttendeeIds = new Set();
let plannerSchedule = null;
const PLANNER_CANDIDATES = 300;

function shuffled(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

function planPartyNight(ids, perSide, gameCount) {
  const played = Object.fromEntries(ids.map(id => [id, 0]));
  const mates = {}, opps = {};
  const key = (p, q) => [p, q].sort().join("|");
  const schedule = [];
  for (let g = 0; g < gameCount; g++) {
    const spots = perSide ? Math.min(ids.length, perSide * 2) : ids.length;
    const order = shuffled(ids).sort((x, y) => played[x] - played[y]);
    const playing = order.slice(0, spots), sitting = order.slice(spots);
    const sizeA = Math.ceil(spots / 2);
    let best = null;
    for (let c = 0; c < PLANNER_CANDIDATES; c++) {
      const mix = shuffled(playing);
      const a = mix.slice(0, sizeA), b = mix.slice(sizeA);
      let repeat = 0;
      [a, b].forEach(team => team.forEach((p, i) => team.slice(i + 1).forEach(q => { repeat += 2 * (mates[key(p, q)] || 0); })));
      a.forEach(p => b.forEach(q => { repeat += opps[key(p, q)] || 0; }));
      const pred = predictRealMatchup(a, b);
      const score = repeat + (pred ? Math.abs(pred.pA - 0.5) * 40 : 0);
      if (!best || score < best.score) best = { a, b, sitting, score, pA: pred ? pred.pA : null };
    }
    [best.a, best.b].forEach(team => team.forEach((p, i) => team.slice(i + 1).forEach(q => { mates[key(p, q)] = (mates[key(p, q)] || 0) + 1; })));
    best.a.forEach(p => best.b.forEach(q => { opps[key(p, q)] = (opps[key(p, q)] || 0) + 1; }));
    [...best.a, ...best.b].forEach(id => played[id]++);
    schedule.push(best);
  }
  const summary = ids.map(id => {
    const teammates = new Set();
    schedule.forEach(g => [g.a, g.b].forEach(team => { if (team.includes(id)) team.forEach(t => { if (t !== id) teammates.add(t); }); }));
    return { id, games: played[id], teammates: teammates.size };
  }).sort((x, y) => poolNameOf(x.id).localeCompare(poolNameOf(y.id)));
  return { games: schedule, summary, others: ids.length - 1 };
}

function renderPlannerAttendeePicker() {
  const wrap = document.getElementById("plannerAttendeePicker");
  if (!wrap) return;
  if (state.players.length === 0) {
    wrap.innerHTML = '<p class="empty-state">No players yet. Add players in the Players tab.</p>';
  } else {
    wrap.innerHTML = [...state.players].sort((a, b) => a.name.localeCompare(b.name)).map(p =>
      `<button type="button" class="attendee-chip${plannerAttendeeIds.has(p.id) ? " selected" : ""}" data-planner-id="${escapeHtml(p.id)}">${escapeHtml(p.name)}</button>`).join("");
    wrap.querySelectorAll("[data-planner-id]").forEach(btn => btn.addEventListener("click", () => {
      const id = btn.dataset.plannerId;
      if (plannerAttendeeIds.has(id)) plannerAttendeeIds.delete(id); else plannerAttendeeIds.add(id);
      renderPlannerAttendeePicker();
    }));
  }
  const n = plannerAttendeeIds.size;
  const sizeSel = document.getElementById("plannerTeamSize");
  if (sizeSel) {
    const current = sizeSel.value;
    const opts = ['<option value="0">Everyone plays</option>'];
    for (let k = 2; k * 2 < n; k++) opts.push(`<option value="${k}">${k} per side (${n - 2 * k} sit)</option>`);
    sizeSel.innerHTML = opts.join("");
    if ([...sizeSel.options].some(o => o.value === current)) sizeSel.value = current;
  }
  const btn = document.getElementById("plannerGenerateBtn");
  if (btn) btn.disabled = n < 2;
  const count = document.getElementById("plannerCount");
  if (count) count.textContent = n ? `${n} here` : "";
}

function plannerScheduleText(plan) {
  const names = ids => ids.map(poolNameOf).join(", ");
  return plan.games.map((g, i) => {
    const odds = g.pA !== null ? ` (${Math.round(g.pA * 100)}% / ${100 - Math.round(g.pA * 100)}%)` : "";
    const sit = g.sitting.length ? `\n   Sitting: ${names(g.sitting)}` : "";
    return `Game ${i + 1}: ${names(g.a)} vs. ${names(g.b)}${odds}${sit}`;
  }).join("\n");
}

function renderPlannerResult() {
  const wrap = document.getElementById("plannerResult");
  if (!wrap) return;
  if (!plannerSchedule) { wrap.innerHTML = ""; return; }
  const plan = plannerSchedule;
  const gamesHtml = plan.games.map((g, i) => {
    const pA = g.pA !== null ? Math.round(g.pA * 100) : null;
    return `<li class="planner-game">
      <span class="planner-game-num">Game ${i + 1}</span>
      <span class="planner-game-teams"><span>${g.a.map(poolPlayerLink).join(", ")}</span><span class="planner-vs">vs.</span><span>${g.b.map(poolPlayerLink).join(", ")}</span></span>
      ${pA !== null ? `<span class="planner-game-odds" title="Matchup Predictor odds, left team / right team">${pA}% / ${100 - pA}%</span>` : ""}
      ${g.sitting.length ? `<span class="planner-game-sit">Sitting: ${g.sitting.map(id => escapeHtml(poolNameOf(id))).join(", ")}</span>` : ""}
      ${liveGameEnabled() ? `<button type="button" class="secondary-btn planner-live-btn" data-game-index="${i}">Play Live</button>` : ""}
    </li>`;
  }).join("");
  const summaryHtml = plan.summary.map(r => `<li>${poolPlayerLink(r.id)} <span class="hint" style="margin:0">${r.games} game${r.games === 1 ? "" : "s"}, ${r.teammates} of ${plan.others} as teammates</span></li>`).join("");
  wrap.innerHTML = `
    <ol class="planner-games">${gamesHtml}</ol>
    <div class="balance-controls" style="margin-top:10px">
      <button type="button" class="secondary-btn" id="plannerReshuffleBtn">Reshuffle</button>
      <button type="button" class="secondary-btn" id="plannerCopyBtn">Copy Schedule</button>
      <span class="hint" id="plannerCopyStatus" style="margin:0" aria-live="polite"></span>
    </div>
    <h4 style="margin:14px 0 8px">Who plays with whom</h4>
    <ul class="player-tips-list" style="display:block">${summaryHtml}</ul>`;
  wrap.querySelectorAll(".planner-live-btn").forEach(btn => btn.addEventListener("click", () => {
    const g = plan.games[Number(btn.dataset.gameIndex)];
    startLiveGame(g.a, g.b);
  }));
  document.getElementById("plannerReshuffleBtn").addEventListener("click", generatePlannerSchedule);
  document.getElementById("plannerCopyBtn").addEventListener("click", async () => {
    const status = document.getElementById("plannerCopyStatus");
    try { await navigator.clipboard.writeText(plannerScheduleText(plan)); status.textContent = "Copied"; }
    catch (e) { status.textContent = "Couldn't copy. Select the schedule and copy it by hand."; }
  });
}

function generatePlannerSchedule() {
  const ids = [...plannerAttendeeIds];
  if (ids.length < 2) return;
  const perSide = parseInt(document.getElementById("plannerTeamSize").value, 10) || 0;
  const count = Math.min(30, Math.max(1, parseInt(document.getElementById("plannerGameCount").value, 10) || 8));
  plannerSchedule = planPartyNight(ids, perSide, count);
  renderPlannerResult();
}

document.getElementById("plannerGenerateBtn")?.addEventListener("click", generatePlannerSchedule);
document.getElementById("plannerUseBalanceBtn")?.addEventListener("click", () => {
  plannerAttendeeIds = new Set([...balanceAttendeeIds]);
  renderPlannerAttendeePicker();
});

document.getElementById("generateBalancedTeamsBtn").addEventListener("click", () => {
  const teamSizeInput = document.getElementById("balanceTeamSizeInput");
  const teamSize = Math.max(1, parseInt(teamSizeInput.value, 10) || 3);
  balanceResults = generateBalancedTeamSets([...balanceAttendeeIds], teamSize);
  renderBalanceResults();
});

function teamScore(game, playerIds) {
  return playerIds.reduce((sum, pid) => {
    const s = game.stats.find(st => st.playerId === pid);
    return sum + (s ? s.pts : 0);
  }, 0);
}

// Both teams' final score added together — our stand-in for "how much game happened," since
// games are capped at different targets (16 or 21) and we don't track possessions. Rates are
// expressed "per 20 combined points" (roughly the middle of that range) instead of per game,
// so a player's numbers are comparable across games regardless of which cap was in play.
function gameTotalPoints(game) {
  return teamScore(game, game.teamA) + teamScore(game, game.teamB);
}

// "W" / "L" / "T" for this player in this game, or null if they weren't in it OR the
// result isn't known yet. Once real shots are logged (scoringEvents non-empty), the actual
// score is authoritative. Until then, fall back to `game.winner` ("A"/"B") if the game was
// imported with a historical result — otherwise the game is just undecided, not a 0-0 tie.
function playerGameResult(game, playerId) {
  const onA = game.teamA.includes(playerId);
  const onB = game.teamB.includes(playerId);
  if (!onA && !onB) return null;

  let outcome; // "A" | "B" | "T"
  if (game.scoringEvents.length > 0) {
    const scoreA = teamScore(game, game.teamA);
    const scoreB = teamScore(game, game.teamB);
    outcome = scoreA === scoreB ? "T" : (scoreA > scoreB ? "A" : "B");
  } else if (game.winner === "A" || game.winner === "B") {
    outcome = game.winner;
  } else {
    return null;
  }

  if (outcome === "T") return "T";
  const wonIt = (onA && outcome === "A") || (onB && outcome === "B");
  return wonIt ? "W" : "L";
}

// ---------- Stat Entry ----------
document.getElementById("backToGamesBtn").addEventListener("click", () => {
  currentGameId = null;
  document.getElementById("statsTabBtn").hidden = true;
  showTab("games");
  renderGames();
});

function openGame(gameId) {
  currentGameId = gameId;
  document.getElementById("statsTabBtn").hidden = false;
  showTab("stats");
  renderStatEntry();
  const game = state.games.find(g => g.id === gameId);
  if (game && game.masterVideoId) {
    loadStoredMasterVideo(game.masterVideoId);
  } else {
    loadStoredVideo(gameId);
  }
}

// Same as openGame(), but also seeks to one specific moment once the video's actually loaded --
// for links reached from OUTSIDE Stat Entry (the Highlights & Lowlights tables' own "▶ Jump"),
// where there's no video on screen yet the instant this is clicked, unlike the plain createJumpButton()
// used inside Stat Entry's own tables (Shot Log, Other Events, Matchups, Reel), which only ever
// need to seek a video that's already loaded. The video loads asynchronously (from IndexedDB,
// possibly a large blob), so this polls briefly for currentVideoEl to appear rather than assuming
// it's there the instant openGame() returns.
function openGameAndSeek(gameId, videoTime) {
  openGame(gameId);
  if (videoTime === null || videoTime === undefined) return;
  const tryJump = attemptsLeft => {
    if (currentGameId !== gameId) return; // navigated elsewhere before the video was ready
    if (currentVideoEl) {
      currentVideoEl.currentTime = videoTime;
      currentVideoEl.play();
      currentVideoEl.scrollIntoView({ behavior: "smooth", block: "center" });
      return;
    }
    if (attemptsLeft > 0) setTimeout(() => tryJump(attemptsLeft - 1), 200);
  };
  tryJump(25);
}

// Loads a game's video into an arbitrary <video> element and seeks to one moment, for the inline
// players "Watch film" buttons open right where they're clicked (Personalized Tips, Notable
// Matchups, Areas to Work On, Review Possible Dunks) instead of switching away to Stat Entry.
// Deliberately doesn't touch the global currentVideoEl, which stays reserved for the actual Stat
// Entry panel's own video. Mirrors renderVideoPanel's own source resolution (master video vs
// local video). viewer-videos.js patches this the same way it already patches openGame/
// createJumpButton, so hosted per-game files and their own time offset work here too without
// this function needing to know about them.
async function loadInlineVideo(game, videoEl, videoTime) {
  let url = null;
  if (game.masterVideoId) {
    if (!masterVideoBlobUrls[game.masterVideoId]) {
      const file = await getVideoFile(game.masterVideoId);
      if (file) masterVideoBlobUrls[game.masterVideoId] = URL.createObjectURL(file);
    }
    url = masterVideoBlobUrls[game.masterVideoId] || null;
  } else {
    if (!localVideoBlobUrls[game.id]) {
      const file = await getVideoFile(game.id);
      if (file) localVideoBlobUrls[game.id] = URL.createObjectURL(file);
    }
    url = localVideoBlobUrls[game.id] || game.videoUrl || null;
  }
  if (!url) return false;
  if (videoEl.dataset.loadedUrl !== url) {
    videoEl.src = url;
    videoEl.dataset.loadedUrl = url;
  }
  const seekAndPlay = () => {
    if (videoTime !== null && videoTime !== undefined) videoEl.currentTime = videoTime;
    videoEl.play();
  };
  if (videoEl.readyState >= 1) seekAndPlay();
  else videoEl.addEventListener("loadedmetadata", seekAndPlay, { once: true });
  return true;
}

// One inline player per container (Player Detail's Personalized Tips/Notable Matchups/Areas to
// Work On each get their own; Review Possible Dunks gets its own too) -- clicking a different
// "Watch film" instance within the same panel reuses the same player rather than stacking a new
// one per click.
function ensureInlineVideoPlayer(wrap) {
  let player = wrap.querySelector(".inline-video-player");
  if (!player) {
    player = document.createElement("div");
    player.className = "inline-video-player";
    player.innerHTML = '<p class="hint inline-video-label" style="margin:0 0 4px"></p><video controls style="max-width:100%;display:block;margin-bottom:10px"></video>';
    wrap.prepend(player); // top of the panel, not the bottom -- no scrolling past a long list to see it
  }
  return player;
}

async function playInlineVideoAt(wrap, gameId, videoTime) {
  const game = state.games.find(g => g.id === gameId);
  const player = ensureInlineVideoPlayer(wrap);
  const video = player.querySelector("video");
  const labelEl = player.querySelector(".inline-video-label");
  if (!game) {
    labelEl.textContent = "Game not found.";
    return;
  }
  labelEl.textContent = `Loading ${formatDateDisplay(game.date)}…`;
  const ok = await loadInlineVideo(game, video, videoTime);
  labelEl.textContent = ok
    ? `${formatDateDisplay(game.date)}${videoTime !== null && videoTime !== undefined ? " · " + formatVideoTime(videoTime) : ""}`
    : `No video available for ${formatDateDisplay(game.date)}.`;
  player.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

// Shared by every "Watch film" row (Personalized Tips, Notable Matchups, Areas to Work On, Review
// Possible Dunks): renders one button per matching instance, labeled with the date AND that
// instance's own timestamp when one was captured (so two games on the same day, or several
// instances in one game, are never ambiguous the way a bare date list was), wired to play right
// there inline instead of switching tabs.
function watchFilmLinksHtml(games) {
  if (!games || games.length === 0) return "";
  return `<div class="player-tip-watch">Watch film: ${games.map(g => {
    const label = g.videoTime !== null && g.videoTime !== undefined
      ? `${formatDateDisplay(g.date)} · ${formatVideoTime(g.videoTime)}`
      : formatDateDisplay(g.date);
    const timeAttr = g.videoTime !== null && g.videoTime !== undefined ? ` data-video-time="${g.videoTime}"` : "";
    return `<button type="button" class="icon-btn player-tip-game-btn" data-game-id="${g.id}"${timeAttr}>${escapeHtml(label)}</button>`;
  }).join(" ")}</div>`;
}

function wireWatchFilmButtons(root) {
  root.querySelectorAll(".player-tip-game-btn").forEach(btn => {
    const videoTime = btn.dataset.videoTime !== undefined ? parseFloat(btn.dataset.videoTime) : null;
    btn.addEventListener("click", () => playInlineVideoAt(root, btn.dataset.gameId, videoTime));
  });
}

async function loadStoredVideo(gameId) {
  if (localVideoBlobUrls[gameId]) return;
  const file = await getVideoFile(gameId);
  // Full re-render, not just the video panel — the Shot Log/Other Events/Matchups Jump buttons
  // were built while the video was still loading (so `currentVideoEl` was null and they got
  // created disabled); only re-rendering those tables too gives them a chance to enable.
  if (file && gameId === currentGameId) {
    localVideoBlobUrls[gameId] = URL.createObjectURL(file);
    renderStatEntry();
  }
}

// Session videos are keyed by their own id (not a game id) and cached here so switching
// between several games that share one recording doesn't re-fetch the blob every time.
const masterVideoBlobUrls = {};

async function loadStoredMasterVideo(masterVideoId) {
  if (masterVideoBlobUrls[masterVideoId]) {
    const game = state.games.find(g => g.id === currentGameId);
    if (game) renderStatEntry();
    return;
  }
  const file = await getVideoFile(masterVideoId);
  if (file) masterVideoBlobUrls[masterVideoId] = URL.createObjectURL(file);
  const game = state.games.find(g => g.id === currentGameId);
  if (game && game.masterVideoId === masterVideoId) renderStatEntry();
}

function getOrCreatePlayerStats(game, playerId) {
  let s = game.stats.find(st => st.playerId === playerId);
  if (!s) {
    s = { playerId, pts: 0, oreb: 0, dreb: 0, ast: 0, stl: 0, blk: 0, tov: 0, pf: 0 };
    game.stats.push(s);
  }
  return s;
}

// True if two players were on the same team in this game — used to tell an offensive rebound
// (rebounder on the shooter's team) from a defensive one (rebounder on the other team).
function sameTeam(game, playerIdA, playerIdB) {
  return (game.teamA.includes(playerIdA) && game.teamA.includes(playerIdB)) ||
    (game.teamB.includes(playerIdA) && game.teamB.includes(playerIdB));
}

// ---- Shot chart geometry (shared by the entry/backfill picker and both heatmaps) ----
// Real court proportions (~30ft end to end by ~15ft wide, 2:1) as the SVG viewBox itself,
// instead of a square viewBox distorted via preserveAspectRatio="none" — a rect/circle/font
// stays visually undistorted this way as long as the CSS box matches the same 1:2 ratio (see
// .shot-chart / .heatmap-chart / .backfill-shot-row .shot-chart), since one viewBox unit then
// maps to the same number of real pixels on both axes. Stored shot coordinates stay plain
// 0-100 percentages either way — only this rendering math needs to know the real viewBox
// height. Every rendering of the chart also flips the hoop to the bottom (stored y=0 maps to
// the *largest* viewBox y, not the smallest) — consistent everywhere, logging a shot or
// reviewing one later.
const SHOT_CHART_VIEWBOX_W = 100;
const SHOT_CHART_VIEWBOX_H = 200;
function shotChartVbX(storedX) { return (storedX / 100) * SHOT_CHART_VIEWBOX_W; }
function shotChartVbY(storedY) { return SHOT_CHART_VIEWBOX_H - (storedY / 100) * SHOT_CHART_VIEWBOX_H; }

// The static court/3pt-line/hoop background shared by every shot chart rendering. `extraAttrs`
// is a raw string of additional attributes on the <svg> tag itself — e.g. `data-shot-chart` on
// the clickable entry/backfill picker, omitted on the heatmap since that one isn't a click
// target. The heatmap draws its own grid of cells on top of this same background separately
// (see renderHeatmapSvg) rather than through this function, since it needs them layered between
// the court and the 3pt line/hoop.
function renderShotChartBaseSvg(extraAttrs = "") {
  const threePtVbY = shotChartVbY(60);
  const hoopVbY = shotChartVbY(7);
  return `
    <svg class="shot-chart" viewBox="0 0 ${SHOT_CHART_VIEWBOX_W} ${SHOT_CHART_VIEWBOX_H}" ${extraAttrs}>
      <rect x="1" y="1" width="${SHOT_CHART_VIEWBOX_W - 2}" height="${SHOT_CHART_VIEWBOX_H - 2}" rx="4" class="shot-chart-court" />
      <line x1="1" y1="${threePtVbY}" x2="${SHOT_CHART_VIEWBOX_W - 1}" y2="${threePtVbY}" class="shot-chart-3pt-line" />
      <text x="${SHOT_CHART_VIEWBOX_W - 3}" y="${threePtVbY - 3}" class="shot-chart-label" text-anchor="end">3PT</text>
      <circle cx="${SHOT_CHART_VIEWBOX_W / 2}" cy="${hoopVbY}" r="4" class="shot-chart-hoop" />
    </svg>
  `;
}

// ---- Shot heatmap (Player Detail + League) ----
// Coarse on purpose — with a season's worth of shots split across dozens of players, a finer
// grid would mostly produce single-shot cells that read as 0% or 100% and mean nothing.
const HEATMAP_COLS = 5;
// Row boundaries (not just a row count) so one lands exactly on the 3pt line (y: 60, same
// threshold the Shot Log's "📍 2PT range"/"📍 3PT range" badge uses) — a zone never straddles
// it and blends a 2PT FG% together with a 3PT one. Denser inside the arc (4 rows) than beyond
// it (2 rows), since that's where shot volume concentrates.
const HEATMAP_ROW_BOUNDARIES = [0, 15, 30, 45, 60, 80, 100];

function heatmapRowForY(y) {
  const rowCount = HEATMAP_ROW_BOUNDARIES.length - 1;
  for (let r = 0; r < rowCount; r++) {
    if (y < HEATMAP_ROW_BOUNDARIES[r + 1]) return r;
  }
  return rowCount - 1; // y === 100, the top boundary itself
}

function computeHeatmapCells(shots) {
  const cellW = 100 / HEATMAP_COLS;
  const rowCount = HEATMAP_ROW_BOUNDARIES.length - 1;
  const cells = [];
  for (let r = 0; r < rowCount; r++) {
    const y = HEATMAP_ROW_BOUNDARIES[r];
    const h = HEATMAP_ROW_BOUNDARIES[r + 1] - y;
    for (let c = 0; c < HEATMAP_COLS; c++) {
      cells.push({ x: c * cellW, y, w: cellW, h, attempts: 0, makes: 0 });
    }
  }
  shots.forEach(ev => {
    const col = Math.max(0, Math.min(HEATMAP_COLS - 1, Math.floor(ev.shotLocation.x / cellW)));
    const row = heatmapRowForY(Math.max(0, Math.min(100, ev.shotLocation.y)));
    const cell = cells[row * HEATMAP_COLS + col];
    cell.attempts++;
    if (ev.made !== false) cell.makes++;
  });
  return cells;
}

// Red (0% FG) through green (100% FG) — plus a light opacity ramp so a single-shot cell (which
// is really just "make" or "miss", not a rate) reads as less confident than a well-sampled one.
// Saturation kept high (85%, not a more muted 70%) specifically because the mid-range of this
// hue sweep (~45-70°, yellow-to-olive) is where the human eye is worst at telling two hues apart
// — a washed-out 45% and 55% cell were reading as the same color. Every other cell/bar on this
// page that uses this red-to-green convention (defensive heatmap, Matchup Grid, Teammate Lift
// Matrix, TS% by Shot Distance) uses the same saturation for the same reason.
function heatmapCellColor(cell) {
  const fgFrac = cell.makes / cell.attempts;
  const hue = fgFrac * 120;
  const opacity = Math.min(0.85, 0.32 + cell.attempts * 0.1);
  return `hsla(${hue}, 85%, 42%, ${opacity})`;
}

// Inverted from heatmapCellColor — a low opponent FG% is good defense, so red/green mean the
// opposite of what they mean on every offensive heatmap. Never share the two functions' output
// directly for that reason, even though the math is nearly identical.
function defensiveHeatmapCellColor(cell) {
  const fgFrac = cell.makes / cell.attempts;
  const hue = (1 - fgFrac) * 120;
  const opacity = Math.min(0.85, 0.32 + cell.attempts * 0.1);
  return `hsla(${hue}, 85%, 42%, ${opacity})`;
}

// Renders the shared court/hoop/3pt-line background with a heatmap grid over it, or null if
// there's nothing to plot yet — the caller decides what empty-state message fits its context.
// colorFn defaults to the offensive red-low/green-high convention; the defensive heatmaps pass
// defensiveHeatmapCellColor instead, since a low percentage means something good there, not bad.
function renderHeatmapSvg(shots, colorFn = heatmapCellColor) {
  if (shots.length === 0) return null;
  const cells = computeHeatmapCells(shots);
  const cellsSvg = cells.filter(cell => cell.attempts > 0).map(cell => {
    const vbX = shotChartVbX(cell.x);
    const vbW = (cell.w / 100) * SHOT_CHART_VIEWBOX_W;
    const vbYTop = shotChartVbY(cell.y + cell.h); // farther from the hoop = smaller stored y-span end = higher up once flipped
    const vbYBottom = shotChartVbY(cell.y);
    const vbH = vbYBottom - vbYTop;
    const cx = vbX + vbW / 2;
    const cy = vbYTop + vbH / 2;
    const fgPct = Math.round((cell.makes / cell.attempts) * 100);
    return `
      <rect x="${vbX}" y="${vbYTop}" width="${vbW}" height="${vbH}" fill="${colorFn(cell)}" stroke="var(--panel-bg)" stroke-width="0.5" />
      <text x="${cx}" y="${cy - 1}" text-anchor="middle" class="heatmap-cell-label">${cell.attempts}</text>
      <text x="${cx}" y="${cy + 7}" text-anchor="middle" class="heatmap-cell-pct">${fgPct}%</text>
    `;
  }).join("");

  const threePtVbY = shotChartVbY(60);
  const hoopVbY = shotChartVbY(7);

  // Hoop marker drawn BEFORE the cell grid (not after) so it never sits on top of a cell's
  // attempt count — it only shows through in a cell with no data there, which is the point of
  // a background reference marker in the first place.
  return `
    <svg class="shot-chart heatmap-chart" viewBox="0 0 ${SHOT_CHART_VIEWBOX_W} ${SHOT_CHART_VIEWBOX_H}">
      <rect x="1" y="1" width="${SHOT_CHART_VIEWBOX_W - 2}" height="${SHOT_CHART_VIEWBOX_H - 2}" rx="4" class="shot-chart-court" />
      <circle cx="${SHOT_CHART_VIEWBOX_W / 2}" cy="${hoopVbY}" r="4" class="shot-chart-hoop" />
      ${cellsSvg}
      <line x1="1" y1="${threePtVbY}" x2="${SHOT_CHART_VIEWBOX_W - 1}" y2="${threePtVbY}" class="shot-chart-3pt-line" />
      <text x="${SHOT_CHART_VIEWBOX_W - 3}" y="${threePtVbY - 3}" class="shot-chart-label" text-anchor="end">3PT</text>
    </svg>
  `;
}

// Shared by the player, league, and defensive heatmaps — only difference is the field goal
// filter and (for the defensive ones) the color function.
function renderHeatmapInto(containerId, allFieldGoals, colorFn = heatmapCellColor) {
  const container = document.getElementById(containerId);
  if (!container) return;
  const withLocation = allFieldGoals.filter(ev => ev.shotLocation);
  const svg = renderHeatmapSvg(withLocation, colorFn);
  if (!svg) {
    container.innerHTML = '<p class="empty-state">No shots with a location marked yet.</p>';
    return;
  }
  const missing = allFieldGoals.length - withLocation.length;
  container.innerHTML = `
    <div class="shot-chart-wrap">${svg}</div>
    <p class="hint" style="margin:0">${withLocation.length} of ${allFieldGoals.length} field goal${allFieldGoals.length === 1 ? "" : "s"} plotted${missing > 0 ? ` (${missing} still missing a location)` : ""}.</p>
  `;
}

function renderPlayerHeatmap(playerId) {
  const shots = [];
  state.games.filter(isQualifyingGame).forEach(g => g.scoringEvents.forEach(ev => {
    if (ev.scorerId === playerId && (ev.points === 2 || ev.points === 3)) shots.push(ev);
  }));
  renderHeatmapInto("playerHeatmap", shots);
}

// The defensive counterpart to the heatmap above — same zone grid, but keyed on every shot this
// player was tagged defending (fan-out rule: a double-teamed shot counts toward every tagged
// defender, same as gameDefenseStats()/headToHeadAsDefender() elsewhere) instead of shots they
// took. This is what actually answers "does this player's overall Opp FG% hold up at every
// distance, or does it collapse somewhere specific" — a single season-long percentage can't say
// that on its own.
function renderPlayerDefensiveHeatmap(playerId) {
  const shots = [];
  state.games.filter(isQualifyingGame).forEach(g => g.scoringEvents.forEach(ev => {
    if ((ev.points === 2 || ev.points === 3) && (ev.defenderIds || []).includes(playerId)) shots.push(ev);
  }));
  renderHeatmapInto("playerDefensiveHeatmap", shots, defensiveHeatmapCellColor);
}

// Every individual marked shot, plotted at its real spot rather than bucketed into a zone —
// the heatmap's coarseness (deliberate, see computeHeatmapCells) necessarily smooths over a
// cluster or a gap within one zone; this shows exactly where each shot actually was. Reuses the
// same court background and coordinate transform as everything else (shotChartVbX/Y, hoop
// drawn before the dots so it never sits on top of one).
function renderPlayerShotChart(playerId) {
  const wrap = document.getElementById("playerShotChart");
  if (!wrap) return;
  const shots = [];
  state.games.forEach(g => g.scoringEvents.forEach(ev => {
    if (ev.scorerId === playerId && (ev.points === 2 || ev.points === 3) && ev.shotLocation) shots.push(ev);
  }));
  if (shots.length === 0) {
    wrap.innerHTML = '<p class="empty-state">No shots with a marked location yet.</p>';
    return;
  }
  const makes = shots.filter(ev => ev.made !== false).length;
  const misses = shots.length - makes;
  const typeCounts = {};
  shots.forEach(ev => { const k = effShotType(ev) || "untagged"; typeCounts[k] = (typeCounts[k] || 0) + 1; });
  const dotsSvg = shots.map(ev => {
    const cx = shotChartVbX(ev.shotLocation.x);
    const cy = shotChartVbY(ev.shotLocation.y);
    const type = effShotType(ev);
    const cls = (ev.made !== false ? "shot-dot-make" : "shot-dot-miss") + (type ? "" : " shot-dot-untagged");
    const label = `${ev.made !== false ? "Make" : "Miss"}, ${ev.points}pt${type ? ", " + shotTypeLabel(type) : ", no shot type yet"}`;
    return shotTypeShape(type, cx, cy, cls, label);
  }).join("");
  // The legend keys the shapes (only the types this player has), next to the make/miss colors.
  const shapeLegend = Object.keys(typeCounts).some(k => k !== "untagged") ? SHOT_TYPES.filter(t => typeCounts[t.key]).map(t =>
    `<span class="legend-item"><svg class="legend-shape" viewBox="-4 -4 8 8" width="11" height="11">${shotTypeShape(t.key, 0, 0, "legend-shape-fill")}</svg>${escapeHtml(t.label)} (${typeCounts[t.key]})</span>`
  ).join("") + (typeCounts.untagged ? `<span class="legend-item"><svg class="legend-shape" viewBox="-4 -4 8 8" width="11" height="11">${shotTypeShape(null, 0, 0, "legend-shape-fill shot-dot-untagged")}</svg>Not tagged (${typeCounts.untagged})</span>` : "") : "";
  const threePtVbY = shotChartVbY(60);
  const hoopVbY = shotChartVbY(7);
  wrap.innerHTML = `
    <div class="shot-chart-wrap">
      <svg class="shot-chart heatmap-chart" viewBox="0 0 ${SHOT_CHART_VIEWBOX_W} ${SHOT_CHART_VIEWBOX_H}">
        <rect x="1" y="1" width="${SHOT_CHART_VIEWBOX_W - 2}" height="${SHOT_CHART_VIEWBOX_H - 2}" rx="4" class="shot-chart-court" />
        <circle cx="${SHOT_CHART_VIEWBOX_W / 2}" cy="${hoopVbY}" r="4" class="shot-chart-hoop" />
        ${dotsSvg}
        <line x1="1" y1="${threePtVbY}" x2="${SHOT_CHART_VIEWBOX_W - 1}" y2="${threePtVbY}" class="shot-chart-3pt-line" />
        <text x="${SHOT_CHART_VIEWBOX_W - 3}" y="${threePtVbY - 3}" class="shot-chart-label" text-anchor="end">3PT</text>
      </svg>
      <div class="shot-chart-legend">
        <span class="legend-item"><span class="legend-dot legend-dot-make"></span>Make (${makes})</span>
        <span class="legend-item"><span class="legend-dot legend-dot-miss"></span>Miss (${misses})</span>
      </div>
      ${shapeLegend ? `<div class="shot-chart-legend">${shapeLegend}</div>` : ""}
    </div>
  `;
}

// One marker per shot, its shape set by the shot type: circle for catch-and-shoot, square for a
// drive, triangle for a deep heave, diamond for a Move, star for a dunk. Color stays make (green) / miss (red).
// Untagged shots are a faint circle so a partly tagged player still reads at a glance.
function shotTypeShape(type, cx, cy, cls, label) {
  const title = label ? `<title>${escapeHtml(label)}</title>` : "";
  const c = `class="${cls}"`;
  if (type === "dunk") {
    const pts = [];
    for (let i = 0; i < 10; i++) {
      const r = i % 2 === 0 ? 3.4 : 1.5, a = -Math.PI / 2 + (i * Math.PI) / 5;
      pts.push(`${(cx + r * Math.cos(a)).toFixed(2)},${(cy + r * Math.sin(a)).toFixed(2)}`);
    }
    return `<polygon points="${pts.join(" ")}" ${c}>${title}</polygon>`;
  }
  if (type === "drive") return `<rect x="${cx - 2}" y="${cy - 2}" width="4" height="4" ${c}>${title}</rect>`;
  if (type === "deepHeave") return `<polygon points="${cx},${cy - 2.9} ${cx - 2.6},${cy + 2} ${cx + 2.6},${cy + 2}" ${c}>${title}</polygon>`;
  if (type === "move") return `<polygon points="${cx},${cy - 3} ${cx + 3},${cy} ${cx},${cy + 3} ${cx - 3},${cy}" ${c}>${title}</polygon>`;
  return `<circle cx="${cx}" cy="${cy}" r="2.2" ${c}>${title}</circle>`;
}

function renderLeagueHeatmap() {
  const shots = [];
  state.games.filter(isQualifyingGame).forEach(g => g.scoringEvents.forEach(ev => {
    if (ev.points === 2 || ev.points === 3) shots.push(ev);
  }));
  renderHeatmapInto("leagueHeatmap", shots);
}

// PTS, AST, BLK, OREB, DREB, TOV, STL, and PF are all derived from event logs (scoringEvents /
// turnoverEvents / stealEvents / foulEvents), not clicked directly — this keeps each total
// in sync with its log, the same way PTS has always been derived from scoringEvents. Older
// scoringEvents have no `made` field at all, which means "made" (they predate misses).
function recomputeDerivedStats(game) {
  [...game.teamA, ...game.teamB].forEach(pid => {
    const s = getOrCreatePlayerStats(game, pid);
    s.pts = game.scoringEvents
      .filter(ev => ev.scorerId === pid && ev.made !== false)
      .reduce((sum, ev) => sum + ev.points, 0);
    s.ast = game.scoringEvents.filter(ev => ev.assistId === pid && ev.made !== false).length;
    s.blk = game.scoringEvents.filter(ev => ev.blockerId === pid && ev.made === false).length;
    const rebounded = game.scoringEvents.filter(ev => ev.made === false && ev.rebounderId === pid);
    s.oreb = rebounded.filter(ev => sameTeam(game, ev.scorerId, pid)).length;
    s.dreb = rebounded.filter(ev => !sameTeam(game, ev.scorerId, pid)).length;
    s.tov = game.turnoverEvents.filter(ev => ev.playerId === pid).length;
    s.stl = game.stealEvents.filter(ev => ev.playerId === pid).length;
    s.pf = game.foulEvents.filter(ev => ev.playerId === pid).length;
  });
}

// A steal is always also a turnover for whoever it was stolen from, so logging one creates
// both records — playerId committed the turnover, opponentId (the stealer) forced it. The
// turnover carries stealEventId so the two stay linked for removal (see removeTaggedEvent).
// TOV/PF just create their own single record.
function commitTaggedEvent(game, cfg, playerId, opponentId) {
  const videoTime = currentPlaybackTime();
  if (cfg.field === "stl") {
    const stealId = uid("stl");
    game.stealEvents.push({ id: stealId, playerId, opponentId, videoTime });
    // Same instant as the steal, so they share a timestamp rather than being captured twice.
    game.turnoverEvents.push({ id: uid("tov"), playerId: opponentId, opponentId: playerId, stealEventId: stealId, videoTime });
  } else {
    game[cfg.eventsKey].push({ id: uid(cfg.field), playerId, opponentId, videoTime, ...(cfg.field === "tov" ? { stealEventId: null } : {}) });
  }
}

// Removing either half of a steal/turnover pair removes both, so the two never drift out of
// sync — a turnover that "is" a steal can't exist without the steal, and vice versa.
function removeTaggedEvent(game, cfg, eventId) {
  if (cfg.field === "stl") {
    game.stealEvents = game.stealEvents.filter(e => e.id !== eventId);
    game.turnoverEvents = game.turnoverEvents.filter(e => e.stealEventId !== eventId);
  } else if (cfg.field === "tov") {
    const ev = game.turnoverEvents.find(e => e.id === eventId);
    game.turnoverEvents = game.turnoverEvents.filter(e => e.id !== eventId);
    if (ev && ev.stealEventId) game.stealEvents = game.stealEvents.filter(e => e.id !== ev.stealEventId);
    if (ev && ev.missEventId) {
      const missEv = game.scoringEvents.find(e => e.id === ev.missEventId);
      if (missEv) missEv.turnoverEventId = null;
    }
  } else {
    game[cfg.eventsKey] = game[cfg.eventsKey].filter(e => e.id !== eventId);
  }
}

// Radial distance from the hoop (x: 50, y: 0 — the same 0-100 normalized shot-chart space
// shotLocation is stored in). Not real feet, just a consistent proxy for "how far was this
// shot from the basket," used only to split 3PT attempts into two very different shots below.
function shotDistanceFromHoop(loc) {
  return Math.sqrt(Math.pow(loc.x - 50, 2) + Math.pow(loc.y, 2));
}

// A 3PT attempt is "Line" (a normal three right at the line -- Poolean's three is straight, not a
// curved arc; the returned value stays "arc" internally) or "Deep" (a near-pool-length heave),
// split at a boundary calibrated from the logged shots (see Calibrated thresholds below). Only ever
// applied within the 3PT bucket; the 2PT/3PT boundary itself (the 3pt line at 60% depth) is fixed.
// ---------- Calibrated thresholds ----------
// These cutoffs are set from the logged data instead of being hand-picked, and each one is
// rechecked each time enough new data has come in (a fixed step, never on every page load).
// Everything here is derived purely from the games in state, in date order, so the dashboard and
// the viewer always agree and nothing extra needs storing. Each check is kept in a history so the
// Calibrated Thresholds panel can show what changed and why; a check only moves a value when the
// evidence is clear, otherwise the last value stays.
//   1. Close/Midrange boundary (2PT): where FG% drops off most sharply.
//   2. Line/Deep boundary (3PT): same method.
//   3. Close-game margin: the closest-finishing third of balanced games.
//   4. Second-chance window: the length that captures real conversions without picking up
//      scores that would have happened anyway.
const CLOSE_RANGE_DEFAULT = 30;          // used until there is enough data to calibrate
const THREE_PT_DEEP_DEFAULT = 80;
const CLUTCH_MARGIN_DEFAULT = 5;
const SECOND_CHANCE_WINDOW_DEFAULT = 20;
const CALIBRATION_MIN_STAT = 10;         // 2 x log-likelihood gain needed to move a shot boundary
const CALIBRATION_MIN_SIDE = 15;         // each side of a candidate boundary needs this many attempts
const SECOND_CHANCE_MIN_EXCESS = 5;      // conversions above chance needed to move the window
const SECOND_CHANCE_WINDOWS = [5, 10, 15, 20, 25, 30, 40, 50, 60];

function binomialLogLik(k, n) {
  if (n === 0) return 0;
  const p = k / n;
  return (k > 0 ? k * Math.log(p) : 0) + (n - k > 0 ? (n - k) * Math.log(1 - p) : 0);
}

// The distance that best splits `shots` ([{d, made}]) into a nearer group shooting clearly better
// than a farther one: maximum-likelihood two-rate split, searched one unit at a time.
function findShotBreakpoint(shots, lo, hi, minSide) {
  const total = shots.length;
  const totalMade = shots.filter(s => s.made).length;
  const nullLL = binomialLogLik(totalMade, total);
  let best = null;
  for (let t = lo; t <= hi; t++) {
    let nNear = 0, madeNear = 0;
    shots.forEach(s => { if (s.d <= t) { nNear++; if (s.made) madeNear++; } });
    const nFar = total - nNear, madeFar = totalMade - madeNear;
    if (nNear < minSide || nFar < minSide) continue;
    if (madeNear / nNear <= madeFar / nFar) continue;
    const ll = binomialLogLik(madeNear, nNear) + binomialLogLik(madeFar, nFar);
    if (!best || ll > best.ll) {
      best = { ll, value: t, nNear, fgNear: madeNear / nNear, nFar, fgFar: madeFar / nFar, stat: 2 * (ll - nullLL) };
    }
  }
  return best;
}

function gamesByDate(filterFn) {
  return state.games.filter(g => (g.scoringEvents || []).length > 0 && filterFn(g))
    .sort((a, b) => ((a.date || "") < (b.date || "") ? -1 : (a.date || "") > (b.date || "") ? 1 : 0));
}

function nextCheckpoint(total, minN, step) {
  if (total < minN) return minN;
  return minN + (Math.floor((total - minN) / step) + 1) * step;
}

function calibrateShotBoundary(points, cfg) {
  const shots = [];
  gamesByDate(() => true).forEach(game => {
    game.scoringEvents.forEach(ev => {
      if (ev.points === points && ev.shotLocation) {
        shots.push({ d: shotDistanceFromHoop(ev.shotLocation), made: ev.made !== false });
      }
    });
  });
  const history = [];
  let value = cfg.defaultValue;
  const pct0 = v => Math.round(v * 100) + "%";
  for (let n = cfg.minN; n <= shots.length; n += cfg.step) {
    const found = findShotBreakpoint(shots.slice(0, n), cfg.search[0], cfg.search[1], CALIBRATION_MIN_SIDE);
    const strong = !!found && found.stat >= CALIBRATION_MIN_STAT;
    const previous = value;
    if (strong) value = found.value;
    history.push({
      n, previous, value, strong,
      detail: found ? `Nearer: ${pct0(found.fgNear)} (${found.nNear} shots). Farther: ${pct0(found.fgFar)} (${found.nFar} shots).` : "Not enough shots on both sides."
    });
  }
  return { current: value, defaultValue: cfg.defaultValue, total: shots.length, unit: cfg.unit, noun: cfg.noun, history, nextAt: nextCheckpoint(shots.length, cfg.minN, cfg.step) };
}

function calibrateClutchMargin() {
  const margins = gamesByDate(isBalancedGame).map(g => Math.abs(teamScore(g, g.teamA) - teamScore(g, g.teamB)));
  const history = [];
  let value = CLUTCH_MARGIN_DEFAULT;
  const MIN_N = 6, STEP = 3;
  for (let n = MIN_N; n <= margins.length; n += STEP) {
    const sorted = margins.slice(0, n).sort((a, b) => a - b);
    const thr = sorted[Math.ceil(n / 3) - 1];
    const previous = value;
    value = thr;
    const count = sorted.filter(m => m <= thr).length;
    history.push({ n, previous, value, strong: true, detail: `${count} of ${n} games finished within ${thr} points.` });
  }
  return { current: value, defaultValue: CLUTCH_MARGIN_DEFAULT, total: margins.length, unit: "points", noun: "games", history, nextAt: nextCheckpoint(margins.length, MIN_N, STEP) };
}

function calibrateSecondChanceWindow() {
  // One observation per offensive rebound with a video time: how long until the rebounder next
  // scored or assisted (or never), and how often that player scores or assists at all (per second
  // of that game), which is the chance a score lands in any window by luck alone.
  const obs = [];
  gamesByDate(() => true).forEach(game => {
    const events = game.scoringEvents;
    const times = events.map(e => e.videoTime).filter(t => t !== null && t !== undefined);
    if (times.length < 2) return;
    const duration = Math.max(...times) - Math.min(...times);
    if (duration <= 0) return;
    events.forEach(ev => {
      if (ev.made !== false || !ev.rebounderId || !sameTeam(game, ev.scorerId, ev.rebounderId)) return;
      if (ev.videoTime === null || ev.videoTime === undefined) return;
      const involved = events.filter(c => c !== ev && c.made !== false && c.videoTime !== null && c.videoTime !== undefined
        && (c.scorerId === ev.rebounderId || c.assistId === ev.rebounderId));
      const lags = involved.map(c => c.videoTime - ev.videoTime).filter(l => l >= 0);
      obs.push({ lag: lags.length ? Math.min(...lags) : null, rate: involved.length / duration });
    });
  });
  const history = [];
  let value = SECOND_CHANCE_WINDOW_DEFAULT;
  const MIN_N = 25, STEP = 25;
  for (let n = MIN_N; n <= obs.length; n += STEP) {
    const slice = obs.slice(0, n);
    let best = null;
    SECOND_CHANCE_WINDOWS.forEach(w => {
      const conv = slice.filter(o => o.lag !== null && o.lag <= w).length;
      const chance = slice.reduce((sum, o) => sum + Math.min(1, o.rate * w), 0);
      const excess = conv - chance;
      if (!best || excess > best.excess) best = { w, conv, chance, excess };
    });
    const strong = best.excess >= SECOND_CHANCE_MIN_EXCESS;
    const previous = value;
    if (strong) value = best.w;
    history.push({
      n, previous, value, strong,
      detail: `${best.conv} of ${n} rebounds led to a score or assist by the rebounder within ${best.w}s, against about ${best.chance.toFixed(1)} expected by chance.`
    });
  }
  return { current: value, defaultValue: SECOND_CHANCE_WINDOW_DEFAULT, total: obs.length, unit: "seconds", noun: "offensive rebounds", history, nextAt: nextCheckpoint(obs.length, MIN_N, STEP) };
}

let calibrationCache = null;
function getCalibrations() {
  if (calibrationCache) return calibrationCache;
  calibrationCache = {
    closeRange: calibrateShotBoundary(2, { defaultValue: CLOSE_RANGE_DEFAULT, search: [12, 50], minN: 100, step: 50, unit: "units from the hoop", noun: "2-point shots" }),
    threePtDeep: calibrateShotBoundary(3, { defaultValue: THREE_PT_DEEP_DEFAULT, search: [70, 100], minN: 50, step: 25, unit: "units from the hoop", noun: "3-point shots" }),
    clutchMargin: calibrateClutchMargin(),
    secondChanceWindow: calibrateSecondChanceWindow()
  };
  return calibrationCache;
}
function closeRangeThreshold() { return getCalibrations().closeRange.current; }
function threePtDeepThreshold() { return getCalibrations().threePtDeep.current; }
function clutchMarginThreshold() { return getCalibrations().clutchMargin.current; }
function secondChanceWindowSeconds() { return getCalibrations().secondChanceWindow.current; }

function shotBand(loc, points) {
  const distance = shotDistanceFromHoop(loc);
  if (points === 3) return distance > threePtDeepThreshold() ? "deep" : "arc";
  return distance > closeRangeThreshold() ? "mid" : "close";
}

function renderCalibrationPanel() {
  const wrap = document.getElementById("calibrationPanel");
  if (!wrap) return;
  const cal = getCalibrations();
  const sections = [
    { title: "Close/Midrange boundary (2-point shots)", c: cal.closeRange },
    { title: "Line/Deep boundary (3-point shots)", c: cal.threePtDeep },
    { title: "Close-game margin", c: cal.clutchMargin },
    { title: "Second-chance window", c: cal.secondChanceWindow }
  ];
  wrap.innerHTML = sections.map(({ title, c }) => {
    const head = `<h3 style="margin:16px 0 4px;font-size:1rem">${escapeHtml(title)}</h3>`;
    if (c.history.length === 0) {
      return `${head}<p class="hint" style="margin-top:0">Using ${c.defaultValue} ${c.unit} until enough data is logged (${c.total} ${c.noun} so far, first check at ${c.nextAt}).</p>`;
    }
    const rows = c.history.map(h => {
      const result = !h.strong ? `Kept ${h.previous} (no clear signal yet)`
        : h.value === h.previous ? `Stayed at ${h.value}`
        : `Moved from ${h.previous} to ${h.value}`;
      return `<tr><td>${h.n}</td><td>${result}</td><td>${escapeHtml(h.detail)}</td></tr>`;
    }).join("");
    const started = c.history[0].previous;
    return `${head}
      <p class="hint" style="margin-top:0">Now <strong>${c.current}</strong> ${c.unit}${c.current !== started ? ` (started at ${started})` : ""}. Next check at ${c.nextAt} ${c.noun}.</p>
      <div class="table-scroll"><table class="matchup-table">
        <thead><tr><th>${escapeHtml(c.noun.charAt(0).toUpperCase() + c.noun.slice(1))} used</th><th>Result</th><th>Detail</th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div>`;
  }).join("");
}

// Field goal / free throw splits derived from scoringEvents for one player in one game.
// points === 1 is treated as a free throw attempt; 2 or 3 are field goal attempts.
function shootingStats(game, playerId) {
  const shots = game.scoringEvents.filter(ev => ev.scorerId === playerId);
  const made = ev => ev.made !== false;
  const fg = shots.filter(ev => ev.points === 2 || ev.points === 3);
  const two = shots.filter(ev => ev.points === 2);
  const three = shots.filter(ev => ev.points === 3);
  const ft = shots.filter(ev => ev.points === 1);
  // Banded splits — only among attempts with a marked shot location (banding needs x/y to
  // measure distance). An unmarked attempt still counts in fgm/fga/tpm/tpa above, just not in
  // any band below — same as the heatmap/backfill tools treat an unmarked shot as excluded, so
  // e.g. tpArcA + tpDeepA can be less than tpa until every 3PT attempt has a location marked.
  const close = two.filter(ev => ev.shotLocation && shotBand(ev.shotLocation, 2) === "close");
  const mid = two.filter(ev => ev.shotLocation && shotBand(ev.shotLocation, 2) === "mid");
  const threeArc = three.filter(ev => ev.shotLocation && shotBand(ev.shotLocation, 3) === "arc");
  const threeDeep = three.filter(ev => ev.shotLocation && shotBand(ev.shotLocation, 3) === "deep");
  const dunk = two.filter(ev => ev.dunk === true);
  return {
    fgm: fg.filter(made).length, fga: fg.length,
    tpm: three.filter(made).length, tpa: three.length,
    ftm: ft.filter(made).length, fta: ft.length,
    closeM: close.filter(made).length, closeA: close.length,
    midM: mid.filter(made).length, midA: mid.length,
    tpArcM: threeArc.filter(made).length, tpArcA: threeArc.length,
    tpDeepM: threeDeep.filter(made).length, tpDeepA: threeDeep.length,
    dunkM: dunk.filter(made).length, dunkA: dunk.length
  };
}

// Defensive mirror of shootingStats() above (see poolean-defensive-mirrors-spec.md): the exact
// same zone-banding logic, just scoped to shots this player is tagged DEFENDING instead of shots
// they took. Free throws have no defender tag at all, so there's no ft* here the way shootingStats
// has ftm/fta -- only field goals are ever defended.
function defensiveShootingStats(game, playerId) {
  const shots = game.scoringEvents.filter(ev => (ev.defenderIds || []).includes(playerId));
  const made = ev => ev.made !== false;
  const fg = shots.filter(ev => ev.points === 2 || ev.points === 3);
  const two = shots.filter(ev => ev.points === 2);
  const three = shots.filter(ev => ev.points === 3);
  const close = two.filter(ev => ev.shotLocation && shotBand(ev.shotLocation, 2) === "close");
  const mid = two.filter(ev => ev.shotLocation && shotBand(ev.shotLocation, 2) === "mid");
  const threeArc = three.filter(ev => ev.shotLocation && shotBand(ev.shotLocation, 3) === "arc");
  const threeDeep = three.filter(ev => ev.shotLocation && shotBand(ev.shotLocation, 3) === "deep");
  return {
    fgm: fg.filter(made).length, fga: fg.length,
    tpm: three.filter(made).length, tpa: three.length,
    closeM: close.filter(made).length, closeA: close.length,
    midM: mid.filter(made).length, midA: mid.length,
    tpArcM: threeArc.filter(made).length, tpArcA: threeArc.length,
    tpDeepM: threeDeep.filter(made).length, tpDeepA: threeDeep.length,
  };
}

function pct(made, attempted) {
  return attempted > 0 ? Math.round((made / attempted) * 100) : null;
}

// True Shooting % — scoring efficiency accounting for the extra value of 3s and the lower
// cost of free throws. Standard formula: PTS / (2 * (FGA + 0.44 * FTA)).
function trueShootingPct(pts, fga, fta) {
  const denom = 2 * (fga + 0.44 * fta);
  return denom > 0 ? Math.round((pts / denom) * 100) : null;
}

// Turnover % — a player's own turnovers as a share of their own "plays used" (FGA, plus FTA
// scaled by the same 0.44 free-throw-trip factor TS% uses above, plus the turnovers
// themselves) — not a share of the team's turnovers, since giving the ball away isn't a
// shared resource the way a shot or an assist is. Standard formula: TOV / (FGA + 0.44×FTA + TOV).
function turnoverPct(tov, fga, fta) {
  const denom = fga + 0.44 * fta + tov;
  return denom > 0 ? Math.round((tov / denom) * 100) : null;
}

// Effective FG% — FG% adjusted so a make 3 counts as 1.5x a make 2.
function effectiveFgPct(fgm, tpm, fga) {
  return fga > 0 ? Math.round(((fgm + 0.5 * tpm) / fga) * 100) : null;
}

// Rounds defensively — every existing caller already passes an integer straight from pct() /
// turnoverPct() / trueShootingPct() (all three round internally), so this is a no-op for them;
// it only actually matters for a value like a plain average of several already-rounded numbers
// (computePlayerTips' own leagueAvg()), which is a real, non-integer float and would otherwise
// print however many decimal places floating-point division happens to produce.
function formatPct(v) {
  return v === null ? "—" : `${Math.round(v)}%`;
}

// { playerId, points, isMiss } while waiting for the user to pick who (if anyone) was
// contesting the shot. pendingDefenders holds the multi-select in progress (a shot can be
// double-teamed) until Confirm commits it. pendingAssist is the single teammate credited
// with the assist, if any — only offered on makes, since a miss can't be assisted. pendingBlocker
// and pendingOutOfBounds are miss-only: who (if anyone) blocked it, and whether it went out of
// bounds — which, per Poolean's out-of-bounds rule, is a turnover for the shooter. pendingRebounder
// is who (if anyone, from either team) grabbed it — only offered on a live-ball miss, since an
// out-of-bounds miss never gets rebounded.
let pendingScore = null;
let pendingDefenders = new Set();
let pendingAssist = null;
let pendingBlocker = null;
let pendingOutOfBounds = false;
let pendingRebounder = null;
// { x, y } as percentages (0-100) of the shot chart, y=0 at the hoop and y=100 at the far
// wall — or null if no location was marked. Offered on field goals only (points 2 or 3), never
// on free throws, since a free throw has no shot location on the floor.
let pendingShotLocation = null;
// Whether this attempt was a dunk — offered on field goals only, same as shot location. Added so
// Shot Arc's ball-flight fitting can exclude dunks up front (a dunk is carried by hand through a
// close-range slam, not a free-flying arc, so no amount of window-trimming makes one fit a
// parabola; see shot-arc/FINDINGS.md, caught from a real hand-labeled shot whose trajectory
// zigzagged instead of tracing one arc). Existing shots logged before this field existed have
// dunk === undefined rather than false — see "Review Possible Dunks" below for backfilling those.
let pendingDunk = false;
let pendingShotType = null;

// { playerId, kind: "tov"|"stl"|"pf" } while waiting for the user to tag the one opponent
// involved (unlike shot defenders, these are single-select and commit immediately on click —
// a turnover/steal/foul only ever involves one other player, no double-teams to account for).
let pendingTag = null;

// Which screen-side hoop Team A shoots at this game (Team B is always the other one) — set once
// per game rather than per shot, since teams don't swap ends mid-game here. Purely additive:
// doesn't touch shotLocation's own x/y meaning at all, so heatmaps and shot charts stay exactly
// as they've always been either way — this only powers the separate Shooting by Direction split.
//
// Stored as "left"/"right" throughout (screen-relative, easy to derive consistently), but always
// DISPLAYED by a real backyard landmark (which hoop is toward the deck vs. the bushes) instead —
// anyone looking at a panel later, a friend on the viewer site included, has no way to know which
// way this particular camera happens to be pointed, so a bare "Left"/"Right" would mean nothing
// to them even though it's unambiguous to whoever's actively looking at the live video.
function directionLabel(dir) {
  return dir === "left" ? "Deck" : dir === "right" ? "Bushes" : "?";
}

function renderTeamDirectionToggle(game) {
  const wrap = document.getElementById("teamDirectionToggle");
  if (!wrap) return;
  const statusText = game.teamADirection
    ? `✓ Set: Team A shoots toward the ${directionLabel(game.teamADirection).toLowerCase()}`
    : "Not set yet";
  wrap.innerHTML = `<span>Where is Team A shooting?</span>
    <button type="button" class="secondary-btn${game.teamADirection === "left" ? " selected" : ""}" data-team-direction="left">Deck</button>
    <button type="button" class="secondary-btn${game.teamADirection === "right" ? " selected" : ""}" data-team-direction="right">Bushes</button>
    <span class="team-direction-status${game.teamADirection ? " team-direction-status-set" : ""}">${statusText}</span>
  `;
  wrap.querySelectorAll("[data-team-direction]").forEach(btn => {
    btn.addEventListener("click", () => {
      game.teamADirection = game.teamADirection === btn.dataset.teamDirection ? null : btn.dataset.teamDirection;
      saveState();
      renderTeamDirectionToggle(game);
    });
  });
}

// Same pattern as the dunk flag: a simple human-confirmed checkbox, not something inferred from
// the box score (see poolean-stopped-early-spec.md) -- a naturally short, fast, complete game and
// a stopped-early one can look identical in raw counts, so this needs someone who was there.
function renderStoppedEarlyToggle(game) {
  const wrap = document.getElementById("stoppedEarlyToggle");
  if (!wrap) return;
  wrap.innerHTML = `
    <button type="button" class="secondary-btn${game.stoppedEarly ? " selected" : ""}" data-toggle-stopped-early="1">
      ${game.stoppedEarly ? "🛑 Stopped early" : "Mark as stopped early"}
    </button>
    ${game.stoppedEarly ? '<span class="hint" style="margin:0">Excluded from per-game comparisons (Best/Worst Games, Power Ranking vs. Performance, Shot Attempt Differential, Pace/PPP, Win Shares). Season-total rates still include it.</span>' : ""}
  `;
  wrap.querySelector("[data-toggle-stopped-early]").addEventListener("click", () => {
    game.stoppedEarly = !game.stoppedEarly;
    saveState();
    renderStoppedEarlyToggle(game);
  });
}

// Which screen-side hoop this player's own team is shooting at this game, or null if the game's
// own direction hasn't been set (game.teamADirection) or the player isn't on either roster.
function playerShotDirection(game, playerId) {
  if (!game.teamADirection) return null;
  if (game.teamA.includes(playerId)) return game.teamADirection;
  if (game.teamB.includes(playerId)) return game.teamADirection === "left" ? "right" : "left";
  return null;
}

function renderStatEntry() {
  const game = state.games.find(g => g.id === currentGameId);
  if (!game) return;

  document.getElementById("statEntryTitle").textContent = formatDateDisplay(game.date);
  const scoreA = teamScore(game, game.teamA);
  const scoreB = teamScore(game, game.teamB);
  document.getElementById("statEntryScore").innerHTML = `
    <span class="scoreboard-team${scoreA > scoreB ? " leading" : ""}">
      <span class="scoreboard-label">Team A</span>
      <span class="scoreboard-value">${scoreA}</span>
    </span>
    <span class="scoreboard-dash">–</span>
    <span class="scoreboard-team${scoreB > scoreA ? " leading" : ""}">
      <span class="scoreboard-value">${scoreB}</span>
      <span class="scoreboard-label">Team B</span>
    </span>
    ${(game.liveScores || []).length ? `<span class="scoreboard-live" title="Tracked live on party night: who scored, not a full shot log. A reference while logging from film.">Live score ${liveScoreOf(game, game.teamA)}-${liveScoreOf(game, game.teamB)}</span>` : ""}
  `;

  renderTeamDirectionToggle(game);
  renderStoppedEarlyToggle(game);
  renderVideoPanel(game);
  renderRosterAssignment(game);
  renderBoxScore(game);
  renderGameStatsTable(game);
  renderScoringLog(game);
  renderOtherEventsLog(game);
  renderMatchupForm(game);
  renderMatchupTable(game);
  renderSuggestedPlays(game);
  renderReel(game);
}

// {key, label, accessor} for the sortable header — "time" doubles as the chronological order
// (see otherEventsSort below), so clicking it while already on it just flips direction; the
// dedicated ↺ Chronological button is the reliable way back to the original natural order,
// since a direction flip alone can't distinguish "chronological" from "reverse-chronological."
const OTHER_EVENTS_COLUMNS = [
  { key: "type", label: "Type", accessor: r => r.cfg.verb },
  { key: "player", label: "Player", accessor: r => r.playerName },
  { key: "opponent", label: "Opponent", accessor: r => r.opponentName },
  { key: "time", label: "Time", accessor: r => r.videoTime }
];
// null key = natural order (chronological by videoTime, nulls last) — the same order this table
// has always opened with. Only a real column key overrides it.
let otherEventsSort = { key: null, dir: "asc" };

// TOV/STL/PF, each optionally tagged with the one opponent involved (see TAGGED_STAT_CONFIG).
function renderOtherEventsLog(game) {
  const headerRow = document.getElementById("otherEventsHeaderRow");
  const body = document.getElementById("otherEventsBody");
  if (!body) return;
  renderSortableHeader(headerRow, OTHER_EVENTS_COLUMNS, otherEventsSort, () => renderOtherEventsLog(game));
  headerRow.appendChild(document.createElement("th"));
  headerRow.appendChild(document.createElement("th"));
  headerRow.appendChild(document.createElement("th"));

  // Merging turnovers/steals/fouls means there's no single natural order (each type is its own
  // array) — chronological order sorts by videoTime so the table reads in the order the plays
  // actually happened, rather than grouped by type. Events with no timestamp (no video loaded
  // when logged) sort last, since there's nothing to place them by.
  let rows = TAGGED_STAT_CONFIG.flatMap(cfg =>
    game[cfg.eventsKey].map(ev => {
      const player = state.players.find(p => p.id === ev.playerId);
      const opponent = ev.opponentId ? state.players.find(p => p.id === ev.opponentId) : null;
      return { ...ev, cfg, playerName: player ? player.name : "?", opponentName: opponent ? opponent.name : "" };
    })
  );
  if (otherEventsSort.key === null) {
    rows.sort((a, b) => {
      if (a.videoTime === null) return b.videoTime === null ? 0 : 1;
      if (b.videoTime === null) return -1;
      return a.videoTime - b.videoTime;
    });
  } else {
    const sortCol = OTHER_EVENTS_COLUMNS.find(c => c.key === otherEventsSort.key);
    rows.sort((a, b) => compareForSort(sortCol.accessor(a), sortCol.accessor(b), otherEventsSort.dir));
  }
  if (rows.length === 0) {
    body.innerHTML = '<tr><td colspan="7" class="empty-state">No turnovers, steals, or fouls recorded yet.</td></tr>';
    return;
  }
  body.innerHTML = "";
  rows.forEach(ev => {
    const viaSteal = ev.cfg.field === "tov" && ev.stealEventId;
    const viaMiss = ev.cfg.field === "tov" && ev.missEventId;
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${ev.cfg.verb}${viaSteal ? ' <span class="hint" style="margin:0">(via steal)</span>' : ""}${viaMiss ? ' <span class="hint" style="margin:0">(shot out of bounds)</span>' : ""}</td>
      <td>${escapeHtml(ev.playerName)}</td>
      <td>${ev.opponentName ? escapeHtml(ev.opponentName) : "—"}</td>
      <td>${formatVideoTime(ev.videoTime)}</td>
    `;
    const tdJump = document.createElement("td");
    tdJump.appendChild(createJumpButton(padJumpTime(ev.videoTime)));
    tr.appendChild(tdJump);
    const tdEdit = document.createElement("td");
    tdEdit.appendChild(createEditTimeButton(t => {
      const real = game[ev.cfg.eventsKey].find(e => e.id === ev.id);
      if (!real) return;
      real.videoTime = t;
      saveState();
      renderOtherEventsLog(game);
    }));
    tr.appendChild(tdEdit);
    const tdBtn = document.createElement("td");
    const delBtn = document.createElement("button");
    delBtn.className = "icon-btn";
    delBtn.textContent = "Remove";
    delBtn.title = viaSteal ? "Also removes the linked steal" : viaMiss ? "Un-marks the linked shot as an out-of-bounds turnover" : (ev.cfg.field === "stl" ? "Also removes the linked turnover" : "");
    delBtn.addEventListener("click", () => {
      removeTaggedEvent(game, ev.cfg, ev.id);
      recomputeDerivedStats(game);
      saveState();
      renderStatEntry();
    });
    tdBtn.appendChild(delBtn);
    tr.appendChild(tdBtn);
    body.appendChild(tr);
  });
}
document.getElementById("otherEventsChronoBtn").addEventListener("click", () => {
  otherEventsSort = { key: null, dir: "asc" };
  const game = state.games.find(g => g.id === currentGameId);
  if (game) renderOtherEventsLog(game);
});

// ---- Shot log (every make and miss, with who if anyone was contesting/assisting) ----
// Editing state for an already-logged shot in the Shot Log — separate from pendingScore/etc.
// (the new-entry flow in the box score) so the two never collide if both happened to be open
// at once. Covers defender/assist/blocker/rebounder only, not make-vs-miss, points, or the
// out-of-bounds turnover link — those change what other records exist (the linked turnover,
// the derived pts) rather than just who's tagged, so correcting one of those still means
// deleting and re-logging the shot.
let editingShotId = null;
let editDefenders = new Set();
let editAssist = null;
let editBlocker = null;
let editRebounder = null;
let editReboundContesters = new Set();
let editNoContest = false;
let editShotType = null;

function renderShotEditRow(game, ev) {
  const scorerOnA = game.teamA.includes(ev.scorerId);
  const opponentIds = scorerOnA ? game.teamB : game.teamA;
  const teammateIds = (scorerOnA ? game.teamA : game.teamB).filter(id => id !== ev.scorerId);
  const opponents = opponentIds.map(id => state.players.find(p => p.id === id)).filter(Boolean);
  const teammates = teammateIds.map(id => state.players.find(p => p.id === id)).filter(Boolean);
  const scorer = state.players.find(p => p.id === ev.scorerId);
  const made = ev.made !== false;

  const tr = document.createElement("tr");
  tr.innerHTML = `
    <td colspan="8" class="stat-cell expanded" style="text-align:left">
      <div class="stat-label">Editing ${scorer ? escapeHtml(scorer.name) : "?"}'s ${made ? "make" : "miss"} (defender/assist/block/rebound only)</div>
      ${(ev.points === 2 || ev.points === 3) && ev.dunk !== true ? `
        <div class="stat-label" style="margin-top:6px">Shot type</div>
        <div class="defender-pick-list">${shotTypeButtonsHtml(editShotType, "edit-shot-type")}</div>
      ` : ""}
      <div class="stat-label" style="margin-top:6px">Contesting defender(s)</div>
      <div class="defender-pick-list">
        <button type="button" class="secondary-btn${editDefenders.size === 0 ? " selected" : ""}" data-edit-nodefender="1">No defender</button>
        ${opponents.map(o => `<button type="button" class="secondary-btn${editDefenders.has(o.id) ? " selected" : ""}" data-edit-defender="${o.id}">${escapeHtml(o.name)}</button>`).join("")}
      </div>
      ${made ? `
        <div class="stat-label" style="margin-top:6px">Assisted by?</div>
        <div class="defender-pick-list">
          <button type="button" class="secondary-btn${!editAssist ? " selected" : ""}" data-edit-noassist="1">No assist</button>
          ${teammates.map(t => `<button type="button" class="secondary-btn${editAssist === t.id ? " selected" : ""}" data-edit-assist="${t.id}">${escapeHtml(t.name)}</button>`).join("")}
        </div>
      ` : `
        <div class="stat-label" style="margin-top:6px">Blocked by?</div>
        <div class="defender-pick-list">
          <button type="button" class="secondary-btn${!editBlocker ? " selected" : ""}" data-edit-noblock="1">No block</button>
          ${opponents.map(o => `<button type="button" class="secondary-btn${editBlocker === o.id ? " selected" : ""}" data-edit-block="${o.id}">${escapeHtml(o.name)}</button>`).join("")}
        </div>
        ${ev.turnoverEventId ? '<p class="hint" style="margin:6px 0 0">This miss is marked out of bounds, so it has no rebounder. Remove and re-log it if that\'s wrong.</p>' : `
          <div class="stat-label" style="margin-top:6px">Rebounded by?</div>
          <div class="defender-pick-list">
            <button type="button" class="secondary-btn${!editRebounder ? " selected" : ""}" data-edit-norebound="1">No rebound tracked</button>
            <button type="button" class="secondary-btn${editRebounder === ev.scorerId ? " selected" : ""}" data-edit-rebound="${ev.scorerId}">${scorer ? escapeHtml(scorer.name) : "?"} (self)</button>
            ${teammates.map(t => `<button type="button" class="secondary-btn${editRebounder === t.id ? " selected" : ""}" data-edit-rebound="${t.id}">${escapeHtml(t.name)}</button>`).join("")}
            ${opponents.map(o => `<button type="button" class="secondary-btn${editRebounder === o.id ? " selected" : ""}" data-edit-rebound="${o.id}">${escapeHtml(o.name)} (opp)</button>`).join("")}
          </div>
          ${editRebounder ? (() => {
            // Who was contesting position against the rebounder specifically -- the rebound
            // equivalent of defenderIds, see poolean-rebound-battles-spec.md. A real new
            // per-play tagging step, not inferred: leave it blank rather than guess, same
            // "tag whoever's genuinely contesting" stance shot defense already uses. Candidates
            // are always the team OPPOSITE the rebounder, not the shooter -- a teammate rebounding
            // (offensive board) gets contested by the shooter's opponents; an opponent rebounding
            // (defensive board) gets contested by the shooter's own side.
            const rebounderOnScorerSide = editRebounder === ev.scorerId || teammateIds.includes(editRebounder);
            const contesterIds = rebounderOnScorerSide ? opponentIds : [ev.scorerId, ...teammateIds];
            const contesters = contesterIds.map(id => state.players.find(p => p.id === id)).filter(Boolean);
            // "Not tagged" (haven't looked / unsure) and "No contest" (looked, confirmed nobody
            // was actually contesting it -- a genuine, uncontested/leaked-out rebound) are two
            // different, real answers, not the same blank state -- see reboundNoContest above.
            return `
              <div class="stat-label" style="margin-top:6px">Contesting the rebounder (Rebound Battles -- tag only if you're sure)</div>
              <div class="defender-pick-list">
                <button type="button" class="secondary-btn${editReboundContesters.size === 0 && !editNoContest ? " selected" : ""}" data-edit-nocontester="1">Not tagged</button>
                <button type="button" class="secondary-btn${editNoContest ? " selected" : ""}" data-edit-nocontest="1">No contest (uncontested)</button>
                ${contesters.map(c => `<button type="button" class="secondary-btn${editReboundContesters.has(c.id) ? " selected" : ""}" data-edit-contester="${c.id}">${escapeHtml(c.name)}</button>`).join("")}
              </div>
            `;
          })() : ""}
        `}
      `}
      <div class="confirm-row">
        <button type="button" class="highlight-btn confirm-btn" data-edit-save="1">✓ Save</button>
        <button type="button" class="secondary-btn" data-edit-cancel="1">Cancel</button>
      </div>
    </td>
  `;
  tr.querySelectorAll("[data-edit-shot-type]").forEach(b => {
    b.addEventListener("click", () => { editShotType = editShotType === b.dataset.editShotType ? null : b.dataset.editShotType; renderScoringLog(game); });
  });
  tr.querySelector("[data-edit-nodefender]").addEventListener("click", () => { editDefenders.clear(); renderScoringLog(game); });
  tr.querySelectorAll("[data-edit-defender]").forEach(b => {
    b.addEventListener("click", () => {
      const id = b.dataset.editDefender;
      if (editDefenders.has(id)) editDefenders.delete(id); else editDefenders.add(id);
      renderScoringLog(game);
    });
  });
  if (made) {
    tr.querySelector("[data-edit-noassist]").addEventListener("click", () => { editAssist = null; renderScoringLog(game); });
    tr.querySelectorAll("[data-edit-assist]").forEach(b => {
      b.addEventListener("click", () => { editAssist = editAssist === b.dataset.editAssist ? null : b.dataset.editAssist; renderScoringLog(game); });
    });
  } else {
    tr.querySelector("[data-edit-noblock]").addEventListener("click", () => { editBlocker = null; renderScoringLog(game); });
    tr.querySelectorAll("[data-edit-block]").forEach(b => {
      b.addEventListener("click", () => { editBlocker = editBlocker === b.dataset.editBlock ? null : b.dataset.editBlock; renderScoringLog(game); });
    });
    if (!ev.turnoverEventId) {
      // Changing (or clearing) the rebounder invalidates any already-picked contesters -- the
      // candidate side flips depending on who the rebounder is, so a stale pick from before the
      // change could silently point at the wrong team.
      tr.querySelector("[data-edit-norebound]").addEventListener("click", () => { editRebounder = null; editReboundContesters.clear(); editNoContest = false; renderScoringLog(game); });
      tr.querySelectorAll("[data-edit-rebound]").forEach(b => {
        b.addEventListener("click", () => {
          editRebounder = editRebounder === b.dataset.editRebound ? null : b.dataset.editRebound;
          editReboundContesters.clear();
          editNoContest = false;
          renderScoringLog(game);
        });
      });
      const noContesterBtn = tr.querySelector("[data-edit-nocontester]");
      if (noContesterBtn) noContesterBtn.addEventListener("click", () => { editReboundContesters.clear(); editNoContest = false; renderScoringLog(game); });
      const noContestBtn = tr.querySelector("[data-edit-nocontest]");
      if (noContestBtn) noContestBtn.addEventListener("click", () => { editReboundContesters.clear(); editNoContest = !editNoContest; renderScoringLog(game); });
      tr.querySelectorAll("[data-edit-contester]").forEach(b => {
        b.addEventListener("click", () => {
          const id = b.dataset.editContester;
          if (editReboundContesters.has(id)) editReboundContesters.delete(id); else editReboundContesters.add(id);
          editNoContest = false;
          renderScoringLog(game);
        });
      });
    }
  }
  tr.querySelector("[data-edit-save]").addEventListener("click", () => {
    ev.defenderIds = [...editDefenders];
    if (ev.points === 2 || ev.points === 3) ev.shotType = editShotType;
    if (made) {
      ev.assistId = editAssist;
    } else {
      ev.blockerId = editBlocker;
      if (!ev.turnoverEventId) {
        ev.rebounderId = editRebounder;
        ev.reboundContesterIds = editRebounder ? [...editReboundContesters] : [];
        ev.reboundNoContest = editRebounder ? editNoContest : false;
      }
    }
    editingShotId = null;
    recomputeDerivedStats(game);
    saveState();
    renderStatEntry();
  });
  tr.querySelector("[data-edit-cancel]").addEventListener("click", () => {
    editingShotId = null;
    renderScoringLog(game);
  });
  return tr;
}

// null key = natural order (most-recently-logged first, the same order this table has always
// opened with — a plain reverse of insertion order, not a videoTime sort). Only a real column
// key overrides it; the ↺ Chronological button restores null.
const SHOT_LOG_COLUMNS = [
  { key: "shooter", label: "Shooter", accessor: r => r.scorerName },
  { key: "result", label: "Result", accessor: r => r.made ? "Make" : "Miss" },
  { key: "value", label: "Value", accessor: r => r.points },
  { key: "assist", label: "Assist", accessor: r => r.assisterName },
  { key: "defender", label: "Defender", accessor: r => r.defenderLabel },
  { key: "time", label: "Time", accessor: r => r.videoTime }
];
let shotLogSort = { key: null, dir: "asc" };

function renderScoringLog(game) {
  const headerRow = document.getElementById("scoringLogHeaderRow");
  const body = document.getElementById("scoringLogBody");
  if (!body) return;
  renderSortableHeader(headerRow, SHOT_LOG_COLUMNS, shotLogSort, () => renderScoringLog(game));
  headerRow.appendChild(document.createElement("th"));
  headerRow.appendChild(document.createElement("th"));
  headerRow.appendChild(document.createElement("th"));
  body.innerHTML = "";
  if (game.scoringEvents.length === 0) {
    body.innerHTML = '<tr><td colspan="9" class="empty-state">No shots recorded yet.</td></tr>';
    return;
  }
  let rows = game.scoringEvents.map(ev => {
    const scorer = state.players.find(p => p.id === ev.scorerId);
    const assister = ev.assistId ? state.players.find(p => p.id === ev.assistId) : null;
    return { ev, scorerName: scorer ? scorer.name : "?", made: ev.made !== false, points: ev.points, assisterName: assister ? assister.name : "", defenderLabel: defenderNames(ev.defenderIds), videoTime: ev.videoTime };
  });
  if (shotLogSort.key === null) {
    rows.reverse();
  } else {
    const sortCol = SHOT_LOG_COLUMNS.find(c => c.key === shotLogSort.key);
    rows.sort((a, b) => compareForSort(sortCol.accessor(a), sortCol.accessor(b), shotLogSort.dir));
  }
  rows.forEach(({ ev }) => {
    const scorer = state.players.find(p => p.id === ev.scorerId);
    const made = ev.made !== false;
    const assister = ev.assistId ? state.players.find(p => p.id === ev.assistId) : null;
    const blocker = ev.blockerId ? state.players.find(p => p.id === ev.blockerId) : null;
    const rebounder = ev.rebounderId ? state.players.find(p => p.id === ev.rebounderId) : null;
    let resultBadge = made
      ? '<span class="badge badge-highlight">✅ Make</span>'
      : '<span class="badge badge-lowlight">❌ Miss</span>';
    if (blocker) resultBadge += ` <span class="badge">Blocked: ${playerLink(blocker.id, blocker.name)}</span>`;
    if (ev.turnoverEventId) resultBadge += ' <span class="badge">Out of bounds → TOV</span>';
    if (rebounder) {
      const kind = sameTeam(game, ev.scorerId, rebounder.id) ? "OREB" : "DREB";
      resultBadge += ` <span class="badge">${kind}: ${playerLink(rebounder.id, rebounder.name)}</span>`;
      if ((ev.reboundContesterIds || []).length > 0) {
        const contesterNames = playerLinksJoined((ev.reboundContesterIds || []).filter(id => state.players.some(p => p.id === id)));
        resultBadge += ` <span class="badge" title="Rebound Battles: who was contesting ${escapeHtml(rebounder.name)}">Contested by: ${contesterNames}</span>`;
      } else if (ev.reboundNoContest) {
        resultBadge += ` <span class="badge" title="Rebound Battles: reviewed, nobody was actually contesting this rebound">No contest</span>`;
      }
    }
    if (effShotType(ev)) resultBadge += ` <span class="badge" title="Shot type">${escapeHtml(shotTypeLabel(effShotType(ev)))}</span>`;
    if (ev.shotLocation) {
      const zone = ev.shotLocation.y >= 60 ? "3PT range" : "2PT range";
      resultBadge += ` <span class="badge">📍 ${zone}</span>`;
    }
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${scorer ? playerLink(scorer.id, scorer.name) : "?"}</td>
      <td>${resultBadge}</td>
      <td>${ev.points}</td>
      <td>${assister ? playerLink(assister.id, assister.name) : "—"}</td>
      <td>${defenderNamesLinked(ev.defenderIds)}</td>
      <td>${formatVideoTime(ev.videoTime)}</td>
    `;
    const tdJump = document.createElement("td");
    tdJump.appendChild(createJumpButton(padJumpTime(ev.videoTime)));
    tr.appendChild(tdJump);
    const tdEdit = document.createElement("td");
    tdEdit.appendChild(createEditTimeButton(t => {
      ev.videoTime = t;
      saveState();
      renderScoringLog(game);
    }));
    tr.appendChild(tdEdit);
    const tdBtn = document.createElement("td");
    const editBtn = document.createElement("button");
    editBtn.className = "icon-btn";
    editBtn.textContent = editingShotId === ev.id ? "Editing…" : "Edit";
    editBtn.disabled = editingShotId === ev.id;
    editBtn.title = "Fix the tagged defender, assist, block, or rebound (not make/miss, points, or out-of-bounds)";
    editBtn.addEventListener("click", () => {
      editingShotId = ev.id;
      editDefenders = new Set(ev.defenderIds || []);
      editAssist = ev.assistId;
      editBlocker = ev.blockerId;
      editRebounder = ev.rebounderId;
      editReboundContesters = new Set(ev.reboundContesterIds || []);
      editNoContest = ev.reboundNoContest === true;
      editShotType = ev.shotType || null;
      renderScoringLog(game);
    });
    tdBtn.appendChild(editBtn);
    const delBtn = document.createElement("button");
    delBtn.className = "icon-btn";
    delBtn.textContent = "Remove";
    delBtn.addEventListener("click", () => {
      game.scoringEvents = game.scoringEvents.filter(e => e.id !== ev.id);
      if (ev.turnoverEventId) game.turnoverEvents = game.turnoverEvents.filter(e => e.id !== ev.turnoverEventId);
      if (editingShotId === ev.id) editingShotId = null;
      recomputeDerivedStats(game);
      saveState();
      renderStatEntry();
    });
    tdBtn.appendChild(delBtn);
    tr.appendChild(tdBtn);
    body.appendChild(tr);
    if (editingShotId === ev.id) body.appendChild(renderShotEditRow(game, ev));
  });
}
document.getElementById("scoringLogChronoBtn").addEventListener("click", () => {
  shotLogSort = { key: null, dir: "asc" };
  const game = state.games.find(g => g.id === currentGameId);
  if (game) renderScoringLog(game);
});

// ---- Video ----
let currentVideoEl = null; // the live <video> element for the open game, when there is one

// The live playback position when an event is logged, so it can be jumped back to later —
// null if no video is loaded (or it's a YouTube/generic iframe embed, which this tool can't
// read the playback position of). Backed up by TIMESTAMP_LEAD_SECONDS since you're always
// clicking a moment after the play actually happened.
function currentPlaybackTime() {
  return currentVideoEl ? Math.max(0, currentVideoEl.currentTime - TIMESTAMP_LEAD_SECONDS) : null;
}

// Left/Right arrow keys scrub the loaded video by SEEK_STEP_SECONDS, from anywhere on the
// page — skipped while typing in a field (a text input, a number input like the video-start
// field, etc.) so arrow keys still move the cursor/adjust the value there like normal.
document.addEventListener("keydown", e => {
  if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
  if (!currentVideoEl) return;
  const tag = document.activeElement ? document.activeElement.tagName : "";
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || (document.activeElement && document.activeElement.isContentEditable)) return;
  e.preventDefault();
  const delta = e.key === "ArrowLeft" ? -SEEK_STEP_SECONDS : SEEK_STEP_SECONDS;
  currentVideoEl.currentTime = Math.max(0, currentVideoEl.currentTime + delta);
});

function renderMasterVideoControls(game) {
  const select = document.getElementById("masterVideoSelect");
  select.innerHTML = '<option value="">None (use a video just for this game)</option>' +
    state.masterVideos.map(m => `<option value="${m.id}">${escapeHtml(m.name)}</option>`).join("");
  select.value = game.masterVideoId || "";

  const startRow = document.getElementById("masterVideoStartRow");
  const endRow = document.getElementById("masterVideoEndRow");
  const detachRow = document.getElementById("masterVideoDetachRow");
  if (game.masterVideoId) {
    startRow.hidden = false;
    endRow.hidden = false;
    detachRow.hidden = false;
    document.getElementById("videoStartInput").value = game.videoStart;
    document.getElementById("videoStartFormatted").textContent = `(${formatTime(game.videoStart)})`;
    document.getElementById("videoEndInput").value = game.videoEnd === null ? "" : game.videoEnd;
    document.getElementById("videoEndFormatted").textContent = game.videoEnd === null ? "" : `(${formatTime(game.videoEnd)})`;
  } else {
    startRow.hidden = true;
    endRow.hidden = true;
    detachRow.hidden = true;
  }
}

document.getElementById("masterVideoSelect").addEventListener("change", e => {
  const game = state.games.find(g => g.id === currentGameId);
  if (!game) return;
  game.masterVideoId = e.target.value || null;
  if (game.masterVideoId && !game.videoStart) game.videoStart = 0;
  game.videoEnd = null; // any previously-set end belonged to whatever recording was attached before
  saveState();
  renderVideoPanel(game);
  renderGames();
  if (game.masterVideoId) loadStoredMasterVideo(game.masterVideoId);
});

document.getElementById("masterVideoInput").addEventListener("change", async e => {
  const game = state.games.find(g => g.id === currentGameId);
  const file = e.target.files[0];
  e.target.value = "";
  if (!game || !file) return;
  const name = prompt("Name this session recording (e.g. the date, or \"Aug 16 games\"):", file.name.replace(/\.[^.]+$/, ""));
  if (name === null) return;
  const masterId = uid("master");
  masterVideoBlobUrls[masterId] = URL.createObjectURL(file);
  state.masterVideos.push({ id: masterId, name: name.trim() || file.name, fileName: file.name });
  game.masterVideoId = masterId;
  game.videoStart = 0;
  game.videoEnd = null;
  await storeVideoFile(masterId, file);
  saveState();
  renderVideoPanel(game);
  renderGames();
});

document.getElementById("videoStartInput").addEventListener("change", e => {
  const game = state.games.find(g => g.id === currentGameId);
  if (!game) return;
  game.videoStart = Math.max(0, parseFloat(e.target.value) || 0);
  saveState();
  document.getElementById("videoStartFormatted").textContent = `(${formatTime(game.videoStart)})`;
  if (currentVideoEl) currentVideoEl.currentTime = game.videoStart;
});

document.getElementById("videoEndInput").addEventListener("change", e => {
  const game = state.games.find(g => g.id === currentGameId);
  if (!game) return;
  const raw = e.target.value.trim();
  game.videoEnd = raw === "" ? null : Math.max(0, parseFloat(raw) || 0);
  saveState();
  document.getElementById("videoEndFormatted").textContent = game.videoEnd === null ? "" : `(${formatTime(game.videoEnd)})`;
});

document.getElementById("setEndFromPlaybackBtn").addEventListener("click", () => {
  const game = state.games.find(g => g.id === currentGameId);
  if (!game || !currentVideoEl) return;
  game.videoEnd = currentVideoEl.currentTime;
  saveState();
  document.getElementById("videoEndInput").value = game.videoEnd.toFixed(1);
  document.getElementById("videoEndFormatted").textContent = `(${formatTime(game.videoEnd)})`;
});

document.getElementById("clearVideoEndBtn").addEventListener("click", () => {
  const game = state.games.find(g => g.id === currentGameId);
  if (!game) return;
  game.videoEnd = null;
  saveState();
  document.getElementById("videoEndInput").value = "";
  document.getElementById("videoEndFormatted").textContent = "";
});

document.getElementById("setStartFromPlaybackBtn").addEventListener("click", () => {
  const game = state.games.find(g => g.id === currentGameId);
  if (!game || !currentVideoEl) return;
  game.videoStart = currentVideoEl.currentTime;
  saveState();
  document.getElementById("videoStartInput").value = game.videoStart.toFixed(1);
  document.getElementById("videoStartFormatted").textContent = `(${formatTime(game.videoStart)})`;
});

document.getElementById("detachMasterVideoBtn").addEventListener("click", () => {
  const game = state.games.find(g => g.id === currentGameId);
  if (!game) return;
  game.masterVideoId = null;
  saveState();
  renderVideoPanel(game);
  renderGames();
});

// Identifies which video panel is currently showing, so renderVideoPanel can tell "same
// source as last render" apart from "the video actually needs to change." Without this,
// every stat click — which re-renders the whole Stat Entry view — would tear down and
// recreate the <video>/<iframe>, resetting playback to 0:00 and interrupting whatever was
// playing every single time you tagged a stat.
let renderedVideoKey = null;

function renderVideoPanel(game) {
  document.getElementById("videoUrlInput").value = game.videoUrl || "";
  renderMasterVideoControls(game);

  const wrap = document.getElementById("videoPlayerWrap");

  if (game.masterVideoId) {
    const masterUrl = masterVideoBlobUrls[game.masterVideoId];
    if (!masterUrl) {
      renderedVideoKey = null; // nothing stable rendered yet — always retry until it's ready
      wrap.innerHTML = '<p class="empty-state">Loading session video…</p>';
      currentVideoEl = null;
      updateReelButtons();
      return;
    }
    const key = `master:${game.id}:${game.masterVideoId}`;
    if (key === renderedVideoKey && wrap.querySelector("video")) { updateReelButtons(); return; }
    renderedVideoKey = key;
    wrap.innerHTML = `<video controls src="${masterUrl}"></video>`;
    const videoEl = wrap.querySelector("video");
    videoEl.addEventListener("loadedmetadata", () => { videoEl.currentTime = game.videoStart; }, { once: true });
    currentVideoEl = videoEl;
    updateReelButtons();
    return;
  }

  const localUrl = localVideoBlobUrls[game.id];
  if (localUrl) {
    const key = `local:${game.id}:${localUrl}`;
    if (key === renderedVideoKey && wrap.querySelector("video")) { updateReelButtons(); return; }
    renderedVideoKey = key;
    wrap.innerHTML = `<video controls src="${localUrl}"></video><p class="hint"><button type="button" id="removeLocalVideoBtn" class="icon-btn">Remove local video</button></p>`;
    document.getElementById("removeLocalVideoBtn").addEventListener("click", () => removeLocalVideo(game));
    currentVideoEl = wrap.querySelector("video");
    updateReelButtons();
    return;
  }
  if (!game.videoUrl) {
    renderedVideoKey = null;
    wrap.innerHTML = '<p class="empty-state">No video loaded yet.</p>';
    currentVideoEl = null;
    updateReelButtons();
    return;
  }
  const url = game.videoUrl;
  const ytMatch = url.match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|embed\/|shorts\/))([\w-]{11})/);
  if (ytMatch) {
    const key = `yt:${game.id}:${url}`;
    if (key === renderedVideoKey && wrap.querySelector("iframe")) { updateReelButtons(); return; }
    renderedVideoKey = key;
    currentVideoEl = null;
    wrap.innerHTML = `<iframe src="https://www.youtube.com/embed/${ytMatch[1]}" allowfullscreen></iframe>`;
    updateReelButtons();
    return;
  }
  if (/\.(mp4|webm|ogg|mov)(\?.*)?$/i.test(url)) {
    const key = `url:${game.id}:${url}`;
    if (key === renderedVideoKey && wrap.querySelector("video")) { updateReelButtons(); return; }
    renderedVideoKey = key;
    wrap.innerHTML = `<video controls src="${escapeHtml(url)}"></video>`;
    currentVideoEl = wrap.querySelector("video");
    updateReelButtons();
    return;
  }
  const key = `iframe:${game.id}:${url}`;
  if (key === renderedVideoKey && wrap.querySelector("iframe")) { updateReelButtons(); return; }
  renderedVideoKey = key;
  currentVideoEl = null;
  wrap.innerHTML = `
    <iframe src="${escapeHtml(url)}" allowfullscreen></iframe>
    <p class="hint">If the video above doesn't load, <a href="${escapeHtml(url)}" target="_blank" rel="noopener">open it in a new tab</a> instead.</p>
  `;
  updateReelButtons();
}

document.getElementById("saveVideoUrlBtn").addEventListener("click", async () => {
  const game = state.games.find(g => g.id === currentGameId);
  if (!game) return;
  if (localVideoBlobUrls[game.id]) {
    URL.revokeObjectURL(localVideoBlobUrls[game.id]);
    delete localVideoBlobUrls[game.id];
    await deleteVideoFile(game.id);
  }
  game.videoUrl = document.getElementById("videoUrlInput").value.trim();
  saveState();
  renderVideoPanel(game);
  renderGames();
});

document.getElementById("localVideoInput").addEventListener("change", async e => {
  const game = state.games.find(g => g.id === currentGameId);
  const file = e.target.files[0];
  e.target.value = "";
  if (!game || !file) return;
  if (localVideoBlobUrls[game.id]) URL.revokeObjectURL(localVideoBlobUrls[game.id]);
  localVideoBlobUrls[game.id] = URL.createObjectURL(file);
  renderVideoPanel(game);
  await storeVideoFile(game.id, file);
});

async function removeLocalVideo(game) {
  if (localVideoBlobUrls[game.id]) {
    URL.revokeObjectURL(localVideoBlobUrls[game.id]);
    delete localVideoBlobUrls[game.id];
  }
  await deleteVideoFile(game.id);
  renderVideoPanel(game);
}

// ---- Roster assignment ----
function setPlayerAssignment(game, playerId, value) {
  game.teamA = game.teamA.filter(id => id !== playerId);
  game.teamB = game.teamB.filter(id => id !== playerId);
  if (value === "A") game.teamA.push(playerId);
  if (value === "B") game.teamB.push(playerId);
}

// Compact chip-based assignment: each column only shows the players actually on that
// team, plus a small "add player" dropdown limited to whoever isn't assigned anywhere
// yet — much less to scan than listing all 21 roster players with a select each.
function renderRosterAssignment(game) {
  const wrap = document.getElementById("rosterAssignment");
  wrap.innerHTML = "";
  if (state.players.length === 0) {
    wrap.innerHTML = '<p class="empty-state">No players on the roster yet. Add players in the Players tab.</p>';
    return;
  }

  const byName = (a, b) => a.name.localeCompare(b.name);
  const assignedIds = new Set([...game.teamA, ...game.teamB]);
  const available = state.players.filter(p => !assignedIds.has(p.id)).sort(byName);

  [["Team A", game.teamA], ["Team B", game.teamB]].forEach(([label, playerIds]) => {
    const col = document.createElement("div");
    col.className = "roster-team-col";
    col.innerHTML = `<h4>${label}</h4>`;

    const chipWrap = document.createElement("div");
    chipWrap.className = "roster-chip-list";
    const players = playerIds.map(id => state.players.find(p => p.id === id)).filter(Boolean).sort(byName);
    if (players.length === 0) {
      chipWrap.innerHTML = '<span class="empty-state">No players yet.</span>';
    }
    players.forEach(p => {
      const chip = document.createElement("span");
      chip.className = "roster-chip";
      chip.innerHTML = `${escapeHtml(p.name)} <button type="button" title="Remove from ${label}">&times;</button>`;
      chip.querySelector("button").addEventListener("click", () => {
        setPlayerAssignment(game, p.id, "none");
        saveState();
        renderStatEntry();
      });
      chipWrap.appendChild(chip);
    });
    col.appendChild(chipWrap);

    const addSelect = document.createElement("select");
    addSelect.className = "roster-add-select";
    addSelect.innerHTML = `<option value="">+ Add player…</option>` +
      available.map(p => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join("");
    addSelect.addEventListener("change", () => {
      if (!addSelect.value) return;
      setPlayerAssignment(game, addSelect.value, label === "Team A" ? "A" : "B");
      saveState();
      renderStatEntry();
    });
    if (available.length === 0) addSelect.disabled = true;
    col.appendChild(addSelect);

    wrap.appendChild(col);
  });
}

// ---- Box score ----
function renderBoxScore(game) {
  const cols = document.getElementById("boxScoreColumns");
  cols.innerHTML = "";
  [["Team A", game.teamA, game.teamB], ["Team B", game.teamB, game.teamA]].forEach(([label, playerIds, opponentIds]) => {
    const box = document.createElement("div");
    box.className = "team-box";
    box.innerHTML = `<h3>${label}</h3>`;
    if (playerIds.length === 0) {
      box.innerHTML += '<p class="empty-state">No players assigned yet.</p>';
    }
    playerIds.forEach(pid => {
      const p = state.players.find(pl => pl.id === pid);
      if (!p) return;
      const s = getOrCreatePlayerStats(game, pid);
      const card = document.createElement("div");
      card.className = "player-stat-card";
      card.innerHTML = `<div class="name-row"><span>${escapeHtml(p.name)}</span></div>`;
      const grid = document.createElement("div");
      grid.className = "stat-grid";

      const ptsCell = document.createElement("div");
      ptsCell.className = "stat-cell";

      if (pendingScore && pendingScore.playerId === pid) {
        const opponents = opponentIds.map(id => state.players.find(pl2 => pl2.id === id)).filter(Boolean);
        const teammates = playerIds.filter(id => id !== pid).map(id => state.players.find(pl2 => pl2.id === id)).filter(Boolean);
        const verb = pendingScore.isMiss ? "contesting the miss" : "scored on";
        const selectedNames = opponents.filter(o => pendingDefenders.has(o.id)).map(o => o.name);
        const label = selectedNames.length > 0 ? selectedNames.join(" + ") : "No defender";
        const assister = pendingAssist ? state.players.find(pl2 => pl2.id === pendingAssist) : null;
        const blocker = pendingBlocker ? state.players.find(pl2 => pl2.id === pendingBlocker) : null;
        const rebounder = pendingRebounder ? state.players.find(pl2 => pl2.id === pendingRebounder) : null;
        ptsCell.classList.add("expanded");
        ptsCell.innerHTML = `
          <div class="stat-label">Who was ${verb}? (${pendingScore.isMiss ? "miss" : "+"}${pendingScore.points}): ${escapeHtml(label)}</div>
          <div class="defender-pick-list">
            <button type="button" class="secondary-btn${pendingDefenders.size === 0 ? " selected" : ""}" data-nodefender="1">No defender</button>
            ${opponents.map(o => `<button type="button" class="secondary-btn${pendingDefenders.has(o.id) ? " selected" : ""}" data-defender="${o.id}">${escapeHtml(o.name)}</button>`).join("")}
          </div>
          ${pendingScore.points === 1 ? "" : `
            <div class="stat-label" style="margin-top:6px">Where was it from? ${pendingShotLocation ? "" : "(not marked)"}</div>
            <div class="shot-chart-wrap">
              ${renderShotChartBaseSvg("data-shot-chart")}
              <button type="button" class="icon-btn" data-clear-location="1">Clear location</button>
            </div>
            <div class="stat-label" style="margin-top:6px">
              <button type="button" class="secondary-btn${pendingDunk ? " selected" : ""}" data-toggle-dunk="1">🏀 ${pendingDunk ? "Dunk" : "Not a dunk"}</button>
            </div>
            ${pendingDunk ? "" : `<div class="stat-label" style="margin-top:6px">Shot type? ${pendingShotType ? escapeHtml(shotTypeLabel(pendingShotType)) : "(not set)"}</div>
            <div class="defender-pick-list">${shotTypeButtonsHtml(pendingShotType, "shot-type")}</div>`}
          `}
          ${pendingScore.isMiss ? `
            <div class="stat-label" style="margin-top:6px">Blocked by? ${blocker ? escapeHtml(blocker.name) : "No block"}</div>
            <div class="defender-pick-list">
              <button type="button" class="secondary-btn${!pendingBlocker ? " selected" : ""}" data-noblock="1">No block</button>
              ${opponents.map(o => `<button type="button" class="secondary-btn${pendingBlocker === o.id ? " selected" : ""}" data-block="${o.id}">${escapeHtml(o.name)}</button>`).join("")}
            </div>
            <div class="stat-label" style="margin-top:6px">Where did it end up?</div>
            <div class="defender-pick-list">
              <button type="button" class="secondary-btn${!pendingOutOfBounds ? " selected" : ""}" data-live="1">Live ball</button>
              <button type="button" class="secondary-btn${pendingOutOfBounds ? " selected" : ""}" data-oob="1">Out of bounds (turnover)</button>
            </div>
            ${pendingOutOfBounds ? "" : `
              <div class="stat-label" style="margin-top:6px">Rebounded by? ${rebounder ? escapeHtml(rebounder.name) : "No rebound tracked"}</div>
              <div class="defender-pick-list">
                <button type="button" class="secondary-btn${!pendingRebounder ? " selected" : ""}" data-norebound="1">No rebound tracked</button>
                <button type="button" class="secondary-btn${pendingRebounder === pid ? " selected" : ""}" data-rebound="${pid}">${escapeHtml(p.name)} (self)</button>
                ${teammates.map(t => `<button type="button" class="secondary-btn${pendingRebounder === t.id ? " selected" : ""}" data-rebound="${t.id}">${escapeHtml(t.name)}</button>`).join("")}
                ${opponents.map(o => `<button type="button" class="secondary-btn${pendingRebounder === o.id ? " selected" : ""}" data-rebound="${o.id}">${escapeHtml(o.name)} (opp)</button>`).join("")}
              </div>
            `}
          ` : `
            <div class="stat-label" style="margin-top:6px">Assisted by? ${assister ? escapeHtml(assister.name) : "No assist"}</div>
            <div class="defender-pick-list">
              <button type="button" class="secondary-btn${!pendingAssist ? " selected" : ""}" data-noassist="1">No assist</button>
              ${teammates.map(t => `<button type="button" class="secondary-btn${pendingAssist === t.id ? " selected" : ""}" data-assist="${t.id}">${escapeHtml(t.name)}</button>`).join("")}
            </div>
          `}
          <div class="confirm-row">
            <button type="button" class="highlight-btn confirm-btn" data-confirm="1">✓ Confirm</button>
            <button type="button" class="secondary-btn" data-cancel="1">Cancel</button>
          </div>
        `;
        ptsCell.querySelector("[data-nodefender]").addEventListener("click", () => {
          pendingDefenders.clear();
          renderStatEntry();
        });
        ptsCell.querySelectorAll("button[data-defender]").forEach(b => {
          b.addEventListener("click", () => {
            const id = b.dataset.defender;
            if (pendingDefenders.has(id)) pendingDefenders.delete(id);
            else pendingDefenders.add(id);
            renderStatEntry();
          });
        });
        if (pendingScore.points !== 1) {
          const chartEl = ptsCell.querySelector("[data-shot-chart]");
          setShotChartDot(chartEl, pendingShotLocation);
          chartEl.addEventListener("click", e => {
            const rect = chartEl.getBoundingClientRect();
            const xFrac = Math.max(0, Math.min(100, ((e.clientX - rect.left) / rect.width) * 100));
            const yFrac = Math.max(0, Math.min(100, ((e.clientY - rect.top) / rect.height) * 100));
            // The chart renders flipped (hoop at the bottom), so the raw fraction from the top
            // of the box needs inverting to land back on the stored convention (y=0 at the hoop).
            pendingShotLocation = { x: xFrac, y: 100 - yFrac };
            renderStatEntry();
          });
          ptsCell.querySelector("[data-clear-location]").addEventListener("click", () => {
            pendingShotLocation = null;
            renderStatEntry();
          });
          ptsCell.querySelector("[data-toggle-dunk]").addEventListener("click", () => {
            pendingDunk = !pendingDunk;
            renderStatEntry();
          });
          ptsCell.querySelectorAll("button[data-shot-type]").forEach(b => {
            b.addEventListener("click", () => {
              pendingShotType = pendingShotType === b.dataset.shotType ? null : b.dataset.shotType;
              renderStatEntry();
            });
          });
        }
        if (!pendingScore.isMiss) {
          ptsCell.querySelector("[data-noassist]").addEventListener("click", () => {
            pendingAssist = null;
            renderStatEntry();
          });
          ptsCell.querySelectorAll("button[data-assist]").forEach(b => {
            b.addEventListener("click", () => {
              pendingAssist = pendingAssist === b.dataset.assist ? null : b.dataset.assist;
              renderStatEntry();
            });
          });
        } else {
          ptsCell.querySelector("[data-noblock]").addEventListener("click", () => {
            pendingBlocker = null;
            renderStatEntry();
          });
          ptsCell.querySelectorAll("button[data-block]").forEach(b => {
            b.addEventListener("click", () => {
              pendingBlocker = pendingBlocker === b.dataset.block ? null : b.dataset.block;
              renderStatEntry();
            });
          });
          ptsCell.querySelector("[data-live]").addEventListener("click", () => {
            pendingOutOfBounds = false;
            renderStatEntry();
          });
          ptsCell.querySelector("[data-oob]").addEventListener("click", () => {
            pendingOutOfBounds = true;
            pendingRebounder = null;
            renderStatEntry();
          });
          if (!pendingOutOfBounds) {
            ptsCell.querySelector("[data-norebound]").addEventListener("click", () => {
              pendingRebounder = null;
              renderStatEntry();
            });
            ptsCell.querySelectorAll("button[data-rebound]").forEach(b => {
              b.addEventListener("click", () => {
                pendingRebounder = pendingRebounder === b.dataset.rebound ? null : b.dataset.rebound;
                renderStatEntry();
              });
            });
          }
        }
        ptsCell.querySelector("[data-confirm]").addEventListener("click", () => {
          const scoreEventId = uid("score");
          game.scoringEvents.push({
            id: scoreEventId,
            scorerId: pid,
            points: pendingScore.points,
            made: !pendingScore.isMiss,
            defenderIds: [...pendingDefenders],
            assistId: pendingScore.isMiss ? null : pendingAssist,
            blockerId: pendingScore.isMiss ? pendingBlocker : null,
            turnoverEventId: null,
            rebounderId: pendingScore.isMiss && !pendingOutOfBounds ? pendingRebounder : null,
            shotLocation: pendingScore.points === 1 ? null : pendingShotLocation,
            dunk: pendingScore.points === 1 ? false : pendingDunk,
            shotType: pendingScore.points === 1 ? null : pendingShotType,
            videoTime: currentPlaybackTime()
          });
          if (pendingScore.isMiss && pendingOutOfBounds) {
            // Credit whoever forced it out, if known — the blocker if it was blocked, else the
            // lone defender if there was exactly one (with a double-team, it's ambiguous).
            const opponentId = pendingBlocker || (pendingDefenders.size === 1 ? [...pendingDefenders][0] : null);
            const tovId = uid("tov");
            game.turnoverEvents.push({ id: tovId, playerId: pid, opponentId, stealEventId: null, missEventId: scoreEventId, videoTime: currentPlaybackTime() });
            game.scoringEvents.find(e => e.id === scoreEventId).turnoverEventId = tovId;
          }
          pendingScore = null;
          pendingDefenders = new Set();
          pendingAssist = null;
          pendingBlocker = null;
          pendingOutOfBounds = false;
          pendingRebounder = null;
          pendingShotLocation = null;
          pendingDunk = false;
          pendingShotType = null;
          recomputeDerivedStats(game);
          saveState();
          renderStatEntry();
        });
        ptsCell.querySelector("[data-cancel]").addEventListener("click", () => {
          pendingScore = null;
          pendingDefenders = new Set();
          pendingAssist = null;
          pendingBlocker = null;
          pendingOutOfBounds = false;
          pendingRebounder = null;
          pendingShotLocation = null;
          pendingDunk = false;
          pendingShotType = null;
          renderStatEntry();
        });
      } else {
        ptsCell.innerHTML = `
          <div class="stat-label">PTS</div>
          <div class="stat-value">${s.pts}</div>
          <div class="stat-buttons">
            <button type="button" data-points="1">+1</button>
            <button type="button" data-points="2">+2</button>
            <button type="button" data-points="3">+3</button>
            <button type="button" data-undo="1">-</button>
          </div>
          <div class="stat-label" style="margin-top:4px">MISS</div>
          <div class="stat-buttons">
            <button type="button" class="secondary-btn" data-miss="1">1</button>
            <button type="button" class="secondary-btn" data-miss="2">2</button>
            <button type="button" class="secondary-btn" data-miss="3">3</button>
          </div>
        `;
        ptsCell.querySelectorAll("button[data-points]").forEach(b => {
          b.addEventListener("click", () => {
            pendingScore = { playerId: pid, points: parseInt(b.dataset.points, 10), isMiss: false };
            pendingDefenders = new Set();
            pendingAssist = null;
            pendingBlocker = null;
            pendingOutOfBounds = false;
            pendingRebounder = null;
            pendingShotLocation = null;
            pendingDunk = false;
            pendingShotType = null;
            renderStatEntry();
          });
        });
        ptsCell.querySelectorAll("button[data-miss]").forEach(b => {
          b.addEventListener("click", () => {
            pendingScore = { playerId: pid, points: parseInt(b.dataset.miss, 10), isMiss: true };
            pendingDefenders = new Set();
            pendingAssist = null;
            pendingBlocker = null;
            pendingOutOfBounds = false;
            pendingRebounder = null;
            pendingShotLocation = null;
            pendingDunk = false;
            pendingShotType = null;
            renderStatEntry();
          });
        });
        ptsCell.querySelector("[data-undo]").addEventListener("click", () => {
          for (let i = game.scoringEvents.length - 1; i >= 0; i--) {
            if (game.scoringEvents[i].scorerId === pid && game.scoringEvents[i].made !== false) {
              game.scoringEvents.splice(i, 1);
              break;
            }
          }
          recomputeDerivedStats(game);
          saveState();
          renderStatEntry();
        });
      }
      grid.appendChild(ptsCell);

      // AST/BLK/OREB/DREB are all derived from scoringEvents (assistId on makes, blockerId and
      // rebounderId on misses), not clicked directly — read-only here, same pattern as
      // PTS/TOV/STL/PF. There's no manual +1/- stat left; every box score number traces back to
      // a specific tagged shot.
      ["ast", "blk", "oreb", "dreb"].forEach(field => {
        const cell = document.createElement("div");
        cell.className = "stat-cell";
        cell.innerHTML = `<div class="stat-label">${STAT_LABELS[field]}</div><div class="stat-value">${s[field]}</div>`;
        grid.appendChild(cell);
      });

      TAGGED_STAT_CONFIG.forEach(cfg => {
        const cell = document.createElement("div");
        cell.className = "stat-cell";

        if (pendingTag && pendingTag.playerId === pid && pendingTag.kind === cfg.field) {
          const opponents = opponentIds.map(id => state.players.find(pl2 => pl2.id === id)).filter(Boolean);
          cell.classList.add("expanded");
          cell.innerHTML = `
            <div class="stat-label">${cfg.prompt}</div>
            <div class="defender-pick-list">
              ${cfg.requireOpponent ? "" : '<button type="button" class="secondary-btn" data-opp="">No one tagged</button>'}
              ${opponents.map(o => `<button type="button" class="secondary-btn" data-opp="${o.id}">${escapeHtml(o.name)}</button>`).join("")}
            </div>
            <button type="button" class="icon-btn" data-cancel="1">Cancel</button>
          `;
          cell.querySelectorAll("button[data-opp]").forEach(b => {
            b.addEventListener("click", () => {
              commitTaggedEvent(game, cfg, pid, b.dataset.opp || null);
              pendingTag = null;
              recomputeDerivedStats(game);
              saveState();
              renderStatEntry();
            });
          });
          cell.querySelector("[data-cancel]").addEventListener("click", () => {
            pendingTag = null;
            renderStatEntry();
          });
        } else {
          cell.innerHTML = `
            <div class="stat-label">${cfg.label}</div>
            <div class="stat-value">${s[cfg.field]}</div>
            <div class="stat-buttons">
              <button type="button" data-add="1">+1</button>
              <button type="button" data-undo="1">-</button>
            </div>
          `;
          cell.querySelector("[data-add]").addEventListener("click", () => {
            pendingTag = { playerId: pid, kind: cfg.field };
            renderStatEntry();
          });
          cell.querySelector("[data-undo]").addEventListener("click", () => {
            const arr = game[cfg.eventsKey];
            for (let i = arr.length - 1; i >= 0; i--) {
              if (arr[i].playerId === pid) { removeTaggedEvent(game, cfg, arr[i].id); break; }
            }
            recomputeDerivedStats(game);
            saveState();
            renderStatEntry();
          });
        }
        grid.appendChild(cell);
      });

      card.appendChild(grid);
      box.appendChild(card);
    });
    cols.appendChild(box);
  });
}

// Defensive numbers derived from scoringEvents.defenderIds — "beaten" only counts made
// shots against them; a contested miss is a stop, not a beaten defender. Opponent FG% is
// the shooting percentage of everyone this player was tagged as defending, contested or
// not (i.e. of Beaten + Stops) — a real per-defender shooting percentage allowed. A
// double-teamed shot counts fully against every tagged defender, not split between them —
// so these totals mean "shots this player was involved in defending," and summing them
// across all defenders in a game can exceed the game's actual points.
function gameDefenseStats(game, playerId) {
  const against = game.scoringEvents.filter(ev => (ev.defenderIds || []).includes(playerId));
  const madeAgainst = against.filter(ev => ev.made !== false);
  const timesBeaten = madeAgainst.length;
  const stops = against.filter(ev => ev.made === false).length;
  // Made 3s against, specifically -- needed for Opponent eFG% (see poolean-defensive-mirrors-
  // spec.md). Free throws are never tagged with a defender at all (see Stat Entry: the defender
  // picker only shows for a 2/3-point shot).
  const tpmAgainst = madeAgainst.filter(ev => ev.points === 3).length;
  // Blocks this player gets extra defensive credit for in defensiveRating(), beyond the Stop
  // credit above — only counted here when the block ISN'T also one of their own tagged Stops
  // already (the common case, since a shot-blocker is almost always also the tagged on-ball
  // defender). Crediting a blocked-and-tagged shot in both places would double-count one
  // defensive possession.
  const blocksNotAlreadyStopped = game.scoringEvents.filter(ev =>
    ev.blockerId === playerId && ev.made === false && !(ev.defenderIds || []).includes(playerId)
  ).length;
  return {
    ptsAllowed: madeAgainst.reduce((sum, ev) => sum + ev.points, 0),
    timesBeaten,
    stops,
    tpmAgainst,
    oppFgPct: pct(timesBeaten, timesBeaten + stops),
    blocksNotAlreadyStopped
  };
}

function defenderNames(defenderIds) {
  if (!defenderIds || defenderIds.length === 0) return "No defender";
  return defenderIds.map(id => {
    const p = state.players.find(pl => pl.id === id);
    return p ? escapeHtml(p.name) : "?";
  }).join(" + ");
}

// Same as defenderNames() but each name links to that player's page -- for HTML display only
// (defenderNames() itself stays plain text, since it also feeds the CSV export and sort keys).
function defenderNamesLinked(defenderIds) {
  if (!defenderIds || defenderIds.length === 0) return "No defender";
  return defenderIds.map(id => {
    const p = state.players.find(pl => pl.id === id);
    return p ? playerLink(p.id, p.name, false) : "?";
  }).join(" + ");
}

function playerLinksJoined(ids, sep = " + ") {
  return ids.map(id => {
    const p = state.players.find(pl => pl.id === id);
    return p ? playerLink(p.id, p.name, false) : "?";
  }).join(sep);
}

// `asRate` formats m/a to one decimal (per-20 rate values, e.g. "12.3/20.0 (61%)") instead of
// plain integers (raw counts, e.g. "8/13 (61%)") — same "m/a (pct%)" shape either way.
function formatShootingSplit(m, a, asRate = false) {
  return a > 0 ? `${asRate ? m.toFixed(1) : m}/${asRate ? a.toFixed(1) : a} (${pct(m, a)}%)` : "—";
}

function formatAstTov(ast, tov) {
  if (tov === 0) return ast === 0 ? "0.0" : "∞";
  return (ast / tov).toFixed(1);
}

// Hollinger's Game Score, minus its two defensive terms (STL and BLK) — the offense-only half
// of Two-Way Score. STL and BLK aren't dropped, just moved to defensiveRating() below, where
// they sit next to the rest of this player's defensive numbers instead of being buried in an
// otherwise-offensive formula.
function offensiveRating(s, sh) {
  return s.pts + 0.4 * sh.fgm - 0.7 * sh.fga - 0.4 * (sh.fta - sh.ftm)
    + 0.7 * s.oreb + 0.3 * s.dreb + 0.7 * s.ast - 0.4 * s.pf - s.tov;
}

// Off Rating's defensive counterpart: Stops/Beaten/Pts Allowed from the same per-shot defender
// tagging as before, plus STL and BLK pulled out of the old Game Score formula above. BLK only
// counts here via def.blocksNotAlreadyStopped — a block that's also one of this player's own
// tagged Stops already got its credit from the Stops term, so adding it again here would
// double-count that one defensive possession (which the old GmSc + Def Impact combination
// actually did, for every shot where the blocker was also the tagged defender). Stops and
// Beaten are weighted symmetrically at 1.0 (a stop denies a possession the same way STL is
// weighted at 1.0 too), Pts Allowed at 0.4 so a 3-point beat scores worse than a 2-point beat
// without double-penalizing the same possession the Beaten count already covers, and Opp FG%
// isn't its own term since it's just Beaten / (Beaten + Stops) — a separate term would
// double-count that. A player never tagged as a defender, with no steals or unstopped blocks,
// computes to exactly 0 — not a penalty for conservative tagging (per Ben's tag-only-when-clear
// policy).
function defensiveRating(s, def) {
  return s.stl + 0.7 * def.blocksNotAlreadyStopped + def.stops - def.timesBeaten - 0.4 * def.ptsAllowed;
}

function twoWayScore(s, sh, def) {
  return offensiveRating(s, sh) + defensiveRating(s, def);
}

// Poolean rule: "If one player has fouled three times in a single game, that player is
// ejected for the remainder of the game." PF is already derived from foulEvents — this just
// flags when a game's count has crossed that line, wherever PF is shown in a box score.
const FOUL_OUT_THRESHOLD = 3;
function foulCellHtml(pf) {
  return pf >= FOUL_OUT_THRESHOLD
    ? `${pf} <span class="badge badge-lowlight" title="${FOUL_OUT_THRESHOLD} fouls: ejected for the rest of this game">🚫 OUT</span>`
    : String(pf);
}

// Same {key, label, accessor} shape as LEADERBOARD_COLUMNS, sortable via the shared
// renderSortableHeader() — this table is one game's box score, not a season, so accessors read
// off a precomputed {player, team, s, def, sh, offRtg, twoWay} row instead of computeLeaderboard().
const GAME_STATS_COLUMNS = [
  { key: "player", label: "Player", accessor: r => r.player.name },
  { key: "team", label: "Team", accessor: r => r.team },
  { key: "pts", label: "PTS", accessor: r => r.s.pts },
  { key: "fg", label: "FG", accessor: r => r.sh.fga },
  { key: "tpt", label: "3PT", accessor: r => r.sh.tpa },
  { key: "ft", label: "FT", accessor: r => r.sh.fta },
  { key: "efg", label: "eFG%", accessor: r => effectiveFgPct(r.sh.fgm, r.sh.tpm, r.sh.fga) },
  { key: "ts", label: "TS%", accessor: r => trueShootingPct(r.s.pts, r.sh.fga, r.sh.fta) },
  { key: "oreb", label: "OREB", accessor: r => r.s.oreb },
  { key: "dreb", label: "DREB", accessor: r => r.s.dreb },
  { key: "ast", label: "AST", accessor: r => r.s.ast },
  { key: "stl", label: "STL", accessor: r => r.s.stl },
  { key: "blk", label: "BLK", accessor: r => r.s.blk },
  { key: "tov", label: "TOV", accessor: r => r.s.tov },
  { key: "atov", label: "A/TO", accessor: r => r.s.tov === 0 ? (r.s.ast === 0 ? 0 : Infinity) : r.s.ast / r.s.tov },
  { key: "pf", label: "PF", accessor: r => r.s.pf },
  { key: "ptsAllowed", label: "Pts Allowed", accessor: r => r.def.ptsAllowed },
  { key: "oppfg", label: "Opp FG%", accessor: r => r.def.oppFgPct },
  { key: "beaten", label: "Beaten", accessor: r => r.def.timesBeaten },
  { key: "stops", label: "Stops", accessor: r => r.def.stops },
  { key: "offrtg", label: "Off Rating", accessor: r => r.offRtg },
  { key: "twoway", label: "Two-Way", accessor: r => r.twoWay }
];
let gameStatsSort = { key: "pts", dir: "desc" };

function renderGameStatsTable(game) {
  const headerRow = document.getElementById("gameStatsHeaderRow");
  const body = document.getElementById("gameStatsTableBody");
  if (!body) return;
  renderSortableHeader(headerRow, GAME_STATS_COLUMNS, gameStatsSort, () => renderGameStatsTable(game));
  headerRow.firstElementChild.classList.add("sticky-col");
  body.innerHTML = "";
  const roster = [...game.teamA.map(id => ({ id, team: "A" })), ...game.teamB.map(id => ({ id, team: "B" }))];
  const rows = roster.map(({ id, team }) => {
    const player = state.players.find(pl => pl.id === id);
    if (!player) return null;
    const s = getOrCreatePlayerStats(game, id);
    const def = gameDefenseStats(game, id);
    const sh = shootingStats(game, id);
    return { player, team, s, def, sh, offRtg: offensiveRating(s, sh), twoWay: twoWayScore(s, sh, def) };
  }).filter(Boolean);
  if (rows.length === 0) {
    body.innerHTML = '<tr><td colspan="22" class="empty-state">No players assigned yet.</td></tr>';
    return;
  }
  const sortCol = GAME_STATS_COLUMNS.find(c => c.key === gameStatsSort.key);
  rows.sort((a, b) => compareForSort(sortCol.accessor(a), sortCol.accessor(b), gameStatsSort.dir));
  rows.forEach(r => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td class="sticky-col">${playerLink(r.player.id, r.player.name)}</td>
      <td>${r.team}</td>
      <td>${r.s.pts}</td>
      <td>${formatShootingSplit(r.sh.fgm, r.sh.fga)}</td>
      <td>${formatShootingSplit(r.sh.tpm, r.sh.tpa)}</td>
      <td>${formatShootingSplit(r.sh.ftm, r.sh.fta)}</td>
      <td>${formatPct(effectiveFgPct(r.sh.fgm, r.sh.tpm, r.sh.fga))}</td>
      <td>${formatPct(trueShootingPct(r.s.pts, r.sh.fga, r.sh.fta))}</td>
      <td>${r.s.oreb}</td>
      <td>${r.s.dreb}</td>
      <td>${r.s.ast}</td>
      <td>${r.s.stl}</td>
      <td>${r.s.blk}</td>
      <td>${r.s.tov}</td>
      <td>${formatAstTov(r.s.ast, r.s.tov)}</td>
      <td>${foulCellHtml(r.s.pf)}</td>
      <td>${r.def.ptsAllowed}</td>
      <td>${formatPct(r.def.oppFgPct)}</td>
      <td>${r.def.timesBeaten}</td>
      <td>${r.def.stops}</td>
      <td>${r.offRtg.toFixed(1)}</td>
      <td>${r.twoWay.toFixed(1)}</td>
    `;
    body.appendChild(tr);
  });
}

// ---- Highlight / lowlight reel ----
function formatTime(seconds) {
  const s = Math.max(0, Math.round(seconds));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, "0")}`;
}

function formatVideoTime(videoTime) {
  return videoTime === null || videoTime === undefined ? "—" : formatTime(videoTime);
}

// A logged event's own videoTime is the moment itself, not a lead-in -- jumping to it exactly
// starts playback right as the action is already happening. Shot Log/Other Events/Matchups pass
// their own raw event time through this before handing it to createJumpButton(), so Jump instead
// starts a few seconds ahead of the moment, same as every play/highlight already does (their own
// start is already videoTime-5 by construction; this gives the same lead-in to a plain logged
// event that has no separately-stored start of its own).
const JUMP_LEAD_SECONDS = 5;
function padJumpTime(videoTime) {
  return videoTime === null || videoTime === undefined ? videoTime : Math.max(0, videoTime - JUMP_LEAD_SECONDS);
}

// A small "▶ Jump" button for any logged event's timestamp — disabled when there's no video
// loaded right now, or the event predates timestamp capture and has no time to jump to. Scrolls
// the video into view on click, not just seeks/plays it — these buttons live in tables (Shot Log,
// Other Events, Matchups, the Reel) further down the page than the video player itself, so
// without the scroll, clicking "Jump" starts playback somewhere off-screen the user has to go
// find manually.
function createJumpButton(videoTime) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "secondary-btn";
  btn.textContent = "▶ Jump";
  btn.disabled = !currentVideoEl || videoTime === null || videoTime === undefined;
  btn.addEventListener("click", () => {
    if (!currentVideoEl || videoTime === null || videoTime === undefined) return;
    currentVideoEl.currentTime = videoTime;
    currentVideoEl.play();
    currentVideoEl.scrollIntoView({ behavior: "smooth", block: "center" });
  });
  return btn;
}

// A small companion to createJumpButton(), for the opposite direction: instead of seeking the
// video TO an event's own timestamp, this corrects the event's timestamp FROM the video's current
// position -- scrub to the real moment, click this, done. Exists because a logged videoTime isn't
// always right (see shot-arc/FINDINGS.md's own window-timing findings: it can land well off the
// real moment), and the only fix before this was deleting and re-logging the whole event just to
// change when it happened. `onSet` receives the new time and is responsible for actually writing
// it onto the real event object and re-rendering -- this button doesn't know that object's shape,
// since callers differ (a direct mutable reference in some tables, an id lookup in others).
function createEditTimeButton(onSet) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "icon-btn";
  btn.title = "Set this event's timestamp to the video's current playback position";
  btn.textContent = "✏️";
  btn.disabled = !currentVideoEl;
  btn.addEventListener("click", () => {
    if (!currentVideoEl) return;
    onSet(currentVideoEl.currentTime);
  });
  return btn;
}

function updateReelButtons() {
  const hBtn = document.getElementById("markHighlightBtn");
  const lBtn = document.getElementById("markLowlightBtn");
  if (!hBtn || !lBtn) return;
  const enabled = !!currentVideoEl;
  hBtn.disabled = !enabled;
  lBtn.disabled = !enabled;
}

// Auto-suggests candidate Highlight/Lowlight clips for the open game from stat signal that's
// already logged -- dunks, blocks, contested makes, deep 3s, steals, out-of-bounds turnovers, the
// game-winning shot -- instead of requiring someone to scrub the whole video by eye looking for
// moments worth clipping. Purely suggestions: nothing is added to game.plays until a real click,
// same 5-second pad either side of the event's own videoTime markPlay() already uses for a
// manually-marked clip. Only events with a real videoTime can be suggested at all; an
// already-added suggestion (a play of the same type, for the same player, within a few seconds of
// the same timestamp) is filtered back out so re-rendering never re-offers something just added.
function computeSuggestedPlays(game) {
  const suggestions = [];
  const alreadyAdded = (playerId, type, videoTime) => game.plays.some(p =>
    p.playerId === playerId && p.type === type && Math.abs((p.start + 5) - videoTime) < 3
  );
  const add = (playerId, type, videoTime, reason) => {
    if (!playerId || videoTime === null || videoTime === undefined) return;
    if (alreadyAdded(playerId, type, videoTime)) return;
    suggestions.push({ playerId, type, videoTime, reason });
  };

  game.scoringEvents.forEach(ev => {
    if (ev.dunk && ev.made !== false) add(ev.scorerId, "highlight", ev.videoTime, "Dunk");
    if (ev.dunk && ev.made === false) add(ev.scorerId, "lowlight", ev.videoTime, "Missed dunk attempt");
    if (ev.made !== false && (ev.defenderIds || []).length >= 2) {
      add(ev.scorerId, "highlight", ev.videoTime, `Contested make (${ev.defenderIds.length} defenders)`);
    }
    if (ev.blockerId) {
      add(ev.blockerId, "highlight", ev.videoTime, "Block");
      add(ev.scorerId, "lowlight", ev.videoTime, "Shot blocked");
    }
    if (ev.made !== false && ev.points === 3 && ev.shotLocation && shotBand(ev.shotLocation, 3) === "deep") {
      add(ev.scorerId, "highlight", ev.videoTime, "Deep 3");
    }
    // An out-of-bounds turnover was tried here too, but it's just a routine missed shot most of
    // the time -- not a real lowlight-worthy moment the way a blown dunk or getting blocked is,
    // so it was pure noise in this list rather than something worth clipping.
  });
  game.stealEvents.forEach(ev => add(ev.playerId, "highlight", ev.videoTime, "Steal"));
  const gws = gameWinningShot(game);
  if (gws) add(gws.scorerId, "highlight", gws.videoTime, "Game-winning bucket");

  suggestions.sort((a, b) => a.videoTime - b.videoTime);
  return suggestions;
}

function renderSuggestedPlays(game) {
  const wrap = document.getElementById("suggestedPlaysList");
  if (!wrap) return;
  const suggestions = computeSuggestedPlays(game);
  if (suggestions.length === 0) {
    wrap.innerHTML = '<p class="empty-state">Nothing suggested yet -- either nothing in this game\'s log fits, or every suggestion has already been added.</p>';
    return;
  }
  wrap.innerHTML = `<ul class="player-tips-list">${suggestions.map((s, i) => {
    const player = state.players.find(p => p.id === s.playerId);
    const icon = s.type === "highlight" ? "🔥" : "👎";
    const label = s.type === "highlight" ? "Add as Highlight" : "Add as Lowlight";
    return `<li>
      <span class="player-tip-icon">${icon}</span>
      <span>${escapeHtml(player ? player.name : "?")}: ${escapeHtml(s.reason)} (${formatTime(s.videoTime)})
      <div class="player-tip-watch" data-jump-index="${i}"><button type="button" class="icon-btn secondary-btn suggested-play-add-btn" data-index="${i}">${label}</button></div>
      </span>
    </li>`;
  }).join("")}</ul>`;
  // Reuses createJumpButton() as-is (same "▶ Jump" seek/play/scroll behavior the Shot Log/Other
  // Events tables already use) rather than a second jump mechanism -- this only ever renders for
  // the currently open game, so currentVideoEl is already the right video to seek.
  wrap.querySelectorAll(".player-tip-watch").forEach(div => {
    const s = suggestions[parseInt(div.dataset.jumpIndex, 10)];
    div.prepend(createJumpButton(s.videoTime));
  });
  wrap.querySelectorAll(".suggested-play-add-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const s = suggestions[parseInt(btn.dataset.index, 10)];
      game.plays.push({
        id: uid("play"),
        type: s.type,
        start: Math.max(0, s.videoTime - 5),
        end: s.videoTime + 5,
        playerId: s.playerId,
        note: s.reason
      });
      saveState();
      renderSuggestedPlays(game);
      renderReel(game);
    });
  });
}

function markPlay(type) {
  const game = state.games.find(g => g.id === currentGameId);
  if (!game || !currentVideoEl) return;
  const t = currentVideoEl.currentTime || 0;
  game.plays.push({
    id: uid("play"),
    type,
    start: Math.max(0, t - 5),
    end: t + 5,
    playerId: null,
    note: ""
  });
  saveState();
  renderReel(game);
}

document.getElementById("markHighlightBtn").addEventListener("click", () => markPlay("highlight"));
document.getElementById("markLowlightBtn").addEventListener("click", () => markPlay("lowlight"));

// null key = natural order (by clip start time, the same order this table has always opened
// with). Only a real column key overrides it.
const REEL_COLUMNS = [
  { key: "type", label: "Type", accessor: r => r.type },
  { key: "start", label: "Start", accessor: r => r.start },
  { key: "end", label: "End", accessor: r => r.end },
  { key: "player", label: "Player", accessor: r => r.playerName },
  { key: "note", label: "Note", accessor: r => r.note || "" }
];
let reelSort = { key: null, dir: "asc" };

function renderReel(game) {
  updateReelButtons();
  updateReelExportButton(game);
  const headerRow = document.getElementById("reelHeaderRow");
  const body = document.getElementById("reelTableBody");
  if (!body) return;
  renderSortableHeader(headerRow, REEL_COLUMNS, reelSort, () => renderReel(game));
  headerRow.appendChild(document.createElement("th"));
  headerRow.appendChild(document.createElement("th"));
  body.innerHTML = "";
  if (game.plays.length === 0) {
    body.innerHTML = '<tr><td colspan="7" class="empty-state">No clips marked yet.</td></tr>';
    return;
  }
  const gamePlayers = [...game.teamA, ...game.teamB].map(id => state.players.find(p => p.id === id)).filter(Boolean);

  let rows = game.plays.map(play => {
    const player = play.playerId ? state.players.find(p => p.id === play.playerId) : null;
    return { ...play, play, playerName: player ? player.name : "" };
  });
  if (reelSort.key === null) {
    rows.sort((a, b) => a.start - b.start);
  } else {
    const sortCol = REEL_COLUMNS.find(c => c.key === reelSort.key);
    rows.sort((a, b) => compareForSort(sortCol.accessor(a), sortCol.accessor(b), reelSort.dir));
  }
  rows.forEach(({ play }) => {
    const tr = document.createElement("tr");

    const typeTd = document.createElement("td");
    typeTd.innerHTML = play.type === "highlight"
      ? '<span class="badge badge-highlight">🔥 Highlight</span>'
      : '<span class="badge badge-lowlight">👎 Lowlight</span>';
    tr.appendChild(typeTd);

    const startTd = document.createElement("td");
    const startInput = document.createElement("input");
    startInput.type = "number";
    startInput.step = "0.5";
    startInput.min = "0";
    startInput.className = "reel-time-input";
    startInput.value = play.start.toFixed(1);
    startInput.title = formatTime(play.start);
    startInput.addEventListener("change", () => {
      play.start = Math.max(0, parseFloat(startInput.value) || 0);
      saveState();
    });
    startTd.appendChild(startInput);
    tr.appendChild(startTd);

    const endTd = document.createElement("td");
    const endInput = document.createElement("input");
    endInput.type = "number";
    endInput.step = "0.5";
    endInput.min = "0";
    endInput.className = "reel-time-input";
    endInput.value = play.end.toFixed(1);
    endInput.title = formatTime(play.end);
    endInput.addEventListener("change", () => {
      play.end = Math.max(play.start, parseFloat(endInput.value) || play.start);
      saveState();
    });
    endTd.appendChild(endInput);
    tr.appendChild(endTd);

    const playerTd = document.createElement("td");
    const playerSelect = document.createElement("select");
    playerSelect.innerHTML = `<option value="">—</option>` +
      gamePlayers.map(p => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join("");
    playerSelect.value = play.playerId || "";
    playerSelect.addEventListener("change", () => {
      play.playerId = playerSelect.value || null;
      saveState();
    });
    playerTd.appendChild(playerSelect);
    tr.appendChild(playerTd);

    const noteTd = document.createElement("td");
    const noteInput = document.createElement("input");
    noteInput.type = "text";
    noteInput.className = "reel-note-input";
    noteInput.placeholder = "Note";
    noteInput.value = play.note || "";
    noteInput.addEventListener("change", () => {
      play.note = noteInput.value.trim();
      saveState();
    });
    noteTd.appendChild(noteInput);
    tr.appendChild(noteTd);

    const jumpTd = document.createElement("td");
    jumpTd.appendChild(createJumpButton(play.start));
    tr.appendChild(jumpTd);

    const delTd = document.createElement("td");
    const delBtn = document.createElement("button");
    delBtn.type = "button";
    delBtn.className = "icon-btn";
    delBtn.textContent = "Remove";
    delBtn.addEventListener("click", () => {
      game.plays = game.plays.filter(pl => pl.id !== play.id);
      saveState();
      renderReel(game);
    });
    delTd.appendChild(delBtn);
    tr.appendChild(delTd);

    body.appendChild(tr);
  });
}
document.getElementById("reelChronoBtn").addEventListener("click", () => {
  reelSort = { key: null, dir: "asc" };
  const game = state.games.find(g => g.id === currentGameId);
  if (game) renderReel(game);
});

// ---- Combine Reel clips into one downloadable video ----
// Plays every clip in this game's Reel back-to-back through the already-loaded <video> element
// and records the playback live via MediaRecorder — entirely in-browser, no server, no external
// library, matching everything else in this tool. The real cost of that: it runs in real time (a
// 5-minute combined reel takes about 5 minutes to produce), and the tab has to stay open and the
// video actually playing — browsers throttle or drop captureStream() frames on a backgrounded
// tab. Output is .mp4 where the browser's MediaRecorder supports recording directly to it
// (recent Chrome/Edge), falling back to .webm otherwise (see pickRecorderMimeType()) — no
// transcoding step, no ffmpeg.wasm dependency, just recording straight to whichever container
// the browser will actually produce.
// { cancelled, cancelPromise } while an export is running; null otherwise. cancelPromise is
// racED against every step below (seeking, playing, waiting for a clip to end) so Cancel can
// actually break out of a stuck step, not just get checked between steps — a plain boolean flag
// alone can't interrupt an in-flight `await video.play()` that never settles.
let reelExportState = null;

// Always chronological by clip start time, regardless of whatever sort the Reel table is
// currently showing — the combined video should play in the order things actually happened, not
// in whatever column order someone happens to have the table sorted by. Degenerate clips
// (end <= start, shouldn't normally exist but a hand-edited start/end could produce one) are
// skipped rather than recorded as a zero-length freeze.
function reelClipsChronological(game) {
  return [...game.plays].filter(p => p.end > p.start).sort((a, b) => a.start - b.start);
}

function updateReelExportButton(game) {
  const btn = document.getElementById("exportReelVideoBtn");
  if (!btn) return;
  btn.disabled = !!reelExportState || !currentVideoEl || !game || reelClipsChronological(game).length === 0;
}

// MP4 first, WebM as a fallback for browsers that don't support recording directly to MP4 (older
// Chrome/Edge, most non-Chromium browsers) — MediaRecorder support for `video/mp4` output is
// newer and less universal than `video/webm`, so this has to stay a real fallback chain, not a
// hard switch. `pickRecorderExtension()` mirrors this list so a downloaded file's name always
// matches whichever container actually got recorded.
function pickRecorderMimeType() {
  const candidates = [
    "video/mp4;codecs=avc1,mp4a.40.2",
    "video/mp4;codecs=avc1",
    "video/mp4",
    "video/webm;codecs=vp9,opus",
    "video/webm;codecs=vp8,opus",
    "video/webm"
  ];
  return candidates.find(t => window.MediaRecorder && MediaRecorder.isTypeSupported(t)) || "";
}
function pickRecorderExtension(mimeType) {
  return mimeType.startsWith("video/mp4") ? "mp4" : "webm";
}

// Resolves once the video has actually reached `time`, not just once currentTime is set —
// seeking on a real (especially large local-file) video is asynchronous. Resolves "done" or,
// past `timeoutMs` with no "seeked" event at all (a real stall — a bad/out-of-range timestamp,
// a decoder hiccup, whatever the cause), "timeout" — this used to have no timeout at all, which
// left the whole export silently stuck on one clip forever with no way out except Cancel (which,
// from the outside, looks identical to it just being slow — there's no way to tell "still working"
// from "will never finish" without one).
function waitForSeek(video, time, timeoutMs = 15000) {
  return new Promise(resolve => {
    if (Math.abs(video.currentTime - time) < 0.05) { resolve("done"); return; }
    let settled = false;
    const onSeeked = () => {
      if (settled) return;
      settled = true;
      video.removeEventListener("seeked", onSeeked);
      clearTimeout(timeout);
      resolve("done");
    };
    video.addEventListener("seeked", onSeeked);
    video.currentTime = time;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      video.removeEventListener("seeked", onSeeked);
      resolve("timeout");
    }, timeoutMs);
  });
}

// Polls on a plain interval rather than requestAnimationFrame — rAF callbacks are suspended
// entirely (not just throttled) on a page that isn't actually visible, which would hang this
// forever if the tab gets backgrounded mid-export instead of just running late. `timeoutMs`
// guards the same "silently stuck forever" failure mode as waitForSeek above — real-time
// clip playback stalling (a buffering pause, a decode stall, `ended` never firing) used to hang
// the whole export on whatever clip it happened to, with the status line frozen and no way to
// tell that from it just taking a while. The caller sizes `timeoutMs` to the clip's own expected
// length plus real headroom, not a flat constant, so a normal slow clip doesn't trip a timeout
// meant for a genuinely stuck one.
function waitUntilTime(video, endTime, timeoutMs = 30000) {
  return new Promise(resolve => {
    let settled = false;
    const interval = setInterval(() => {
      if (settled) return;
      if (video.currentTime >= endTime || video.ended) {
        settled = true;
        clearInterval(interval);
        clearTimeout(timeout);
        resolve("done");
      }
    }, 50);
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      clearInterval(interval);
      resolve("timeout");
    }, timeoutMs);
  });
}

// Wraps a promise so a cancel click can interrupt it even mid-flight — a video.play() call that
// never settles (blocked autoplay policy, a stalled/buffering source, whatever the cause)
// otherwise leaves the whole export stuck with no way out except reloading the page. Passes the
// wrapped promise's own resolved value through unchanged (not flattened to a fixed "done") so a
// caller can tell "finished normally" apart from "timed out" for promises — like waitForSeek/
// waitUntilTime — that resolve with one or the other instead of always succeeding.
function raceCancel(promise, cancelPromise) {
  return Promise.race([promise, cancelPromise.then(() => "cancelled")]);
}

async function exportReelVideo(game) {
  if (!currentVideoEl || reelExportState) return;
  const clips = reelClipsChronological(game);
  if (clips.length === 0) return;
  const mimeType = pickRecorderMimeType();
  const statusEl = document.getElementById("reelExportStatus");
  if (!mimeType) {
    statusEl.textContent = "This browser doesn't support recording video. Try a recent Chrome or Firefox.";
    return;
  }

  const video = currentVideoEl;
  const originalTime = video.currentTime;
  const wasPaused = video.paused;
  const originalMuted = video.muted;
  // A muted <video> element's captured audio track is silent on Chrome even though the source
  // has real audio — unmute for the recording, restore afterward regardless of how it ends.
  video.muted = false;

  const stream = video.captureStream ? video.captureStream() : video.mozCaptureStream();
  const recorder = new MediaRecorder(stream, { mimeType });
  const chunks = [];
  recorder.ondataavailable = e => { if (e.data.size > 0) chunks.push(e.data); };

  let resolveCancel;
  const cancelPromise = new Promise(resolve => { resolveCancel = resolve; });
  reelExportState = { cancelled: false, resolveCancel };
  document.getElementById("exportReelVideoBtn").disabled = true;
  document.getElementById("cancelReelExportBtn").hidden = false;

  let stoppedEarly = null; // set to a user-facing reason if a step fails/times out mid-export

  // Started paused so only the actual clip playback — not the seeking/loading between clips —
  // ends up in the recording. pause()/resume() (not stop-and-restart) keeps it one continuous
  // MediaRecorder session, so the output is one seamless file rather than needing to be stitched
  // from several.
  recorder.start();
  recorder.pause();
  try {
    for (let i = 0; i < clips.length; i++) {
      if (reelExportState.cancelled) break;
      statusEl.textContent = `Recording clip ${i + 1} of ${clips.length}…`;

      const seekOutcome = await raceCancel(waitForSeek(video, clips[i].start), cancelPromise);
      if (seekOutcome === "cancelled") break;
      if (seekOutcome === "timeout") {
        stoppedEarly = `Clip ${i + 1} of ${clips.length} never finished seeking. Stopped there.`;
        break;
      }

      recorder.resume();
      const playPromise = video.play().catch(() => {}); // a rejected play() still resolves this race with "done" via .catch, handled by the timeout below if it never settles at all
      const playOutcome = await Promise.race([
        playPromise.then(() => "played"),
        cancelPromise.then(() => "cancelled"),
        new Promise(resolve => setTimeout(() => resolve("timeout"), 8000))
      ]);
      if (playOutcome !== "played") {
        recorder.pause();
        if (playOutcome === "cancelled") break;
        stoppedEarly = `Clip ${i + 1} of ${clips.length} didn't start playing. Stopped there.`;
        break;
      }

      // Timeout sized to this clip's own remaining length plus real headroom (3x it, floor
      // 15s) rather than a flat constant — a clip that's simply longer than most shouldn't trip
      // a timeout meant to catch actual stalls, but a genuinely stuck clip still gets caught
      // instead of hanging the whole export forever with the status line frozen.
      const remaining = Math.max(0, clips[i].end - video.currentTime);
      const waitOutcome = await raceCancel(waitUntilTime(video, clips[i].end, Math.max(15000, remaining * 3000)), cancelPromise);
      video.pause();
      recorder.pause();
      if (waitOutcome === "cancelled") break;
      if (waitOutcome === "timeout") {
        stoppedEarly = `Clip ${i + 1} of ${clips.length} stalled partway through. Stopped there.`;
        break;
      }
    }
  } finally {
    recorder.stop();
    await new Promise(resolve => { recorder.onstop = resolve; });
    video.muted = originalMuted;
    video.currentTime = originalTime;
    if (wasPaused) video.pause();
  }

  const cancelled = reelExportState.cancelled;
  reelExportState = null;
  document.getElementById("cancelReelExportBtn").hidden = true;
  updateReelExportButton(game);

  if (cancelled) {
    statusEl.textContent = "Cancelled. Nothing downloaded.";
  } else if (chunks.length === 0) {
    statusEl.textContent = stoppedEarly || "Recording produced no data. Try again.";
  } else {
    const blob = new Blob(chunks, { type: mimeType });
    download(`${game.date || "game"}-highlights.${pickRecorderExtension(mimeType)}`, blob, mimeType);
    const clipWord = clips.length === 1 ? "clip" : "clips";
    statusEl.textContent = stoppedEarly
      ? `${stoppedEarly} Downloaded what was recorded before that.`
      : `Done: ${clips.length} ${clipWord} combined and downloaded.`;
  }
}

document.getElementById("exportReelVideoBtn").addEventListener("click", () => {
  const game = state.games.find(g => g.id === currentGameId);
  if (game) exportReelVideo(game);
});
document.getElementById("cancelReelExportBtn").addEventListener("click", () => {
  if (reelExportState) {
    reelExportState.cancelled = true;
    reelExportState.resolveCancel();
  }
});

// ---- Matchups ----
function renderMatchupForm(game) {
  const defSel = document.getElementById("defenderSelect");
  const offSel = document.getElementById("offenderSelect");
  const gamePlayers = [...game.teamA, ...game.teamB]
    .map(id => state.players.find(p => p.id === id))
    .filter(Boolean);
  const optionsFor = (players) => players.map(p => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join("");
  defSel.innerHTML = optionsFor(gamePlayers);
  offSel.innerHTML = optionsFor(gamePlayers);
}

document.getElementById("addMatchupForm").addEventListener("submit", e => {
  e.preventDefault();
  const game = state.games.find(g => g.id === currentGameId);
  if (!game) return;
  const defenderId = document.getElementById("defenderSelect").value;
  const offenderId = document.getElementById("offenderSelect").value;
  const note = document.getElementById("matchupNoteInput").value.trim();
  if (!defenderId || !offenderId) return;
  game.matchups.push({ id: uid("matchup"), defenderId, offenderId, note, videoTime: currentPlaybackTime() });
  saveState();
  document.getElementById("matchupNoteInput").value = "";
  renderMatchupTable(game);
});

// null key = natural order (plain insertion order, the same order this table has always opened
// with — matchups aren't videoTime-sorted by default today). Only a real column key overrides it.
const MATCHUP_TABLE_COLUMNS = [
  { key: "defender", label: "Defender", accessor: r => r.defenderName },
  { key: "guarded", label: "Guarded", accessor: r => r.offenderName },
  { key: "note", label: "Note", accessor: r => r.m.note || "" },
  { key: "time", label: "Time", accessor: r => r.m.videoTime }
];
let matchupTableSort = { key: null, dir: "asc" };

function renderMatchupTable(game) {
  const headerRow = document.getElementById("matchupTableHeaderRow");
  const body = document.getElementById("matchupTableBody");
  renderSortableHeader(headerRow, MATCHUP_TABLE_COLUMNS, matchupTableSort, () => renderMatchupTable(game));
  headerRow.appendChild(document.createElement("th"));
  headerRow.appendChild(document.createElement("th"));
  headerRow.appendChild(document.createElement("th"));
  body.innerHTML = "";
  if (game.matchups.length === 0) {
    body.innerHTML = '<tr><td colspan="7" class="empty-state">No matchups recorded yet.</td></tr>';
    return;
  }
  let rows = game.matchups.map(m => {
    const defender = state.players.find(p => p.id === m.defenderId);
    const offender = state.players.find(p => p.id === m.offenderId);
    return { m, defenderName: defender ? defender.name : "?", offenderName: offender ? offender.name : "?" };
  });
  if (matchupTableSort.key !== null) {
    const sortCol = MATCHUP_TABLE_COLUMNS.find(c => c.key === matchupTableSort.key);
    rows.sort((a, b) => compareForSort(sortCol.accessor(a), sortCol.accessor(b), matchupTableSort.dir));
  }
  rows.forEach(({ m, defenderName, offenderName }) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${escapeHtml(defenderName)}</td>
      <td>${escapeHtml(offenderName)}</td>
      <td>${escapeHtml(m.note || "")}</td>
      <td>${formatVideoTime(m.videoTime)}</td>
    `;
    const tdJump = document.createElement("td");
    tdJump.appendChild(createJumpButton(padJumpTime(m.videoTime)));
    tr.appendChild(tdJump);
    const tdEdit = document.createElement("td");
    tdEdit.appendChild(createEditTimeButton(t => {
      m.videoTime = t;
      saveState();
      renderMatchupTable(game);
    }));
    tr.appendChild(tdEdit);
    const tdBtn = document.createElement("td");
    const delBtn = document.createElement("button");
    delBtn.className = "icon-btn";
    delBtn.textContent = "Remove";
    delBtn.addEventListener("click", () => {
      game.matchups = game.matchups.filter(mm => mm.id !== m.id);
      saveState();
      renderMatchupTable(game);
    });
    tdBtn.appendChild(delBtn);
    tr.appendChild(tdBtn);
    body.appendChild(tr);
  });
}
document.getElementById("matchupTableChronoBtn").addEventListener("click", () => {
  matchupTableSort = { key: null, dir: "asc" };
  const game = state.games.find(g => g.id === currentGameId);
  if (game) renderMatchupTable(game);
});

// ---------- Defensive Load (see poolean-defensive-load-spec.md) ----------
// Fills a real gap Def Rating can't: a shutdown defender the offense avoids attacking entirely
// looks statistically identical to someone who's just genuinely uninvolved on defense -- both
// just show up as "few shots tagged." Defensive Load measures how much defensive WORKLOAD a
// player is actually carrying, as a companion to Def Rating's own measure of how well they handle
// what they get. Never meant to replace Def Rating, or to be read on its own -- see
// describeDefensiveLoad() below, which is mandatory framing, not optional color commentary.
//
// Minimum total "expected fair share" (summed across every qualifying game) before this is shown
// at all -- gated on expected share rather than raw tagged count, since expected share is the
// more stable denominator: it reflects how much tagged team-defensive-possession volume actually
// existed while this player was on the roster, not just whether this specific player happened to
// get tagged a lot.
const DEFENSIVE_LOAD_MIN_SHARE = 8;

function computeDefensiveLoad(playerId) {
  const games = qualifyingGamesForPlayer(playerId);
  let taggedSum = 0, shareSum = 0;
  games.forEach(game => {
    const myTeam = game.teamA.includes(playerId) ? game.teamA : game.teamB;
    const oppTeam = game.teamA.includes(playerId) ? game.teamB : game.teamA;
    if (myTeam.length === 0) return;
    // Every opponent field-goal attempt with at least one tagged defender -- untagged shots are
    // deliberately excluded from this count entirely, not just from this player's own numerator.
    // Tested including them: it systematically drags EVERY player's ratio below 1.0, a pure data
    // artifact (untagged shots dilute everyone's expected share equally and say nothing about how
    // the tagged defensive load was actually distributed), not a real finding. Do not "fix" this
    // by folding untagged shots back into the denominator -- that reintroduces the exact bug this
    // formula was deliberately built to avoid.
    const taggedOppFga = game.scoringEvents.filter(ev =>
      oppTeam.includes(ev.scorerId) && (ev.points === 2 || ev.points === 3) && (ev.defenderIds || []).length > 0
    );
    if (taggedOppFga.length === 0) return;
    shareSum += taggedOppFga.length / myTeam.length;
    taggedSum += taggedOppFga.filter(ev => ev.defenderIds.includes(playerId)).length;
  });
  if (shareSum < DEFENSIVE_LOAD_MIN_SHARE) return null;
  return taggedSum / shareSum;
}

// Mandatory interpretive framing, not optional color commentary -- a low Defensive Load is
// genuinely ambiguous (avoided as a tough matchup, genuinely uninvolved for other reasons, or
// just too small a sample) and this stat should never be shown without naming that ambiguity and
// pairing it with the same player's own Opp FG% (leading) and Def Rating/20 (secondary context).
// Opp FG% leads deliberately, not Def Rating: Opp FG% means exactly one thing (shooting
// percentage on the shots this player actually defended) and needs no trust in a formula's
// weights, where Def Rating blends Stops/Beaten/Pts Allowed under weights that were never
// validated against real outcomes (a properly regression-fit set looked meaningfully different
// from the assumed GmSc-derived ones). This still can't fully separate "avoided out of respect"
// from "genuinely uninvolved," and can't account for scheme (a player deliberately assigned to a
// team's weakest scorer shows a low load through no fault or credit of their own) -- a signal
// worth investigating further, never a standalone verdict.
const DEFENSIVE_LOAD_LOW = 0.8;
const DEFENSIVE_LOAD_HIGH = 1.2;

function describeDefensiveLoad(load, oppFgPct, leagueAvgOppFg) {
  if (load === null || load === undefined || oppFgPct === null || leagueAvgOppFg === null) return "";
  const low = oppFgPct < leagueAvgOppFg;
  if (load < DEFENSIVE_LOAD_LOW) {
    return low
      ? "Faces few shots, and stops them well: possibly avoided as a tough matchup."
      : "Faces few shots: not enough data to say whether this is a strength or just low defensive involvement.";
  }
  if (load > DEFENSIVE_LOAD_HIGH) {
    return low
      ? "Takes on a heavy share of the defensive workload and handles it well: a real two-way contributor, not just efficient in a light role."
      : "Takes on a heavy defensive workload but is being scored on: likely a tough or heavily-targeted matchup.";
  }
  return "Faces a roughly even share of the team's tagged defensive workload.";
}

// Short version of describeDefensiveLoad(), for contexts too dense for the full sentence (the
// Leaderboard's own Def Load column) -- still shown inline with the number itself, never hidden
// behind a hover, since the spec this implements is explicit that the framing has to ship WITH
// the number, not as an afterthought. The full sentence still lives in Player Detail and in this
// column's own tooltip.
function defensiveLoadShortTag(load, oppFgPct, leagueAvgOppFg) {
  if (load === null || load === undefined || oppFgPct === null || leagueAvgOppFg === null) return "";
  const low = oppFgPct < leagueAvgOppFg;
  if (load < DEFENSIVE_LOAD_LOW) return low ? "possibly avoided" : "low involvement, unclear";
  if (load > DEFENSIVE_LOAD_HIGH) return low ? "heavy & effective" : "heavy & targeted";
  return "even share";
}

// League-average Opp FG% among every qualifying player, the baseline describeDefensiveLoad()/
// defensiveLoadShortTag() compare a given player's own Opp FG% against -- same "compare to the
// league, not a fixed constant" convention Areas to Work On and the Personalized Tips already use
// elsewhere, rather than an arbitrary hardcoded percentage.
function computeLeagueAvgOppFg(board) {
  const vals = board.map(r => pct(r.defense.timesBeaten, r.defense.timesBeaten + r.defense.stops)).filter(v => v !== null);
  return vals.length > 0 ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
}

// ---------- Leaderboard ----------
// Cached the same way, and for the same reason, as computeWinSharesWeights() above: a single
// Leaderboard (or Player Detail) render calls this dozens of times over -- once per panel that
// needs the board, not once total -- and it's real work per call (every player's full season
// across every qualifying game). Measured real impact: recomputing on every call made a single
// Leaderboard render take 16 seconds; caching it (plus Win Shares' own cache above) brought that
// down to a real fraction of a second. Invalidated by saveState() (a real edit changes the
// underlying data) and forced fresh once per render pass by renderLeaderboard()/renderPlayerDetail
// themselves (see there) -- every caller within the same pass reuses the one real computation
// instead of silently working from data that's gone stale mid-edit.
let leaderboardCache = null;
function computeLeaderboard() {
  if (leaderboardCache !== null) return leaderboardCache;
  leaderboardCache = computeLeaderboardUncached();
  return leaderboardCache;
}

function computeLeaderboardUncached() {
  // Computed once, not once per player -- computeLeagueZonePointsPerAttempt() is a league-wide
  // constant that doesn't depend on which player is being looked at, so calling it fresh inside
  // the per-player map below (once for every one of ~20 players) would redo the exact same
  // full-league scan 20 times over for no reason.
  const zonePpa = computeLeagueZonePointsPerAttempt();
  // Same one-time-not-per-player reasoning as zonePpa above: the regression is fit once against
  // the whole league's current player-games, not refit fresh for each player being scored by it.
  const winSharesWeights = computeWinSharesWeights();
  return state.players.map(p => {
    // Only games actually logged with real shots count toward GP/averages — a game that's
    // just been rostered (or only carries a historical winner imported with no shot-level
    // detail, see playerGameResult()) has nothing to average, and counting it would drag
    // every average toward 0 for a game nobody has reviewed yet. qualifyingGamesForPlayer()
    // also excludes an imbalanced (e.g. 3-on-2) game unless includeImbalancedGames is toggled
    // on, and this player's own statistical outlier games if Exclude Outlier Games is on.
    const gamesPlayed = qualifyingGamesForPlayer(p.id);
    const totals = { pts: 0, oreb: 0, dreb: 0, ast: 0, stl: 0, blk: 0, tov: 0, pf: 0 };
    const shooting = { fgm: 0, fga: 0, tpm: 0, tpa: 0, closeM: 0, closeA: 0, midM: 0, midA: 0, tpArcM: 0, tpArcA: 0, tpDeepM: 0, tpDeepA: 0, ftm: 0, fta: 0, dunkM: 0, dunkA: 0 };
    const defense = { ptsAllowed: 0, timesBeaten: 0, stops: 0, tpmAgainst: 0, blocksNotAlreadyStopped: 0 };
    let wins = 0, losses = 0, ties = 0, combinedPoints = 0, teamFgaTotal = 0, teamAstTotal = 0, orebPoolTotal = 0, drebPoolTotal = 0;
    gamesPlayed.forEach(g => {
      const s = g.stats.find(st => st.playerId === p.id);
      if (s) STAT_FIELDS.forEach(f => totals[f] += s[f]);
      const sh = shootingStats(g, p.id);
      Object.keys(shooting).forEach(k => shooting[k] += sh[k]);
      const def = gameDefenseStats(g, p.id);
      defense.ptsAllowed += def.ptsAllowed;
      defense.timesBeaten += def.timesBeaten;
      defense.stops += def.stops;
      defense.tpmAgainst += def.tpmAgainst;
      defense.blocksNotAlreadyStopped += def.blocksNotAlreadyStopped;
      combinedPoints += gameTotalPoints(g);
      // Shot%/AST% denominators: this player's own team's total in this game (themselves
      // included), so "what share of the team's shots/assists were theirs" — not the league's,
      // since a team's own diet in each category is the meaningful comparison for who's actually
      // doing it on a given night.
      const myTeam = g.teamA.includes(p.id) ? g.teamA : g.teamB;
      const oppTeam = g.teamA.includes(p.id) ? g.teamB : g.teamA;
      teamFgaTotal += myTeam.reduce((sum, id) => sum + shootingStats(g, id).fga, 0);
      teamAstTotal += myTeam.reduce((sum, id) => { const ts = g.stats.find(st => st.playerId === id); return sum + (ts ? ts.ast : 0); }, 0);
      // OREB%/DREB% denominators: the real "available rebounds" pool a rebound percentage is
      // supposed to be measured against — both teams' rebounds on that category of miss, not
      // just this player's own team (unlike Shot%/AST% above, since a rebound is contested
      // between both teams on the floor, not a stat only one side can produce). Normally this
      // needs minutes played to scope it to when a player was actually on the floor, which this
      // tool doesn't track — but Poolean has no substitutions, so anyone rostered for a game is
      // on the floor for the whole thing, and that term drops out on its own.
      const teamOreb = myTeam.reduce((sum, id) => { const ts = g.stats.find(st => st.playerId === id); return sum + (ts ? ts.oreb : 0); }, 0);
      const teamDreb = myTeam.reduce((sum, id) => { const ts = g.stats.find(st => st.playerId === id); return sum + (ts ? ts.dreb : 0); }, 0);
      const oppOreb = oppTeam.reduce((sum, id) => { const ts = g.stats.find(st => st.playerId === id); return sum + (ts ? ts.oreb : 0); }, 0);
      const oppDreb = oppTeam.reduce((sum, id) => { const ts = g.stats.find(st => st.playerId === id); return sum + (ts ? ts.dreb : 0); }, 0);
      orebPoolTotal += teamOreb + oppDreb;
      drebPoolTotal += teamDreb + oppOreb;
      const result = playerGameResult(g, p.id);
      if (result === "W") wins++;
      else if (result === "L") losses++;
      else if (result === "T") ties++;
    });
    const gp = gamesPlayed.length;
    // Both are linear combinations of raw counts, so the season total equals the sum of each
    // game's value — computing once on the summed totals gives the same result as summing
    // per-game numbers would.
    const totalOffRating = offensiveRating(totals, shooting);
    const totalTwoWay = totalOffRating + defensiveRating(totals, defense);
    // Every counting stat on the Leaderboard is a rate per 20 combined points scored in the
    // game, not a per-game average — games are capped at different totals (16 or 21), so a
    // player who mostly plays 16-point games isn't fairly compared to one who mostly plays
    // 21s by a plain per-game average. The combined final score stands in for "how much game
    // happened," since possessions aren't tracked. This is the same reasoning PTS/20 and
    // Off Rating/20 always used, just applied uniformly instead of singling those two out.
    const per20 = value => combinedPoints > 0 ? (value / combinedPoints) * 20 : 0;
    const rate = {};
    STAT_FIELDS.forEach(f => { rate[f] = per20(totals[f]); });
    const rateShooting = {};
    Object.keys(shooting).forEach(k => { rateShooting[k] = per20(shooting[k]); });
    const rateDefense = {
      ptsAllowed: per20(defense.ptsAllowed),
      timesBeaten: per20(defense.timesBeaten),
      stops: per20(defense.stops),
      blocksNotAlreadyStopped: per20(defense.blocksNotAlreadyStopped)
    };
    // Last 5 games (by date, not insertion order), same per-20 math as the season — a quick
    // "how are they trending lately" read next to the season number, not a separate stat family.
    // Fewer than 5 games played just means fewer games in the window, not a blank/"—" — the
    // comparison still means something with 2-3 games, just noisier.
    const last5Games = [...gamesPlayed].sort((a, b) => (b.date || "").localeCompare(a.date || "")).slice(0, 5);
    const last5 = computeRateSummaryForGames(p.id, last5Games);
    const seasonOffRatingPer20 = per20(totalOffRating);
    const last5Delta = last5.gp > 0 ? last5.offRatingPer20 - seasonOffRatingPer20 : null;
    // ±0.5 counts as flat rather than a real trend — otherwise a 0.1 wobble reads as a signal.
    // "●" for flat, not "-"/"–" — a dash next to a number reads as a minus sign, not "no change."
    const last5Trend = last5Delta === null ? "" : last5Delta > 0.5 ? "▲" : last5Delta < -0.5 ? "▼" : "●";
    return {
      player: p, gp, totals, shooting, defense, rate, rateShooting, rateDefense,
      wins, losses, ties,
      winPct: (wins + losses) > 0 ? pct(wins, wins + losses) : null,
      offRatingPer20: seasonOffRatingPer20,
      twoWayPer20: per20(totalTwoWay),
      // Season-long sums, not per-20 rates — for the rare comparison (MVP) where "played a lot
      // and contributed a lot" should outweigh a slightly higher rate over fewer games.
      offRatingTotal: totalOffRating,
      twoWayTotal: totalTwoWay,
      stocks: totals.stl + totals.blk,
      dunks: shooting.dunkM,
      dunkPct: pct(shooting.dunkA, shooting.fga),
      defensiveLoad: computeDefensiveLoad(p.id),
      expectedPoints: computeExpectedPoints(p.id, zonePpa),
      expectedPointsAgainst: computeExpectedPointsAgainst(p.id, zonePpa),
      shotCreation: computeShotCreationRate(p.id),
      pointsOffTakeaways: computePointsOffTakeaways(p.id),
      turnoverCredit: computeTurnoverCreditRate(p.id),
      shotAttemptDiff: computeShotAttemptDifferential(p.id),
      reboundDiff: computeReboundDifferential(p.id),
      paceAndPpp: computePaceAndPpp(p.id),
      winShares: computeWinShares(p.id, winSharesWeights),
      shotPct: pct(shooting.fga, teamFgaTotal),
      astPct: pct(totals.ast, teamAstTotal),
      orebPct: pct(totals.oreb, orebPoolTotal),
      drebPct: pct(totals.dreb, drebPoolTotal),
      trebPct: pct(totals.oreb + totals.dreb, orebPoolTotal + drebPoolTotal),
      tovPct: turnoverPct(totals.tov, shooting.fga, shooting.fta),
      astTov: formatAstTov(totals.ast, totals.tov),
      last5Gp: last5.gp, last5OffRatingPer20: last5.offRatingPer20, last5TwoWayPer20: last5.twoWayPer20, last5Trend
    };
  });
}

// A standalone ranking for one of the real MVP ballot's own criteria — how much a player's
// night-to-night performance actually varies, not just their average level of it. Season-long
// Two-Way total (`twoWayTotal` in `computeLeaderboard()`, already the closest tracked comparison
// to the real historical MVP award — see AWARD_RESULTS) already covers "impact, volume
// included"; this is a different question — standard deviation of their own per-game
// Two-Way/20 (same numbers computeTwoWayTrend()'s own chart plots) — lower means steadier output
// game to game, not necessarily better output; a player who's reliably average every night reads
// as more "consistent" here than a boom-or-bust one who's spectacular half the time and poor the
// other half, even if their season averages land the same. Requires at least 2 qualifying games —
// a single game has no variance to measure, and showing 0.0 for it would misleadingly read as
// "perfectly consistent" rather than "not enough data yet."
function computeConsistencyStandings() {
  const board = computeLeaderboard().filter(r => r.gp >= 2);
  return board.map(r => {
    const values = computeTwoWayTrend(r.player.id).points.map(p => p.value);
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const variance = values.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / values.length;
    return { player: r.player, gp: r.gp, twoWayPer20: r.twoWayPer20, stdDev: Math.sqrt(variance) };
  }).sort((a, b) => a.stdDev - b.stdDev);
}
function renderConsistencyStandings() {
  const wrap = document.getElementById("consistencyStandings");
  if (!wrap) return;
  const rows = computeConsistencyStandings();
  if (rows.length === 0) {
    wrap.innerHTML = '<p class="empty-state">Nobody has 2+ qualifying games yet.</p>';
    return;
  }
  const rowsHtml = rows.map((r, i) => `<tr>
    <td>${i + 1}</td>
    <td><button type="button" class="icon-btn consistency-player-btn" style="color:var(--accent);font-weight:700" data-player-id="${r.player.id}">${escapeHtml(r.player.name)}</button></td>
    <td>${r.stdDev.toFixed(1)}</td>
    <td>${r.twoWayPer20.toFixed(1)}</td>
    <td>${r.gp}</td>
  </tr>`).join("");
  wrap.innerHTML = `
    <div class="table-scroll">
      <table class="matchup-table">
        <thead><tr><th>#</th><th>Player</th><th>Two-Way Std Dev</th><th>Two-Way/20</th><th>GP</th></tr></thead>
        <tbody>${rowsHtml}</tbody>
      </table>
    </div>
  `;
  wrap.querySelectorAll(".consistency-player-btn").forEach(btn => {
    btn.addEventListener("click", () => openPlayerDetail(btn.dataset.playerId));
  });
}

// Every passer-to-scorer connection, directional — Alice assisting Bob is tracked separately
// from Bob assisting Alice. A real chemistry signal straight from the Shot Log's assist tags,
// unlike win/loss (which the real Poolean site already tracks per duo).
function computeAssistConnections() {
  const totals = {}; // "passerId|scorerId" -> count
  state.games.filter(isQualifyingGame).forEach(g => {
    g.scoringEvents.forEach(ev => {
      if (!ev.assistId || ev.made === false) return;
      const key = `${ev.assistId}|${ev.scorerId}`;
      totals[key] = (totals[key] || 0) + 1;
    });
  });
  return Object.entries(totals).map(([key, count]) => {
    const [passerId, scorerId] = key.split("|");
    return {
      passer: state.players.find(p => p.id === passerId),
      scorer: state.players.find(p => p.id === scorerId),
      count
    };
  }).filter(r => r.passer && r.scorer).sort((a, b) => b.count - a.count);
}

// The shot that actually brought the winning team to their final score — the real
// game-ending basket in a race-to-a-target format, not just "scored late." Only credited when
// the shot in question has a real video timestamp: without one, "last in array order" isn't
// trustworthy enough to call a specific shot the game-winner, since edits/backfill workflows
// don't guarantee insertion order matches game order. A tied game has no winner and therefore
// no winning shot.
function gameWinningShot(game) {
  if (!isQualifyingGame(game)) return null;
  const scoreA = teamScore(game, game.teamA);
  const scoreB = teamScore(game, game.teamB);
  if (scoreA === scoreB) return null;
  const winningTeam = scoreA > scoreB ? game.teamA : game.teamB;
  const makes = game.scoringEvents.filter(ev => ev.made !== false);
  if (makes.length === 0) return null;
  // Only trust the ordering when *every* make in the game has a real timestamp — a single
  // untimed shot could have happened at any point in the game, early or late, so a partial set
  // of timestamps can't reliably say which specific shot actually came last.
  if (makes.some(ev => ev.videoTime === null || ev.videoTime === undefined)) return null;
  const last = [...makes].sort((a, b) => a.videoTime - b.videoTime)[makes.length - 1];
  return winningTeam.includes(last.scorerId) ? last : null;
}

// Season count of game-winning buckets per player — a discrete "big moment" tally, not a per-20
// rate, since a rate would round a rare, memorable thing down to an unreadable decimal. Kept in
// its own panel (like Out-of-Bounds Misses) rather than as a Leaderboard column.
function computeGameWinningBuckets() {
  const totals = {};
  state.games.forEach(game => {
    const shot = gameWinningShot(game);
    if (shot) totals[shot.scorerId] = (totals[shot.scorerId] || 0) + 1;
  });
  return Object.entries(totals)
    .map(([playerId, count]) => ({ player: state.players.find(p => p.id === playerId), count }))
    .filter(r => r.player)
    .sort((a, b) => b.count - a.count);
}

function renderGameWinningBucketsPanel() {
  const body = document.getElementById("gameWinningBucketsBody");
  if (!body) return;
  const rows = computeGameWinningBuckets();
  body.innerHTML = rows.length === 0
    ? '<tr><td colspan="2" class="empty-state">No game-winning buckets identified yet. Needs a timestamped make that closes out a decided game.</td></tr>'
    : rows.map(r => `<tr><td>${playerLink(r.player.id, r.player.name)}</td><td>${r.count}</td></tr>`).join("");
}

// League-wide Defensive Load table (see computeDefensiveLoad()/describeDefensiveLoad() above) --
// its own panel rather than one more cramped column on the giant Season Rates table, since the
// spec's own mandatory framing sentence needs real room, not a truncated tag.
function computeDefensiveLoadPanelRows() {
  const board = computeLeaderboard();
  const leagueAvgOppFg = computeLeagueAvgOppFg(board);
  return board
    .filter(r => r.defensiveLoad !== null)
    .map(r => {
      const oppFgPct = pct(r.defense.timesBeaten, r.defense.timesBeaten + r.defense.stops);
      const defRtg = defensiveRating(r.rate, r.rateDefense);
      return {
        player: r.player, load: r.defensiveLoad, oppFgPct, defRtg,
        sentence: describeDefensiveLoad(r.defensiveLoad, oppFgPct, leagueAvgOppFg),
        // Own gate (10+ tagged defended shots, see computeExpectedPointsAgainst), separate from
        // Defensive Load's own (8+ expected tagged possessions) -- a player can clear one without
        // the other, so this is nullable here even for a row that otherwise has a real Def Load.
        pointsAllowedUnderExpected: r.expectedPointsAgainst ? r.expectedPointsAgainst.pointsAllowedUnderExpected : null,
      };
    });
}

const DEFENSIVE_LOAD_COLUMNS = [
  { key: "player", label: "Player", accessor: r => r.player.name },
  { key: "load", label: "Def Load", accessor: r => r.load, display: r => `${r.load.toFixed(2)}x` },
  { key: "oppfg", label: "Opp FG%", accessor: r => r.oppFgPct, display: r => formatPct(r.oppFgPct) },
  { key: "defrtg", label: "Def Rating/20", accessor: r => r.defRtg, display: r => r.defRtg.toFixed(1) },
  {
    key: "xpa", label: "Pts Allowed Under Exp",
    accessor: r => r.pointsAllowedUnderExpected,
    display: r => r.pointsAllowedUnderExpected === null ? "—" : `${r.pointsAllowedUnderExpected >= 0 ? "+" : ""}${r.pointsAllowedUnderExpected.toFixed(1)}`,
  },
  { key: "read", label: "Read", accessor: r => r.sentence },
];
let defensiveLoadPanelSort = { key: "load", dir: "desc" };

function renderDefensiveLoadPanel() {
  const headerRow = document.getElementById("defensiveLoadPanelHeaderRow");
  const body = document.getElementById("defensiveLoadPanelBody");
  if (!body) return;
  renderSortableHeader(headerRow, DEFENSIVE_LOAD_COLUMNS, defensiveLoadPanelSort, renderDefensiveLoadPanel);
  const rows = computeDefensiveLoadPanelRows();
  if (rows.length === 0) {
    body.innerHTML = `<tr><td colspan="6" class="empty-state">Nobody has enough tagged defensive volume yet (needs ${DEFENSIVE_LOAD_MIN_SHARE}+ expected tagged possessions across enough games).</td></tr>`;
    return;
  }
  const sortCol = DEFENSIVE_LOAD_COLUMNS.find(c => c.key === defensiveLoadPanelSort.key);
  rows.sort((a, b) => compareForSort(sortCol.accessor(a), sortCol.accessor(b), defensiveLoadPanelSort.dir));
  body.innerHTML = rows.map(r => `<tr>
    <td><button type="button" class="icon-btn defload-player-btn" data-player-id="${r.player.id}" style="padding:0;font-weight:700;color:var(--accent)">${escapeHtml(r.player.name)}</button></td>
    <td>${r.load.toFixed(2)}x</td>
    <td>${formatPct(r.oppFgPct)}</td>
    <td>${r.defRtg.toFixed(1)}</td>
    <td>${r.pointsAllowedUnderExpected === null ? "—" : `${r.pointsAllowedUnderExpected >= 0 ? "+" : ""}${r.pointsAllowedUnderExpected.toFixed(1)}`}</td>
    <td>${escapeHtml(r.sentence)}</td>
  </tr>`).join("");
  body.querySelectorAll(".defload-player-btn").forEach(btn => {
    btn.addEventListener("click", () => openPlayerDetail(btn.dataset.playerId));
  });
}

// Close-Game Shooting — a margin-aware alternative to Game-Winning Buckets for the Clutch
// comparison above. GWB is explicitly non-scarce by construction (see the comment on
// gameWinningShot()): the last basket of every decided game is, by definition, the winner's, so
// it measures "who tends to close games out" rather than performance under real pressure. This
// instead looks at shooting efficiency specifically in games that actually finished close — TS%
// across every attempt in a game decided by the calibrated close-game margin or fewer. Tied games
// count here (a tie is the closest a game can finish) even though a tie has no "winning shot" for
// GWB to credit. Single adjustable constant, same provisional-not-a-setting pattern as every
// other threshold on this page — 5 points is a starting guess against Poolean's 16/21-point
// targets, not a value backed by a real season's worth of margin data yet.

function computeCloseGameShooting() {
  const closeGames = state.games.filter(g => {
    if (!isQualifyingGame(g)) return false;
    return Math.abs(teamScore(g, g.teamA) - teamScore(g, g.teamB)) <= clutchMarginThreshold();
  });
  const totals = {}; // playerId -> { pts, fga, fta, gp }
  closeGames.forEach(game => {
    [...game.teamA, ...game.teamB].forEach(playerId => {
      const sh = shootingStats(game, playerId);
      if (sh.fga + sh.fta === 0) return;
      const s = getOrCreatePlayerStats(game, playerId);
      const t = totals[playerId] = totals[playerId] || { pts: 0, fga: 0, fta: 0, gp: 0 };
      t.pts += s.pts;
      t.fga += sh.fga;
      t.fta += sh.fta;
      t.gp++;
    });
  });
  return Object.entries(totals)
    .map(([playerId, v]) => ({
      player: state.players.find(p => p.id === playerId),
      gp: v.gp,
      attempts: v.fga + v.fta,
      ts: trueShootingPct(v.pts, v.fga, v.fta)
    }))
    .filter(r => r.player && r.ts !== null);
}

const CLOSE_GAME_SHOOTING_COLUMNS = [
  { key: "player", label: "Player", accessor: r => r.player.name },
  { key: "gp", label: "Close Games", accessor: r => r.gp },
  { key: "attempts", label: "FGA+FTA", accessor: r => r.attempts },
  { key: "ts", label: "TS%", accessor: r => r.ts }
];
let closeGameShootingSort = { key: "ts", dir: "desc" };

function renderCloseGameShootingPanel() {
  const headerRow = document.getElementById("closeGameShootingHeaderRow");
  if (!headerRow) return;
  renderSortableHeader(headerRow, CLOSE_GAME_SHOOTING_COLUMNS, closeGameShootingSort, renderCloseGameShootingPanel);
  const body = document.getElementById("closeGameShootingBody");
  const rows = computeCloseGameShooting();
  const sortCol = CLOSE_GAME_SHOOTING_COLUMNS.find(c => c.key === closeGameShootingSort.key);
  rows.sort((a, b) => compareForSort(sortCol.accessor(a), sortCol.accessor(b), closeGameShootingSort.dir));
  body.innerHTML = rows.length === 0
    ? `<tr><td colspan="4" class="empty-state">No games decided by ${clutchMarginThreshold()} points or fewer yet.</td></tr>`
    : rows.map(r => `<tr><td>${playerLink(r.player.id, r.player.name)}</td><td>${r.gp}</td><td>${r.attempts}</td><td>${formatPct(r.ts)}</td></tr>`).join("");
}

// ---------- Close-Game Defense (see poolean-defensive-mirrors-spec.md) ----------
// Direct mirror of Close-Game Shooting above: same close-game filter (decided by
// the calibrated close-game margin or fewer), just Opp FG% instead of TS%, since that's the
// existing headline defensive shooting-allowed number (Opp eFG% above is the more granular
// version, but Opp FG% is what Defensive Load and the rest of this page already lead with). Does
// a defender hold up or break down when the game is actually on the line, the same real question
// Close-Game Shooting answers for offense.
function computeCloseGameDefense() {
  const closeGames = state.games.filter(g => {
    if (!isQualifyingGame(g)) return false;
    return Math.abs(teamScore(g, g.teamA) - teamScore(g, g.teamB)) <= clutchMarginThreshold();
  });
  const totals = {}; // playerId -> { timesBeaten, stops, gp }
  closeGames.forEach(game => {
    [...game.teamA, ...game.teamB].forEach(playerId => {
      const def = gameDefenseStats(game, playerId);
      if (def.timesBeaten + def.stops === 0) return;
      const t = totals[playerId] = totals[playerId] || { timesBeaten: 0, stops: 0, gp: 0 };
      t.timesBeaten += def.timesBeaten;
      t.stops += def.stops;
      t.gp++;
    });
  });
  return Object.entries(totals)
    .map(([playerId, v]) => ({
      player: state.players.find(p => p.id === playerId),
      gp: v.gp,
      attempts: v.timesBeaten + v.stops,
      oppFgPct: pct(v.timesBeaten, v.timesBeaten + v.stops)
    }))
    .filter(r => r.player && r.oppFgPct !== null);
}

const CLOSE_GAME_DEFENSE_COLUMNS = [
  { key: "player", label: "Player", accessor: r => r.player.name },
  { key: "gp", label: "Close Games", accessor: r => r.gp },
  { key: "attempts", label: "Shots Defended", accessor: r => r.attempts },
  { key: "oppfg", label: "Opp FG%", accessor: r => r.oppFgPct }
];
let closeGameDefenseSort = { key: "oppfg", dir: "asc" };

function renderCloseGameDefensePanel() {
  const headerRow = document.getElementById("closeGameDefenseHeaderRow");
  if (!headerRow) return;
  renderSortableHeader(headerRow, CLOSE_GAME_DEFENSE_COLUMNS, closeGameDefenseSort, renderCloseGameDefensePanel);
  const body = document.getElementById("closeGameDefenseBody");
  const rows = computeCloseGameDefense();
  const sortCol = CLOSE_GAME_DEFENSE_COLUMNS.find(c => c.key === closeGameDefenseSort.key);
  rows.sort((a, b) => compareForSort(sortCol.accessor(a), sortCol.accessor(b), closeGameDefenseSort.dir));
  body.innerHTML = rows.length === 0
    ? `<tr><td colspan="4" class="empty-state">No games decided by ${clutchMarginThreshold()} points or fewer yet.</td></tr>`
    : rows.map(r => `<tr><td>${playerLink(r.player.id, r.player.name)}</td><td>${r.gp}</td><td>${r.attempts}</td><td>${formatPct(r.oppFgPct)}</td></tr>`).join("");
}

// Best & Worst Individual Games — ranks every player-game line by that single game's actual
// Two-Way score (Off Rating + Defensive Rating), not a per-20 rate and not a season total. The
// rest of the Leaderboard deliberately normalizes everything to per-20 or season-long numbers so
// players are comparable across different game lengths and sample sizes — this panel is the one
// exception on purpose, since the whole point is surfacing a specific game's own story (a real
// 16.7 Two-Way night), which per-20 and season aggregates both average away. Every player on
// either roster for a reviewed game gets a row, even a quiet one with almost nothing recorded.
// Excludes stoppedEarly games: a partial game's Two-Way score shouldn't compete for a spot on
// this leaderboard against complete ones (see poolean-stopped-early-spec.md).
function computeIndividualGamePerformances() {
  const rows = [];
  state.games.filter(g => isQualifyingGame(g) && !g.stoppedEarly).forEach(game => {
    [...game.teamA, ...game.teamB].forEach(playerId => {
      const player = state.players.find(p => p.id === playerId);
      if (!player) return;
      const s = getOrCreatePlayerStats(game, playerId);
      const sh = shootingStats(game, playerId);
      const def = gameDefenseStats(game, playerId);
      const offRtg = offensiveRating(s, sh);
      const defRtg = defensiveRating(s, def);
      rows.push({ player, game, pts: s.pts, offRtg, defRtg, twoWay: offRtg + defRtg });
    });
  });
  return rows;
}

// Best & Worst Individual Games can rank by any of the three scores that make up a game's own
// box score line -- Two-Way (the default, offense and defense combined), or either half on its
// own, since "best offensive game" and "best defensive game" are real, different questions a
// single combined ranking can't answer (a huge scoring night can bury a genuinely dominant
// defensive one, and vice versa).
const INDIVIDUAL_GAMES_MODES = {
  twoway: { label: "Overall", valueOf: r => r.twoWay, unit: "Two-Way" },
  offense: { label: "Offense", valueOf: r => r.offRtg, unit: "Off Rating" },
  defense: { label: "Defense", valueOf: r => r.defRtg, unit: "Def Rating" },
};
let individualGamesMode = "twoway";

function renderIndividualGamePerformances() {
  const wrap = document.getElementById("individualGamePerformances");
  if (!wrap) return;
  const rows = computeIndividualGamePerformances();
  if (rows.length === 0) {
    wrap.innerHTML = '<p class="empty-state">No games logged yet.</p>';
    return;
  }
  const mode = INDIVIDUAL_GAMES_MODES[individualGamesMode];
  const sorted = [...rows].sort((a, b) => mode.valueOf(b) - mode.valueOf(a));
  // Capped so best/worst never overlap on a thin season — with few enough rows, showing the same
  // handful of games in both lists (just reversed) would read as a bug, not a real result.
  const n = Math.min(10, Math.max(1, Math.floor(sorted.length / 2)));
  const best = sorted.slice(0, n);
  const worst = sorted.slice(-n).reverse();
  const li = r => {
    const val = mode.valueOf(r);
    return `
    <li>
      <span class="award-standings-name"><button type="button" class="icon-btn indiv-game-player-btn" data-player-id="${r.player.id}" style="padding:0;font-weight:700;color:var(--accent)">${escapeHtml(r.player.name)}</button> <button type="button" class="icon-btn indiv-game-date-btn" data-game-id="${r.game.id}" style="padding:0;font-weight:600;color:var(--accent)">(${escapeHtml(formatDateDisplay(r.game.date))})</button></span>
      <span>${val >= 0 ? "+" : ""}${val.toFixed(1)} ${mode.unit} <span class="hint" style="margin:0">(${r.pts} pts)</span></span>
    </li>
  `;
  };
  wrap.innerHTML = `
    <div class="button-row" style="margin-bottom:10px">
      ${Object.entries(INDIVIDUAL_GAMES_MODES).map(([key, m]) =>
        `<button type="button" class="secondary-btn indiv-games-mode-btn${key === individualGamesMode ? " selected" : ""}" data-mode="${key}">${m.label}</button>`
      ).join("")}
    </div>
    <div class="award-standings-wrap">
      <div class="award-standings-col">
        <h4 class="award-standings-heading">Best</h4>
        <ol class="award-standings">${best.map(li).join("")}</ol>
      </div>
      <div class="award-standings-col">
        <h4 class="award-standings-heading">Worst</h4>
        <ol class="award-standings">${worst.map(li).join("")}</ol>
      </div>
    </div>
  `;
  wrap.querySelectorAll(".indiv-games-mode-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      individualGamesMode = btn.dataset.mode;
      renderIndividualGamePerformances();
    });
  });
  wrap.querySelectorAll(".indiv-game-player-btn").forEach(btn => {
    btn.addEventListener("click", () => openPlayerDetail(btn.dataset.playerId));
  });
  wrap.querySelectorAll(".indiv-game-date-btn").forEach(btn => {
    btn.addEventListener("click", () => openGame(btn.dataset.gameId));
  });
}

// Every season's voted awards, straight from each season's closed ballot (award_results in the
// season spreadsheet); `season` is the year. Add a new season's entries by hand once its voting
// closes (the site export deliberately leaves awards out). Fixed, historical facts, not something this tool derives or
// could recompute. `winners` are player slugs, which match this tool's own player.id for anyone
// imported from poolean-seed.json (see INTEGRATION.md). `statKey` says which tracked stat is
// the closest comparison for that award; null means there's no tracked equivalent to compare
// against, so the panel says that plainly instead of forcing a stretch metric onto it. MVP uses
// season-long Two-Way total rather than a per-20 rate, on the theory that "played a lot and
// contributed a lot" should outweigh a slightly higher rate over fewer games for that specific
// award — every other award here still compares on the per-20 rate.
// `votedStandings` is the real ballot tally (`award_tally_long`'s `borda_points` measure —
// `pair_votes` for the two duo awards, which aren't single-candidate ballots) for every
// candidate who got at least one vote, not just the winner — a genuine second ranking to sit
// next to the stat standings, sourced from the same spreadsheet as everything else here. `name`
// is the display name straight from that sheet (pre-joined as "X + Y" for a duo), so this list
// never depends on whether that person happens to be in the current browser's roster.
const ALL_AWARD_RESULTS = [
  { season: 2026, key: "mvp", label: "MVP", winners: ["ben"], statKey: "twoWayTotal", votedStandings: [
    { slug: "ben", name: "Ben", points: 18 }, { slug: "adam", name: "Adam", points: 11 },
    { slug: "phillip", name: "Phillip", points: 7 }, { slug: "reilly", name: "Reilly", points: 6 },
    { slug: "zach", name: "Zach", points: 5 }, { slug: "evan", name: "Evan", points: 1 }
  ] },
  { season: 2026, key: "best-player", label: "Best Player", winners: ["phillip"], statKey: "twoWay", votedStandings: [
    { slug: "phillip", name: "Phillip", points: 21 }, { slug: "ben", name: "Ben", points: 7 },
    { slug: "logan-hoskins", name: "Logan H", points: 6 }, { slug: "adam", name: "Adam", points: 4 },
    { slug: "evan", name: "Evan", points: 4 }, { slug: "reilly", name: "Reilly", points: 3 },
    { slug: "sean", name: "Sean", points: 2 }, { slug: "kayla", name: "Kayla", points: 1 }
  ] },
  { season: 2026, key: "dpoy", label: "Defensive Player of the Year", winners: ["adam"], statKey: "defRating", votedStandings: [
    { slug: "adam", name: "Adam", points: 9 }, { slug: "jason", name: "Jason", points: 9 },
    { slug: "phillip", name: "Phillip", points: 6 }, { slug: "ben", name: "Ben", points: 4 },
    { slug: "logan-hoskins", name: "Logan H", points: 3 }, { slug: "sean", name: "Sean", points: 3 },
    { slug: "g-ian", name: "Ian", points: 2 }, { slug: "reilly", name: "Reilly", points: 2 },
    { slug: "will", name: "Will", points: 2 }, { slug: "evan", name: "Evan", points: 1 },
    { slug: "zach", name: "Zach", points: 1 }
  ] },
  { season: 2026, key: "clutch", label: "Clutch", winners: ["phillip"], statKey: "closeGameTs", votedStandings: [
    { slug: "phillip", name: "Phillip", points: 7 }, { slug: "zach", name: "Zach", points: 7 },
    { slug: "adam", name: "Adam", points: 5 }, { slug: "evan", name: "Evan", points: 5 },
    { slug: "alex", name: "Alex", points: 4 }, { slug: "reilly", name: "Reilly", points: 4 },
    { slug: "ben", name: "Ben", points: 3 }, { slug: "viraj", name: "Viraj", points: 1 }
  ] },
  { season: 2026, key: "mip-season", label: "Most Improved (Season)", winners: ["zach"], statKey: "trend", votedStandings: [
    { slug: "zach", name: "Zach", points: 19 }, { slug: "ben", name: "Ben", points: 7 },
    { slug: "alex", name: "Alex", points: 4 }, { slug: "evan", name: "Evan", points: 4 },
    { slug: "g-lukas", name: "Lukas", points: 4 }, { slug: "adam", name: "Adam", points: 2 },
    { slug: "jason", name: "Jason", points: 2 }
  ] },
  { season: 2026, key: "mip-yoy", label: "Most Improved (Year-over-Year)", winners: ["zach"], statKey: "trend", votedStandings: [
    { slug: "zach", name: "Zach", points: 9 }, { slug: "ben", name: "Ben", points: 6 },
    { slug: "adam", name: "Adam", points: 5 }, { slug: "alex", name: "Alex", points: 3 },
    { slug: "jason", name: "Jason", points: 3 }, { slug: "viraj", name: "Viraj", points: 3 },
    { slug: "logan-watson", name: "Logan W", points: 2 }, { slug: "ryder", name: "Ryder", points: 2 },
    { slug: "sean", name: "Sean", points: 2 }, { slug: "evan", name: "Evan", points: 1 }
  ] },
  { season: 2026, key: "teammate", label: "Best Teammate", winners: ["ben"], statKey: "teammateLift", votedStandings: [
    { slug: "ben", name: "Ben", points: 10 }, { slug: "reilly", name: "Reilly", points: 6 },
    { slug: "sean", name: "Sean", points: 6 }, { slug: "evan", name: "Evan", points: 4 },
    { slug: "jason", name: "Jason", points: 4 }, { slug: "adam", name: "Adam", points: 3 },
    { slug: "logan-hoskins", name: "Logan H", points: 3 }, { slug: "phillip", name: "Phillip", points: 2 },
    { slug: "alex", name: "Alex", points: 1 }, { slug: "g-ian", name: "Ian", points: 1 },
    { slug: "will", name: "Will", points: 1 }, { slug: "zach", name: "Zach", points: 1 }
  ] },
  { season: 2026, key: "first-team", label: "First Team", winners: ["phillip", "ben", "sean"], statKey: "twoWay", votedStandings: [
    { slug: "phillip", name: "Phillip", points: 29 }, { slug: "ben", name: "Ben", points: 22 },
    { slug: "sean", name: "Sean", points: 13 }, { slug: "adam", name: "Adam", points: 12 },
    { slug: "reilly", name: "Reilly", points: 10 }, { slug: "evan", name: "Evan", points: 9 },
    { slug: "logan-hoskins", name: "Logan H", points: 7 }, { slug: "zach", name: "Zach", points: 3 }
  ] },
  { season: 2026, key: "second-team", label: "Second Team", winners: ["adam", "reilly", "evan"], statKey: "twoWay", votedStandings: [
    { slug: "phillip", name: "Phillip", points: 29 }, { slug: "ben", name: "Ben", points: 22 },
    { slug: "sean", name: "Sean", points: 13 }, { slug: "adam", name: "Adam", points: 12 },
    { slug: "reilly", name: "Reilly", points: 10 }, { slug: "evan", name: "Evan", points: 9 },
    { slug: "logan-hoskins", name: "Logan H", points: 7 }, { slug: "zach", name: "Zach", points: 3 }
  ] },
  { season: 2026, key: "best-duo", label: "Best Duo", winners: ["phillip", "ben"], statKey: "twoWay", isDuo: true, votedStandings: [
    { slug: "ben|phillip", name: "Ben + Phillip", points: 3 }, { slug: "alex|kayla", name: "Alex + Kayla", points: 1 },
    { slug: "alex|viraj", name: "Alex + Viraj", points: 1 }
  ] },
  { season: 2026, key: "worst-duo", label: "Worst Duo", winners: ["phillip", "viraj"], statKey: "twoWay", isDuo: true, votedStandings: [
    { slug: "phillip|viraj", name: "Phillip + Viraj", points: 4 }, { slug: "adam|zach", name: "Adam + Zach", points: 1 },
    { slug: "alex|viraj", name: "Alex + Viraj", points: 1 }
  ] }
];

// The awards for whichever real season is picked in the header (setPooleanSeason() below
// reassigns this). ALL_AWARD_RESULTS stays the full history, for the avatar ring and badges.
let AWARD_RESULTS = ALL_AWARD_RESULTS;

// For each award, resolves its voted winner(s) against whatever's actually logged in this
// browser right now — a rank/value on the closest tracked stat, or an honest "no games logged
// yet" / "no comparable tracked stat" rather than a fabricated number. Recomputed fresh every
// render, same as every other Leaderboard panel — nothing about awards or their pairing to a
// stat is stored in `state`.
// Full ranked standings for each statKey a click can expand into — same underlying numbers the
// winner-detail line already summarizes, just for every player instead of only the voted
// winner(s). Built once per statKey (not per award), since several awards share one.
function computeAwardStandings() {
  const board = computeLeaderboard().filter(r => r.gp > 0);
  const teammateLift = state.players.map(p => {
    const lifts = [];
    state.players.forEach(other => {
      if (other.id === p.id) return;
      const synergy = computeTeammateSynergy(other.id).find(s => s.teammate.id === p.id);
      if (synergy && synergy.with.gp > 0 && synergy.without.gp > 0) lifts.push(synergy.with.twoWayPer20 - synergy.without.twoWayPer20);
    });
    if (lifts.length === 0) return null;
    const avg = lifts.reduce((a, b) => a + b, 0) / lifts.length;
    return { player: p, value: avg, display: `${avg >= 0 ? "+" : ""}${avg.toFixed(1)} Two-Way/20 avg lift (${lifts.length} teammate${lifts.length === 1 ? "" : "s"})` };
  }).filter(Boolean).sort((a, b) => b.value - a.value);

  return {
    twoWay: [...board].sort((a, b) => b.twoWayPer20 - a.twoWayPer20)
      .map(r => ({ player: r.player, value: r.twoWayPer20, display: `${r.twoWayPer20.toFixed(1)} Two-Way/20` })),
    twoWayTotal: [...board].sort((a, b) => b.twoWayTotal - a.twoWayTotal)
      .map(r => ({ player: r.player, value: r.twoWayTotal, display: `${r.twoWayTotal.toFixed(1)} Two-Way (season)` })),
    defRating: [...board].sort((a, b) => defensiveRating(b.rate, b.rateDefense) - defensiveRating(a.rate, a.rateDefense))
      .map(r => ({ player: r.player, value: defensiveRating(r.rate, r.rateDefense), display: `${defensiveRating(r.rate, r.rateDefense).toFixed(1)} Def Rating/20` })),
    gwb: computeGameWinningBuckets()
      .map(r => ({ player: r.player, value: r.count, display: `${r.count} game-winning bucket${r.count === 1 ? "" : "s"}` })),
    closeGameTs: [...computeCloseGameShooting()].sort((a, b) => b.ts - a.ts)
      .map(r => ({ player: r.player, value: r.ts, display: `${r.ts}% TS in close games (${r.gp} game${r.gp === 1 ? "" : "s"}, ${r.attempts} att)` })),
    trend: [...board].sort((a, b) => b.last5TwoWayPer20 - a.last5TwoWayPer20)
      .map(r => ({ player: r.player, value: r.last5TwoWayPer20, display: `Last 5: ${r.last5Trend} ${r.last5TwoWayPer20.toFixed(1)} vs. season ${r.twoWayPer20.toFixed(1)} Two-Way/20` })),
    teammateLift
  };
}

const AWARD_NOT_FOUND_TEXT = {
  gwb: "0 game-winning buckets this season",
  closeGameTs: "No games decided by 5 points or fewer yet",
  teammateLift: "Not enough With/Without games logged yet"
};

const AWARD_ICONS = {
  mvp: "🏆", "best-player": "🛡️", dpoy: "🧱", clutch: "🧊", "mip-season": "📈", "mip-yoy": "📊",
  teammate: "🤝", "first-team": "⭐", "second-team": "🥈", "best-duo": "🔥", "worst-duo": "🥴"
};

// Poolean Awards UI spec: three real tiers (gold/silver/bronze) plus one deliberately untiered
// house award (Worst Duo — stays visible everywhere an award shows, just never gold/silver/bronze
// and never sets a ring color). Tier 1 is the two headline individual awards; tier 2 is the other
// individual honors plus the stronger of the two All-Poolean squads; tier 3 is the pair/role
// awards plus the weaker squad. All-Poolean is two separate honors (First Team outranks Second),
// and Most Improved is two separate awards (Season vs. Year-over-Year) — never collapse either
// pair into one label.
const AWARD_TIER = {
  mvp: 1, "best-player": 1,
  "mip-season": 2, "mip-yoy": 2, dpoy: 2, "first-team": 2,
  "best-duo": 3, "second-team": 3, teammate: 3, clutch: 3,
  "worst-duo": null
};
const AWARD_TIER_COLOR = { 1: "gold", 2: "silver", 3: "bronze" };
const AWARD_PLACEMENT_LABEL = { 1: "Runner-up", 2: "Honorable mention" };

// This player's real award history across every season: 1st (they're in award.winners), 2nd or
// 3rd place (that position in award.votedStandings, the real ballot tally, not this tool's own
// approximate stat standings). A duo award's votedStandings slugs are "a|b" pairs, checked by
// membership, and its badge names the other half of the pair. Newest season first.
function computePlayerAwardBadges(playerId) {
  return [...ALL_AWARD_RESULTS].sort((a, b) => b.season - a.season).map(award => {
    const isWinner = award.winners.includes(playerId);
    let placementIndex = isWinner ? 0 : -1;
    if (!isWinner) {
      placementIndex = award.votedStandings.findIndex(entry => entry.slug.split("|").includes(playerId));
      if (placementIndex < 1 || placementIndex > 2) return null; // only 2nd/3rd count as a placement badge
    }
    // The duo this placement belongs to: the winning pair for a win, otherwise whichever
    // votedStandings pair this player's own placement came from.
    const pairSlugs = award.isDuo
      ? (isWinner ? award.winners : award.votedStandings[placementIndex].slug.split("|"))
      : null;
    const partnerId = pairSlugs ? pairSlugs.find(id => id !== playerId) || null : null;
    return {
      key: award.key, label: award.label, icon: AWARD_ICONS[award.key] || "🏅", season: award.season,
      isWinner, tier: AWARD_TIER[award.key] || null, color: AWARD_TIER_COLOR[AWARD_TIER[award.key]] || null,
      placementLabel: isWinner ? String(award.season) : `${AWARD_PLACEMENT_LABEL[placementIndex]} ${award.season}`,
      partnerName: partnerId ? poolNameOf(partnerId) : null, partnerId
    };
  }).filter(Boolean);
}

// The ring's color/thickness: highest tier among this player's actual WINS only (a runner-up
// finish shows in the badge grid but never sets the ring). Thick with a glow for a win in the
// latest season that has awards; thin for someone whose wins are all from earlier seasons.
// Always judged against the latest season, whichever season is picked in the header.
function computePlayerAwardTier(playerId) {
  const wins = ALL_AWARD_RESULTS.filter(a => a.winners.includes(playerId) && AWARD_TIER[a.key]);
  if (wins.length === 0) return null;
  const latest = Math.max(...ALL_AWARD_RESULTS.map(a => a.season));
  const currentWins = wins.filter(a => a.season === latest);
  const pool = currentWins.length > 0 ? currentWins : wins;
  const tier = Math.min(...pool.map(a => AWARD_TIER[a.key]));
  return { tier, color: AWARD_TIER_COLOR[tier], isCurrent: currentWins.length > 0 };
}

// ---------- Real site seasons ----------
// Every season this app knows about, from either the imported site data (POOLEAN_SEASON_LIST)
// or the hand-entered awards, oldest first. The header's season picker swaps every real-data
// panel over to one season by reassigning the POOLEAN_* globals and AWARD_RESULTS.
const POOLEAN_SEASON_KEY = "poolean-selected-season";
let selectedPooleanSeason = null;

function pooleanSeasonList() {
  const years = new Set(ALL_AWARD_RESULTS.map(a => String(a.season)));
  if (typeof POOLEAN_SEASON_LIST !== "undefined") POOLEAN_SEASON_LIST.forEach(y => years.add(String(y)));
  return [...years].sort((a, b) => Number(a) - Number(b));
}

function setPooleanSeason(year) {
  const list = pooleanSeasonList();
  selectedPooleanSeason = list.includes(String(year)) ? String(year) : list[list.length - 1] || null;
  AWARD_RESULTS = ALL_AWARD_RESULTS.filter(a => String(a.season) === selectedPooleanSeason);
  if (typeof POOLEAN_SEASONS === "undefined") return;
  const d = POOLEAN_SEASONS[selectedPooleanSeason];
  // A season with awards but no imported site data leaves these undefined, so every real-data
  // panel shows its normal "no real-site data" empty state instead of another season's numbers.
  window.POOLEAN_RANKINGS = d ? d.rankings : undefined;
  window.POOLEAN_RECORD = d ? d.record : undefined;
  window.POOLEAN_TOGETHER = d ? d.together : undefined;
  window.POOLEAN_AGAINST = d ? d.against : undefined;
  window.POOLEAN_SEASON_CARDS = d ? d.cards : undefined;
  window.POOLEAN_GAMES = d ? d.games : undefined;
  if (d) window.POOLEAN_NAMES = d.names;
}

function initPooleanSeasonPicker() {
  let saved = null;
  try { saved = localStorage.getItem(POOLEAN_SEASON_KEY); } catch (e) { /* storage blocked */ }
  setPooleanSeason(saved);
  const select = document.getElementById("pooleanSeasonSelect");
  const wrap = document.getElementById("pooleanSeasonPicker");
  if (!select || !wrap) return;
  const list = pooleanSeasonList();
  wrap.hidden = list.length < 2;
  select.innerHTML = [...list].reverse().map(y => `<option value="${y}">${y} season</option>`).join("");
  select.value = selectedPooleanSeason;
  select.addEventListener("change", () => {
    setPooleanSeason(select.value);
    try { localStorage.setItem(POOLEAN_SEASON_KEY, selectedPooleanSeason); } catch (e) { /* storage blocked */ }
    renderLeaderboard();
    if (currentPlayerId) renderPlayerDetail();
  });
}

// One row per season this player has a real season card in, with the change from their
// previous season. Always every season, whichever one the header picker is on.
function computePlayerRealSeasons(playerId) {
  if (typeof POOLEAN_SEASONS === "undefined") return [];
  let prev = null;
  return pooleanSeasonList().map(year => {
    const card = POOLEAN_SEASONS[year]?.cards?.[playerId];
    if (!card) return null;
    const wins = ALL_AWARD_RESULTS.filter(a => String(a.season) === year && a.winners.includes(playerId));
    const row = { year, card, wins, powerDelta: prev ? card.powerPct - prev.powerPct : null, winDelta: prev ? card.winPct - prev.winPct : null };
    prev = card;
    return row;
  }).filter(Boolean);
}

function renderPlayerRealSeasons(playerId) {
  const wrap = document.getElementById("playerRealSeasons");
  if (!wrap) return;
  const rows = computePlayerRealSeasons(playerId);
  if (rows.length === 0) { wrap.innerHTML = '<p class="empty-state">No real-site season cards for this player yet.</p>'; return; }
  const delta = d => d === null ? "" : ` <span class="season-delta ${d > 0 ? "season-delta-up" : d < 0 ? "season-delta-down" : ""}">${Math.round(d) > 0 ? "+" : Math.round(d) === 0 ? "±" : ""}${Math.round(d)}</span>`;
  const body = [...rows].reverse().map(r => `
    <tr>
      <td><strong>${r.year}</strong></td>
      <td>${r.card.w}-${r.card.l}</td>
      <td>${Math.round(r.card.winPct)}%${delta(r.winDelta)}</td>
      <td>${Math.round(r.card.powerPct)}%${delta(r.powerDelta)}</td>
      <td>${r.card.crowns}</td>
      <td>${r.card.bestRank ? ordinal(r.card.bestRank) : "-"}</td>
      <td>${r.wins.map(a => `<span title="${escapeHtml(a.label)}">${AWARD_ICONS[a.key] || "🏅"}</span>`).join(" ") || "-"}</td>
    </tr>`).join("");
  wrap.innerHTML = `<div class="table-scroll"><table class="matchup-table">
    <thead><tr><th>Season</th><th>Record</th><th>Win %</th><th>Power %</th><th>#1 nights</th><th>Best rank</th><th>Awards won</th></tr></thead>
    <tbody>${body}</tbody></table></div>
    ${rows.length === 1 ? '<p class="hint" style="margin:10px 0 0">Year-over-year changes show up here once a second season is imported.</p>' : ""}`;
}

// A shareable one-screen recap of the real (closed) season: the MVP as champion, every award and
// its winner(s), the final top of the real power rankings, and the season's biggest mover in
// either direction. Everything here comes from the real site's own data (AWARD_RESULTS/
// POOLEAN_SEASON_CARDS/POOLEAN_RANKINGS), not this app's own locally logged subset — same
// "frozen historical record" reasoning as Power Rankings and Real Game Record above it.
function computeSeasonRecap() {
  if (typeof POOLEAN_SEASON_CARDS === "undefined") return null;
  // Every real slug (POOLEAN_NAMES), not just this browser's own local roster -- the champion,
  // top power rankings, and biggest mover all need to be right even when whoever they land on
  // isn't in the local roster yet, not silently skip that person and show second-best instead.
  const mvp = AWARD_RESULTS.find(a => a.key === "mvp");
  const champion = mvp ? { slug: mvp.winners[0], name: poolNameOf(mvp.winners[0]) } : null;
  const awardRows = AWARD_RESULTS.map(a => ({
    label: a.label, icon: AWARD_ICONS[a.key] || "🏅", color: AWARD_TIER_COLOR[AWARD_TIER[a.key]] || null,
    winners: a.winners.map(slug => ({ slug, name: poolNameOf(slug) }))
  }));
  const topPower = Object.entries(POOLEAN_SEASON_CARDS)
    .map(([slug, card]) => ({ slug, name: poolNameOf(slug), card }))
    .sort((a, b) => b.card.powerPct - a.card.powerPct)
    .slice(0, 3);
  // Biggest movers: each player's rank at the very first real party versus their FINAL overall
  // season rank (by season-long power ranking %, POOLEAN_SEASON_CARDS) -- not their last single
  // party's percentile, which is noisy (one good or bad night against a small field can swing it
  // to 0% or 100% on its own). Rank 1 is best either way, so a positive delta means moved up.
  let riser = null, faller = null;
  if (typeof POOLEAN_RANKINGS !== "undefined" && POOLEAN_RANKINGS.length >= 1) {
    const first = POOLEAN_RANKINGS[0];
    const overallRank = Object.fromEntries(
      Object.entries(POOLEAN_SEASON_CARDS).sort((a, b) => b[1].powerPct - a[1].powerPct).map(([slug], i) => [slug, i + 1])
    );
    const fieldSize = Object.keys(POOLEAN_SEASON_CARDS).length;
    Object.keys(POOLEAN_SEASON_CARDS).forEach(slug => {
      const f = first.players.find(x => x.slug === slug);
      const finalRank = overallRank[slug];
      if (!f || !finalRank) return;
      const delta = f.rank - finalRank;
      const entry = { slug, name: poolNameOf(slug), delta, from: f.rank, fromOf: first.players.length, to: finalRank, toOf: fieldSize };
      if (!riser || delta > riser.delta) riser = entry;
      if (!faller || delta < faller.delta) faller = entry;
    });
  }
  return { champion, mvpAward: mvp, awardRows, topPower, riser, faller };
}

function renderSeasonRecap() {
  const wrap = document.getElementById("seasonRecap");
  if (!wrap) return;
  const recap = computeSeasonRecap();
  if (!recap) {
    wrap.innerHTML = '<p class="empty-state">No real-site season data loaded yet.</p>';
    return;
  }
  const championHtml = recap.champion ? `
    <div class="award-marquee">
      <span class="award-marquee-icon">🏆</span>
      <span class="award-marquee-text"><strong>${escapeHtml(recap.champion.name)}</strong><span>Season Champion · ${escapeHtml(recap.mvpAward.label)}</span></span>
    </div>` : "";
  const awardsHtml = recap.awardRows.map(a => `
    <span class="award-badge${a.color ? ` award-badge-${a.color}` : " award-badge-untiered"}">
      <span class="award-badge-icon">${a.icon}</span>
      <span class="award-badge-label">${escapeHtml(a.label)}</span>
      <span class="award-badge-sub">${a.winners.map(w => escapeHtml(w.name)).join(" + ") || "—"}</span>
    </span>`).join("");
  const topPowerHtml = recap.topPower.map((r, i) => `
    <li>${i + 1}. ${poolPlayerLink(r.slug)} <span class="hint" style="margin:0">${r.card.powerPct}% · ${r.card.crowns}× #1</span></li>`).join("");
  const mover = (label, m) => !m ? "" : `<div class="real-partner-tile">
      <span class="real-partner-label">${label}</span>
      ${poolPlayerLink(m.slug)}
      <span class="real-partner-pct">${ordinal(m.from)} of ${m.fromOf} on Day 1 → ${ordinal(m.to)} overall (${m.delta >= 0 ? "+" : ""}${m.delta})</span>
    </div>`;
  wrap.innerHTML = `
    ${championHtml}
    <h4 style="margin:14px 0 8px">Season awards</h4>
    <div class="award-badge-grid">${awardsHtml}</div>
    <h4 style="margin:14px 0 8px">Final power rankings, top 3</h4>
    <ol class="award-standings">${topPowerHtml}</ol>
    <h4 style="margin:14px 0 8px">Biggest movers</h4>
    <div class="real-partner-grid">${mover("Biggest riser", recap.riser)}${mover("Biggest faller", recap.faller)}</div>`;
}

// ---------- Streaks, Rivalries, Upsets, Party Recap, Trophy Case ----------
// All five read POOLEAN_GAMES (build_poolean_data.py's raw, chronological real game log) rather
// than this app's own locally logged subset, same "real site is the bigger, steadier sample"
// reasoning as everywhere else the real data shows up.

// This player's real win/loss streaks: current (however many games long, win or loss), and the
// longest of each across the whole season, in real play order (byPlayOrder).
function computePlayerStreaks(playerId) {
  if (typeof POOLEAN_GAMES === "undefined") return null;
  const games = POOLEAN_GAMES.filter(g => g.a.includes(playerId) || g.b.includes(playerId)).sort(byPlayOrder);
  if (games.length === 0) return null;
  let curWin = 0, curLoss = 0, longestWin = 0, longestLoss = 0;
  games.forEach(g => {
    const onA = g.a.includes(playerId);
    const won = (onA && g.w === "A") || (!onA && g.w === "B");
    if (won) { curWin++; curLoss = 0; longestWin = Math.max(longestWin, curWin); }
    else { curLoss++; curWin = 0; longestLoss = Math.max(longestLoss, curLoss); }
  });
  const current = curWin > 0 ? { type: "W", n: curWin } : { type: "L", n: curLoss };
  return { current, longestWin, longestLoss, gp: games.length };
}

function renderPlayerStreaks(playerId) {
  const wrap = document.getElementById("playerStreaks");
  if (!wrap) return;
  const s = computePlayerStreaks(playerId);
  if (!s) { wrap.innerHTML = '<p class="empty-state">No real-site games for this player yet.</p>'; return; }
  wrap.innerHTML = `
    <div class="league-rank-grid">
      <div class="league-rank-badge${s.current.type === "W" ? " league-rank-top" : ""}"><span class="league-rank-place">${s.current.type === "W" ? "🔥" : "❄️"} ${s.current.n}</span><span class="league-rank-label">Current ${s.current.type === "W" ? "win" : "losing"} streak</span></div>
      <div class="league-rank-badge"><span class="league-rank-place">${s.longestWin}</span><span class="league-rank-label">Longest win streak</span></div>
      <div class="league-rank-badge"><span class="league-rank-place">${s.longestLoss}</span><span class="league-rank-label">Longest losing streak</span></div>
    </div>`;
}

const RIVALRY_MIN_GP = 5;

// This player's display name, whether or not they're in this browser's own local roster (state.
// players) — falls back to POOLEAN_NAMES (the real site's own name for that slug), so a real
// player who hasn't been added locally yet still shows by name instead of silently vanishing from
// every real-data panel that touches them. poolPlayerLink() additionally links to their own page
// when a local match exists, or shows plain (unlinked) text when it doesn't, since there's no
// Player Detail page to send them to.
function poolNameOf(slug) {
  const p = state.players.find(x => x.id === slug);
  if (p) return p.name;
  return typeof POOLEAN_NAMES !== "undefined" ? POOLEAN_NAMES[slug] || slug : slug;
}
function poolPlayerLink(slug) {
  const p = state.players.find(x => x.id === slug);
  return p ? playerLink(p.id, p.name) : escapeHtml(poolNameOf(slug));
}
function poolKnownSlug(slug) {
  if (state.players.some(p => p.id === slug)) return true;
  return typeof POOLEAN_NAMES !== "undefined" && !!POOLEAN_NAMES[slug];
}

// League-wide rivalry superlatives from the full pairwise real data (POOLEAN_TOGETHER/AGAINST),
// not one player's own view of it — the most-played pairing, the tightest and most lopsided real
// head-to-head, and the closest real record for two players who've actually shared a team.
function computeRivalries() {
  if (typeof POOLEAN_TOGETHER === "undefined") return null;
  const pairLabel = key => key.split("|").map(poolNameOf);
  let mostPlayed = null, bestTeam = null, fiercestRivalry = null, mostLopsided = null;
  Object.entries(POOLEAN_TOGETHER).forEach(([key, v]) => {
    if (!poolKnownSlug(key.split("|")[0]) || !poolKnownSlug(key.split("|")[1])) return;
    if (!mostPlayed || v.gp > mostPlayed.gp) mostPlayed = { key, ...v };
    if (v.gp >= RIVALRY_MIN_GP) {
      const winPct = v.w / v.gp;
      if (!bestTeam || winPct > bestTeam.winPct) bestTeam = { key, ...v, winPct };
    }
  });
  Object.entries(POOLEAN_AGAINST).forEach(([key, v]) => {
    const [a, b] = key.split("|");
    if (!poolKnownSlug(a) || !poolKnownSlug(b) || a > b) return; // one direction per pair is enough to compare
    if (v.gp < RIVALRY_MIN_GP) return;
    const dist = Math.abs(v.w / v.gp - 0.5);
    if (!fiercestRivalry || dist < fiercestRivalry.dist) fiercestRivalry = { key, ...v, dist };
    if (!mostLopsided || dist > mostLopsided.dist) mostLopsided = { key, ...v, dist };
  });
  if (!mostPlayed && !bestTeam && !fiercestRivalry && !mostLopsided) return null;
  return { mostPlayed, bestTeam, fiercestRivalry, mostLopsided, pairLabel };
}

function renderRivalries() {
  const wrap = document.getElementById("rivalriesPanel");
  if (!wrap) return;
  const r = computeRivalries();
  if (!r) { wrap.innerHTML = '<p class="empty-state">No real-site pairwise data loaded yet.</p>'; return; }
  const tile = (label, entry, verb) => !entry ? "" : `<div class="real-partner-tile">
      <span class="real-partner-label">${label}</span>
      <span>${escapeHtml(r.pairLabel(entry.key).join(verb))}</span>
      <span class="real-partner-record">${entry.w}-${entry.l}</span>
      <span class="real-partner-pct">${entry.gp} games</span>
    </div>`;
  wrap.innerHTML = `<div class="real-partner-grid">
    ${tile("Most-played pairing", r.mostPlayed, " & ")}
    ${tile(`Best record together (${RIVALRY_MIN_GP}+ games)`, r.bestTeam, " & ")}
    ${tile(`Fiercest rivalry (${RIVALRY_MIN_GP}+ games)`, r.fiercestRivalry, " vs. ")}
    ${tile(`Most lopsided matchup (${RIVALRY_MIN_GP}+ games)`, r.mostLopsided, " vs. ")}
  </div>`;
}

// Extra-player advantage, in the same 0-100 percentile points PARTY_RANKINGS/POOLEAN_RANKINGS
// already use, derived from the real games themselves rather than guessed: among every real game
// with unequal team sizes, how often did the bigger side win? (percentile points) = (that win% -
// 50) * 2, the same win%-to-percentile-scale conversion used elsewhere in this app (e.g.
// teamWinRateAdjustment's win%-to-Two-Way-points conversion), applied once per extra player on a
// side. Needs at least 8 real uneven games before trusting the estimate; below that, uneven games
// are compared on raw percentile with no adjustment, same as an even game.
function computeTeamSizeAdvantagePct() {
  if (typeof POOLEAN_GAMES === "undefined") return 0;
  let biggerWins = 0, total = 0;
  POOLEAN_GAMES.forEach(g => {
    const diff = g.a.length - g.b.length;
    if (diff === 0) return;
    total++;
    if ((diff > 0 && g.w === "A") || (diff < 0 && g.w === "B")) biggerWins++;
  });
  if (total < 8) return 0;
  return ((biggerWins / total) * 100 - 50) * 2;
}

// Games where the lower-ranked side (by that same night's real power ranking percentile, adjusted
// for team size when sides are uneven) won anyway — an upset needs both sides to have a real
// ranking that night, so a game on a date with no ranking (or missing players) is simply left
// out, not guessed at.
function computeUpsets() {
  if (typeof POOLEAN_GAMES === "undefined" || typeof POOLEAN_RANKINGS === "undefined") return null;
  const rankByDate = Object.fromEntries(POOLEAN_RANKINGS.map(r => [r.date, r.players]));
  const sizeAdvantage = computeTeamSizeAdvantagePct();
  const upsets = [];
  POOLEAN_GAMES.forEach(g => {
    const night = rankByDate[g.date];
    if (!night) return;
    const pctOf = slug => { const p = night.find(x => x.slug === slug); return p ? p.pct : null; };
    const avg = ids => { const vals = ids.map(pctOf).filter(v => v !== null); return vals.length === ids.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null; };
    let aPct = avg(g.a), bPct = avg(g.b);
    if (aPct === null || bPct === null) return;
    // Team-size adjustment: whichever side has more players gets sizeAdvantage points per extra
    // player added to ITS effective percentile for the favorite comparison only -- the real
    // (unadjusted) percentiles are still what gets reported in the result below.
    const sizeDiff = g.a.length - g.b.length;
    const aEff = aPct + Math.max(0, sizeDiff) * sizeAdvantage;
    const bEff = bPct + Math.max(0, -sizeDiff) * sizeAdvantage;
    if (aEff === bEff) return;
    const favorite = aEff > bEff ? "A" : "B";
    if (g.w === favorite) return; // favorite won, not an upset
    const winners = g.w === "A" ? g.a : g.b, losers = g.w === "A" ? g.b : g.a;
    const winPct = g.w === "A" ? aPct : bPct, losePct = g.w === "A" ? bPct : aPct;
    const winEff = g.w === "A" ? aEff : bEff, loseEff = g.w === "A" ? bEff : aEff;
    upsets.push({ date: g.date, winners, losers, winPct, losePct, uneven: sizeDiff !== 0, gap: loseEff - winEff });
  });
  upsets.sort((a, b) => b.gap - a.gap);
  return upsets;
}

function renderUpsetTracker() {
  const wrap = document.getElementById("upsetTracker");
  if (!wrap) return;
  const upsets = computeUpsets();
  if (!upsets) { wrap.innerHTML = '<p class="empty-state">No real-site game/ranking data loaded yet.</p>'; return; }
  if (upsets.length === 0) { wrap.innerHTML = '<p class="empty-state">No upsets: the favorite won every game.</p>'; return; }
  const nameOf = poolPlayerLink;
  const rows = upsets.slice(0, 10).map(u => `
    <tr>
      <td>${escapeHtml(formatDateDisplay(u.date))}</td>
      <td>${u.winners.map(nameOf).join(" & ")}</td>
      <td>${u.losers.map(nameOf).join(" & ")}</td>
      <td>${Math.round(u.winPct)}% vs. ${Math.round(u.losePct)}%${u.uneven ? ` <span class="hint" style="margin:0">(uneven teams, size-adjusted)</span>` : ""}</td>
    </tr>`).join("");
  const unevenCount = upsets.filter(u => u.uneven).length;
  wrap.innerHTML = `<div class="table-scroll"><table class="matchup-table">
    <thead><tr><th>Date</th><th>Won</th><th>Beat (the favorite)</th><th>Power ranking that night</th></tr></thead>
    <tbody>${rows}</tbody></table></div>
    <p class="hint" style="margin:10px 0 0">${upsets.length} upset${upsets.length === 1 ? "" : "s"} total, biggest gap first${unevenCount > 0 ? ` (${unevenCount} on uneven teams, adjusted for the extra player)` : ""}.</p>`;
}

// Every real party night with at least one logged game: who went off, that night's biggest
// upset (if any, from computeUpsets() filtered to the date), and each attendee's record for
// just that one night.
function computePartyRecap(date) {
  if (typeof POOLEAN_GAMES === "undefined") return null;
  const games = POOLEAN_GAMES.filter(g => g.date === date);
  if (games.length === 0) return null;
  const record = {};
  games.forEach(g => {
    [...g.a, ...g.b].forEach(slug => { record[slug] = record[slug] || { w: 0, l: 0 }; });
    g.a.forEach(slug => record[slug][g.w === "A" ? "w" : "l"]++);
    g.b.forEach(slug => record[slug][g.w === "B" ? "w" : "l"]++);
  });
  const standings = Object.entries(record)
    .map(([slug, wl]) => ({ slug, ...wl }))
    .sort((a, b) => (b.w - b.l) - (a.w - a.l) || b.w - a.w);
  const nightUpsets = (computeUpsets() || []).filter(u => u.date === date);
  return { date, games: games.length, standings, upsets: nightUpsets, climber: computeNightClimber(date) };
}

function renderPartyRecap() {
  const select = document.getElementById("partyRecapSelect");
  const wrap = document.getElementById("partyRecap");
  if (!select || !wrap) return;
  if (typeof POOLEAN_GAMES === "undefined") { wrap.innerHTML = '<p class="empty-state">No real-site game data loaded yet.</p>'; return; }
  const dates = [...new Set(POOLEAN_GAMES.map(g => g.date))].sort().reverse();
  // Refilled whenever the header season picker changes, since each season has its own nights.
  if (select.dataset.season !== String(selectedPooleanSeason)) {
    select.innerHTML = dates.map(d => `<option value="${d}">${escapeHtml(formatDateDisplay(d))}</option>`).join("");
    select.dataset.season = String(selectedPooleanSeason);
  }
  if (!select.dataset.wired) {
    select.dataset.wired = "1";
    select.addEventListener("change", renderPartyRecap);
    document.getElementById("downloadPartyRecapBtn")?.addEventListener("click", downloadPartyRecapImage);
  }
  const recap = computePartyRecap(select.value || dates[0]);
  if (!recap) { wrap.innerHTML = '<p class="empty-state">No games that night.</p>'; return; }
  const standingsHtml = recap.standings.map(r => `<li>${poolPlayerLink(r.slug)} <span class="hint" style="margin:0">${r.w}-${r.l}</span></li>`).join("");
  const upsetsHtml = recap.upsets.length === 0 ? "" : `<p class="hint" style="margin:10px 0 0">🎲 ${recap.upsets.length} upset${recap.upsets.length === 1 ? "" : "s"} that night.</p>`;
  const climberHtml = recap.climber ? `<p class="hint" style="margin:6px 0 0">📈 Biggest climber: ${poolPlayerLink(recap.climber.slug)}, #${recap.climber.from} to #${recap.climber.to} in the season power rankings.</p>` : "";
  wrap.innerHTML = `<p class="hint" style="margin:0 0 10px">${recap.games} game${recap.games === 1 ? "" : "s"} that night.</p>
    <ul class="player-tips-list" style="display:block">${standingsHtml}</ul>${upsetsHtml}${climberHtml}`;
}

// Shareable PNG of one party night for the group chat: that night's standings and its biggest
// upset, drawn on a canvas the same way as the player trading card.
function wrapCanvasText(ctx, text, maxWidth) {
  const words = text.split(" ");
  const lines = [];
  let line = "";
  words.forEach(word => {
    const test = line ? `${line} ${word}` : word;
    if (ctx.measureText(test).width > maxWidth && line) { lines.push(line); line = word; }
    else line = test;
  });
  if (line) lines.push(line);
  return lines;
}

function generatePartyRecapCanvas(date) {
  const recap = computePartyRecap(date);
  if (!recap) return null;
  const W = 1080, rowH = 64, top = 330;
  const upset = recap.upsets[0] || null;
  const names = ids => ids.map(poolNameOf).join(" & ");
  const measure = document.createElement("canvas").getContext("2d");
  measure.font = "30px sans-serif";
  const upsetLines = upset ? wrapCanvasText(measure, `${names(upset.winners)} beat ${names(upset.losers)} (${Math.round(upset.winPct)}% vs. ${Math.round(upset.losePct)}% power ranking that night)`, W - 160) : [];
  const climber = recap.climber;
  const H = top + recap.standings.length * rowH + (upset ? 90 + upsetLines.length * 40 : 0) + (climber ? 90 : 0) + 120;
  const canvas = document.createElement("canvas");
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext("2d");
  const grad = ctx.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0, "#12212b"); grad.addColorStop(1, "#1c2e3a");
  ctx.fillStyle = grad; ctx.fillRect(0, 0, W, H);

  ctx.textAlign = "left"; ctx.textBaseline = "alphabetic";
  ctx.fillStyle = "#3FE0D4"; ctx.font = "bold 30px sans-serif";
  ctx.fillText("POOLEAN PARTY RECAP", 80, 120);
  ctx.fillStyle = "white"; ctx.font = "bold 72px sans-serif";
  ctx.fillText(formatDateDisplay(date), 80, 205);
  ctx.fillStyle = "rgba(255,255,255,0.65)"; ctx.font = "30px sans-serif";
  ctx.fillText(`${recap.games} game${recap.games === 1 ? "" : "s"} · ${recap.standings.length} players`, 80, 260);

  recap.standings.forEach((r, i) => {
    const y = top + i * rowH;
    if (i === 0) {
      ctx.fillStyle = "rgba(227,169,58,0.16)";
      ctx.fillRect(60, y - 8, W - 120, rowH - 8);
    }
    ctx.fillStyle = i === 0 ? "#E3A93A" : "rgba(255,255,255,0.45)";
    ctx.font = "bold 30px sans-serif"; ctx.textAlign = "left";
    ctx.fillText(String(i + 1), 84, y + 36);
    ctx.fillStyle = "white"; ctx.font = `${i === 0 ? "bold " : ""}34px sans-serif`;
    ctx.fillText(`${poolNameOf(r.slug)}${i === 0 ? "  👑" : ""}`, 150, y + 36);
    ctx.textAlign = "right";
    ctx.fillStyle = r.w > r.l ? "#3FE0D4" : r.w < r.l ? "#F0873A" : "rgba(255,255,255,0.8)";
    ctx.font = "bold 34px sans-serif";
    ctx.fillText(`${r.w}-${r.l}`, W - 84, y + 36);
  });

  let y = top + recap.standings.length * rowH + 40;
  if (upset) {
    ctx.textAlign = "left";
    ctx.fillStyle = "#F0873A"; ctx.font = "bold 28px sans-serif";
    ctx.fillText(`BIGGEST UPSET${recap.upsets.length > 1 ? ` (of ${recap.upsets.length})` : ""}`, 80, y);
    y += 46;
    ctx.fillStyle = "rgba(255,255,255,0.85)"; ctx.font = "30px sans-serif";
    upsetLines.forEach(line => { ctx.fillText(line, 80, y); y += 40; });
    y += 20;
  }
  if (climber) {
    ctx.textAlign = "left";
    ctx.fillStyle = "#3FE0D4"; ctx.font = "bold 28px sans-serif";
    ctx.fillText("BIGGEST CLIMBER", 80, y);
    y += 46;
    ctx.fillStyle = "rgba(255,255,255,0.85)"; ctx.font = "30px sans-serif";
    ctx.fillText(`${poolNameOf(climber.slug)}: #${climber.from} to #${climber.to} in the season rankings`, 80, y);
  }
  ctx.textAlign = "center"; ctx.fillStyle = "rgba(255,255,255,0.4)"; ctx.font = "22px sans-serif";
  ctx.fillText("Poolean", W / 2, H - 40);
  return canvas;
}

function downloadPartyRecapImage() {
  const select = document.getElementById("partyRecapSelect");
  if (!select || !select.value) return;
  const canvas = generatePartyRecapCanvas(select.value);
  if (!canvas) return;
  canvas.toBlob(blob => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `Poolean_recap_${select.value}.png`;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, "image/png");
}

// ---------- Award Race ----------
// A stats-only guess at every award for the season picked in the header: who the numbers point
// to, top 3 each. The vote is what actually counts; once a season's results are entered, each
// award shows who really won next to the projection. Most rows use the real site's data; DPOY,
// Clutch and Best Teammate have no real-site equivalent, so they use this app's own logged games.
const AWARD_RACE_DUO_MIN_GP = 5;

function computeAwardRace() {
  const cards = typeof POOLEAN_SEASON_CARDS !== "undefined" ? POOLEAN_SEASON_CARDS : null;
  const rows = [];
  const pct = n => `${Math.round(n)}%`;
  let qualified = [];
  if (cards) {
    const maxParties = Math.max(...Object.values(cards).map(c => c.parties || 0), 0);
    // At least 3 parties (or a fifth of the season, if that's more): keeps one-night cameos out
    // without dropping someone who played less but was clearly one of the best.
    const minParties = pooleanMinParties(maxParties);
    qualified = Object.entries(cards).filter(([, c]) => (c.parties || 0) >= minParties).map(([slug, c]) => ({ slug, c }));
    const byPower = [...qualified].sort((a, b) => b.c.powerPct - a.c.powerPct);
    rows.push({ key: "mvp", basis: "Most real wins", leaders: [...qualified].sort((a, b) => b.c.w - a.c.w || b.c.powerPct - a.c.powerPct).slice(0, 3).map(r => ({ ids: [r.slug], value: `${r.c.w}-${r.c.l}` })) });
    rows.push({ key: "best-player", basis: "Highest power ranking %", leaders: byPower.slice(0, 3).map(r => ({ ids: [r.slug], value: pct(r.c.powerPct) })) });
    rows.push({ key: "first-team", basis: "Power ranking %, 1st to 3rd", leaders: byPower.slice(0, 3).map(r => ({ ids: [r.slug], value: pct(r.c.powerPct) })) });
    rows.push({ key: "second-team", basis: "Power ranking %, 4th to 6th", leaders: byPower.slice(3, 6).map(r => ({ ids: [r.slug], value: pct(r.c.powerPct) })) });
    // Season MIP: first ranked night's percentile to the season-long power ranking %.
    if (typeof POOLEAN_RANKINGS !== "undefined") {
      const firstPct = {};
      [...POOLEAN_RANKINGS].sort((a, b) => a.date.localeCompare(b.date)).forEach(n => n.players.forEach(p => { if (!(p.slug in firstPct)) firstPct[p.slug] = p.pct; }));
      const risers = qualified.filter(r => r.slug in firstPct).map(r => ({ slug: r.slug, delta: r.c.powerPct - firstPct[r.slug], from: firstPct[r.slug], to: r.c.powerPct }))
        .sort((a, b) => b.delta - a.delta).slice(0, 3);
      rows.push({ key: "mip-season", basis: "First night's rank % to season %", leaders: risers.map(r => ({ ids: [r.slug], value: `${pct(r.from)} to ${pct(r.to)}` })) });
    }
    const list = pooleanSeasonList();
    const prevYear = list[list.indexOf(selectedPooleanSeason) - 1];
    const prevCards = prevYear && typeof POOLEAN_SEASONS !== "undefined" ? POOLEAN_SEASONS[prevYear]?.cards : null;
    rows.push(prevCards
      ? { key: "mip-yoy", basis: `Power ranking % vs. ${prevYear}`, leaders: qualified.filter(r => prevCards[r.slug]).map(r => ({ slug: r.slug, delta: r.c.powerPct - prevCards[r.slug].powerPct }))
          .sort((a, b) => b.delta - a.delta).slice(0, 3).map(r => ({ ids: [r.slug], value: `${r.delta >= 0 ? "+" : ""}${Math.round(r.delta)}` })) }
      : { key: "mip-yoy", basis: "Power ranking % vs. last season", leaders: [], empty: "Needs last season's data imported." });
  }
  const standings = computeAwardStandings();
  const local = (key, statKey, basis) => rows.push({ key, basis, local: true, empty: "No logged games for this yet.", leaders: (standings[statKey] || []).slice(0, 3).map(r => ({ ids: [r.player.id], value: r.display })) });
  local("dpoy", "defRating", "Defensive rating per 20");
  local("clutch", "closeGameTs", "Shooting in close games");
  local("teammate", "teammateLift", "How much teammates improve with them");
  if (typeof POOLEAN_TOGETHER !== "undefined") {
    const duos = Object.entries(POOLEAN_TOGETHER).filter(([, v]) => v.gp >= AWARD_RACE_DUO_MIN_GP)
      .map(([k, v]) => ({ ids: k.split("|"), v, rate: v.w / v.gp }));
    const fmt = d => ({ ids: d.ids, value: `${d.v.w}-${d.v.l} together` });
    rows.push({ key: "best-duo", basis: `Best record together (${AWARD_RACE_DUO_MIN_GP}+ games)`, leaders: [...duos].sort((a, b) => b.rate - a.rate || b.v.gp - a.v.gp).slice(0, 3).map(fmt) });
    rows.push({ key: "worst-duo", basis: `Worst record together (${AWARD_RACE_DUO_MIN_GP}+ games)`, leaders: [...duos].sort((a, b) => a.rate - b.rate || b.v.gp - a.v.gp).slice(0, 3).map(fmt) });
  }
  const order = Object.keys(AWARD_TIER);
  rows.sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key));
  return rows.map(r => {
    const voted = AWARD_RESULTS.find(a => a.key === r.key) || null;
    const label = voted ? voted.label : (ALL_AWARD_RESULTS.find(a => a.key === r.key) || {}).label || r.key;
    // A hit: the projected leader(s) match who actually won. Team awards compare the whole top 3.
    // A hit: the projected leader(s) match who actually won. Team awards (three winners) get
    // partial credit: how many of the projected three were actually voted onto the team.
    let hit = null, teamMatched = null;
    if (voted && r.leaders.length) {
      const winners = voted.winners;
      if (r.key.endsWith("-team")) {
        const projected = r.leaders.flatMap(l => l.ids);
        teamMatched = winners.filter(w => projected.includes(w)).length;
        hit = teamMatched === winners.length;
      } else {
        const projected = r.leaders[0].ids;
        hit = projected.length === winners.length ? winners.every(w => projected.includes(w)) : projected.every(id => winners.includes(id));
      }
    }
    return { ...r, label, voted, hit, teamMatched };
  });
}

function renderAwardRace() {
  const wrap = document.getElementById("awardRace");
  if (!wrap) return;
  const rows = computeAwardRace();
  const withLeaders = rows.filter(r => r.leaders.length || r.empty);
  if (withLeaders.length === 0) { wrap.innerHTML = '<p class="empty-state">No real-site season data or logged games yet.</p>'; return; }
  const names = ids => ids.map(poolPlayerLink).join(" + ");
  const hits = rows.filter(r => r.hit !== null);
  wrap.innerHTML = `<div class="award-race-grid">${withLeaders.map(r => {
    const color = AWARD_TIER_COLOR[AWARD_TIER[r.key]];
    const leaders = r.leaders.length
      ? `<ol class="award-race-leaders">${r.leaders.map(l => `<li>${names(l.ids)} <span class="hint" style="margin:0">${escapeHtml(l.value)}</span></li>`).join("")}</ol>`
      : `<p class="hint" style="margin:6px 0 0">${escapeHtml(r.empty || "Not enough data yet.")}</p>`;
    const mark = r.teamMatched !== null && !r.hit ? `${r.teamMatched} of ${r.voted.winners.length} · ` : r.hit === true ? "✓ " : r.hit === false ? "✗ " : "";
    const voted = r.voted ? `<p class="award-race-voted">${mark}Voted: ${r.voted.winners.map(poolPlayerLink).join(" + ")}</p>` : "";
    return `<div class="award-race-card${color ? ` award-race-${color}` : ""}">
      <div class="award-race-head"><span>${AWARD_ICONS[r.key] || "🏅"}</span><strong>${escapeHtml(r.label)}</strong></div>
      <span class="award-race-basis">${escapeHtml(r.basis)}${r.local ? " · logged games" : ""}</span>
      ${leaders}${voted}
    </div>`;
  }).join("")}</div>
  ${hits.length ? `<p class="hint" style="margin:10px 0 0">The stats picked the actual winner for ${hits.filter(r => r.hit).length} of ${hits.length} awards this season${hits.some(r => r.teamMatched && !r.hit) ? `, and got ${hits.filter(r => r.teamMatched !== null && !r.hit).map(r => `${r.teamMatched} of ${r.voted.winners.length} on ${r.label}`).join(" and ")}` : ""}.</p>` : `<p class="hint" style="margin:10px 0 0">No votes in yet for this season, so this is the stats' best guess.</p>`}`;
}

// Every player with a real award win, sorted gold-first, for a hall-of-fame style grid.
function computeTrophyCase() {
  // Every real slug that's won a tiered award, not just whoever's in this browser's local roster
  // — a real winner not added locally yet still belongs in the case, by name.
  const winnerSlugs = [...new Set(AWARD_RESULTS.flatMap(a => AWARD_TIER[a.key] ? a.winners : []))];
  return winnerSlugs
    .map(slug => ({ slug, tier: computePlayerAwardTier(slug) }))
    .filter(r => r.tier)
    .sort((a, b) => a.tier.tier - b.tier.tier);
}

function renderTrophyCase() {
  const wrap = document.getElementById("trophyCase");
  if (!wrap) return;
  const rows = computeTrophyCase();
  if (rows.length === 0) { wrap.innerHTML = '<p class="empty-state">Nobody has a real award win yet.</p>'; return; }
  wrap.innerHTML = `<div class="trophy-case-grid">${rows.map(r => {
    const local = state.players.find(p => p.id === r.slug);
    const avatarPlayer = local || { id: r.slug, name: poolNameOf(r.slug) };
    return `
    <div class="trophy-case-tile">
      ${renderPlayerAvatar(avatarPlayer, "large", playerAvatarRingClass(r.slug))}
      ${poolPlayerLink(r.slug)}
    </div>`;
  }).join("")}</div>`;
}

// ---------- Real Rivalry Matrix ----------
// The full grid behind Rivalries' four superlatives: every real together-win% at once, same
// visual language as the Matchup Grid / Teammate Lift Matrix but fed by the real site's full
// pairwise history instead of this app's own locally logged subset.
function renderRealRivalryMatrix() {
  const wrap = document.getElementById("realRivalryMatrix");
  if (!wrap) return;
  if (typeof POOLEAN_TOGETHER === "undefined") { wrap.innerHTML = '<p class="empty-state">No real-site pairwise data loaded yet.</p>'; return; }
  // Every real slug that appears in POOLEAN_TOGETHER, whether or not they're in this browser's
  // own local roster -- a real player not yet added locally still gets a row/column, by name.
  const activeSlugs = [...new Set(Object.keys(POOLEAN_TOGETHER).flatMap(k => k.split("|")))];
  if (activeSlugs.length < 2) { wrap.innerHTML = '<p class="empty-state">Not enough real-site pairwise data yet.</p>'; return; }
  const slugs = activeSlugs.sort((a, b) => poolNameOf(a).localeCompare(poolNameOf(b)));
  const maxGp = Math.max(1, ...Object.values(POOLEAN_TOGETHER).map(v => v.gp));
  const headerHtml = slugs.map(s => `<th>${poolPlayerLink(s)}</th>`).join("");
  const rows = slugs.map(rowSlug => {
    const cells = slugs.map(colSlug => {
      if (rowSlug === colSlug) return `<td class="matchup-grid-cell"></td>`;
      const v = POOLEAN_TOGETHER[[rowSlug, colSlug].sort().join("|")];
      if (!v) return `<td class="matchup-grid-cell matchup-grid-empty"></td>`;
      const pct = Math.round((v.w / v.gp) * 100);
      const hue = pct >= 50 ? 140 : 0;
      const opacity = 0.2 + 0.6 * (v.gp / maxGp);
      return `<td class="matchup-grid-cell" style="background: hsla(${hue}, 70%, 42%, ${opacity})" title="${escapeHtml(poolNameOf(rowSlug))} &amp; ${escapeHtml(poolNameOf(colSlug))}: ${v.w}-${v.l} together">${pct}%</td>`;
    }).join("");
    return `<tr><td class="sticky-col">${poolPlayerLink(rowSlug)}</td>${cells}</tr>`;
  }).join("");
  wrap.innerHTML = `<div class="table-scroll"><table class="matchup-table">
    <thead><tr><th></th>${headerHtml}</tr></thead>
    <tbody>${rows}</tbody></table></div>`;
}

// ---------- Attendance streaks ("Iron Man") ----------
// Same idea as win/loss Streaks, but for showing up: consecutive real parties attended without
// missing one, from POOLEAN_RANKINGS (already in play order). "Current" is the trailing run
// ending at the most recent real party; a player who joined partway through the season isn't
// penalized for parties before they existed, since the run only ever counts real attendance.
function computePlayerAttendanceStreak(playerId) {
  if (typeof POOLEAN_RANKINGS === "undefined") return null;
  const attended = POOLEAN_RANKINGS.map(party => party.players.some(x => x.slug === playerId));
  if (!attended.some(Boolean)) return null;
  let cur = 0, longest = 0;
  attended.forEach(a => { if (a) { cur++; longest = Math.max(longest, cur); } else cur = 0; });
  let trailing = 0;
  for (let i = attended.length - 1; i >= 0 && attended[i]; i--) trailing++;
  return { current: trailing, longest, of: POOLEAN_RANKINGS.length };
}

function renderPlayerAttendanceStreak(playerId) {
  const wrap = document.getElementById("playerAttendanceStreak");
  if (!wrap) return;
  const s = computePlayerAttendanceStreak(playerId);
  if (!s) { wrap.innerHTML = '<p class="empty-state">No real-site attendance data for this player yet.</p>'; return; }
  wrap.innerHTML = `<div class="league-rank-grid">
    <div class="league-rank-badge${s.current === s.of && s.of > 0 ? " league-rank-top" : ""}"><span class="league-rank-place">${s.current}</span><span class="league-rank-label">Current streak</span></div>
    <div class="league-rank-badge"><span class="league-rank-place">${s.longest}</span><span class="league-rank-label">Longest streak</span></div>
    <div class="league-rank-badge"><span class="league-rank-place">${s.of}</span><span class="league-rank-label">Real parties total</span></div>
  </div>`;
}

// League-wide: whoever holds the longest attendance streak of anyone on the roster.
// Every player tied for the longest real attendance streak, not just whoever happens to come
// first in roster order — a real tie (e.g. two players who've both made every party) should show
// as a tie, not silently pick a winner.
function computeIronMan() {
  if (typeof POOLEAN_RANKINGS === "undefined") return null;
  // Every real slug (POOLEAN_NAMES), not just this browser's local roster -- a real player who
  // hasn't been added locally yet can still hold (or share) the real attendance streak.
  const slugs = typeof POOLEAN_NAMES !== "undefined" ? Object.keys(POOLEAN_NAMES) : state.players.map(p => p.id);
  const all = slugs
    .map(slug => ({ slug, streak: computePlayerAttendanceStreak(slug) }))
    .filter(r => r.streak);
  if (all.length === 0) return null;
  const longest = Math.max(...all.map(r => r.streak.longest));
  return { holders: all.filter(r => r.streak.longest === longest), longest, of: all[0].streak.of };
}

function renderIronMan() {
  const wrap = document.getElementById("ironManPanel");
  if (!wrap) return;
  const result = computeIronMan();
  if (!result) { wrap.innerHTML = '<p class="empty-state">No real-site attendance data loaded yet.</p>'; return; }
  const names = result.holders.map(r => poolPlayerLink(r.slug)).join(", ");
  wrap.innerHTML = `<div class="real-partner-tile">
    <span class="real-partner-label">Iron Man${result.holders.length > 1 ? " (tied)" : ""}</span>
    <span>${names}</span>
    <span class="real-partner-pct">${result.longest} real part${result.longest === 1 ? "y" : "ies"} in a row, out of ${result.of} total</span>
  </div>`;
}

// ---------- Comeback Tracker ----------
// Different data source than the six panels above: this app's own locally logged shot-by-shot
// games (which carry real videoTime, so a running score can be reconstructed), not the real
// site's game-result-only data. For each qualifying game with a clear winner, replays every made
// shot in videoTime order and finds the largest deficit the eventual winner ever faced.
function computeComebacks() {
  const results = [];
  state.games.filter(isQualifyingGame).forEach(game => {
    if (!game.teamA || !game.teamB || game.teamA.length === 0 || game.teamB.length === 0) return;
    const events = game.scoringEvents
      .filter(ev => ev.made !== false && ev.videoTime !== null && ev.videoTime !== undefined && (ev.points === 1 || ev.points === 2 || ev.points === 3))
      .sort((a, b) => a.videoTime - b.videoTime);
    if (events.length === 0) return;
    const finalA = teamScore(game, game.teamA), finalB = teamScore(game, game.teamB);
    if (finalA === finalB) return; // no winner, nothing to have come back from
    const winnerIsA = finalA > finalB;
    let a = 0, b = 0, maxDeficit = 0;
    events.forEach(ev => {
      if (game.teamA.includes(ev.scorerId)) a += ev.points;
      else if (game.teamB.includes(ev.scorerId)) b += ev.points;
      const deficit = winnerIsA ? b - a : a - b;
      if (deficit > maxDeficit) maxDeficit = deficit;
    });
    if (maxDeficit > 0) {
      results.push({
        game, deficit: maxDeficit,
        winner: winnerIsA ? game.teamA : game.teamB, loser: winnerIsA ? game.teamB : game.teamA,
        finalWinner: winnerIsA ? finalA : finalB, finalLoser: winnerIsA ? finalB : finalA
      });
    }
  });
  results.sort((a, b) => b.deficit - a.deficit);
  return results;
}

function renderComebackTracker() {
  const wrap = document.getElementById("comebackTracker");
  if (!wrap) return;
  const results = computeComebacks();
  if (results.length === 0) { wrap.innerHTML = '<p class="empty-state">No reviewed games with a timestamped comeback yet.</p>'; return; }
  const teamNames = ids => ids.map(id => { const p = state.players.find(x => x.id === id); return p ? playerLink(p.id, p.name) : "?"; }).join(" & ");
  const rows = results.slice(0, 10).map(r => `
    <tr>
      <td>${escapeHtml(formatDateDisplay(r.game.date))}</td>
      <td>${teamNames(r.winner)}</td>
      <td>${teamNames(r.loser)}</td>
      <td>down ${r.deficit}</td>
      <td>${r.finalWinner}-${r.finalLoser}</td>
    </tr>`).join("");
  wrap.innerHTML = `<div class="table-scroll"><table class="matchup-table">
    <thead><tr><th>Date</th><th>Came back</th><th>Against</th><th>Biggest deficit</th><th>Final</th></tr></thead>
    <tbody>${rows}</tbody></table></div>
    <p class="hint" style="margin:10px 0 0">${results.length} game${results.length === 1 ? "" : "s"} with a real comeback, biggest deficit first.</p>`;
}

// ---------- Player Trading Card (canvas image export) ----------
// Draws a shareable card straight to a <canvas> (avatar + ring, name, real record, power ranking,
// top real award wins) and downloads it as a PNG. No library — a photo (if this player has one)
// is loaded as an <img> and clipped to a circle; an initial avatar is drawn the same way
// renderPlayerAvatar() would color it, so the card matches the rest of the app.
const TRADING_CARD_TIER_COLORS = {
  gold: ["#3a2f14", "#E3A93A"], silver: ["#0d2b29", "#3FE0D4"], bronze: ["#3a2210", "#F0873A"]
};
async function generateTradingCardCanvas(playerId) {
  const player = state.players.find(p => p.id === playerId);
  if (!player) return null;
  const tier = computePlayerAwardTier(playerId);
  const real = poolRealRecord(playerId);
  const power = computePowerRankingSummary(playerId);
  const row = computeLeaderboard().find(r => r.player.id === playerId);
  const badges = computePlayerAwardBadges(playerId).filter(b => b.isWinner).slice(0, 3);
  const W = 600, H = 880;
  const canvas = document.createElement("canvas");
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext("2d");
  const [bg1, bg2] = tier ? TRADING_CARD_TIER_COLORS[tier.color] : ["#12212b", "#1c2e3a"];
  const grad = ctx.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0, bg1); grad.addColorStop(1, bg2);
  ctx.fillStyle = grad; ctx.fillRect(0, 0, W, H);

  const cx = W / 2, cy = 230, r = 110;
  ctx.save();
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.closePath(); ctx.clip();
  const photoFile = PLAYER_PHOTO_FILES[player.id];
  if (photoFile) {
    const img = await new Promise(res => { const im = new Image(); im.onload = () => res(im); im.onerror = () => res(null); im.src = `photos/${photoFile}`; });
    if (img) ctx.drawImage(img, cx - r, cy - r, r * 2, r * 2);
    else { ctx.fillStyle = "#333"; ctx.fillRect(cx - r, cy - r, r * 2, r * 2); }
  } else {
    const hue = avatarHueForPlayer(player.id);
    ctx.fillStyle = `hsl(${hue}, 55%, 42%)`;
    ctx.fillRect(cx - r, cy - r, r * 2, r * 2);
    ctx.fillStyle = "white";
    ctx.font = "bold 120px sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText((player.name.trim().charAt(0) || "?").toUpperCase(), cx, cy + 10);
  }
  ctx.restore();
  if (tier) {
    ctx.lineWidth = 10; ctx.strokeStyle = TRADING_CARD_TIER_COLORS[tier.color][1];
    ctx.beginPath(); ctx.arc(cx, cy, r + 8, 0, Math.PI * 2); ctx.stroke();
  }

  ctx.fillStyle = "white"; ctx.font = "bold 48px sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "alphabetic";
  ctx.fillText(player.name, W / 2, 395);

  let y = 450;
  ctx.font = "28px sans-serif"; ctx.fillStyle = "rgba(255,255,255,0.85)";
  if (real) { ctx.fillText(`Real Record: ${real.w}-${real.l}`, W / 2, y); y += 42; }
  if (power) { ctx.fillText(`Power Ranking: ${Math.round(power.avgPct)}%`, W / 2, y); y += 42; }
  y += 10;
  // Statline: the same per-20 core numbers shown on the profile header itself, so the card
  // carries this app's own local read alongside the real site's data above it.
  if (row) {
    const tsPct = trueShootingPct(row.totals.pts, row.shooting.fga, row.shooting.fta);
    ctx.font = "22px sans-serif"; ctx.fillStyle = "rgba(255,255,255,0.75)";
    ctx.fillText(`${row.rate.pts.toFixed(1)} PTS/20 · ${row.rate.ast.toFixed(1)} AST/20${tsPct !== null ? ` · ${tsPct}% TS` : ""} · ${row.twoWayPer20.toFixed(1)} Two-Way/20`, W / 2, y);
    y += 40;
  }
  y += 12;
  ctx.font = "24px sans-serif"; ctx.fillStyle = "rgba(255,255,255,0.85)";
  badges.forEach(b => { ctx.fillText(`${b.icon} ${b.label}`, W / 2, y); y += 36; });

  ctx.font = "16px sans-serif"; ctx.fillStyle = "rgba(255,255,255,0.5)";
  ctx.fillText("Poolean", W / 2, H - 30);
  return canvas;
}

async function downloadTradingCard(playerId) {
  const canvas = await generateTradingCardCanvas(playerId);
  if (!canvas) return;
  const player = state.players.find(p => p.id === playerId);
  canvas.toBlob(blob => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `${(player.name || "player").replace(/\s+/g, "_")}_card.png`;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, "image/png");
}

// ---------- Season Timeline ----------
// One chronological scroll of the real season's story: who held the crown each real party night,
// and any upsets that same night (from computeUpsets(), grouped by date) -- a narrative reading
// of the same facts Season Recap and Upset Tracker already show as static summaries.
function computeSeasonTimeline() {
  if (typeof POOLEAN_RANKINGS === "undefined") return null;
  const upsetsByDate = {};
  (computeUpsets() || []).forEach(u => { (upsetsByDate[u.date] = upsetsByDate[u.date] || []).push(u); });
  return [...POOLEAN_RANKINGS].sort((a, b) => a.date.localeCompare(b.date)).map(party => {
    const crown = party.players.find(p => p.rank === 1);
    return { date: party.date, crownSlug: crown ? crown.slug : null, fieldSize: party.players.length, upsets: upsetsByDate[party.date] || [] };
  });
}

function renderSeasonTimeline() {
  const wrap = document.getElementById("seasonTimeline");
  if (!wrap) return;
  const entries = computeSeasonTimeline();
  if (!entries) { wrap.innerHTML = '<p class="empty-state">No real-site data loaded yet.</p>'; return; }
  wrap.innerHTML = `<ul class="season-timeline-list">${entries.map(e => `
    <li class="season-timeline-item">
      <span class="season-timeline-date">${escapeHtml(formatDateDisplay(e.date))}</span>
      <span class="season-timeline-body">
        ${e.crownSlug ? `👑 ${poolPlayerLink(e.crownSlug)} took the crown (${e.fieldSize} ranked)` : `${e.fieldSize} players ranked`}
        ${e.upsets.length > 0 ? `<br><span class="hint" style="margin:0">🎲 ${e.upsets.length} upset${e.upsets.length === 1 ? "" : "s"} that night</span>` : ""}
      </span>
    </li>`).join("")}</ul>`;
}

function renderPlayerAwardBadges(playerId) {
  const wrap = document.getElementById("playerAwardBadges");
  if (!wrap) return;
  const badges = computePlayerAwardBadges(playerId);
  if (badges.length === 0) {
    wrap.innerHTML = '<p class="empty-state">No award wins or runner-up finishes for this player yet.</p>';
    return;
  }
  // Marquee: only when they hold a tier-1 (gold) win from the latest season with awards, skipped
  // entirely otherwise, never an empty placeholder version.
  const latestAwardSeason = Math.max(...ALL_AWARD_RESULTS.map(a => a.season));
  const goldWin = badges.find(b => b.isWinner && b.tier === 1 && b.season === latestAwardSeason);
  const marquee = goldWin ? `
    <div class="award-marquee">
      <span class="award-marquee-icon">${goldWin.icon}</span>
      <span class="award-marquee-text"><strong>${escapeHtml(goldWin.label)}</strong><span>${goldWin.season} · reigning</span></span>
    </div>` : "";
  const grid = badges.map(b => {
    const untiered = !b.color; // Worst Duo: deliberately never gold/silver/bronze, never a ring
    const cls = untiered ? "award-badge award-badge-untiered" : `award-badge award-badge-${b.color}`;
    let sub = escapeHtml(b.placementLabel);
    if (b.partnerName) {
      const seasonTogether = typeof POOLEAN_SEASONS !== "undefined" ? POOLEAN_SEASONS[String(b.season)]?.together : null;
      const together = seasonTogether ? seasonTogether[[playerId, b.partnerId].sort().join("|")] : null;
      const withPart = `with ${escapeHtml(b.partnerName)}${together ? ` · ${together.w}-${together.l} together` : ""}`;
      sub = `${escapeHtml(b.placementLabel)} · ${withPart}`;
    }
    return `<span class="${cls}">
      <span class="award-badge-icon">${b.icon}</span>
      <span class="award-badge-label">${escapeHtml(b.label)}</span>
      <span class="award-badge-sub">${sub}</span>
    </span>`;
  }).join("");
  wrap.innerHTML = `${marquee}<div class="award-badge-grid">${grid}</div>`;
}

function renderPlayerPowerRanking(playerId) {
  const wrap = document.getElementById("playerPowerRanking");
  if (!wrap) return;
  const summary = computePowerRankingSummary(playerId);
  if (!summary) {
    wrap.innerHTML = '<p class="empty-state">No real-site power ranking history for this player yet.</p>';
    return;
  }
  wrap.innerHTML = `
    <div class="league-rank-grid">
      <div class="league-rank-badge"><span class="league-rank-place">${Math.round(summary.avgPct)}%</span><span class="league-rank-label">Season average</span></div>
      <div class="league-rank-badge${summary.firsts > 0 ? " league-rank-top" : ""}"><span class="league-rank-place">${summary.firsts}×</span><span class="league-rank-label">Times at #1</span></div>
      <div class="league-rank-badge"><span class="league-rank-place">${summary.of}</span><span class="league-rank-label">of ${summary.of} parties</span></div>
    </div>`;
}

function renderPlayerRealRecord(playerId) {
  const wrap = document.getElementById("playerRealRecord");
  if (!wrap) return;
  const real = poolRealRecord(playerId);
  if (!real) {
    wrap.innerHTML = '<p class="empty-state">No real-site game record for this player yet.</p>';
    return;
  }
  const row = computeLeaderboard().find(r => r.player.id === playerId);
  const loggedGp = row ? row.gp : 0;
  const loggedRecord = row ? `${row.wins}-${row.losses}${row.ties ? `-${row.ties}` : ""}` : "0-0";
  const realWinPct = real.gp > 0 ? Math.round((real.w / real.gp) * 100) : 0;
  wrap.innerHTML = `
    <div class="league-rank-grid">
      <div class="league-rank-badge"><span class="league-rank-place">${real.w}-${real.l}</span><span class="league-rank-label">Real record</span></div>
      <div class="league-rank-badge"><span class="league-rank-place">${realWinPct}%</span><span class="league-rank-label">Real win rate</span></div>
      <div class="league-rank-badge"><span class="league-rank-place">${real.gp}</span><span class="league-rank-label">Real games</span></div>
    </div>
    <p class="hint" style="margin:10px 0 0">Reviewed in this app: <strong>${escapeHtml(loggedRecord)}</strong> across ${loggedGp} game${loggedGp === 1 ? "" : "s"}, ${real.gp > 0 ? `${Math.round((loggedGp / real.gp) * 100)}% of the real total` : "—"}.</p>`;
}

const REAL_PARTNER_MIN_GP = 3; // "Needs at least 3 games together to count" (matches the real site's own bar)

// Best/worst teammate and best/worst opponent for one player, from the real site's full pairwise
// history (POOLEAN_TOGETHER/POOLEAN_AGAINST) rather than this app's own locally logged subset —
// almost always a bigger, steadier sample. AGAINST is directional (this player's own record facing
// each opponent), TOGETHER is the shared record with each teammate.
function computePlayerRealPartners(playerId) {
  if (typeof POOLEAN_TOGETHER === "undefined") return null;
  const withRows = [], againstRows = [];
  state.players.forEach(p => {
    if (p.id === playerId) return;
    const t = POOLEAN_TOGETHER[[playerId, p.id].sort().join("|")];
    if (t && t.gp >= REAL_PARTNER_MIN_GP) withRows.push({ player: p, w: t.w, l: t.l, gp: t.gp, pct: t.w / t.gp });
    const a = POOLEAN_AGAINST[`${playerId}|${p.id}`];
    if (a && a.gp >= REAL_PARTNER_MIN_GP) againstRows.push({ player: p, w: a.w, l: a.l, gp: a.gp, pct: a.w / a.gp });
  });
  if (withRows.length === 0 && againstRows.length === 0) return null;
  const best = rows => rows.length ? rows.reduce((a, b) => (b.pct > a.pct ? b : a)) : null;
  const worst = rows => rows.length ? rows.reduce((a, b) => (b.pct < a.pct ? b : a)) : null;
  return { bestWith: best(withRows), worstWith: worst(withRows), bestAgainst: best(againstRows), worstAgainst: worst(againstRows) };
}

function renderPlayerRealPartners(playerId) {
  const wrap = document.getElementById("playerRealPartners");
  if (!wrap) return;
  const p = computePlayerRealPartners(playerId);
  if (!p) {
    wrap.innerHTML = `<p class="empty-state">Needs at least ${REAL_PARTNER_MIN_GP} real games together or against someone to show a split.</p>`;
    return;
  }
  const tile = (label, entry) => !entry ? "" : `
    <div class="real-partner-tile">
      <span class="real-partner-label">${label}</span>
      ${playerLink(entry.player.id, entry.player.name)}
      <span class="real-partner-record">${entry.w}-${entry.l}</span>
      <span class="real-partner-pct">${Math.round(entry.pct * 100)}%</span>
    </div>`;
  wrap.innerHTML = `<div class="real-partner-grid">
    ${tile("Best with", p.bestWith)}${tile("Worst with", p.worstWith)}
    ${tile("Best against", p.bestAgainst)}${tile("Worst against", p.worstAgainst)}
  </div>
  <p class="hint" style="margin:10px 0 0">Needs at least ${REAL_PARTNER_MIN_GP} real games together (or against) to count.</p>`;
}

function computeAwardsVsStats() {
  const standings = computeAwardStandings();

  return AWARD_RESULTS.map(award => {
    const ranking = award.statKey ? standings[award.statKey] : null;
    const winners = award.winners.map(slug => {
      const player = state.players.find(p => p.id === slug);
      let detail = "No directly comparable tracked stat";
      if (ranking) {
        const idx = ranking.findIndex(r => r.player.id === slug);
        detail = idx === -1
          ? (AWARD_NOT_FOUND_TEXT[award.statKey] || "No games logged yet")
          : `${ranking[idx].display} (#${idx + 1} of ${ranking.length})`;
      }
      return { slug, player, detail };
    });
    let duoDetail = null;
    if (award.isDuo && award.winners.length === 2) {
      const [aId, bId] = award.winners;
      const total = computeAssistConnections()
        .filter(c => (c.passer.id === aId && c.scorer.id === bId) || (c.passer.id === bId && c.scorer.id === aId))
        .reduce((sum, c) => sum + c.count, 0);
      duoDetail = total > 0 ? `${total} assist${total === 1 ? "" : "s"} between them, either direction` : "No assist connections between them logged yet";
    }
    return { ...award, winners, duoDetail, standings: ranking || [] };
  });
}

// Which award cards currently have their full standings expanded — a plain module-level Set
// rather than anything stored, since it's just this render's UI state, not app data. Persists
// across re-renders within a session (e.g. after a stat-changing edit elsewhere) but resets on
// reload, which is fine for a "let me peek at the full list" interaction.
let expandedAwards = new Set();

function renderAwardsVsStats() {
  const wrap = document.getElementById("awardsVsStats");
  if (!wrap) return;
  wrap.innerHTML = "";
  computeAwardsVsStats().forEach(award => {
    const row = document.createElement("div");
    row.className = "award-row";
    const isExpanded = expandedAwards.has(award.key);
    const winnersHtml = award.winners.map(w => `
      <div class="award-winner">
        <span class="award-winner-name">${w.player ? playerLink(w.player.id, w.player.name) : `${escapeHtml(w.slug)} (not in current roster)`}</span>
        <span class="hint" style="margin:0">${escapeHtml(w.detail)}</span>
      </div>
    `).join("");
    const votedHtml = award.votedStandings && award.votedStandings.length > 0
      ? `<ol class="award-standings">${award.votedStandings.map(v => { const vp = state.players.find(pl => pl.id === v.slug); return `<li><span class="award-standings-name">${vp ? playerLink(vp.id, v.name) : escapeHtml(v.name)}</span><span class="hint" style="margin:0">${v.points} pt${v.points === 1 ? "" : "s"}</span></li>`; }).join("")}</ol>`
      : '<p class="empty-state" style="margin:0">No ballot data for this award.</p>';
    const statHtml = award.standings.length > 0
      ? `<ol class="award-standings">${award.standings.map(s => `<li><span class="award-standings-name">${playerLink(s.player.id, s.player.name)}</span><span class="hint" style="margin:0">${escapeHtml(s.display)}</span></li>`).join("")}</ol>`
      : '<p class="empty-state" style="margin:0">No standings yet for this stat.</p>';
    const standingsHtml = isExpanded
      ? `
        <div class="award-standings-col">
          <h4 class="award-standings-heading">How the vote went</h4>
          ${votedHtml}
        </div>
        <div class="award-standings-col">
          <h4 class="award-standings-heading">Stat standings</h4>
          ${statHtml}
        </div>
      `
      : "";
    row.innerHTML = `
      <button type="button" class="award-toggle" aria-expanded="${isExpanded}">
        <span class="award-label">${escapeHtml(award.label)}</span>
        <span class="award-toggle-icon">${isExpanded ? "▲ Hide standings" : "▼ See standings"}</span>
      </button>
      <div class="award-winners">${winnersHtml}</div>
      ${award.duoDetail ? `<div class="hint" style="margin:4px 0 0">${escapeHtml(award.duoDetail)}</div>` : ""}
      <div class="award-standings-wrap">${standingsHtml}</div>
    `;
    row.querySelector(".award-toggle").addEventListener("click", () => {
      if (expandedAwards.has(award.key)) expandedAwards.delete(award.key);
      else expandedAwards.add(award.key);
      renderAwardsVsStats();
    });
    wrap.appendChild(row);
  });
}

// Historical per-party ("night") power rankings — Adam's real site computes a rank/percentile
// per player per party and averages those into a season-long "power ranking" number; this is
// that same frozen historical record, not something this tool derives. RANK 1 is best that
// night; PCT is field-size-normalized (100 = first place that night), same definition the site
// uses. Sourced from POOLEAN_RANKINGS (poolean-external-data.js, built by build_poolean_data.py
// from the real site's own data export) when that file is loaded; falls back to just the nights
// that also have logged game film if it isn't, so this still works before anyone's run the export.
const PARTY_RANKINGS = typeof POOLEAN_RANKINGS !== "undefined" ? POOLEAN_RANKINGS : [
  { date: "2026-07-29", players: [
    { slug: "ben", rank: 1, fieldSize: 5, pct: 100 }, { slug: "adam", rank: 2, fieldSize: 5, pct: 75 },
    { slug: "zach", rank: 3, fieldSize: 5, pct: 50 }, { slug: "g-ian", rank: 4, fieldSize: 5, pct: 25 },
    { slug: "g-michael-t", rank: 5, fieldSize: 5, pct: 0 }
  ] },
  { date: "2026-08-02", players: [
    { slug: "ben", rank: 1, fieldSize: 5, pct: 100 }, { slug: "adam", rank: 2, fieldSize: 5, pct: 75 },
    { slug: "zach", rank: 3, fieldSize: 5, pct: 50 }, { slug: "g-ian", rank: 4, fieldSize: 5, pct: 25 },
    { slug: "g-lukas", rank: 5, fieldSize: 5, pct: 0 }
  ] },
  { date: "2026-08-05", players: [
    { slug: "zach", rank: 1, fieldSize: 6, pct: 100 }, { slug: "ben", rank: 2, fieldSize: 6, pct: 80 },
    { slug: "reilly", rank: 3, fieldSize: 6, pct: 60 }, { slug: "adam", rank: 4, fieldSize: 6, pct: 40 },
    { slug: "logan-watson", rank: 5, fieldSize: 6, pct: 20 }, { slug: "g-lukas", rank: 6, fieldSize: 6, pct: 0 }
  ] },
  { date: "2026-08-10", players: [
    { slug: "evan", rank: 1, fieldSize: 9, pct: 100 }, { slug: "zach", rank: 2, fieldSize: 9, pct: 87.5 },
    { slug: "reilly", rank: 3, fieldSize: 9, pct: 75 }, { slug: "adam", rank: 4, fieldSize: 9, pct: 62.5 },
    { slug: "ben", rank: 5, fieldSize: 9, pct: 50 }, { slug: "alex", rank: 6, fieldSize: 9, pct: 37.5 },
    { slug: "g-lukas", rank: 7, fieldSize: 9, pct: 25 }, { slug: "g-ian", rank: 8, fieldSize: 9, pct: 12.5 },
    { slug: "viraj", rank: 9, fieldSize: 9, pct: 0 }
  ] },
  { date: "2026-08-16", players: [
    { slug: "adam", rank: 1, fieldSize: 5, pct: 100 }, { slug: "zach", rank: 2, fieldSize: 5, pct: 75 },
    { slug: "ben", rank: 3, fieldSize: 5, pct: 50 }, { slug: "sean", rank: 4, fieldSize: 5, pct: 25 },
    { slug: "alex", rank: 5, fieldSize: 5, pct: 0 }
  ] }
];

// Season-long power ranking summary for one player, straight off the full real-site history
// (every party night, not just the ones with logged film -- unlike computePowerRankingVsPerformance()
// above, which needs a reviewed game to compare against and so only covers a handful of nights).
function computePowerRankingSummary(playerId) {
  const nights = PARTY_RANKINGS.filter(party => party.players.some(p => p.slug === playerId));
  if (nights.length === 0) return null;
  // The site's own frozen season line (POOLEAN_SEASON_CARDS), when available, instead of
  // recomputing the average here — matches the site exactly rather than approximating it.
  const card = typeof POOLEAN_SEASON_CARDS !== "undefined" ? POOLEAN_SEASON_CARDS[playerId] : null;
  if (card) return { avgPct: card.powerPct, firsts: card.crowns, of: card.parties, nights };
  let pctSum = 0, firsts = 0;
  nights.forEach(party => {
    const p = party.players.find(x => x.slug === playerId);
    pctSum += p.pct;
    if (p.rank === 1) firsts++;
  });
  return { avgPct: pctSum / nights.length, firsts, of: nights.length, nights };
}

// Real overall win-loss for one player across every game the site has ever recorded (POOLEAN_RECORD,
// same source file as above) -- almost always more games than this app's own locally logged subset,
// since re-logging a game shot-by-shot from film is real work nobody's caught up on for every game.
function poolRealRecord(playerId) {
  return typeof POOLEAN_RECORD !== "undefined" ? POOLEAN_RECORD[playerId] || null : null;
}

// For each historical party, pairs its frozen power ranking with that same player's *actual*
// per-20 performance in just the games logged for that date — scoped per player to the games
// they themselves appeared in that night (not every game logged that date), same "only games
// with real shots logged count" rule as everywhere else. Computed live, every render; only the
// ranking side is the frozen historical record. A night where nobody's game has been reviewed
// yet is dropped entirely — it would otherwise render as an all-"—" table telling you nothing.
function computePowerRankingVsPerformance() {
  return PARTY_RANKINGS.map(party => {
    // Excludes stoppedEarly games: "that night's Two-Way/20" is exactly the single-game case a
    // partial game would distort undiluted (see poolean-stopped-early-spec.md).
    const gamesThatNight = state.games.filter(g => g.date === party.date && isQualifyingGame(g) && !g.stoppedEarly);
    const rows = party.players.map(pr => {
      const player = state.players.find(p => p.id === pr.slug);
      const gamesPlayed = player ? gamesThatNight.filter(g => g.teamA.includes(pr.slug) || g.teamB.includes(pr.slug)) : [];
      const perf = gamesPlayed.length > 0 ? computeRateSummaryForGames(pr.slug, gamesPlayed) : null;
      return { slug: pr.slug, player, rank: pr.rank, fieldSize: pr.fieldSize, pct: pr.pct, perf };
    });
    return { date: party.date, players: rows };
  }).filter(party => party.players.some(r => r.perf !== null));
}

function renderPowerRankingVsPerformance() {
  const wrap = document.getElementById("powerRankingVsPerformance");
  if (!wrap) return;
  const parties = computePowerRankingVsPerformance();
  if (parties.length === 0) {
    wrap.innerHTML = '<p class="empty-state">No games reviewed yet for any night with a power ranking.</p>';
    return;
  }
  wrap.innerHTML = "";
  parties.forEach(party => {
    const section = document.createElement("div");
    section.className = "power-ranking-night";
    const rowsHtml = party.players.map(r => `
      <tr>
        <td>${r.rank} <span class="hint" style="margin:0">(of ${r.fieldSize})</span></td>
        <td>${r.player ? playerLink(r.player.id, r.player.name) : `${escapeHtml(r.slug)} (not in current roster)`}</td>
        <td>${r.pct}%</td>
        <td>${r.perf ? `${r.perf.twoWayPer20.toFixed(1)} <span class="hint" style="margin:0">(${r.perf.gp} game${r.perf.gp === 1 ? "" : "s"})</span>` : "—"}</td>
      </tr>
    `).join("");
    section.innerHTML = `
      <h4>${escapeHtml(formatDateDisplay(party.date))}</h4>
      <div class="table-scroll">
        <table class="matchup-table">
          <thead><tr><th>Power Rank</th><th>Player</th><th>Power %</th><th>Two-Way/20 That Night</th></tr></thead>
          <tbody>${rowsHtml}</tbody>
        </table>
      </div>
    `;
    wrap.appendChild(section);
  });
}

// One SVG "dot" per player on a scatter chart — the same colored-initial identity as
// renderPlayerAvatar() elsewhere (roster, Leaderboard, Player Detail header), just drawn as
// SVG circle+text instead of an HTML span, and hash-based on the player's own id rather than
// their position in this render's data array — so a player is always the same color on every
// chart and every other view in the app, not a color that happens to depend on sort order or
// who else is in the room. Replaced an earlier index-cycling categorical palette (Okabe-Ito)
// that gave the same player a different color on every render depending on array order.
// `label` overrides the default photo/initial with something else (e.g. a rank number for the
// Two-Way/20 Rank Over the Season chart below) — same dot, same color, a number takes priority
// over a photo there since the number is the actual information that chart needs at a glance.
// With no override, a real photo (PLAYER_PHOTO_FILES, same as renderPlayerAvatar()'s HTML
// version) draws as a circle-clipped SVG <image> when one exists for this player, falling back to
// the colored-initial circle otherwise. The clip path's id is randomized per call — multiple
// charts render their own <svg> on the same page simultaneously, and DOM ids must stay unique
// across the whole document, not just within one <svg>.
function svgAvatarDot(player, cx, cy, r = 9, label = null) {
  const hue = avatarHueForPlayer(player.id);
  const photoFile = label === null ? PLAYER_PHOTO_FILES[player.id] : null;
  if (photoFile) {
    const clipId = `avatarClip-${player.id}-${Math.random().toString(36).slice(2, 8)}`;
    // The border ring uses its own .quadrant-dot-ring class, not .quadrant-dot — CSS `fill`
    // beats an SVG presentation attribute in the cascade, so a plain `fill="none"` on a
    // `.quadrant-dot`-classed circle would still paint solid (that class sets `fill:
    // var(--accent)`), completely covering the photo underneath. Learned this the hard way: it
    // rendered as a plain colored dot with the image invisibly stuck behind it.
    return `
      <clipPath id="${clipId}"><circle cx="${cx}" cy="${cy}" r="${r}" /></clipPath>
      <image href="photos/${photoFile}" x="${cx - r}" y="${cy - r}" width="${r * 2}" height="${r * 2}" clip-path="url(#${clipId})" preserveAspectRatio="xMidYMid slice" />
      <circle cx="${cx}" cy="${cy}" r="${r}" class="quadrant-dot-ring" />
    `;
  }
  const displayLabel = label !== null ? String(label) : (player.name.trim().charAt(0) || "?").toUpperCase();
  return `
    <circle cx="${cx}" cy="${cy}" r="${r}" style="fill:hsl(${hue}, 55%, 42%)" class="quadrant-dot" />
    <text x="${cx}" y="${cy}" text-anchor="middle" dominant-baseline="central" class="quadrant-dot-initial">${escapeHtml(displayLabel)}</text>
  `;
}

// One dot per player: Off Rating/20 on the x-axis, Def Rating/20 on the y-axis — the two
// halves of Two-Way Score, plotted separately instead of pre-summed, so "who's actually good"
// splits into "good at what." The quadrant split is at 0 on both axes rather than the data's
// median, since 0 is already the meaningful boundary each stat uses on its own (0 Off Rating/20
// is replacement-level offense; 0 Def Rating is "no steals, no unstopped blocks, and stops
// minus times beaten minus points allowed net zero"), not an arbitrary line drawn through
// wherever this particular roster happens to cluster.
function computeQuadrantData() {
  return computeLeaderboard()
    .filter(r => r.gp > 0)
    .map(r => ({ player: r.player, offRtg: r.offRatingPer20, defRtg: defensiveRating(r.rate, r.rateDefense) }));
}

function renderQuadrantChart() {
  const wrap = document.getElementById("quadrantChart");
  if (!wrap) return;
  const data = computeQuadrantData();
  if (data.length === 0) {
    wrap.innerHTML = '<p class="empty-state">No games logged yet.</p>';
    return;
  }
  const W = 340, H = 340, PAD = 46;
  const plotW = W - PAD * 2, plotH = H - PAD * 2;
  const maxAbsX = Math.max(1, ...data.map(d => Math.abs(d.offRtg))) * 1.15;
  const maxAbsY = Math.max(1, ...data.map(d => Math.abs(d.defRtg))) * 1.15;
  const xScale = v => PAD + ((v + maxAbsX) / (2 * maxAbsX)) * plotW;
  const yScale = v => PAD + plotH - ((v + maxAbsY) / (2 * maxAbsY)) * plotH;
  const zeroX = xScale(0), zeroY = yScale(0);

  const dotsSvg = data.map(d => {
    const cx = xScale(d.offRtg), cy = yScale(d.defRtg);
    return `
      <g>
        <title>${escapeHtml(d.player.name)}: ${d.offRtg.toFixed(1)} Off Rating/20, ${d.defRtg.toFixed(1)} Def Rating/20</title>
        ${svgAvatarDot(d.player, cx, cy)}
      </g>
      <text x="${cx}" y="${cy - 12}" text-anchor="middle" class="quadrant-label">${escapeHtml(d.player.name)}</text>
    `;
  }).join("");

  wrap.innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" class="quadrant-svg">
      <text x="${PAD + 4}" y="${PAD + 14}" class="quadrant-corner-label">Defense-first</text>
      <text x="${W - PAD - 4}" y="${PAD + 14}" text-anchor="end" class="quadrant-corner-label">Two-way standout</text>
      <text x="${PAD + 4}" y="${H - PAD - 6}" class="quadrant-corner-label">Below average both</text>
      <text x="${W - PAD - 4}" y="${H - PAD - 6}" text-anchor="end" class="quadrant-corner-label">Offense-first</text>
      <line x1="${PAD}" y1="${zeroY}" x2="${W - PAD}" y2="${zeroY}" class="quadrant-axis" />
      <line x1="${zeroX}" y1="${PAD}" x2="${zeroX}" y2="${H - PAD}" class="quadrant-axis" />
      ${dotsSvg}
      <text x="${W - PAD}" y="${H - PAD + 16}" text-anchor="end" class="quadrant-axis-label">Off Rating/20 &#8594;</text>
      <text x="4" y="${PAD - 10}" text-anchor="start" class="quadrant-axis-label">&#8593; Def Rating/20</text>
    </svg>
  `;
}

// Volume vs. Efficiency — offense only, deliberately separate from the Two-Way Quadrant above
// (which plots Off Rating against Def Rating). This one is x = shot volume (FGA/20, "how much they
// shoot"), y = TS% (season, same formula as the main Leaderboard table's TS% column, "how well
// they shoot") — the pairing that shows a high-volume/low-efficiency player and a low-volume/
// high-efficiency player as mirror opposites directly, instead of needing someone to
// cross-reference the FGA and TS% columns on the main table by hand.
function computeVolumeEfficiencyData() {
  return computeLeaderboard()
    .filter(r => r.gp > 0)
    .map(r => ({ player: r.player, volume: r.rateShooting.fga, ts: trueShootingPct(r.totals.pts, r.shooting.fga, r.shooting.fta) }))
    .filter(r => r.ts !== null);
}

function renderVolumeEfficiencyChart() {
  const wrap = document.getElementById("volumeEfficiencyChart");
  if (!wrap) return;
  const data = computeVolumeEfficiencyData();
  if (data.length === 0) {
    wrap.innerHTML = '<p class="empty-state">No field goals logged yet.</p>';
    return;
  }
  const W = 380, H = 340, PAD_L = 40, PAD_R = 20, PAD_T = 20, PAD_B = 34;
  const plotW = W - PAD_L - PAD_R, plotH = H - PAD_T - PAD_B;
  const maxVolume = Math.max(1, ...data.map(d => d.volume)) * 1.15;
  // TS% for a small enough sample isn't capped at 100 (see computeLeagueTsByZone's comment) —
  // scale to whatever the data actually produced rather than assuming a fixed 0-100 range.
  const maxTs = Math.max(100, ...data.map(d => d.ts)) * 1.08;
  const xScale = v => PAD_L + (v / maxVolume) * plotW;
  const yScale = v => PAD_T + plotH - (v / maxTs) * plotH;

  const dotsSvg = data.map(d => {
    const cx = xScale(d.volume), cy = yScale(d.ts);
    return `
      <g>
        <title>${escapeHtml(d.player.name)}: ${d.volume.toFixed(1)} FGA/20, ${d.ts}% TS</title>
        ${svgAvatarDot(d.player, cx, cy)}
      </g>
      <text x="${cx}" y="${cy - 12}" text-anchor="middle" class="quadrant-label">${escapeHtml(d.player.name)}</text>
    `;
  }).join("");

  wrap.innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" class="quadrant-svg">
      <line x1="${PAD_L}" y1="${PAD_T}" x2="${PAD_L}" y2="${H - PAD_B}" class="quadrant-axis" />
      <line x1="${PAD_L}" y1="${H - PAD_B}" x2="${W - PAD_R}" y2="${H - PAD_B}" class="quadrant-axis" />
      ${dotsSvg}
      <text x="${W - PAD_R}" y="${H - PAD_B + 16}" text-anchor="end" class="quadrant-axis-label">FGA/20 &#8594;</text>
      <text x="${PAD_L - 10}" y="${PAD_T + 4}" text-anchor="end" class="quadrant-axis-label">&#8593; TS%</text>
    </svg>
  `;
}

// ---------- Play Style Clusters (k-means) ----------
// Groups players by how their own stat profile actually compares to the rest of the roster,
// rather than by anyone's manually-picked Scorer/Defender/Playmaker tag (see PLAYER_PHYSICAL_DATA/
// PHYSICAL_ROLE_LABELS elsewhere in this file — a real, separate, hand-entered system). Five
// per-20 features, standardized to z-scores (a raw Assists/20 of "6" and a raw Def Rating/20 of
// "6" aren't remotely the same size of number, so clustering on the raw values would just measure
// whichever stat happens to have the largest scale), clustered with k-means. Deterministic on
// purpose — seeded, not Math.random() — so the same season's data always produces the same
// groupings instead of visibly reshuffling on every unrelated re-render.
const PLAY_STYLE_FEATURES = [
  { key: "off", label: "Off Rating/20", accessor: r => r.offRatingPer20 },
  { key: "def", label: "Def Rating/20", accessor: r => defensiveRating(r.rate, r.rateDefense) },
  { key: "ast", label: "Assists/20", accessor: r => r.rate.ast },
  { key: "reb", label: "Rebounds/20", accessor: r => r.rate.oreb + r.rate.dreb },
  { key: "stocks", label: "Stocks/20", accessor: r => r.rate.stl + r.rate.blk }
];
const PLAY_STYLE_MIN_PLAYERS = 4;
const PLAY_STYLE_MIN_GP = 2;

function computePlayerStyleFeatures() {
  return computeLeaderboard()
    .filter(r => r.gp >= PLAY_STYLE_MIN_GP)
    .map(r => ({ player: r.player, gp: r.gp, values: PLAY_STYLE_FEATURES.map(f => f.accessor(r)) }));
}

function standardizePlayStyleFeatures(rows) {
  const n = PLAY_STYLE_FEATURES.length;
  const means = new Array(n), stds = new Array(n);
  for (let i = 0; i < n; i++) {
    const vals = rows.map(r => r.values[i]);
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    const variance = vals.reduce((sum, v) => sum + (v - mean) ** 2, 0) / vals.length;
    means[i] = mean;
    stds[i] = Math.sqrt(variance) || 1; // guards a stat everyone happens to share equally (0 spread)
  }
  return rows.map(r => ({ ...r, z: r.values.map((v, i) => (v - means[i]) / stds[i]) }));
}

function euclideanDist(a, b) {
  return Math.sqrt(a.reduce((sum, v, i) => sum + (v - b[i]) ** 2, 0));
}

// A tiny seeded PRNG (Lehmer/Park-Miller) — deterministic given the same seed, unlike
// Math.random(), which is exactly the point here (see the comment above this section).
function seededRandom(seed) {
  let s = seed % 2147483647;
  if (s <= 0) s += 2147483646;
  return function () {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

// k-means++ initialization: the first center is picked (seeded-)randomly, then each next center
// is picked with probability proportional to its squared distance from the nearest center already
// chosen — spreads the starting centers out across the data instead of risking two starting right
// next to each other, the classic failure mode of picking k plain random starting points.
function kMeansPlusPlusInit(points, k, rand) {
  const centers = [points[Math.floor(rand() * points.length)]];
  while (centers.length < k) {
    const distSq = points.map(p => Math.min(...centers.map(c => euclideanDist(p, c) ** 2)));
    const total = distSq.reduce((a, b) => a + b, 0);
    if (total === 0) { centers.push(points[Math.floor(rand() * points.length)]); continue; }
    let r = rand() * total, idx = 0;
    for (; idx < distSq.length - 1; idx++) { r -= distSq[idx]; if (r <= 0) break; }
    centers.push(points[idx]);
  }
  return centers;
}

// Standard Lloyd's algorithm: assign each point to its nearest center, recompute each center as
// the mean of its assigned points, repeat until nothing reassigns (or a hard iteration cap, as a
// safety net against a pathological oscillation between two equally-good assignments).
function kMeans(points, k, seed) {
  const rand = seededRandom(seed);
  let centers = kMeansPlusPlusInit(points, k, rand);
  let assignments = new Array(points.length).fill(-1);
  for (let iter = 0; iter < 100; iter++) {
    const next = points.map(p => {
      let best = 0, bestDist = Infinity;
      centers.forEach((c, ci) => {
        const d = euclideanDist(p, c);
        if (d < bestDist) { bestDist = d; best = ci; }
      });
      return best;
    });
    const changed = next.some((a, i) => a !== assignments[i]);
    assignments = next;
    centers = centers.map((c, ci) => {
      const members = points.filter((_, i) => assignments[i] === ci);
      return members.length > 0 ? c.map((_, d) => members.reduce((s, m) => s + m[d], 0) / members.length) : c;
    });
    if (!changed) break;
  }
  return { centers, assignments };
}

const PLAY_STYLE_DESCRIPTORS = {
  off: { high: "Scorer", low: "Cold" },
  def: { high: "Lockdown Defender", low: "Turnstile" },
  ast: { high: "Playmaker", low: "Black Hole" },
  reb: { high: "Glass-Cleaner", low: "Allergic to the Glass" },
  stocks: { high: "Disruptor", low: "Ghost" }
};

// Labels a cluster by whichever one or two features sit furthest from the league-wide average
// (z=0) at that cluster's own centroid, rather than a fixed preset name per cluster index — so
// the label actually reflects what this specific group's games produced, not a guess at what a
// "cluster 2" is supposed to mean. A centroid with nothing far from average reads as a real
// finding (a genuinely unremarkable, all-around group), not a labeling failure.
function describePlayStyleCluster(center) {
  const ranked = PLAY_STYLE_FEATURES
    .map((f, i) => ({ feature: f, z: center[i] }))
    .sort((a, b) => Math.abs(b.z) - Math.abs(a.z));
  const top = ranked.slice(0, 2).filter(r => Math.abs(r.z) >= 0.35);
  const words = top.map(r => (r.z >= 0 ? PLAY_STYLE_DESCRIPTORS[r.feature.key].high : PLAY_STYLE_DESCRIPTORS[r.feature.key].low)).filter(Boolean);
  const label = words.length > 0 ? [...new Set(words)].join(" / ") : "Balanced / Role Player";
  // Plain-language gloss of the same top features the label above was built from — the label
  // itself is a nickname, not self-explanatory (a "Ghost" reads as an insult until you know it
  // means "below-average Stocks"), so this spells out which real stat earned it and which
  // direction, in the same order the label lists them.
  const explain = top.length > 0
    ? top.map(r => `${r.z >= 0 ? "above" : "below"}-average ${r.feature.label}`).join(", ")
    : "no stat far enough from average to stand out";
  return { label, explain };
}

function computePlayerStyleClusters() {
  const rows = computePlayerStyleFeatures();
  if (rows.length < PLAY_STYLE_MIN_PLAYERS) return null;
  const standardized = standardizePlayStyleFeatures(rows);
  const points = standardized.map(r => r.z);
  const k = Math.min(4, Math.max(2, Math.floor(rows.length / 3)));
  // Several seeded (not random) restarts, keeping whichever converges to the lowest total squared
  // distance from each point to its own cluster's center — the standard k-means quality measure —
  // since Lloyd's algorithm above can still settle into a locally-good-but-not-best assignment
  // depending on where it started.
  let best = null;
  for (let seed = 1; seed <= 8; seed++) {
    const { centers, assignments } = kMeans(points, k, seed * 97 + rows.length);
    const inertia = points.reduce((sum, p, i) => sum + euclideanDist(p, centers[assignments[i]]) ** 2, 0);
    if (!best || inertia < best.inertia) best = { centers, assignments };
  }
  return best.centers
    .map((center, ci) => ({
      ...describePlayStyleCluster(center),
      members: standardized.filter((_, i) => best.assignments[i] === ci)
    }))
    .filter(c => c.members.length > 0)
    .sort((a, b) => b.members.length - a.members.length);
}

function renderPlayStyleClusters() {
  const wrap = document.getElementById("playStyleClusters");
  if (!wrap) return;
  const clusters = computePlayerStyleClusters();
  if (!clusters) {
    wrap.innerHTML = `<p class="empty-state">Needs at least ${PLAY_STYLE_MIN_PLAYERS} players with ${PLAY_STYLE_MIN_GP}+ qualifying games to cluster yet.</p>`;
    return;
  }
  wrap.innerHTML = `
    <div class="play-style-clusters">
      ${clusters.map(c => `
        <div class="play-style-cluster">
          <h4>${escapeHtml(c.label)} <span class="hint" style="margin:0">(${c.members.length})</span></h4>
          <p class="hint play-style-explain">${escapeHtml(c.explain)}</p>
          <ul>${c.members.map(m => `<li>${renderPlayerAvatar(m.player)}${playerLink(m.player.id, m.player.name)}</li>`).join("")}</ul>
        </div>
      `).join("")}
    </div>
  `;
}

// Two-Way/20 rank at every checkpoint across the season, one line per player — the "how's my
// standing actually trended" question the single-snapshot Leaderboard table can't answer on its
// own. A checkpoint is every date with at least one qualifying game; a player's rank at that
// checkpoint comes from their *cumulative* Two-Way/20 across every qualifying game up through
// (and including) that date — not just that date's own games — ranked against everyone else's
// own cumulative number at the same point in time, so this is a real "if the season had ended
// here" snapshot repeated at every checkpoint, not a per-night score. Deliberately built on the
// plain `isQualifyingGame()` gate rather than each player's own `qualifyingGamesForPlayer()` (with
// Exclude Outlier Games in play) — a per-player outlier exclusion would mean two players could
// disagree about which dates even exist as checkpoints, which breaks the "everyone ranked at the
// same moments in time" premise this chart depends on.
function computeTwoWayRankOverSeason() {
  const qualifyingGames = state.games.filter(isQualifyingGame);
  const dates = [...new Set(qualifyingGames.map(g => g.date).filter(Boolean))].sort();
  const series = {}; // playerId -> [{date, rank, twoWay}], chronological
  dates.forEach(date => {
    const gamesSoFar = qualifyingGames.filter(g => g.date <= date);
    const snapshot = state.players.map(p => {
      const playerGames = gamesSoFar.filter(g => g.teamA.includes(p.id) || g.teamB.includes(p.id));
      if (playerGames.length === 0) return null;
      return { player: p, twoWay: computeRateSummaryForGames(p.id, playerGames).twoWayPer20 };
    }).filter(Boolean);
    snapshot.sort((a, b) => b.twoWay - a.twoWay);
    snapshot.forEach((s, i) => {
      (series[s.player.id] = series[s.player.id] || []).push({ date, rank: i + 1, twoWay: s.twoWay });
    });
  });
  return { dates, series };
}

// This player's real-site power ranking for the season picked in the header (the site's own
// season %: the average of each night's percentile), plus how many places they moved with the
// latest party night. Only players with enough parties to count are ranked (see
// pooleanMinParties()), so a one-night guest at 100% doesn't sit at #1.
function pooleanMinParties(maxParties) {
  return Math.max(3, Math.ceil(maxParties * 0.2));
}
// Season power ranking after the first `count` party nights: slug -> rank, among players with
// enough parties by then.
function pooleanRankAfter(count) {
  const nights = [...POOLEAN_RANKINGS].sort((x, y) => x.date.localeCompare(y.date));
  const pcts = {};
  nights.slice(0, count).forEach(n => n.players.forEach(p => (pcts[p.slug] = pcts[p.slug] || []).push(p.pct)));
  const maxParties = Math.max(0, ...Object.values(pcts).map(v => v.length));
  const min = pooleanMinParties(maxParties);
  const order = Object.entries(pcts).filter(([, v]) => v.length >= min)
    .map(([slug, v]) => ({ slug, avg: v.reduce((x, y) => x + y, 0) / v.length }))
    .sort((x, y) => y.avg - x.avg);
  return { ranks: Object.fromEntries(order.map((e, i) => [e.slug, i + 1])), fieldSize: order.length, min };
}

function computePlayerOverallRank(playerId) {
  if (typeof POOLEAN_RANKINGS === "undefined" || POOLEAN_RANKINGS.length === 0) return null;
  const now = pooleanRankAfter(POOLEAN_RANKINGS.length);
  const rank = now.ranks[playerId];
  if (!rank) return null;
  const before = POOLEAN_RANKINGS.length > 1 ? pooleanRankAfter(POOLEAN_RANKINGS.length - 1).ranks[playerId] : null;
  return { rank, fieldSize: now.fieldSize, min: now.min, delta: before ? before - rank : null }; // positive: moved up
}

// Who moved up the season power rankings most with this party night, among that night's players.
function computeNightClimber(date) {
  if (typeof POOLEAN_RANKINGS === "undefined") return null;
  const dates = POOLEAN_RANKINGS.map(n => n.date).sort();
  const count = dates.indexOf(date) + 1;
  if (count < 2) return null;
  const night = POOLEAN_RANKINGS.find(n => n.date === date);
  const before = pooleanRankAfter(count - 1).ranks, after = pooleanRankAfter(count).ranks;
  let best = null;
  night.players.forEach(p => {
    if (!before[p.slug] || !after[p.slug]) return;
    const delta = before[p.slug] - after[p.slug];
    if (delta > 0 && (!best || delta > best.delta)) best = { slug: p.slug, from: before[p.slug], to: after[p.slug], delta };
  });
  return best;
}

function renderPlayerRankPill(playerId) {
  const wrap = document.getElementById("playerRankPill");
  if (!wrap) return;
  const rank = computePlayerOverallRank(playerId);
  const summary = computePowerRankingSummary(playerId);
  const parts = [];
  if (rank) {
    const arrow = rank.delta === null || rank.delta === 0 ? "" : rank.delta > 0
      ? `<span class="player-rank-pill-up">▲${rank.delta}</span>` : `<span class="player-rank-pill-down">▼${Math.abs(rank.delta)}</span>`;
    parts.push(`<span class="player-rank-pill-main" title="Real site power ranking for the ${escapeHtml(String(selectedPooleanSeason))} season, among the ${rank.fieldSize} players with ${rank.min}+ parties. The arrow is the move from the latest party night.">#${rank.rank} of ${rank.fieldSize}</span>${arrow}`);
  }
  if (summary) parts.push(`<span class="player-rank-pill-attendance">📅 ${summary.of} part${summary.of === 1 ? "y" : "ies"} this season</span>`);
  wrap.innerHTML = parts.join("");
}

function renderTwoWayRankChart() {
  const wrap = document.getElementById("twoWayRankChart");
  if (!wrap) return;
  const { dates, series } = computeTwoWayRankOverSeason();
  const playerIds = Object.keys(series);
  if (dates.length === 0 || playerIds.length === 0) {
    wrap.innerHTML = '<p class="empty-state">No games logged yet.</p>';
    return;
  }
  // H bumped up from an earlier 360 — this chart lives paired in a .panel-row (half-width) next
  // to League Shot Heatmap, and at that squeezed width the old H rendered genuinely tiny (an SVG
  // with width:100% scales its height to match its own viewBox aspect ratio, so a wide, short
  // viewBox stays short no matter how little width it actually gets). Taller viewBox, same W,
  // means more vertical room between rank rows too — a real readability win, not just a size one.
  const W = 680, H = 520, PAD_L = 32, PAD_R = 96, PAD_T = 16, PAD_B = 34;
  const plotW = W - PAD_L - PAD_R, plotH = H - PAD_T - PAD_B;
  const maxRank = Math.max(1, ...playerIds.flatMap(pid => series[pid].map(p => p.rank)));
  const xScale = i => dates.length === 1 ? PAD_L + plotW / 2 : PAD_L + (i / (dates.length - 1)) * plotW;
  // Rank 1 at the top — a "climbing" line reads as improving, matching how a real standings
  // table already reads (1st at the top), not an arbitrary choice of which way is "up."
  const yScale = rank => PAD_T + ((rank - 1) / Math.max(1, maxRank - 1)) * plotH;
  const dateIndex = {};
  dates.forEach((d, i) => dateIndex[d] = i);

  const linesSvg = playerIds.map(pid => {
    const player = state.players.find(p => p.id === pid);
    if (!player) return "";
    const points = series[pid];
    const hue = avatarHueForPlayer(pid);
    const pathD = points.map((p, i) => `${i === 0 ? "M" : "L"}${xScale(dateIndex[p.date])},${yScale(p.rank)}`).join(" ");
    const dotsSvg = points.map(p => `
      <g>
        <title>${escapeHtml(player.name)}: #${p.rank} as of ${escapeHtml(formatDateDisplay(p.date))} (${p.twoWay.toFixed(1)} Two-Way/20)</title>
        ${svgAvatarDot(player, xScale(dateIndex[p.date]), yScale(p.rank), 8, p.rank)}
      </g>
    `).join("");
    const last = points[points.length - 1];
    // Lighter/more saturated than the 55%/42% used for avatars and the quadrant-scatter dots
    // elsewhere — those sit on colored circles with a contrasting ring, but a thin line has to
    // read against the raw dark panel background on its own, and 42% lightness is genuinely hard
    // to see for the blue/purple end of the hue wheel specifically, which sits close in tone to
    // this app's own dark navy background.
    const labelSvg = `<text x="${xScale(dateIndex[last.date]) + 12}" y="${yScale(last.rank)}" dominant-baseline="central" class="rank-line-label" style="fill:hsl(${hue}, 70%, 62%)">${escapeHtml(player.name)}</text>`;
    return `<path d="${pathD}" style="stroke:hsl(${hue}, 70%, 62%)" class="rank-line-path" />${dotsSvg}${labelSvg}`;
  }).join("");

  const labelEvery = Math.max(1, Math.ceil(dates.length / 6));
  const xLabelsSvg = dates.map((d, i) => (i % labelEvery !== 0 && i !== dates.length - 1) ? "" : `
    <text x="${xScale(i)}" y="${H - PAD_B + 16}" text-anchor="middle" class="quadrant-axis-label">${escapeHtml(formatDateDisplay(d))}</text>
  `).join("");
  const yTicksSvg = Array.from({ length: maxRank }, (_, i) => i + 1).map(r =>
    `<text x="${PAD_L - 8}" y="${yScale(r) + 3}" text-anchor="end" class="quadrant-axis-label">${r}</text>`
  ).join("");

  wrap.innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" class="quadrant-svg">
      <line x1="${PAD_L}" y1="${PAD_T}" x2="${PAD_L}" y2="${H - PAD_B}" class="quadrant-axis" />
      <line x1="${PAD_L}" y1="${H - PAD_B}" x2="${W - PAD_R}" y2="${H - PAD_B}" class="quadrant-axis" />
      ${yTicksSvg}
      ${linesSvg}
      ${xLabelsSvg}
      <text x="${PAD_L - 10}" y="${PAD_T - 4}" text-anchor="end" class="quadrant-axis-label">Rank</text>
    </svg>
  `;
}

// League-wide head-to-head matchup grid — every scorer down one axis, every defender across the
// other, one cell per pairing. The natural league-wide extension of the per-player Head-to-Head
// tables on Player Detail (headToHeadAsScorer/headToHeadAsDefender): those only ever surface one
// player's matchups at a time, so a strong or weak pairing between two OTHER players stays
// invisible until someone happens to check that specific player's tab. Same underlying data and
// counting rule as those tables — an event with multiple tagged defenders (a double-team) counts
// once per defender, not once total — just pivoted into a full grid instead of two single-column
// lists. Not filtered to field goals only, matching those tables' existing behavior exactly.
function computeMatchupGrid() {
  const cellTotals = {}; // "scorerId|defenderId" -> { fgm, fga }
  const scorerTotals = {}; // scorerId -> attempts, for sorting rows by sample size
  const defenderTotals = {}; // defenderId -> attempts, for sorting columns by sample size
  state.games.filter(isQualifyingGame).forEach(g => {
    g.scoringEvents.forEach(ev => {
      (ev.defenderIds || []).forEach(defenderId => {
        const key = `${ev.scorerId}|${defenderId}`;
        const cell = cellTotals[key] = cellTotals[key] || { fgm: 0, fga: 0 };
        cell.fga++;
        if (ev.made !== false) cell.fgm++;
        scorerTotals[ev.scorerId] = (scorerTotals[ev.scorerId] || 0) + 1;
        defenderTotals[defenderId] = (defenderTotals[defenderId] || 0) + 1;
      });
    });
  });
  const scorers = Object.keys(scorerTotals)
    .map(id => state.players.find(p => p.id === id))
    .filter(Boolean)
    .sort((a, b) => scorerTotals[b.id] - scorerTotals[a.id]);
  const defenders = Object.keys(defenderTotals)
    .map(id => state.players.find(p => p.id === id))
    .filter(Boolean)
    .sort((a, b) => defenderTotals[b.id] - defenderTotals[a.id]);
  return {
    scorers,
    defenders,
    cellFor: (scorerId, defenderId) => cellTotals[`${scorerId}|${defenderId}`] || null
  };
}

function renderMatchupGrid() {
  const wrap = document.getElementById("matchupGrid");
  if (!wrap) return;
  const { scorers, defenders, cellFor } = computeMatchupGrid();
  if (scorers.length === 0 || defenders.length === 0) {
    wrap.innerHTML = '<p class="empty-state">No shots with a tagged defender yet.</p>';
    return;
  }
  const headerHtml = defenders.map(d => `<th>${playerLink(d.id, d.name)}</th>`).join("");
  const rowsHtml = scorers.map(scorer => {
    const cellsHtml = defenders.map(defender => {
      const cell = cellFor(scorer.id, defender.id);
      if (!cell) return `<td class="matchup-grid-cell matchup-grid-empty">&#8212;</td>`;
      const fgPct = pct(cell.fgm, cell.fga);
      const hue = (fgPct / 100) * 120;
      const opacity = Math.min(0.85, 0.32 + cell.fga * 0.08);
      return `<td class="matchup-grid-cell" style="background: hsla(${hue}, 85%, 42%, ${opacity})" title="${escapeHtml(scorer.name)} vs. ${escapeHtml(defender.name)}: ${cell.fgm}/${cell.fga}">${fgPct}%</td>`;
    }).join("");
    return `<tr><td class="sticky-col">${playerLink(scorer.id, scorer.name)}</td>${cellsHtml}</tr>`;
  }).join("");
  wrap.innerHTML = `
    <div class="table-scroll">
      <table class="matchup-table matchup-grid-table">
        <thead><tr><th class="sticky-col">Scorer &#8595; / Defender &#8594;</th>${headerHtml}</tr></thead>
        <tbody>${rowsHtml}</tbody>
      </table>
    </div>
  `;
}

// Wide-Open Shooting — every field goal attempt with NO tagged defender at all, as opposed to
// contested. Pure analysis off data already captured: a shot's defenderIds is empty exactly when
// nobody tagged a defender on it, no new logging required. Free throws are excluded entirely (not
// just untouched by defenderIds) since an FT is uncontested by rule, not by circumstance — folding
// them in would trivially inflate every player's "wide open" numbers with a shot type that was
// never actually a read on defensive pressure. TS%, not FG%, for the same reason every other
// efficiency panel on this page prefers it — it accounts for the extra value of a made 3.
function computeWideOpenShooting() {
  const totals = {}; // playerId -> { pts, fga, totalFga }
  state.games.filter(isQualifyingGame).forEach(game => {
    game.scoringEvents.forEach(ev => {
      if (ev.points !== 2 && ev.points !== 3) return;
      const t = totals[ev.scorerId] = totals[ev.scorerId] || { pts: 0, fga: 0, totalFga: 0 };
      t.totalFga++;
      if (!ev.defenderIds || ev.defenderIds.length === 0) {
        t.fga++;
        if (ev.made !== false) t.pts += ev.points;
      }
    });
  });
  return Object.entries(totals)
    .map(([playerId, v]) => ({
      player: state.players.find(p => p.id === playerId),
      wideOpenFga: v.fga,
      totalFga: v.totalFga,
      share: pct(v.fga, v.totalFga),
      ts: v.fga > 0 ? trueShootingPct(v.pts, v.fga, 0) : null
    }))
    .filter(r => r.player && r.wideOpenFga > 0);
}

const WIDE_OPEN_COLUMNS = [
  { key: "player", label: "Player", accessor: r => r.player.name },
  { key: "wideOpenFga", label: "Wide-Open FGA", accessor: r => r.wideOpenFga },
  { key: "share", label: "Share of FGA", accessor: r => r.share },
  { key: "ts", label: "TS%", accessor: r => r.ts }
];
let wideOpenSort = { key: "ts", dir: "desc" };

function renderWideOpenShootingPanel() {
  const headerRow = document.getElementById("wideOpenHeaderRow");
  if (!headerRow) return;
  renderSortableHeader(headerRow, WIDE_OPEN_COLUMNS, wideOpenSort, renderWideOpenShootingPanel);
  const body = document.getElementById("wideOpenBody");
  const rows = computeWideOpenShooting();
  const sortCol = WIDE_OPEN_COLUMNS.find(c => c.key === wideOpenSort.key);
  rows.sort((a, b) => compareForSort(sortCol.accessor(a), sortCol.accessor(b), wideOpenSort.dir));
  body.innerHTML = rows.length === 0
    ? '<tr><td colspan="4" class="empty-state">No field goals without a tagged defender yet.</td></tr>'
    : rows.map(r => `<tr><td>${playerLink(r.player.id, r.player.name)}</td><td>${r.wideOpenFga}</td><td>${formatPct(r.share)}</td><td>${formatPct(r.ts)}</td></tr>`).join("");
}

// League-wide Assist Connections is trimmed to "top by count," not the full O(players^2) list —
// the full list grows long fast, when "who's the top connection or two" is the actual thing worth
// seeing at a glance here. Trimmed to the same row count as Teammate Context, its .panel-row
// partner (one row per player with gp > 0 — computeTeammateContext()'s own row basis), purely so
// the two panels land at roughly the same height side by side instead of one trailing off with a
// lot of empty space below it — not because there's any real relationship between "how many
// players have played" and "how many assist pairings are worth showing." The per-player
// equivalent on Player Detail ("Assisted By") stays the full, untrimmed list, since that one's
// already naturally scoped to a single player's own connections rather than every pairing in the
// league.
function renderAssistSynergy() {
  const body = document.getElementById("assistSynergyBody");
  const rowLimit = Math.max(1, computeLeaderboard().filter(r => r.gp > 0).length);
  const rows = computeAssistConnections().slice(0, rowLimit);
  body.innerHTML = rows.length === 0
    ? '<tr><td colspan="3" class="empty-state">No assists logged yet.</td></tr>'
    : rows.map(r => `<tr><td>${playerLink(r.passer.id, r.passer.name)}</td><td>${playerLink(r.scorer.id, r.scorer.name)}</td><td>${r.count}</td></tr>`).join("");
}

// Teammate Lift Matrix — the same pairwise With/Without comparison Average Teammate Lift (the
// Best Teammate award's stat) averages into one number per player, laid out as a full grid
// instead: row player on the team, column player's own Two-Way/20 change as a result. NOT
// symmetric — row A / col B ("does A help B") and row B / col A ("does B help A") are two
// different facts about two different people's games, not mirror images of the same number.
// Reuses computeTeammateSynergy() once per player (not once per pair) and looks the rest up.
function computeTeammateLiftMatrix() {
  const synergyByPlayer = {};
  state.players.forEach(p => { synergyByPlayer[p.id] = computeTeammateSynergy(p.id); });
  const cells = {}; // "rowId|colId" -> { lift, withGp, withoutGp }
  const involvedIds = new Set();
  let maxAbsLift = 0;
  state.players.forEach(colP => {
    (synergyByPlayer[colP.id] || []).forEach(s => {
      if (s.with.gp === 0 || s.without.gp === 0) return;
      const lift = s.with.twoWayPer20 - s.without.twoWayPer20;
      cells[`${s.teammate.id}|${colP.id}`] = { lift, withGp: s.with.gp, withoutGp: s.without.gp };
      involvedIds.add(s.teammate.id);
      involvedIds.add(colP.id);
      maxAbsLift = Math.max(maxAbsLift, Math.abs(lift));
    });
  });
  const players = state.players.filter(p => involvedIds.has(p.id)).sort((a, b) => a.name.localeCompare(b.name));
  return {
    players,
    maxAbsLift,
    cellFor: (rowId, colId) => cells[`${rowId}|${colId}`] || null
  };
}

function renderTeammateLiftMatrix() {
  const wrap = document.getElementById("teammateLiftMatrix");
  if (!wrap) return;
  const { players, cellFor, maxAbsLift } = computeTeammateLiftMatrix();
  if (players.length === 0) {
    wrap.innerHTML = '<p class="empty-state">Not enough With/Without games logged yet for any pairing.</p>';
    return;
  }
  const headerHtml = players.map(p => `<th>${playerLink(p.id, p.name)}</th>`).join("");
  const rowsHtml = players.map(rowP => {
    const cellsHtml = players.map(colP => {
      if (rowP.id === colP.id) return '<td class="matchup-grid-cell matchup-grid-empty">&#8212;</td>';
      const cell = cellFor(rowP.id, colP.id);
      if (!cell) return '<td class="matchup-grid-cell matchup-grid-empty">&#8212;</td>';
      const magnitude = maxAbsLift > 0 ? Math.abs(cell.lift) / maxAbsLift : 0;
      const opacity = 0.18 + magnitude * 0.62;
      const hue = cell.lift >= 0 ? 120 : 0;
      const sign = cell.lift >= 0 ? "+" : "";
      return `<td class="matchup-grid-cell" style="background: hsla(${hue}, 70%, 45%, ${opacity})" title="With ${escapeHtml(rowP.name)} on their team, ${escapeHtml(colP.name)}'s Two-Way/20 is ${sign}${cell.lift.toFixed(1)} (${cell.withGp} with / ${cell.withoutGp} without)">${sign}${cell.lift.toFixed(1)}</td>`;
    }).join("");
    return `<tr><td class="sticky-col">${playerLink(rowP.id, rowP.name)}</td>${cellsHtml}</tr>`;
  }).join("");
  wrap.innerHTML = `
    <div class="table-scroll">
      <table class="matchup-table matchup-grid-table">
        <thead><tr><th class="sticky-col">On team with &#8595; / Stat shown for &#8594;</th>${headerHtml}</tr></thead>
        <tbody>${rowsHtml}</tbody>
      </table>
    </div>
  `;
}

// Teammate Quality / Offensive & Defensive Matchup Difficulty / Assisted By's season-average
// headline numbers, side by side for every player at once — the league-wide table version of
// four Player Detail panels, so the pattern they were built to catch (a player whose own numbers
// lean on strong teammates and easy matchups on both ends) is scannable across the whole roster
// instead of one profile at a time. Season summaries only, straight from the same compute
// functions Player Detail already uses — no separate computation to keep in sync.
const TEAMMATE_CONTEXT_COLUMNS = [
  { key: "player", label: "Player", accessor: r => r.player.name },
  { key: "gp", label: "GP", accessor: r => r.gp },
  { key: "offRtg", label: "Off Rating/20", accessor: r => r.offRatingPer20 },
  { key: "teammateQuality", label: "Teammate Quality", accessor: r => r.teammateQuality },
  { key: "offMatchupDifficulty", label: "Off Matchup Difficulty", accessor: r => r.offMatchupDifficulty },
  { key: "defMatchupDifficulty", label: "Def Matchup Difficulty", accessor: r => r.defMatchupDifficulty },
  { key: "assistedPct", label: "Assisted%", accessor: r => r.assistedPct },
  { key: "avgAssisterQuality", label: "Avg Assister Quality", accessor: r => r.avgAssisterQuality }
];
let teammateContextSort = { key: "teammateQuality", dir: "desc" };

function computeTeammateContext() {
  return computeLeaderboard().filter(r => r.gp > 0).map(r => {
    const tq = computeTeammateQualityTrend(r.player.id);
    const omd = computeOffensiveMatchupDifficultyTrend(r.player.id);
    const dmd = computeDefensiveMatchupDifficultyTrend(r.player.id);
    const ab = computeAssistedByBreakdown(r.player.id);
    return {
      player: r.player, gp: r.gp, offRatingPer20: r.offRatingPer20,
      teammateQuality: tq.seasonAvg, offMatchupDifficulty: omd.seasonAvg, defMatchupDifficulty: dmd.seasonAvg,
      assistedPct: ab.assistedPct, avgAssisterQuality: ab.avgAssisterQuality
    };
  });
}

function renderTeammateContextPanel() {
  const headerRow = document.getElementById("teammateContextHeaderRow");
  if (!headerRow) return;
  renderSortableHeader(headerRow, TEAMMATE_CONTEXT_COLUMNS, teammateContextSort, renderTeammateContextPanel);
  const body = document.getElementById("teammateContextBody");
  const rows = computeTeammateContext();
  const sortCol = TEAMMATE_CONTEXT_COLUMNS.find(c => c.key === teammateContextSort.key);
  rows.sort((a, b) => compareForSort(sortCol.accessor(a), sortCol.accessor(b), teammateContextSort.dir));
  body.innerHTML = rows.length === 0
    ? '<tr><td colspan="8" class="empty-state">No games with players yet.</td></tr>'
    : rows.map(r => `<tr>
        <td>${playerLink(r.player.id, r.player.name)}</td>
        <td>${r.gp}</td>
        <td>${r.offRatingPer20.toFixed(1)}</td>
        <td>${r.teammateQuality !== null ? r.teammateQuality.toFixed(1) : "—"}</td>
        <td>${r.offMatchupDifficulty !== null ? r.offMatchupDifficulty.toFixed(1) : "—"}</td>
        <td>${r.defMatchupDifficulty !== null ? r.defMatchupDifficulty.toFixed(1) : "—"}</td>
        <td>${r.assistedPct !== null ? formatPct(r.assistedPct) : "—"}</td>
        <td>${r.avgAssisterQuality !== null ? r.avgAssisterQuality.toFixed(1) : "—"}</td>
      </tr>`).join("");
}

// Shot Distance + Shot Selection, combined — these used to be two separate panels (FG% by zone,
// and share-of-attempts by zone) built from the exact same per-player, same-4-zone data, which
// just meant scanning two panels to answer one real question: "where does this player shoot
// from, and how well." Each sortable column now carries both numbers (FG% as the sortable value,
// share-of-attempts as the muted sub-label underneath), and the old Shot Selection bar survives
// as a non-sortable "Mix" column at the end for the same at-a-glance visual read it always gave.
const SHOT_ZONES = [
  { key: "close", label: "Close", cssClass: "shot-seg-close", makes: r => r.shooting.closeM, attempts: r => r.shooting.closeA },
  { key: "mid", label: "Midrange", cssClass: "shot-seg-mid", makes: r => r.shooting.midM, attempts: r => r.shooting.midA },
  { key: "line", label: "3PT Line", cssClass: "shot-seg-line", makes: r => r.shooting.tpArcM, attempts: r => r.shooting.tpArcA },
  { key: "deep", label: "3PT Deep", cssClass: "shot-seg-deep", makes: r => r.shooting.tpDeepM, attempts: r => r.shooting.tpDeepA }
];
const totalBandedAttempts = r => SHOT_ZONES.reduce((sum, z) => sum + z.attempts(r), 0);
const SHOT_ZONE_COLUMNS = [
  { key: "player", label: "Player", accessor: r => r.player.name },
  ...SHOT_ZONES.map(z => ({ key: z.key, label: z.label, accessor: r => pct(z.makes(r), z.attempts(r)) })),
  { key: "attempts", label: "Attempts", accessor: r => totalBandedAttempts(r) }
];
let shotZoneSort = { key: "attempts", dir: "desc" };

const LEAGUE_DIRECTION_MIN_FGA = 5;

// League-wide, not per-player (see Shooting by Direction on Player Detail for that): does the
// team shooting one direction actually do better than the other, across every game where
// game.teamADirection has been set? FG%/TS% pool every attempt from every player on the team
// shooting that direction; Win% is one result per game per direction, same as a normal team
// record, not one per player.
function computeLeagueDirectionSplits() {
  const shooting = { left: { fgm: 0, fga: 0, fta: 0, pts: 0 }, right: { fgm: 0, fga: 0, fta: 0, pts: 0 } };
  const record = { left: { wins: 0, losses: 0, ties: 0 }, right: { wins: 0, losses: 0, ties: 0 } };
  state.games.filter(isQualifyingGame).forEach(game => {
    if (!game.teamADirection) return;
    const dirA = game.teamADirection;
    const dirB = dirA === "left" ? "right" : "left";
    [[game.teamA, dirA], [game.teamB, dirB]].forEach(([teamIds, dir]) => {
      teamIds.forEach(pid => {
        const sh = shootingStats(game, pid);
        shooting[dir].fgm += sh.fgm;
        shooting[dir].fga += sh.fga;
        shooting[dir].fta += sh.fta;
        const s = game.stats.find(st => st.playerId === pid);
        if (s) shooting[dir].pts += s.pts;
      });
    });
    const scoreA = teamScore(game, game.teamA);
    const scoreB = teamScore(game, game.teamB);
    if (scoreA > scoreB) { record[dirA].wins++; record[dirB].losses++; }
    else if (scoreB > scoreA) { record[dirB].wins++; record[dirA].losses++; }
    else { record[dirA].ties++; record[dirB].ties++; }
  });
  const build = dir => {
    const sh = shooting[dir];
    const rec = record[dir];
    const decided = rec.wins + rec.losses;
    return {
      fga: sh.fga,
      fgPct: sh.fga >= LEAGUE_DIRECTION_MIN_FGA ? pct(sh.fgm, sh.fga) : null,
      tsPct: sh.fga >= LEAGUE_DIRECTION_MIN_FGA ? trueShootingPct(sh.pts, sh.fga, sh.fta) : null,
      wins: rec.wins, losses: rec.losses, ties: rec.ties,
      winPct: decided > 0 ? pct(rec.wins, decided) : null,
    };
  };
  return { left: build("left"), right: build("right") };
}

function renderLeagueDirectionSplits() {
  const wrap = document.getElementById("leagueDirectionSplits");
  if (!wrap) return;
  const { left, right } = computeLeagueDirectionSplits();
  if (left.fga === 0 && right.fga === 0) {
    wrap.innerHTML = '<p class="empty-state">No games with a set direction yet. Set it per game in Stat Entry: "Where is Team A shooting?"</p>';
    return;
  }
  const recordText = r => `${r.wins}-${r.losses}${r.ties ? `-${r.ties}` : ""}`;
  const row = (label, r) => `<tr>
    <td>${label}</td>
    <td>${r.fga}</td>
    <td>${formatPct(r.fgPct)}</td>
    <td>${formatPct(r.tsPct)}</td>
    <td>${recordText(r)}</td>
    <td>${formatPct(r.winPct)}</td>
  </tr>`;
  let note = "";
  if (left.winPct !== null && right.winPct !== null) {
    const diff = left.winPct - right.winPct;
    if (Math.abs(diff) >= 15) {
      const better = diff > 0 ? directionLabel("left") : directionLabel("right");
      note = `<p class="hint" style="margin:8px 0 0">${Math.abs(diff)} points higher win rate shooting toward the ${escapeHtml(better.toLowerCase())} so far, worth watching if it holds up as more games get a direction set.</p>`;
    }
  }
  wrap.innerHTML = `
    <table class="matchup-table">
      <thead><tr><th>Direction</th><th>FGA</th><th>FG%</th><th>TS%</th><th>Record</th><th>Win%</th></tr></thead>
      <tbody>${row(directionLabel("left"), left)}${row(directionLabel("right"), right)}</tbody>
    </table>
    ${note}
  `;
}

function renderShotZonePanel() {
  const headerRow = document.getElementById("shotZoneHeaderRow");
  renderSortableHeader(headerRow, SHOT_ZONE_COLUMNS, shotZoneSort, renderShotZonePanel);
  // The Mix column is purely visual (a stacked bar has no single sortable number), so it's
  // appended after renderSortableHeader builds the real sortable headers rather than being one
  // of them.
  const mixTh = document.createElement("th");
  mixTh.textContent = "Mix";
  headerRow.appendChild(mixTh);

  const body = document.getElementById("shotZoneBody");
  const rows = computeLeaderboard().filter(r => totalBandedAttempts(r) > 0);
  const sortCol = SHOT_ZONE_COLUMNS.find(c => c.key === shotZoneSort.key);
  rows.sort((a, b) => compareForSort(sortCol.accessor(a), sortCol.accessor(b), shotZoneSort.dir));

  if (rows.length === 0) {
    body.innerHTML = `<tr><td colspan="${SHOT_ZONE_COLUMNS.length + 1}" class="empty-state">No field goals with a marked shot location yet.</td></tr>`;
    return;
  }
  body.innerHTML = rows.map(r => {
    const total = totalBandedAttempts(r);
    const zoneCellsHtml = SHOT_ZONES.map(z => {
      const a = z.attempts(r);
      const share = total > 0 ? Math.round((a / total) * 100) : 0;
      return `<td>${formatShootingSplit(z.makes(r), a)}${a > 0 ? `<br><span class="hint" style="margin:0">${share}% of shots</span>` : ""}</td>`;
    }).join("");
    const mixHtml = SHOT_ZONES.map(z => {
      const a = z.attempts(r);
      if (a === 0) return "";
      const share = (a / total) * 100;
      return `<div class="shot-seg ${z.cssClass}" style="width:${share}%"><title>${escapeHtml(r.player.name)}: ${a} ${escapeHtml(z.label)} attempt${a === 1 ? "" : "s"} (${Math.round(share)}%)</title></div>`;
    }).join("");
    return `<tr><td>${playerLink(r.player.id, r.player.name)}</td>${zoneCellsHtml}<td>${total}</td><td><div class="shot-selection-bar">${mixHtml}</div></td></tr>`;
  }).join("");
}

// ---------- Defensive Shot Distance (see poolean-defensive-mirrors-spec.md) ----------
// Direct mirror of Shot Distance above, just pointed at shots this player is tagged defending
// instead of shots they took -- same four zones, same FG%-plus-share-of-attempts shape, reusing
// SHOT_ZONES/totalBandedAttempts as-is since they only ever read `r.shooting.<zone>M/A`, and these
// rows are shaped the same way (`r.shooting` here holds defensiveShootingStats()'s own zone
// totals instead of shootingStats()'s).
function computeDefensiveShotZoneRows() {
  const totals = {};
  state.players.forEach(p => {
    totals[p.id] = { closeM: 0, closeA: 0, midM: 0, midA: 0, tpArcM: 0, tpArcA: 0, tpDeepM: 0, tpDeepA: 0 };
  });
  state.games.filter(isQualifyingGame).forEach(game => {
    [...game.teamA, ...game.teamB].forEach(playerId => {
      const sh = defensiveShootingStats(game, playerId);
      const t = totals[playerId];
      if (!t) return;
      t.closeM += sh.closeM; t.closeA += sh.closeA;
      t.midM += sh.midM; t.midA += sh.midA;
      t.tpArcM += sh.tpArcM; t.tpArcA += sh.tpArcA;
      t.tpDeepM += sh.tpDeepM; t.tpDeepA += sh.tpDeepA;
    });
  });
  return state.players.map(p => ({ player: p, shooting: totals[p.id] }));
}

const DEFENSIVE_SHOT_ZONE_COLUMNS = [
  { key: "player", label: "Player", accessor: r => r.player.name },
  ...SHOT_ZONES.map(z => ({ key: z.key, label: z.label, accessor: r => pct(z.makes(r), z.attempts(r)) })),
  { key: "attempts", label: "Attempts", accessor: r => totalBandedAttempts(r) }
];
let defensiveShotZoneSort = { key: "attempts", dir: "desc" };

function renderDefensiveShotZonePanel() {
  const headerRow = document.getElementById("defensiveShotZoneHeaderRow");
  if (!headerRow) return;
  renderSortableHeader(headerRow, DEFENSIVE_SHOT_ZONE_COLUMNS, defensiveShotZoneSort, renderDefensiveShotZonePanel);
  const mixTh = document.createElement("th");
  mixTh.textContent = "Mix";
  headerRow.appendChild(mixTh);

  const body = document.getElementById("defensiveShotZoneBody");
  const rows = computeDefensiveShotZoneRows().filter(r => totalBandedAttempts(r) > 0);
  const sortCol = DEFENSIVE_SHOT_ZONE_COLUMNS.find(c => c.key === defensiveShotZoneSort.key);
  rows.sort((a, b) => compareForSort(sortCol.accessor(a), sortCol.accessor(b), defensiveShotZoneSort.dir));

  if (rows.length === 0) {
    body.innerHTML = `<tr><td colspan="${DEFENSIVE_SHOT_ZONE_COLUMNS.length + 1}" class="empty-state">No defended field goals with a marked shot location yet.</td></tr>`;
    return;
  }
  body.innerHTML = rows.map(r => {
    const total = totalBandedAttempts(r);
    const zoneCellsHtml = SHOT_ZONES.map(z => {
      const a = z.attempts(r);
      const share = total > 0 ? Math.round((a / total) * 100) : 0;
      return `<td>${formatShootingSplit(z.makes(r), a)}${a > 0 ? `<br><span class="hint" style="margin:0">${share}% of shots</span>` : ""}</td>`;
    }).join("");
    const mixHtml = SHOT_ZONES.map(z => {
      const a = z.attempts(r);
      if (a === 0) return "";
      const share = (a / total) * 100;
      return `<div class="shot-seg ${z.cssClass}" style="width:${share}%"><title>${escapeHtml(r.player.name)}: ${a} ${escapeHtml(z.label)} attempt${a === 1 ? "" : "s"} allowed (${Math.round(share)}%)</title></div>`;
    }).join("");
    return `<tr><td>${playerLink(r.player.id, r.player.name)}</td>${zoneCellsHtml}<td>${total}</td><td><div class="shot-selection-bar">${mixHtml}</div></td></tr>`;
  }).join("");
}

// League-wide TS% per date, across every player in every reviewed game that day — a single
// number meant for watching the whole league's scoring efficiency drift over the season (e.g.
// to see whether a future rule change moves it), not for comparing individual players. Computed
// directly from scoringEvents rather than via shootingStats(), since that function is scoped to
// one player at a time and this needs every player's shots pooled together per date.
function computeLeagueTsOverTime() {
  const byDate = {};
  state.games.filter(isQualifyingGame).forEach(game => {
    let pts = 0, fga = 0, fta = 0;
    game.scoringEvents.forEach(ev => {
      const made = ev.made !== false;
      if (ev.points === 2 || ev.points === 3) {
        fga++;
        if (made) pts += ev.points;
      } else if (ev.points === 1) {
        fta++;
        if (made) pts += 1;
      }
    });
    const bucket = byDate[game.date] = byDate[game.date] || { pts: 0, fga: 0, fta: 0 };
    bucket.pts += pts;
    bucket.fga += fga;
    bucket.fta += fta;
  });
  return Object.entries(byDate)
    .map(([date, v]) => ({ date, ts: trueShootingPct(v.pts, v.fga, v.fta) }))
    .filter(d => d.ts !== null)
    .sort((a, b) => a.date.localeCompare(b.date));
}

function renderLeagueTsChart() {
  const wrap = document.getElementById("leagueTsChart");
  if (!wrap) return;
  const points = computeLeagueTsOverTime();
  if (points.length === 0) {
    wrap.innerHTML = '<p class="empty-state">No games logged yet.</p>';
    return;
  }
  const W = 560, H = 220, PAD_L = 34, PAD_R = 16, PAD_T = 16, PAD_B = 34;
  const plotW = W - PAD_L - PAD_R, plotH = H - PAD_T - PAD_B;
  const values = points.map(p => p.ts);
  const rawMin = Math.min(...values), rawMax = Math.max(...values);
  const span = Math.max(1, rawMax - rawMin);
  const yMin = Math.max(0, rawMin - span * 0.15);
  const yMax = Math.min(100, rawMax + span * 0.15 || rawMax + 5);
  const xScale = i => points.length === 1 ? PAD_L + plotW / 2 : PAD_L + (i / (points.length - 1)) * plotW;
  const yScale = v => PAD_T + plotH - ((v - yMin) / (yMax - yMin || 1)) * plotH;

  const pathD = points.map((p, i) => `${i === 0 ? "M" : "L"}${xScale(i)},${yScale(p.ts)}`).join(" ");
  const dotsSvg = points.map((p, i) => `
    <circle cx="${xScale(i)}" cy="${yScale(p.ts)}" r="3.5" class="ts-line-dot">
      <title>${escapeHtml(formatDateDisplay(p.date))}: ${p.ts}% TS</title>
    </circle>
  `).join("");
  const labelEvery = Math.max(1, Math.ceil(points.length / 6));
  const xLabelsSvg = points.map((p, i) => (i % labelEvery !== 0 && i !== points.length - 1) ? "" : `
    <text x="${xScale(i)}" y="${H - PAD_B + 16}" text-anchor="middle" class="ts-line-axis-label">${escapeHtml(formatDateDisplay(p.date))}</text>
  `).join("");

  wrap.innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" class="ts-line-svg">
      <line x1="${PAD_L}" y1="${PAD_T}" x2="${PAD_L}" y2="${H - PAD_B}" class="ts-line-axis" />
      <line x1="${PAD_L}" y1="${H - PAD_B}" x2="${W - PAD_R}" y2="${H - PAD_B}" class="ts-line-axis" />
      <text x="${PAD_L - 6}" y="${yScale(yMax) + 4}" text-anchor="end" class="ts-line-axis-label">${Math.round(yMax)}%</text>
      <text x="${PAD_L - 6}" y="${yScale(yMin) + 4}" text-anchor="end" class="ts-line-axis-label">${Math.round(yMin)}%</text>
      <path d="${pathD}" class="ts-line-path" />
      ${dotsSvg}
      ${xLabelsSvg}
    </svg>
  `;
}

// TS% by shot-distance zone, league-wide — same four bands as Shot Distance/Shot Selection, meant
// to make "shooting gets worse with distance" (or wherever it actually breaks down) readable in
// one glance instead of requiring someone to read the Shot Distance table and compare percentages
// in their head. Free throws have no shot location, so unlike the over-time TS% line above, this
// is computed with fta always 0 — pts/(2*fga) restricted to that zone's own attempts, not the
// full TS formula. Only field goals with a marked shot location count, same as every other
// distance-banded panel.
const LEAGUE_TS_ZONES = [
  { key: "close", label: "Close" },
  { key: "mid", label: "Midrange" },
  { key: "arc", label: "3PT Line" },
  { key: "deep", label: "3PT Deep" }
];

// ---------- Expected Points (see poolean-additional-metrics-spec.md, section 3) ----------
// The xG equivalent: every shot already has a real, empirical zone-based conversion rate (this
// tool's own League TS% by Shot Distance, just expressed as points-per-attempt instead of TS%
// -- pts/fga, not pts/(2*fga)). Assigning each attempt its own zone's league-average value and
// comparing a player's actual points against the sum separates "scored efficiently because of
// real skill" from "got hot" or "ran cold" relative to the shots they actually took: a player who
// outscores their own shot-selection-based expectation is shooting better than average from
// those exact shots, not just taking easier ones.
function computeLeagueZonePointsPerAttempt() {
  const totals = {};
  LEAGUE_TS_ZONES.forEach(z => totals[z.key] = { pts: 0, fga: 0 });
  let allPts = 0, allFga = 0;
  state.games.filter(isQualifyingGame).forEach(game => {
    game.scoringEvents.forEach(ev => {
      if (ev.points !== 2 && ev.points !== 3) return;
      const pts = ev.made !== false ? ev.points : 0;
      allPts += pts;
      allFga++;
      if (!ev.shotLocation) return;
      const bucket = totals[shotBand(ev.shotLocation, ev.points)];
      if (!bucket) return;
      bucket.fga++;
      bucket.pts += pts;
    });
  });
  const byZone = {};
  LEAGUE_TS_ZONES.forEach(z => { byZone[z.key] = totals[z.key].fga > 0 ? totals[z.key].pts / totals[z.key].fga : null; });
  // Overall league points-per-attempt (all zoned attempts pooled) is the fallback for a made/miss
  // shot with no marked location -- it still needs an expected value to be counted at all, and
  // "the league's overall average" is a more honest stand-in than silently dropping it, which
  // would just understate both a player's actual AND expected points by the same missing shots.
  return { byZone, overall: allFga > 0 ? allPts / allFga : null };
}

// Free throws are excluded entirely -- no shot location, no zone, and uncontested by rule, same
// exclusion Wide-Open Shooting/Close-Game Shooting already make elsewhere in this tool. Takes
// zonePpa (computeLeagueZonePointsPerAttempt()'s own result) as a parameter rather than computing
// it fresh each call -- see computeLeaderboard()'s own comment on why.
function computeExpectedPoints(playerId, zonePpa) {
  let actualPts = 0, expectedPts = 0, fga = 0;
  qualifyingGamesForPlayer(playerId).forEach(game => {
    game.scoringEvents.forEach(ev => {
      if (ev.scorerId !== playerId || (ev.points !== 2 && ev.points !== 3)) return;
      fga++;
      actualPts += ev.made !== false ? ev.points : 0;
      const xppa = ev.shotLocation && zonePpa.byZone[shotBand(ev.shotLocation, ev.points)] !== null
        ? zonePpa.byZone[shotBand(ev.shotLocation, ev.points)]
        : zonePpa.overall;
      if (xppa !== null && xppa !== undefined) expectedPts += xppa;
    });
  });
  if (fga === 0) return null;
  return { fga, actualPts, expectedPts, pointsOverExpected: actualPts - expectedPts };
}

// ---------- Expected Points Against (see poolean-expected-points-against-spec.md) ----------
// Defensive counterpart to Expected Points above, reusing the exact same zone PPA rates: Opp FG%
// and Def Rating are currently zone-blind, averaging across whatever shots a defender happened to
// face without accounting for how hard those specific shots actually were. A defender who mostly
// gets switched onto point-blank looks faces an inherently higher expected shooting percentage
// than one who mostly closes out on deep attempts -- their raw numbers get compared as if shot
// difficulty were the same, when it isn't. "Under expected" (not "over"), the opposite sign
// convention from offensive Expected Points: for defense, allowing FEWER points than expected is
// the good outcome. Doesn't touch the separate, still-open "tagged but beaten after genuinely
// good position vs. never really in the play" ambiguity -- this only sharpens the shot-difficulty
// dimension. Inherits the same provisional-zone-rates caveat as offensive Expected Points: only as
// good as the underlying zone PPA rates, which are still early and expected to shift with volume.
//
// Min-sample gate matches the same "defense: 10+ shots defended" threshold Areas to Work On
// already uses for a defensive read -- too few tagged defended shots and the expected/actual gap
// is mostly noise, not a real signal.
const EXPECTED_POINTS_AGAINST_MIN_FGA = 10;
function computeExpectedPointsAgainst(playerId, zonePpa) {
  let actualPtsAllowed = 0, expectedPtsAllowed = 0, fga = 0;
  qualifyingGamesForPlayer(playerId).forEach(game => {
    game.scoringEvents.forEach(ev => {
      if (ev.points !== 2 && ev.points !== 3) return;
      if (!(ev.defenderIds || []).includes(playerId)) return;
      fga++;
      actualPtsAllowed += ev.made !== false ? ev.points : 0;
      const xppa = ev.shotLocation && zonePpa.byZone[shotBand(ev.shotLocation, ev.points)] !== null
        ? zonePpa.byZone[shotBand(ev.shotLocation, ev.points)]
        : zonePpa.overall;
      if (xppa !== null && xppa !== undefined) expectedPtsAllowed += xppa;
    });
  });
  if (fga < EXPECTED_POINTS_AGAINST_MIN_FGA) return null;
  return { fga, actualPtsAllowed, expectedPtsAllowed, pointsAllowedUnderExpected: expectedPtsAllowed - actualPtsAllowed };
}

// ---------- Shot Creation Rate (see poolean-shot-creation-and-mirrors-spec.md) ----------
// What share of a player's own makes came off a teammate's assist vs. self-created -- reuses
// assistId, already populated on every made shot, no new tracking. Answers "does this player
// create their own offense or get set up" directly instead of inferring it from assists-received
// volume. Not the same idea as grading a pass's own quality (declined separately): this only
// counts something that already exists in the data, no new judgment calls.
const SHOT_CREATION_MIN_FGM = 5;
function computeShotCreationRate(playerId) {
  let assisted = 0, unassisted = 0;
  qualifyingGamesForPlayer(playerId).forEach(game => {
    game.scoringEvents.forEach(ev => {
      if (ev.scorerId !== playerId || ev.made === false) return;
      if (ev.points !== 2 && ev.points !== 3) return;
      if (ev.assistId) assisted++; else unassisted++;
    });
  });
  const total = assisted + unassisted;
  if (total < SHOT_CREATION_MIN_FGM) return null;
  return { assisted, unassisted, total, selfCreatedPct: pct(unassisted, total) };
}

// ---------- Points off Takeaways (see poolean-shot-creation-and-mirrors-spec.md) ----------
// Genuinely sport-specific, not borrowed from anywhere: possession only alternates automatically
// after a made basket, but a turnover is a live-ball change of possession, so there's a real,
// brief window where the defense hasn't reset the way it would after a made shot. Ties two things
// already tracked separately -- who's disruptive on defense (steals) and who actually cashes that
// disruption in on offense -- by summing this player's own TEAM's points scored within
// TAKEAWAY_WINDOW_SECONDS of every steal this player is individually credited with. Scoped to
// stealEvents specifically, not the broader turnoverEvents log: a steal is the one turnover type
// with a real, individually-credited defender (see Turnover Credit Rate below for the broader,
// mostly-uncredited pool). A single adjustable constant, same provisional-not-backed-by-real-
// transition-speed-data pattern as every other threshold on this page.
const TAKEAWAY_WINDOW_SECONDS = 15;
function computePointsOffTakeaways(playerId) {
  let takeaways = 0, pointsOff = 0, noTimestamp = 0;
  qualifyingGamesForPlayer(playerId).forEach(game => {
    const myTeam = game.teamA.includes(playerId) ? game.teamA : game.teamB;
    game.stealEvents.filter(ev => ev.playerId === playerId).forEach(ev => {
      takeaways++;
      const hasTimestamp = ev.videoTime !== null && ev.videoTime !== undefined;
      if (!hasTimestamp) { noTimestamp++; return; }
      const windowEnd = ev.videoTime + TAKEAWAY_WINDOW_SECONDS;
      game.scoringEvents.forEach(sc => {
        if (sc.made === false || !myTeam.includes(sc.scorerId)) return;
        if (sc.videoTime === null || sc.videoTime === undefined) return;
        if (sc.videoTime < ev.videoTime || sc.videoTime > windowEnd) return;
        pointsOff += sc.points;
      });
    });
  });
  if (takeaways === 0) return null;
  return { takeaways, pointsOff, noTimestamp, perTakeaway: pointsOff / takeaways };
}

const POINTS_OFF_TAKEAWAYS_COLUMNS = [
  { key: "player", label: "Player", accessor: r => r.player.name },
  { key: "takeaways", label: "Takeaways", accessor: r => r.pointsOffTakeaways.takeaways },
  { key: "pointsoff", label: "Points Off", accessor: r => r.pointsOffTakeaways.pointsOff },
  { key: "pertakeaway", label: "Per Takeaway", accessor: r => r.pointsOffTakeaways.perTakeaway },
];
let pointsOffTakeawaysSort = { key: "pointsoff", dir: "desc" };

function renderPointsOffTakeawaysPanel() {
  const headerRow = document.getElementById("pointsOffTakeawaysHeaderRow");
  if (!headerRow) return;
  renderSortableHeader(headerRow, POINTS_OFF_TAKEAWAYS_COLUMNS, pointsOffTakeawaysSort, renderPointsOffTakeawaysPanel);
  const rows = computeLeaderboard().filter(r => r.pointsOffTakeaways !== null);
  const sortCol = POINTS_OFF_TAKEAWAYS_COLUMNS.find(c => c.key === pointsOffTakeawaysSort.key);
  rows.sort((a, b) => compareForSort(sortCol.accessor(a), sortCol.accessor(b), pointsOffTakeawaysSort.dir));
  const totalNoTimestamp = rows.reduce((sum, r) => sum + r.pointsOffTakeaways.noTimestamp, 0);
  const summaryEl = document.getElementById("pointsOffTakeawaysSummary");
  if (summaryEl) {
    summaryEl.textContent = totalNoTimestamp > 0
      ? `${totalNoTimestamp} steal${totalNoTimestamp === 1 ? "" : "s"} had no video timestamp and couldn't be checked for a quick score afterward (still counted toward Takeaways, never toward Points Off).`
      : "";
  }
  const body = document.getElementById("pointsOffTakeawaysBody");
  body.innerHTML = rows.length === 0
    ? '<tr><td colspan="4" class="empty-state">No steals logged yet.</td></tr>'
    : rows.map(r => `<tr><td>${playerLink(r.player.id, r.player.name)}</td><td>${r.pointsOffTakeaways.takeaways}</td><td>${r.pointsOffTakeaways.pointsOff}</td><td>${r.pointsOffTakeaways.perTakeaway.toFixed(2)}</td></tr>`).join("");
}

// ---------- Turnover Credit Rate (see poolean-shot-creation-and-mirrors-spec.md) ----------
// The defensive mirror of Shot Creation Rate, applied to turnovers instead of shots: stealEvents
// only capture the subset of turnovers where a specific person gets individual credit; the
// broader turnoverEvents log includes plenty of live-ball giveaways with no one credited at all
// (opponentId null -- see TAGGED_STAT_CONFIG's own "Who forced/recovered it, if anyone?" prompt).
// An UNcredited turnover has no defender tag at all, so there's no honest way to say it happened
// "near" one specific player more than any other teammate on the floor that game -- the fair,
// checkable denominator is every turnover the opponent committed in games this player's own team
// was on defense (the whole pool a credited turnover could have come from), not a guess at who
// was nearby. Separates real, active disruption (individually credited) from a defender who
// benefits from sloppy opposing possessions without doing much to cause them.
const TURNOVER_CREDIT_MIN_POOL = 5;
function computeTurnoverCreditRate(playerId) {
  let credited = 0, teamTotal = 0;
  qualifyingGamesForPlayer(playerId).forEach(game => {
    const oppTeam = game.teamA.includes(playerId) ? game.teamB : game.teamA;
    const forced = game.turnoverEvents.filter(ev => oppTeam.includes(ev.playerId));
    teamTotal += forced.length;
    credited += forced.filter(ev => ev.opponentId === playerId).length;
  });
  if (teamTotal < TURNOVER_CREDIT_MIN_POOL) return null;
  return { credited, teamTotal, rate: pct(credited, teamTotal) };
}

// ---------- Shot Attempt Differential (see poolean-additional-metrics-spec.md, section 4) ----------
// The Corsi/Fenwick equivalent: total shot attempts for vs. against, regardless of outcome -- a
// real, separate signal from shooting efficiency (TS%/eFG% already cover that), closer to shot
// creation and tempo control. Deliberately a plain differential, not a rate: matches Corsi's own
// simplicity (count everything, don't weight by quality -- that's what Expected Points is for).
// Teams aren't persistent entities across a season here (rosters are picked fresh each game), so
// this is tracked per player using their own team's shots in each game they played, per-game
// average rather than a season total -- comparable across players regardless of how many games
// they've played, without turning it into a normalized /20-style rate the spec explicitly didn't
// want.
// Excludes stoppedEarly games (see poolean-stopped-early-spec.md): this is inherently a per-game
// stat, not a season aggregate blended across many games, so a partial game's undiluted
// distortion would show up directly instead of being averaged down to something modest.
function computeShotAttemptDifferential(playerId) {
  const games = qualifyingGamesForPlayer(playerId).filter(g => !g.stoppedEarly);
  if (games.length === 0) return null;
  let forSum = 0, againstSum = 0;
  games.forEach(game => {
    const myTeam = game.teamA.includes(playerId) ? game.teamA : game.teamB;
    const oppTeam = game.teamA.includes(playerId) ? game.teamB : game.teamA;
    const isFga = ev => ev.points === 2 || ev.points === 3;
    forSum += game.scoringEvents.filter(ev => myTeam.includes(ev.scorerId) && isFga(ev)).length;
    againstSum += game.scoringEvents.filter(ev => oppTeam.includes(ev.scorerId) && isFga(ev)).length;
  });
  return { gp: games.length, forTotal: forSum, againstTotal: againstSum, diffPerGame: (forSum - againstSum) / games.length };
}

// ---------- Rebound Differential (see poolean-shot-creation-and-mirrors-spec.md) ----------
// Team-level mirror of Shot Attempt Differential above, applied to rebounds instead of shot
// attempts: this player's own team's total rebounds (OREB+DREB combined) minus the opponent's,
// per game, across games they played. Not individual rebound-battle attribution ("who beats whom
// for a specific ball") -- a missed shot only ever tracks a single rebounderId, with no data on
// who else contested it, so a real head-to-head rebound-battle stat would need new tracking, the
// same category as the declined deflections idea. This is the real signal buildable right now:
// who controls the boards overall. Same stoppedEarly exclusion as Shot Attempt Differential, for
// the same reason: a per-game differential, not a season aggregate, so a partial game's own
// distortion would show up undiluted.
function computeReboundDifferential(playerId) {
  const games = qualifyingGamesForPlayer(playerId).filter(g => !g.stoppedEarly);
  if (games.length === 0) return null;
  let forSum = 0, againstSum = 0;
  games.forEach(game => {
    const myTeam = game.teamA.includes(playerId) ? game.teamA : game.teamB;
    const oppTeam = game.teamA.includes(playerId) ? game.teamB : game.teamA;
    const teamRebs = ids => ids.reduce((sum, id) => {
      const s = game.stats.find(st => st.playerId === id);
      return sum + (s ? s.oreb + s.dreb : 0);
    }, 0);
    forSum += teamRebs(myTeam);
    againstSum += teamRebs(oppTeam);
  });
  return { gp: games.length, forTotal: forSum, againstTotal: againstSum, diffPerGame: (forSum - againstSum) / games.length };
}

// ---------- Rebound Battle Record (see poolean-rebound-battle-panels-spec.md) ----------
// Now that reboundContesterIds/reboundNoContest are real, actively-tagged data (not a pilot
// anymore), this surfaces what's currently only computable by hand: who actually wins the
// physical battle for a loose ball. `reboundContesterIds` lists whoever contested and LOST -- the
// winner is `rebounderId`, which is never in its own contester list (mirrors how `defenderIds`
// already excludes the shooter) -- so a win is "this player is rebounderId on a real contest," a
// loss is "this player appears in someone else's reboundContesterIds." Only real contests count
// (reboundContesterIds non-empty): an OOB miss (no rebounder at all) or a reboundNoContest rebound
// isn't a battle anyone won or lost.
const REBOUND_BATTLE_MIN_CONTESTS = 5; // same "don't show below a real threshold" reasoning as
// everywhere else in this system -- verified against a real hand-checked sample (Evan 6-2 75%,
// Ben 5-2 71%, Alex 4-2 67%, Ian 5-5 50%, Adam 5-5 50%, Lukas 4-4 50%, Reilly 2-3 40%, Viraj 4-7
// 36%, Zach 2-7 22%) reproduces exactly at this threshold.
function computeReboundBattleRecord() {
  const totals = {}; // playerId -> { wins, losses }
  state.games.filter(isQualifyingGame).forEach(game => {
    game.scoringEvents.forEach(ev => {
      if (ev.made !== false || !ev.rebounderId || ev.turnoverEventId) return;
      const contesters = ev.reboundContesterIds || [];
      if (contesters.length === 0) return; // no-contest or untagged -- not a real battle
      const w = totals[ev.rebounderId] = totals[ev.rebounderId] || { wins: 0, losses: 0 };
      w.wins++;
      contesters.forEach(id => {
        const l = totals[id] = totals[id] || { wins: 0, losses: 0 };
        l.losses++;
      });
    });
  });
  return Object.entries(totals)
    .map(([playerId, v]) => {
      const total = v.wins + v.losses;
      return { player: state.players.find(p => p.id === playerId), wins: v.wins, losses: v.losses, total, winPct: pct(v.wins, total) };
    })
    .filter(r => r.player && r.total >= REBOUND_BATTLE_MIN_CONTESTS);
}

// Context stat, not a ranking on its own (see poolean-rebound-battle-panels-spec.md): what share
// of this player's own rebounds (as rebounderId, offensive or defensive) came from a real contest
// vs. a no-contest situation. Required to sit alongside Rebound Battle Record wherever it's shown
// -- same "never stand alone" reasoning as Defensive Load pairing with Opp FG%/Def Rating -- since
// a player whose boards are mostly uncontested pickups is in a genuinely different situation than
// one winning real battles, even at the same raw rebound total. Deliberately not itself a
// leaderboard/ranking: a high or low share isn't good or bad, just context for reading the rest.
// Untagged rebounds (reviewed by neither tag yet) are excluded from both the numerator and
// denominator -- there's no answer yet for those, so they shouldn't silently count as either.
function computeReboundContestRate(playerId) {
  let real = 0, noContest = 0;
  qualifyingGamesForPlayer(playerId).forEach(game => {
    game.scoringEvents.forEach(ev => {
      if (ev.made !== false || ev.rebounderId !== playerId || ev.turnoverEventId) return;
      if ((ev.reboundContesterIds || []).length > 0) real++;
      else if (ev.reboundNoContest) noContest++;
    });
  });
  const total = real + noContest;
  if (total === 0) return null;
  return { real, noContest, total, contestRate: pct(real, total) };
}

// ---------- Rebound Battle Head-to-Head (see poolean-rebound-battle-panels-spec.md) ----------
// Direct mirror of computeMatchupGrid() above, same visual pattern, just pointed at rebound
// win/loss instead of shot make/miss. Unlike the shot grid (scorer vs. defender is inherently
// directional -- a shot is always attempted BY someone AGAINST someone), a rebound battle between
// two specific players can go either way on different occasions, so a cell here is this row
// player's win rate specifically against this column player: wins where row was rebounderId and
// column was a contester, over the combined total of both directions between that exact pair.
function computeReboundBattleGrid() {
  const winsAgainst = {}; // "winnerId|loserId" -> count of times winner beat loser
  const playerTotals = {}; // playerId -> total battles involved in (win or loss), for sort order
  state.games.filter(isQualifyingGame).forEach(game => {
    game.scoringEvents.forEach(ev => {
      if (ev.made !== false || !ev.rebounderId || ev.turnoverEventId) return;
      const contesters = ev.reboundContesterIds || [];
      if (contesters.length === 0) return;
      contesters.forEach(loserId => {
        const key = `${ev.rebounderId}|${loserId}`;
        winsAgainst[key] = (winsAgainst[key] || 0) + 1;
        playerTotals[ev.rebounderId] = (playerTotals[ev.rebounderId] || 0) + 1;
        playerTotals[loserId] = (playerTotals[loserId] || 0) + 1;
      });
    });
  });
  // Same min-contests gate as Rebound Battle Record -- a player below the real threshold doesn't
  // get a row/column at all, not just a hidden one, since even one real matchup cell involving
  // them would be undersampled noise dressed up as a grid.
  const players = Object.keys(playerTotals)
    .filter(id => playerTotals[id] >= REBOUND_BATTLE_MIN_CONTESTS)
    .map(id => state.players.find(p => p.id === id))
    .filter(Boolean)
    .sort((a, b) => playerTotals[b.id] - playerTotals[a.id]);
  return {
    players,
    cellFor: (rowId, colId) => {
      const wins = winsAgainst[`${rowId}|${colId}`] || 0;
      const losses = winsAgainst[`${colId}|${rowId}`] || 0;
      const total = wins + losses;
      if (total === 0) return null;
      return { wins, losses, total, winPct: pct(wins, total) };
    }
  };
}

const REBOUND_BATTLE_RECORD_COLUMNS = [
  { key: "player", label: "Player", accessor: r => r.player.name },
  { key: "wins", label: "W", accessor: r => r.wins },
  { key: "losses", label: "L", accessor: r => r.losses },
  { key: "total", label: "Total", accessor: r => r.total },
  { key: "winpct", label: "Win%", accessor: r => r.winPct },
  { key: "contestrate", label: "Contest Rate", accessor: r => r.contestRate === null ? -1 : r.contestRate },
];
let reboundBattleRecordSort = { key: "winpct", dir: "desc" };

function renderReboundBattleRecordPanel() {
  const headerRow = document.getElementById("reboundBattleRecordHeaderRow");
  if (!headerRow) return;
  renderSortableHeader(headerRow, REBOUND_BATTLE_RECORD_COLUMNS, reboundBattleRecordSort, renderReboundBattleRecordPanel);
  const body = document.getElementById("reboundBattleRecordBody");
  const rows = computeReboundBattleRecord().map(r => {
    const rate = computeReboundContestRate(r.player.id);
    return { ...r, contestRate: rate ? rate.contestRate : null };
  });
  const sortCol = REBOUND_BATTLE_RECORD_COLUMNS.find(c => c.key === reboundBattleRecordSort.key);
  rows.sort((a, b) => compareForSort(sortCol.accessor(a), sortCol.accessor(b), reboundBattleRecordSort.dir));
  body.innerHTML = rows.length === 0
    ? `<tr><td colspan="6" class="empty-state">Nobody has ${REBOUND_BATTLE_MIN_CONTESTS}+ real rebound contests yet.</td></tr>`
    : rows.map(r => `<tr>
        <td><button type="button" class="icon-btn rebound-battle-player-btn" data-player-id="${r.player.id}" style="padding:0;font-weight:700;color:var(--accent)">${escapeHtml(r.player.name)}</button></td>
        <td>${r.wins}</td>
        <td>${r.losses}</td>
        <td>${r.total}</td>
        <td>${formatPct(r.winPct)}</td>
        <td>${r.contestRate === null ? "—" : formatPct(r.contestRate)}</td>
      </tr>`).join("");
  body.querySelectorAll(".rebound-battle-player-btn").forEach(btn => {
    btn.addEventListener("click", () => openPlayerDetail(btn.dataset.playerId));
  });
}

function renderReboundBattleGridPanel() {
  const wrap = document.getElementById("reboundBattleGrid");
  if (!wrap) return;
  const { players, cellFor } = computeReboundBattleGrid();
  if (players.length === 0) {
    wrap.innerHTML = `<p class="empty-state">Nobody has ${REBOUND_BATTLE_MIN_CONTESTS}+ real rebound contests yet.</p>`;
    return;
  }
  const headerHtml = players.map(p => `<th>${playerLink(p.id, p.name)}</th>`).join("");
  const rowsHtml = players.map(row => {
    const cellsHtml = players.map(col => {
      if (row.id === col.id) return `<td class="matchup-grid-cell matchup-grid-empty">&#8212;</td>`;
      const cell = cellFor(row.id, col.id);
      if (!cell) return `<td class="matchup-grid-cell matchup-grid-empty">&#8212;</td>`;
      const hue = (cell.winPct / 100) * 120;
      const opacity = Math.min(0.85, 0.32 + cell.total * 0.08);
      return `<td class="matchup-grid-cell" style="background: hsla(${hue}, 85%, 42%, ${opacity})" title="${escapeHtml(row.name)} vs. ${escapeHtml(col.name)}: ${cell.wins}-${cell.losses}">${cell.winPct}%</td>`;
    }).join("");
    return `<tr><td class="sticky-col">${playerLink(row.id, row.name)}</td>${cellsHtml}</tr>`;
  }).join("");
  wrap.innerHTML = `
    <div class="table-scroll">
      <table class="matchup-table matchup-grid-table">
        <thead><tr><th class="sticky-col">Wins &#8595; / Against &#8594;</th>${headerHtml}</tr></thead>
        <tbody>${rowsHtml}</tbody>
      </table>
    </div>
  `;
}

// ---------- Pace and PPP (see poolean-additional-metrics-spec.md, section 2) ----------
// Real Pace measures possessions per game; this tool has always substituted combined final score
// as the "how much game happened" proxy for every per-20 rate, reasonable but imperfect -- a
// fast, sloppy 21-point game and a slow, efficient 21-point game get treated identically by that
// normalization even though very different numbers of actual plays happened. Total logged plays
// (every scoringEvent + turnoverEvent + stealEvent, summed literally per the spec's own stated
// formula -- a steal paired with its own linked turnover record counts as two logged plays here,
// not deduplicated to one) is a genuine count of how much game actually happened, closer to a
// real possession count than points ever could be. Computed per player from their own team's own
// totals across the games they played, same reasoning as Shot Attempt Differential: teams aren't
// persistent entities across a season here, so there's no single "team's" Pace independent of who
// was on it that night.
// Excludes stoppedEarly games, same reasoning as Shot Attempt Differential above: Pace/PPP are
// per-game stats, so a partial game's undercount of plays would distort them directly rather
// than being blended away like it is in a season-total per-20 rate.
function computePaceAndPpp(playerId) {
  const games = qualifyingGamesForPlayer(playerId).filter(g => !g.stoppedEarly);
  if (games.length === 0) return null;
  let totalPlays = 0, totalPts = 0;
  games.forEach(game => {
    const myTeam = game.teamA.includes(playerId) ? game.teamA : game.teamB;
    const plays = game.scoringEvents.filter(ev => myTeam.includes(ev.scorerId)).length
      + game.turnoverEvents.filter(ev => myTeam.includes(ev.playerId)).length
      + game.stealEvents.filter(ev => myTeam.includes(ev.playerId)).length;
    const pts = myTeam.reduce((sum, pid) => {
      const s = game.stats.find(st => st.playerId === pid);
      return sum + (s ? s.pts : 0);
    }, 0);
    totalPlays += plays;
    totalPts += pts;
  });
  if (totalPlays === 0) return null;
  return { gp: games.length, pace: totalPlays / games.length, ppp: totalPts / totalPlays };
}

// ---------- Win Shares: sign-constrained ridge regression (see
// poolean-winshares-signconstrained-spec.md) ----------
// BETA/PROVISIONAL, not a finished stat: real NBA Win Shares apportions credit for actual team
// wins using regression-fit weights against real game margin, rather than an assumed scale like
// GmSc/Two-Way. This fits that regression fresh from Poolean's own current season data every time
// it's computed (one row per player-game, this season's own box stats), instead of reusing any
// earlier fit.
//
// Supersedes an earlier unconstrained fit that produced basketball-impossible signs (fouls
// positive, defensive stats negative): with only ~38 player-games and several highly correlated
// defensive predictors (stops/beaten/points-allowed all measure closely related things), an
// unconstrained fit can assign a paradoxical sign to one variable just to balance the math, not
// because it found anything real. The fix is NOT hand-picking weights that "look right" -- that
// would just recreate GmSc's own unvalidated-weights problem under a new name. Instead, each
// stat is told up front which DIRECTION it can move in (basic, uncontroversial basketball logic:
// a stop cannot reduce a team's chances, a turnover cannot increase them), and the data determines
// the actual SIZE of that effect within those bounds. Direction is domain knowledge; magnitude
// stays fully data-driven.
//
// Personal fouls are dropped as a predictor entirely (not just sign-constrained): near-zero
// information in this sample (most player-games log 0 fouls), and the source of the worst sign
// violation in the original fit. Safe to reintroduce once there's enough foul data to fit
// meaningfully. `sign: 1` means this stat can only help (weight >= 0); `sign: -1` means it can
// only hurt (weight <= 0).
//
// Beaten is also dropped, for a checked (not guessed) reason: beaten and points-allowed correlate
// at 0.987 in this season's own data, essentially perfect redundancy, since points allowed is
// mostly just beaten count times average shot value. Stops only correlates weakly with either
// (0.17), so the real problem behind stops landing at 0 wasn't stops being redundant, it was
// beaten/points-allowed fighting each other over the same credit and eating the model's limited
// capacity to properly separate stops out. Keeping points-allowed over beaten (not the reverse):
// points-allowed also captures shot value, a 3 beaten hurts more than a 2, which a raw beaten
// count can't distinguish.
//
// `prior` on assists is a weakly-informative Bayesian prior, not a hand-picked weight: assists and
// points only correlate at 0.24 here, not nearly enough to explain assists landing implausibly
// close to points' own weight through redundancy the way beaten/points-allowed did -- with only
// ~38 rows, a real but modest signal like assists can land almost anywhere by chance.
//
// The prior's VALUE (0.5) is sourced, not guessed: an earlier version of this prior used 0.4 as a
// round, self-described "somewhere between a third and a half a point" estimate. This is now
// Basketball-Reference's own published Points Produced formula (Dean Oliver's methodology; see
// poolean-nba-informed-prior-spec.md) -- specifically its simplified pre-1973-74 form, since the
// full modern version (qAST) needs per-player and per-team minutes-played data Poolean has no
// equivalent of at all (verified directly against Basketball-Reference's own methodology before
// writing this, not assumed from memory): AST_Part = 0.5 * assists, a flat points-per-assist
// credit already denominated in the same "points" units this whole model's target (game margin)
// already uses -- no NBA-scale rescaling needed, unlike the formula's FG_Part (which scales a
// made shot's own credit by the team's assist rate, and isn't used here: it isn't part of the
// specific implausible-weight problem being fixed, and folding it in would need verifying a
// second piece of the formula this change didn't need to touch). Telling the fit to start at this
// sourced value (rather than 0, ridge's usual default) while still letting the data override it
// if it strongly disagrees is a real, defensible Bayesian technique, meaningfully different from
// overriding a coefficient because it looks wrong. This is a stopgap, not a fix -- more data is
// still the real answer for assists (see poolean-winshares-signconstrained-spec.md's own "known
// remaining issue"), and swapping a guessed constant for a sourced one doesn't change that; it
// only makes the starting point defensible instead of arbitrary.
const WIN_SHARES_FEATURES = [
  { key: "pts", label: "Points", sign: 1, extract: (s, sh, def) => s.pts },
  { key: "fga", label: "Shot Attempts", sign: -1, extract: (s, sh, def) => sh.fga },
  { key: "oreb", label: "Off Rebounds", sign: 1, extract: (s, sh, def) => s.oreb },
  { key: "dreb", label: "Def Rebounds", sign: 1, extract: (s, sh, def) => s.dreb },
  { key: "ast", label: "Assists", sign: 1, prior: 0.5, extract: (s, sh, def) => s.ast },
  { key: "tov", label: "Turnovers", sign: -1, extract: (s, sh, def) => s.tov },
  { key: "stops", label: "Stops", sign: 1, extract: (s, sh, def) => def.stops },
  { key: "ptsAllowed", label: "Pts Allowed", sign: -1, extract: (s, sh, def) => def.ptsAllowed },
];

function winSharesRegressionRows() {
  const rows = [];
  state.games.filter(isQualifyingGame).forEach(game => {
    // A stopped-early game's margin isn't a real outcome to fit against (see
    // poolean-stopped-early-spec.md), so it doesn't belong in the regression's own training data
    // any more than it belongs in the per-player win-shares calculation below.
    if (game.scoringEvents.length === 0 || game.stoppedEarly) return;
    const scoreA = teamScore(game, game.teamA);
    const scoreB = teamScore(game, game.teamB);
    [...game.teamA.map(id => ({ id, own: scoreA, opp: scoreB })),
     ...game.teamB.map(id => ({ id, own: scoreB, opp: scoreA }))].forEach(({ id, own, opp }) => {
      const s = getOrCreatePlayerStats(game, id);
      const sh = shootingStats(game, id);
      const def = gameDefenseStats(game, id);
      rows.push({ features: WIN_SHARES_FEATURES.map(f => f.extract(s, sh, def)), margin: own - opp });
    });
  });
  return rows;
}

function matVec(M, v) {
  return M.map(row => row.reduce((sum, x, j) => sum + x * v[j], 0));
}

function dotProduct(a, b) {
  return a.reduce((sum, x, i) => sum + x * b[i], 0);
}

// Largest eigenvalue of a small symmetric matrix via power iteration -- used to pick a safe,
// guaranteed-convergent step size for the projected gradient descent below. A real eigensolver
// would be overkill for a fixed 9x9 matrix; a few dozen iterations of power iteration gets close
// enough for that purpose.
function largestEigenvalue(M, iterations = 200) {
  let v = M.map(() => 1);
  for (let it = 0; it < iterations; it++) {
    const Mv = matVec(M, v);
    const norm = Math.sqrt(dotProduct(Mv, Mv)) || 1;
    v = Mv.map(x => x / norm);
  }
  return dotProduct(v, matVec(M, v));
}

// Zero-mean, unit-variance per column. Fitting in this space keeps gradient descent
// well-conditioned regardless of each stat's raw scale (points vs. turnovers), and doesn't change
// any coefficient's SIGN -- dividing by a standard deviation (always positive) can't flip a sign
// constraint's direction, so the same bounds apply unchanged in either space.
function standardizeColumns(X) {
  const n = X.length, k = X[0].length;
  const means = new Array(k).fill(0), stds = new Array(k).fill(0);
  for (let j = 0; j < k; j++) means[j] = X.reduce((sum, row) => sum + row[j], 0) / n;
  for (let j = 0; j < k; j++) {
    const variance = X.reduce((sum, row) => sum + (row[j] - means[j]) ** 2, 0) / n;
    stds[j] = Math.sqrt(variance) || 1; // guards a column with zero variance (e.g. all-zero stat)
  }
  return { Z: X.map(row => row.map((x, j) => (x - means[j]) / stds[j])), means, stds };
}

// Ridge regression (squared error + sum(alpha_j * (weight_j - prior_j)^2)) subject to a
// per-feature sign bound, solved by projected gradient descent -- exact for this convex quadratic
// problem, just found iteratively instead of via a closed-form normal-equation solve, since box
// constraints have no closed form the way plain ridge does. Standard ridge is the special case
// prior = 0 for every feature (shrink toward "no effect"); a nonzero prior (assists, see
// WIN_SHARES_FEATURES above) shrinks toward that value instead, a weakly-informative Bayesian
// prior rather than a hard-coded weight -- the data can still override it given enough signal.
// alphaVec lets each feature have its OWN regularization strength rather than sharing one global
// value -- assists gets its own (see computeWinSharesWeights below), a standard technique (
// feature-specific shrinkage), since sharing the global alpha left the assist prior technically
// present but functionally inert: the data's own pull dominated a shrinkage strength tuned for
// every OTHER feature, not specifically for how hard to lean on this one prior. Z/yc must already
// be standardized/mean-centered (see fitSignConstrainedRidge below); bounds and priorsStd are
// both in that same standardized space.
function projectedRidge(Z, yc, bounds, priorsStd, alphaVec, iterations = 1500) {
  const n = Z.length, k = bounds.length;
  const ZtZ = Array.from({ length: k }, (_, a) =>
    Array.from({ length: k }, (_, b) => {
      let sum = 0;
      for (let i = 0; i < n; i++) sum += Z[i][a] * Z[i][b];
      return sum;
    })
  );
  const Zty = new Array(k).fill(0);
  for (let i = 0; i < n; i++) for (let a = 0; a < k; a++) Zty[a] += Z[i][a] * yc[i];

  const step = 1 / (2 * (largestEigenvalue(ZtZ) + Math.max(...alphaVec))); // Lipschitz-safe step size
  let w = priorsStd.slice(); // start from the prior rather than 0 -- purely an initialization,
                              // doesn't change what the optimizer converges to
  for (let it = 0; it < iterations; it++) {
    const ZtZw = matVec(ZtZ, w);
    w = w.map((wj, j) => {
      const grad = 2 * (ZtZw[j] - Zty[j]) + 2 * alphaVec[j] * (wj - priorsStd[j]);
      return Math.min(bounds[j][1], Math.max(bounds[j][0], wj - step * grad));
    });
  }
  return w;
}

function fitSignConstrainedRidge(rows, alphaVec) {
  const n = rows.length;
  const k = WIN_SHARES_FEATURES.length;
  if (n < k + 1) return null;
  const X = rows.map(r => r.features);
  const y = rows.map(r => r.margin);
  const { Z, means, stds } = standardizeColumns(X);
  const yMean = y.reduce((a, b) => a + b, 0) / n;
  const yc = y.map(v => v - yMean);
  const bounds = WIN_SHARES_FEATURES.map(f => f.sign > 0 ? [0, Infinity] : [-Infinity, 0]);
  // A raw-scale prior (e.g. 0.4 points per assist) needs converting into the same standardized
  // space the optimizer actually runs in: since w_raw = w_std/std, the equivalent w_std is
  // prior_raw * std.
  const priorsStd = WIN_SHARES_FEATURES.map((f, j) => (f.prior || 0) * stds[j]);
  const wStd = projectedRidge(Z, yc, bounds, priorsStd, alphaVec);
  // Un-standardize: z_j = (x_j - mean_j)/std_j, so a fit of y ~ b0std + sum(wStd_j * z_j) is
  // equivalent to y ~ (b0std - sum(wStd_j * mean_j/std_j)) + sum((wStd_j/std_j) * x_j).
  const weights = {};
  WIN_SHARES_FEATURES.forEach((f, j) => { weights[f.key] = wStd[j] / stds[j]; });
  const intercept = yMean - WIN_SHARES_FEATURES.reduce((sum, f, j) => sum + weights[f.key] * means[j], 0);
  return { intercept, weights };
}

function predictMargin(features, fit) {
  return WIN_SHARES_FEATURES.reduce((sum, f, j) => sum + fit.weights[f.key] * features[j], fit.intercept);
}

function computeR2(actual, predicted) {
  const n = actual.length;
  const mean = actual.reduce((a, b) => a + b, 0) / n;
  const ssTot = actual.reduce((sum, v) => sum + (v - mean) ** 2, 0);
  const ssRes = actual.reduce((sum, v, i) => sum + (v - predicted[i]) ** 2, 0);
  return ssTot > 0 ? 1 - ssRes / ssTot : 0;
}

function pearsonCorrelation(a, b) {
  const n = a.length;
  const meanA = a.reduce((x, y) => x + y, 0) / n;
  const meanB = b.reduce((x, y) => x + y, 0) / n;
  let num = 0, denA = 0, denB = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i] - meanA, db = b[i] - meanB;
    num += da * db; denA += da * da; denB += db * db;
  }
  const den = Math.sqrt(denA * denB);
  return den > 0 ? num / den : 0;
}

// Honest, not in-sample: refits on all-but-one player-game, predicts the held-out one, repeats
// for every row -- required on every refit per the spec, since in-sample fit always looks
// artificially good and would hide exactly the instability this whole redesign exists to catch.
function leaveOneOutDiagnostics(rows, alphaVec) {
  const n = rows.length;
  const predicted = [];
  for (let i = 0; i < n; i++) {
    const trainRows = rows.slice(0, i).concat(rows.slice(i + 1));
    const fit = fitSignConstrainedRidge(trainRows, alphaVec);
    if (!fit) return null;
    predicted.push(predictMargin(rows[i].features, fit));
  }
  const actual = rows.map(r => r.margin);
  return { r2: computeR2(actual, predicted), correlation: pearsonCorrelation(actual, predicted) };
}

// Alpha (regularization strength) is chosen by the same leave-one-out validation the spec asks
// for, not a fixed guess: whichever grid value gives the best honest out-of-sample R² wins.
const WIN_SHARES_ALPHA_GRID = [0.1, 1, 3, 10, 30, 100];
// A wider grid, tried only for assists (see below), including values well above the global grid
// -- a strong enough pull toward the prior is exactly the thing a shared global alpha couldn't
// reach, since anything that strong would over-shrink every OTHER feature too.
const WIN_SHARES_AST_ALPHA_GRID = [0.1, 1, 3, 10, 30, 100, 300, 1000, 3000];

function alphaVectorFor(globalAlpha, astAlpha) {
  return WIN_SHARES_FEATURES.map(f => f.key === "ast" ? astAlpha : globalAlpha);
}

// Cached, not recomputed on every call: computeLeaderboard() calls this once itself, but a single
// Leaderboard render also calls computeLeaderboard() dozens of times over (once per panel that
// needs it -- Defensive Load, Individual Game Performances, the quadrant/volume/cluster charts,
// etc.), and this fit's own leave-one-out cross-validation grid search (two stages, see below) is
// real work, not free. Recomputing it 48 times in one render was a real, measured 16-second stall
// -- caching it here (invalidated by saveState(), and forced fresh once per render by
// renderLeaderboard() itself, see there) turns that into one real computation reused by every
// caller in the same render pass, not stale data silently surviving a real edit.
let winSharesWeightsCache = null;
function computeWinSharesWeights() {
  if (winSharesWeightsCache !== null) return winSharesWeightsCache;
  winSharesWeightsCache = computeWinSharesWeightsUncached();
  return winSharesWeightsCache;
}

function computeWinSharesWeightsUncached() {
  const rows = winSharesRegressionRows();
  if (rows.length < WIN_SHARES_FEATURES.length + 1) return null;

  // Stage 1: one shared alpha for every feature (assists included, at this stage) -- same search
  // as before the feature-specific refinement below.
  let bestGlobal = null;
  WIN_SHARES_ALPHA_GRID.forEach(alpha => {
    const diag = leaveOneOutDiagnostics(rows, alphaVectorFor(alpha, alpha));
    if (diag && (!bestGlobal || diag.r2 > bestGlobal.diag.r2)) bestGlobal = { alpha, diag };
  });
  if (!bestGlobal) return null;

  // Stage 2: assists gets its OWN regularization strength (feature-specific shrinkage, a standard
  // technique -- not the same move as hand-picking a weight), holding every other feature's alpha
  // fixed at the stage-1 global value. Chosen the same honest way: whichever value gives the best
  // leave-one-out R², so a stronger pull toward the assist prior only wins if cross-validation
  // actually supports it -- if the data genuinely doesn't support shrinking assists harder, this
  // stage will land back near the global value on its own, which is itself an honest result, not
  // a failure of the mechanism.
  let bestAst = null;
  WIN_SHARES_AST_ALPHA_GRID.forEach(astAlpha => {
    const diag = leaveOneOutDiagnostics(rows, alphaVectorFor(bestGlobal.alpha, astAlpha));
    if (diag && (!bestAst || diag.r2 > bestAst.diag.r2)) bestAst = { astAlpha, diag };
  });
  if (!bestAst) return null;

  const fit = fitSignConstrainedRidge(rows, alphaVectorFor(bestGlobal.alpha, bestAst.astAlpha));
  if (!fit) return null;
  return {
    ...fit,
    alpha: bestGlobal.alpha,
    astAlpha: bestAst.astAlpha,
    looR2: bestAst.diag.r2,
    looCorrelation: bestAst.diag.correlation,
    n: rows.length,
  };
}

function playerMarginContribution(s, sh, def, fit) {
  return WIN_SHARES_FEATURES.reduce((sum, f) => sum + fit.weights[f.key] * f.extract(s, sh, def), fit.intercept);
}

// Per the spec: a win contributes a fixed 1.0 "win" to be split across that team's own roster,
// proportional to each player's regression-weighted contribution that game (clipped to
// non-negative, so a player the model says actively hurt their team gets none of it rather than
// a negative share); a loss contributes zero, matching the real Win Shares convention. Falls back
// to an even split if every contribution on a winning team clips to zero.
// Excludes stoppedEarly games: this is fit and split per-game, not aggregated across a season
// the way rate stats are, and a margin from an incomplete game isn't a real outcome to credit
// wins against (see poolean-stopped-early-spec.md).
function computeWinShares(playerId, weights) {
  if (!weights) return null;
  const games = qualifyingGamesForPlayer(playerId).filter(g => g.scoringEvents.length > 0 && !g.stoppedEarly);
  if (games.length === 0) return null;
  let total = 0;
  games.forEach(game => {
    const onA = game.teamA.includes(playerId);
    const myTeam = onA ? game.teamA : game.teamB;
    const scoreA = teamScore(game, game.teamA);
    const scoreB = teamScore(game, game.teamB);
    const won = onA ? scoreA > scoreB : scoreB > scoreA;
    if (!won) return;
    const contribs = myTeam.map(pid => ({
      pid, c: Math.max(0, playerMarginContribution(
        getOrCreatePlayerStats(game, pid), shootingStats(game, pid), gameDefenseStats(game, pid), weights,
      )),
    }));
    const sum = contribs.reduce((acc, c) => acc + c.c, 0);
    const mine = contribs.find(c => c.pid === playerId).c;
    total += sum > 0 ? mine / sum : 1 / myTeam.length;
  });
  return { gp: games.length, winShares: total };
}

// See poolean-winshares-signconstrained-spec.md's own "what a weight landing at exactly 0 means"
// section: this isn't a failure of the method, it means that stat isn't adding independent
// predictive information once other, correlated stats are already in the model. Purely a display
// helper for the Win Shares Model panel below.
function renderWinSharesModelPanel() {
  const wrap = document.getElementById("winSharesModelPanel");
  if (!wrap) return;
  const weights = computeWinSharesWeights();
  if (!weights) {
    wrap.innerHTML = '<p class="empty-state">Not enough reviewed, non-stopped-early games yet to fit this model.</p>';
    return;
  }
  const rows = WIN_SHARES_FEATURES.map(f => {
    const w = weights.weights[f.key];
    const atFloor = Math.abs(w) < 1e-6;
    return `<tr><td>${escapeHtml(f.label)}</td><td>${w >= 0 ? "+" : ""}${w.toFixed(3)}${atFloor ? ' <span class="hint" style="margin:0">(0: no independent signal yet)</span>' : ""}</td></tr>`;
  }).join("");
  wrap.innerHTML = `
    <p class="hint" style="margin-top:0">Fit from <strong>${weights.n}</strong> player-games. Alpha (regularization strength): <strong>${weights.alpha}</strong>, except Assists, which gets its own separately-tuned strength (<strong>${weights.astAlpha}</strong>) so its prior can have real pull rather than being technically present but functionally inert. Leave-one-out R&sup2;: <strong>${weights.looR2.toFixed(2)}</strong>. Leave-one-out correlation (predicted vs. actual margin): <strong>${weights.looCorrelation.toFixed(2)}</strong>.</p>
    <div class="table-scroll">
      <table class="matchup-table">
        <thead><tr><th>Stat</th><th>Fitted Weight</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  `;
}

function computeLeagueTsByZone() {
  const totals = {};
  LEAGUE_TS_ZONES.forEach(z => totals[z.key] = { pts: 0, fga: 0 });
  state.games.filter(isQualifyingGame).forEach(game => {
    game.scoringEvents.forEach(ev => {
      if (!ev.shotLocation || (ev.points !== 2 && ev.points !== 3)) return;
      const bucket = totals[shotBand(ev.shotLocation, ev.points)];
      if (!bucket) return;
      bucket.fga++;
      if (ev.made !== false) bucket.pts += ev.points;
    });
  });
  return LEAGUE_TS_ZONES.map(z => ({
    key: z.key,
    label: z.label,
    fga: totals[z.key].fga,
    ts: totals[z.key].fga > 0 ? trueShootingPct(totals[z.key].pts, totals[z.key].fga, 0) : null
  }));
}

function renderLeagueTsByZoneChart() {
  const wrap = document.getElementById("leagueTsByZoneChart");
  if (!wrap) return;
  const zones = computeLeagueTsByZone();
  if (zones.every(z => z.fga === 0)) {
    wrap.innerHTML = '<p class="empty-state">No field goals with a marked shot location yet.</p>';
    return;
  }
  const W = 420, H = 220, PAD_L = 16, PAD_R = 16, PAD_T = 26, PAD_B = 32;
  const plotW = W - PAD_L - PAD_R, plotH = H - PAD_T - PAD_B;
  const gap = 18;
  const barW = (plotW - gap * (zones.length - 1)) / zones.length;
  // TS% is mathematically uncapped at 100 — a small, hot-from-three sample can clear it (e.g. 1
  // make on 1 three-point attempt is pts/(2*fga) = 3/2 = 150%). The ceiling scales up to fit
  // whatever the data actually produced instead of assuming 100 is always the max.
  const ceiling = Math.max(100, ...zones.map(z => z.ts ?? 0)) * 1.08;
  const yScale = v => PAD_T + plotH - (v / ceiling) * plotH;

  const barsSvg = zones.map((z, i) => {
    const x = PAD_L + i * (barW + gap);
    const val = z.ts ?? 0;
    const y = yScale(val);
    const h = (PAD_T + plotH) - y;
    const fill = z.ts === null ? "var(--surface-muted)" : `hsl(${Math.min(120, (val / 100) * 120)}, 85%, 42%)`;
    return `
      <rect x="${x}" y="${y}" width="${barW}" height="${h}" rx="3" fill="${fill}">
        <title>${escapeHtml(z.label)}: ${z.ts === null ? "no data" : `${z.ts}% TS`} (${z.fga} attempt${z.fga === 1 ? "" : "s"})</title>
      </rect>
      <text x="${x + barW / 2}" y="${y - 6}" text-anchor="middle" class="ts-zone-value-label">${z.ts === null ? "&#8212;" : `${z.ts}%`}</text>
      <text x="${x + barW / 2}" y="${PAD_T + plotH + 16}" text-anchor="middle" class="ts-zone-axis-label">${escapeHtml(z.label)}</text>
    `;
  }).join("");

  wrap.innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" class="ts-zone-svg">
      <line x1="${PAD_L}" y1="${PAD_T + plotH}" x2="${W - PAD_R}" y2="${PAD_T + plotH}" class="ts-line-axis" />
      ${barsSvg}
    </svg>
  `;
}

// How often a player's own missed shot ends up out of bounds (a turnover for them, per
// Poolean's "whoever last touched it loses possession" rule) vs. staying live for either team
// to rebound. Scoped to misses specifically — a make can never go out of bounds — so this reads
// as "when this player misses, how often does the ball leave their hands for good," not a
// shooting-accuracy stat.
// "True" second-chance conversion — same algorithm as scripts/second-chance-analysis.js
// (the standalone script this panel was built from), kept in sync with it deliberately, just
// running against whatever's already loaded in this browser instead of an exported file. An
// offensive rebound is a missed shot with a rebounderId on the shooter's own team; it counts as
// *converted* if, within the calibrated second-chance window of the miss's own videoTime, either that
// rebounder scored themselves or someone else scored with that rebounder as the assist — either
// path counts once, not twice. Both the miss and the candidate score need a real videoTime to
// be checked; a miss logged without one still counts toward OREB but can't be evaluated for
// conversion, same "don't guess" stance as Game-Winning Buckets. Single adjustable constant,
// not a UI setting, same reasoning as every other threshold on this page.

function computeSecondChanceConversions() {
  const totals = {}; // playerId -> { oreb, converted, noTimestamp }
  state.games.filter(isQualifyingGame).forEach(game => {
    const events = game.scoringEvents;
    events.forEach(ev => {
      if (ev.made === false && ev.rebounderId && sameTeam(game, ev.scorerId, ev.rebounderId)) {
        const t = totals[ev.rebounderId] = totals[ev.rebounderId] || { oreb: 0, converted: 0, noTimestamp: 0 };
        t.oreb++;
        const hasTimestamp = ev.videoTime !== null && ev.videoTime !== undefined;
        if (!hasTimestamp) { t.noTimestamp++; return; }
        const windowStart = ev.videoTime;
        const windowEnd = ev.videoTime + secondChanceWindowSeconds();
        const converted = events.some(cand => {
          if (cand === ev || cand.made === false) return false;
          if (cand.videoTime === null || cand.videoTime === undefined) return false;
          if (cand.videoTime < windowStart || cand.videoTime > windowEnd) return false;
          return cand.scorerId === ev.rebounderId || cand.assistId === ev.rebounderId;
        });
        if (converted) t.converted++;
      }
    });
  });
  return Object.entries(totals)
    .map(([playerId, v]) => ({ player: state.players.find(p => p.id === playerId), ...v }))
    .filter(r => r.player)
    .sort((a, b) => b.oreb - a.oreb);
}

const SECOND_CHANCE_COLUMNS = [
  { key: "player", label: "Player", accessor: r => r.player.name },
  { key: "oreb", label: "OREB", accessor: r => r.oreb },
  { key: "converted", label: "Converted", accessor: r => r.converted },
  { key: "rate", label: "Rate", accessor: r => pct(r.converted, r.oreb) }
];
let secondChanceSort = { key: "oreb", dir: "desc" };

function renderSecondChancePanel() {
  renderSortableHeader(document.getElementById("secondChanceHeaderRow"), SECOND_CHANCE_COLUMNS, secondChanceSort, renderSecondChancePanel);
  const rows = computeSecondChanceConversions();
  const sortCol = SECOND_CHANCE_COLUMNS.find(c => c.key === secondChanceSort.key);
  rows.sort((a, b) => compareForSort(sortCol.accessor(a), sortCol.accessor(b), secondChanceSort.dir));
  const totalNoTimestamp = rows.reduce((sum, r) => sum + r.noTimestamp, 0);
  const summaryEl = document.getElementById("secondChanceSummary");
  summaryEl.textContent = totalNoTimestamp > 0
    ? `${totalNoTimestamp} offensive rebound${totalNoTimestamp === 1 ? "" : "s"} had no video timestamp on the missed shot and couldn't be checked for conversion (still counted toward OREB, never toward Converted or Rate).`
    : "";
  const body = document.getElementById("secondChanceBody");
  body.innerHTML = rows.length === 0
    ? '<tr><td colspan="4" class="empty-state">No offensive rebounds logged yet.</td></tr>'
    : rows.map(r => `<tr><td>${playerLink(r.player.id, r.player.name)}</td><td>${r.oreb}</td><td>${r.converted}</td><td>${formatPct(pct(r.converted, r.oreb))}</td></tr>`).join("");
}

// ---------- Second-Chance Points Allowed (see poolean-rebound-battle-panels-spec.md) ----------
// Rebuilt entirely on real Rebound Battle data, replacing the earlier self-rebound-only stopgap.
// That version was a real improvement over the original (which charged the shot's defender no
// matter who grabbed the rebound), but it was still a workaround for missing data: self-rebounds
// happen to be the one case where "the shot's defender" and "whoever actually lost the rebound
// battle" are guaranteed to be the same relationship, at the cost of almost the entire sample
// (self-crash-and-putbacks are rare). Now that reboundContesterIds tags who ACTUALLY lost the
// battle, this fires whenever the offense keeps its own miss alive (rebounder's team == shooter's
// team) via a real contest, and charges whichever tagged contester(s) are on the DEFENDING side --
// a contester can theoretically be an offensive teammate who also went for the ball, and only the
// defensive-side losers had any real responsibility for the possession not ending. Same
// second-chance window conversion-check logic as Second-Chance Conversion. Lower rate is
// better here (the opposite of the offensive version).
//
// Deliberately NOT gated at REBOUND_BATTLE_MIN_CONTESTS like Rebound Battle Record/the Head-to-
// Head grid: this panel's own denominator (real contests that are ALSO offensive rebounds AND
// have a defensive-side loser) is a much smaller subset of real contests, and gating it the same
// way would leave the panel showing almost nobody. The spec's own instruction for genuinely thin
// numbers here (1-4 situations per player, expected for a while) is to label the low-sample state
// clearly rather than hide it -- a 1-situation 100% sitting next to a real 25% needs a visible
// flag, not to be gated into invisibility. See the "small sample" flag on any row below
// REBOUND_BATTLE_MIN_CONTESTS in the render function below.
function computeSecondChancePointsAllowed() {
  const totals = {}; // defenderId -> { situations, allowed, noTimestamp }
  state.games.filter(isQualifyingGame).forEach(game => {
    const events = game.scoringEvents;
    events.forEach(ev => {
      if (ev.made !== false || !ev.rebounderId || ev.turnoverEventId) return;
      if (!sameTeam(game, ev.scorerId, ev.rebounderId)) return; // must be an offensive rebound
      const contesters = ev.reboundContesterIds || [];
      if (contesters.length === 0) return; // real contest required -- no-contest/untagged excluded
      const scorerTeam = game.teamA.includes(ev.scorerId) ? game.teamA : game.teamB;
      const defensiveLosers = contesters.filter(id => !scorerTeam.includes(id));
      if (defensiveLosers.length === 0) return; // every tagged loser was actually on offense
      const hasTimestamp = ev.videoTime !== null && ev.videoTime !== undefined;
      let allowed = false;
      if (hasTimestamp) {
        const windowStart = ev.videoTime;
        const windowEnd = ev.videoTime + secondChanceWindowSeconds();
        allowed = events.some(cand => {
          if (cand === ev || cand.made === false) return false;
          if (cand.videoTime === null || cand.videoTime === undefined) return false;
          if (cand.videoTime < windowStart || cand.videoTime > windowEnd) return false;
          return cand.scorerId === ev.rebounderId || cand.assistId === ev.rebounderId;
        });
      }
      defensiveLosers.forEach(defId => {
        const t = totals[defId] = totals[defId] || { situations: 0, allowed: 0, noTimestamp: 0 };
        t.situations++;
        if (!hasTimestamp) { t.noTimestamp++; return; }
        if (allowed) t.allowed++;
      });
    });
  });
  return Object.entries(totals)
    .map(([playerId, v]) => ({ player: state.players.find(p => p.id === playerId), ...v }))
    .filter(r => r.player)
    .sort((a, b) => b.situations - a.situations);
}

const SECOND_CHANCE_ALLOWED_COLUMNS = [
  { key: "player", label: "Player", accessor: r => r.player.name },
  { key: "situations", label: "Situations", accessor: r => r.situations },
  { key: "allowed", label: "Allowed", accessor: r => r.allowed },
  { key: "rate", label: "Rate", accessor: r => pct(r.allowed, r.situations) }
];
let secondChanceAllowedSort = { key: "rate", dir: "asc" };

function renderSecondChanceAllowedPanel() {
  const headerRow = document.getElementById("secondChanceAllowedHeaderRow");
  if (!headerRow) return;
  renderSortableHeader(headerRow, SECOND_CHANCE_ALLOWED_COLUMNS, secondChanceAllowedSort, renderSecondChanceAllowedPanel);
  const rows = computeSecondChancePointsAllowed();
  const sortCol = SECOND_CHANCE_ALLOWED_COLUMNS.find(c => c.key === secondChanceAllowedSort.key);
  rows.sort((a, b) => compareForSort(sortCol.accessor(a), sortCol.accessor(b), secondChanceAllowedSort.dir));
  const totalNoTimestamp = rows.reduce((sum, r) => sum + r.noTimestamp, 0);
  const summaryEl = document.getElementById("secondChanceAllowedSummary");
  if (summaryEl) {
    summaryEl.textContent = totalNoTimestamp > 0
      ? `${totalNoTimestamp} situation${totalNoTimestamp === 1 ? "" : "s"} had no video timestamp on the original missed shot and couldn't be checked for conversion (still counted toward Situations, never toward Allowed or Rate).`
      : "";
  }
  const body = document.getElementById("secondChanceAllowedBody");
  body.innerHTML = rows.length === 0
    ? '<tr><td colspan="4" class="empty-state">No real rebound-battle-losing defenders on an offensive board yet.</td></tr>'
    : rows.map(r => {
        // Not a hard gate (see this panel's own doc comment above) -- a visible flag instead, so
        // a thin sample doesn't read as equally settled next to a real one.
        const thin = r.situations < REBOUND_BATTLE_MIN_CONTESTS;
        const thinFlag = thin ? ` <span class="hint" style="margin:0" title="Fewer than ${REBOUND_BATTLE_MIN_CONTESTS} situations: too little data to treat as a settled number yet">(small sample)</span>` : "";
        return `<tr><td>${playerLink(r.player.id, r.player.name)}</td><td>${r.situations}${thinFlag}</td><td>${r.allowed}</td><td>${formatPct(pct(r.allowed, r.situations))}</td></tr>`;
      }).join("");
}

function computeOutOfBoundsStats() {
  const totals = {}; // playerId -> { misses, oob }
  state.games.filter(isQualifyingGame).forEach(g => {
    g.scoringEvents.filter(ev => ev.made === false).forEach(ev => {
      const t = totals[ev.scorerId] = totals[ev.scorerId] || { misses: 0, oob: 0 };
      t.misses++;
      if (ev.turnoverEventId) t.oob++;
    });
  });
  return Object.entries(totals)
    .map(([playerId, v]) => ({ player: state.players.find(p => p.id === playerId), ...v }))
    .filter(r => r.player)
    .sort((a, b) => b.misses - a.misses);
}

const OUT_OF_BOUNDS_COLUMNS = [
  { key: "player", label: "Player", accessor: r => r.player.name },
  { key: "misses", label: "Misses", accessor: r => r.misses },
  { key: "oob", label: "Out of Bounds", accessor: r => r.oob },
  { key: "oobPct", label: "OOB%", accessor: r => pct(r.oob, r.misses) }
];
let outOfBoundsSort = { key: "misses", dir: "desc" };

function renderOutOfBoundsPanel() {
  renderSortableHeader(document.getElementById("outOfBoundsHeaderRow"), OUT_OF_BOUNDS_COLUMNS, outOfBoundsSort, renderOutOfBoundsPanel);
  const rows = computeOutOfBoundsStats();
  const summaryEl = document.getElementById("outOfBoundsSummary");
  const totalMisses = rows.reduce((sum, r) => sum + r.misses, 0);
  const totalOob = rows.reduce((sum, r) => sum + r.oob, 0);
  summaryEl.textContent = totalMisses > 0
    ? `League-wide: ${totalOob} of ${totalMisses} missed shots this season went out of bounds (${formatPct(pct(totalOob, totalMisses))}).`
    : "No missed shots logged yet.";
  const sortCol = OUT_OF_BOUNDS_COLUMNS.find(c => c.key === outOfBoundsSort.key);
  rows.sort((a, b) => compareForSort(sortCol.accessor(a), sortCol.accessor(b), outOfBoundsSort.dir));
  const body = document.getElementById("outOfBoundsBody");
  body.innerHTML = rows.length === 0
    ? '<tr><td colspan="4" class="empty-state">No missed shots logged yet.</td></tr>'
    : rows.map(r => `<tr><td>${playerLink(r.player.id, r.player.name)}</td><td>${r.misses}</td><td>${r.oob}</td><td>${formatPct(pct(r.oob, r.misses))}</td></tr>`).join("");
}

// Same per-20 math as computeLeaderboard(), just scoped to a specific subset of one player's
// games (their games "with" vs. "without" a given teammate) instead of their whole season.
function computeRateSummaryForGames(playerId, games) {
  const totals = { pts: 0, oreb: 0, dreb: 0, ast: 0, stl: 0, blk: 0, tov: 0, pf: 0 };
  const shooting = { fgm: 0, fga: 0, tpm: 0, tpa: 0, ftm: 0, fta: 0 };
  const defense = { ptsAllowed: 0, timesBeaten: 0, stops: 0, blocksNotAlreadyStopped: 0 };
  let combinedPoints = 0;
  games.forEach(g => {
    const s = g.stats.find(st => st.playerId === playerId);
    if (s) STAT_FIELDS.forEach(f => totals[f] += s[f]);
    const sh = shootingStats(g, playerId);
    Object.keys(shooting).forEach(k => shooting[k] += sh[k]);
    const def = gameDefenseStats(g, playerId);
    defense.ptsAllowed += def.ptsAllowed;
    defense.timesBeaten += def.timesBeaten;
    defense.stops += def.stops;
    defense.blocksNotAlreadyStopped += def.blocksNotAlreadyStopped;
    combinedPoints += gameTotalPoints(g);
  });
  const totalOffRating = offensiveRating(totals, shooting);
  const totalTwoWay = totalOffRating + defensiveRating(totals, defense);
  const per20 = value => combinedPoints > 0 ? (value / combinedPoints) * 20 : 0;
  return { gp: games.length, offRatingPer20: per20(totalOffRating), twoWayPer20: per20(totalTwoWay) };
}

// Everything before the current season boundary, one row per closed season (state.seasonHistory),
// computed live off the still-fully-intact game records rather than a frozen snapshot — these
// numbers stay correct if a stat's formula ever changes later, same as every other computed
// number in this tool. Respects the imbalanced-games toggle (a 3-on-2 shouldn't count in a past
// season's numbers any more than it counts in the current one) but deliberately not the Include
// Past Seasons toggle itself — that toggle blends archived games INTO the live current-season
// view; this panel is the opposite, each closed season shown on its own row for comparison, never
// blended together.
function computeSeasonHistoryForPlayer(playerId) {
  return state.seasonHistory.map(season => {
    const seasonGames = state.games.filter(g =>
      g.scoringEvents.length > 0
      && (g.teamA.includes(playerId) || g.teamB.includes(playerId))
      && (includeImbalancedGames || isBalancedGame(g))
      && (season.startedAt ? (g.date || "") >= season.startedAt : true)
      && (g.date || "") <= season.endedAt
    );
    if (seasonGames.length === 0) return null;
    let wins = 0, losses = 0, ties = 0;
    seasonGames.forEach(g => {
      const result = playerGameResult(g, playerId);
      if (result === "W") wins++;
      else if (result === "L") losses++;
      else if (result === "T") ties++;
    });
    const summary = computeRateSummaryForGames(playerId, seasonGames);
    return {
      label: season.label, endedAt: season.endedAt, gp: seasonGames.length, wins, losses, ties,
      offRatingPer20: summary.offRatingPer20,
      defRatingPer20: summary.twoWayPer20 - summary.offRatingPer20,
      twoWayPer20: summary.twoWayPer20
    };
  }).filter(Boolean);
}

function renderSeasonHistoryPanel(playerId) {
  const wrap = document.getElementById("playerSeasonHistory");
  if (!wrap) return;
  const rows = computeSeasonHistoryForPlayer(playerId);
  if (rows.length === 0) {
    wrap.innerHTML = '<p class="empty-state">No past seasons recorded for this player yet.</p>';
    return;
  }
  const rowsHtml = rows.map(r => `<tr>
    <td>${escapeHtml(r.label)}</td>
    <td>${r.gp}</td>
    <td>${r.wins}-${r.losses}${r.ties ? `-${r.ties}` : ""}</td>
    <td>${r.offRatingPer20.toFixed(1)}</td>
    <td>${r.defRatingPer20.toFixed(1)}</td>
    <td>${r.twoWayPer20.toFixed(1)}</td>
  </tr>`).join("");
  wrap.innerHTML = `
    <div class="table-scroll">
      <table class="matchup-table">
        <thead><tr><th>Season</th><th>GP</th><th>Record</th><th>Off Rating/20</th><th>Def Rating/20</th><th>Two-Way/20</th></tr></thead>
        <tbody>${rowsHtml}</tbody>
      </table>
    </div>
  `;
}

// The league-wide equivalent of computeSeasonHistoryForPlayer() above — same per-season game
// filter (real shots logged, balanced unless includeImbalancedGames is on, within that season's
// own [startedAt, endedAt] date range), just pooled across every player instead of scoped to
// one, for full standings of one specific closed season rather than one player's row in it.
function computeLeagueSeasonStandings(season) {
  return state.players.map(p => {
    const seasonGames = state.games.filter(g =>
      g.scoringEvents.length > 0
      && (g.teamA.includes(p.id) || g.teamB.includes(p.id))
      && (includeImbalancedGames || isBalancedGame(g))
      && (season.startedAt ? (g.date || "") >= season.startedAt : true)
      && (g.date || "") <= season.endedAt
    );
    if (seasonGames.length === 0) return null;
    let wins = 0, losses = 0, ties = 0;
    seasonGames.forEach(g => {
      const result = playerGameResult(g, p.id);
      if (result === "W") wins++;
      else if (result === "L") losses++;
      else if (result === "T") ties++;
    });
    const summary = computeRateSummaryForGames(p.id, seasonGames);
    return {
      player: p, gp: seasonGames.length, wins, losses, ties,
      offRatingPer20: summary.offRatingPer20,
      defRatingPer20: summary.twoWayPer20 - summary.offRatingPer20,
      twoWayPer20: summary.twoWayPer20
    };
  }).filter(Boolean).sort((a, b) => b.twoWayPer20 - a.twoWayPer20);
}

// Rebuilds the season <select>'s options from state.seasonHistory (most recently ended first),
// trying to keep whatever was already selected in place across a re-render (e.g. from an
// unrelated toggle click triggering renderLeaderboard()) by matching on label rather than index,
// since seasons have no id field of their own.
function renderLeagueSeasonSelect() {
  const sel = document.getElementById("leagueSeasonSelect");
  if (!sel) return;
  const sorted = [...state.seasonHistory].sort((a, b) => (b.endedAt || "").localeCompare(a.endedAt || ""));
  if (sorted.length === 0) {
    sel.innerHTML = '<option value="">No seasons closed yet</option>';
    sel.disabled = true;
    return;
  }
  sel.disabled = false;
  const prevLabel = sel.selectedOptions[0]?.textContent;
  sel.innerHTML = sorted.map((s, i) => `<option value="${i}">${escapeHtml(s.label)}</option>`).join("");
  const matchIndex = sorted.findIndex(s => s.label === prevLabel);
  if (matchIndex !== -1) sel.value = String(matchIndex);
}
document.getElementById("leagueSeasonSelect").addEventListener("change", renderLeagueSeasonStandings);

function renderLeagueSeasonStandings() {
  renderLeagueSeasonSelect();
  const sel = document.getElementById("leagueSeasonSelect");
  const wrap = document.getElementById("leagueSeasonStandings");
  if (!sel || !wrap) return;
  if (state.seasonHistory.length === 0) {
    wrap.innerHTML = '<p class="empty-state">No seasons closed yet (Export → Data Management → Start New Season). Nothing archived to show.</p>';
    return;
  }
  const sorted = [...state.seasonHistory].sort((a, b) => (b.endedAt || "").localeCompare(a.endedAt || ""));
  const season = sorted[Number(sel.value)] || sorted[0];
  const rows = computeLeagueSeasonStandings(season);
  if (rows.length === 0) {
    wrap.innerHTML = '<p class="empty-state">No games with real shots logged in this season.</p>';
    return;
  }
  const rowsHtml = rows.map((r, i) => `<tr>
    <td>${i + 1}</td>
    <td><button type="button" class="icon-btn league-season-player-btn" style="color:var(--accent);font-weight:700" data-player-id="${r.player.id}">${escapeHtml(r.player.name)}</button></td>
    <td>${r.gp}</td>
    <td>${r.wins}-${r.losses}${r.ties ? `-${r.ties}` : ""}</td>
    <td>${r.offRatingPer20.toFixed(1)}</td>
    <td>${r.defRatingPer20.toFixed(1)}</td>
    <td>${r.twoWayPer20.toFixed(1)}</td>
  </tr>`).join("");
  wrap.innerHTML = `
    <div class="table-scroll">
      <table class="matchup-table">
        <thead><tr><th>#</th><th>Player</th><th>GP</th><th>Record</th><th>Off Rating/20</th><th>Def Rating/20</th><th>Two-Way/20</th></tr></thead>
        <tbody>${rowsHtml}</tbody>
      </table>
    </div>
  `;
  wrap.querySelectorAll(".league-season-player-btn").forEach(btn => {
    btn.addEventListener("click", () => openPlayerDetail(btn.dataset.playerId));
  });
}

// Whether this player ended up on either roster of any game actually logged for a given date —
// deliberately not gated by isQualifyingGame() (real shots + balanced teams): attendance is
// about whether they physically showed up, not whether that game happened to get scored or came
// out even-sided. A game record existing with them rostered is attendance; nothing rostered for
// that date at all just means unresolved (see computeFlakeStats() below), not absent.
function playerAttendedDate(playerId, date) {
  return state.games.some(g => g.date === date && (g.teamA.includes(playerId) || g.teamB.includes(playerId)));
}

// Flake % = of the dates this player RSVP'd yes for AND that have since been resolved (at least
// one game logged for that date, regardless of who's on it), what share they never actually
// showed up for. An RSVP'd date with zero games logged yet is excluded from the denominator
// entirely — the session may just not be entered in the tracker yet, which isn't the same as a
// no-show, and counting it that way would punish players for Ben's own reviewing backlog. `pct`
// is null (not 0) when nothing's resolved yet, same "no data" convention used everywhere else in
// this tool, so the UI can say so plainly instead of showing a misleading 0%.
function computeFlakeStats(playerId) {
  const rsvpDates = state.rsvps.filter(r => r.playerIds.includes(playerId));
  let resolved = 0, flaked = 0;
  rsvpDates.forEach(r => {
    if (!state.games.some(g => g.date === r.date)) return;
    resolved++;
    if (!playerAttendedDate(playerId, r.date)) flaked++;
  });
  return { resolved, flaked, pct: resolved > 0 ? pct(flaked, resolved) : null };
}

// ---------- Personalized Tips ----------
// Not a fixed checklist — every candidate tip below is just this player's own number next to the
// league average for that same stat, and only the ones that actually stand out get shown (same
// "rank by distance from average, don't force a fixed count" idea Play Style Clusters' own
// labeling already uses). Needs a real sample (PLAYER_TIPS_MIN_GP qualifying games) before
// showing anything at all — a hot or cold stretch over 1-2 games isn't a pattern yet, it's noise
// dressed up as a coaching note.
const PLAYER_TIPS_MIN_GP = 3;

// Turns a tip from "here's a stat" into "here's where to go watch it" — the actual improvement
// mechanism, since a percentage on its own doesn't teach anyone anything a real clip review does.
// Both helpers return the most recent few qualifying games (capped, not exhaustive) that actually
// contain the shots behind a given tip, for a "Watch film" row of direct openGame() links.
function gamesForZoneShots(playerId, zoneKey, made) {
  // shotBand() (the per-event classifier) returns "arc" for the 3PT-line zone; SHOT_ZONES itself
  // spells that same zone "line" — the two vocabularies never got reconciled since SHOT_ZONES
  // predates this lookup, so translate at the one call site that needs both instead of renaming
  // either existing constant and risking a mismatch somewhere that already depends on the old name.
  const bandKey = zoneKey === "line" ? "arc" : zoneKey;
  const matches = ev =>
    ev.scorerId === playerId && (ev.made !== false) === made && (ev.points === 2 || ev.points === 3) &&
    ev.shotLocation && shotBand(ev.shotLocation, ev.points) === bandKey;
  const games = state.games.filter(isQualifyingGame).map(g => {
    const hits = g.scoringEvents.filter(matches);
    if (hits.length === 0) return null;
    // Last matching event in this game's own log order, i.e. the most recent instance within it.
    return { id: g.id, date: g.date, videoTime: hits[hits.length - 1].videoTime };
  }).filter(Boolean);
  return games.sort((a, b) => (b.date || "").localeCompare(a.date || "")).slice(0, 3);
}
function gamesForMatchup(scorerId, defenderId) {
  const matches = ev => ev.scorerId === scorerId && (ev.defenderIds || []).includes(defenderId);
  const games = state.games.filter(isQualifyingGame).map(g => {
    const hits = g.scoringEvents.filter(matches);
    if (hits.length === 0) return null;
    return { id: g.id, date: g.date, videoTime: hits[hits.length - 1].videoTime };
  }).filter(Boolean);
  return games.sort((a, b) => (b.date || "").localeCompare(a.date || "")).slice(0, 3);
}

function computePlayerTips(playerId) {
  const board = computeLeaderboard().filter(r => r.gp > 0);
  const row = board.find(r => r.player.id === playerId);
  if (!row || row.gp < PLAYER_TIPS_MIN_GP) return null;

  const leagueAvg = accessor => {
    const vals = board.map(accessor).filter(v => v !== null && v !== undefined && !Number.isNaN(v));
    return vals.length > 0 ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
  };

  const candidates = [];

  // Turnovers: how often they turn it over relative to their own scoring opportunities.
  const avgTov = leagueAvg(r => r.tovPct);
  if (avgTov !== null && row.tovPct - avgTov >= 4) {
    candidates.push({ diff: row.tovPct - avgTov, icon: "🎯", text: `Ball security: your turnover rate (${formatPct(row.tovPct)}) is running ${(row.tovPct - avgTov).toFixed(0)} points above the league average (${formatPct(avgTov)}). Tightening decisions with the ball is probably the single fastest way to add value right now.` });
  }

  // Defense: opponent shooting % against them, only once they've actually been tagged enough to
  // mean something (fewer than 5 tagged attempts is too small a sample to say anything real).
  // avgOppFg is also reused below by the defender-side matchup tip.
  const defAttempts = row.defense.timesBeaten + row.defense.stops;
  const avgOppFg = leagueAvg(r => {
    const a = r.defense.timesBeaten + r.defense.stops;
    return a >= 5 ? pct(r.defense.timesBeaten, a) : null;
  });
  if (defAttempts >= 5) {
    const oppFg = pct(row.defense.timesBeaten, defAttempts);
    if (avgOppFg !== null && oppFg - avgOppFg >= 8) {
      candidates.push({ diff: oppFg - avgOppFg, icon: "🛡️", text: `Defense: opponents are shooting ${formatPct(oppFg)} against you, well above the ${formatPct(avgOppFg)} league average allowed. Tighter closeouts or picking your defensive matchups more carefully could close that gap.` });
    } else if (avgOppFg !== null && avgOppFg - oppFg >= 8) {
      candidates.push({ diff: avgOppFg - oppFg, icon: "🛡️", text: `Defense: opponents are shooting just ${formatPct(oppFg)} against you, well below the ${formatPct(avgOppFg)} league average. Whatever you're doing on that end is working: real strength, not a fluke at ${row.gp} games.` });
    }
  }

  // Matchup-specific, as scorer: a real weak or strong shooting split against one specific
  // defender they've actually faced enough to mean something (5+ attempts), not a single bad
  // possession. Compared against their own overall FG%, not the league's — this is about how
  // this defender changes *their* shot, not a league-wide ranking.
  const ownFgPct = pct(row.shooting.fgm, row.shooting.fga);
  const scorerMatchups = headToHeadAsScorer(playerId).filter(m => m.defenderId && m.fga >= 5);
  if (scorerMatchups.length > 0 && ownFgPct !== null) {
    const worst = scorerMatchups.reduce((a, b) => pct(b.fgm, b.fga) < pct(a.fgm, a.fga) ? b : a);
    const worstPct = pct(worst.fgm, worst.fga);
    if (ownFgPct - worstPct >= 15) {
      const name = state.players.find(p => p.id === worst.defenderId)?.name || "?";
      candidates.push({ diff: ownFgPct - worstPct, icon: "⚠️", text: `Matchup to watch: ${name} has held you to ${formatPct(worstPct)} shooting (${worst.fga} attempts), well under your own ${formatPct(ownFgPct)} overall. Worth a different look (a different spot on the floor, a screen, anything) when they're the one on you.`, games: gamesForMatchup(playerId, worst.defenderId) });
    }
    const best = scorerMatchups.reduce((a, b) => pct(b.fgm, b.fga) > pct(a.fgm, a.fga) ? b : a);
    const bestPct = pct(best.fgm, best.fga);
    if (bestPct - ownFgPct >= 15 && best.defenderId !== worst.defenderId) {
      const name = state.players.find(p => p.id === best.defenderId)?.name || "?";
      candidates.push({ diff: bestPct - ownFgPct, icon: "✅", text: `Favorable matchup: you're shooting ${formatPct(bestPct)} against ${name} (${best.fga} attempts), well above your own ${formatPct(ownFgPct)} overall. Worth hunting that matchup, or at least not shying away from it, when you get the chance.`, games: gamesForMatchup(playerId, best.defenderId) });
    }
  }

  // Matchup-specific, as defender: one scorer who's genuinely torched them specifically, beyond
  // what this player allows overall — not just "a good shooter had a good night."
  const defenderMatchups = headToHeadAsDefender(playerId).filter(m => m.fga >= 5);
  if (defenderMatchups.length > 0 && avgOppFg !== null) {
    const worst = defenderMatchups.reduce((a, b) => pct(b.fgm, b.fga) > pct(a.fgm, a.fga) ? b : a);
    const worstAllowed = pct(worst.fgm, worst.fga);
    if (worstAllowed - avgOppFg >= 15) {
      const name = state.players.find(p => p.id === worst.scorerId)?.name || "?";
      candidates.push({ diff: worstAllowed - avgOppFg, icon: "⚠️", text: `Defensive matchup to watch: ${name} is shooting ${formatPct(worstAllowed)} against you specifically (${worst.fga} attempts), well above what you allow overall. Extra help on that matchup, or a different defender entirely, might be worth it.`, games: gamesForMatchup(worst.scorerId, playerId) });
    }
  }

  // Shot selection: volume vs. efficiency, mirroring the Volume vs. Efficiency chart's own
  // "mirror opposites" framing but scoped to this one player instead of a scatter plot.
  const avgTs = leagueAvg(r => trueShootingPct(r.totals.pts, r.shooting.fga, r.shooting.fta));
  const avgFga = leagueAvg(r => r.rateShooting.fga);
  const ownTs = trueShootingPct(row.totals.pts, row.shooting.fga, row.shooting.fta);
  if (avgTs !== null && avgFga !== null && ownTs !== null) {
    if (row.rateShooting.fga - avgFga >= 2 && avgTs - ownTs >= 8) {
      candidates.push({ diff: (avgTs - ownTs) + (row.rateShooting.fga - avgFga), icon: "🎯", text: `Shot selection: you're taking more shots per 20 than most (${row.rateShooting.fga.toFixed(1)} vs. ${avgFga.toFixed(1)} average) at a below-average TS% (${formatPct(ownTs)} vs. ${formatPct(avgTs)}). A more selective diet could raise the efficiency without giving up much volume.` });
    } else if (avgFga - row.rateShooting.fga >= 2 && ownTs - avgTs >= 8) {
      candidates.push({ diff: (ownTs - avgTs) + (avgFga - row.rateShooting.fga), icon: "🎯", text: `Shot selection: you're shooting ${formatPct(ownTs)} TS%, well above the ${formatPct(avgTs)} average, on fewer attempts than most (${row.rateShooting.fga.toFixed(1)} vs. ${avgFga.toFixed(1)} per 20). There's real room to take (and make) more without your efficiency needing to hold up on its own; it already has.` });
    }
  }

  // Shot profile: their real preferred zone (share of their own attempts) and a real strength or
  // weakness zone (FG% in a zone they've taken enough shots in to mean something), each checked
  // against the league's own average FG% from that same zone — not just "they shoot well from
  // deep" but "X%, vs. a Y% league average from that same distance." Reuses SHOT_ZONES (the same
  // four buckets the league-wide Shot Distance table sorts by), so this can never disagree with
  // that table's own numbers.
  const totalZoneAttempts = SHOT_ZONES.reduce((sum, z) => sum + z.attempts(row), 0);
  if (totalZoneAttempts >= 8) {
    const zoneStats = SHOT_ZONES.map(z => {
      const attempts = z.attempts(row), makes = z.makes(row);
      const leagueZoneFg = leagueAvg(r => {
        const a = z.attempts(r);
        return a >= 5 ? pct(z.makes(r), a) : null;
      });
      return { zone: z, attempts, fgPct: pct(makes, attempts), share: pct(attempts, totalZoneAttempts), leagueZoneFg };
    });
    const favorite = zoneStats.reduce((a, b) => b.attempts > a.attempts ? b : a);
    if (favorite.share >= 35) {
      candidates.push({ diff: favorite.share / 10, icon: "📍", text: `Shot profile: ${formatPct(favorite.share)} of their field goal attempts come from ${favorite.zone.label} (${favorite.attempts} attempts). That's their go-to spot, worth knowing whether you're setting up to feed them there or trying to take it away.` });
    }
    const meaningfulZones = zoneStats.filter(z => z.attempts >= 5 && z.leagueZoneFg !== null);
    if (meaningfulZones.length > 0) {
      const best = meaningfulZones.reduce((a, b) => (b.fgPct - b.leagueZoneFg) > (a.fgPct - a.leagueZoneFg) ? b : a);
      if (best.fgPct - best.leagueZoneFg >= 12) {
        candidates.push({ diff: best.fgPct - best.leagueZoneFg, icon: "🔥", text: `Strength: ${formatPct(best.fgPct)} from ${best.zone.label} (${best.attempts} attempts), well above the ${formatPct(best.leagueZoneFg)} league average from there. A real weapon from that range, worth respecting, not sagging off.`, games: gamesForZoneShots(playerId, best.zone.key, true) });
      }
      const worst = meaningfulZones.reduce((a, b) => (a.fgPct - a.leagueZoneFg) > (b.fgPct - b.leagueZoneFg) ? b : a);
      if (worst.leagueZoneFg - worst.fgPct >= 12) {
        candidates.push({ diff: worst.leagueZoneFg - worst.fgPct, icon: "❄️", text: `Weakness: just ${formatPct(worst.fgPct)} from ${worst.zone.label} (${worst.attempts} attempts), well under the ${formatPct(worst.leagueZoneFg)} league average from there. Sagging off there and daring that shot is a defensible bet.`, games: gamesForZoneShots(playerId, worst.zone.key, false) });
      }
    }
  }

  // Shot type: the player's own tagged shot types against the league's on the same type.
  candidates.push(...shotTypeTipCandidates(playerId));

  // Rebounding share, both boards combined.
  const avgTreb = leagueAvg(r => r.trebPct);
  if (avgTreb !== null && avgTreb - row.trebPct >= 8) {
    candidates.push({ diff: avgTreb - row.trebPct, icon: "🏀", text: `Rebounding: your share of available boards (${formatPct(row.trebPct)}) sits well under the ${formatPct(avgTreb)} league average. Boxing out on both ends is free extra possessions nobody has to pass you the ball for.` });
  }

  // Playmaking: assist share of their own team's assists.
  const avgAst = leagueAvg(r => r.astPct);
  if (avgAst !== null && avgAst - row.astPct >= 10 && (avgTov === null || row.tovPct - avgTov < 4)) {
    candidates.push({ diff: avgAst - row.astPct, icon: "🤝", text: `Playmaking: your share of your team's assists (${formatPct(row.astPct)}) is below the ${formatPct(avgAst)} average. Looking to set up a teammate one extra pass earlier could open up easier looks for everyone, yours included.` });
  }

  candidates.sort((a, b) => b.diff - a.diff);
  return candidates.slice(0, 4);
}

function renderPlayerTips(playerId) {
  const wrap = document.getElementById("playerTips");
  if (!wrap) return;
  const tips = computePlayerTips(playerId);
  if (tips === null) {
    wrap.innerHTML = `<p class="empty-state">Needs at least ${PLAYER_TIPS_MIN_GP} qualifying games before there's a real pattern to compare against the league average.</p>`;
    return;
  }
  if (tips.length === 0) {
    wrap.innerHTML = `<p class="empty-state">Nothing stands out from the league average in either direction: a genuinely well-rounded game right now.</p>`;
    return;
  }
  wrap.innerHTML = `<ul class="player-tips-list">${tips.map(t => {
    const watchLinks = watchFilmLinksHtml(t.games);
    return `<li><span class="player-tip-icon">${t.icon}</span><span>${t.text}${watchLinks}</span></li>`;
  }).join("")}</ul>`;
  wireWatchFilmButtons(wrap);
}

// ---------- Areas to Work On ----------
// A player's own rate for each category here next to the league MEDIAN for that same stat, not
// the average and not the league's best. The league leader would flag nearly every category for
// nearly every player and turn this into background noise nobody reads; the median is a real
// "behind where a typical player in this league is at this specific thing" bar, rare enough to be
// worth attention when it fires, common enough that most players land on 1-3 real flags, not 0 or
// 15. Every category has its own minimum-sample gate (spec'd exactly per category, not a rough
// guess); below that gate a category never flags at all — this is the single most important rule
// here, since a confident callout off 3 shots is worse than no callout at all. Both directions get
// surfaced, not just weaknesses: a category a player clearly beats the median on is useful to know
// too, if only so they know what NOT to change. Deliberately not ranked/truncated to a fixed
// count the way Personalized Tips above is — the gates themselves are what keep this small.
//
// Explicitly out of scope, on purpose: no prescriptive drills (this tool has no way to verify
// practice happened between games, so it only ever names the area, never how to fix it), no
// cross-player comparison framing (median-relative only, phrased about this player's own numbers,
// never "worse than so-and-so"), and no goal-setting/target-tracking (a real future feature, but
// one that needs its own storage and its own UI, not an extension of this one).
const AREAS_TO_WORK_ON_MIN_GP = 3;

function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

// Shared "is this already improving" check reused by every category below instead of seven
// near-identical per-category trend computations: sums `statFn(game, playerId)`'s own {num,
// denom} across every qualifying game for the season rate, and across just the last 3
// (chronological) for the recent one.
function seasonVsRecentRate(playerId, statFn) {
  const games = [...qualifyingGamesForPlayer(playerId)].sort((a, b) => (a.date || "").localeCompare(b.date || ""));
  const sumOver = list => list.reduce((acc, g) => {
    const s = statFn(g, playerId);
    acc.num += s.num; acc.denom += s.denom;
    return acc;
  }, { num: 0, denom: 0 });
  const season = sumOver(games);
  const recent = sumOver(games.slice(-3));
  return {
    seasonRate: season.denom > 0 ? (season.num / season.denom) * 100 : null,
    recentRate: recent.denom > 0 ? (recent.num / recent.denom) * 100 : null
  };
}
function trendNote(seasonRate, recentRate, higherIsBetter) {
  if (seasonRate === null || recentRate === null) return "";
  const improved = higherIsBetter ? recentRate - seasonRate : seasonRate - recentRate;
  if (improved < 3) return "";
  return ` Already trending the right way: ${seasonRate.toFixed(0)}% for the season, ${recentRate.toFixed(0)}% over your last 3.`;
}

// The shared shape behind every percent-based category (shot zones, TOV%, Wide-Open Shooting%):
// a season sample count (gated separately from the rate's own denominator — TOV%'s gate is a
// plain FGA+FTA+TOV count while its rate uses the FTA-weighted denominator TS%/TOV% already use
// elsewhere, so `sampleFn` lets a category's gate differ from its rate's own math when it needs
// to), a season rate, and the league median among every *other* player who clears that same
// category's own gate.
function computeAreaCategory(playerId, def) {
  const games = qualifyingGamesForPlayer(playerId);
  let num = 0, denom = 0, sample = 0;
  games.forEach(g => {
    const s = def.statFn(g, playerId);
    num += s.num; denom += s.denom;
    sample += def.sampleFn ? def.sampleFn(g, playerId) : s.denom;
  });
  if (sample < def.minSample || denom === 0) return null;
  const ownRate = (num / denom) * 100;

  const leagueRates = state.players.map(p => {
    if (p.id === playerId) return null;
    let n2 = 0, d2 = 0, s2 = 0;
    qualifyingGamesForPlayer(p.id).forEach(g => {
      const s = def.statFn(g, p.id);
      n2 += s.num; d2 += s.denom;
      s2 += def.sampleFn ? def.sampleFn(g, p.id) : s.denom;
    });
    if (s2 < def.minSample || d2 === 0) return null;
    return (n2 / d2) * 100;
  }).filter(v => v !== null);
  const leagueMedian = median(leagueRates);
  if (leagueMedian === null) return null;

  const { seasonRate, recentRate } = seasonVsRecentRate(playerId, def.statFn);
  return { ownRate, leagueMedian, trend: trendNote(seasonRate, recentRate, def.higherIsBetter) };
}

// Automated clip curation for Areas to Work On: reuses the exact same multi-game compile pipeline
// the league-wide "Combine All Clips" export already has (runClipExportFromGroups(), see its own
// comment) instead of introducing a second video-recording mechanism. Nothing new gets stored —
// no new fields, no manual tagging step — this just synthesizes a {start, end} clip (padded 5
// seconds either side, the same padding the real Mark-a-Clip highlight/lowlight flow already
// uses) around every matching scoringEvent's own already-existing videoTime, on the fly, purely
// for this one export. Only the four categories the spec actually describes a filter for get a
// "Watch these clips" button at all (shot zones, Wide-Open Shooting, turnover rate, defense) —
// A/TO, out-of-bounds, and Second-Chance Conversion still get the lighter per-game "Watch film"
// links built earlier, just not a compiled reel.
// Short labels for the "Watch these clips" button/status text and export filename -- only the
// four categories computeCategoryClipGroups() actually knows a filter for get an entry here, so
// every other category (A/TO, out-of-bounds, Second-Chance) silently gets no button at all, same
// as the spec's own scoping.
const AREA_CLIP_CATEGORY_LABELS = Object.fromEntries([
  ...SHOT_ZONES.map(z => [`zone_${z.key}`, `${z.label} shooting`]),
  ["wideopen", "Wide-open shooting"],
  ["tov", "Turnovers"],
  ["defense", "Defense"],
]);

const CLIP_CURATION_PAD_SECONDS = 5;
function computeCategoryClipGroups(playerId, categoryKey) {
  const bandKey = categoryKey.startsWith("zone_") ? categoryKey.slice(5) : null;
  const matchScoringEvent = ev => {
    if (bandKey) {
      // Both makes and misses in the flagged zone, on purpose — the spec's own point is seeing
      // what a make looks like right next to what a miss looks like, not just a reel of failures.
      if (ev.scorerId !== playerId || (ev.points !== 2 && ev.points !== 3) || !ev.shotLocation) return false;
      const wantBand = bandKey === "line" ? "arc" : bandKey; // shotBand()'s own "arc" vs. SHOT_ZONES' "line", see gamesForZoneShots()'s identical note
      return shotBand(ev.shotLocation, ev.points) === wantBand;
    }
    if (categoryKey === "wideopen") {
      return ev.scorerId === playerId && (ev.points === 2 || ev.points === 3) && (!ev.defenderIds || ev.defenderIds.length === 0);
    }
    if (categoryKey === "defense") {
      // Beaten and Stops combined into one reel rather than the spec's own two sub-groups — a
      // simplification for this first version; still real value seeing every tagged possession in
      // one place, and splitting later is just a second, narrower filter on the same mechanism.
      return (ev.defenderIds || []).includes(playerId);
    }
    return false;
  };

  const grouped = [];
  state.games.filter(isQualifyingGame).forEach(game => {
    const events = categoryKey === "tov"
      ? game.turnoverEvents.filter(ev => ev.playerId === playerId)
      : game.scoringEvents.filter(matchScoringEvent);
    const clips = events
      .filter(ev => ev.videoTime !== null && ev.videoTime !== undefined)
      .map(ev => ({ start: Math.max(0, ev.videoTime - CLIP_CURATION_PAD_SECONDS), end: ev.videoTime + CLIP_CURATION_PAD_SECONDS }))
      .sort((a, b) => a.start - b.start);
    if (clips.length > 0) grouped.push({ game, clips });
  });
  return grouped.sort((a, b) => (a.game.date || "").localeCompare(b.game.date || ""));
}

// Triggered from Player Detail (where Areas to Work On lives), but the actual recording/preview
// UI is the League Export panel on the Leaderboard tab — reused as-is rather than building a
// second video-preview element, so this switches there and scrolls to it before starting, the
// same "go look at the one place this always happens" pattern instead of a duplicate UI.
function startAreaClipExport(playerId, categoryKey, categoryLabel) {
  const grouped = computeCategoryClipGroups(playerId, categoryKey);
  if (grouped.length === 0) return;
  showTab("leaderboard");
  const previewWrap = document.getElementById("leagueExportPreviewWrap");
  previewWrap?.scrollIntoView({ behavior: "smooth", block: "center" });
  const statusEl = document.getElementById("leagueExportStatus");
  if (statusEl) statusEl.textContent = `Compiling clips for "${categoryLabel}"…`;
  const safeName = categoryLabel.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
  runClipExportFromGroups(grouped, `${safeName || "clips"}-clips`);
}

function computeAreasToWorkOn(playerId) {
  const board = computeLeaderboard().filter(r => r.gp > 0);
  const row = board.find(r => r.player.id === playerId);
  if (!row || row.gp < AREAS_TO_WORK_ON_MIN_GP) return null;

  const results = [];

  // Shooting efficiency by zone, min 5 attempts in that zone this season. Always paired with
  // that zone's share of this player's own shot diet, per the spec's own requirement — a weak
  // zone that's 40% of someone's shots matters more than one that's 5%.
  SHOT_ZONES.forEach(z => {
    const statFn = (g, pid) => { const sh = shootingStats(g, pid); return { num: z.makes({ shooting: sh }), denom: z.attempts({ shooting: sh }) }; };
    const cat = computeAreaCategory(playerId, { statFn, minSample: 5, higherIsBetter: true });
    if (!cat) return;
    const diff = cat.ownRate - cat.leagueMedian;
    if (Math.abs(diff) < 8) return;
    const isWeak = diff < 0;
    const totalFga = row.shooting.fga;
    const zoneFga = z.attempts(row);
    const share = totalFga > 0 ? pct(zoneFga, totalFga) : null;
    const shareNote = share !== null
      ? ` This is ${zoneFga} of your ${totalFga} shot attempts this season (${formatPct(share)} of your diet)${share >= 25 ? (isWeak ? ", worth genuinely working on given how often it comes up" : ", a real weapon given how often you get there") : share < 10 ? ", low-volume enough that it's a minor factor either way" : ""}.`
      : "";
    results.push({
      key: `zone_${z.key}`, isWeak,
      text: `Your ${z.label} shooting is ${formatPct(cat.ownRate)}, ${isWeak ? "below" : "above"} the league median of ${formatPct(cat.leagueMedian)}.${shareNote}${cat.trend}`,
      games: gamesForZoneShots(playerId, z.key, !isWeak)
    });
  });

  // TOV%: min 10 combined FGA+FTA+TOV (a plain count, deliberately not the FTA-weighted
  // denominator turnoverPct() itself uses for the rate).
  {
    const statFn = (g, pid) => { const s = getOrCreatePlayerStats(g, pid); const sh = shootingStats(g, pid); return { num: s.tov, denom: sh.fga + 0.44 * sh.fta + s.tov }; };
    const sampleFn = (g, pid) => { const s = getOrCreatePlayerStats(g, pid); const sh = shootingStats(g, pid); return sh.fga + sh.fta + s.tov; };
    const cat = computeAreaCategory(playerId, { statFn, sampleFn, minSample: 10, higherIsBetter: false });
    if (cat) {
      const diff = cat.ownRate - cat.leagueMedian;
      if (Math.abs(diff) >= 4) {
        const isWeak = diff > 0;
        results.push({ key: "tov", isWeak, text: `Your turnover rate is ${formatPct(cat.ownRate)}, ${isWeak ? "above" : "below"} the league median of ${formatPct(cat.leagueMedian)}.${cat.trend}` });
      }
    }
  }

  // A/TO: min 5 assists or turnovers combined. A ratio, not a percentage, so it's handled
  // separately from computeAreaCategory's percent-shaped engine — including the zero-turnover
  // edge case (an infinite ratio reads as an automatic, real strength, not a division to skip).
  {
    const totals = row.totals;
    const sample = totals.ast + totals.tov;
    if (sample >= 5) {
      const leagueRatios = board.filter(r => r.player.id !== playerId && (r.totals.ast + r.totals.tov) >= 5 && r.totals.tov > 0).map(r => r.totals.ast / r.totals.tov);
      const leagueMedian = median(leagueRatios);
      if (leagueMedian !== null) {
        if (totals.tov === 0 && totals.ast > 0) {
          results.push({ key: "atoto", isWeak: false, text: `Your assist-to-turnover ratio has no turnovers at all charged against ${totals.ast} assist${totals.ast === 1 ? "" : "s"} this season, an automatic strength beyond what the league median of ${leagueMedian.toFixed(1)} even measures.` });
        } else if (totals.tov > 0) {
          const ownRatio = totals.ast / totals.tov;
          const diff = ownRatio - leagueMedian;
          if (Math.abs(diff) >= 0.5) {
            const isWeak = diff < 0;
            results.push({ key: "atoto", isWeak, text: `Your assist-to-turnover ratio is ${ownRatio.toFixed(1)}, ${isWeak ? "below" : "above"} the league median of ${leagueMedian.toFixed(1)}.` });
          }
        }
      }
    }
  }

  // Wide-Open Shooting %: min 5 wide-open attempts. TS%-style (points per 2 shot-equivalents),
  // matching the league-wide Wide-Open Shooting panel's own formula exactly, so this can never
  // disagree with that table.
  {
    const statFn = (g, pid) => {
      let pts = 0, fga = 0;
      g.scoringEvents.forEach(ev => {
        if (ev.scorerId !== pid || (ev.points !== 2 && ev.points !== 3)) return;
        if (ev.defenderIds && ev.defenderIds.length > 0) return;
        fga++;
        if (ev.made !== false) pts += ev.points;
      });
      return { num: pts, denom: fga * 2 };
    };
    const cat = computeAreaCategory(playerId, { statFn, minSample: 5, higherIsBetter: true });
    if (cat) {
      const diff = cat.ownRate - cat.leagueMedian;
      if (Math.abs(diff) >= 8) {
        const isWeak = diff < 0;
        results.push({ key: "wideopen", isWeak, text: `Your wide-open shooting (no defender at all tagged) is ${formatPct(cat.ownRate)} TS%, ${isWeak ? "below" : "above"} the league median of ${formatPct(cat.leagueMedian)}. ${isWeak ? "Worth attention since a scouting report can't take these shots away" : "A real strength on the shots nobody can defend"}.${cat.trend}` });
      }
    }
  }

  // Def Rating/20 and Opp FG% together, min 10 shots defended for either to count — two views of
  // the same defensive-difficulty question, shown together either way, flagged on whichever one
  // actually clears its own threshold.
  {
    const defAttempts = row.defense.timesBeaten + row.defense.stops;
    if (defAttempts >= 10) {
      const ownDefRtg = defensiveRating(row.rate, row.rateDefense);
      const ownOppFg = pct(row.defense.timesBeaten, defAttempts);
      const others = board.filter(r => r.player.id !== playerId && (r.defense.timesBeaten + r.defense.stops) >= 10);
      const medDefRtg = median(others.map(r => defensiveRating(r.rate, r.rateDefense)));
      const medOppFg = median(others.map(r => pct(r.defense.timesBeaten, r.defense.timesBeaten + r.defense.stops)));
      if (medDefRtg !== null && medOppFg !== null && ownOppFg !== null) {
        const rtgDiff = ownDefRtg - medDefRtg;
        const fgDiff = ownOppFg - medOppFg;
        if (Math.abs(fgDiff) >= 8 || Math.abs(rtgDiff) >= 1.5) {
          const isWeak = Math.abs(fgDiff) >= 8 ? fgDiff > 0 : rtgDiff < 0;
          const statFn = (g, pid) => { const def = gameDefenseStats(g, pid); return { num: def.timesBeaten, denom: def.timesBeaten + def.stops }; };
          const { seasonRate, recentRate } = seasonVsRecentRate(playerId, statFn);
          const trend = trendNote(seasonRate, recentRate, false);
          results.push({
            key: "defense", isWeak,
            text: `Your defense: Def Rating/20 of ${ownDefRtg.toFixed(1)} (league median ${medDefRtg.toFixed(1)}) and opponents shooting ${formatPct(ownOppFg)} against you (league median ${formatPct(medOppFg)}).${isWeak ? " Tighter closeouts or a different defensive matchup could close that gap." : " Real defensive strength, not a fluke at this sample size."}${trend}`
          });
        }
      }
    }
  }

  // Out-of-bounds miss rate: min 10 misses.
  {
    const oobRows = computeOutOfBoundsStats();
    const own = oobRows.find(r => r.player.id === playerId);
    if (own && own.misses >= 10) {
      const ownRate = pct(own.oob, own.misses);
      const leagueMedian = median(oobRows.filter(r => r.player.id !== playerId && r.misses >= 10).map(r => pct(r.oob, r.misses)));
      if (leagueMedian !== null && ownRate !== null) {
        const diff = ownRate - leagueMedian;
        if (Math.abs(diff) >= 8) {
          const isWeak = diff > 0;
          const statFn = (g, pid) => {
            let misses = 0, oob = 0;
            g.scoringEvents.filter(ev => ev.scorerId === pid && ev.made === false).forEach(ev => { misses++; if (ev.turnoverEventId) oob++; });
            return { num: oob, denom: misses };
          };
          const { seasonRate, recentRate } = seasonVsRecentRate(playerId, statFn);
          const trend = trendNote(seasonRate, recentRate, false);
          results.push({ key: "oob", isWeak, text: `Your missed shots go out of bounds ${formatPct(ownRate)} of the time, ${isWeak ? "above" : "below"} the league median of ${formatPct(leagueMedian)}.${isWeak ? " Worth a beat more care about where a miss ends up, not just whether it goes in." : ""}${trend}` });
        }
      }
    }
  }

  // Second-Chance Conversion rate: min 5 offensive rebounds. Only rebounds with a real video
  // timestamp on the missed shot can be checked for conversion at all (same limitation the
  // league-wide Second-Chance Conversion panel already has and explains) — an OREB without one
  // still counts toward the sample, just never toward the numerator.
  {
    const scRows = computeSecondChanceConversions();
    const own = scRows.find(r => r.player.id === playerId);
    if (own && own.oreb >= 5) {
      const ownRate = pct(own.converted, own.oreb);
      const leagueMedian = median(scRows.filter(r => r.player.id !== playerId && r.oreb >= 5).map(r => pct(r.converted, r.oreb)));
      if (leagueMedian !== null && ownRate !== null) {
        const diff = ownRate - leagueMedian;
        if (Math.abs(diff) >= 12) {
          const isWeak = diff < 0;
          results.push({ key: "secondchance", isWeak, text: `Your second-chance conversion (points off your own offensive rebounds) is ${formatPct(ownRate)}, ${isWeak ? "below" : "above"} the league median of ${formatPct(leagueMedian)}.${isWeak ? " Worth a beat more urgency going back up with it instead of resetting." : ""}` });
        }
      }
    }
  }

  return results;
}

function renderAreasToWorkOn(playerId) {
  const wrap = document.getElementById("areasToWorkOn");
  if (!wrap) return;
  const results = computeAreasToWorkOn(playerId);
  if (results === null) {
    wrap.innerHTML = `<p class="empty-state">Needs at least ${AREAS_TO_WORK_ON_MIN_GP} qualifying games before there's enough of a season to compare against the league median.</p>`;
    return;
  }
  if (results.length === 0) {
    wrap.innerHTML = `<p class="empty-state">Nothing clears its own minimum sample yet, or nothing that does is meaningfully off the league median: check back as more games get logged.</p>`;
    return;
  }
  const weaknesses = results.filter(r => r.isWeak);
  const strengths = results.filter(r => !r.isWeak);
  const section = (title, rows) => rows.length === 0 ? "" : `
    <h4 style="margin:14px 0 6px">${title}</h4>
    <ul class="player-tips-list">${rows.map(r => {
      const watchLinks = watchFilmLinksHtml(r.games);
      const clipLabel = AREA_CLIP_CATEGORY_LABELS[r.key];
      const clipBtn = clipLabel
        ? `<div class="player-tip-watch"><button type="button" class="icon-btn area-clip-export-btn" data-player-id="${playerId}" data-category-key="${r.key}" data-category-label="${escapeHtml(clipLabel)}">🎬 Watch these clips</button></div>`
        : "";
      return `<li><span class="player-tip-icon">${r.isWeak ? "❄️" : "🔥"}</span><span>${r.text}${watchLinks}${clipBtn}</span></li>`;
    }).join("")}</ul>
  `;
  wrap.innerHTML = section("Areas to work on", weaknesses) + section("Real strengths", strengths);
  wireWatchFilmButtons(wrap);
  wrap.querySelectorAll(".area-clip-export-btn").forEach(btn => {
    btn.addEventListener("click", () => startAreaClipExport(btn.dataset.playerId, btn.dataset.categoryKey, btn.dataset.categoryLabel));
  });
}

function renderFlakeStatsPanel(playerId) {
  const wrap = document.getElementById("playerFlakeStats");
  if (!wrap) return;
  const stats = computeFlakeStats(playerId);
  if (stats.pct === null) {
    wrap.innerHTML = '<p class="empty-state">No resolved RSVPs for this player yet. Flake % needs at least one RSVP\'d date with a logged game.</p>';
    return;
  }
  wrap.innerHTML = `<p class="score-display">${stats.pct}% <span class="hint" style="margin:0">(${stats.flaked} of ${stats.resolved} RSVP'd sessions missed)</span></p>`;
}

// For each teammate this player has shared a team with (in a game with real shots logged),
// split that player's own games into "with" (teammate on their side) and "without" (teammate
// on the other team, or not playing) and compare per-20 output across the split.
function computeTeammateSynergy(playerId) {
  const qualifyingGames = qualifyingGamesForPlayer(playerId);
  const teammateIds = new Set();
  qualifyingGames.forEach(g => {
    const myTeam = g.teamA.includes(playerId) ? g.teamA : g.teamB;
    myTeam.forEach(id => { if (id !== playerId) teammateIds.add(id); });
  });
  return [...teammateIds].map(teammateId => {
    const withGames = [];
    const withoutGames = [];
    qualifyingGames.forEach(g => {
      const myTeam = g.teamA.includes(playerId) ? g.teamA : g.teamB;
      (myTeam.includes(teammateId) ? withGames : withoutGames).push(g);
    });
    return {
      teammate: state.players.find(p => p.id === teammateId),
      with: computeRateSummaryForGames(playerId, withGames),
      without: computeRateSummaryForGames(playerId, withoutGames)
    };
  }).filter(r => r.teammate).sort((a, b) => b.with.gp - a.with.gp);
}

const TEAMMATE_SYNERGY_COLUMNS = [
  { key: "teammate", label: "Teammate", accessor: r => r.teammate.name },
  { key: "gpWith", label: "GP With", accessor: r => r.with.gp },
  { key: "gpWithout", label: "GP W/o", accessor: r => r.without.gp },
  { key: "offRtgWith", label: "Off Rating/20 With", accessor: r => r.with.gp > 0 ? r.with.offRatingPer20 : null },
  { key: "offRtgWithout", label: "Off Rating/20 W/o", accessor: r => r.without.gp > 0 ? r.without.offRatingPer20 : null },
  { key: "twoWayWith", label: "Two-Way/20 With", accessor: r => r.with.gp > 0 ? r.with.twoWayPer20 : null },
  { key: "twoWayWithout", label: "Two-Way/20 W/o", accessor: r => r.without.gp > 0 ? r.without.twoWayPer20 : null }
];
let teammateSynergySort = { key: "gpWith", dir: "desc" };

function renderTeammateSynergy(playerId) {
  const headerRow = document.getElementById("teammateSynergyHeaderRow");
  const body = document.getElementById("teammateSynergyBody");
  renderSortableHeader(headerRow, TEAMMATE_SYNERGY_COLUMNS, teammateSynergySort, () => renderTeammateSynergy(playerId));
  const rows = computeTeammateSynergy(playerId);
  const sortCol = TEAMMATE_SYNERGY_COLUMNS.find(c => c.key === teammateSynergySort.key);
  rows.sort((a, b) => compareForSort(sortCol.accessor(a), sortCol.accessor(b), teammateSynergySort.dir));
  const fmt = (v, gp) => gp > 0 ? v.toFixed(1) : "—";
  body.innerHTML = rows.length === 0
    ? '<tr><td colspan="7" class="empty-state">No games with teammates and real shots logged yet.</td></tr>'
    : rows.map(r => `<tr><td>${playerLink(r.teammate.id, r.teammate.name)}</td><td>${r.with.gp}</td><td>${r.without.gp}</td><td>${fmt(r.with.offRatingPer20, r.with.gp)}</td><td>${fmt(r.without.offRatingPer20, r.without.gp)}</td><td>${fmt(r.with.twoWayPer20, r.with.gp)}</td><td>${fmt(r.without.twoWayPer20, r.without.gp)}</td></tr>`).join("");
}

// Per-game Two-Way/20 over the season for one player — the line-graph version of the "Last 5: X
// vs. season Y" text the Leaderboard's Last 5 column already shows (and what the Most Improved
// comparison in Awards vs. Stats is built on), since a real trend line makes "up or down lately,
// and by how much" legible at a glance instead of two numbers to compare by hand. Each point is
// computeRateSummaryForGames() run on a single game, so it's the same per-20 math as everywhere
// else, just normalized against that one game's own combined score instead of the season's.
function computeTwoWayTrend(playerId) {
  const qualifyingGames = qualifyingGamesForPlayer(playerId);
  const sorted = [...qualifyingGames].sort((a, b) => (a.date || "").localeCompare(b.date || ""));
  const points = sorted.map(g => ({ date: g.date, value: computeRateSummaryForGames(playerId, [g]).twoWayPer20 }));
  const seasonAvg = computeRateSummaryForGames(playerId, qualifyingGames).twoWayPer20;
  return { points, seasonAvg };
}

function renderTwoWayTrendChart(playerId) {
  const { points, seasonAvg } = computeTwoWayTrend(playerId);
  const leagueAvg = leagueAvgOfPlayerTrend(computeTwoWayTrend);
  renderTrendLineChart("playerTwoWayTrend", points, seasonAvg, "Two-Way/20", leagueAvg);
}

// ---------- Single-Stat Trend (Player Detail) ----------
// The same per-game line chart as Two-Way Trend, for any one stat. Every stat is a function of a
// set of games, so a game's point is that stat over just that one game and the season line is the
// same stat over all of them (pooled, not a mean of per-game means). A game only becomes a point
// when the player had at least `minN` attempts of the relevant kind in it, since a percentage off
// one or two shots isn't a real reading. With fewer than TREND_MIN_POINTS points the line is faded.
const TREND_MIN_POINTS = 5;
const pctOrNull = (num, den) => den > 0 ? (num / den) * 100 : null;
const shotPoints = sh => 2 * sh.fgm + sh.tpm + sh.ftm;

const PLAYER_TREND_STATS = [
  { key: "tovPct", label: "TOV%", unit: "%", decimals: 0, minN: 4, lowerIsBetter: true,
    about: "How often this player turns the ball over relative to their shot attempts: TOV ÷ (FGA + 0.44×FTA + TOV). Lower is better.",
    compute: (pid, games) => {
      let tov = 0, fga = 0, fta = 0;
      games.forEach(g => {
        const s = g.stats.find(st => st.playerId === pid); if (s) tov += s.tov;
        const sh = shootingStats(g, pid); fga += sh.fga; fta += sh.fta;
      });
      const den = fga + 0.44 * fta + tov;
      return { value: pctOrNull(tov, den), n: den };
    } },
  { key: "wideOpen", label: "Wide-Open Shooting TS%", unit: "%", decimals: 0, minN: 2,
    about: "True Shooting % on shots with no defender tagged. Needs at least 2 wide-open shots in a game to count that game.",
    compute: (pid, games) => {
      let pts = 0, fga = 0;
      games.forEach(g => g.scoringEvents.forEach(ev => {
        if (ev.scorerId !== pid || (ev.points !== 2 && ev.points !== 3)) return;
        if (ev.defenderIds && ev.defenderIds.length > 0) return;
        fga++; if (ev.made !== false) pts += ev.points;
      }));
      return { value: fga > 0 ? (pts / (2 * fga)) * 100 : null, n: fga };
    } },
  { key: "expAgainst", label: "Points Saved vs. Expected (per shot defended)", unit: "pts/shot", decimals: 2, minN: 3,
    about: "How many fewer points than expected this player allowed per shot they defended, given how hard those shots were. Higher is better. Needs at least 3 defended shots in a game.",
    compute: (pid, games, ctx) => {
      let actual = 0, expected = 0, fga = 0;
      games.forEach(g => g.scoringEvents.forEach(ev => {
        if ((ev.points !== 2 && ev.points !== 3) || !(ev.defenderIds || []).includes(pid)) return;
        fga++;
        actual += ev.made !== false ? ev.points : 0;
        const zone = ev.shotLocation ? ctx.zonePpa.byZone[shotBand(ev.shotLocation, ev.points)] : null;
        const x = zone !== null && zone !== undefined ? zone : ctx.zonePpa.overall;
        if (x !== null && x !== undefined) expected += x;
      }));
      return { value: fga > 0 ? (expected - actual) / fga : null, n: fga };
    } },
  { key: "oppFg", label: "Opp FG% (shots defended)", unit: "%", decimals: 0, minN: 3, lowerIsBetter: true,
    about: "How often shots this player was tagged defending went in. Lower is better. Needs at least 3 defended shots in a game.",
    compute: (pid, games) => {
      let beaten = 0, stops = 0;
      games.forEach(g => { const d = gameDefenseStats(g, pid); beaten += d.timesBeaten; stops += d.stops; });
      return { value: pctOrNull(beaten, beaten + stops), n: beaten + stops };
    } },
  { key: "reboundWin", label: "Rebound Battle Win%", unit: "%", decimals: 0, minN: 2,
    about: "Share of contested rebounds this player came away with. Needs at least 2 contested rebounds in a game.",
    compute: (pid, games) => {
      let wins = 0, losses = 0;
      games.forEach(g => g.scoringEvents.forEach(ev => {
        if (ev.made !== false || !ev.rebounderId || ev.turnoverEventId) return;
        const contesters = ev.reboundContesterIds || [];
        if (contesters.length === 0) return;
        if (ev.rebounderId === pid) wins++;
        if (contesters.includes(pid)) losses++;
      }));
      return { value: pctOrNull(wins, wins + losses), n: wins + losses };
    } },
  { key: "fgPct", label: "FG%", unit: "%", decimals: 0, minN: 4,
    about: "Field goal percentage. Needs at least 4 attempts in a game.",
    compute: (pid, games) => {
      let m = 0, a = 0;
      games.forEach(g => { const sh = shootingStats(g, pid); m += sh.fgm; a += sh.fga; });
      return { value: pctOrNull(m, a), n: a };
    } },
  { key: "threePct", label: "3PT%", unit: "%", decimals: 0, minN: 3,
    about: "Three-point percentage. Needs at least 3 attempts in a game.",
    compute: (pid, games) => {
      let m = 0, a = 0;
      games.forEach(g => { const sh = shootingStats(g, pid); m += sh.tpm; a += sh.tpa; });
      return { value: pctOrNull(m, a), n: a };
    } },
  { key: "tsPct", label: "TS%", unit: "%", decimals: 0, minN: 4,
    about: "True Shooting %: points per shot attempt, counting threes and free throws properly. Needs at least 4 attempts in a game.",
    compute: (pid, games) => {
      let pts = 0, fga = 0, fta = 0;
      games.forEach(g => { const sh = shootingStats(g, pid); pts += shotPoints(sh); fga += sh.fga; fta += sh.fta; });
      const den = 2 * (fga + 0.44 * fta);
      return { value: den > 0 ? (pts / den) * 100 : null, n: fga };
    } },
  { key: "twoWay", label: "Two-Way/20", unit: "/20", decimals: 1, minN: 0,
    about: "Offense plus defense rating per 20 combined points, the same number as the Two-Way Trend above.",
    compute: (pid, games) => ({ value: games.length ? computeRateSummaryForGames(pid, games).twoWayPer20 : null, n: games.length }) },
  { key: "offRating", label: "Off Rating/20", unit: "/20", decimals: 1, minN: 0,
    about: "Offense-only rating per 20 combined points.",
    compute: (pid, games) => ({ value: games.length ? computeRateSummaryForGames(pid, games).offRatingPer20 : null, n: games.length }) },
  { key: "defRating", label: "Def Rating/20", unit: "/20", decimals: 1, minN: 0,
    about: "Defense-only rating per 20 combined points.",
    compute: (pid, games) => {
      if (!games.length) return { value: null, n: 0 };
      const r = computeRateSummaryForGames(pid, games);
      return { value: r.twoWayPer20 - r.offRatingPer20, n: games.length };
    } }
];
let playerStatTrendKey = "tovPct";

function computePlayerStatTrend(playerId, stat, ctx) {
  const games = [...qualifyingGamesForPlayer(playerId)].sort((a, b) => (a.date || "").localeCompare(b.date || ""));
  const points = [];
  let excluded = 0;
  games.forEach(g => {
    const r = stat.compute(playerId, [g], ctx);
    if (r.value === null || r.value === undefined || (stat.minN && r.n < stat.minN)) { excluded++; return; }
    points.push({ date: g.date, value: r.value, n: r.n });
  });
  const season = stat.compute(playerId, games, ctx);
  return { points, seasonAvg: season.value === undefined ? null : season.value, excluded };
}

function renderPlayerStatTrend(playerId) {
  const select = document.getElementById("playerStatTrendSelect");
  const chart = document.getElementById("playerStatTrend");
  const note = document.getElementById("playerStatTrendNote");
  if (!select || !chart) return;
  if (select.options.length === 0) {
    PLAYER_TREND_STATS.forEach(s => {
      const opt = document.createElement("option");
      opt.value = s.key;
      opt.textContent = s.label;
      select.appendChild(opt);
    });
    select.addEventListener("change", () => {
      playerStatTrendKey = select.value;
      if (currentPlayerId) renderPlayerStatTrend(currentPlayerId);
    });
  }
  select.value = playerStatTrendKey;
  const stat = PLAYER_TREND_STATS.find(s => s.key === playerStatTrendKey) || PLAYER_TREND_STATS[0];
  const ctx = { zonePpa: computeLeagueZonePointsPerAttempt() };
  const { points, seasonAvg, excluded } = computePlayerStatTrend(playerId, stat, ctx);
  const leagueAvg = leagueAvgOfPlayerTrend(pid => ({ seasonAvg: computePlayerStatTrend(pid, stat, ctx).seasonAvg }));
  const faded = points.length < TREND_MIN_POINTS;
  renderTrendLineChart("playerStatTrend", points, seasonAvg, stat.unit, leagueAvg, { decimals: stat.decimals, faded });
  const parts = [stat.about];
  if (faded && points.length > 0) parts.push(`Only ${points.length} game${points.length === 1 ? "" : "s"} so far, too few to call a trend (the line is faded until there are ${TREND_MIN_POINTS}).`);
  if (excluded > 0) parts.push(`${excluded} game${excluded === 1 ? " was" : "s were"} left out for too few attempts.`);
  note.textContent = parts.join(" ");
}

// Generic SVG line-chart renderer — per-game points plus a dashed season-average reference
// line, parameterized over a {date, value} point list and a unit label rather than hardwired to
// one stat. renderTwoWayTrendChart() (above) is now just a thin wrapper over this; Teammate
// Quality and both Matchup Difficulty charts below use it directly.
// `leagueAvg` (optional) draws a second reference line: the same stat's average across every
// other qualifying player, so a number like "1.1" reads against a real baseline ("is that good?")
// instead of just this one player's own history. Omitted entirely when there isn't a meaningful
// league-wide number to compare against (a caller passing undefined/null just gets the original
// single-reference-line chart, unchanged).
function renderTrendLineChart(containerId, points, seasonAvg, unitLabel, leagueAvg, opts) {
  const dec = opts && opts.decimals !== undefined ? opts.decimals : 1;
  const faded = !!(opts && opts.faded);
  const wrap = document.getElementById(containerId);
  if (!wrap) return;
  if (points.length === 0 || seasonAvg === null) {
    wrap.innerHTML = '<p class="empty-state">Not enough data yet.</p>';
    return;
  }
  const hasLeagueAvg = leagueAvg !== undefined && leagueAvg !== null;
  const W = 560, H = 220, PAD_L = 40, PAD_R = 16, PAD_T = 16, PAD_B = 34;
  const plotW = W - PAD_L - PAD_R, plotH = H - PAD_T - PAD_B;
  const values = [...points.map(p => p.value), seasonAvg];
  if (hasLeagueAvg) values.push(leagueAvg);
  const rawMin = Math.min(...values), rawMax = Math.max(...values);
  const span = Math.max(1, rawMax - rawMin);
  const yMin = rawMin - span * 0.15;
  const yMax = rawMax + span * 0.15;
  const xScale = i => points.length === 1 ? PAD_L + plotW / 2 : PAD_L + (i / (points.length - 1)) * plotW;
  const yScale = v => PAD_T + plotH - ((v - yMin) / (yMax - yMin || 1)) * plotH;

  const pathD = points.map((p, i) => `${i === 0 ? "M" : "L"}${xScale(i)},${yScale(p.value)}`).join(" ");
  const dotsSvg = points.map((p, i) => `
    <circle cx="${xScale(i)}" cy="${yScale(p.value)}" r="3.5" class="ts-line-dot">
      <title>${escapeHtml(formatDateDisplay(p.date))}: ${p.value.toFixed(dec)} ${escapeHtml(unitLabel)}</title>
    </circle>
  `).join("");
  const labelEvery = Math.max(1, Math.ceil(points.length / 6));
  const xLabelsSvg = points.map((p, i) => (i % labelEvery !== 0 && i !== points.length - 1) ? "" : `
    <text x="${xScale(i)}" y="${H - PAD_B + 16}" text-anchor="middle" class="ts-line-axis-label">${escapeHtml(formatDateDisplay(p.date))}</text>
  `).join("");
  const seasonY = yScale(seasonAvg);
  const leagueY = hasLeagueAvg ? yScale(leagueAvg) : null;
  // Labels default to opposite corners so the two reference lines' text doesn't collide when
  // they land close together; if they're far enough apart vertically that collision was never a
  // real risk, both being anchored to the same end still reads fine.
  const leagueRefSvg = hasLeagueAvg ? `
      <line x1="${PAD_L}" y1="${leagueY}" x2="${W - PAD_R}" y2="${leagueY}" class="ts-line-ref ts-line-ref-league">
        <title>League average: ${leagueAvg.toFixed(dec)} ${escapeHtml(unitLabel)}</title>
      </line>
      <text x="${PAD_L}" y="${leagueY - 4}" text-anchor="start" class="ts-line-axis-label ts-line-league-label">league avg ${leagueAvg.toFixed(dec)}</text>
  ` : "";

  wrap.innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" class="ts-line-svg${faded ? " ts-line-faded" : ""}">
      <line x1="${PAD_L}" y1="${PAD_T}" x2="${PAD_L}" y2="${H - PAD_B}" class="ts-line-axis" />
      <line x1="${PAD_L}" y1="${H - PAD_B}" x2="${W - PAD_R}" y2="${H - PAD_B}" class="ts-line-axis" />
      <line x1="${PAD_L}" y1="${seasonY}" x2="${W - PAD_R}" y2="${seasonY}" class="ts-line-ref">
        <title>Season average: ${seasonAvg.toFixed(dec)} ${escapeHtml(unitLabel)}</title>
      </line>
      <text x="${W - PAD_R}" y="${seasonY - 4}" text-anchor="end" class="ts-line-axis-label">season avg ${seasonAvg.toFixed(dec)}</text>
      ${leagueRefSvg}
      <path d="${pathD}" class="ts-line-path" />
      ${dotsSvg}
      ${xLabelsSvg}
    </svg>
  `;
}

// Averages a per-player trend function's own seasonAvg across every player who has one — the
// league-wide baseline these charts plot as a second reference line (see renderTrendLineChart's
// own `leagueAvg` param), computed generically over whichever trend function is passed in so
// Teammate Quality/Offensive/Defensive Matchup Difficulty can each reuse this instead of three
// near-identical baseline computations.
function leagueAvgOfPlayerTrend(trendFn) {
  const vals = state.players.map(p => trendFn(p.id).seasonAvg).filter(v => v !== null && v !== undefined);
  return vals.length > 0 ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
}

// "Teammate Quality" — how strong (season Off Rating/20) this player's own teammates have been,
// game by game and on average. Built to test a specific hypothesis: a player whose own numbers
// lean on playing next to good scorers/passers (drawing mismatches, getting fed easy looks)
// should show a high teammate-quality average, distinct from their own Off Rating/20. Off
// Rating/20 specifically, not Two-Way/20 — the mechanism this measures (drawing defensive
// attention, creating mismatches, generating easy shots) is a teammate's offensive gravity, not
// their defense. The season average is pooled across every (game, teammate) appearance rather
// than a mean of per-game means, same "sum totals, divide once" preference every per-20 rate on
// this tool already uses. Doesn't correct for this player also counting toward each teammate's
// own Off Rating/20 (no leave-one-out adjustment) — a known simplification.
function computeTeammateQualityTrend(playerId) {
  const board = computeLeaderboard();
  const offRtgById = {};
  board.forEach(r => { offRtgById[r.player.id] = r.gp > 0 ? r.offRatingPer20 : null; });
  const qualifyingGames = qualifyingGamesForPlayer(playerId);
  const sorted = [...qualifyingGames].sort((a, b) => (a.date || "").localeCompare(b.date || ""));
  const points = [];
  let sumQuality = 0, countAppearances = 0;
  sorted.forEach(g => {
    const myTeam = g.teamA.includes(playerId) ? g.teamA : g.teamB;
    const qualities = myTeam.filter(id => id !== playerId).map(id => offRtgById[id]).filter(v => v !== null && v !== undefined);
    if (qualities.length === 0) return;
    points.push({ date: g.date, value: qualities.reduce((a, b) => a + b, 0) / qualities.length });
    sumQuality += qualities.reduce((a, b) => a + b, 0);
    countAppearances += qualities.length;
  });
  return { points, seasonAvg: countAppearances > 0 ? sumQuality / countAppearances : null };
}

function renderTeammateQualityChart(playerId) {
  const { points, seasonAvg } = computeTeammateQualityTrend(playerId);
  const leagueAvg = leagueAvgOfPlayerTrend(computeTeammateQualityTrend);
  renderTrendLineChart("playerTeammateQuality", points, seasonAvg, "Off Rating/20", leagueAvg);
}

// "Defensive Matchup Difficulty" — the defensive-side counterpart to Teammate Quality above: how
// strong (season Off Rating/20) the players this player was tagged defending have been, game by
// game and on average, straight from the same defenderIds tags Def Rating already reads. A low
// number doesn't guarantee an easy defensive night, but it does mean this player wasn't drawing
// the toughest offensive assignments. Weighted per shot, not deduplicated per opponent — the
// same shot-by-shot weighting Stops/Beaten/Pts Allowed already use.
function computeDefensiveMatchupDifficultyTrend(playerId) {
  const board = computeLeaderboard();
  const offRtgById = {};
  board.forEach(r => { offRtgById[r.player.id] = r.gp > 0 ? r.offRatingPer20 : null; });
  const qualifyingGames = qualifyingGamesForPlayer(playerId);
  const sorted = [...qualifyingGames].sort((a, b) => (a.date || "").localeCompare(b.date || ""));
  const points = [];
  let sumQuality = 0, countShots = 0;
  sorted.forEach(g => {
    const qualities = g.scoringEvents
      .filter(ev => (ev.defenderIds || []).includes(playerId))
      .map(ev => offRtgById[ev.scorerId])
      .filter(v => v !== null && v !== undefined);
    if (qualities.length === 0) return;
    points.push({ date: g.date, value: qualities.reduce((a, b) => a + b, 0) / qualities.length });
    sumQuality += qualities.reduce((a, b) => a + b, 0);
    countShots += qualities.length;
  });
  return { points, seasonAvg: countShots > 0 ? sumQuality / countShots : null };
}

function renderDefensiveMatchupDifficultyChart(playerId) {
  const { points, seasonAvg } = computeDefensiveMatchupDifficultyTrend(playerId);
  const leagueAvg = leagueAvgOfPlayerTrend(computeDefensiveMatchupDifficultyTrend);
  renderTrendLineChart("playerDefensiveMatchupDifficulty", points, seasonAvg, "Opp Off Rating/20", leagueAvg);
}

// See poolean-defensive-load-spec.md and computeDefensiveLoad()/describeDefensiveLoad() above --
// always shown paired with this same player's own Opp FG% (leading) and Def Rating/20 (secondary
// context), never the ratio alone, since a low Defensive Load is genuinely ambiguous on its own.
function renderPlayerDefensiveLoadPanel(playerId) {
  const wrap = document.getElementById("defensiveLoad");
  if (!wrap) return;
  const board = computeLeaderboard();
  const row = board.find(r => r.player.id === playerId);
  const load = row ? row.defensiveLoad : null;
  if (!row || load === null) {
    wrap.innerHTML = `<p class="empty-state">Not enough tagged defensive volume yet across enough games to show this (needs ${DEFENSIVE_LOAD_MIN_SHARE}+ expected tagged possessions season-to-date).</p>`;
    return;
  }
  const oppFgPct = pct(row.defense.timesBeaten, row.defense.timesBeaten + row.defense.stops);
  const defRtg = defensiveRating(row.rate, row.rateDefense);
  const leagueAvgOppFg = computeLeagueAvgOppFg(board);
  const xpa = row.expectedPointsAgainst;
  const xpaText = xpa
    ? `, Pts Allowed Under Exp: ${xpa.pointsAllowedUnderExpected >= 0 ? "+" : ""}${xpa.pointsAllowedUnderExpected.toFixed(1)}`
    : "";
  wrap.innerHTML = `
    <p class="score-display">${load.toFixed(2)}x <span class="hint" style="margin:0">(Opp FG%: ${formatPct(oppFgPct)}, Def Rating/20: ${defRtg.toFixed(1)}${xpaText})</span></p>
    <p class="hint" style="margin:8px 0 0">${escapeHtml(describeDefensiveLoad(load, oppFgPct, leagueAvgOppFg))}</p>
  `;
}

// "Offensive Matchup Difficulty" — the mirror of Defensive Matchup Difficulty from the scorer's
// side: average season Def Rating/20 of whoever was tagged defending THIS player's own shot
// attempts, game by game and on average. Def Rating/20 specifically (not Off Rating/20) — the
// question here is how good the defenders this player has had to shoot over have been
// defensively, not offensively. A double-teamed shot counts toward every tagged defender, not
// split, same rule Stops/Beaten/Pts Allowed already use. An untagged ("wide open") shot
// contributes nothing — there's no defender to rate, same exclusion Wide-Open Shooting already
// makes. Field goals only (points === 2 or 3); free throws are uncontested by rule and never
// carry a defender tag anyway.
function computeOffensiveMatchupDifficultyTrend(playerId) {
  const board = computeLeaderboard();
  const defRtgById = {};
  board.forEach(r => { defRtgById[r.player.id] = r.gp > 0 ? defensiveRating(r.rate, r.rateDefense) : null; });
  const qualifyingGames = qualifyingGamesForPlayer(playerId);
  const sorted = [...qualifyingGames].sort((a, b) => (a.date || "").localeCompare(b.date || ""));
  const points = [];
  let sumQuality = 0, countTags = 0;
  sorted.forEach(g => {
    const qualities = [];
    g.scoringEvents
      .filter(ev => ev.scorerId === playerId && (ev.points === 2 || ev.points === 3))
      .forEach(ev => {
        (ev.defenderIds || []).forEach(id => {
          const q = defRtgById[id];
          if (q !== null && q !== undefined) qualities.push(q);
        });
      });
    if (qualities.length === 0) return;
    points.push({ date: g.date, value: qualities.reduce((a, b) => a + b, 0) / qualities.length });
    sumQuality += qualities.reduce((a, b) => a + b, 0);
    countTags += qualities.length;
  });
  return { points, seasonAvg: countTags > 0 ? sumQuality / countTags : null };
}

function renderOffensiveMatchupDifficultyChart(playerId) {
  const { points, seasonAvg } = computeOffensiveMatchupDifficultyTrend(playerId);
  const leagueAvg = leagueAvgOfPlayerTrend(computeOffensiveMatchupDifficultyTrend);
  renderTrendLineChart("playerOffensiveMatchupDifficulty", points, seasonAvg, "Opp Def Rating/20", leagueAvg);
}

// "Assisted By" — what share of this player's own makes were set up by someone else, and how
// good (season Off Rating/20) those passers have been. Field goals only (points === 2 or 3) —
// free throws don't carry an assist by rule, matching how shootingStats()/Shot% already treat
// FTs as their own category everywhere else in this tool.
function computeAssistedByBreakdown(playerId) {
  const board = computeLeaderboard();
  const offRtgById = {};
  board.forEach(r => { offRtgById[r.player.id] = r.gp > 0 ? r.offRatingPer20 : null; });
  let fgm = 0, assistedFgm = 0;
  const byAssister = {};
  state.games.filter(isQualifyingGame).forEach(g => {
    g.scoringEvents.forEach(ev => {
      if (ev.scorerId !== playerId || ev.made === false) return;
      if (ev.points !== 2 && ev.points !== 3) return;
      fgm++;
      if (ev.assistId) {
        assistedFgm++;
        byAssister[ev.assistId] = (byAssister[ev.assistId] || 0) + 1;
      }
    });
  });
  const assisters = Object.entries(byAssister).map(([id, assists]) => {
    const player = state.players.find(p => p.id === id);
    return { player, assists, offRatingPer20: offRtgById[id] ?? null };
  }).filter(a => a.player).sort((a, b) => b.assists - a.assists);
  const weightedSum = assisters.reduce((sum, a) => sum + (a.offRatingPer20 !== null ? a.offRatingPer20 * a.assists : 0), 0);
  const weightedCount = assisters.reduce((sum, a) => sum + (a.offRatingPer20 !== null ? a.assists : 0), 0);
  return {
    fgm, assistedFgm, assistedPct: pct(assistedFgm, fgm), assisters,
    avgAssisterQuality: weightedCount > 0 ? weightedSum / weightedCount : null
  };
}

function renderAssistedByPanel(playerId) {
  const wrap = document.getElementById("playerAssistedBy");
  if (!wrap) return;
  const { fgm, assistedFgm, assistedPct, assisters, avgAssisterQuality } = computeAssistedByBreakdown(playerId);
  if (fgm === 0) {
    wrap.innerHTML = '<p class="empty-state">No field goals logged yet.</p>';
    return;
  }
  // League baselines for both headline numbers, same "is this actually high or low" context the
  // trend charts' own league-average reference line gives — computed from every other player's
  // own breakdown rather than a single leaguewide pool, so a player who barely shoots doesn't
  // quietly dominate the average the way pooling every make league-wide would let them.
  const otherBreakdowns = state.players.filter(p => p.id !== playerId).map(p => computeAssistedByBreakdown(p.id)).filter(b => b.fgm > 0);
  const leagueAvgAssistedPct = otherBreakdowns.length > 0
    ? otherBreakdowns.reduce((sum, b) => sum + b.assistedPct, 0) / otherBreakdowns.length
    : null;
  const leagueAvgAssisterQuality = (() => {
    const vals = otherBreakdowns.map(b => b.avgAssisterQuality).filter(v => v !== null);
    return vals.length > 0 ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
  })();
  const assistedPctNote = leagueAvgAssistedPct !== null ? ` (league average: ${formatPct(leagueAvgAssistedPct)})` : "";
  const qualityNote = avgAssisterQuality !== null
    ? `, average assister quality: ${avgAssisterQuality.toFixed(1)} Off Rating/20${leagueAvgAssisterQuality !== null ? ` (league average: ${leagueAvgAssisterQuality.toFixed(1)})` : ""}`
    : "";
  const rows = assisters.length === 0
    ? '<tr><td colspan="3" class="empty-state">No assisted makes yet.</td></tr>'
    : assisters.map(a => `<tr><td>${playerLink(a.player.id, a.player.name)}</td><td>${a.assists}</td><td>${a.offRatingPer20 !== null ? a.offRatingPer20.toFixed(1) : "—"}</td></tr>`).join("");
  wrap.innerHTML = `
    <p class="hint" style="margin:0 0 10px">${assistedFgm} of ${fgm} makes were assisted (${formatPct(assistedPct)}${assistedPctNote})${qualityNote}.</p>
    <div class="table-scroll">
      <table class="matchup-table">
        <thead><tr><th>Teammate</th><th>Assists</th><th>Their Off Rating/20</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  `;
}

// Single source of truth for the Leaderboard's columns: label, how to sort it (accessor
// returning a number/string/null), and how to display it (defaults to the accessor's value).
// Keeping header + row generation driven by one list avoids them drifting out of sync.
const LEADERBOARD_COLUMNS = [
  { key: "player", label: "Player", accessor: r => r.player.name, tooltip: "Click a name to open that player's detail page." },
  { key: "gp", label: "GP", accessor: r => r.gp, tooltip: "Games with real shots logged. A game that's just been rostered but not reviewed yet doesn't count." },
  { key: "w", label: "W", accessor: r => r.wins, tooltip: "Wins, counted only for games with real shots logged." },
  { key: "l", label: "L", accessor: r => r.losses, tooltip: "Losses, counted only for games with real shots logged." },
  { key: "pct", label: "PCT", accessor: r => r.winPct, display: r => formatPct(r.winPct), tooltip: "Win percentage: wins / (wins + losses)." },
  { key: "pts", label: "PTS/20", accessor: r => r.rate.pts, display: r => r.rate.pts.toFixed(1), tooltip: "Points, per 20 combined points scored in the game (not per game; see the note above the table)." },
  { key: "shotpct", label: "Shot%", advanced: true, accessor: r => r.shotPct, display: r => formatPct(r.shotPct), tooltip: "Share of their own team's field goal attempts that were theirs, across games they played: not the league's shots, their team's. A season-long share (their FGA / their team's FGA in those same games), not a per-20 rate." },
  { key: "astpct", label: "AST%", advanced: true, accessor: r => r.astPct, display: r => formatPct(r.astPct), tooltip: "Share of their own team's assists that were theirs, across games they played: not the league's assists, their team's. A season-long share (their AST / their team's AST in those same games), not a per-20 rate." },
  { key: "orebpct", label: "OREB%", advanced: true, accessor: r => r.orebPct, display: r => formatPct(r.orebPct), tooltip: "Real Total Rebound %-style share: this player's OREB divided by every offensive rebound available on their team's misses that game (their team's OREB plus the opponent's DREB on those same misses), not just their own team's OREB total like Shot%/AST% above, since a rebound is contested between both teams. Poolean has no substitutions, so a rostered player is on the floor for the whole game; the minutes-played term real rebound rate stats normally need just doesn't apply here. A season-long share, not a per-20 rate." },
  { key: "drebpct", label: "DREB%", advanced: true, accessor: r => r.drebPct, display: r => formatPct(r.drebPct), tooltip: "Same idea as OREB% for the other side of the ball: this player's DREB divided by every defensive rebound available on the opponent's misses that game (their team's DREB plus the opponent's OREB on those same misses). A season-long share, not a per-20 rate." },
  { key: "trebpct", label: "TRB%", advanced: true, accessor: r => r.trebPct, display: r => formatPct(r.trebPct), tooltip: "OREB and DREB combined: this player's total rebounds divided by every rebound actually available across the games they played (OREB% and DREB%'s two pools added together). Same no-substitutions reasoning as OREB%/DREB% above; a season-long share, not a per-20 rate." },
  { key: "tovpct", label: "TOV%", advanced: true, accessor: r => r.tovPct, display: r => formatPct(r.tovPct), tooltip: "How often this player turned it over relative to their own scoring opportunities: TOV ÷ (FGA + 0.44×FTA + TOV), the same FTA-equivalent scaling True Shooting % uses. Not a share of the team's turnovers like Shot%/AST% above; a turnover isn't a shared resource the way a shot or an assist is, so this measures usage instead: of the times this player had the ball in a position to score or give it away, how often it was the latter." },
  { key: "fg", label: "FG", accessor: r => pct(r.shooting.fgm, r.shooting.fga), display: r => formatShootingSplit(r.rateShooting.fgm, r.rateShooting.fga, true), tooltip: "Field goals made/attempted (2s and 3s combined), per 20 combined points, with FG%." },
  { key: "tpt", label: "3PT", accessor: r => pct(r.shooting.tpm, r.shooting.tpa), display: r => formatShootingSplit(r.rateShooting.tpm, r.rateShooting.tpa, true), tooltip: "3-pointers made/attempted, per 20 combined points, with 3PT%. See the 3PT Shot Distance panel below for the Arc/Deep breakdown." },
  { key: "ft", label: "FT", accessor: r => pct(r.shooting.ftm, r.shooting.fta), display: r => formatShootingSplit(r.rateShooting.ftm, r.rateShooting.fta, true), tooltip: "Free throws made/attempted, per 20 combined points, with FT%." },
  { key: "efg", label: "eFG%", accessor: r => effectiveFgPct(r.shooting.fgm, r.shooting.tpm, r.shooting.fga), display: r => formatPct(effectiveFgPct(r.shooting.fgm, r.shooting.tpm, r.shooting.fga)), tooltip: "Effective FG%: field goal percentage weighted so a made 3 counts as 1.5 made 2s." },
  { key: "ts", label: "TS%", accessor: r => trueShootingPct(r.totals.pts, r.shooting.fga, r.shooting.fta), display: r => formatPct(trueShootingPct(r.totals.pts, r.shooting.fga, r.shooting.fta)), tooltip: "True Shooting %: overall scoring efficiency across field goals and free throws combined." },
  { key: "ptsoverxp", label: "Pts +/- Exp", advanced: true,
    accessor: r => r.expectedPoints ? r.expectedPoints.pointsOverExpected : null,
    display: r => {
      if (!r.expectedPoints) return "—";
      const v = r.expectedPoints.pointsOverExpected;
      return `${v >= 0 ? "+" : ""}${v.toFixed(1)}`;
    },
    tooltip: "Points Over Expected: every field goal attempt gets an expected value from its own zone's real, empirical league-average points-per-attempt (this season's own League TS% by Shot Distance, expressed as points instead of a percentage) -- an unmarked shot location falls back to the league's overall average rather than being dropped. This player's actual points scored on those same attempts, minus that sum, across the whole season (a total, not a per-20 rate). Positive means outscoring what an average shooter would on the exact same shot selection: real shooting skill on those specific shots, not just an easier shot diet. Free throws excluded entirely (no shot location, no zone, uncontested by rule)." },
  { key: "shotdiff", label: "Shot Diff/G", advanced: true,
    accessor: r => r.shotAttemptDiff ? r.shotAttemptDiff.diffPerGame : null,
    display: r => {
      if (!r.shotAttemptDiff) return "—";
      const v = r.shotAttemptDiff.diffPerGame;
      return `${v >= 0 ? "+" : ""}${v.toFixed(1)}`;
    },
    tooltip: "Shot Attempt Differential, per game: this player's own team's total field goal attempts (made or missed, regardless of outcome) minus the opponent's, averaged across the games they played. A real, separate signal from shooting efficiency (TS%/eFG% already cover that) -- closer to shot creation and tempo control, whether this player's side tends to generate (or allow) more total looks. Deliberately a plain per-game differential, not a normalized /20 rate, matching the real stat's own simplicity: count every attempt equally, don't weight by quality. Excludes any game flagged Stopped Early (Export, Review Stopped-Early Games): a partial game's shot count isn't comparable to a complete one." },
  { key: "rebdiff", label: "Reb Diff/G", advanced: true,
    accessor: r => r.reboundDiff ? r.reboundDiff.diffPerGame : null,
    display: r => {
      if (!r.reboundDiff) return "—";
      const v = r.reboundDiff.diffPerGame;
      return `${v >= 0 ? "+" : ""}${v.toFixed(1)}`;
    },
    tooltip: "Rebound Differential, per game: this player's own team's total rebounds (OREB+DREB combined) minus the opponent's, averaged across the games they played. Team-level, not individual rebound-battle attribution -- a missed shot only ever tracks one rebounderId, with no data on who else contested it, so 'who wins a specific ball' isn't something this tool can answer without new tracking. This is the real signal available now: does this player's side tend to control the boards overall. Same Stopped Early exclusion as Shot Diff/G." },
  { key: "pace", label: "Pace", advanced: true,
    accessor: r => r.paceAndPpp ? r.paceAndPpp.pace : null,
    display: r => r.paceAndPpp ? r.paceAndPpp.pace.toFixed(1) : "—",
    tooltip: "Total logged plays per game (every scoring attempt, turnover, and steal combined, across their own team, in games they played): a real count of how much game actually happened, closer to a true possession count than the combined-points normalization every other rate stat here uses. Excludes any game flagged Stopped Early (Export, Review Stopped-Early Games): a partial game's play count isn't comparable to a complete one." },
  { key: "ppp", label: "PPP", advanced: true,
    accessor: r => r.paceAndPpp ? r.paceAndPpp.ppp : null,
    display: r => r.paceAndPpp ? r.paceAndPpp.ppp.toFixed(2) : "—",
    tooltip: "Points per total play (their own team's points divided by Pace's play count): scoring efficiency measured against actual plays rather than combined score. Same Stopped Early exclusion as Pace." },
  { key: "winshares", label: "Win Shares (beta)", advanced: true,
    accessor: r => r.winShares ? r.winShares.winShares : null,
    display: r => r.winShares ? r.winShares.winShares.toFixed(2) : "—",
    tooltip: "Experimental, provisional: this season's share of actual team wins credited to this player, from a regression fit fresh against real game margins (not an assumed points scale like GmSc/Two-Way), sign-constrained so each stat can only push in its basketball-plausible direction. See the Win Shares Model panel below for this fit's current sample size, alpha, and leave-one-out validation numbers. Not enough data yet to trust for anything with real stakes. Excludes any game flagged Stopped Early: a margin from an incomplete game isn't a real outcome to fit against." },
  { key: "dunks", label: "Dunks", advanced: true, accessor: r => r.dunks, tooltip: "Made dunks, season total (not per-20: a counting stat, not a rate). Only counts shots tagged as a dunk in Stat Entry; games logged before that field existed need a manual pass (Export, Review Possible Dunks) before they count here." },
  { key: "dunkpct", label: "Dunk%", advanced: true, accessor: r => r.dunkPct, display: r => formatPct(r.dunkPct), tooltip: "Share of this player's own field goal attempts (2s and 3s combined) that were tagged as a dunk, make or miss: how much of their offense is above the rim. Same Review Possible Dunks caveat as Dunks: undercounts until older games are backfilled." },
  { key: "selfcreated", label: "Self-Created %", advanced: true,
    accessor: r => r.shotCreation ? r.shotCreation.selfCreatedPct : null,
    display: r => r.shotCreation ? formatPct(r.shotCreation.selfCreatedPct) : "—",
    tooltip: `Share of this player's own makes (2s and 3s) with no assist tagged, vs. set up by a teammate: real shot creation, not an eyeballed inference from how many assists they receive. Needs ${SHOT_CREATION_MIN_FGM}+ makes before showing.` },
  { key: "moneyzone", label: "Money Zone %", advanced: true,
    accessor: r => {
      const money = r.shooting.closeA + r.shooting.tpArcA;
      const total = money + r.shooting.midA + r.shooting.tpDeepA;
      return total > 0 ? pct(money, total) : null;
    },
    display: r => {
      const money = r.shooting.closeA + r.shooting.tpArcA;
      const total = money + r.shooting.midA + r.shooting.tpDeepA;
      return total > 0 ? formatPct(pct(money, total)) : "—";
    },
    tooltip: "Share of this player's own zone-marked field goal attempts from the two real-positive-value zones (Close, 3PT Line) rather than the two weak ones (Midrange, 3PT Deep) -- see the Shot Distance panel below for the four-way split this collapses into one number. How much of this diet is good shots, at a glance, not a read on whether they're making them." },
  { key: "oreb", label: "OREB/20", accessor: r => r.rate.oreb, display: r => r.rate.oreb.toFixed(1), tooltip: "Offensive rebounds (grabbed by a teammate of the shooter), per 20 combined points." },
  { key: "dreb", label: "DREB/20", accessor: r => r.rate.dreb, display: r => r.rate.dreb.toFixed(1), tooltip: "Defensive rebounds (grabbed by an opponent of the shooter), per 20 combined points." },
  { key: "ast", label: "AST/20", accessor: r => r.rate.ast, display: r => r.rate.ast.toFixed(1), tooltip: "Assists (credited on a made shot when a teammate is tagged as the passer), per 20 combined points." },
  { key: "stl", label: "STL/20", accessor: r => r.rate.stl, display: r => r.rate.stl.toFixed(1), tooltip: "Steals, per 20 combined points. Feeds Def Rating below." },
  { key: "tovcredit", label: "TOV Credit %", advanced: true,
    accessor: r => r.turnoverCredit ? r.turnoverCredit.rate : null,
    display: r => r.turnoverCredit ? formatPct(r.turnoverCredit.rate) : "—",
    tooltip: `Of every turnover the opponent committed in games this player's own team was on defense (credited or not -- the whole pool a credited one could come from), what share did this player individually get credited for forcing (a real steal, or being named on a standalone turnover)? A turnover with no one credited has no defender tag at all, so it can't honestly be pinned on one specific teammate over another; this only compares against the real, checkable pool. Separates active disruption from benefiting off sloppy opposing possessions without causing them. Needs ${TURNOVER_CREDIT_MIN_POOL}+ team turnovers forced.` },
  { key: "blk", label: "BLK/20", accessor: r => r.rate.blk, display: r => r.rate.blk.toFixed(1), tooltip: "Blocks (credited on a missed shot when this player is tagged as the blocker), per 20 combined points. Feeds Def Rating below, except when the block is already one of this player's own Stops (the usual case); see Def Rating's own tooltip." },
  { key: "tov", label: "TOV/20", accessor: r => r.rate.tov, display: r => r.rate.tov.toFixed(1), tooltip: "Turnovers (including ones forced by a steal, or a miss ruled out of bounds), per 20 combined points." },
  { key: "atov", label: "A/TO", accessor: r => r.totals.tov === 0 ? (r.totals.ast === 0 ? 0 : Infinity) : r.totals.ast / r.totals.tov, display: r => r.astTov, tooltip: "Assist-to-turnover ratio." },
  { key: "pf", label: "PF/20", accessor: r => r.rate.pf, display: r => r.rate.pf.toFixed(1), tooltip: "Personal fouls, per 20 combined points." },
  { key: "ptsAllowed", label: "Pts Allowed/20", accessor: r => r.rateDefense.ptsAllowed, display: r => r.rateDefense.ptsAllowed.toFixed(1), tooltip: "Points scored by opponents on shots where this player was the tagged defender, per 20 combined points." },
  { key: "oppfg", label: "Opp FG%", accessor: r => pct(r.defense.timesBeaten, r.defense.timesBeaten + r.defense.stops), display: r => formatPct(pct(r.defense.timesBeaten, r.defense.timesBeaten + r.defense.stops)), tooltip: "Shooting percentage of everyone this player was tagged defending, make or miss: a real 'shooting percentage allowed.'" },
  { key: "oppefg", label: "Opp eFG%", advanced: true,
    accessor: r => effectiveFgPct(r.defense.timesBeaten, r.defense.tpmAgainst, r.defense.timesBeaten + r.defense.stops),
    display: r => formatPct(effectiveFgPct(r.defense.timesBeaten, r.defense.tpmAgainst, r.defense.timesBeaten + r.defense.stops)),
    tooltip: "Opp FG%'s value-weighted counterpart, the exact same formula offensive eFG% uses just applied to shots allowed: a made 3 counts as 1.5x a made 2. Separates a defender who allows a lot of made 3s from one allowing the same raw FG% but mostly on 2s, who currently look identical on plain Opp FG% alone." },
  { key: "beaten", label: "Beaten/20", accessor: r => r.rateDefense.timesBeaten, display: r => r.rateDefense.timesBeaten.toFixed(1), tooltip: "Times scored on while tagged as the defender on a made shot, per 20 combined points." },
  { key: "stops", label: "Stops/20", accessor: r => r.rateDefense.stops, display: r => r.rateDefense.stops.toFixed(1), tooltip: "Times tagged as the defender on a missed shot, per 20 combined points." },
  { key: "defrtg20", label: "Def Rating/20", accessor: r => defensiveRating(r.rate, r.rateDefense), display: r => defensiveRating(r.rate, r.rateDefense).toFixed(1), tooltip: "This tool's Defensive Rating: STL, plus BLK (only when it isn't already one of this player's own Stops, so a blocked-and-tagged shot isn't credited twice), plus Stops minus Beaten minus 0.4×Pts Allowed, all per 20 combined points. Not points-allowed-per-100-possessions like the NBA stat of the same name; possessions aren't tracked here, so combined points stands in as the pace proxy, same as every other per-20 rate on this board. 0 for anyone never tagged as a defender with no steals or blocks, not a penalty for conservative tagging." },
  { key: "ptsallowedunderxp", label: "Pts Allowed Under Exp", advanced: true,
    accessor: r => r.expectedPointsAgainst ? r.expectedPointsAgainst.pointsAllowedUnderExpected : null,
    display: r => {
      if (!r.expectedPointsAgainst) return "—";
      const v = r.expectedPointsAgainst.pointsAllowedUnderExpected;
      return `${v >= 0 ? "+" : ""}${v.toFixed(1)}`;
    },
    tooltip: "Expected Points' defensive counterpart, using the same zone rates: every shot this player is tagged defending gets that shot zone's league-average points-per-attempt as its expected value (Close/Midrange/Line/Deep), summed and compared to what was actually scored on them. Positive means allowing fewer points than the shot difficulty they actually faced would predict, the good outcome for defense (opposite sign convention from offensive Pts +/- Exp, where scoring more than expected is good). Separates 'suppresses shooting below what's normal for the shots faced' from 'happens to face an easier or harder mix of shots than average' -- Opp FG% alone can't tell those apart. Needs 10+ tagged defended shots to show at all; inherits the same still-early zone-rate caveat as offensive Expected Points, and doesn't touch the separate, still-open question of whether a 'beaten' shot was genuinely well-defended or not." },
  { key: "offrtg20", label: "Off Rating/20", accessor: r => r.offRatingPer20, display: r => r.offRatingPer20.toFixed(1), tooltip: "Offense-only Game Score: PTS, shooting efficiency, rebounds, assists, TOV, and fouls, adapted from the standard basketball Game Score formula, minus its STL and BLK terms, which live in Def Rating instead, per 20 combined points." },
  { key: "twoway20", label: "Two-Way/20", accessor: r => r.twoWayPer20, display: r => r.twoWayPer20.toFixed(1), tooltip: "Off Rating plus Def Rating, per 20 combined points." },
  { key: "last5", label: "Last 5", accessor: r => r.last5OffRatingPer20, display: r => r.last5Gp > 0 ? `${r.last5Trend} ${r.last5OffRatingPer20.toFixed(1)}` : "—", tooltip: "Off Rating/20 over their last 5 games with real shots logged (fewer if they haven't played 5 yet). ▲/▼ shows whether that's above or below their season Off Rating/20; within ±0.5 counts as flat (–)." }
];

let leaderboardSort = { key: "twoway20", dir: "desc" };

// The six share-of-team/-pool "%" columns (Shot%/AST%/OREB%/DREB%/TRB%/TOV%) are marked
// `advanced: true` above and hidden by default — the newest, most niche additions to an
// already-34-column table, kept a click away instead of always adding to the scroll. Persisted
// so the choice survives a reload, same pattern as THEME_KEY.
const SHOW_ADVANCED_COLS_KEY = "poolLeagueShowAdvancedCols";
let showAdvancedCols = localStorage.getItem(SHOW_ADVANCED_COLS_KEY) === "true";
function visibleLeaderboardColumns() {
  return LEADERBOARD_COLUMNS.filter(c => !c.advanced || showAdvancedCols);
}
function updateAdvancedColsBtnLabel() {
  const input = document.getElementById("toggleAdvancedColsBtn");
  if (input) input.checked = showAdvancedCols;
}
document.getElementById("toggleAdvancedColsBtn").addEventListener("change", e => {
  showAdvancedCols = e.target.checked;
  localStorage.setItem(SHOW_ADVANCED_COLS_KEY, String(showAdvancedCols));
  // A column that just got hidden can't be clicked again to sort by — fall back to the default
  // rather than leaving the table sorted by a column nobody can see or un-sort.
  if (!showAdvancedCols) {
    const advancedKeys = new Set(LEADERBOARD_COLUMNS.filter(c => c.advanced).map(c => c.key));
    if (advancedKeys.has(leaderboardSort.key)) leaderboardSort = { key: "pts", dir: "desc" };
  }
  updateAdvancedColsBtnLabel();
  renderLeaderboard();
});

// All three of these toggles are now real checkbox inputs styled as iOS switches
// (.ios-switch-row in style.css) rather than buttons whose own text used to flip between
// "Include X"/"Exclude X" — the label next to each switch names the setting once, and the
// switch's checked state (fed from `.checked`, not textContent) shows whether it's on. Every
// updater below sets `.checked` to match the underlying flag instead of rewriting a label.
function updateImbalancedGamesBtnLabel() {
  const input = document.getElementById("toggleImbalancedGamesBtn");
  if (input) input.checked = includeImbalancedGames;
}
document.getElementById("toggleImbalancedGamesBtn").addEventListener("change", e => {
  includeImbalancedGames = e.target.checked;
  localStorage.setItem(INCLUDE_IMBALANCED_KEY, String(includeImbalancedGames));
  updateImbalancedGamesBtnLabel();
  invalidateComputedCaches();
  // isQualifyingGame() feeds Leaderboard rates, awards, every Player Detail trend/panel, and
  // most of the league-wide Leaderboard panels — a full re-render, same as any other toggle
  // that changes what counts as "in" rather than just what's shown.
  renderLeaderboard();
});

function updateOutlierGamesBtnLabel() {
  const input = document.getElementById("toggleOutlierGamesBtn");
  if (input) input.checked = includeOutlierGames;
}
document.getElementById("toggleOutlierGamesBtn").addEventListener("change", e => {
  includeOutlierGames = e.target.checked;
  localStorage.setItem(INCLUDE_OUTLIER_GAMES_KEY, String(includeOutlierGames));
  updateOutlierGamesBtnLabel();
  invalidateComputedCaches();
  // qualifyingGamesForPlayer() feeds Leaderboard rates and every per-player Player Detail
  // trend/panel that routes through it — same full-rerender pattern as the other two toggles.
  renderLeaderboard();
});

// Two switches drive the same one global includePastSeasons flag — the original on the
// Leaderboard, and a second on Player Detail's own Past Seasons panel (added so combining a
// player's history doesn't require hopping back to the Leaderboard first just to flip it). Both
// stay in sync automatically since they share this one updater and one flag.
const PAST_SEASONS_TOGGLE_BTN_IDS = ["togglePastSeasonsBtn", "togglePastSeasonsBtnPlayer"];
function updatePastSeasonsBtnLabel() {
  PAST_SEASONS_TOGGLE_BTN_IDS.forEach(id => {
    const input = document.getElementById(id);
    if (!input) return;
    if (!state.currentSeasonStartedAt) {
      input.checked = false;
      input.disabled = true;
      input.title = "No season has been closed yet (Export → Data Management → Start New Season). Nothing archived to include.";
      return;
    }
    input.disabled = false;
    input.title = "";
    input.checked = includePastSeasons;
  });
}
function togglePastSeasonsInclusion(e) {
  includePastSeasons = e.target.checked;
  localStorage.setItem(INCLUDE_PAST_SEASONS_KEY, String(includePastSeasons));
  updatePastSeasonsBtnLabel();
  invalidateComputedCaches();
  // isQualifyingGame() feeds both views off the same flag, so both need a fresh render — cheap
  // even for the one not currently on screen, and keeps it correct whenever the user switches
  // back rather than re-deriving on tab switch.
  renderLeaderboard();
  if (currentPlayerId) renderPlayerDetail();
}
document.getElementById("togglePastSeasonsBtn").addEventListener("change", togglePastSeasonsInclusion);
document.getElementById("togglePastSeasonsBtnPlayer").addEventListener("change", togglePastSeasonsInclusion);

// Nulls (no attempts yet, etc.) always sort last regardless of direction.
function compareForSort(a, b, dir) {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  const cmp = typeof a === "string" ? a.localeCompare(b) : a - b;
  return dir === "asc" ? cmp : -cmp;
}

// Shared click-to-sort header renderer for the smaller Leaderboard-tab tables (Out-of-Bounds
// Misses, Shot Distance) — same mechanism as the main Leaderboard table's own sort
// (LEADERBOARD_COLUMNS/renderLeaderboardHeader), just generalized to take any {key, label,
// accessor} column list and a mutable {key, dir} sort-state object instead of being wired to
// LEADERBOARD_COLUMNS specifically. Mutates `sortState`'s properties in place (not reassigning
// it) so the caller's own variable stays in sync across renders.
function renderSortableHeader(headerRowEl, columns, sortState, onChange) {
  headerRowEl.innerHTML = "";
  columns.forEach(col => {
    const th = document.createElement("th");
    th.className = "sortable-th";
    const active = sortState.key === col.key;
    th.textContent = col.label + (active ? (sortState.dir === "desc" ? " ▼" : " ▲") : "");
    if (active) th.classList.add("sorted");
    th.addEventListener("click", () => {
      if (sortState.key === col.key) {
        sortState.dir = sortState.dir === "desc" ? "asc" : "desc";
      } else {
        sortState.key = col.key;
        sortState.dir = "desc";
      }
      onChange();
    });
    headerRowEl.appendChild(th);
  });
}

function renderLeaderboardHeader() {
  const headerRow = document.getElementById("leaderboardHeaderRow");
  headerRow.innerHTML = "";
  visibleLeaderboardColumns().forEach(col => {
    const th = document.createElement("th");
    th.className = col.key === "player" ? "sortable-th sticky-col" : "sortable-th";
    if (col.tooltip) th.title = col.tooltip;
    const active = leaderboardSort.key === col.key;
    th.textContent = col.label + (active ? (leaderboardSort.dir === "desc" ? " ▼" : " ▲") : "");
    if (active) th.classList.add("sorted");
    th.addEventListener("click", () => {
      if (leaderboardSort.key === col.key) {
        leaderboardSort.dir = leaderboardSort.dir === "desc" ? "asc" : "desc";
      } else {
        leaderboardSort = { key: col.key, dir: "desc" };
      }
      renderLeaderboard();
    });
    headerRow.appendChild(th);
  });
}

// Render order follows the panels' actual top-to-bottom order in index.html — overview, then
// player-comparison scatters, then shot-location/efficiency, then matchup/chemistry grids, then
// situational stats, capped with the season's best/worst individual games. Keep the two in sync.
function renderLeaderboard() {
  updateAdvancedColsBtnLabel();
  updateImbalancedGamesBtnLabel();
  updatePastSeasonsBtnLabel();
  updateOutlierGamesBtnLabel();
  renderLeaderboardHighlights();
  renderLeaderboardHeader();
  renderLeagueSeasonStandings();
  renderConsistencyStandings();
  renderAwardsVsStats();
  renderPowerRankingVsPerformance();
  renderQuadrantChart();
  renderVolumeEfficiencyChart();
  renderPlayStyleClusters();
  renderTwoWayRankChart();
  renderLeagueHeatmap();
  renderShotZonePanel();
  renderDefensiveShotZonePanel();
  renderShotTypePanel();
  renderDeepShotCheckPanel();
  renderMoveCheckPanel();
  renderShotTypeContestPanel();
  appendShotTypeExclusionNote(["shotTypePanel", "deepShotCheckPanel", "moveCheckPanel", "shotTypeContestPanel"]);
  renderCalibrationPanel();
  renderLeagueDirectionSplits();
  renderLeagueTsByZoneChart();
  renderWideOpenShootingPanel();
  renderLeagueTsChart();
  renderMatchupGrid();
  renderReboundBattleRecordPanel();
  renderReboundBattleGridPanel();
  renderTeammateLiftMatrix();
  renderTeammateContextPanel();
  renderAssistSynergy();
  renderOutOfBoundsPanel();
  renderSecondChancePanel();
  renderSecondChanceAllowedPanel();
  renderPointsOffTakeawaysPanel();
  renderGameWinningBucketsPanel();
  renderDefensiveLoadPanel();
  renderWinSharesModelPanel();
  renderCloseGameShootingPanel();
  renderCloseGameDefensePanel();
  renderComebackTracker();
  renderSeasonRecap();
  renderAwardRace();
  renderSeasonTimeline();
  renderRivalries();
  renderRealRivalryMatrix();
  renderUpsetTracker();
  renderPartyRecap();
  renderTrophyCase();
  renderIronMan();
  renderIndividualGamePerformances();
  renderLeagueHighlights();
  renderPlayerComparisonSelects();
  renderPlayerComparison();
  const body = document.getElementById("leaderboardBody");
  body.innerHTML = "";
  // Players with no games yet just clutter the table with a row of dashes.
  const rows = computeLeaderboard().filter(r => r.gp > 0);
  const cols = visibleLeaderboardColumns();
  if (rows.length === 0) {
    body.innerHTML = `<tr><td colspan="${cols.length}" class="empty-state">No games with players yet.</td></tr>`;
    return;
  }
  const sortCol = LEADERBOARD_COLUMNS.find(c => c.key === leaderboardSort.key);
  rows.sort((a, b) => compareForSort(sortCol.accessor(a), sortCol.accessor(b), leaderboardSort.dir));

  // Highlights whoever's leading each column this season — reuses the same "which direction is
  // better" data Player Comparison already established (COMPARISON_NEUTRAL_KEYS/
  // COMPARISON_LOWER_IS_BETTER_KEYS below), so a column reads as a leaderboard the same way in
  // both places rather than inventing a second opinion on which stats even have a "better."
  // "last5" is excluded too — its own display is a trend arrow, not a plain number, same
  // reasoning Player Comparison uses to skip it.
  const columnBest = {};
  const columnWorst = {};
  cols.forEach(col => {
    if (col.key === "player" || col.key === "last5" || COMPARISON_NEUTRAL_KEYS.has(col.key)) return;
    const values = rows.map(r => col.accessor(r)).filter(v => typeof v === "number" && !Number.isNaN(v));
    if (values.length === 0) return;
    const lowerBetter = COMPARISON_LOWER_IS_BETTER_KEYS.has(col.key);
    const best = lowerBetter ? Math.min(...values) : Math.max(...values);
    const worst = lowerBetter ? Math.max(...values) : Math.min(...values);
    columnBest[col.key] = best;
    // Only mark a worst when it's actually distinct from the best — with every value tied (or
    // just one row), the same cell being both "leader" and "last place" would be confusing
    // rather than informative.
    if (worst !== best) columnWorst[col.key] = worst;
  });

  rows.forEach(r => {
    const tr = document.createElement("tr");
    cols.forEach(col => {
      const td = document.createElement("td");
      if (col.key === "player") {
        td.className = "sticky-col";
        const nameBtn = document.createElement("button");
        nameBtn.className = "icon-btn player-name-btn";
        nameBtn.style.color = "var(--accent)";
        nameBtn.style.fontWeight = "700";
        nameBtn.innerHTML = `${renderPlayerAvatar(r.player)}${escapeHtml(r.player.name)}`;
        nameBtn.addEventListener("click", () => openPlayerDetail(r.player.id));
        td.appendChild(nameBtn);
      } else {
        td.className = "num-cell";
        td.textContent = col.display ? col.display(r) : col.accessor(r);
        const value = col.accessor(r);
        if (columnBest[col.key] !== undefined && value === columnBest[col.key]) {
          td.classList.add("leaderboard-leader-cell");
          td.title = "Season leader in this column";
        } else if (columnWorst[col.key] !== undefined && value === columnWorst[col.key]) {
          td.classList.add("leaderboard-worst-cell");
          td.title = "Season worst in this column";
        }
      }
      tr.appendChild(td);
    });
    body.appendChild(tr);
  });
  renderLeaderboardSectionTeasers();
}

// Every stat with a clear "which direction is better" reads that way here; everything else
// (GP, and the shot-share percentages Shot%/AST%/OREB%/DREB%/TRB%) is left uncolored on
// purpose, since a bigger share of the team's shots or assists reflects a role a player's
// settled into, not necessarily better play.
const COMPARISON_NEUTRAL_KEYS = new Set(["gp", "shotpct", "astpct", "orebpct", "drebpct", "trebpct"]);
const COMPARISON_LOWER_IS_BETTER_KEYS = new Set(["l", "tov", "pf", "ptsAllowed", "oppfg", "oppefg", "beaten", "tovpct"]);

// Rebuilds the two <select> option lists from the current roster — cheap, called on every
// Leaderboard render so a player added elsewhere shows up without a reload. Re-setting
// innerHTML only touches the <option> children, not the <select> itself, so the change
// listeners wired once below stay attached across re-renders.
function renderPlayerComparisonSelects() {
  const sel1 = document.getElementById("comparePlayer1Select");
  const sel2 = document.getElementById("comparePlayer2Select");
  if (!sel1 || !sel2) return;
  const options = ['<option value="">Select a player…</option>']
    .concat([...state.players].sort((a, b) => a.name.localeCompare(b.name)).map(p => `<option value="${p.id}">${escapeHtml(p.name)}</option>`))
    .join("");
  const prev1 = sel1.value, prev2 = sel2.value;
  sel1.innerHTML = options;
  sel2.innerHTML = options;
  sel1.value = prev1;
  sel2.value = prev2;
}

// Every LEADERBOARD_COLUMNS entry, reused as-is (accessor/display/tooltip) so this table can
// never drift from what the main Season Rates table itself shows — always all of them,
// including the advanced ones, regardless of the Leaderboard's own show/hide toggle, since a
// two-column comparison doesn't have that table's 34-column width problem. "player" and "last5"
// are skipped: player is the row label already, and Last 5's trend-arrow display format doesn't
// reduce to a single comparable number the way every other column does.
function renderPlayerComparison() {
  const wrap = document.getElementById("playerComparisonResult");
  if (!wrap) return;
  const id1 = document.getElementById("comparePlayer1Select")?.value;
  const id2 = document.getElementById("comparePlayer2Select")?.value;
  if (!id1 || !id2) {
    wrap.innerHTML = '<p class="empty-state">Pick two players above.</p>';
    return;
  }
  if (id1 === id2) {
    wrap.innerHTML = '<p class="empty-state">Pick two different players.</p>';
    return;
  }
  const board = computeLeaderboard();
  const row1 = board.find(r => r.player.id === id1);
  const row2 = board.find(r => r.player.id === id2);
  if (!row1 || !row2) { wrap.innerHTML = ""; return; }

  const rowsHtml = LEADERBOARD_COLUMNS.filter(c => c.key !== "player" && c.key !== "last5").map(col => {
    const v1 = col.accessor(row1), v2 = col.accessor(row2);
    const d1 = col.display ? col.display(row1) : v1;
    const d2 = col.display ? col.display(row2) : v2;
    let cls1 = "", cls2 = "";
    if (!COMPARISON_NEUTRAL_KEYS.has(col.key) && typeof v1 === "number" && typeof v2 === "number" && v1 !== v2) {
      const lowerBetter = COMPARISON_LOWER_IS_BETTER_KEYS.has(col.key);
      const win1 = lowerBetter ? v1 < v2 : v1 > v2;
      cls1 = win1 ? "compare-better" : "compare-worse";
      cls2 = win1 ? "compare-worse" : "compare-better";
    }
    return `<tr title="${escapeHtml(col.tooltip || "")}"><td class="compare-stat-label">${escapeHtml(col.label)}</td><td class="${cls1}">${d1}</td><td class="${cls2}">${d2}</td></tr>`;
  }).join("");

  wrap.innerHTML = `
    <div class="table-scroll">
      <table class="matchup-table compare-table">
        <thead><tr><th></th><th>${playerLink(row1.player.id, row1.player.name)}</th><th>${playerLink(row2.player.id, row2.player.name)}</th></tr></thead>
        <tbody>${rowsHtml}</tbody>
      </table>
    </div>
  `;
}
document.getElementById("comparePlayer1Select").addEventListener("change", renderPlayerComparison);
document.getElementById("comparePlayer2Select").addEventListener("change", renderPlayerComparison);

// ---------- Player Detail ----------
let currentPlayerId = null;

function openPlayerDetail(playerId) {
  currentPlayerId = playerId;
  showTab("player");
  renderPlayerDetail();
}

document.getElementById("backToLeaderboardBtn").addEventListener("click", () => {
  currentPlayerId = null;
  showTab("leaderboard");
});

function renderPlayerDetail() {
  const player = state.players.find(p => p.id === currentPlayerId);
  if (!player) return;

  const row = computeLeaderboard().find(r => r.player.id === currentPlayerId);
  document.getElementById("playerDetailTitle").innerHTML = `${renderPlayerAvatar(player, "large", playerAvatarRingClass(player.id))}<span>${escapeHtml(player.name)}</span>`;
  renderPlayerRankPill(player.id);
  document.getElementById("playerDetailSummary").textContent = row
    ? `${row.wins}-${row.losses}${row.ties ? `-${row.ties}` : ""} · ${row.rate.pts.toFixed(1)} PTS/20 · ${row.offRatingPer20.toFixed(1)} Off Rating/20 · ${row.twoWayPer20.toFixed(1)} Two-Way/20`
    : "No games yet";
  const shareBtn = document.getElementById("sharePlayerBtn");
  shareBtn.onclick = () => shareOrCopy({
    title: "Pool League Stat Tracker",
    text: row
      ? `${player.name}: ${row.wins}-${row.losses}${row.ties ? `-${row.ties}` : ""}, ${row.twoWayPer20.toFixed(1)} Two-Way/20`
      : player.name,
    url: `${location.origin}${location.pathname}#player=${encodeURIComponent(player.id)}`
  }, shareBtn);
  const cardBtn = document.getElementById("downloadCardBtn");
  if (cardBtn) cardBtn.onclick = () => downloadTradingCard(player.id);

  // Render order follows the panels' actual top-to-bottom order in index.html — tips first, then
  // past-season context, then season overview, then offense detail (shots, then who defended
  // them), then defense detail (same shape, mirrored), then team context, then media. Keep the
  // two in sync.
  renderPlayerLeagueRank(player.id);
  renderPlayerAwardBadges(player.id);
  renderPlayerPowerRanking(player.id);
  renderPlayerRealSeasons(player.id);
  renderPlayerRealRecord(player.id);
  renderPlayerRealPartners(player.id);
  renderPlayerStreaks(player.id);
  renderPlayerAttendanceStreak(player.id);
  renderPlayerTips(player.id);
  renderNotableMatchups(player.id);
  renderSeasonHistoryPanel(player.id);
  renderFlakeStatsPanel(player.id);
  renderTwoWayTrendChart(player.id);
  renderPlayerStatTrend(player.id);
  renderPlayerShotTypes(player.id);
  renderPlayerShotArc(player.id);
  renderPlayerGameLog(player.id);
  renderPlayerShotChart(player.id);
  renderPlayerHeatmap(player.id);
  renderHeadToHead(player.id); // fills both the As-Scorer and As-Defender tables in one pass
  renderPlayerDefensiveHeatmap(player.id);
  renderTeammateSynergy(player.id);
  renderTeammateQualityChart(player.id);
  renderAssistedByPanel(player.id);
  renderOffensiveMatchupDifficultyChart(player.id);
  renderDefensiveMatchupDifficultyChart(player.id);
  renderPlayerDefensiveLoadPanel(player.id);
  renderPlayerReel(player.id);
  renderAreasToWorkOn(player.id);
  renderShootingByDirection(player.id);
  renderPlayerSectionTeasers(player.id);
}

const SHOOTING_BY_DIRECTION_MIN_FGA = 5;

// FG%/TS% split by which hoop this player's own team was facing that game (see
// playerShotDirection/game.teamADirection) -- e.g. checking whether the sun genuinely costs
// shooting one direction more than the other on an outdoor court, not just a feeling. Only counts
// games where the game's own direction has actually been set; most historical games won't have
// this until it's set retroactively in Stat Entry.
function computeShootingByDirection(playerId) {
  const totals = { left: { fgm: 0, fga: 0, fta: 0, pts: 0 }, right: { fgm: 0, fga: 0, fta: 0, pts: 0 } };
  qualifyingGamesForPlayer(playerId).forEach(game => {
    const dir = playerShotDirection(game, playerId);
    if (!dir) return;
    const sh = shootingStats(game, playerId);
    totals[dir].fgm += sh.fgm;
    totals[dir].fga += sh.fga;
    totals[dir].fta += sh.fta;
    const s = game.stats.find(st => st.playerId === playerId);
    if (s) totals[dir].pts += s.pts;
  });
  const build = t => t.fga < SHOOTING_BY_DIRECTION_MIN_FGA ? null : {
    fga: t.fga, fgPct: pct(t.fgm, t.fga), tsPct: trueShootingPct(t.pts, t.fga, t.fta),
  };
  return { left: build(totals.left), right: build(totals.right) };
}

function renderShootingByDirection(playerId) {
  const wrap = document.getElementById("playerShootingByDirection");
  if (!wrap) return;
  const panel = wrap.closest(".panel");
  const { left, right } = computeShootingByDirection(playerId);
  // Almost no historical game has "Where is Team A shooting?" set, so this panel is an empty
  // state for nearly every player -- hidden until there's real data instead of adding to the
  // wall of empty-state text on the page.
  if (!left && !right) {
    if (panel) panel.style.display = "none";
    return;
  }
  if (panel) panel.style.display = "";
  const row = (label, t) => t
    ? `<tr><td>${label}</td><td>${t.fga}</td><td>${formatPct(t.fgPct)}</td><td>${formatPct(t.tsPct)}</td></tr>`
    : `<tr><td>${label}</td><td colspan="3" class="hint">Not enough attempts yet (${SHOOTING_BY_DIRECTION_MIN_FGA}+ needed)</td></tr>`;
  let diffNote = "";
  if (left && right) {
    const diff = left.fgPct - right.fgPct;
    if (Math.abs(diff) >= 8) {
      const better = diff > 0 ? directionLabel("left") : directionLabel("right");
      diffNote = `<p class="hint" style="margin:8px 0 0">${Math.abs(diff)} points better shooting toward the ${escapeHtml(better.toLowerCase())} so far, worth watching if it holds up as more games get set.</p>`;
    }
  }
  wrap.innerHTML = `
    <table class="matchup-table">
      <thead><tr><th>Direction</th><th>FGA</th><th>FG%</th><th>TS%</th></tr></thead>
      <tbody>${row(directionLabel("left"), left)}${row(directionLabel("right"), right)}</tbody>
    </table>
    ${diffNote}
  `;
}

// Every highlight/lowlight clip tagged to this player, across every game — the per-clip
// player tag itself is set from the Reel table in Stat Entry; this just collects them.
function renderPlayerReel(playerId) {
  const body = document.getElementById("playerReelBody");
  const clips = [];
  state.games.forEach(g => {
    g.plays.forEach(play => {
      if (play.playerId === playerId) clips.push({ ...play, gameId: g.id, gameDate: g.date });
    });
  });
  clips.sort((a, b) => (b.gameDate || "").localeCompare(a.gameDate || ""));

  if (clips.length === 0) {
    body.innerHTML = '<tr><td colspan="5" class="empty-state">No clips tagged to this player yet.</td></tr>';
    return;
  }
  body.innerHTML = "";
  clips.forEach(clip => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${formatDateDisplay(clip.gameDate)}</td>
      <td>${clip.type === "highlight" ? '<span class="badge badge-highlight">🔥 Highlight</span>' : '<span class="badge badge-lowlight">👎 Lowlight</span>'}</td>
      <td>${formatTime(clip.start)}–${formatTime(clip.end)}</td>
      <td>${escapeHtml(clip.note || "")}</td>
    `;
    const tdBtn = document.createElement("td");
    const goBtn = document.createElement("button");
    goBtn.type = "button";
    goBtn.className = "secondary-btn";
    goBtn.textContent = "▶ Jump";
    goBtn.addEventListener("click", () => openGameAndSeek(clip.gameId, clip.start));
    tdBtn.appendChild(goBtn);
    tr.appendChild(tdBtn);
    body.appendChild(tr);
  });
}

// League-wide Highlights & Lowlights — every tagged clip across every player and game, not
// scoped to one player like the Reel above. Same underlying data (game.plays), just pooled with
// a Player column added, so it reads as a season highlight reel instead of requiring someone to
// click into each player's own profile to find their clips.
function computeLeagueHighlights() {
  const clips = [];
  state.games.forEach(g => {
    g.plays.forEach(play => {
      const player = state.players.find(p => p.id === play.playerId);
      if (player) clips.push({ ...play, player, gameId: g.id, gameDate: g.date });
    });
  });
  return clips.sort((a, b) => (b.gameDate || "").localeCompare(a.gameDate || ""));
}

function renderLeagueHighlights() {
  const body = document.getElementById("leagueHighlightsBody");
  if (!body) return;
  updateLeagueExportButton();
  const clips = computeLeagueHighlights();
  body.innerHTML = "";
  if (clips.length === 0) {
    body.innerHTML = '<tr><td colspan="6" class="empty-state">No clips tagged yet. Mark one from the Highlight / Lowlight Reel table in Stat Entry.</td></tr>';
    return;
  }
  clips.forEach(clip => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${formatDateDisplay(clip.gameDate)}</td>
      <td>${playerLink(clip.player.id, clip.player.name)}</td>
      <td>${clip.type === "highlight" ? '<span class="badge badge-highlight">🔥 Highlight</span>' : '<span class="badge badge-lowlight">👎 Lowlight</span>'}</td>
      <td>${formatTime(clip.start)}–${formatTime(clip.end)}</td>
      <td>${escapeHtml(clip.note || "")}</td>
    `;
    const tdBtn = document.createElement("td");
    const goBtn = document.createElement("button");
    goBtn.type = "button";
    goBtn.className = "secondary-btn";
    goBtn.textContent = "▶ Jump";
    goBtn.addEventListener("click", () => openGameAndSeek(clip.gameId, clip.start));
    tdBtn.appendChild(goBtn);
    tr.appendChild(tdBtn);
    body.appendChild(tr);
  });
}

// ---- Combine League Highlights into one downloadable video ----
// Same real-time, in-browser MediaRecorder approach as the per-game Reel export (see that one's
// comment in the Stat Entry section for the full reasoning), extended across every game that has
// a usable video instead of just whichever one happens to be open. The one real architectural
// difference: this uses its own dedicated <video> element (there may not be a game open at all),
// whose src gets swapped between games — captureStream() stays bound to that one element the
// whole time, so pause()/resume() around each game's load keeps this one continuous MediaRecorder
// session, exactly like the per-game version, instead of needing several files stitched together
// afterward. Reuses pickRecorderMimeType()/waitForSeek()/waitUntilTime()/raceCancel() from that
// same section — the per-clip mechanics don't change, only how the video source is supplied.
let leagueExportState = null; // { cancelled, resolveCancel } while an export is running

// Every clip across the whole league, grouped by game, with both levels sorted ascending (oldest
// game first, then earliest clip within it) — a combined video should tell the season's story in
// the order it actually happened, the opposite of computeLeagueHighlights()'s own newest-first
// sort (that one's built for a reading list, not a video).
function leagueClipsByGameChronological() {
  return state.games
    .map(game => ({ game, clips: reelClipsChronological(game) }))
    .filter(({ clips }) => clips.length > 0)
    .sort((a, b) => (a.game.date || "").localeCompare(b.game.date || ""));
}

function updateLeagueExportButton() {
  const btn = document.getElementById("exportLeagueVideoBtn");
  if (!btn) return;
  const totalClips = leagueClipsByGameChronological().reduce((sum, { clips }) => sum + clips.length, 0);
  btn.disabled = !!leagueExportState || totalClips === 0;
}

// Resolves to a playable video src for this specific game (a blob: URL for a locally stored
// file, or the game's own direct video link) or null if there's nothing captureStream() can use
// — a YouTube embed or a generic iframe link. Deliberately doesn't touch localVideoBlobUrls'/
// masterVideoBlobUrls' existing caches or call renderStatEntry() the way loadStoredVideo()/
// loadStoredMasterVideo() do — those two are wired to "the one currently open game," and this
// runs across many games that mostly aren't open, so it keeps its own cache instead.
const leagueExportVideoSrcCache = {};
async function getGameVideoSrcForExport(game) {
  const cacheKey = game.masterVideoId || game.id;
  if (cacheKey in leagueExportVideoSrcCache) return leagueExportVideoSrcCache[cacheKey];
  let src = null;
  const file = await getVideoFile(cacheKey);
  if (file) {
    src = URL.createObjectURL(file);
  } else if (game.videoUrl) {
    const isYouTube = /(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|embed\/|shorts\/))/.test(game.videoUrl);
    const isDirectVideo = /\.(mp4|webm|ogg|mov)(\?.*)?$/i.test(game.videoUrl);
    if (!isYouTube && isDirectVideo) src = game.videoUrl;
  }
  leagueExportVideoSrcCache[cacheKey] = src;
  return src;
}

// Resolves once `video.src` has actually loaded enough to seek/play — needed since this swaps
// src on one persistent element rather than creating a new one per game.
// Resolves "done", "error" (a real <video error> event — a corrupt file, an unsupported codec,
// whatever the cause), or, past `timeoutMs` with neither ever firing, "timeout" — this used to
// have no timeout at all and rejected on error rather than resolving, so a swap that silently
// never settled (this exact video element already has a live captureStream() attached to it,
// mid-recording, when its src changes — not a normal video-loading situation) hung the whole
// export forever, and a genuine load error threw an unhandled rejection past this function's own
// try/finally, leaving the export state stuck non-null and every future export attempt a no-op
// with no visible error at all.
function loadVideoSrc(video, src, timeoutMs = 20000) {
  return new Promise(resolve => {
    let settled = false;
    function cleanup() {
      video.removeEventListener("loadedmetadata", onReady);
      video.removeEventListener("error", onError);
      clearTimeout(timeout);
    }
    function onReady() { if (settled) return; settled = true; cleanup(); resolve("done"); }
    function onError() { if (settled) return; settled = true; cleanup(); resolve("error"); }
    video.addEventListener("loadedmetadata", onReady, { once: true });
    video.addEventListener("error", onError, { once: true });
    video.src = src;
    video.load();
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve("timeout");
    }, timeoutMs);
  });
}

// Everything from here down used to be exportLeagueVideo() itself, hardwired to
// leagueClipsByGameChronological()'s own manually-tagged plays. Factored out so a second caller
// (Areas to Work On's own "Watch these clips" button — see computeCategoryClipGroups() below) can
// feed it a different clip source: a filter's own matching scoringEvents, synthesized into clips
// on the fly, in exactly the same {game, clips: [{start, end}]} shape leagueClipsByGameChronological()
// already produces. Nothing about the actual recording pipeline (source resolution, the
// mid-export recorder-recreation-on-src-swap fix, cancel handling) changes at all — only where
// the clip list itself comes from.
async function runClipExportFromGroups(grouped, downloadFilename) {
  if (leagueExportState) return;
  if (grouped.length === 0) return;
  const mimeType = pickRecorderMimeType();
  const statusEl = document.getElementById("leagueExportStatus");
  if (!mimeType) {
    statusEl.textContent = "This browser doesn't support recording video. Try a recent Chrome or Firefox.";
    return;
  }

  const previewWrap = document.getElementById("leagueExportPreviewWrap");
  const video = document.getElementById("leagueExportVideo");
  previewWrap.hidden = false;
  video.muted = false;

  let resolveCancel;
  const cancelPromise = new Promise(resolve => { resolveCancel = resolve; });
  leagueExportState = { cancelled: false, resolveCancel };
  document.getElementById("exportLeagueVideoBtn").disabled = true;
  document.getElementById("cancelLeagueExportBtn").hidden = false;

  // Resolve every game's video source up front, before any recording starts — this way "which
  // games got skipped" is known before spending any real recording time, and games sharing the
  // same source (a shared session video) only ever get fetched once.
  statusEl.textContent = "Checking video sources…";
  const queue = []; // flat list of {game, clip, src}, video reloads only happen when src changes
  let skippedGames = 0, skippedClips = 0;
  for (const { game, clips } of grouped) {
    if (leagueExportState.cancelled) break;
    let src = null;
    try { src = await getGameVideoSrcForExport(game); } catch (e) { src = null; }
    if (!src) {
      skippedGames++;
      skippedClips += clips.length;
      continue;
    }
    clips.forEach(clip => queue.push({ game, clip, src }));
  }

  const totalClips = queue.length;
  let done = 0;
  let currentSrc = null;
  let stoppedEarly = null;
  const chunks = [];

  // captureStream() has to happen once this element actually has a real frame to capture — call
  // it while `video` still has no src at all (as it does right here, since this element only ever
  // exists for exports and nothing else ever sets its src) and on Chrome the captured stream just
  // stays black for the entire recording, regardless of every later src swap. So the very first
  // clip's source loads BEFORE captureStream()/the MediaRecorder get created, not after — every
  // other src swap later in the loop below is fine, since the stream's already bound to a real,
  // already-playing video by then.
  // Started paused so only actual clip playback — not the seeking/loading between clips or
  // between games — ends up in the recording. pause()/resume() (not stop-and-restart) keeps it
  // one continuous MediaRecorder session — normally. Pulled into its own function since a src
  // swap can force rebuilding this mid-export too (see the try/catch around .resume() below).
  function createLeagueRecorder() {
    const stream = video.captureStream ? video.captureStream() : video.mozCaptureStream();
    const r = new MediaRecorder(stream, { mimeType });
    r.ondataavailable = e => { if (e.data.size > 0) chunks.push(e.data); };
    r.start();
    r.pause();
    return r;
  }

  let recorder = null;
  if (totalClips > 0 && !leagueExportState.cancelled) {
    const first = queue[0];
    statusEl.textContent = `Loading video for ${formatDateDisplay(first.game.date)}…`;
    const firstLoadOutcome = await raceCancel(loadVideoSrc(video, first.src), cancelPromise);
    if (firstLoadOutcome === "error" || firstLoadOutcome === "timeout") {
      stoppedEarly = `Couldn't load the video for ${formatDateDisplay(first.game.date)}. Stopped there.`;
    } else if (firstLoadOutcome !== "cancelled") {
      currentSrc = first.src;
      recorder = createLeagueRecorder();
    }
  }
  try {
    for (const { game, clip, src } of queue) {
      if (leagueExportState.cancelled || !recorder) break;

      if (src !== currentSrc) {
        statusEl.textContent = `Loading video for ${formatDateDisplay(game.date)}…`;
        const loadOutcome = await raceCancel(loadVideoSrc(video, src), cancelPromise);
        if (loadOutcome === "cancelled") break;
        if (loadOutcome !== "done") {
          stoppedEarly = `Couldn't load the video for ${formatDateDisplay(game.date)}. Stopped there.`;
          break;
        }
        currentSrc = src;
      }

      done++;
      statusEl.textContent = `Recording clip ${done} of ${totalClips} (${formatDateDisplay(game.date)})…`;

      const seekOutcome = await raceCancel(waitForSeek(video, clip.start), cancelPromise);
      if (seekOutcome === "cancelled") break;
      if (seekOutcome === "timeout") {
        stoppedEarly = `Clip ${done} of ${totalClips} never finished seeking. Stopped there.`;
        break;
      }

      // Real bug found by testing: a video src swap can end the MediaRecorder's captured track
      // out from under it — Chrome auto-stops a MediaRecorder once its source track ends, per
      // spec — and exactly when that transition actually lands isn't reliably predictable ahead
      // of time (checking `recorder.state` right after the swap succeeds was too early; the
      // recorder was still "paused" then and only flipped to "inactive" some time after). Calling
      // `.resume()` on an inactive recorder throws, which used to propagate straight out of this
      // whole function, skipping every bit of cleanup below and leaving `leagueExportState` stuck
      // non-null forever (every future export attempt silently no-ops from then on) — from the
      // outside this looked exactly like a permanent freeze on whichever clip happened to be the
      // first one needing a source swap. Catching the failure right here, at the one place it can
      // actually happen, and rebuilding fresh bound to the now-current video, sidesteps needing to
      // predict the timing at all — the new recorder keeps pushing into the same `chunks` array,
      // so the segments concatenate into one downloadable blob at the end.
      try {
        recorder.resume();
      } catch (e) {
        recorder = createLeagueRecorder();
        recorder.resume();
      }
      const playPromise = video.play().catch(() => {});
      const playOutcome = await Promise.race([
        playPromise.then(() => "played"),
        cancelPromise.then(() => "cancelled"),
        new Promise(resolve => setTimeout(() => resolve("timeout"), 8000))
      ]);
      if (playOutcome !== "played") {
        recorder.pause();
        if (playOutcome === "cancelled") break;
        stoppedEarly = `Clip ${done} of ${totalClips} didn't start playing. Stopped there.`;
        break;
      }

      // Same per-clip-sized timeout as the per-game export above, not a flat constant.
      const remaining = Math.max(0, clip.end - video.currentTime);
      const waitOutcome = await raceCancel(waitUntilTime(video, clip.end, Math.max(15000, remaining * 3000)), cancelPromise);
      video.pause();
      recorder.pause();
      if (waitOutcome === "cancelled") break;
      if (waitOutcome === "timeout") {
        stoppedEarly = `Clip ${done} of ${totalClips} stalled partway through. Stopped there.`;
        break;
      }
    }
  } finally {
    if (recorder && recorder.state !== "inactive") {
      recorder.stop();
      await new Promise(resolve => { recorder.onstop = resolve; });
    }
    video.pause();
    video.removeAttribute("src");
    video.load();
    previewWrap.hidden = true;
  }

  const cancelled = leagueExportState.cancelled;
  leagueExportState = null;
  document.getElementById("cancelLeagueExportBtn").hidden = true;
  updateLeagueExportButton();

  const skipNote = skippedClips > 0
    ? ` (${skippedClips} clip${skippedClips === 1 ? "" : "s"} across ${skippedGames} game${skippedGames === 1 ? "" : "s"} skipped: no usable video source.)`
    : "";
  if (cancelled) {
    statusEl.textContent = "Cancelled. Nothing downloaded.";
  } else if (chunks.length === 0) {
    statusEl.textContent = (stoppedEarly || "Recording produced no data. Try again.") + skipNote;
  } else {
    const blob = new Blob(chunks, { type: mimeType });
    download(`${downloadFilename}.${pickRecorderExtension(mimeType)}`, blob, mimeType);
    statusEl.textContent = stoppedEarly
      ? `${stoppedEarly} Downloaded what was recorded before that.${skipNote}`
      : `Done: ${done} clip${done === 1 ? "" : "s"} combined and downloaded.${skipNote}`;
  }
}

function exportLeagueVideo() {
  return runClipExportFromGroups(leagueClipsByGameChronological(), "league-highlights");
}

document.getElementById("exportLeagueVideoBtn").addEventListener("click", () => {
  exportLeagueVideo();
});
document.getElementById("cancelLeagueExportBtn").addEventListener("click", () => {
  if (leagueExportState) {
    leagueExportState.cancelled = true;
    leagueExportState.resolveCancel();
  }
});

// Same idea as GAME_STATS_COLUMNS, but each row is one of this player's own games (not another
// player in the same game) — accessor reads off a precomputed {game, s, def, sh, offRtg, twoWay,
// result} row.
const PLAYER_GAME_LOG_COLUMNS = [
  { key: "date", label: "Date", accessor: r => r.game.date || "" },
  { key: "result", label: "Result", accessor: r => r.result || "" },
  { key: "pts", label: "PTS", accessor: r => r.s.pts },
  { key: "fg", label: "FG", accessor: r => r.sh.fga },
  { key: "tpt", label: "3PT", accessor: r => r.sh.tpa },
  { key: "ft", label: "FT", accessor: r => r.sh.fta },
  { key: "efg", label: "eFG%", accessor: r => effectiveFgPct(r.sh.fgm, r.sh.tpm, r.sh.fga) },
  { key: "ts", label: "TS%", accessor: r => trueShootingPct(r.s.pts, r.sh.fga, r.sh.fta) },
  { key: "oreb", label: "OREB", accessor: r => r.s.oreb },
  { key: "dreb", label: "DREB", accessor: r => r.s.dreb },
  { key: "ast", label: "AST", accessor: r => r.s.ast },
  { key: "stl", label: "STL", accessor: r => r.s.stl },
  { key: "blk", label: "BLK", accessor: r => r.s.blk },
  { key: "tov", label: "TOV", accessor: r => r.s.tov },
  { key: "atov", label: "A/TO", accessor: r => r.s.tov === 0 ? (r.s.ast === 0 ? 0 : Infinity) : r.s.ast / r.s.tov },
  { key: "pf", label: "PF", accessor: r => r.s.pf },
  { key: "ptsAllowed", label: "Pts Allowed", accessor: r => r.def.ptsAllowed },
  { key: "oppfg", label: "Opp FG%", accessor: r => r.def.oppFgPct },
  { key: "beaten", label: "Beaten", accessor: r => r.def.timesBeaten },
  { key: "stops", label: "Stops", accessor: r => r.def.stops },
  { key: "offrtg", label: "Off Rating", accessor: r => r.offRtg },
  { key: "twoway", label: "Two-Way", accessor: r => r.twoWay }
];
let playerGameLogSort = { key: "date", dir: "desc" };

function renderPlayerGameLog(playerId) {
  const headerRow = document.getElementById("playerGameLogHeaderRow");
  const body = document.getElementById("playerGameLogBody");
  renderSortableHeader(headerRow, PLAYER_GAME_LOG_COLUMNS, playerGameLogSort, () => renderPlayerGameLog(playerId));
  body.innerHTML = "";
  const games = state.games.filter(g => g.teamA.includes(playerId) || g.teamB.includes(playerId));
  if (games.length === 0) {
    body.innerHTML = '<tr><td colspan="22" class="empty-state">No games recorded for this player yet.</td></tr>';
    return;
  }
  const rows = games.map(game => {
    const s = getOrCreatePlayerStats(game, playerId);
    const sh = shootingStats(game, playerId);
    const def = gameDefenseStats(game, playerId);
    return { game, s, sh, def, result: playerGameResult(game, playerId), offRtg: offensiveRating(s, sh), twoWay: twoWayScore(s, sh, def) };
  });
  // Best/worst individual game by Two-Way score, same 🔥/👎 language as the Games list's own
  // best/worst-this-game badges — only among games with real shots logged, so an unreviewed
  // 0-everything game can never wrongly "win" either title, and only when there are at least 2
  // reviewed games (with just 1, best and worst would trivially be the same game).
  const reviewed = rows.filter(r => r.game.scoringEvents.length > 0 && !r.game.stoppedEarly);
  let bestGameId = null, worstGameId = null;
  if (reviewed.length >= 2) {
    bestGameId = reviewed.reduce((a, b) => b.twoWay > a.twoWay ? b : a).game.id;
    worstGameId = reviewed.reduce((a, b) => b.twoWay < a.twoWay ? b : a).game.id;
    if (worstGameId === bestGameId) worstGameId = null;
  }
  const sortCol = PLAYER_GAME_LOG_COLUMNS.find(c => c.key === playerGameLogSort.key);
  rows.sort((a, b) => compareForSort(sortCol.accessor(a), sortCol.accessor(b), playerGameLogSort.dir));
  rows.forEach(r => {
    const tr = document.createElement("tr");
    const twoWayBadge = r.game.id === bestGameId
      ? ' <span class="badge badge-highlight" title="Best individual game this season by Two-Way score.">🔥</span>'
      : r.game.id === worstGameId
        ? ' <span class="badge badge-lowlight" title="Worst individual game this season by Two-Way score.">👎</span>'
        : "";
    const stoppedEarlyBadge = r.game.stoppedEarly
      ? ' <span class="badge badge-lowlight" title="This game ended early. Not comparable to a complete game -- excluded from Best/Worst Games, Power Ranking vs. Performance, Shot Attempt Differential, Pace/PPP, and Win Shares.">🛑</span>'
      : "";
    tr.innerHTML = `
      <td><button type="button" class="icon-btn game-log-date-btn" data-game-id="${r.game.id}" style="padding:0;font-weight:600;color:var(--accent)">${formatDateDisplay(r.game.date)}</button>${stoppedEarlyBadge}</td>
      <td>${r.result || "—"}</td>
      <td>${r.s.pts}</td>
      <td>${formatShootingSplit(r.sh.fgm, r.sh.fga)}</td>
      <td>${formatShootingSplit(r.sh.tpm, r.sh.tpa)}</td>
      <td>${formatShootingSplit(r.sh.ftm, r.sh.fta)}</td>
      <td>${formatPct(effectiveFgPct(r.sh.fgm, r.sh.tpm, r.sh.fga))}</td>
      <td>${formatPct(trueShootingPct(r.s.pts, r.sh.fga, r.sh.fta))}</td>
      <td>${r.s.oreb}</td>
      <td>${r.s.dreb}</td>
      <td>${r.s.ast}</td>
      <td>${r.s.stl}</td>
      <td>${r.s.blk}</td>
      <td>${r.s.tov}</td>
      <td>${formatAstTov(r.s.ast, r.s.tov)}</td>
      <td>${foulCellHtml(r.s.pf)}</td>
      <td>${r.def.ptsAllowed}</td>
      <td>${formatPct(r.def.oppFgPct)}</td>
      <td>${r.def.timesBeaten}</td>
      <td>${r.def.stops}</td>
      <td>${r.offRtg.toFixed(1)}</td>
      <td>${r.twoWay.toFixed(1)}${twoWayBadge}</td>
    `;
    body.appendChild(tr);
  });
  body.querySelectorAll(".game-log-date-btn").forEach(btn => {
    btn.addEventListener("click", () => openGame(btn.dataset.gameId));
  });
}

// Shared by headToHeadAsScorer/headToHeadAsDefender below — walks every qualifying game's
// scoring events matching `matchEvent`, bucketing fgm/fga by whatever key(s) `keysFor` returns
// for that event (an array, since a double-teamed shot counts fully against each tagged
// defender's own bucket, same as gameDefenseStats()).
function accumulateHeadToHeadFg(matchEvent, keysFor) {
  const totals = {}; // key -> { fgm, fga }
  state.games.filter(isQualifyingGame).forEach(g => {
    g.scoringEvents.filter(matchEvent).forEach(ev => {
      keysFor(ev).forEach(key => {
        totals[key] = totals[key] || { fgm: 0, fga: 0 };
        totals[key].fga++;
        if (ev.made !== false) totals[key].fgm++;
      });
    });
  });
  return totals;
}

// Every shot this player took, grouped by who (if anyone) was tagged defending it.
function headToHeadAsScorer(playerId) {
  const totals = accumulateHeadToHeadFg(
    ev => ev.scorerId === playerId,
    ev => (ev.defenderIds && ev.defenderIds.length > 0) ? ev.defenderIds : ["none"]
  );
  return Object.entries(totals)
    .map(([key, v]) => ({ defenderId: key === "none" ? null : key, ...v }))
    .sort((a, b) => b.fga - a.fga);
}

// Every shot this player was tagged defending, grouped by who took it.
function headToHeadAsDefender(playerId) {
  const totals = accumulateHeadToHeadFg(
    ev => (ev.defenderIds || []).includes(playerId),
    ev => [ev.scorerId]
  );
  return Object.entries(totals)
    .map(([scorerId, v]) => ({ scorerId, ...v }))
    .sort((a, b) => b.fga - a.fga);
}

// League-wide version of the same "real matchup swing" signal Personalized Tips surfaces on one
// player's own Player Detail page — every scorer/defender pair involving them, with a genuinely
// notable shooting swing, ranked biggest first. Optionally scoped to one player (either side of
// the matchup) via `onlyPlayerId`; omitted entirely, it returns every notable pair league-wide.
// Same bar for "real, not noise" either way: 5+ attempts against that one specific opponent, and
// at least 15 percentage points away from the scorer's own overall FG% (not the league's — this
// is about what a specific defender does to a specific scorer's own normal shot, not a
// league-wide ranking).
const NOTABLE_MATCHUP_MIN_FGA = 5;
const NOTABLE_MATCHUP_MIN_DEVIATION = 15;
function computeNotableMatchups(onlyPlayerId) {
  const cellTotals = {}; // "scorerId|defenderId" -> { fgm, fga }
  state.games.filter(isQualifyingGame).forEach(g => {
    g.scoringEvents.forEach(ev => {
      (ev.defenderIds || []).forEach(defenderId => {
        const key = `${ev.scorerId}|${defenderId}`;
        const cell = cellTotals[key] = cellTotals[key] || { fgm: 0, fga: 0 };
        cell.fga++;
        if (ev.made !== false) cell.fgm++;
      });
    });
  });
  const ownFgById = {};
  computeLeaderboard().filter(r => r.gp > 0).forEach(r => { ownFgById[r.player.id] = pct(r.shooting.fgm, r.shooting.fga); });

  const rows = [];
  Object.entries(cellTotals).forEach(([key, cell]) => {
    if (cell.fga < NOTABLE_MATCHUP_MIN_FGA) return;
    const [scorerId, defenderId] = key.split("|");
    if (onlyPlayerId && scorerId !== onlyPlayerId && defenderId !== onlyPlayerId) return;
    const scorer = state.players.find(p => p.id === scorerId);
    const defender = state.players.find(p => p.id === defenderId);
    const ownFg = ownFgById[scorerId];
    if (!scorer || !defender || ownFg === undefined || ownFg === null) return;
    const fgPct = pct(cell.fgm, cell.fga);
    const deviation = fgPct - ownFg;
    if (Math.abs(deviation) < NOTABLE_MATCHUP_MIN_DEVIATION) return;
    rows.push({ scorer, defender, fgm: cell.fgm, fga: cell.fga, fgPct, ownFgPct: ownFg, deviation });
  });
  rows.sort((a, b) => Math.abs(b.deviation) - Math.abs(a.deviation));
  return rows;
}

function renderNotableMatchups(playerId) {
  const wrap = document.getElementById("playerNotableMatchups");
  if (!wrap) return;
  const rows = computeNotableMatchups(playerId);
  if (rows.length === 0) {
    wrap.innerHTML = `<p class="empty-state">No matchup of theirs yet has both ${NOTABLE_MATCHUP_MIN_FGA}+ attempts and a real (${NOTABLE_MATCHUP_MIN_DEVIATION}+ point) swing from the scorer's own overall FG%.</p>`;
    return;
  }
  wrap.innerHTML = `<ul class="notable-matchups-list">${rows.map(r => {
    const suppressed = r.deviation < 0;
    const icon = suppressed ? "⚠️" : "✅";
    const verb = suppressed ? "is being held to" : "is shooting";
    const compare = suppressed ? "under" : "above";
    const games = gamesForMatchup(r.scorer.id, r.defender.id);
    const watchLinks = watchFilmLinksHtml(games);
    return `<li>
      <span class="player-tip-icon">${icon}</span>
      <span><button type="button" class="icon-btn notable-matchup-player-btn" data-player-id="${r.scorer.id}" style="padding:0;font-weight:700;color:var(--accent)">${escapeHtml(r.scorer.name)}</button> ${verb} ${formatPct(r.fgPct)} against
      <button type="button" class="icon-btn notable-matchup-player-btn" data-player-id="${r.defender.id}" style="padding:0;font-weight:700;color:var(--accent)">${escapeHtml(r.defender.name)}</button>
      (${r.fgm}/${r.fga}), ${Math.abs(r.deviation).toFixed(0)} points ${compare} their own ${formatPct(r.ownFgPct)} overall.${watchLinks}</span>
    </li>`;
  }).join("")}</ul>`;
  wrap.querySelectorAll(".notable-matchup-player-btn").forEach(btn => {
    btn.addEventListener("click", () => openPlayerDetail(btn.dataset.playerId));
  });
  wireWatchFilmButtons(wrap);
}

const H2H_SCORER_COLUMNS = [
  { key: "defender", label: "Defender", accessor: r => r.defender ? r.defender.name : "No defender" },
  { key: "fg", label: "FG", accessor: r => r.fga },
  { key: "fgpct", label: "FG%", accessor: r => pct(r.fgm, r.fga) }
];
let h2hScorerSort = { key: "fg", dir: "desc" };

const H2H_DEFENDER_COLUMNS = [
  { key: "scorer", label: "Scorer", accessor: r => r.scorer ? r.scorer.name : "?" },
  { key: "fg", label: "FG Allowed", accessor: r => r.fga },
  { key: "fgpct", label: "FG% Allowed", accessor: r => pct(r.fgm, r.fga) }
];
let h2hDefenderSort = { key: "fg", dir: "desc" };

function renderHeadToHead(playerId) {
  const scorerHeaderRow = document.getElementById("h2hScorerHeaderRow");
  const scorerBody = document.getElementById("h2hScorerBody");
  renderSortableHeader(scorerHeaderRow, H2H_SCORER_COLUMNS, h2hScorerSort, () => renderHeadToHead(playerId));
  const scorerRows = headToHeadAsScorer(playerId).map(r => ({ ...r, defender: r.defenderId ? state.players.find(p => p.id === r.defenderId) : null }));
  const scorerSortCol = H2H_SCORER_COLUMNS.find(c => c.key === h2hScorerSort.key);
  scorerRows.sort((a, b) => compareForSort(scorerSortCol.accessor(a), scorerSortCol.accessor(b), h2hScorerSort.dir));
  scorerBody.innerHTML = scorerRows.length === 0
    ? '<tr><td colspan="3" class="empty-state">No tagged shots yet.</td></tr>'
    : scorerRows.map(r => `<tr><td>${r.defender ? playerLink(r.defender.id, r.defender.name) : "No defender"}</td><td>${formatShootingSplit(r.fgm, r.fga)}</td><td>${formatPct(pct(r.fgm, r.fga))}</td></tr>`).join("");

  const defenderHeaderRow = document.getElementById("h2hDefenderHeaderRow");
  const defenderBody = document.getElementById("h2hDefenderBody");
  renderSortableHeader(defenderHeaderRow, H2H_DEFENDER_COLUMNS, h2hDefenderSort, () => renderHeadToHead(playerId));
  const defenderRows = headToHeadAsDefender(playerId).map(r => ({ ...r, scorer: state.players.find(p => p.id === r.scorerId) }));
  const defenderSortCol = H2H_DEFENDER_COLUMNS.find(c => c.key === h2hDefenderSort.key);
  defenderRows.sort((a, b) => compareForSort(defenderSortCol.accessor(a), defenderSortCol.accessor(b), h2hDefenderSort.dir));
  defenderBody.innerHTML = defenderRows.length === 0
    ? '<tr><td colspan="3" class="empty-state">No tagged shots yet.</td></tr>'
    : defenderRows.map(r => `<tr><td>${r.scorer ? playerLink(r.scorer.id, r.scorer.name) : "?"}</td><td>${formatShootingSplit(r.fgm, r.fga)}</td><td>${formatPct(pct(r.fgm, r.fga))}</td></tr>`).join("");
}

// ---------- Export ----------
function download(filename, content, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ---------- Backups ----------
// Games logged here live only in this browser's storage, so clearing site data or switching
// browsers loses them. This remembers when the last backup file was saved and how many edits
// have happened since (a per-browser note, not app data), nudges on the Games tab when a backup
// is overdue, and saves one automatically before anything destructive and after each live game.
function readBackupMeta() {
  try { return JSON.parse(localStorage.getItem(BACKUP_META_KEY) || "{}"); } catch (e) { return {}; }
}
function writeBackupMeta(patch) {
  try { localStorage.setItem(BACKUP_META_KEY, JSON.stringify({ ...readBackupMeta(), ...patch })); } catch (e) { /* storage full or blocked */ }
}
function noteEditForBackup() {
  const meta = readBackupMeta();
  writeBackupMeta({ editsSinceBackup: (meta.editsSinceBackup || 0) + 1 });
}
function downloadBackup(filename) {
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
  download(filename || `pool-league-backup-${stamp}.json`, JSON.stringify(state, null, 2), "application/json");
  writeBackupMeta({ lastBackupAt: Date.now(), editsSinceBackup: 0 });
  renderBackupReminder();
}
function autoBackupAfterLiveGame() {
  return readBackupMeta().autoAfterLive !== false;
}

function renderBackupReminder() {
  const el = document.getElementById("backupReminder");
  if (!el) return;
  const meta = readBackupMeta();
  const days = meta.lastBackupAt ? Math.floor((Date.now() - meta.lastBackupAt) / 86400000) : null;
  let text = "";
  if (state.games.length > 0 && days === null) {
    text = "Your games are saved only in this browser. Save a backup file so they're safe if it gets cleared.";
  } else if (days !== null && days >= BACKUP_NUDGE_DAYS && (meta.editsSinceBackup || 0) > 0) {
    text = `Last backup was ${days} days ago, and there have been changes since.`;
  }
  el.hidden = !text;
  el.innerHTML = text ? `💾 ${text} <button type="button" class="secondary-btn" id="backupNowBtn">Save Backup</button>` : "";
  document.getElementById("backupNowBtn")?.addEventListener("click", () => downloadBackup());
}

document.getElementById("exportAllJsonBtn").addEventListener("click", () => downloadBackup("pool-league-data.json"));

// ---- Shot Arc hand-labeling (see shot-arc/FINDINGS.md) ----
// A click-to-label tool for producing fine-tuning data: stock ball detection doesn't find the
// ball on real in-flight shots, so the next real option is fine-tuning a small detector on
// hand-labeled frames from actual games. Point-and-click instead of drawing a precise box per
// frame, since across potentially hundreds of frames a full bounding-box editor would be far
// slower than it needs to be -- the fine-tuning step this feeds can turn a center point plus a
// fixed box size into a real training label on its own.
let labelFrameNames = []; // e.g. ["frame_0001.png", "frame_0002.png", ...]
let labelResults = {}; // filename -> {x, y} (labeled) | "no-ball" | absent (not yet visited)
let labelFrameIndex = 0;
let labelShotKey = "";
let labelNaturalSize = null; // {w, h} of the first loaded frame, assumed constant across the set
// Null means "not set, defaults to the whole clip" -- most shots are already a single clean
// flight and don't need trimming. Set via Mark Shot Start/End once a clip turns out to contain
// more than the shot itself (a pass or dribble before release, a bounce after) -- see
// FINDINGS.md's "multi-touch window" note, caught from a fully-labeled real shot whose trajectory
// swung back and forth across the frame instead of tracing one arc.
let labelShotStartIndex = null;
let labelShotEndIndex = null;

function labelEntryFor(filename) {
  return Object.prototype.hasOwnProperty.call(labelResults, filename) ? labelResults[filename] : undefined;
}

function labelStepSize() {
  return Math.max(1, parseInt(document.getElementById("labelStepSize").value, 10) || 1);
}

// Straight-line fill between two real clicks, for whatever step-size skipped over -- ball motion
// over a gap this short (capped below) is close enough to linear that this beats spending a click
// on every single frame. Only fills between two REAL clicks (not e.g. off the last one to the end
// of the clip, where there's nothing to interpolate toward), and only within [rangeStart,
// rangeEnd] so it never bleeds into frames Mark Shot Start/End excluded. A gap longer than
// LABEL_INTERP_MAX_GAP is left alone rather than trusted -- long gaps are exactly where the ball
// was doing something less predictable (why it went unlabeled that long in the first place).
const LABEL_INTERP_MAX_GAP = 8;
function interpolateLabelFrames(rangeStart, rangeEnd) {
  const filled = {};
  const anchors = [];
  for (let i = rangeStart; i <= rangeEnd; i++) {
    const entry = labelResults[labelFrameNames[i]];
    if (entry && typeof entry === "object") anchors.push({ i, x: entry.x, y: entry.y });
  }
  for (let a = 0; a < anchors.length - 1; a++) {
    const p0 = anchors[a], p1 = anchors[a + 1];
    const gap = p1.i - p0.i;
    if (gap <= 1 || gap > LABEL_INTERP_MAX_GAP) continue;
    for (let i = p0.i + 1; i < p1.i; i++) {
      const name = labelFrameNames[i];
      const existing = labelResults[name];
      if (existing && typeof existing === "object") continue; // a real click already covers it
      const frac = (i - p0.i) / gap;
      filled[name] = {
        x: Math.round((p0.x + (p1.x - p0.x) * frac) * 10) / 10,
        y: Math.round((p0.y + (p1.y - p0.y) * frac) * 10) / 10,
      };
    }
  }
  return filled;
}

function labelFrameUrl(filename) {
  return `shot-arc/frames/${labelShotKey}/${filename}`;
}

function renderLabelFrame() {
  const wrap = document.getElementById("labelFrameWrap");
  const progressEl = document.getElementById("labelProgress");
  if (labelFrameNames.length === 0) {
    wrap.innerHTML = "";
    progressEl.textContent = "";
    return;
  }
  const name = labelFrameNames[labelFrameIndex];
  const entry = labelEntryFor(name);
  const labeledCount = labelFrameNames.filter(n => labelEntryFor(n) !== undefined).length;
  const rangeText = labelShotStartIndex === null && labelShotEndIndex === null
    ? "Shot range: whole clip (not trimmed)."
    : `Shot range: frame ${(labelShotStartIndex ?? 0) + 1} to ${(labelShotEndIndex ?? labelFrameNames.length - 1) + 1}.`;
  progressEl.textContent = `Frame ${labelFrameIndex + 1} of ${labelFrameNames.length} (${name}) -- ${labeledCount} of ${labelFrameNames.length} labeled so far. ${rangeText} Click the ball's center, or use "No ball visible."`;

  wrap.innerHTML = `<img id="labelFrameImg" src="${labelFrameUrl(name)}" style="display:block;max-width:100%;cursor:crosshair" draggable="false">`;
  const img = document.getElementById("labelFrameImg");
  img.addEventListener("load", () => {
    if (!labelNaturalSize) labelNaturalSize = { w: img.naturalWidth, h: img.naturalHeight };
    if (entry && typeof entry === "object") {
      const marker = document.createElement("div");
      const rect = img.getBoundingClientRect();
      const scaleX = rect.width / img.naturalWidth;
      const scaleY = rect.height / img.naturalHeight;
      marker.style.cssText = `position:absolute;left:${entry.x * scaleX - 5}px;top:${entry.y * scaleY - 5}px;width:10px;height:10px;border-radius:50%;background:#ff3b30;border:2px solid #fff;pointer-events:none`;
      wrap.appendChild(marker);
    }
  }, { once: true });
  img.addEventListener("click", e => {
    const rect = img.getBoundingClientRect();
    const scaleX = img.naturalWidth / rect.width;
    const scaleY = img.naturalHeight / rect.height;
    const x = (e.clientX - rect.left) * scaleX;
    const y = (e.clientY - rect.top) * scaleY;
    labelResults[name] = { x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10 };
    advanceLabelFrame(labelStepSize());
  });

  document.getElementById("labelPrevFrameBtn").disabled = labelFrameIndex === 0;
  document.getElementById("labelNextFrameBtn").disabled = labelFrameIndex === labelFrameNames.length - 1;
}

function advanceLabelFrame(delta) {
  const next = labelFrameIndex + delta;
  if (next < 0 || next >= labelFrameNames.length) return;
  labelFrameIndex = next;
  renderLabelFrame();
}

// Populated from shot-arc/labeling-manifest.js (a plain <script>-loaded global, not fetch()'d --
// see index.html's own comment on why: fetch() of a local file hits file:// CORS restrictions
// in Chrome, a <script src> tag doesn't), which extract_frames.py regenerates from whatever's
// actually sitting in shot-arc/frames/ every time it runs. Nothing to upload: picking a shot from
// this list is enough, since the frame images themselves are just loaded by relative path.
function populateLabelShotSelect() {
  const select = document.getElementById("labelShotSelect");
  const manifest = typeof SHOT_ARC_LABEL_MANIFEST !== "undefined" ? SHOT_ARC_LABEL_MANIFEST : null;
  if (!manifest || manifest.length === 0) {
    select.innerHTML = '<option value="">No frames available -- run shot-arc/extract_frames.py first</option>';
    return;
  }
  select.innerHTML = '<option value="">Pick a shot to label…</option>' +
    manifest.map(s => `<option value="${escapeHtml(s.key)}">${escapeHtml(s.key)} (${s.frameCount} frames)</option>`).join("");
}

document.getElementById("labelShotSelect").addEventListener("change", e => {
  const manifest = typeof SHOT_ARC_LABEL_MANIFEST !== "undefined" ? SHOT_ARC_LABEL_MANIFEST : [];
  const entry = manifest.find(s => s.key === e.target.value);
  if (!entry) {
    labelFrameNames = [];
    renderLabelFrame();
    ["labelPrevFrameBtn", "labelNoballBtn", "labelNextFrameBtn", "labelDownloadBtn"].forEach(id => {
      document.getElementById(id).disabled = true;
    });
    return;
  }
  labelShotKey = entry.key;
  labelFrameNames = Array.from({ length: entry.frameCount }, (_, i) => `frame_${String(i + 1).padStart(4, "0")}.png`);
  labelResults = {};
  labelFrameIndex = 0;
  labelNaturalSize = null;
  labelShotStartIndex = null;
  labelShotEndIndex = null;

  ["labelPrevFrameBtn", "labelNoballBtn", "labelNextFrameBtn", "labelDownloadBtn", "labelMarkStartBtn", "labelMarkEndBtn", "labelExcludeBtn"].forEach(id => {
    document.getElementById(id).disabled = false;
  });
  renderLabelFrame();
});

populateLabelShotSelect();

document.getElementById("labelPrevFrameBtn").addEventListener("click", () => advanceLabelFrame(-1));
document.getElementById("labelNextFrameBtn").addEventListener("click", () => advanceLabelFrame(1));
document.getElementById("labelNoballBtn").addEventListener("click", () => {
  if (labelFrameNames.length === 0) return;
  labelResults[labelFrameNames[labelFrameIndex]] = "no-ball";
  advanceLabelFrame(labelStepSize());
});
document.getElementById("labelMarkStartBtn").addEventListener("click", () => {
  if (labelFrameNames.length === 0) return;
  labelShotStartIndex = labelFrameIndex;
  renderLabelFrame();
});
document.getElementById("labelMarkEndBtn").addEventListener("click", () => {
  if (labelFrameNames.length === 0) return;
  labelShotEndIndex = labelFrameIndex;
  renderLabelFrame();
});
document.getElementById("labelExcludeBtn").addEventListener("click", () => {
  if (!labelShotKey) return;
  const reason = prompt('Why exclude this shot? (e.g. "dunk", "multiple plays")', "dunk") || "unspecified";
  download(`${labelShotKey}-excluded.json`, JSON.stringify({ shotKey: labelShotKey, excluded: true, reason }, null, 2), "application/json");
});
document.addEventListener("keydown", e => {
  if (labelFrameNames.length === 0) return;
  if (e.code !== "Space") return;
  const active = document.activeElement;
  if (active && (active.tagName === "INPUT" || active.tagName === "TEXTAREA" || active.tagName === "SELECT" || active.isContentEditable)) return;
  if (!document.getElementById("tab-export").classList.contains("active")) return;
  e.preventDefault();
  document.getElementById("labelNoballBtn").click();
});

document.getElementById("labelDownloadBtn").addEventListener("click", () => {
  if (labelFrameNames.length === 0) return;
  const rangeStart = labelShotStartIndex ?? 0;
  const rangeEnd = labelShotEndIndex ?? (labelFrameNames.length - 1);
  const interpolated = interpolateLabelFrames(rangeStart, rangeEnd);
  const output = {
    shotKey: labelShotKey,
    frameWidth: labelNaturalSize ? labelNaturalSize.w : null,
    frameHeight: labelNaturalSize ? labelNaturalSize.h : null,
    shotStartFrame: rangeStart + 1, // 1-indexed to match frame_0001.png naming
    shotEndFrame: rangeEnd + 1,
    frames: labelFrameNames.map((name, i) => {
      const inRange = i >= rangeStart && i <= rangeEnd;
      if (!inRange) return { filename: name, status: "outside-shot" };
      const entry = labelEntryFor(name);
      if (entry === undefined) {
        return interpolated[name]
          ? { filename: name, status: "interpolated", x: interpolated[name].x, y: interpolated[name].y }
          : { filename: name, status: "unlabeled" };
      }
      if (entry === "no-ball") {
        return interpolated[name]
          ? { filename: name, status: "interpolated", x: interpolated[name].x, y: interpolated[name].y }
          : { filename: name, status: "no-ball" };
      }
      return { filename: name, status: "labeled", x: entry.x, y: entry.y };
    }),
  };
  download(`${labelShotKey}-labels.json`, JSON.stringify(output, null, 2), "application/json");
});

function csvEscape(val) {
  const s = String(val ?? "");
  if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

document.getElementById("exportBoxScoreCsvBtn").addEventListener("click", () => {
  const rows = [["game_id", "date", "team", "player", ...STAT_FIELDS,
    "fgm", "fga", "tpm", "tpa", "close_m", "close_a", "mid_m", "mid_a", "tp_arc_m", "tp_arc_a", "tp_deep_m", "tp_deep_a", "ftm", "fta", "efg_pct", "ts_pct", "stocks", "ast_tov",
    "pts_allowed", "opp_fg_pct", "times_beaten", "stops", "off_rating", "two_way_score"]];
  state.games.forEach(game => {
    game.stats.forEach(s => {
      const player = state.players.find(p => p.id === s.playerId);
      if (!player) return;
      const teamLabel = game.teamA.includes(s.playerId) ? "A" : game.teamB.includes(s.playerId) ? "B" : "";
      const sh = shootingStats(game, s.playerId);
      const def = gameDefenseStats(game, s.playerId);
      rows.push([
        game.id, game.date, teamLabel, player.name, ...STAT_FIELDS.map(f => s[f]),
        sh.fgm, sh.fga, sh.tpm, sh.tpa, sh.closeM, sh.closeA, sh.midM, sh.midA, sh.tpArcM, sh.tpArcA, sh.tpDeepM, sh.tpDeepA, sh.ftm, sh.fta,
        effectiveFgPct(sh.fgm, sh.tpm, sh.fga), trueShootingPct(s.pts, sh.fga, sh.fta),
        s.stl + s.blk, formatAstTov(s.ast, s.tov),
        def.ptsAllowed, def.oppFgPct, def.timesBeaten, def.stops, offensiveRating(s, sh).toFixed(1), twoWayScore(s, sh, def).toFixed(1)
      ]);
    });
  });
  download("box-scores.csv", rows.map(r => r.map(csvEscape).join(",")).join("\n"), "text/csv");
});

// Seconds + mm:ss, matching how the Highlight Reel CSV represents timestamps — "" (not 0)
// when there's no timestamp, so it's not mistaken for an actual time at 0:00.
function videoTimeCsv(videoTime) {
  return videoTime === null || videoTime === undefined ? ["", ""] : [videoTime.toFixed(1), formatTime(videoTime)];
}

document.getElementById("exportScoringLogCsvBtn").addEventListener("click", () => {
  const rows = [["game_id", "date", "shooter", "made", "points", "assist", "defenders", "blocked_by", "out_of_bounds_turnover", "rebounded_by", "rebound_type", "shot_x", "shot_y", "shot_band", "video_time_seconds", "video_time_mmss"]];
  state.games.forEach(game => {
    game.scoringEvents.forEach(ev => {
      const scorer = state.players.find(p => p.id === ev.scorerId);
      const assister = ev.assistId ? state.players.find(p => p.id === ev.assistId) : null;
      const blocker = ev.blockerId ? state.players.find(p => p.id === ev.blockerId) : null;
      const rebounder = ev.rebounderId ? state.players.find(p => p.id === ev.rebounderId) : null;
      const reboundType = rebounder ? (sameTeam(game, ev.scorerId, rebounder.id) ? "OREB" : "DREB") : "";
      const bandLabels = { close: "close", mid: "midrange", arc: "line", deep: "deep" };
      const band = ev.shotLocation && (ev.points === 2 || ev.points === 3) ? bandLabels[shotBand(ev.shotLocation, ev.points)] : "";
      rows.push([game.id, game.date, scorer ? scorer.name : "", ev.made !== false, ev.points, assister ? assister.name : "", defenderNames(ev.defenderIds), blocker ? blocker.name : "", !!ev.turnoverEventId, rebounder ? rebounder.name : "", reboundType, ev.shotLocation ? ev.shotLocation.x.toFixed(1) : "", ev.shotLocation ? ev.shotLocation.y.toFixed(1) : "", band, ...videoTimeCsv(ev.videoTime)]);
    });
  });
  download("shot-log.csv", rows.map(r => r.map(csvEscape).join(",")).join("\n"), "text/csv");
});

// Just the shots with a marked location — a focused subset of the Shot Log CSV, for handing
// Adam exactly what a shot chart needs without him having to filter out the unmapped rows
// (shot_x/shot_y are never blank here, unlike shot-log.csv).
document.getElementById("exportShotLocationsCsvBtn").addEventListener("click", () => {
  const rows = [["game_id", "date", "player", "team", "made", "points", "shot_x", "shot_y", "video_time_seconds", "video_time_mmss"]];
  state.games.forEach(game => {
    game.scoringEvents.filter(ev => ev.shotLocation).forEach(ev => {
      const scorer = state.players.find(p => p.id === ev.scorerId);
      const team = game.teamA.includes(ev.scorerId) ? "A" : game.teamB.includes(ev.scorerId) ? "B" : "";
      rows.push([game.id, game.date, scorer ? scorer.name : "", team, ev.made !== false, ev.points, ev.shotLocation.x.toFixed(1), ev.shotLocation.y.toFixed(1), ...videoTimeCsv(ev.videoTime)]);
    });
  });
  download("shot-locations.csv", rows.map(r => r.map(csvEscape).join(",")).join("\n"), "text/csv");
});

document.getElementById("exportOtherEventsCsvBtn").addEventListener("click", () => {
  const rows = [["game_id", "date", "type", "player", "opponent", "via_steal", "video_time_seconds", "video_time_mmss"]];
  state.games.forEach(game => {
    TAGGED_STAT_CONFIG.forEach(cfg => {
      game[cfg.eventsKey].forEach(ev => {
        const player = state.players.find(p => p.id === ev.playerId);
        const opponent = ev.opponentId ? state.players.find(p => p.id === ev.opponentId) : null;
        const viaSteal = cfg.field === "tov" && !!ev.stealEventId;
        rows.push([game.id, game.date, cfg.verb, player ? player.name : "", opponent ? opponent.name : "", viaSteal, ...videoTimeCsv(ev.videoTime)]);
      });
    });
  });
  download("other-events.csv", rows.map(r => r.map(csvEscape).join(",")).join("\n"), "text/csv");
});

document.getElementById("exportMatchupCsvBtn").addEventListener("click", () => {
  const rows = [["game_id", "date", "defender", "guarded_offender", "note", "video_time_seconds", "video_time_mmss"]];
  state.games.forEach(game => {
    game.matchups.forEach(m => {
      const defender = state.players.find(p => p.id === m.defenderId);
      const offender = state.players.find(p => p.id === m.offenderId);
      rows.push([game.id, game.date, defender ? defender.name : "", offender ? offender.name : "", m.note || "", ...videoTimeCsv(m.videoTime)]);
    });
  });
  download("matchups.csv", rows.map(r => r.map(csvEscape).join(",")).join("\n"), "text/csv");
});

document.getElementById("exportLeaderboardCsvBtn").addEventListener("click", () => {
  const rows = [["player", "games_played", ...STAT_FIELDS,
    "fgm", "fga", "tpm", "tpa", "close_m", "close_a", "mid_m", "mid_a", "tp_arc_m", "tp_arc_a", "tp_deep_m", "tp_deep_a", "ftm", "fta", "shot_pct", "ast_pct", "oreb_pct", "dreb_pct", "treb_pct", "tov_pct", "efg_pct", "ts_pct", "stocks", "ast_tov",
    "pts_allowed", "opp_fg_pct", "times_beaten", "stops", "pts_per_20", "off_rating_per_20", "def_rating_per_20", "two_way_per_20"]];
  computeLeaderboard().forEach(r => {
    rows.push([
      r.player.name, r.gp, ...STAT_FIELDS.map(f => r.totals[f]),
      r.shooting.fgm, r.shooting.fga, r.shooting.tpm, r.shooting.tpa, r.shooting.closeM, r.shooting.closeA, r.shooting.midM, r.shooting.midA, r.shooting.tpArcM, r.shooting.tpArcA, r.shooting.tpDeepM, r.shooting.tpDeepA, r.shooting.ftm, r.shooting.fta,
      r.shotPct, r.astPct, r.orebPct, r.drebPct, r.trebPct, r.tovPct, effectiveFgPct(r.shooting.fgm, r.shooting.tpm, r.shooting.fga), trueShootingPct(r.totals.pts, r.shooting.fga, r.shooting.fta),
      r.stocks, r.astTov, r.defense.ptsAllowed,
      pct(r.defense.timesBeaten, r.defense.timesBeaten + r.defense.stops),
      r.defense.timesBeaten, r.defense.stops, r.rate.pts.toFixed(1), r.offRatingPer20.toFixed(1),
      defensiveRating(r.rate, r.rateDefense).toFixed(1), r.twoWayPer20.toFixed(1)
    ]);
  });
  download("leaderboard.csv", rows.map(r => r.map(csvEscape).join(",")).join("\n"), "text/csv");
});

document.getElementById("exportAssistSynergyCsvBtn").addEventListener("click", () => {
  const rows = [["passer", "scorer", "assists"]];
  computeAssistConnections().forEach(r => {
    rows.push([r.passer.name, r.scorer.name, r.count]);
  });
  download("assist-connections.csv", rows.map(r => r.map(csvEscape).join(",")).join("\n"), "text/csv");
});

document.getElementById("exportTeammateSynergyCsvBtn").addEventListener("click", () => {
  const rows = [["player", "teammate", "gp_with", "gp_without", "off_rating_per20_with", "off_rating_per20_without", "two_way_per20_with", "two_way_per20_without"]];
  state.players.forEach(p => {
    computeTeammateSynergy(p.id).forEach(r => {
      rows.push([
        p.name, r.teammate.name, r.with.gp, r.without.gp,
        r.with.gp > 0 ? r.with.offRatingPer20.toFixed(1) : "",
        r.without.gp > 0 ? r.without.offRatingPer20.toFixed(1) : "",
        r.with.gp > 0 ? r.with.twoWayPer20.toFixed(1) : "",
        r.without.gp > 0 ? r.without.twoWayPer20.toFixed(1) : ""
      ]);
    });
  });
  download("teammate-synergy.csv", rows.map(r => r.map(csvEscape).join(",")).join("\n"), "text/csv");
});

document.getElementById("exportOutOfBoundsCsvBtn").addEventListener("click", () => {
  const rows = [["player", "misses", "out_of_bounds", "oob_pct"]];
  computeOutOfBoundsStats().forEach(r => {
    rows.push([r.player.name, r.misses, r.oob, pct(r.oob, r.misses) ?? ""]);
  });
  download("out-of-bounds.csv", rows.map(r => r.map(csvEscape).join(",")).join("\n"), "text/csv");
});

document.getElementById("exportReelCsvBtn").addEventListener("click", () => {
  const rows = [["game_id", "date", "type", "start_seconds", "start_mmss", "end_seconds", "end_mmss", "player", "note"]];
  state.games.forEach(game => {
    (game.plays || []).forEach(play => {
      const player = play.playerId ? state.players.find(p => p.id === play.playerId) : null;
      rows.push([
        game.id, game.date, play.type,
        play.start.toFixed(1), formatTime(play.start),
        play.end.toFixed(1), formatTime(play.end),
        player ? player.name : "", play.note || ""
      ]);
    });
  });
  download("highlight-reel.csv", rows.map(r => r.map(csvEscape).join(",")).join("\n"), "text/csv");
});

function renderExportGameSelect() {
  const sel = document.getElementById("exportGameSelect");
  sel.innerHTML = [...state.games].sort((x, y) => (x.date || "").localeCompare(y.date || ""))
    .map(g => `<option value="${g.id}">${formatDateDisplay(g.date)} (${g.teamA.length + g.teamB.length} players)</option>`).join("");
}

document.getElementById("exportGameJsonBtn").addEventListener("click", () => {
  const gameId = document.getElementById("exportGameSelect").value;
  const game = state.games.find(g => g.id === gameId);
  if (!game) return;
  // A single-game export has no sibling `masterVideos` array to resolve `masterVideoId`
  // against (unlike the full "export all data" dump, where it's a top-level array) — without
  // this, fileName never actually reaches anyone reading just this one file.
  const masterVideo = game.masterVideoId ? (state.masterVideos.find(m => m.id === game.masterVideoId) || null) : null;
  download(`game-${gameId}.json`, JSON.stringify({ ...game, masterVideo }, null, 2), "application/json");
});

// Loads whatever video a game actually has (session video, local file, or a direct link — not
// YouTube, which can't be seeked programmatically) into the given wrap, independent of
// currentGameId/currentVideoEl so it doesn't disturb Stat Entry's own video state. Shares the
// same blob URL caches as the main flow, so a game already opened this session loads instantly
// instead of re-reading IndexedDB.
async function loadBackfillVideo(game, videoWrap) {
  let url = null;
  if (game.masterVideoId) {
    url = masterVideoBlobUrls[game.masterVideoId];
    if (!url) {
      const file = await getVideoFile(game.masterVideoId);
      if (file) { url = URL.createObjectURL(file); masterVideoBlobUrls[game.masterVideoId] = url; }
    }
  } else {
    url = localVideoBlobUrls[game.id];
    if (!url) {
      const file = await getVideoFile(game.id);
      if (file) { url = URL.createObjectURL(file); localVideoBlobUrls[game.id] = url; }
    }
  }
  if (!url && game.videoUrl && /\.(mp4|webm|ogg|mov)(\?.*)?$/i.test(game.videoUrl)) url = game.videoUrl;
  if (!videoWrap.isConnected) return; // panel moved on before this resolved — nothing to update
  if (url) {
    videoWrap.innerHTML = `<video controls class="backfill-video"></video>`;
    videoWrap.querySelector("video").src = url;
  } else {
    videoWrap.innerHTML = '<p class="hint" style="margin:0">No video available for this game. Mark from memory, or open it directly in Stat Entry.</p>';
  }
}

let backfillUndoTimer = null;

// A few seconds' grace to fix a misclick without hunting back through the list for it —
// clicking Undo puts the shot right back to whatever it was before this click (null if it was
// unmarked, or its previous spot if you were correcting an already-marked one).
function showBackfillUndoToast(playerName, game, eventId, previousLocation) {
  const toast = document.getElementById("backfillUndoToast");
  if (!toast) return;
  clearTimeout(backfillUndoTimer);
  toast.innerHTML = `<span class="hint" style="margin:0">Location set for ${escapeHtml(playerName)}'s shot.</span> <button type="button" class="icon-btn" data-undo-location="1">Undo</button>`;
  toast.querySelector("[data-undo-location]").addEventListener("click", () => {
    const ev = game.scoringEvents.find(e => e.id === eventId);
    if (ev) ev.shotLocation = previousLocation;
    saveState();
    clearTimeout(backfillUndoTimer);
    renderBackfillShotLocations();
  });
  backfillUndoTimer = setTimeout(() => { toast.innerHTML = ""; }, 8000);
}

function setShotChartDot(svgEl, location) {
  const existing = svgEl.querySelector(".shot-chart-dot");
  if (existing) existing.remove();
  if (!location) return;
  const dot = document.createElementNS("http://www.w3.org/2000/svg", "circle");
  dot.setAttribute("cx", shotChartVbX(location.x));
  dot.setAttribute("cy", shotChartVbY(location.y));
  dot.setAttribute("r", "4");
  dot.setAttribute("class", "shot-chart-dot");
  svgEl.appendChild(dot);
}

// Off by default so the list only shows what's actually missing — the satisfying "clear the
// list" case. Toggling it on reveals already-marked shots too (with their dot shown), for
// fixing a mistaken spot without needing to remember which specific shot it was.
let backfillShowMarked = false;

// Backfilling shot locations for games logged before the shot chart existed — grouped by game,
// each group with its own video (loaded once, reused for every shot in that game) so a shot can
// actually be placed correctly instead of guessed at from memory. In the default (missing-only)
// view, a click removes just that one row from the DOM rather than re-rendering the whole
// panel, so every other group's video keeps playing undisturbed — the same reason the main
// video panel avoids tearing its <video> down on every re-render. With "show already-marked"
// on, a click instead redraws that row's dot in place, since the row needs to stay visible
// either way. Undo always does a full re-render, since it's rare enough that losing another
// group's playback position is an acceptable trade for simpler code.
// Close/midrange 2PT field goals with no `dunk` field at all (undefined) -- everything logged
// before that field existed. Once reviewed, dunk is explicitly true or false, so it drops off
// this list either way; nothing new ever needs review again once the Stat Entry toggle is in use.
function computeUnresolvedDunkCandidates() {
  const rows = [];
  state.games.forEach(game => {
    game.scoringEvents.forEach(ev => {
      if (ev.points !== 2 || ev.dunk !== undefined || !ev.shotLocation) return;
      const band = shotBand(ev.shotLocation, ev.points);
      if (band !== "close" && band !== "mid") return;
      rows.push({ game, ev });
    });
  });
  return rows.sort((a, b) => (a.game.date || "").localeCompare(b.game.date || ""));
}

// Resolving one row only ever removes that one <li> rather than re-rendering the whole panel --
// same reason Backfill Shot Locations avoids a full re-render per click: the inline video player
// (see ensureInlineVideoPlayer/loadInlineVideo above) lives in this same wrap, and a full
// innerHTML rebuild would tear it down and stop playback every time a DIFFERENT row got resolved
// while a clip was open.
function renderDunkReview() {
  const wrap = document.getElementById("dunkReview");
  if (!wrap) return;
  const rows = computeUnresolvedDunkCandidates();
  if (rows.length === 0) {
    wrap.innerHTML = '<p class="empty-state">Every close/midrange field goal has been reviewed for dunks.</p>';
    return;
  }
  wrap.innerHTML = `<p class="hint dunk-review-summary" style="margin-top:0">${rows.length} close/midrange field goal${rows.length === 1 ? "" : "s"} still unreviewed.</p>
  <ul class="player-tips-list">${rows.map(({ game, ev }) => {
    const scorer = state.players.find(p => p.id === ev.scorerId);
    const hasTime = ev.videoTime !== null && ev.videoTime !== undefined;
    const watchLinks = watchFilmLinksHtml(hasTime ? [{ id: game.id, date: game.date, videoTime: ev.videoTime }] : []);
    return `<li data-event-id="${ev.id}">
      <span>${scorer ? playerLink(scorer.id, scorer.name) : "?"}: ${ev.made !== false ? "Make" : "Miss"} (${ev.points}pt, ${escapeHtml(formatDateDisplay(game.date))})${watchLinks}</span>
      <div class="button-row" style="margin-top:4px">
        <button type="button" class="secondary-btn" data-mark-dunk="${ev.id}">🏀 Dunk</button>
        <button type="button" class="secondary-btn" data-mark-notdunk="${ev.id}">Not a dunk</button>
      </div>
    </li>`;
  }).join("")}</ul>`;
  wireWatchFilmButtons(wrap);

  const summaryEl = wrap.querySelector(".dunk-review-summary");
  const listEl = wrap.querySelector("ul");
  const resolveRow = (eventId, value) => {
    const ev = state.games.flatMap(g => g.scoringEvents).find(e => e.id === eventId);
    if (!ev) return;
    ev.dunk = value;
    saveState();
    listEl.querySelector(`li[data-event-id="${eventId}"]`)?.remove();
    const left = listEl.querySelectorAll("li").length;
    if (left === 0) {
      listEl.remove();
      summaryEl.textContent = "";
      if (!wrap.querySelector(".dunk-review-done-msg")) {
        const doneMsg = document.createElement("p");
        doneMsg.className = "empty-state dunk-review-done-msg";
        doneMsg.textContent = "Every close/midrange field goal has been reviewed for dunks.";
        wrap.appendChild(doneMsg);
      }
    } else {
      summaryEl.textContent = `${left} close/midrange field goal${left === 1 ? "" : "s"} still unreviewed.`;
    }
  };
  wrap.querySelectorAll("[data-mark-dunk]").forEach(btn => {
    btn.addEventListener("click", () => resolveRow(btn.dataset.markDunk, true));
  });
  wrap.querySelectorAll("[data-mark-notdunk]").forEach(btn => {
    btn.addEventListener("click", () => resolveRow(btn.dataset.markNotdunk, false));
  });
}

// ---------- Shot Type Tagging (see poolean-player-development-spec.md) ----------
// How the possession got the shooter to the spot: a catch-and-shoot and a shot off a drive are
// different skills that look identical in the location/make/miss data. Four types, kept small so
// tagging stays fast. Stored as ev.shotType (null = not tagged); tagged in Stat Entry as a shot is
// logged, or afterward in Shot Log's Edit flow and Export's Review Shot Types.
const SHOT_TYPES = [
  { key: "catchAndShoot", label: "Catch-and-shoot", cssClass: "shot-seg-type-cs", about: "Received the ball and shot without a dribble move or drive first." },
  { key: "deepHeave", label: "Deep heave", cssClass: "shot-seg-type-heave", about: "A long attempt taken right off a checked-in ball or a rebound, before the defense sets up." },
  { key: "drive", label: "Drive", cssClass: "shot-seg-type-drive", about: "Put the ball on the floor and attacked toward the basket before shooting, whether or not it ended at the rim." },
  { key: "move", label: "Move", cssClass: "shot-seg-type-move", about: "A shot after a specific move without a full drive: a spin, a hesitation, a pump fake, and so on." },
  // Not tagged by hand: any shot marked as a dunk lands here automatically (see effShotType).
  { key: "dunk", label: "Dunk", cssClass: "shot-seg-type-dunk", about: "Any shot marked as a dunk. Set automatically, not tagged.", auto: true }
];
const TAGGABLE_SHOT_TYPES = SHOT_TYPES.filter(t => !t.auto);

// The type a shot counts under: a dunk is its own category whatever was tagged, otherwise the
// tagged type (null = not tagged yet). A type already tagged on a dunk stays saved but is ignored.
function effShotType(ev) {
  return ev.dunk === true ? "dunk" : (ev.shotType || null);
}
const SHOT_TYPE_MIN_ATTEMPTS = 5;      // tagged attempts of one type before its efficiency shows
const SHOT_TYPE_DEEP_CHECK_MIN = 10;   // tagged deep attempts before the league deep-shot split shows

function shotTypeLabel(key) {
  const t = SHOT_TYPES.find(s => s.key === key);
  return t ? t.label : "";
}

// One row of buttons per picker; `attr` is the data attribute the caller wires its click handler to.
function shotTypeButtonsHtml(current, attr) {
  return TAGGABLE_SHOT_TYPES.map(t => `<button type="button" class="secondary-btn${current === t.key ? " selected" : ""}" data-${attr}="${t.key}" title="${escapeHtml(t.about)}">${escapeHtml(t.label)}</button>`).join("");
}

function computeShotTypeStats() {
  const blank = () => ({ tagged: 0, fga: 0, types: Object.fromEntries(SHOT_TYPES.map(t => [t.key, { a: 0, m: 0, pts: 0 }])) });
  const league = blank();
  const byPlayer = {};
  state.games.filter(isQualifyingGame).forEach(game => {
    game.scoringEvents.forEach(ev => {
      if (ev.points !== 2 && ev.points !== 3) return;
      const p = byPlayer[ev.scorerId] = byPlayer[ev.scorerId] || blank();
      [p, league].forEach(t => {
        t.fga++;
        const b = effShotType(ev) ? t.types[effShotType(ev)] : null;
        if (!b) return;
        t.tagged++;
        b.a++;
        if (ev.made !== false) { b.m++; b.pts += ev.points; }
      });
    });
  });
  const rows = Object.entries(byPlayer)
    .map(([playerId, v]) => ({ player: state.players.find(pl => pl.id === playerId), ...v }))
    .filter(r => r.player && r.tagged > 0)
    .sort((a, b) => b.tagged - a.tagged);
  return { rows, league };
}

function shotTypeCellHtml(b, tagged) {
  if (b.a === 0) return "<td>—</td>";
  const share = tagged > 0 ? Math.round((b.a / tagged) * 100) : 0;
  if (b.a < SHOT_TYPE_MIN_ATTEMPTS) return `<td>—<br><span class="hint" style="margin:0">${b.a} shot${b.a === 1 ? "" : "s"}, too few</span></td>`;
  return `<td>${Math.round((b.pts / (2 * b.a)) * 100)}% TS<br><span class="hint" style="margin:0">${b.m}/${b.a} · ${share}% of shots</span></td>`;
}

function renderShotTypePanel() {
  const wrap = document.getElementById("shotTypePanel");
  if (!wrap) return;
  const { rows, league } = computeShotTypeStats();
  if (league.tagged === 0) {
    wrap.innerHTML = '<p class="empty-state">No shots have a type yet. Tag new shots as they are logged in Stat Entry, or go through the older ones in Export, Review Shot Types.</p>';
    return;
  }
  const legend = SHOT_TYPES.map(t => `<span class="legend-item"><span class="legend-swatch ${t.cssClass}"></span>${escapeHtml(t.label)}</span>`).join("");
  const rowHtml = (name, r) => {
    const mix = SHOT_TYPES.map(t => {
      const a = r.types[t.key].a;
      return a === 0 ? "" : `<div class="shot-seg ${t.cssClass}" style="width:${(a / r.tagged) * 100}%" title="${escapeHtml(name)}: ${a} ${escapeHtml(t.label)}"></div>`;
    }).join("");
    return `<tr><td>${escapeHtml(name)}</td>${SHOT_TYPES.map(t => shotTypeCellHtml(r.types[t.key], r.tagged)).join("")}<td>${r.tagged} of ${r.fga}</td><td><div class="shot-selection-bar">${mix}</div></td></tr>`;
  };
  wrap.innerHTML = `
    <div class="shot-selection-legend">${legend}</div>
    <div class="table-scroll">
      <table class="matchup-table">
        <thead><tr><th>Player</th>${SHOT_TYPES.map(t => `<th>${escapeHtml(t.label)}</th>`).join("")}<th>Tagged</th><th>Mix</th></tr></thead>
        <tbody>${rowHtml("League", league)}${rows.map(r => rowHtml(r.player.name, r)).join("")}</tbody>
      </table>
    </div>`;
}

// Of the league's 3PT attempts in the Deep zone, how many were the rushed heave off a check or
// rebound versus a deep shot taken some other way, and how each went.
function renderDeepShotCheckPanel() {
  const wrap = document.getElementById("deepShotCheckPanel");
  if (!wrap) return;
  const counts = Object.fromEntries(SHOT_TYPES.map(t => [t.key, { a: 0, m: 0 }]));
  let deepTotal = 0, tagged = 0;
  state.games.filter(isQualifyingGame).forEach(game => {
    game.scoringEvents.forEach(ev => {
      if (ev.points !== 3 || !ev.shotLocation || shotBand(ev.shotLocation, 3) !== "deep") return;
      deepTotal++;
      const b = effShotType(ev) ? counts[effShotType(ev)] : null;
      if (!b) return;
      tagged++;
      b.a++;
      if (ev.made !== false) b.m++;
    });
  });
  if (tagged < SHOT_TYPE_DEEP_CHECK_MIN) {
    wrap.innerHTML = `<p class="empty-state">${tagged} of ${deepTotal} deep 3-pointers have a shot type so far. This needs ${SHOT_TYPE_DEEP_CHECK_MIN} to show a split.</p>`;
    return;
  }
  const heave = counts.deepHeave;
  const otherA = tagged - heave.a, otherM = SHOT_TYPES.reduce((s, t) => s + (t.key === "deepHeave" ? 0 : counts[t.key].m), 0);
  const p = (m, a) => a > 0 ? `${m}/${a} (${Math.round((m / a) * 100)}%)` : "no shots";
  const rows = TAGGABLE_SHOT_TYPES.map(t => {
    const b = counts[t.key];
    return `<tr><td>${escapeHtml(t.label)}</td><td>${b.a}</td><td>${Math.round((b.a / tagged) * 100)}%</td><td>${b.a > 0 ? Math.round((b.m / b.a) * 100) + "%" : "—"}</td></tr>`;
  }).join("");
  wrap.innerHTML = `
    <p class="hint" style="margin-top:0">${tagged} of ${deepTotal} deep 3-pointers are tagged. <strong>${heave.a}</strong> (${Math.round((heave.a / tagged) * 100)}%) were deep heaves off a check or rebound. Those went ${p(heave.m, heave.a)}, against ${p(otherM, otherA)} for deep shots taken any other way.</p>
    <div class="table-scroll">
      <table class="matchup-table">
        <thead><tr><th>Shot type</th><th>Deep attempts</th><th>Share of tagged</th><th>FG%</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

// ---------- Shot type panels: open vs. contested, and "is the Move working?" ----------
// Same tagged shots as the Shot Type Efficiency panel, cut two more ways. A percentage only shows
// once a cell has SHOT_TYPE_MIN_ATTEMPTS attempts; below that the raw makes/attempts still show so
// the volume is visible without pretending a 2-shot percentage means something.
function shotTypeFgCell(m, a) {
  if (a === 0) return "<td>—</td>";
  if (a < SHOT_TYPE_MIN_ATTEMPTS) return `<td>${m}/${a}<br><span class="hint" style="margin:0">too few</span></td>`;
  return `<td>${Math.round((m / a) * 100)}%<br><span class="hint" style="margin:0">${m}/${a}</span></td>`;
}

function computeShotTypeCuts() {
  const contest = {};
  SHOT_TYPES.forEach(t => { contest[t.key] = { open: { a: 0, m: 0 }, contested: { a: 0, m: 0 } }; });
  // Catch-and-shoot again, but within each distance zone, so open vs. guarded is compared at the
  // same range instead of open shots (usually the longer ones) against guarded ones.
  const byZone = {};
  ["close", "mid", "arc", "deep"].forEach(z => { byZone[z] = { open: { a: 0, m: 0 }, contested: { a: 0, m: 0 } }; });
  state.games.filter(isQualifyingGame).forEach(game => {
    game.scoringEvents.forEach(ev => {
      const type = effShotType(ev);
      if ((ev.points !== 2 && ev.points !== 3) || !type || !contest[type]) return;
      const side = (ev.defenderIds || []).length > 0 ? "contested" : "open";
      const c = contest[type][side];
      c.a++;
      if (ev.made !== false) c.m++;
      if (type === "catchAndShoot" && ev.shotLocation) {
        const z = byZone[shotBand(ev.shotLocation, ev.points)];
        if (z) { z[side].a++; if (ev.made !== false) z[side].m++; }
      }
    });
  });
  return { contest, byZone };
}

// The shot type panels follow the same "Include Imbalanced Games" / "Include Past Seasons" switches
// as everything else on this page, so tagged shots from a game those leave out don't show. Say so,
// with the count, instead of the panel silently showing fewer shots than were tagged.
function appendShotTypeExclusionNote(panelIds) {
  let left = 0;
  state.games.forEach(game => {
    if (isQualifyingGame(game)) return;
    game.scoringEvents.forEach(ev => { if ((ev.points === 2 || ev.points === 3) && effShotType(ev)) left++; });
  });
  if (left === 0) return;
  panelIds.forEach(id => {
    const wrap = document.getElementById(id);
    if (wrap) wrap.insertAdjacentHTML("beforeend", `<p class="hint" style="margin:8px 0 0">${left} more tagged shot${left === 1 ? " is" : "s are"} in games left out by the Include Imbalanced Games and Include Past Seasons switches at the top of the Leaderboard. Turn them on to count ${left === 1 ? "it" : "them"}.</p>`);
  });
}

function renderShotTypeContestPanel() {
  const wrap = document.getElementById("shotTypeContestPanel");
  if (!wrap) return;
  const { contest, byZone } = computeShotTypeCuts();
  const total = SHOT_TYPES.reduce((s, t) => s + contest[t.key].open.a + contest[t.key].contested.a, 0);
  if (total === 0) {
    wrap.innerHTML = '<p class="empty-state">No tagged shots yet.</p>';
    return;
  }
  const rows = SHOT_TYPES.map(t => {
    const o = contest[t.key].open, c = contest[t.key].contested;
    const gap = o.a >= SHOT_TYPE_MIN_ATTEMPTS && c.a >= SHOT_TYPE_MIN_ATTEMPTS
      ? `${Math.round((o.m / o.a - c.m / c.a) * 100) > 0 ? "+" : ""}${Math.round((o.m / o.a - c.m / c.a) * 100)} pts`
      : "—";
    return `<tr><td>${escapeHtml(t.label)}</td>${shotTypeFgCell(o.m, o.a)}${shotTypeFgCell(c.m, c.a)}<td>${gap}</td></tr>`;
  }).join("");
  const zoneLabels = { close: "Close", mid: "Midrange", arc: "3PT Line", deep: "3PT Deep" };
  const zoneRows = Object.keys(zoneLabels).map(z => {
    const o = byZone[z].open, c = byZone[z].contested;
    const gap = o.a >= SHOT_TYPE_MIN_ATTEMPTS && c.a >= SHOT_TYPE_MIN_ATTEMPTS ? `${Math.round((o.m / o.a - c.m / c.a) * 100) > 0 ? "+" : ""}${Math.round((o.m / o.a - c.m / c.a) * 100)} pts` : "—";
    return `<tr><td>${zoneLabels[z]}</td>${shotTypeFgCell(o.m, o.a)}${shotTypeFgCell(c.m, c.a)}<td>${gap}</td></tr>`;
  }).join("");
  wrap.innerHTML = `<div class="table-scroll"><table class="matchup-table">
    <thead><tr><th>Shot type</th><th>Open</th><th>Contested</th><th>Open minus contested</th></tr></thead>
    <tbody>${rows}</tbody></table></div>
    <h3 style="margin:14px 0 4px;font-size:1rem">Catch-and-shoot at the same distance</h3>
    <div class="table-scroll"><table class="matchup-table">
    <thead><tr><th>Distance</th><th>Open</th><th>Contested</th><th>Open minus contested</th></tr></thead>
    <tbody>${zoneRows}</tbody></table></div>`;
}

// Is the Move actually producing better shots than the player's other tagged shots? Compares each
// player's own True Shooting % on Move shots with their TS% on everything else they've had tagged,
// and with their catch-and-shoot when that has enough shots too. Needs SHOT_TYPE_MIN_ATTEMPTS Move
// shots AND that many other tagged shots, so a "gap" is never one lucky make against nothing.
const MOVE_CHECK_EDGE_PTS = 10;
function renderMoveCheckPanel() {
  const wrap = document.getElementById("moveCheckPanel");
  if (!wrap) return;
  const { rows, league } = computeShotTypeStats();
  const tsOf = b => (b.a > 0 ? (b.pts / (2 * b.a)) * 100 : null);
  const combine = (r, excludeKey) => {
    const acc = { a: 0, m: 0, pts: 0 };
    TAGGABLE_SHOT_TYPES.forEach(t => { if (t.key !== excludeKey) { acc.a += r.types[t.key].a; acc.m += r.types[t.key].m; acc.pts += r.types[t.key].pts; } });
    return acc;
  };
  const verdict = gap => (gap >= MOVE_CHECK_EDGE_PTS ? "Move is working" : gap <= -MOVE_CHECK_EDGE_PTS ? "Move is trailing" : "About the same");
  const rowHtml = (name, r) => {
    const mv = r.types.move, other = combine(r, "move"), cs = r.types.catchAndShoot;
    if (mv.a < SHOT_TYPE_MIN_ATTEMPTS || other.a < SHOT_TYPE_MIN_ATTEMPTS) return null;
    const gap = tsOf(mv) - tsOf(other);
    return `<tr><td>${escapeHtml(name)}</td><td>${Math.round(tsOf(mv))}% TS<br><span class="hint" style="margin:0">${mv.m}/${mv.a}</span></td>
      <td>${Math.round(tsOf(other))}% TS<br><span class="hint" style="margin:0">${other.m}/${other.a}</span></td>
      <td>${cs.a >= SHOT_TYPE_MIN_ATTEMPTS ? Math.round(tsOf(cs)) + "% TS" : "—"}</td>
      <td>${gap > 0 ? "+" : ""}${Math.round(gap)}</td><td>${verdict(gap)}</td></tr>`;
  };
  const body = [rowHtml("League", league), ...rows.map(r => rowHtml(r.player.name, r))].filter(Boolean);
  if (body.length === 0) {
    wrap.innerHTML = '<p class="empty-state">Nobody has enough tagged Move shots yet. It needs 5 Move shots and 5 other tagged shots from the same player.</p>';
    return;
  }
  wrap.innerHTML = `<div class="table-scroll"><table class="matchup-table">
    <thead><tr><th>Player</th><th>Move</th><th>All other tagged shots (no dunks)</th><th>Catch-and-shoot</th><th>Move minus other (pts of TS%)</th><th>Read</th></tr></thead>
    <tbody>${body.join("")}</tbody></table></div>`;
}

// Watch-film links for a player's tagged shots of one type (most recent games first).
function gamesForShotType(playerId, typeKey, made) {
  const games = state.games.filter(isQualifyingGame).map(g => {
    const hits = g.scoringEvents.filter(ev => ev.scorerId === playerId && effShotType(ev) === typeKey && (ev.made !== false) === made);
    return hits.length ? { id: g.id, date: g.date, videoTime: hits[hits.length - 1].videoTime } : null;
  }).filter(Boolean);
  return games.sort((a, b) => (b.date || "").localeCompare(a.date || "")).slice(0, 3);
}

// Coaching tips from a player's own tagged shot types, against the league's TS% on the same type.
function shotTypeTipCandidates(playerId) {
  const out = [];
  const { rows, league } = computeShotTypeStats();
  const mine = rows.find(r => r.player.id === playerId);
  if (!mine) return out;
  const ts = b => (b.pts / (2 * b.a)) * 100;
  TAGGABLE_SHOT_TYPES.forEach(t => {
    const b = mine.types[t.key], l = league.types[t.key];
    if (b.a < SHOT_TYPE_MIN_ATTEMPTS || l.a < SHOT_TYPE_MIN_ATTEMPTS * 3) return;
    const gap = ts(b) - ts(l);
    if (gap >= 15) {
      out.push({ diff: gap, icon: "🔥", text: `Shot type: your ${t.label.toLowerCase()} shots are going ${formatPct(Math.round(ts(b)))} TS (${b.a} attempts), well above the league's ${formatPct(Math.round(ts(l)))} on that kind of shot. Worth creating more of them.`, games: gamesForShotType(playerId, t.key, true) });
    } else if (gap <= -15) {
      out.push({ diff: -gap, icon: "❄️", text: `Shot type: your ${t.label.toLowerCase()} shots are only ${formatPct(Math.round(ts(b)))} TS (${b.a} attempts), well under the league's ${formatPct(Math.round(ts(l)))} on that kind of shot. Worth practicing, or taking fewer of them until it improves.`, games: gamesForShotType(playerId, t.key, false) });
    }
  });
  const heave = mine.types.deepHeave;
  const noDunkTagged = mine.tagged - mine.types.dunk.a;
  const otherA = noDunkTagged - heave.a;
  if (noDunkTagged >= 12 && heave.a / noDunkTagged >= 0.35 && heave.a >= SHOT_TYPE_MIN_ATTEMPTS && otherA >= SHOT_TYPE_MIN_ATTEMPTS) {
    const otherPts = TAGGABLE_SHOT_TYPES.reduce((s, t) => s + (t.key === "deepHeave" ? 0 : mine.types[t.key].pts), 0);
    const otherTs = (otherPts / (2 * otherA)) * 100;
    if (otherTs - ts(heave) >= 8) {
      out.push({ diff: (otherTs - ts(heave)) / 2, icon: "🎯", text: `Shot selection: ${formatPct(Math.round((heave.a / noDunkTagged) * 100))} of your tagged shots (not counting dunks) are deep heaves off a check or rebound, at ${formatPct(Math.round(ts(heave)))} TS against ${formatPct(Math.round(otherTs))} on everything else. Letting the possession develop before shooting could raise the efficiency.`, games: gamesForShotType(playerId, "deepHeave", false) });
    }
  }
  return out;
}

function renderPlayerShotTypes(playerId) {
  const wrap = document.getElementById("playerShotTypes");
  if (!wrap) return;
  const { rows } = computeShotTypeStats();
  const r = rows.find(x => x.player.id === playerId);
  if (!r) {
    wrap.innerHTML = '<p class="empty-state">No shots by this player have a type yet.</p>';
    return;
  }
  const body = SHOT_TYPES.map(t => {
    const b = r.types[t.key];
    const enough = b.a >= SHOT_TYPE_MIN_ATTEMPTS;
    return `<tr><td>${escapeHtml(t.label)}</td><td>${b.a}</td><td>${Math.round((b.a / r.tagged) * 100)}%</td><td>${enough ? `${b.m}/${b.a} (${Math.round((b.m / b.a) * 100)}%)` : "—"}</td><td>${enough ? Math.round((b.pts / (2 * b.a)) * 100) + "%" : "—"}</td></tr>`;
  }).join("");
  wrap.innerHTML = `
    <p class="hint" style="margin-top:0">${r.tagged} of ${r.fga} field goal attempts have a shot type. Efficiency shows once a type has at least ${SHOT_TYPE_MIN_ATTEMPTS} tagged attempts.</p>
    <div class="table-scroll">
      <table class="matchup-table">
        <thead><tr><th>Shot type</th><th>Attempts</th><th>Share</th><th>FG</th><th>TS%</th></tr></thead>
        <tbody>${body}</tbody>
      </table>
    </div>`;
}

// ---------- Shot Arc (player page) ----------
// Describes the shape of a player's shots from the ones the film tracker followed start to finish
// (shot-arcs-data.js, built by shot-arc/build_arc_profile_data.py). Rows are matched to logged shots by
// game and video time. It only describes: an arc does not predict makes or misses in this data.
const SHOT_ARC_MIN = 8;

function shotArcRowsByShooter() {
  const rows = typeof SHOT_ARC_DATA !== "undefined" ? SHOT_ARC_DATA : [];
  const lookup = new Map(rows.map(r => [r[0] + "@" + r[1].toFixed(3), r]));
  const out = {};
  state.games.forEach(game => game.scoringEvents.forEach(ev => {
    if (ev.videoTime === null || ev.videoTime === undefined) return;
    const row = lookup.get(game.id + "@" + ev.videoTime.toFixed(3));
    if (row) (out[ev.scorerId] = out[ev.scorerId] || []).push(row);
  }));
  return out;
}

function shotArcMedian(values, q) {
  const v = values.slice().sort((a, b) => a - b);
  if (v.length === 0) return null;
  const pos = (v.length - 1) * (q === undefined ? 0.5 : q);
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return v[lo] + (v[hi] - v[lo]) * (pos - lo);
}

// One arc as an SVG path: leaves the shooter's hand at the left, peaks `peak` of the way through the
// flight, and its height is `height` (0 to 1 of the drawing).
function shotArcPath(peak, height, w, h, pad) {
  const p = Math.min(0.95, Math.max(0.1, peak));
  const a = height / (p * p);
  const pts = [];
  for (let i = 0; i <= 40; i++) {
    const t = i / 40;
    const y = height - a * (t - p) * (t - p);
    pts.push(`${(pad + t * (w - 2 * pad)).toFixed(1)},${(h - pad - Math.max(0, y) * (h - 2 * pad)).toFixed(1)}`);
  }
  return "M" + pts.join(" L");
}

function renderPlayerShotArc(playerId) {
  const wrap = document.getElementById("playerShotArc");
  if (!wrap) return;
  const byShooter = shotArcRowsByShooter();
  const mine = byShooter[playerId] || [];
  const all = Object.values(byShooter).flat();
  if (all.length === 0) {
    wrap.innerHTML = '<p class="empty-state">No shots have been traced from film yet.</p>';
    return;
  }
  if (mine.length < SHOT_ARC_MIN) {
    wrap.innerHTML = `<p class="empty-state">${mine.length} of this player's shots ${mine.length === 1 ? "has" : "have"} been traced from film. It needs at least ${SHOT_ARC_MIN} to describe a typical arc.</p>`;
    return;
  }
  const air = mine.map(r => r[2]), peak = mine.map(r => r[3]), arch = mine.map(r => r[4]);
  const leagueAir = shotArcMedian(all.map(r => r[2])), leaguePeak = shotArcMedian(all.map(r => r[3]));
  const myAir = shotArcMedian(air), myPeak = shotArcMedian(peak), myArch = shotArcMedian(arch);
  const archWord = myArch >= 1.12 ? `${Math.round((myArch - 1) * 100)}% higher than a typical arc`
    : myArch <= 0.88 ? `${Math.round((1 - myArch) * 100)}% flatter than a typical arc` : "about a typical arc height";
  const peakWord = myPeak - leaguePeak >= 0.08 ? "later in the flight than most"
    : myPeak - leaguePeak <= -0.08 ? "earlier in the flight than most" : "about the same point as most";
  const lo = shotArcMedian(air, 0.25), hi = shotArcMedian(air, 0.75);
  const W = 220, H = 96, PAD = 8, leagueHeight = 0.62;
  const heightFor = rel => Math.min(0.95, leagueHeight * rel);
  wrap.innerHTML = `
    <p class="hint" style="margin:0 0 8px">Based on ${mine.length} shots followed on film from release to the hoop.</p>
    <div class="shot-arc-body">
      <svg class="shot-arc-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="This player's typical arc compared with the league's">
        <path d="${shotArcPath(leaguePeak, heightFor(1), W, H, PAD)}" class="shot-arc-league" />
        <path d="${shotArcPath(myPeak, heightFor(myArch), W, H, PAD)}" class="shot-arc-mine" />
      </svg>
      <ul class="shot-arc-facts">
        <li><strong>${myAir.toFixed(2)} s</strong> in the air (league ${leagueAir.toFixed(2)} s). Most shots fall between ${lo.toFixed(2)} and ${hi.toFixed(2)} s.</li>
        <li>Arc height: <strong>${archWord}</strong>.</li>
        <li>Highest point: ${peakWord}.</li>
      </ul>
    </div>
    <div class="shot-chart-legend" style="margin-top:6px">
      <span class="legend-item"><span class="legend-dot shot-arc-key-mine"></span>This player</span>
      <span class="legend-item"><span class="legend-dot shot-arc-key-league"></span>League</span>
    </div>`;
}

// ---------- League Rank (player page) ----------
// Quick "where does this player stand" badges next to the header, using the same season numbers
// the Leaderboard already computes -- no new tracking. Same games-played bar as the Leaderboard
// itself (LEAGUE_RANK_MIN_GP), so a player who has barely played doesn't crowd out real ranks.
const LEAGUE_RANK_MIN_GP = 2;
const LEAGUE_RANK_STATS = [
  { key: "pts", label: "PTS/20", higherBetter: true, value: r => r.rate.pts },
  { key: "ast", label: "AST/20", higherBetter: true, value: r => r.rate.ast },
  { key: "stocks", label: "STL+BLK/20", higherBetter: true, value: r => r.rate.stl + r.rate.blk },
  { key: "ts", label: "TS%", higherBetter: true, value: r => trueShootingPct(r.totals.pts, r.shooting.fga, r.shooting.fta) },
  { key: "tov", label: "TOV/20", higherBetter: false, value: r => r.rate.tov },
  { key: "offRating", label: "Off Rating/20", higherBetter: true, value: r => r.offRatingPer20 },
  { key: "defRating", label: "Def Rating/20", higherBetter: true, value: r => r.twoWayPer20 - r.offRatingPer20 },
  { key: "twoWay", label: "Two-Way/20", higherBetter: true, value: r => r.twoWayPer20 },
  { key: "winShares", label: "Win Shares", higherBetter: true, value: r => r.winShares ? r.winShares.winShares : null }
];

function computeLeagueRanks(playerId) {
  const board = computeLeaderboard().filter(r => r.gp >= LEAGUE_RANK_MIN_GP);
  return LEAGUE_RANK_STATS.map(s => {
    const entries = board.map(r => ({ id: r.player.id, value: s.value(r) })).filter(e => e.value !== null && e.value !== undefined && !Number.isNaN(e.value));
    entries.sort((a, b) => s.higherBetter ? b.value - a.value : a.value - b.value);
    const i = entries.findIndex(e => e.id === playerId);
    return i === -1 ? null : { ...s, rank: i + 1, of: entries.length, value: entries[i].value };
  }).filter(Boolean);
}

function renderPlayerLeagueRank(playerId) {
  const wrap = document.getElementById("playerLeagueRank");
  if (!wrap) return;
  const ranks = computeLeagueRanks(playerId);
  if (ranks.length === 0) {
    wrap.innerHTML = '<p class="empty-state">Needs at least 2 games played to show a league rank.</p>';
    return;
  }
  wrap.innerHTML = ranks.map(r => {
    const tier = r.rank === 1 ? " league-rank-rank1" : r.rank === 2 ? " league-rank-rank2" : r.rank === 3 ? " league-rank-rank3" : "";
    const shown = r.decimals === undefined ? (Number.isInteger(r.value) ? r.value : r.value.toFixed(1)) : r.value.toFixed(r.decimals);
    return `<div class="league-rank-badge${tier}" title="${escapeHtml(r.label)}: ${shown}${r.key === "ts" ? "%" : ""} among players with at least ${LEAGUE_RANK_MIN_GP} games played">
      <span class="league-rank-place">${ordinal(r.rank)}</span>
      <span class="league-rank-label">${escapeHtml(r.label)}</span>
      <span class="league-rank-of">of ${r.of}</span>
    </div>`;
  }).join("");
}

function ordinal(n) {
  const s = ["th", "st", "nd", "rd"], v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

// ---------- Player page: section teasers + jump nav ----------
// One-line preview text shown next to each collapsed section's title, built from stats already
// computed for the Leaderboard/League Rank -- no new tracking. Static sections (no player-specific
// number readily at hand) get a plain description instead of a fake number.
function computePlayerSectionTeasers(playerId) {
  const row = computeLeaderboard().find(r => r.player.id === playerId);
  if (!row) return {};
  const tsPct = trueShootingPct(row.totals.pts, row.shooting.fga, row.shooting.fta);
  const defAttempts = row.defense.timesBeaten + row.defense.stops;
  const record = `${row.wins}-${row.losses}${row.ties ? `-${row.ties}` : ""}`;
  return {
    shooting: tsPct !== null ? `${tsPct}% TS, ${row.rate.pts.toFixed(1)} PTS/20` : "Not enough field goals yet",
    passing: `${row.rate.ast.toFixed(1)} AST/20 · ${formatPct(row.tovPct)} turnover rate`,
    defense: defAttempts >= 5 ? `Opponents shooting ${formatPct(pct(row.defense.timesBeaten, defAttempts))} against` : "Not enough tagged defensive plays yet",
    matchups: "Individual matchup history, as scorer and as defender",
    team: "How this player's own numbers shift with and without each teammate",
    trends: `${record} · ${row.twoWayPer20.toFixed(1)} Two-Way/20`,
    media: "Every logged game, plus any clipped highlights and lowlights"
  };
}

function renderPlayerSectionTeasers(playerId) {
  const teasers = computePlayerSectionTeasers(playerId);
  Object.entries(teasers).forEach(([key, text]) => {
    const el = document.getElementById(`teaser-${key}`);
    if (el) el.textContent = text;
  });
}

// Wired once at load (the nav buttons are static markup, never re-rendered) -- opens the target
// section if it was collapsed, then scrolls to it.
function wireSectionNavExtras(tabSelector, idPrefix) {
  // Shared by wirePlayerSectionNav / wireLeaderboardSectionNav: keeps each nav pill's active
  // state synced to whether its section is open, and wires that tab's expand/collapse-all button.
  // The nav and the <details class="player-section"> elements are siblings, not nested, so both
  // are found from the enclosing tab rather than from the nav element itself.
  const tab = document.querySelector(tabSelector);
  if (!tab) return;
  const nav = tab.querySelector(".player-section-nav");
  const sections = tab.querySelectorAll(".player-section");
  if (!nav || !sections.length) return;
  const syncActive = section => {
    const key = section.id.slice(idPrefix.length);
    const link = nav.querySelector(`.player-section-nav-link[data-section="${key}"]`);
    if (link) link.classList.toggle("player-section-nav-active", section.open);
  };
  sections.forEach(section => {
    syncActive(section);
    section.addEventListener("toggle", () => syncActive(section));
  });
  const expandBtn = nav.querySelector(".player-section-expand-all");
  if (expandBtn) {
    expandBtn.addEventListener("click", () => {
      const shouldExpand = Array.from(sections).some(s => !s.open);
      // Setting .open via script doesn't reliably fire "toggle" in every browser, so sync
      // the pills here directly instead of waiting on the listener above to catch it.
      sections.forEach(s => { s.open = shouldExpand; syncActive(s); });
      expandBtn.textContent = shouldExpand ? "Collapse all" : "Expand all";
    });
  }
}

function wirePlayerSectionNav() {
  // Scoped to #tab-player: the Leaderboard tab's own section nav (wireLeaderboardSectionNav)
  // reuses the same .player-section-nav-link class and would otherwise get a second, wrong
  // click handler here too (its data-section values collide with this tab's section ids).
  document.querySelectorAll("#tab-player .player-section-nav-link").forEach(btn => {
    btn.addEventListener("click", () => {
      const section = document.getElementById(`section-${btn.dataset.section}`);
      if (!section) return;
      section.open = true;
      section.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  });
  wireSectionNavExtras("#tab-player", "section-");
}

// ---------- Leaderboard page: section teasers + jump nav ----------
function computeLeaderboardSectionTeasers() {
  const board = computeLeaderboard().filter(r => r.gp >= LEAGUE_RANK_MIN_GP);
  const tsVals = board.map(r => trueShootingPct(r.totals.pts, r.shooting.fga, r.shooting.fta)).filter(v => v !== null);
  const leagueTs = tsVals.length ? Math.round(tsVals.reduce((a, b) => a + b, 0) / tsVals.length) : null;
  return {
    comparison: "Full stat table, head-to-head player comparison, and season-long trends",
    shooting: leagueTs !== null ? `League averaging ${leagueTs}% TS` : "Shot zones, shot types, and shooting splits",
    matchups: "Head-to-head records, rebound battles, and teammate synergy",
    situational: "Out-of-bounds, second-chance, and close-game splits",
    style: "Play style clusters and the advanced models built on top of them",
    media: "Best and worst individual games, plus every clipped highlight"
  };
}

function renderLeaderboardSectionTeasers() {
  const teasers = computeLeaderboardSectionTeasers();
  Object.entries(teasers).forEach(([key, text]) => {
    const el = document.getElementById(`lb-teaser-${key}`);
    if (el) el.textContent = text;
  });
}

function wireLeaderboardSectionNav() {
  document.querySelectorAll("#tab-leaderboard .player-section-nav-link").forEach(btn => {
    btn.addEventListener("click", () => {
      const section = document.getElementById(`lb-section-${btn.dataset.section}`);
      if (!section) return;
      section.open = true;
      section.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  });
  wireSectionNavExtras("#tab-leaderboard", "lb-section-");
}

// ---------- Review Shot Types (backfill and re-check) ----------
// Default view: every 2- and 3-point attempt with no shot type yet, oldest first, a page at a time,
// optionally narrowed to one player (so one player's shots can be tagged first). The re-check views
// list shots that ARE tagged but worth a second look: guarded catch-and-shoots (a guarded "standing"
// shot may really have been a Move) and drives that ended far from the hoop (a real drive rarely
// ends 65+ units out). One click tags/retags the shot and removes just that row (a full redraw
// would stop a clip that's playing in this panel). Skip / "Looks right" hides a row for this visit
// only and writes nothing, so a reload brings it back.
const SHOT_TYPE_REVIEW_PAGE = 20;
const DRIVE_FAR_UNITS = 65;
let shotTypeReviewLimit = SHOT_TYPE_REVIEW_PAGE;
let shotTypeReviewPlayer = "";
let shotTypeReviewMode = "untagged";
const shotTypeSkipped = new Set();
const SHOT_TYPE_REVIEW_MODES = {
  untagged: { label: "Shots with no type yet", noun: "field goals still without a shot type", empty: "Every field goal has a shot type." },
  guardedCatch: { label: "Re-check: guarded catch-and-shoots", noun: "guarded catch-and-shoots to re-check", empty: "No guarded catch-and-shoots to re-check." },
  farDrives: { label: `Re-check: drives ${DRIVE_FAR_UNITS}+ units from the hoop`, noun: "far-out drives to re-check", empty: "No far-out drives to re-check." }
};

function shotTypeReviewMatches(ev) {
  if (ev.points !== 2 && ev.points !== 3) return false;
  const type = effShotType(ev);
  if (shotTypeReviewMode === "untagged") return !type;
  if (shotTypeReviewMode === "guardedCatch") return type === "catchAndShoot" && (ev.defenderIds || []).length > 0;
  if (shotTypeReviewMode === "farDrives") return type === "drive" && ev.shotLocation && shotDistanceFromHoop(ev.shotLocation) >= DRIVE_FAR_UNITS;
  return false;
}

function computeShotTypeReviewRows() {
  const rows = [];
  state.games.forEach(game => {
    game.scoringEvents.forEach(ev => {
      if (!shotTypeReviewMatches(ev)) return;
      if (shotTypeReviewPlayer && ev.scorerId !== shotTypeReviewPlayer) return;
      if (shotTypeSkipped.has(ev.id)) return;
      rows.push({ game, ev });
    });
  });
  return rows.sort((a, b) => (a.game.date || "").localeCompare(b.game.date || "") || (a.ev.videoTime || 0) - (b.ev.videoTime || 0));
}

function renderShotTypeReview() {
  const wrap = document.getElementById("shotTypeReview");
  if (!wrap) return;
  const mode = SHOT_TYPE_REVIEW_MODES[shotTypeReviewMode];
  const all = computeShotTypeReviewRows();
  const shown = all.slice(0, shotTypeReviewLimit);
  // Players who have something in this view, so the filter never offers an empty choice.
  const inMode = new Set();
  state.games.forEach(g => g.scoringEvents.forEach(ev => { if (shotTypeReviewMatches(ev) && !shotTypeSkipped.has(ev.id)) inMode.add(ev.scorerId); }));
  const playerOptions = state.players.filter(p => inMode.has(p.id) || p.id === shotTypeReviewPlayer)
    .map(p => `<option value="${p.id}"${p.id === shotTypeReviewPlayer ? " selected" : ""}>${escapeHtml(p.name)}</option>`).join("");
  const controls = `<div class="button-row" style="margin:0 0 8px;gap:10px;align-items:center">
      <label>Show <select data-review-mode>${Object.entries(SHOT_TYPE_REVIEW_MODES).map(([k, m]) => `<option value="${k}"${k === shotTypeReviewMode ? " selected" : ""}>${escapeHtml(m.label)}</option>`).join("")}</select></label>
      <label>Player <select data-review-player><option value="">Everyone</option>${playerOptions}</select></label>
    </div>`;
  const recheck = shotTypeReviewMode !== "untagged";
  wrap.innerHTML = `${controls}
  ${all.length === 0 ? `<p class="empty-state">${escapeHtml(mode.empty)}</p>` : `<p class="hint shot-type-review-summary" style="margin-top:0"></p>
  <ul class="player-tips-list">${shown.map(({ game, ev }) => {
    const scorer = state.players.find(p => p.id === ev.scorerId);
    const hasTime = ev.videoTime !== null && ev.videoTime !== undefined;
    const watchLinks = watchFilmLinksHtml(hasTime ? [{ id: game.id, date: game.date, videoTime: ev.videoTime }] : []);
    const band = ev.shotLocation ? ` · ${escapeHtml(({ close: "close", mid: "midrange", arc: "at the line", deep: "deep" })[shotBand(ev.shotLocation, ev.points)])}` : "";
    const guarded = (ev.defenderIds || []).length > 0 ? " · guarded" : " · no defender tagged";
    return `<li data-event-id="${ev.id}">
      <span>${scorer ? playerLink(scorer.id, scorer.name) : "?"}: ${ev.made !== false ? "Make" : "Miss"} (${ev.points}pt${band}${recheck ? guarded : ""}, ${escapeHtml(formatDateDisplay(game.date))})${recheck ? ` · currently ${escapeHtml(shotTypeLabel(ev.shotType))}` : ""}${watchLinks}</span>
      <div class="button-row" style="margin-top:4px">
        ${shotTypeButtonsHtml(recheck ? ev.shotType : null, "mark-shot-type")}
        <button type="button" class="icon-btn" data-skip-shot-type="${ev.id}">${recheck ? "Looks right" : "Skip"}</button>
      </div>
    </li>`;
  }).join("")}</ul>
  ${all.length > shown.length ? '<button type="button" class="secondary-btn" data-shot-type-more="1">Show more</button>' : ""}`}`;
  wireWatchFilmButtons(wrap);

  wrap.querySelector("[data-review-mode]").addEventListener("change", e => { shotTypeReviewMode = e.target.value; shotTypeReviewLimit = SHOT_TYPE_REVIEW_PAGE; renderShotTypeReview(); });
  wrap.querySelector("[data-review-player]").addEventListener("change", e => { shotTypeReviewPlayer = e.target.value; shotTypeReviewLimit = SHOT_TYPE_REVIEW_PAGE; renderShotTypeReview(); });
  if (all.length === 0) return;

  const summaryEl = wrap.querySelector(".shot-type-review-summary");
  const updateSummary = () => {
    const left = computeShotTypeReviewRows().length;
    summaryEl.textContent = `${left} ${mode.noun}.`;
  };
  updateSummary();
  const dropRow = eventId => {
    wrap.querySelector(`li[data-event-id="${eventId}"]`)?.remove();
    updateSummary();
    if (wrap.querySelectorAll("li").length === 0) renderShotTypeReview();
  };
  wrap.querySelectorAll("li").forEach(li => {
    const eventId = li.dataset.eventId;
    li.querySelectorAll("[data-mark-shot-type]").forEach(btn => {
      btn.addEventListener("click", () => {
        const ev = state.games.flatMap(g => g.scoringEvents).find(e => e.id === eventId);
        if (!ev) return;
        ev.shotType = btn.dataset.markShotType;
        saveState();
        // A re-check shot that is still a match after the change (same type picked) would otherwise
        // reappear on the next render, so it is also set aside for this visit.
        if (shotTypeReviewMatches(ev)) shotTypeSkipped.add(eventId);
        dropRow(eventId);
      });
    });
    li.querySelector("[data-skip-shot-type]").addEventListener("click", () => {
      shotTypeSkipped.add(eventId);
      dropRow(eventId);
    });
  });
  const moreBtn = wrap.querySelector("[data-shot-type-more]");
  if (moreBtn) moreBtn.addEventListener("click", () => { shotTypeReviewLimit += SHOT_TYPE_REVIEW_PAGE; renderShotTypeReview(); });
}

// ---------- Shots logged at the same moment ----------
// Two shots with exactly the same video time usually mean a miss and its putback were logged
// back to back while the video was paused, so the putback inherited the miss's time. That breaks
// anything keyed to the moment of the shot (film links, shot-arc matching). This lists each such
// pair with a link to the film and a box to give one of the two its real time. The later shot of
// the pair (or the one who rebounded the other's miss) is offered first, since that is the putback.
const sameMomentDismissed = new Set();

function parseVideoTimeInput(text) {
  const t = String(text || "").trim();
  if (!t) return null;
  const m = t.match(/^(?:(\d+):)?(\d+(?:\.\d+)?)$/);
  if (!m) return null;
  const secs = (m[1] ? parseInt(m[1], 10) * 60 : 0) + parseFloat(m[2]);
  return Number.isFinite(secs) ? secs : null;
}

function computeSameMomentGroups() {
  const groups = [];
  state.games.forEach(game => {
    const byTime = new Map();
    game.scoringEvents.forEach(ev => {
      if (ev.points !== 2 && ev.points !== 3) return;
      if (ev.videoTime === null || ev.videoTime === undefined) return;
      const k = ev.videoTime.toFixed(3);
      if (!byTime.has(k)) byTime.set(k, []);
      byTime.get(k).push(ev);
    });
    byTime.forEach((evs, k) => {
      if (evs.length < 2) return;
      const id = game.id + "@" + k;
      if (sameMomentDismissed.has(id)) return;
      groups.push({ id, game, time: evs[0].videoTime, evs });
    });
  });
  return groups.sort((a, b) => (a.game.date || "").localeCompare(b.game.date || "") || a.time - b.time);
}

function renderSameMomentReview() {
  const wrap = document.getElementById("sameMomentReview");
  if (!wrap) return;
  const groups = computeSameMomentGroups();
  if (groups.length === 0) {
    wrap.innerHTML = '<p class="empty-state">No two shots share a video time.</p>';
    return;
  }
  const nameOf = id => (state.players.find(p => p.id === id) || {}).name || "?";
  wrap.innerHTML = `<p class="hint shot-type-review-summary" style="margin-top:0">${groups.length} moment${groups.length === 1 ? "" : "s"} with more than one shot.</p>
  <ul class="player-tips-list">${groups.map(g => {
    const later = g.evs.find(e => g.evs.some(o => o !== e && o.rebounderId === e.scorerId)) || g.evs[g.evs.length - 1];
    const line = g.evs.map(e => `${escapeHtml(nameOf(e.scorerId))} ${e.made !== false ? "made" : "missed"} a ${e.points}pt`).join(", then ");
    return `<li data-group="${g.id}">
      <span>${escapeHtml(formatDateDisplay(g.game.date))} at ${escapeHtml(formatVideoTime(g.time))}: ${line}</span>
      ${watchFilmLinksHtml([{ id: g.game.id, date: g.game.date, videoTime: Math.max(0, g.time - 3) }])}
      <div class="button-row" style="margin-top:4px;gap:8px;align-items:center">
        <label>New time for ${escapeHtml(nameOf(later.scorerId))}'s shot <input type="text" data-new-time size="7" placeholder="m:ss"></label>
        <button type="button" class="secondary-btn" data-save-time="${later.id}">Set time</button>
        <button type="button" class="icon-btn" data-same-ok="1">Same moment is right</button>
      </div>
    </li>`;
  }).join("")}</ul>`;
  wireWatchFilmButtons(wrap);
  wrap.querySelectorAll("li").forEach(li => {
    const gid = li.dataset.group;
    li.querySelector("[data-same-ok]").addEventListener("click", () => { sameMomentDismissed.add(gid); renderSameMomentReview(); });
    const btn = li.querySelector("[data-save-time]");
    btn.addEventListener("click", () => {
      const secs = parseVideoTimeInput(li.querySelector("[data-new-time]").value);
      if (secs === null) { alert("Enter the time as m:ss (for example 17:24) or as seconds."); return; }
      const ev = state.games.flatMap(x => x.scoringEvents).find(e => e.id === btn.dataset.saveTime);
      if (!ev) return;
      ev.videoTime = secs;
      saveState();
      renderSameMomentReview();
    });
  });
}

// ---------- Rebound Battles backfill (see poolean-rebound-battles-spec.md) ----------
// Every miss with a real rebounder tracked but no contest answer yet -- a lightweight scan list
// for piloting the tag on a small batch, same "human judgment, not inferred" stance the picker in
// Stat Entry's own Shot Log Edit flow uses. One click tags a single contester and resolves the
// row (the common case -- a genuine double-team contest is rarer; use Shot Log's own Edit flow
// for that, which supports tagging more than one). "No contest" is a real, persisted answer
// (reviewed, confirmed nobody was actually contesting it -- an uncontested/leaked-out rebound),
// distinct from Skip, which only hides a row for THIS session and writes nothing to state (a page
// reload brings a skipped row back). Meant for one focused batch-tagging session at a time, not a
// permanent, persistent queue.
function computeReboundBattleCandidates() {
  const rows = [];
  state.games.forEach(game => {
    game.scoringEvents.forEach(ev => {
      if (ev.made !== false || !ev.rebounderId || ev.turnoverEventId) return;
      if ((ev.reboundContesterIds || []).length > 0 || ev.reboundNoContest) return;
      rows.push({ game, ev });
    });
  });
  return rows.sort((a, b) => (a.game.date || "").localeCompare(b.game.date || ""));
}

function renderReboundBattleReview() {
  const wrap = document.getElementById("reboundBattleReview");
  if (!wrap) return;
  const rows = computeReboundBattleCandidates();
  if (rows.length === 0) {
    wrap.innerHTML = '<p class="empty-state">No untagged rebounds left to review this session.</p>';
    return;
  }
  wrap.innerHTML = `<p class="hint rebound-battle-review-summary" style="margin-top:0">${rows.length} rebound${rows.length === 1 ? "" : "s"} still untagged.</p>
  <ul class="player-tips-list">${rows.map(({ game, ev }) => {
    const scorer = state.players.find(p => p.id === ev.scorerId);
    const rebounder = state.players.find(p => p.id === ev.rebounderId);
    const hasTime = ev.videoTime !== null && ev.videoTime !== undefined;
    const watchLinks = watchFilmLinksHtml(hasTime ? [{ id: game.id, date: game.date, videoTime: ev.videoTime }] : []);
    const scorerTeam = game.teamA.includes(ev.scorerId) ? game.teamA : game.teamB;
    const opponentTeam = game.teamA.includes(ev.scorerId) ? game.teamB : game.teamA;
    const rebounderOnScorerSide = scorerTeam.includes(ev.rebounderId);
    const contesterIds = rebounderOnScorerSide ? opponentTeam : scorerTeam;
    const contesters = contesterIds.map(id => state.players.find(p => p.id === id)).filter(Boolean);
    const kind = rebounderOnScorerSide ? "OREB" : "DREB";
    return `<li data-event-id="${ev.id}">
      <span>${scorer ? playerLink(scorer.id, scorer.name) : "?"} miss, ${kind} by ${rebounder ? playerLink(rebounder.id, rebounder.name) : "?"} (${escapeHtml(formatDateDisplay(game.date))})${watchLinks}</span>
      <div class="button-row" style="margin-top:4px">
        ${contesters.map(c => `<button type="button" class="secondary-btn" data-tag-contester="${ev.id}" data-contester-id="${c.id}">${escapeHtml(c.name)} contested</button>`).join("")}
        <button type="button" class="secondary-btn" data-no-contest="${ev.id}">No contest</button>
        <button type="button" class="secondary-btn" data-skip-contester="${ev.id}">Skip (unclear)</button>
      </div>
    </li>`;
  }).join("")}</ul>`;
  wireWatchFilmButtons(wrap);

  const summaryEl = wrap.querySelector(".rebound-battle-review-summary");
  const listEl = wrap.querySelector("ul");
  const removeRow = eventId => {
    listEl.querySelector(`li[data-event-id="${eventId}"]`)?.remove();
    const left = listEl.querySelectorAll("li").length;
    if (left === 0) {
      listEl.remove();
      summaryEl.textContent = "";
      if (!wrap.querySelector(".rebound-battle-review-done-msg")) {
        const doneMsg = document.createElement("p");
        doneMsg.className = "empty-state rebound-battle-review-done-msg";
        doneMsg.textContent = "No untagged rebounds left to review this session.";
        wrap.appendChild(doneMsg);
      }
    } else {
      summaryEl.textContent = `${left} rebound${left === 1 ? "" : "s"} still untagged.`;
    }
  };
  wrap.querySelectorAll("[data-tag-contester]").forEach(btn => {
    btn.addEventListener("click", () => {
      const ev = state.games.flatMap(g => g.scoringEvents).find(e => e.id === btn.dataset.tagContester);
      if (!ev) return;
      ev.reboundContesterIds = [btn.dataset.contesterId];
      saveState();
      removeRow(btn.dataset.tagContester);
    });
  });
  wrap.querySelectorAll("[data-no-contest]").forEach(btn => {
    btn.addEventListener("click", () => {
      const ev = state.games.flatMap(g => g.scoringEvents).find(e => e.id === btn.dataset.noContest);
      if (!ev) return;
      ev.reboundNoContest = true;
      saveState();
      removeRow(btn.dataset.noContest);
    });
  });
  wrap.querySelectorAll("[data-skip-contester]").forEach(btn => {
    btn.addEventListener("click", () => removeRow(btn.dataset.skipContester));
  });
}

// Backlog review for the stoppedEarly flag (see poolean-stopped-early-spec.md) -- same pattern as
// Review Possible Dunks, but there's no "unresolved" state to filter down to the way dunk has
// (undefined vs. true/false): every game defaults to stoppedEarly === false, since that's the
// correct assumption for the vast majority logged before this field existed. So this lists every
// reviewed game (one with real shots logged -- an unreviewed game has no stats to distort yet)
// for a human to scan and flag any they remember being cut short, most recent first since that's
// what people actually remember.
function renderStoppedEarlyReview() {
  const wrap = document.getElementById("stoppedEarlyReview");
  if (!wrap) return;
  const games = state.games
    .filter(g => g.scoringEvents.length > 0)
    .sort((a, b) => (b.date || "").localeCompare(a.date || ""));
  if (games.length === 0) {
    wrap.innerHTML = '<p class="empty-state">No reviewed games yet.</p>';
    return;
  }
  wrap.innerHTML = `<ul class="player-tips-list">${games.map(game => {
    const scoreA = teamScore(game, game.teamA);
    const scoreB = teamScore(game, game.teamB);
    const teamANames = game.teamA.map(id => state.players.find(p => p.id === id)?.name).filter(Boolean).join(", ") || "Team A";
    const teamBNames = game.teamB.map(id => state.players.find(p => p.id === id)?.name).filter(Boolean).join(", ") || "Team B";
    return `<li data-game-id="${game.id}">
      <span>${escapeHtml(formatDateDisplay(game.date))}: ${escapeHtml(teamANames)} ${scoreA} - ${scoreB} ${escapeHtml(teamBNames)}</span>
      <div class="button-row" style="margin-top:4px">
        <button type="button" class="secondary-btn${game.stoppedEarly ? " selected" : ""}" data-toggle-stopped-early-review="${game.id}">${game.stoppedEarly ? "🛑 Stopped early" : "Mark as stopped early"}</button>
      </div>
    </li>`;
  }).join("")}</ul>`;
  wrap.querySelectorAll("[data-toggle-stopped-early-review]").forEach(btn => {
    btn.addEventListener("click", () => {
      const game = state.games.find(g => g.id === btn.dataset.toggleStoppedEarlyReview);
      if (!game) return;
      game.stoppedEarly = !game.stoppedEarly;
      saveState();
      btn.classList.toggle("selected", game.stoppedEarly);
      btn.textContent = game.stoppedEarly ? "🛑 Stopped early" : "Mark as stopped early";
    });
  });
}

function renderBackfillShotLocations() {
  const wrap = document.getElementById("backfillShotLocations");
  if (!wrap) return;
  const gamesWithShots = state.games
    .map(game => {
      const allFg = game.scoringEvents.filter(ev => ev.points === 2 || ev.points === 3);
      const missing = allFg.filter(ev => !ev.shotLocation);
      return { game, shots: backfillShowMarked ? allFg : missing, missingCount: missing.length };
    })
    .filter(({ shots }) => shots.length > 0)
    .sort((a, b) => (a.game.date || "").localeCompare(b.game.date || ""));

  const totalMissing = gamesWithShots.reduce((sum, { missingCount }) => sum + missingCount, 0);
  const toggleHtml = `<label class="hint" style="display:flex;align-items:center;gap:6px;margin:0 0 10px">
    <input type="checkbox" id="backfillShowMarkedToggle" ${backfillShowMarked ? "checked" : ""}>
    Show already-marked shots too (to fix a mistaken one)
  </label>`;

  if (gamesWithShots.length === 0) {
    wrap.innerHTML = toggleHtml + '<p class="empty-state">Every field goal has a shot location. Nothing to backfill.</p>';
    wrap.querySelector("#backfillShowMarkedToggle").addEventListener("change", e => {
      backfillShowMarked = e.target.checked;
      renderBackfillShotLocations();
    });
    return;
  }

  wrap.innerHTML = toggleHtml +
    `<p class="hint backfill-summary" style="margin-top:0">${totalMissing} shot${totalMissing === 1 ? "" : "s"} still missing a location.</p><div id="backfillUndoToast"></div>`;
  wrap.querySelector("#backfillShowMarkedToggle").addEventListener("change", e => {
    backfillShowMarked = e.target.checked;
    renderBackfillShotLocations();
  });
  const summaryEl = wrap.querySelector(".backfill-summary");

  gamesWithShots.forEach(({ game, shots }) => {
    const groupEl = document.createElement("div");
    groupEl.className = "backfill-game-group";
    groupEl.innerHTML = `<h4>${escapeHtml(formatDateDisplay(game.date))}</h4><div class="backfill-video-wrap"><p class="hint" style="margin:0">Loading video…</p></div>`;
    const videoWrap = groupEl.querySelector(".backfill-video-wrap");

    const rowsEl = document.createElement("div");
    rowsEl.className = "backfill-shot-rows";
    shots.forEach(ev => {
      const scorer = state.players.find(p => p.id === ev.scorerId);
      const hasTime = ev.videoTime !== null && ev.videoTime !== undefined;
      const row = document.createElement("div");
      row.className = ev.shotLocation ? "backfill-shot-row backfill-shot-row-marked" : "backfill-shot-row";
      row.innerHTML = `
        <div class="backfill-shot-label">
          ${scorer ? playerLink(scorer.id, scorer.name) : "?"}: ${ev.made !== false ? "Make" : "Miss"} (${ev.points}pt)
        </div>
        <button type="button" class="secondary-btn" data-watch="1" ${hasTime ? "" : "disabled"}>▶ Watch</button>
        ${renderShotChartBaseSvg("data-shot-chart")}
      `;
      setShotChartDot(row.querySelector("[data-shot-chart]"), ev.shotLocation);
      row.querySelector("[data-watch]").addEventListener("click", () => {
        const video = videoWrap.querySelector("video");
        if (!video || !hasTime) return;
        video.currentTime = ev.videoTime;
        video.play();
      });
      row.querySelector("[data-shot-chart]").addEventListener("click", e => {
        const rect = e.currentTarget.getBoundingClientRect();
        const previousLocation = ev.shotLocation;
        const xFrac = Math.max(0, Math.min(100, ((e.clientX - rect.left) / rect.width) * 100));
        const yFrac = Math.max(0, Math.min(100, ((e.clientY - rect.top) / rect.height) * 100));
        // Flipped rendering (hoop at the bottom) — invert back to the stored convention.
        ev.shotLocation = { x: xFrac, y: 100 - yFrac };
        saveState();
        // Order matters: show the toast (which needs #backfillUndoToast intact) before doing
        // any cleanup that might otherwise be tempted to wipe the whole panel.
        showBackfillUndoToast(scorer ? scorer.name : "?", game, ev.id, previousLocation);

        if (backfillShowMarked) {
          // The row stays either way in this mode — just redraw its dot.
          setShotChartDot(e.currentTarget, ev.shotLocation);
          row.classList.add("backfill-shot-row-marked");
          if (!previousLocation) {
            const left = Math.max(0, parseInt(summaryEl.textContent, 10) - 1);
            summaryEl.textContent = `${left} shot${left === 1 ? "" : "s"} still missing a location.`;
          }
          return;
        }
        row.remove();
        if (!rowsEl.querySelector(".backfill-shot-row")) groupEl.remove();
        const left = Math.max(0, parseInt(summaryEl.textContent, 10) - 1);
        if (left <= 0) {
          summaryEl.textContent = "";
          if (!wrap.querySelector(".backfill-done-msg")) {
            const doneMsg = document.createElement("p");
            doneMsg.className = "empty-state backfill-done-msg";
            doneMsg.textContent = "Every field goal has a shot location. Nothing to backfill.";
            wrap.appendChild(doneMsg);
          }
        } else {
          summaryEl.textContent = `${left} shot${left === 1 ? "" : "s"} still missing a location.`;
        }
      });
      rowsEl.appendChild(row);
    });
    groupEl.appendChild(rowsEl);
    wrap.appendChild(groupEl);
    // Only load the video once the group is actually attached to the live DOM — otherwise a
    // cached blob URL resolves synchronously, before appendChild above has run, and the
    // `videoWrap.isConnected` guard in loadBackfillVideo silently bails, leaving "Loading
    // video…" stuck forever. An uncached load only surfaced this by accident: the IndexedDB
    // round-trip is slow enough that the DOM always catches up first.
    loadBackfillVideo(game, videoWrap);
  });
}

// Every marked 2PT/3PT shot where the spot disagrees with the point value picked at logging
// time — the same mismatch the Shot Log's "📍 2PT range"/"📍 3PT range" badge flags one row at
// a time (see renderScoringLog), collected here so a whole season's worth can be reviewed in
// one pass instead of stumbled onto while scrolling. Free throws never have a location, so
// they're never candidates.
function computeFlaggedShotMismatches() {
  const flagged = [];
  state.games.forEach(game => {
    game.scoringEvents.forEach(ev => {
      if (!ev.shotLocation || (ev.points !== 2 && ev.points !== 3)) return;
      const zone = ev.shotLocation.y >= 60 ? 3 : 2;
      if (zone !== ev.points) flagged.push({ game, ev });
    });
  });
  return flagged;
}

let flaggedUndoTimer = null;

// Same grace-period Undo as Backfill's — puts a re-marked shot's location right back to
// wherever it was before this click.
function showFlaggedUndoToast(playerName, game, eventId, previousLocation) {
  const toast = document.getElementById("flaggedShotUndoToast");
  if (!toast) return;
  clearTimeout(flaggedUndoTimer);
  toast.innerHTML = `<span class="hint" style="margin:0">Location updated for ${escapeHtml(playerName)}'s shot.</span> <button type="button" class="icon-btn" data-undo-location="1">Undo</button>`;
  toast.querySelector("[data-undo-location]").addEventListener("click", () => {
    const ev = game.scoringEvents.find(e => e.id === eventId);
    if (ev) ev.shotLocation = previousLocation;
    saveState();
    clearTimeout(flaggedUndoTimer);
    renderFlaggedShotMismatches();
  });
  flaggedUndoTimer = setTimeout(() => { toast.innerHTML = ""; }, 8000);
}

// Grouped by game, same shape and video-loading approach as Backfill Shot Locations — each
// group loads its own video once so a shot can be re-marked against the actual play instead of
// from memory. Re-marking a shot that then agrees with its point value drops it from the list,
// the same "click removes just that row" pattern Backfill uses so other groups' video playback
// isn't disturbed; re-marking to a spot that's still flagged just redraws the dot in place.
function renderFlaggedShotMismatches() {
  const wrap = document.getElementById("flaggedShotMismatches");
  if (!wrap) return;
  const flagged = computeFlaggedShotMismatches();
  const byGame = {};
  flagged.forEach(({ game, ev }) => {
    (byGame[game.id] = byGame[game.id] || { game, shots: [] }).shots.push(ev);
  });
  const groups = Object.values(byGame).sort((a, b) => (a.game.date || "").localeCompare(b.game.date || ""));

  if (groups.length === 0) {
    wrap.innerHTML = '<p class="empty-state">No flagged shots. Every marked 2PT/3PT location agrees with its point value.</p>';
    return;
  }

  wrap.innerHTML = `<p class="hint flagged-summary" style="margin-top:0">${flagged.length} shot${flagged.length === 1 ? "" : "s"} flagged.</p><div id="flaggedShotUndoToast"></div>`;
  const summaryEl = wrap.querySelector(".flagged-summary");

  groups.forEach(({ game, shots }) => {
    const groupEl = document.createElement("div");
    groupEl.className = "backfill-game-group";
    groupEl.innerHTML = `<h4>${escapeHtml(formatDateDisplay(game.date))}</h4><div class="backfill-video-wrap"><p class="hint" style="margin:0">Loading video…</p></div>`;
    const videoWrap = groupEl.querySelector(".backfill-video-wrap");

    const rowsEl = document.createElement("div");
    rowsEl.className = "backfill-shot-rows";
    shots.forEach(ev => {
      const scorer = state.players.find(p => p.id === ev.scorerId);
      const hasTime = ev.videoTime !== null && ev.videoTime !== undefined;
      const zoneLabel = ev.shotLocation.y >= 60 ? "3PT range" : "2PT range";
      const row = document.createElement("div");
      row.className = "backfill-shot-row backfill-shot-row-marked";
      row.innerHTML = `
        <div class="backfill-shot-label">
          ${scorer ? playerLink(scorer.id, scorer.name) : "?"}: picked ${ev.points}pt, marked at 📍 ${zoneLabel}
        </div>
        <button type="button" class="secondary-btn" data-watch="1" ${hasTime ? "" : "disabled"}>▶ Watch</button>
        ${renderShotChartBaseSvg("data-shot-chart")}
      `;
      setShotChartDot(row.querySelector("[data-shot-chart]"), ev.shotLocation);
      row.querySelector("[data-watch]").addEventListener("click", () => {
        const video = videoWrap.querySelector("video");
        if (!video || !hasTime) return;
        video.currentTime = ev.videoTime;
        video.play();
      });
      row.querySelector("[data-shot-chart]").addEventListener("click", e => {
        const rect = e.currentTarget.getBoundingClientRect();
        const previousLocation = ev.shotLocation;
        const xFrac = Math.max(0, Math.min(100, ((e.clientX - rect.left) / rect.width) * 100));
        const yFrac = Math.max(0, Math.min(100, ((e.clientY - rect.top) / rect.height) * 100));
        ev.shotLocation = { x: xFrac, y: 100 - yFrac };
        saveState();
        showFlaggedUndoToast(scorer ? scorer.name : "?", game, ev.id, previousLocation);

        const stillFlagged = (ev.shotLocation.y >= 60 ? 3 : 2) !== ev.points;
        if (stillFlagged) {
          setShotChartDot(e.currentTarget, ev.shotLocation);
          return;
        }
        row.remove();
        if (!rowsEl.querySelector(".backfill-shot-row")) groupEl.remove();
        const left = Math.max(0, parseInt(summaryEl.textContent, 10) - 1);
        if (left <= 0) {
          summaryEl.textContent = "";
          if (!wrap.querySelector(".flagged-done-msg")) {
            const doneMsg = document.createElement("p");
            doneMsg.className = "empty-state flagged-done-msg";
            doneMsg.textContent = "No flagged shots. Every marked 2PT/3PT location agrees with its point value.";
            wrap.appendChild(doneMsg);
          }
        } else {
          summaryEl.textContent = `${left} shot${left === 1 ? "" : "s"} flagged.`;
        }
      });
      rowsEl.appendChild(row);
    });
    groupEl.appendChild(rowsEl);
    wrap.appendChild(groupEl);
    loadBackfillVideo(game, videoWrap);
  });
}

// A game's masterVideoId can go stale without anything in the tracker ever erroring — the
// video panel just falls back to "no video" behavior, which looks like a game that was never
// given a video rather than one whose reference broke. Surfacing this list is the only way to
// notice, since nothing else about using the app would ever reveal it.
function renderBrokenVideoLinks() {
  const wrap = document.getElementById("brokenVideoLinks");
  if (!wrap) return;
  const broken = state.games
    .filter(g => g.masterVideoId && !state.masterVideos.some(m => m.id === g.masterVideoId))
    .sort((a, b) => (a.date || "").localeCompare(b.date || ""));
  if (broken.length === 0) {
    wrap.innerHTML = '<p class="empty-state">No broken session video links found.</p>';
    return;
  }
  const table = document.createElement("table");
  table.className = "matchup-table";
  table.innerHTML = `<thead><tr><th>Game</th><th>Broken reference</th><th></th></tr></thead><tbody></tbody>`;
  const body = table.querySelector("tbody");
  broken.forEach(game => {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${escapeHtml(formatDateDisplay(game.date))}</td><td><code>${escapeHtml(game.masterVideoId)}</code></td>`;
    const tdBtn = document.createElement("td");
    const fixBtn = document.createElement("button");
    fixBtn.type = "button";
    fixBtn.className = "secondary-btn";
    fixBtn.textContent = "Open in Stat Entry to fix";
    fixBtn.addEventListener("click", () => openGame(game.id));
    tdBtn.appendChild(fixBtn);
    tr.appendChild(tdBtn);
    body.appendChild(tr);
  });
  wrap.innerHTML = "";
  wrap.appendChild(table);
}

function renderMasterVideoList() {
  const body = document.getElementById("masterVideoListBody");
  if (!body) return;
  body.innerHTML = "";
  if (state.masterVideos.length === 0) {
    body.innerHTML = '<tr><td colspan="3" class="empty-state">No session videos uploaded yet.</td></tr>';
    return;
  }
  state.masterVideos.forEach(m => {
    const usedByCount = state.games.filter(g => g.masterVideoId === m.id).length;
    const tr = document.createElement("tr");
    const fileNameHint = m.fileName ? ` <span class="hint" style="margin:0">(${escapeHtml(m.fileName)})</span>` : "";
    tr.innerHTML = `<td>${escapeHtml(m.name)}${fileNameHint}</td><td>${usedByCount} game${usedByCount === 1 ? "" : "s"}</td>`;
    const tdBtn = document.createElement("td");
    const delBtn = document.createElement("button");
    delBtn.className = "icon-btn";
    delBtn.textContent = "Remove";
    delBtn.addEventListener("click", async () => {
      if (!confirm(`Remove "${m.name}"? This clears it from ${usedByCount} game${usedByCount === 1 ? "" : "s"} using it.`)) return;
      state.games.forEach(g => {
        if (g.masterVideoId === m.id) { g.masterVideoId = null; g.videoStart = 0; }
      });
      state.masterVideos = state.masterVideos.filter(mv => mv.id !== m.id);
      if (masterVideoBlobUrls[m.id]) {
        URL.revokeObjectURL(masterVideoBlobUrls[m.id]);
        delete masterVideoBlobUrls[m.id];
      }
      await deleteVideoFile(m.id);
      saveState();
      renderMasterVideoList();
      renderGames();
    });
    tdBtn.appendChild(delBtn);
    tr.appendChild(tdBtn);
    body.appendChild(tr);
  });
}

document.getElementById("importFileInput").addEventListener("change", e => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const imported = JSON.parse(reader.result);
      if (!imported.players || !imported.games) throw new Error("Missing expected fields");
      if (!confirm("This will replace all current data with the imported file. Continue?")) return;
      state = imported;
      state.masterVideos = state.masterVideos || [];
      state.seasonHistory = state.seasonHistory || [];
      state.currentSeasonStartedAt = state.currentSeasonStartedAt || null;
      (state.games || []).forEach(normalizeGame);
      saveState();
      renderPlayers();
      renderGames();
      showTab("players");
    } catch (err) {
      alert("Could not import file: " + err.message);
    }
  };
  reader.readAsText(file);
  e.target.value = "";
});

// Closes out the current season without deleting anything: pushes a labeled entry onto
// seasonHistory and moves currentSeasonStartedAt to today, which is all isQualifyingGame() and
// isCurrentSeasonGame() need to start treating every existing game as "past" instead of
// "current." Games/stats/matchups themselves are untouched — a player's numbers from the closed
// season stay fully intact and live-recomputed (see computeSeasonHistoryForPlayer(), Player
// Detail's Past Seasons panel), not a frozen snapshot that could go stale if a formula changes
// later. Only the locally-stored video blobs actually get deleted, since those are large and the
// point here is stats, not rewatchability — a past game's masterVideoId/local video reference
// just goes dangling, the same already-handled case Export → Broken Session Video Links exists
// for. The player roster was never touched by this in the first place, since it's one
// league-wide list, not scoped to any season. Doesn't touch the three hardcoded season-snapshot
// tables elsewhere in this file (AWARD_RESULTS, PARTY_RANKINGS, PLAYER_REPUTATION_DATA) — those
// still need a hand-edit for a new season; see README.md "Starting a new season" for the
// checklist.
document.getElementById("startNewSeasonBtn").addEventListener("click", async () => {
  const today = new Date().toISOString().slice(0, 10);
  const label = prompt('Name the season that\'s ending (shown on player profiles and the "Include Past Seasons" toggle), e.g. "Summer 2026":', "");
  if (label === null) return;
  if (!confirm("This archives every current game behind today's date and clears locally-stored video files. Games, stats, the player roster, and every player's height/build/role tags are all kept. A backup file downloads first. Continue?")) return;
  downloadBackup();
  state.seasonHistory.push({ label: label.trim() || `Season ending ${today}`, startedAt: state.currentSeasonStartedAt, endedAt: today });
  state.currentSeasonStartedAt = today;
  saveState();
  const videoIds = await getAllStoredVideoIds();
  for (const id of videoIds) await deleteVideoFile(id);
  state.masterVideos = [];
  saveState();
  currentGameId = null;
  currentPlayerId = null;
  renderPlayers();
  renderGames();
  showTab("games");
});

document.getElementById("resetDataBtn").addEventListener("click", () => {
  if (!confirm("This will permanently delete all players, games, and stats. A backup file downloads first. Continue?")) return;
  downloadBackup();
  state = { players: [], games: [], masterVideos: [], seasonHistory: [], currentSeasonStartedAt: null, playerPhysicalOverrides: {}, rsvps: [] };
  saveState();
  renderPlayers();
  renderGames();
});

function escapeHtml(str) {
  return String(str ?? "").replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}

// A player's name, wherever it's shown read-only (tables, lists, tips, chart keys), as a link to
// their Player Detail page. One shared delegated click handler (wirePlayerNameLinks(), called once
// at load) covers every use of this instead of each render function wiring its own listener.
// Deliberately NOT used in Stat Entry's live tagging pickers, roster/Balance Teams editing, RSVP,
// or any <select>/<option> — those need the click for something other than navigation.
function playerLink(id, name, showAvatar = true) {
  const player = showAvatar ? state.players.find(p => p.id === id) : null;
  const avatar = player ? renderPlayerAvatar(player, "small") : "";
  return `<button type="button" class="icon-btn player-name-link" data-player-link="${id}">${avatar}${escapeHtml(name)}</button>`;
}
function wirePlayerNameLinks() {
  document.addEventListener("click", e => {
    const btn = e.target.closest("[data-player-link]");
    if (btn) openPlayerDetail(btn.dataset.playerLink);
  });
}

// Wraps every panel's explanatory paragraph (the <p class="hint"> immediately after a panel's
// <h2>) in a collapsed <details>/<summary> — the app has grown enough panels that a page full of
// always-visible explainer paragraphs was more wall-of-text than helpful; each one's still there
// on demand, just collapsed by default. Runs once against the static index.html structure (these
// h2/hint pairs are never rebuilt via innerHTML by any render function, unlike the dynamic
// content living in the sibling divs after them), so a single pass at load covers every panel,
// current and future, without hand-editing each one's markup.
function collapseSectionHints() {
  document.querySelectorAll(".panel > h2").forEach(h2 => {
    const hint = h2.nextElementSibling;
    if (!hint || !hint.classList.contains("hint")) return;
    const details = document.createElement("details");
    details.className = "hint-details";
    details.appendChild(document.createElement("summary"));
    h2.after(details);
    details.appendChild(hint);
  });
}

// ---------- Real Poolean data: what changed since last import ----------
// poolean-external-data.js gets manually regenerated and copied in every so often (see
// build_poolean_data.py); there's no server to diff old vs. new for you. So this browser
// remembers the last snapshot it saw (localStorage, not app state — purely a per-browser "have I
// seen this" marker, never exported/shared) and, on the load right after a refreshed file lands,
// shows what moved: games played, win-loss, power ranking %, crowns. Silent when nothing's
// changed (including the very first time this browser has ever seen the file) — no banner to
// dismiss when there's nothing to say.
const POOL_DATA_SNAPSHOT_KEY = "poolDataSnapshot";
function computePoolDataDigest() {
  // Always the latest season's cards (the header picker may be showing an older season).
  if (typeof POOLEAN_SEASONS === "undefined" || typeof POOLEAN_SEASON_LIST === "undefined") return null;
  const latest = String(POOLEAN_SEASON_LIST[POOLEAN_SEASON_LIST.length - 1]);
  const latestCards = POOLEAN_SEASONS[latest].cards;
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(POOL_DATA_SNAPSHOT_KEY) || "null"); } catch (e) { saved = null; }
  try { localStorage.setItem(POOL_DATA_SNAPSHOT_KEY, JSON.stringify({ season: latest, cards: latestCards })); } catch (e) { /* storage full/blocked: digest just won't have a next-time comparison */ }
  if (!saved) return null; // first time this browser's seen real data at all -- nothing to compare against
  // Snapshots saved before seasons existed are a bare cards object from the 2026 season.
  const savedSeason = saved.season ? String(saved.season) : "2026";
  const previous = saved.season ? saved.cards : saved;
  if (savedSeason !== latest) return [{ newSeason: latest }];
  const changes = [];
  Object.entries(latestCards).forEach(([slug, now]) => {
    const before = previous[slug];
    if (!before) { changes.push({ slug, isNew: true }); return; }
    const gpDelta = now.parties - before.parties;
    const gamesDelta = (now.w + now.l) - (before.w + before.l);
    const powerDelta = now.powerPct - before.powerPct;
    const crownsDelta = now.crowns - before.crowns;
    if (gpDelta || gamesDelta || powerDelta || crownsDelta) changes.push({ slug, gpDelta, gamesDelta, powerDelta, crownsDelta });
  });
  return changes.length > 0 ? changes : null;
}
function renderPoolDataDigest() {
  const wrap = document.getElementById("poolDataDigest");
  if (!wrap) return;
  const changes = computePoolDataDigest();
  if (!changes) { wrap.innerHTML = ""; return; }
  const rows = changes.map(c => {
    if (c.newSeason) return `<li>The ${c.newSeason} season was just imported. Use the season picker at the top to look back at earlier seasons.</li>`;
    const name = poolPlayerLink(c.slug);
    if (c.isNew) return `<li>${name}: new in this import</li>`;
    const bits = [];
    if (c.gamesDelta) bits.push(`${c.gamesDelta > 0 ? "+" : ""}${c.gamesDelta} game${Math.abs(c.gamesDelta) === 1 ? "" : "s"}`);
    if (c.powerDelta) bits.push(`power ${c.powerDelta > 0 ? "+" : ""}${c.powerDelta.toFixed(1)}%`);
    if (c.crownsDelta) bits.push(`${c.crownsDelta > 0 ? "+" : ""}${c.crownsDelta} crown${Math.abs(c.crownsDelta) === 1 ? "" : "s"}`);
    return `<li>${name}: ${bits.join(", ") || "updated"}</li>`;
  }).join("");
  wrap.innerHTML = `<div class="award-marquee" style="background:none;border-color:color-mix(in srgb, var(--accent) 45%, transparent)">
    <span class="award-marquee-icon">🔄</span>
    <span class="award-marquee-text" style="flex:1">
      <strong style="color:var(--accent)">Real site data updated</strong>
      <span style="text-transform:none;letter-spacing:0;color:var(--fg);font-size:0.85rem;margin-top:4px">
        <ul style="margin:4px 0 0;padding-left:18px">${rows}</ul>
      </span>
    </span>
    <button type="button" class="icon-btn" data-dismiss-digest="1">Dismiss</button>
  </div>`;
  wrap.querySelector("[data-dismiss-digest]").addEventListener("click", () => { wrap.innerHTML = ""; });
}

// ---------- Init ----------
// Works offline once it's been opened with a connection (see sw.js). Needs https, or localhost
// for testing; the files this page already loaded are handed over so the first visit counts.
if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost")) {
  navigator.serviceWorker.register("sw.js").then(() => navigator.serviceWorker.ready).then(reg => {
    const urls = performance.getEntriesByType("resource").map(e => e.name)
      .filter(u => !/\.(mp4|mov|webm|m4v)(\?|$)/i.test(u));
    reg.active?.postMessage({ cacheUrls: [location.href.split("#")[0], ...urls] });
  }).catch(() => { /* offline support is a bonus; the app works without it */ });
}
// Sticky bars under the header (section nav, sidebar) sit at the header's real height, which
// changes with screen width and wrapping, instead of a fixed guess.
(function trackHeaderHeight() {
  const header = document.querySelector(".app-header");
  if (!header) return;
  const set = () => document.documentElement.style.setProperty("--header-h", `${header.offsetHeight}px`);
  set();
  if (window.ResizeObserver) new ResizeObserver(set).observe(header);
})();
collapseSectionHints();
wirePlayerSectionNav();
wireLeaderboardSectionNav();
wirePlayerNameLinks();
renderPoolDataDigest();
initPooleanSeasonPicker();
renderPlayers();
document.getElementById("rsvpDateInput").value = new Date().toISOString().slice(0, 10);
loadRsvpForDate(document.getElementById("rsvpDateInput").value);
renderGames();
if (liveGameEnabled() && liveGameInProgress()) openLiveGameOverlay();

// Land back on whatever was in view last time, instead of always resetting to Games — a
// browser refresh (or just reopening the file) shouldn't feel like navigating to a new page.
(function restoreLastView() {
  // A shared link (#game=<id> or #player=<id>, see the Share buttons on the Games list and
  // Player Detail) always wins over whatever this browser last happened to have open — someone
  // clicking a link a friend sent wants that specific thing, not wherever they personally left
  // off last time.
  const sharedGameId = location.hash.match(/^#game=(.+)$/)?.[1];
  if (sharedGameId && state.games.some(g => g.id === decodeURIComponent(sharedGameId))) {
    openGame(decodeURIComponent(sharedGameId));
    return;
  }
  const sharedPlayerId = location.hash.match(/^#player=(.+)$/)?.[1];
  if (sharedPlayerId && state.players.some(p => p.id === decodeURIComponent(sharedPlayerId))) {
    openPlayerDetail(decodeURIComponent(sharedPlayerId));
    return;
  }
  let ui = null;
  try { ui = JSON.parse(localStorage.getItem(UI_STATE_KEY)); } catch (e) { /* corrupt/missing, ignore */ }
  if (ui && ui.tab === "stats" && ui.gameId && state.games.some(g => g.id === ui.gameId)) {
    openGame(ui.gameId);
  } else if (ui && ui.tab === "player" && ui.playerId && state.players.some(p => p.id === ui.playerId)) {
    openPlayerDetail(ui.playerId);
  } else if (ui && ["players", "games", "leaderboard", "export"].includes(ui.tab)) {
    showTab(ui.tab);
  } else {
    showTab("games");
  }
})();
