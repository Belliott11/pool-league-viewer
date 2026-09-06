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

  // Best TS% in games decided by CLUTCH_MARGIN_THRESHOLD points or fewer — needs at least 5
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
      detail: `${topDuo.count} assist${topDuo.count === 1 ? "" : "s"} to ${escapeHtml(topDuo.scorer.name)}` });
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
  if (tab === "export") { renderExportGameSelect(); renderMasterVideoList(); renderBrokenVideoLinks(); renderBackfillShotLocations(); renderFlaggedShotMismatches(); }
  if (tab === "leaderboard") renderLeaderboard();
  // Refreshes the attendee picker against the current roster — cheap, and a player added while
  // on a different tab shouldn't require a page reload to show up here.
  if (tab === "games") {
    renderBalanceAttendeePicker();
    renderBalanceRsvpDateSelect();
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
function renderPlayerAvatar(player, size = "normal") {
  if (!player) return "";
  const photoFile = PLAYER_PHOTO_FILES[player.id];
  if (photoFile) {
    return `<img src="photos/${photoFile}" alt="" class="player-avatar player-avatar-${size}">`;
  }
  const initial = (player.name.trim().charAt(0) || "?").toUpperCase();
  const hue = avatarHueForPlayer(player.id);
  return `<span class="player-avatar player-avatar-${size}" style="background:hsl(${hue}, 55%, 42%)">${escapeHtml(initial)}</span>`;
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
      ? `Effort: ${EFFORT_LABELS[phys.effort]}${phys.note ? " — " + phys.note : ""}`
      : (phys?.note || "");
    const tagsTitle = tagsTitleText ? ` title="${escapeHtml(tagsTitleText)}"` : "";
    const tagsHtml = tags.length > 0
      ? `<span class="profile-tags"${tagsTitle}>${tags.map(t => `<span class="profile-tag profile-tag-${t.kind}">${escapeHtml(t.label)}</span>`).join("")}</span>`
      : "";
    row.innerHTML = `<span class="roster-row-name">${renderPlayerAvatar(p)}${escapeHtml(p.name)}${tagsHtml}</span>`;

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
      statusHtml = ' <span class="badge">Pending — no game logged yet</span>';
    } else {
      const missed = r.playerIds.filter(id => !playerAttendedDate(id, r.date));
      statusHtml = missed.length === 0
        ? ' <span class="badge badge-highlight">Everyone showed</span>'
        : ` <span class="badge badge-lowlight">${missed.length} missed: ${escapeHtml(missed.map(id => state.players.find(p => p.id === id)?.name || "?").join(", "))}</span>`;
    }
    return `<div class="roster-row">
      <span>${escapeHtml(formatDateDisplay(r.date))} — ${escapeHtml(names.join(", ") || "nobody")}${statusHtml}</span>
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

function renderGames() {
  renderNeedsReviewSummary();
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
    const scoreA = teamScore(game, game.teamA);
    const scoreB = teamScore(game, game.teamB);
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
      : ` <span class="badge badge-imbalanced" title="Team A has ${game.teamA.length}, Team B has ${game.teamB.length} — excluded from Leaderboard rates and every other computed comparison unless the Include Imbalanced Games toggle on the Leaderboard is on.">⚖️ ${game.teamA.length}v${game.teamB.length}</span>`;
    const pastSeasonBadge = isCurrentSeasonGame(game)
      ? ""
      : ` <span class="badge badge-past-season" title="From a season closed out before this one — excluded from Leaderboard rates and every other computed comparison unless the Include Past Seasons toggle on the Leaderboard is on. See Player Detail's Past Seasons panel for that season's own final numbers.">📅 Past Season</span>`;
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
        starBadge = ` <span class="badge badge-highlight" title="Best individual performance this game by Two-Way score.">🔥 ${escapeHtml(best.player.name)} ${best.twoWay >= 0 ? "+" : ""}${best.twoWay.toFixed(1)}</span>`;
        if (worst.player.id !== best.player.id) {
          coldBadge = ` <span class="badge badge-lowlight" title="Worst individual performance this game by Two-Way score.">👎 ${escapeHtml(worst.player.name)} ${worst.twoWay >= 0 ? "+" : ""}${worst.twoWay.toFixed(1)}</span>`;
        }
      }
    }
    const teamANames = game.teamA.map(id => state.players.find(p => p.id === id)?.name).filter(Boolean).join(", ") || "Team A";
    const teamBNames = game.teamB.map(id => state.players.find(p => p.id === id)?.name).filter(Boolean).join(", ") || "Team B";
    card.innerHTML = `
      <div>
        <div class="matchup-line">${escapeHtml(teamANames)} ${scoreA} — ${scoreB} ${escapeHtml(teamBNames)}</div>
        <div class="date-line">${formatDateDisplay(game.date)} · ${game.teamA.length + game.teamB.length} players${game.notes ? " · " + escapeHtml(game.notes) : ""}${videoBadge}${reviewBadge}${imbalancedBadge}${pastSeasonBadge}${starBadge}${coldBadge}</div>
      </div>
    `;
    const delBtn = document.createElement("button");
    delBtn.className = "icon-btn";
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
// to about 1 point of Two-Way/20, so a dominant 100th-percentile reputation (Phillip) lands
// around +5 rather than some inflated outlier. A single adjustable constant, not a UI setting,
// same pattern as every other judgment-call threshold in this tool (CLUTCH_MARGIN_THRESHOLD,
// SECOND_CHANCE_WINDOW_SECONDS, etc.) — revisit if it turns out to under- or over-weight
// reputation once more of these players actually get logged film.
function estimatedQualityFromReputation(avgPercentile) {
  return (avgPercentile - 50) / 10;
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
        ? { quality: estimatedQualityFromReputation(rep.avgPercentile), source: "reputation", avgPercentile: rep.avgPercentile, parties: rep.parties }
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
        ? `No dashboard stats yet — estimated from a ${q.avgPercentile}th percentile power ranking (${q.parties} part${q.parties === 1 ? "y" : "ies"}), not logged film`
        : "No dashboard stats or power ranking data — counted as a neutral average";
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
function scoreTeamSet(teams, qualityById, liftMap, winRateMap) {
  const avgs = teams.map(team => {
    const base = team.reduce((sum, id) => sum + (qualityById[id] || 0), 0) / team.length;
    return base + teamChemistryAdjustment(team, liftMap).value + teamWinRateAdjustment(team, winRateMap).value;
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
function computeTeamWinRateMap(attendeeIds) {
  const map = {};
  const qualifyingGames = state.games.filter(isQualifyingGame);
  for (let i = 0; i < attendeeIds.length; i++) {
    for (let j = i + 1; j < attendeeIds.length; j++) {
      const [a, b] = [attendeeIds[i], attendeeIds[j]];
      let wins = 0, losses = 0, ties = 0;
      qualifyingGames.forEach(g => {
        const together = (g.teamA.includes(a) && g.teamA.includes(b)) || (g.teamB.includes(a) && g.teamB.includes(b));
        if (!together) return;
        const result = playerGameResult(g, a); // same team, so same result for b
        if (result === "W") wins++;
        else if (result === "L") losses++;
        else if (result === "T") ties++;
      });
      const gp = wins + losses + ties;
      if (gp === 0) continue;
      const winPct = ((wins + ties * 0.5) / gp) * 100;
      const confidence = Math.min(1, gp / 3);
      map[`${a}|${b}`] = { value: ((winPct - 50) / 10) * confidence, gp };
    }
  }
  return map;
}

// Average of every known pairwise win-rate adjustment among this team's own players — symmetric
// lookup, so unlike teamChemistryAdjustment() this only needs each unordered pair once. minGp
// carried the same way and for the same reason as teamChemistryAdjustment()'s own.
function teamWinRateAdjustment(team, winRateMap) {
  if (team.length < 2) return { value: 0, minGp: null };
  let sum = 0, count = 0, minGp = null;
  for (let i = 0; i < team.length; i++) {
    for (let j = i + 1; j < team.length; j++) {
      const key = team[i] < team[j] ? `${team[i]}|${team[j]}` : `${team[j]}|${team[i]}`;
      const entry = winRateMap[key];
      if (entry !== undefined) {
        sum += entry.value;
        count++;
        minGp = minGp === null ? entry.gp : Math.min(minGp, entry.gp);
      }
    }
  }
  return { value: count > 0 ? sum / count : 0, minGp };
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
function localSearchRefine(teams, qualityById, liftMap, winRateMap, iterations) {
  if (teams.length < 2) return teams;
  let current = teams.map(t => [...t]);
  let currentSpread = scoreTeamSet(current, qualityById, liftMap, winRateMap).spread;
  for (let iter = 0; iter < iterations; iter++) {
    const ti = Math.floor(Math.random() * current.length);
    let tj = Math.floor(Math.random() * current.length);
    if (tj === ti) tj = (tj + 1) % current.length;
    if (current[ti].length === 0 || current[tj].length === 0) continue;
    const pi = Math.floor(Math.random() * current[ti].length);
    const pj = Math.floor(Math.random() * current[tj].length);
    const candidate = current.map(t => [...t]);
    [candidate[ti][pi], candidate[tj][pj]] = [candidate[tj][pj], candidate[ti][pi]];
    const candidateSpread = scoreTeamSet(candidate, qualityById, liftMap, winRateMap).spread;
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
    scored.push({ teams, ...scoreTeamSet(teams, qualityById, liftMap, winRateMap) });
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
    const improvedTeams = localSearchRefine(entry.teams, qualityById, liftMap, winRateMap, 25);
    const sig = teamSetSignature(improvedTeams);
    if (refinedSeen.has(sig)) return;
    refinedSeen.add(sig);
    refined.push({ teams: improvedTeams, ...scoreTeamSet(improvedTeams, qualityById, liftMap, winRateMap) });
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

  // "Every team needs someone above today's average height" is a strong guideline, not a hard
  // rule — it only gets to decide between options that are already practically tied on quality
  // (the same tolerance window physical/role uses), and even there it's checked before
  // physicalScore, not folded into it, since it's the more important of the two. A genuinely
  // better-balanced split outside that tolerance window still wins even if it fails the height
  // check — this never excludes a candidate outright, just ranks it behind an equally-fair one
  // that also clears the bar.
  const avgAttendeeHeight = averageAttendeeHeight(attendeeIds);
  const pool = refined.slice(0, 30);
  pool.sort((a, b) => {
    if (Math.abs(a.spread - b.spread) <= tieTolerance) {
      const aTall = a.teams.every(team => teamHasAboveAverageHeight(team, avgAttendeeHeight));
      const bTall = b.teams.every(team => teamHasAboveAverageHeight(team, avgAttendeeHeight));
      if (aTall !== bTall) return aTall ? -1 : 1;
      return a.physicalScore - b.physicalScore;
    }
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
    <table class="matchup-table balance-preview-table">
      <thead><tr><th>Scorer</th><th>Defender</th><th>FG</th><th>FG%</th></tr></thead>
      <tbody>${rowsHtml}</tbody>
    </table>
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
      const winGamesNote = winAdj.minGp !== null ? ` (min ${winAdj.minGp} game${winAdj.minGp === 1 ? "" : "s"} together)` : "";
      const winLine = Math.abs(winAdj.value) >= 0.1
        ? `<div class="balance-team-physical" title="Two-Way/20-scale adjustment from this pairing's actual win rate in past games together, already included in the avg above.">Past record: ${winAdj.value >= 0 ? "+" : ""}${winAdj.value.toFixed(1)}${winGamesNote}</div>`
        : "";
      return `
        <div class="balance-team-card">
          <h5><span>Team ${String.fromCharCode(65 + ti)}</span><span class="balance-team-avg">${r.avgs[ti].toFixed(1)} avg</span></h5>
          <ul>${team.map(id => {
            const name = state.players.find(p => p.id === id)?.name || "?";
            const marker = qualityMap[id]?.source === "reputation" ? " *" : "";
            const phys = getPlayerPhysicalData(id);
            const roleLabel = phys ? phys.roles.map(r => PHYSICAL_ROLE_LABELS[r]).join("/") : "";
            const effortLabel = phys?.effort !== undefined ? `${EFFORT_LABELS[phys.effort]} effort, ` : "";
            const titleText = phys ? `${formatHeightIn(phys.heightIn)}, ${BUILD_LABELS[phys.build]}, ${effortLabel}${roleLabel}${phys.note ? " — " + phys.note : ""}` : "";
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
         <button type="button" class="secondary-btn balance-use-btn" data-index="${i}">Use These Teams &rarr; Create Game</button>`
      : "";
    const previewHtml = r.teams.length === 2
      ? `<div class="balance-preview-wrap" id="balancePreview${i}" hidden>${renderMatchupPreviewTable(r.teams[0], r.teams[1])}</div>`
      : "";
    return `
      <div class="balance-option ${i === 0 ? "balance-option-best" : ""}">
        <div class="balance-option-header">
          <strong>${i === 0 ? "🏆 Most Balanced" : `Option ${i + 1}`}</strong>
          <span class="balance-spread">Δ${r.spread.toFixed(1)} Two-Way/20 between strongest and weakest team</span>
        </div>
        <div class="balance-teams-row">${teamsHtml}</div>
        ${buttonsHtml}
        ${previewHtml}
      </div>
    `;
  }).join("") + (anyEstimated
    ? '<p class="hint" style="margin:0">* No dashboard stats yet — quality estimated from real power-ranking reputation (see the attendee picker above for each one\'s percentile), not logged film.</p>'
    : "");
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
    <p class="hint" style="margin:0">${withLocation.length} of ${allFieldGoals.length} field goal${allFieldGoals.length === 1 ? "" : "s"} plotted${missing > 0 ? ` — ${missing} still missing a location` : ""}.</p>
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
  const dotsSvg = shots.map(ev => {
    const cx = shotChartVbX(ev.shotLocation.x);
    const cy = shotChartVbY(ev.shotLocation.y);
    const cls = ev.made !== false ? "shot-dot-make" : "shot-dot-miss";
    return `<circle cx="${cx}" cy="${cy}" r="2.2" class="${cls}" />`;
  }).join("");
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
    </div>
  `;
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

// Where a 3PT attempt splits into "Line" (a normal three, right at the line — Poolean's three
// is straight, not a curved arc, hence "Line" rather than "Arc" — the returned value stays
// "arc" internally, only the displayed label changed) vs. "Deep" (a much lower-percentage
// near-pool-length heave) — the single blended "3PT%" number was making a real, makeable line
// three look worse than it is and a heave look better than it is. Drawn from a small early
// sample (41 total 3PT attempts logged when this threshold was introduced), not a settled rule —
// a single easy-to-find constant so it's easy to revisit as more games get logged, deliberately
// not a UI setting for a one-operator tool. Only ever applied within the 3PT bucket — the
// 2PT/3PT boundary itself (the actual 3pt line, at 60% depth) doesn't change.
const THREE_PT_DEEP_THRESHOLD = 80;
// Same idea, one level closer to the hoop: splits the 2PT bucket into "Close" and "Midrange" at
// the midpoint of the 2PT zone (y: 0-60, so 30). Unlike THREE_PT_DEEP_THRESHOLD, this wasn't
// derived from a season's worth of logged 2PT attempts — there isn't the shot volume yet to draw
// a real breakpoint from — so treat this one as an even rougher starting guess, equally easy to
// revisit here as the single constant it is.
const CLOSE_RANGE_THRESHOLD = 30;
function shotBand(loc, points) {
  const distance = shotDistanceFromHoop(loc);
  if (points === 3) return distance > THREE_PT_DEEP_THRESHOLD ? "deep" : "arc";
  return distance > CLOSE_RANGE_THRESHOLD ? "mid" : "close";
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
  return {
    fgm: fg.filter(made).length, fga: fg.length,
    tpm: three.filter(made).length, tpa: three.length,
    ftm: ft.filter(made).length, fta: ft.length,
    closeM: close.filter(made).length, closeA: close.length,
    midM: mid.filter(made).length, midA: mid.length,
    tpArcM: threeArc.filter(made).length, tpArcA: threeArc.length,
    tpDeepM: threeDeep.filter(made).length, tpDeepA: threeDeep.length
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

function formatPct(v) {
  return v === null ? "—" : `${v}%`;
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

// { playerId, kind: "tov"|"stl"|"pf" } while waiting for the user to tag the one opponent
// involved (unlike shot defenders, these are single-select and commit immediately on click —
// a turnover/steal/foul only ever involves one other player, no double-teams to account for).
let pendingTag = null;

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
  `;

  renderVideoPanel(game);
  renderRosterAssignment(game);
  renderBoxScore(game);
  renderGameStatsTable(game);
  renderScoringLog(game);
  renderOtherEventsLog(game);
  renderMatchupForm(game);
  renderMatchupTable(game);
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
    body.innerHTML = '<tr><td colspan="6" class="empty-state">No turnovers, steals, or fouls recorded yet.</td></tr>';
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
    tdJump.appendChild(createJumpButton(ev.videoTime));
    tr.appendChild(tdJump);
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
      <div class="stat-label">Editing ${scorer ? escapeHtml(scorer.name) : "?"}'s ${made ? "make" : "miss"} — defender/assist/block/rebound only</div>
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
        ${ev.turnoverEventId ? '<p class="hint" style="margin:6px 0 0">This miss is marked out of bounds, so it has no rebounder — remove and re-log it if that\'s wrong.</p>' : `
          <div class="stat-label" style="margin-top:6px">Rebounded by?</div>
          <div class="defender-pick-list">
            <button type="button" class="secondary-btn${!editRebounder ? " selected" : ""}" data-edit-norebound="1">No rebound tracked</button>
            <button type="button" class="secondary-btn${editRebounder === ev.scorerId ? " selected" : ""}" data-edit-rebound="${ev.scorerId}">${scorer ? escapeHtml(scorer.name) : "?"} (self)</button>
            ${teammates.map(t => `<button type="button" class="secondary-btn${editRebounder === t.id ? " selected" : ""}" data-edit-rebound="${t.id}">${escapeHtml(t.name)}</button>`).join("")}
            ${opponents.map(o => `<button type="button" class="secondary-btn${editRebounder === o.id ? " selected" : ""}" data-edit-rebound="${o.id}">${escapeHtml(o.name)} (opp)</button>`).join("")}
          </div>
        `}
      `}
      <div class="confirm-row">
        <button type="button" class="highlight-btn confirm-btn" data-edit-save="1">✓ Save</button>
        <button type="button" class="secondary-btn" data-edit-cancel="1">Cancel</button>
      </div>
    </td>
  `;
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
      tr.querySelector("[data-edit-norebound]").addEventListener("click", () => { editRebounder = null; renderScoringLog(game); });
      tr.querySelectorAll("[data-edit-rebound]").forEach(b => {
        b.addEventListener("click", () => { editRebounder = editRebounder === b.dataset.editRebound ? null : b.dataset.editRebound; renderScoringLog(game); });
      });
    }
  }
  tr.querySelector("[data-edit-save]").addEventListener("click", () => {
    ev.defenderIds = [...editDefenders];
    if (made) {
      ev.assistId = editAssist;
    } else {
      ev.blockerId = editBlocker;
      if (!ev.turnoverEventId) ev.rebounderId = editRebounder;
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
  body.innerHTML = "";
  if (game.scoringEvents.length === 0) {
    body.innerHTML = '<tr><td colspan="8" class="empty-state">No shots recorded yet.</td></tr>';
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
    if (blocker) resultBadge += ` <span class="badge">Blocked: ${escapeHtml(blocker.name)}</span>`;
    if (ev.turnoverEventId) resultBadge += ' <span class="badge">Out of bounds → TOV</span>';
    if (rebounder) {
      const kind = sameTeam(game, ev.scorerId, rebounder.id) ? "OREB" : "DREB";
      resultBadge += ` <span class="badge">${kind}: ${escapeHtml(rebounder.name)}</span>`;
    }
    if (ev.shotLocation) {
      const zone = ev.shotLocation.y >= 60 ? "3PT range" : "2PT range";
      resultBadge += ` <span class="badge">📍 ${zone}</span>`;
    }
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${scorer ? escapeHtml(scorer.name) : "?"}</td>
      <td>${resultBadge}</td>
      <td>${ev.points}</td>
      <td>${assister ? escapeHtml(assister.name) : "—"}</td>
      <td>${defenderNames(ev.defenderIds)}</td>
      <td>${formatVideoTime(ev.videoTime)}</td>
    `;
    const tdJump = document.createElement("td");
    tdJump.appendChild(createJumpButton(ev.videoTime));
    tr.appendChild(tdJump);
    const tdBtn = document.createElement("td");
    const editBtn = document.createElement("button");
    editBtn.className = "icon-btn";
    editBtn.textContent = editingShotId === ev.id ? "Editing…" : "Edit";
    editBtn.disabled = editingShotId === ev.id;
    editBtn.title = "Fix the tagged defender, assist, block, or rebound — not make/miss, points, or out-of-bounds";
    editBtn.addEventListener("click", () => {
      editingShotId = ev.id;
      editDefenders = new Set(ev.defenderIds || []);
      editAssist = ev.assistId;
      editBlocker = ev.blockerId;
      editRebounder = ev.rebounderId;
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
  select.innerHTML = '<option value="">— None (use a video just for this game) —</option>' +
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
          <div class="stat-label">Who was ${verb}? (${pendingScore.isMiss ? "miss" : "+"}${pendingScore.points}) — ${escapeHtml(label)}</div>
          <div class="defender-pick-list">
            <button type="button" class="secondary-btn${pendingDefenders.size === 0 ? " selected" : ""}" data-nodefender="1">No defender</button>
            ${opponents.map(o => `<button type="button" class="secondary-btn${pendingDefenders.has(o.id) ? " selected" : ""}" data-defender="${o.id}">${escapeHtml(o.name)}</button>`).join("")}
          </div>
          ${pendingScore.points === 1 ? "" : `
            <div class="stat-label" style="margin-top:6px">Where was it from? ${pendingShotLocation ? "" : "— not marked"}</div>
            <div class="shot-chart-wrap">
              ${renderShotChartBaseSvg("data-shot-chart")}
              <button type="button" class="icon-btn" data-clear-location="1">Clear location</button>
            </div>
          `}
          ${pendingScore.isMiss ? `
            <div class="stat-label" style="margin-top:6px">Blocked by? — ${blocker ? escapeHtml(blocker.name) : "No block"}</div>
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
              <div class="stat-label" style="margin-top:6px">Rebounded by? — ${rebounder ? escapeHtml(rebounder.name) : "No rebound tracked"}</div>
              <div class="defender-pick-list">
                <button type="button" class="secondary-btn${!pendingRebounder ? " selected" : ""}" data-norebound="1">No rebound tracked</button>
                <button type="button" class="secondary-btn${pendingRebounder === pid ? " selected" : ""}" data-rebound="${pid}">${escapeHtml(p.name)} (self)</button>
                ${teammates.map(t => `<button type="button" class="secondary-btn${pendingRebounder === t.id ? " selected" : ""}" data-rebound="${t.id}">${escapeHtml(t.name)}</button>`).join("")}
                ${opponents.map(o => `<button type="button" class="secondary-btn${pendingRebounder === o.id ? " selected" : ""}" data-rebound="${o.id}">${escapeHtml(o.name)} (opp)</button>`).join("")}
              </div>
            `}
          ` : `
            <div class="stat-label" style="margin-top:6px">Assisted by? — ${assister ? escapeHtml(assister.name) : "No assist"}</div>
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
    ? `${pf} <span class="badge badge-lowlight" title="${FOUL_OUT_THRESHOLD} fouls — ejected for the rest of this game">🚫 OUT</span>`
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
      <td class="sticky-col">${escapeHtml(r.player.name)}</td>
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

function updateReelButtons() {
  const hBtn = document.getElementById("markHighlightBtn");
  const lBtn = document.getElementById("markLowlightBtn");
  if (!hBtn || !lBtn) return;
  const enabled = !!currentVideoEl;
  hBtn.disabled = !enabled;
  lBtn.disabled = !enabled;
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
// tab. Output is .webm, MediaRecorder's one broadly-supported container; there's no in-browser
// path to .mp4 without the ffmpeg.wasm dependency this tool deliberately doesn't carry.
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

function pickRecorderMimeType() {
  const candidates = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"];
  return candidates.find(t => window.MediaRecorder && MediaRecorder.isTypeSupported(t)) || "";
}

// Resolves once the video has actually reached `time`, not just once currentTime is set —
// seeking on a real (especially large local-file) video is asynchronous.
function waitForSeek(video, time) {
  return new Promise(resolve => {
    if (Math.abs(video.currentTime - time) < 0.05) { resolve(); return; }
    const onSeeked = () => { video.removeEventListener("seeked", onSeeked); resolve(); };
    video.addEventListener("seeked", onSeeked);
    video.currentTime = time;
  });
}

// Polls on a plain interval rather than requestAnimationFrame — rAF callbacks are suspended
// entirely (not just throttled) on a page that isn't actually visible, which would hang this
// forever if the tab gets backgrounded mid-export instead of just running late.
function waitUntilTime(video, endTime) {
  return new Promise(resolve => {
    const interval = setInterval(() => {
      if (video.currentTime >= endTime || video.ended) {
        clearInterval(interval);
        resolve();
      }
    }, 50);
  });
}

// Wraps a promise so a cancel click can interrupt it even mid-flight — a video.play() call that
// never settles (blocked autoplay policy, a stalled/buffering source, whatever the cause)
// otherwise leaves the whole export stuck with no way out except reloading the page.
function raceCancel(promise, cancelPromise) {
  return Promise.race([promise.then(() => "done"), cancelPromise.then(() => "cancelled")]);
}

async function exportReelVideo(game) {
  if (!currentVideoEl || reelExportState) return;
  const clips = reelClipsChronological(game);
  if (clips.length === 0) return;
  const mimeType = pickRecorderMimeType();
  const statusEl = document.getElementById("reelExportStatus");
  if (!mimeType) {
    statusEl.textContent = "This browser doesn't support recording video — try a recent Chrome or Firefox.";
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
        stoppedEarly = `Clip ${i + 1} of ${clips.length} didn't start playing — stopped there.`;
        break;
      }

      const waitOutcome = await raceCancel(waitUntilTime(video, clips[i].end), cancelPromise);
      video.pause();
      recorder.pause();
      if (waitOutcome === "cancelled") break;
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
    statusEl.textContent = "Cancelled — nothing downloaded.";
  } else if (chunks.length === 0) {
    statusEl.textContent = stoppedEarly || "Recording produced no data — try again.";
  } else {
    const blob = new Blob(chunks, { type: mimeType });
    download(`${game.date || "game"}-highlights.webm`, blob, mimeType);
    const clipWord = clips.length === 1 ? "clip" : "clips";
    statusEl.textContent = stoppedEarly
      ? `${stoppedEarly} Downloaded what was recorded before that.`
      : `Done — ${clips.length} ${clipWord} combined and downloaded.`;
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
  body.innerHTML = "";
  if (game.matchups.length === 0) {
    body.innerHTML = '<tr><td colspan="6" class="empty-state">No matchups recorded yet.</td></tr>';
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
    tdJump.appendChild(createJumpButton(m.videoTime));
    tr.appendChild(tdJump);
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

// ---------- Leaderboard ----------
function computeLeaderboard() {
  return state.players.map(p => {
    // Only games actually logged with real shots count toward GP/averages — a game that's
    // just been rostered (or only carries a historical winner imported with no shot-level
    // detail, see playerGameResult()) has nothing to average, and counting it would drag
    // every average toward 0 for a game nobody has reviewed yet. qualifyingGamesForPlayer()
    // also excludes an imbalanced (e.g. 3-on-2) game unless includeImbalancedGames is toggled
    // on, and this player's own statistical outlier games if Exclude Outlier Games is on.
    const gamesPlayed = qualifyingGamesForPlayer(p.id);
    const totals = { pts: 0, oreb: 0, dreb: 0, ast: 0, stl: 0, blk: 0, tov: 0, pf: 0 };
    const shooting = { fgm: 0, fga: 0, tpm: 0, tpa: 0, closeM: 0, closeA: 0, midM: 0, midA: 0, tpArcM: 0, tpArcA: 0, tpDeepM: 0, tpDeepA: 0, ftm: 0, fta: 0 };
    const defense = { ptsAllowed: 0, timesBeaten: 0, stops: 0, blocksNotAlreadyStopped: 0 };
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
    <table class="matchup-table">
      <thead><tr><th>#</th><th>Player</th><th>Two-Way Std Dev</th><th>Two-Way/20</th><th>GP</th></tr></thead>
      <tbody>${rowsHtml}</tbody>
    </table>
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
    ? '<tr><td colspan="2" class="empty-state">No game-winning buckets identified yet — needs a timestamped make that closes out a decided game.</td></tr>'
    : rows.map(r => `<tr><td>${escapeHtml(r.player.name)}</td><td>${r.count}</td></tr>`).join("");
}

// Close-Game Shooting — a margin-aware alternative to Game-Winning Buckets for the Clutch
// comparison above. GWB is explicitly non-scarce by construction (see the comment on
// gameWinningShot()): the last basket of every decided game is, by definition, the winner's, so
// it measures "who tends to close games out" rather than performance under real pressure. This
// instead looks at shooting efficiency specifically in games that actually finished close — TS%
// across every attempt in a game decided by CLUTCH_MARGIN_THRESHOLD points or fewer. Tied games
// count here (a tie is the closest a game can finish) even though a tie has no "winning shot" for
// GWB to credit. Single adjustable constant, same provisional-not-a-setting pattern as every
// other threshold on this page — 5 points is a starting guess against Poolean's 16/21-point
// targets, not a value backed by a real season's worth of margin data yet.
const CLUTCH_MARGIN_THRESHOLD = 5;

function computeCloseGameShooting() {
  const closeGames = state.games.filter(g => {
    if (!isQualifyingGame(g)) return false;
    return Math.abs(teamScore(g, g.teamA) - teamScore(g, g.teamB)) <= CLUTCH_MARGIN_THRESHOLD;
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
    ? `<tr><td colspan="4" class="empty-state">No games decided by ${CLUTCH_MARGIN_THRESHOLD} points or fewer yet.</td></tr>`
    : rows.map(r => `<tr><td>${escapeHtml(r.player.name)}</td><td>${r.gp}</td><td>${r.attempts}</td><td>${formatPct(r.ts)}</td></tr>`).join("");
}

// Best & Worst Individual Games — ranks every player-game line by that single game's actual
// Two-Way score (Off Rating + Defensive Rating), not a per-20 rate and not a season total. The
// rest of the Leaderboard deliberately normalizes everything to per-20 or season-long numbers so
// players are comparable across different game lengths and sample sizes — this panel is the one
// exception on purpose, since the whole point is surfacing a specific game's own story (a real
// 16.7 Two-Way night), which per-20 and season aggregates both average away. Every player on
// either roster for a reviewed game gets a row, even a quiet one with almost nothing recorded.
function computeIndividualGamePerformances() {
  const rows = [];
  state.games.filter(isQualifyingGame).forEach(game => {
    [...game.teamA, ...game.teamB].forEach(playerId => {
      const player = state.players.find(p => p.id === playerId);
      if (!player) return;
      const s = getOrCreatePlayerStats(game, playerId);
      const sh = shootingStats(game, playerId);
      const def = gameDefenseStats(game, playerId);
      rows.push({ player, game, pts: s.pts, twoWay: twoWayScore(s, sh, def) });
    });
  });
  return rows;
}

function renderIndividualGamePerformances() {
  const wrap = document.getElementById("individualGamePerformances");
  if (!wrap) return;
  const rows = computeIndividualGamePerformances();
  if (rows.length === 0) {
    wrap.innerHTML = '<p class="empty-state">No games logged yet.</p>';
    return;
  }
  const sorted = [...rows].sort((a, b) => b.twoWay - a.twoWay);
  // Capped so best/worst never overlap on a thin season — with few enough rows, showing the same
  // handful of games in both lists (just reversed) would read as a bug, not a real result.
  const n = Math.min(10, Math.max(1, Math.floor(sorted.length / 2)));
  const best = sorted.slice(0, n);
  const worst = sorted.slice(-n).reverse();
  const li = r => `
    <li>
      <span class="award-standings-name">${escapeHtml(r.player.name)} <span class="hint" style="margin:0">— ${escapeHtml(formatDateDisplay(r.game.date))}</span></span>
      <span>${r.twoWay >= 0 ? "+" : ""}${r.twoWay.toFixed(1)} Two-Way <span class="hint" style="margin:0">(${r.pts} pts)</span></span>
    </li>
  `;
  wrap.innerHTML = `
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
}

// Summer 2026's voted awards, straight from that season's closed ballot (award_results in the
// original season spreadsheet) — fixed, historical facts, not something this tool derives or
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
const AWARD_RESULTS = [
  { key: "mvp", label: "MVP", winners: ["ben"], statKey: "twoWayTotal", votedStandings: [
    { slug: "ben", name: "Ben", points: 18 }, { slug: "adam", name: "Adam", points: 11 },
    { slug: "phillip", name: "Phillip", points: 7 }, { slug: "reilly", name: "Reilly", points: 6 },
    { slug: "zach", name: "Zach", points: 5 }, { slug: "evan", name: "Evan", points: 1 }
  ] },
  { key: "best-player", label: "Best Player", winners: ["phillip"], statKey: "twoWay", votedStandings: [
    { slug: "phillip", name: "Phillip", points: 21 }, { slug: "ben", name: "Ben", points: 7 },
    { slug: "logan-hoskins", name: "Logan H", points: 6 }, { slug: "adam", name: "Adam", points: 4 },
    { slug: "evan", name: "Evan", points: 4 }, { slug: "reilly", name: "Reilly", points: 3 },
    { slug: "sean", name: "Sean", points: 2 }, { slug: "kayla", name: "Kayla", points: 1 }
  ] },
  { key: "dpoy", label: "Defensive Player of the Year", winners: ["adam"], statKey: "defRating", votedStandings: [
    { slug: "adam", name: "Adam", points: 9 }, { slug: "jason", name: "Jason", points: 9 },
    { slug: "phillip", name: "Phillip", points: 6 }, { slug: "ben", name: "Ben", points: 4 },
    { slug: "logan-hoskins", name: "Logan H", points: 3 }, { slug: "sean", name: "Sean", points: 3 },
    { slug: "g-ian", name: "Ian", points: 2 }, { slug: "reilly", name: "Reilly", points: 2 },
    { slug: "will", name: "Will", points: 2 }, { slug: "evan", name: "Evan", points: 1 },
    { slug: "zach", name: "Zach", points: 1 }
  ] },
  { key: "clutch", label: "Clutch", winners: ["phillip"], statKey: "closeGameTs", votedStandings: [
    { slug: "phillip", name: "Phillip", points: 7 }, { slug: "zach", name: "Zach", points: 7 },
    { slug: "adam", name: "Adam", points: 5 }, { slug: "evan", name: "Evan", points: 5 },
    { slug: "alex", name: "Alex", points: 4 }, { slug: "reilly", name: "Reilly", points: 4 },
    { slug: "ben", name: "Ben", points: 3 }, { slug: "viraj", name: "Viraj", points: 1 }
  ] },
  { key: "mip-season", label: "Most Improved (Season)", winners: ["zach"], statKey: "trend", votedStandings: [
    { slug: "zach", name: "Zach", points: 19 }, { slug: "ben", name: "Ben", points: 7 },
    { slug: "alex", name: "Alex", points: 4 }, { slug: "evan", name: "Evan", points: 4 },
    { slug: "g-lukas", name: "Lukas", points: 4 }, { slug: "adam", name: "Adam", points: 2 },
    { slug: "jason", name: "Jason", points: 2 }
  ] },
  { key: "mip-yoy", label: "Most Improved (Year-over-Year)", winners: ["zach"], statKey: "trend", votedStandings: [
    { slug: "zach", name: "Zach", points: 9 }, { slug: "ben", name: "Ben", points: 6 },
    { slug: "adam", name: "Adam", points: 5 }, { slug: "alex", name: "Alex", points: 3 },
    { slug: "jason", name: "Jason", points: 3 }, { slug: "viraj", name: "Viraj", points: 3 },
    { slug: "logan-watson", name: "Logan W", points: 2 }, { slug: "ryder", name: "Ryder", points: 2 },
    { slug: "sean", name: "Sean", points: 2 }, { slug: "evan", name: "Evan", points: 1 }
  ] },
  { key: "teammate", label: "Best Teammate", winners: ["ben"], statKey: "teammateLift", votedStandings: [
    { slug: "ben", name: "Ben", points: 10 }, { slug: "reilly", name: "Reilly", points: 6 },
    { slug: "sean", name: "Sean", points: 6 }, { slug: "evan", name: "Evan", points: 4 },
    { slug: "jason", name: "Jason", points: 4 }, { slug: "adam", name: "Adam", points: 3 },
    { slug: "logan-hoskins", name: "Logan H", points: 3 }, { slug: "phillip", name: "Phillip", points: 2 },
    { slug: "alex", name: "Alex", points: 1 }, { slug: "g-ian", name: "Ian", points: 1 },
    { slug: "will", name: "Will", points: 1 }, { slug: "zach", name: "Zach", points: 1 }
  ] },
  { key: "first-team", label: "First Team", winners: ["phillip", "ben", "sean"], statKey: "twoWay", votedStandings: [
    { slug: "phillip", name: "Phillip", points: 29 }, { slug: "ben", name: "Ben", points: 22 },
    { slug: "sean", name: "Sean", points: 13 }, { slug: "adam", name: "Adam", points: 12 },
    { slug: "reilly", name: "Reilly", points: 10 }, { slug: "evan", name: "Evan", points: 9 },
    { slug: "logan-hoskins", name: "Logan H", points: 7 }, { slug: "zach", name: "Zach", points: 3 }
  ] },
  { key: "second-team", label: "Second Team", winners: ["adam", "reilly", "evan"], statKey: "twoWay", votedStandings: [
    { slug: "phillip", name: "Phillip", points: 29 }, { slug: "ben", name: "Ben", points: 22 },
    { slug: "sean", name: "Sean", points: 13 }, { slug: "adam", name: "Adam", points: 12 },
    { slug: "reilly", name: "Reilly", points: 10 }, { slug: "evan", name: "Evan", points: 9 },
    { slug: "logan-hoskins", name: "Logan H", points: 7 }, { slug: "zach", name: "Zach", points: 3 }
  ] },
  { key: "best-duo", label: "Best Duo", winners: ["phillip", "ben"], statKey: "twoWay", isDuo: true, votedStandings: [
    { slug: "ben|phillip", name: "Ben + Phillip", points: 3 }, { slug: "alex|kayla", name: "Alex + Kayla", points: 1 },
    { slug: "alex|viraj", name: "Alex + Viraj", points: 1 }
  ] },
  { key: "worst-duo", label: "Worst Duo", winners: ["phillip", "viraj"], statKey: "twoWay", isDuo: true, votedStandings: [
    { slug: "phillip|viraj", name: "Phillip + Viraj", points: 4 }, { slug: "adam|zach", name: "Adam + Zach", points: 1 },
    { slug: "alex|viraj", name: "Alex + Viraj", points: 1 }
  ] }
];

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
        <span class="award-winner-name">${w.player ? escapeHtml(w.player.name) : `${escapeHtml(w.slug)} (not in current roster)`}</span>
        <span class="hint" style="margin:0">${escapeHtml(w.detail)}</span>
      </div>
    `).join("");
    const votedHtml = award.votedStandings && award.votedStandings.length > 0
      ? `<ol class="award-standings">${award.votedStandings.map(v => `<li><span class="award-standings-name">${escapeHtml(v.name)}</span><span class="hint" style="margin:0">${v.points} pt${v.points === 1 ? "" : "s"}</span></li>`).join("")}</ol>`
      : '<p class="empty-state" style="margin:0">No ballot data for this award.</p>';
    const statHtml = award.standings.length > 0
      ? `<ol class="award-standings">${award.standings.map(s => `<li><span class="award-standings-name">${escapeHtml(s.player.name)}</span><span class="hint" style="margin:0">${escapeHtml(s.display)}</span></li>`).join("")}</ol>`
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
// that same frozen historical record (rankings_long in the season spreadsheet), not something
// this tool derives. RANK 1 is best that night; PCT is field-size-normalized (100 = first place
// that night, 0 = last), same definition the site uses. Only the 5 parties that actually have
// logged game video are included here — the other 10 parties in the real record predate any
// footage existing at all, so "performance on the night" could never be computed for them.
const PARTY_RANKINGS = [
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

// For each historical party, pairs its frozen power ranking with that same player's *actual*
// per-20 performance in just the games logged for that date — scoped per player to the games
// they themselves appeared in that night (not every game logged that date), same "only games
// with real shots logged count" rule as everywhere else. Computed live, every render; only the
// ranking side is the frozen historical record. A night where nobody's game has been reviewed
// yet is dropped entirely — it would otherwise render as an all-"—" table telling you nothing.
function computePowerRankingVsPerformance() {
  return PARTY_RANKINGS.map(party => {
    const gamesThatNight = state.games.filter(g => g.date === party.date && isQualifyingGame(g));
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
        <td>${r.player ? escapeHtml(r.player.name) : `${escapeHtml(r.slug)} (not in current roster)`}</td>
        <td>${r.pct}%</td>
        <td>${r.perf ? `${r.perf.twoWayPer20.toFixed(1)} <span class="hint" style="margin:0">(${r.perf.gp} game${r.perf.gp === 1 ? "" : "s"})</span>` : "—"}</td>
      </tr>
    `).join("");
    section.innerHTML = `
      <h4>${escapeHtml(formatDateDisplay(party.date))}</h4>
      <table class="matchup-table">
        <thead><tr><th>Power Rank</th><th>Player</th><th>Power %</th><th>Two-Way/20 That Night</th></tr></thead>
        <tbody>${rowsHtml}</tbody>
      </table>
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
  const headerHtml = defenders.map(d => `<th>${escapeHtml(d.name)}</th>`).join("");
  const rowsHtml = scorers.map(scorer => {
    const cellsHtml = defenders.map(defender => {
      const cell = cellFor(scorer.id, defender.id);
      if (!cell) return `<td class="matchup-grid-cell matchup-grid-empty">&#8212;</td>`;
      const fgPct = pct(cell.fgm, cell.fga);
      const hue = (fgPct / 100) * 120;
      const opacity = Math.min(0.85, 0.32 + cell.fga * 0.08);
      return `<td class="matchup-grid-cell" style="background: hsla(${hue}, 85%, 42%, ${opacity})" title="${escapeHtml(scorer.name)} vs. ${escapeHtml(defender.name)}: ${cell.fgm}/${cell.fga}">${fgPct}%</td>`;
    }).join("");
    return `<tr><td class="sticky-col">${escapeHtml(scorer.name)}</td>${cellsHtml}</tr>`;
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
    : rows.map(r => `<tr><td>${escapeHtml(r.player.name)}</td><td>${r.wideOpenFga}</td><td>${formatPct(r.share)}</td><td>${formatPct(r.ts)}</td></tr>`).join("");
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
    : rows.map(r => `<tr><td>${escapeHtml(r.passer.name)}</td><td>${escapeHtml(r.scorer.name)}</td><td>${r.count}</td></tr>`).join("");
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
  const headerHtml = players.map(p => `<th>${escapeHtml(p.name)}</th>`).join("");
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
    return `<tr><td class="sticky-col">${escapeHtml(rowP.name)}</td>${cellsHtml}</tr>`;
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
        <td>${escapeHtml(r.player.name)}</td>
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
    return `<tr><td>${escapeHtml(r.player.name)}</td>${zoneCellsHtml}<td>${total}</td><td><div class="shot-selection-bar">${mixHtml}</div></td></tr>`;
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
// *converted* if, within SECOND_CHANCE_WINDOW_SECONDS of the miss's own videoTime, either that
// rebounder scored themselves or someone else scored with that rebounder as the assist — either
// path counts once, not twice. Both the miss and the candidate score need a real videoTime to
// be checked; a miss logged without one still counts toward OREB but can't be evaluated for
// conversion, same "don't guess" stance as Game-Winning Buckets. Single adjustable constant,
// not a UI setting, same reasoning as every other threshold on this page.
const SECOND_CHANCE_WINDOW_SECONDS = 20;

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
        const windowEnd = ev.videoTime + SECOND_CHANCE_WINDOW_SECONDS;
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
    : rows.map(r => `<tr><td>${escapeHtml(r.player.name)}</td><td>${r.oreb}</td><td>${r.converted}</td><td>${formatPct(pct(r.converted, r.oreb))}</td></tr>`).join("");
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
    : rows.map(r => `<tr><td>${escapeHtml(r.player.name)}</td><td>${r.misses}</td><td>${r.oob}</td><td>${formatPct(pct(r.oob, r.misses))}</td></tr>`).join("");
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
    <table class="matchup-table">
      <thead><tr><th>Season</th><th>GP</th><th>Record</th><th>Off Rating/20</th><th>Def Rating/20</th><th>Two-Way/20</th></tr></thead>
      <tbody>${rowsHtml}</tbody>
    </table>
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
    wrap.innerHTML = '<p class="empty-state">No seasons closed yet (Export → Data Management → Start New Season) — nothing archived to show.</p>';
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
    <table class="matchup-table">
      <thead><tr><th>#</th><th>Player</th><th>GP</th><th>Record</th><th>Off Rating/20</th><th>Def Rating/20</th><th>Two-Way/20</th></tr></thead>
      <tbody>${rowsHtml}</tbody>
    </table>
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

function renderFlakeStatsPanel(playerId) {
  const wrap = document.getElementById("playerFlakeStats");
  if (!wrap) return;
  const stats = computeFlakeStats(playerId);
  if (stats.pct === null) {
    wrap.innerHTML = '<p class="empty-state">No resolved RSVPs for this player yet — flake % needs at least one RSVP\'d date with a logged game.</p>';
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
    : rows.map(r => `<tr><td>${escapeHtml(r.teammate.name)}</td><td>${r.with.gp}</td><td>${r.without.gp}</td><td>${fmt(r.with.offRatingPer20, r.with.gp)}</td><td>${fmt(r.without.offRatingPer20, r.without.gp)}</td><td>${fmt(r.with.twoWayPer20, r.with.gp)}</td><td>${fmt(r.without.twoWayPer20, r.without.gp)}</td></tr>`).join("");
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
  renderTrendLineChart("playerTwoWayTrend", points, seasonAvg, "Two-Way/20");
}

// Generic SVG line-chart renderer — per-game points plus a dashed season-average reference
// line, parameterized over a {date, value} point list and a unit label rather than hardwired to
// one stat. renderTwoWayTrendChart() (above) is now just a thin wrapper over this; Teammate
// Quality and both Matchup Difficulty charts below use it directly.
function renderTrendLineChart(containerId, points, seasonAvg, unitLabel) {
  const wrap = document.getElementById(containerId);
  if (!wrap) return;
  if (points.length === 0 || seasonAvg === null) {
    wrap.innerHTML = '<p class="empty-state">Not enough data yet.</p>';
    return;
  }
  const W = 560, H = 220, PAD_L = 40, PAD_R = 16, PAD_T = 16, PAD_B = 34;
  const plotW = W - PAD_L - PAD_R, plotH = H - PAD_T - PAD_B;
  const values = [...points.map(p => p.value), seasonAvg];
  const rawMin = Math.min(...values), rawMax = Math.max(...values);
  const span = Math.max(1, rawMax - rawMin);
  const yMin = rawMin - span * 0.15;
  const yMax = rawMax + span * 0.15;
  const xScale = i => points.length === 1 ? PAD_L + plotW / 2 : PAD_L + (i / (points.length - 1)) * plotW;
  const yScale = v => PAD_T + plotH - ((v - yMin) / (yMax - yMin || 1)) * plotH;

  const pathD = points.map((p, i) => `${i === 0 ? "M" : "L"}${xScale(i)},${yScale(p.value)}`).join(" ");
  const dotsSvg = points.map((p, i) => `
    <circle cx="${xScale(i)}" cy="${yScale(p.value)}" r="3.5" class="ts-line-dot">
      <title>${escapeHtml(formatDateDisplay(p.date))}: ${p.value.toFixed(1)} ${escapeHtml(unitLabel)}</title>
    </circle>
  `).join("");
  const labelEvery = Math.max(1, Math.ceil(points.length / 6));
  const xLabelsSvg = points.map((p, i) => (i % labelEvery !== 0 && i !== points.length - 1) ? "" : `
    <text x="${xScale(i)}" y="${H - PAD_B + 16}" text-anchor="middle" class="ts-line-axis-label">${escapeHtml(formatDateDisplay(p.date))}</text>
  `).join("");
  const seasonY = yScale(seasonAvg);

  wrap.innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" class="ts-line-svg">
      <line x1="${PAD_L}" y1="${PAD_T}" x2="${PAD_L}" y2="${H - PAD_B}" class="ts-line-axis" />
      <line x1="${PAD_L}" y1="${H - PAD_B}" x2="${W - PAD_R}" y2="${H - PAD_B}" class="ts-line-axis" />
      <line x1="${PAD_L}" y1="${seasonY}" x2="${W - PAD_R}" y2="${seasonY}" class="ts-line-ref">
        <title>Season average: ${seasonAvg.toFixed(1)} ${escapeHtml(unitLabel)}</title>
      </line>
      <text x="${W - PAD_R}" y="${seasonY - 4}" text-anchor="end" class="ts-line-axis-label">season avg ${seasonAvg.toFixed(1)}</text>
      <path d="${pathD}" class="ts-line-path" />
      ${dotsSvg}
      ${xLabelsSvg}
    </svg>
  `;
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
  renderTrendLineChart("playerTeammateQuality", points, seasonAvg, "Off Rating/20");
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
  renderTrendLineChart("playerDefensiveMatchupDifficulty", points, seasonAvg, "Opp Off Rating/20");
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
  renderTrendLineChart("playerOffensiveMatchupDifficulty", points, seasonAvg, "Opp Def Rating/20");
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
  const qualityNote = avgAssisterQuality !== null ? ` — average assister quality: ${avgAssisterQuality.toFixed(1)} Off Rating/20` : "";
  const rows = assisters.length === 0
    ? '<tr><td colspan="3" class="empty-state">No assisted makes yet.</td></tr>'
    : assisters.map(a => `<tr><td>${escapeHtml(a.player.name)}</td><td>${a.assists}</td><td>${a.offRatingPer20 !== null ? a.offRatingPer20.toFixed(1) : "—"}</td></tr>`).join("");
  wrap.innerHTML = `
    <p class="hint" style="margin:0 0 10px">${assistedFgm} of ${fgm} makes were assisted (${formatPct(assistedPct)})${qualityNote}.</p>
    <table class="matchup-table">
      <thead><tr><th>Teammate</th><th>Assists</th><th>Their Off Rating/20</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
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
  { key: "pts", label: "PTS/20", accessor: r => r.rate.pts, display: r => r.rate.pts.toFixed(1), tooltip: "Points, per 20 combined points scored in the game (not per game — see the note above the table)." },
  { key: "shotpct", label: "Shot%", advanced: true, accessor: r => r.shotPct, display: r => formatPct(r.shotPct), tooltip: "Share of their own team's field goal attempts that were theirs, across games they played — not the league's shots, their team's. A season-long share (their FGA / their team's FGA in those same games), not a per-20 rate." },
  { key: "astpct", label: "AST%", advanced: true, accessor: r => r.astPct, display: r => formatPct(r.astPct), tooltip: "Share of their own team's assists that were theirs, across games they played — not the league's assists, their team's. A season-long share (their AST / their team's AST in those same games), not a per-20 rate." },
  { key: "orebpct", label: "OREB%", advanced: true, accessor: r => r.orebPct, display: r => formatPct(r.orebPct), tooltip: "Real Total Rebound %-style share: this player's OREB divided by every offensive rebound available on their team's misses that game (their team's OREB plus the opponent's DREB on those same misses) — not just their own team's OREB total like Shot%/AST% above, since a rebound is contested between both teams. Poolean has no substitutions, so a rostered player is on the floor for the whole game — the minutes-played term real rebound rate stats normally need just doesn't apply here. A season-long share, not a per-20 rate." },
  { key: "drebpct", label: "DREB%", advanced: true, accessor: r => r.drebPct, display: r => formatPct(r.drebPct), tooltip: "Same idea as OREB% for the other side of the ball: this player's DREB divided by every defensive rebound available on the opponent's misses that game (their team's DREB plus the opponent's OREB on those same misses). A season-long share, not a per-20 rate." },
  { key: "trebpct", label: "TRB%", advanced: true, accessor: r => r.trebPct, display: r => formatPct(r.trebPct), tooltip: "OREB and DREB combined: this player's total rebounds divided by every rebound actually available across the games they played (OREB% and DREB%'s two pools added together). Same no-substitutions reasoning as OREB%/DREB% above — a season-long share, not a per-20 rate." },
  { key: "tovpct", label: "TOV%", advanced: true, accessor: r => r.tovPct, display: r => formatPct(r.tovPct), tooltip: "How often this player turned it over relative to their own scoring opportunities — TOV ÷ (FGA + 0.44×FTA + TOV), the same FTA-equivalent scaling True Shooting % uses. Not a share of the team's turnovers like Shot%/AST% above — a turnover isn't a shared resource the way a shot or an assist is, so this measures usage instead: of the times this player had the ball in a position to score or give it away, how often it was the latter." },
  { key: "fg", label: "FG", accessor: r => pct(r.shooting.fgm, r.shooting.fga), display: r => formatShootingSplit(r.rateShooting.fgm, r.rateShooting.fga, true), tooltip: "Field goals made/attempted (2s and 3s combined), per 20 combined points, with FG%." },
  { key: "tpt", label: "3PT", accessor: r => pct(r.shooting.tpm, r.shooting.tpa), display: r => formatShootingSplit(r.rateShooting.tpm, r.rateShooting.tpa, true), tooltip: "3-pointers made/attempted, per 20 combined points, with 3PT%. See the 3PT Shot Distance panel below for the Arc/Deep breakdown." },
  { key: "ft", label: "FT", accessor: r => pct(r.shooting.ftm, r.shooting.fta), display: r => formatShootingSplit(r.rateShooting.ftm, r.rateShooting.fta, true), tooltip: "Free throws made/attempted, per 20 combined points, with FT%." },
  { key: "efg", label: "eFG%", accessor: r => effectiveFgPct(r.shooting.fgm, r.shooting.tpm, r.shooting.fga), display: r => formatPct(effectiveFgPct(r.shooting.fgm, r.shooting.tpm, r.shooting.fga)), tooltip: "Effective FG% — field goal percentage weighted so a made 3 counts as 1.5 made 2s." },
  { key: "ts", label: "TS%", accessor: r => trueShootingPct(r.totals.pts, r.shooting.fga, r.shooting.fta), display: r => formatPct(trueShootingPct(r.totals.pts, r.shooting.fga, r.shooting.fta)), tooltip: "True Shooting % — overall scoring efficiency across field goals and free throws combined." },
  { key: "oreb", label: "OREB/20", accessor: r => r.rate.oreb, display: r => r.rate.oreb.toFixed(1), tooltip: "Offensive rebounds (grabbed by a teammate of the shooter), per 20 combined points." },
  { key: "dreb", label: "DREB/20", accessor: r => r.rate.dreb, display: r => r.rate.dreb.toFixed(1), tooltip: "Defensive rebounds (grabbed by an opponent of the shooter), per 20 combined points." },
  { key: "ast", label: "AST/20", accessor: r => r.rate.ast, display: r => r.rate.ast.toFixed(1), tooltip: "Assists — credited on a made shot when a teammate is tagged as the passer — per 20 combined points." },
  { key: "stl", label: "STL/20", accessor: r => r.rate.stl, display: r => r.rate.stl.toFixed(1), tooltip: "Steals, per 20 combined points. Feeds Def Rating below." },
  { key: "blk", label: "BLK/20", accessor: r => r.rate.blk, display: r => r.rate.blk.toFixed(1), tooltip: "Blocks — credited on a missed shot when this player is tagged as the blocker — per 20 combined points. Feeds Def Rating below, except when the block is already one of this player's own Stops (the usual case) — see Def Rating's own tooltip." },
  { key: "tov", label: "TOV/20", accessor: r => r.rate.tov, display: r => r.rate.tov.toFixed(1), tooltip: "Turnovers (including ones forced by a steal, or a miss ruled out of bounds), per 20 combined points." },
  { key: "atov", label: "A/TO", accessor: r => r.totals.tov === 0 ? (r.totals.ast === 0 ? 0 : Infinity) : r.totals.ast / r.totals.tov, display: r => r.astTov, tooltip: "Assist-to-turnover ratio." },
  { key: "pf", label: "PF/20", accessor: r => r.rate.pf, display: r => r.rate.pf.toFixed(1), tooltip: "Personal fouls, per 20 combined points." },
  { key: "ptsAllowed", label: "Pts Allowed/20", accessor: r => r.rateDefense.ptsAllowed, display: r => r.rateDefense.ptsAllowed.toFixed(1), tooltip: "Points scored by opponents on shots where this player was the tagged defender, per 20 combined points." },
  { key: "oppfg", label: "Opp FG%", accessor: r => pct(r.defense.timesBeaten, r.defense.timesBeaten + r.defense.stops), display: r => formatPct(pct(r.defense.timesBeaten, r.defense.timesBeaten + r.defense.stops)), tooltip: "Shooting percentage of everyone this player was tagged defending, make or miss — a real 'shooting percentage allowed.'" },
  { key: "beaten", label: "Beaten/20", accessor: r => r.rateDefense.timesBeaten, display: r => r.rateDefense.timesBeaten.toFixed(1), tooltip: "Times scored on while tagged as the defender on a made shot, per 20 combined points." },
  { key: "stops", label: "Stops/20", accessor: r => r.rateDefense.stops, display: r => r.rateDefense.stops.toFixed(1), tooltip: "Times tagged as the defender on a missed shot, per 20 combined points." },
  { key: "defrtg20", label: "Def Rating/20", accessor: r => defensiveRating(r.rate, r.rateDefense), display: r => defensiveRating(r.rate, r.rateDefense).toFixed(1), tooltip: "This tool's Defensive Rating: STL, plus BLK (only when it isn't already one of this player's own Stops, so a blocked-and-tagged shot isn't credited twice), plus Stops minus Beaten minus 0.4×Pts Allowed — all per 20 combined points. Not points-allowed-per-100-possessions like the NBA stat of the same name — possessions aren't tracked here, so combined points stands in as the pace proxy, same as every other per-20 rate on this board. 0 for anyone never tagged as a defender with no steals or blocks — not a penalty for conservative tagging." },
  { key: "offrtg20", label: "Off Rating/20", accessor: r => r.offRatingPer20, display: r => r.offRatingPer20.toFixed(1), tooltip: "Offense-only Game Score: PTS, shooting efficiency, rebounds, assists, TOV, and fouls — adapted from the standard basketball Game Score formula, minus its STL and BLK terms, which live in Def Rating instead — per 20 combined points." },
  { key: "twoway20", label: "Two-Way/20", accessor: r => r.twoWayPer20, display: r => r.twoWayPer20.toFixed(1), tooltip: "Off Rating plus Def Rating, per 20 combined points." },
  { key: "last5", label: "Last 5", accessor: r => r.last5OffRatingPer20, display: r => r.last5Gp > 0 ? `${r.last5Trend} ${r.last5OffRatingPer20.toFixed(1)}` : "—", tooltip: "Off Rating/20 over their last 5 games with real shots logged (fewer if they haven't played 5 yet). ▲/▼ shows whether that's above or below their season Off Rating/20 — within ±0.5 counts as flat (–)." }
];

let leaderboardSort = { key: "pts", dir: "desc" };

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
      input.title = "No season has been closed yet (Export → Data Management → Start New Season) — nothing archived to include.";
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
  renderTwoWayRankChart();
  renderLeagueHeatmap();
  renderShotZonePanel();
  renderLeagueTsByZoneChart();
  renderWideOpenShootingPanel();
  renderLeagueTsChart();
  renderMatchupGrid();
  renderTeammateLiftMatrix();
  renderTeammateContextPanel();
  renderAssistSynergy();
  renderOutOfBoundsPanel();
  renderSecondChancePanel();
  renderGameWinningBucketsPanel();
  renderCloseGameShootingPanel();
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
}

// Every stat with a clear "which direction is better" reads that way here; everything else
// (GP, and the shot-share percentages Shot%/AST%/OREB%/DREB%/TRB%) is left uncolored on
// purpose, since a bigger share of the team's shots or assists reflects a role a player's
// settled into, not necessarily better play.
const COMPARISON_NEUTRAL_KEYS = new Set(["gp", "shotpct", "astpct", "orebpct", "drebpct", "trebpct"]);
const COMPARISON_LOWER_IS_BETTER_KEYS = new Set(["l", "tov", "pf", "ptsAllowed", "oppfg", "beaten", "tovpct"]);

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
    <table class="matchup-table compare-table">
      <thead><tr><th></th><th>${escapeHtml(row1.player.name)}</th><th>${escapeHtml(row2.player.name)}</th></tr></thead>
      <tbody>${rowsHtml}</tbody>
    </table>
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
  document.getElementById("playerDetailTitle").innerHTML = `${renderPlayerAvatar(player, "large")}<span>${escapeHtml(player.name)}</span>`;
  document.getElementById("playerDetailSummary").textContent = row
    ? `${row.wins}-${row.losses}${row.ties ? `-${row.ties}` : ""} · ${row.rate.pts.toFixed(1)} PTS/20 · ${row.offRatingPer20.toFixed(1)} Off Rating/20 · ${row.twoWayPer20.toFixed(1)} Two-Way/20`
    : "No games yet";

  // Render order follows the panels' actual top-to-bottom order in index.html — past-season
  // context, then season overview, then offense detail (shots, then who defended them), then
  // defense detail (same shape, mirrored), then team context, then media. Keep the two in sync.
  renderSeasonHistoryPanel(player.id);
  renderFlakeStatsPanel(player.id);
  renderTwoWayTrendChart(player.id);
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
  renderPlayerReel(player.id);
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
    goBtn.textContent = "Go to game";
    goBtn.addEventListener("click", () => openGame(clip.gameId));
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
    body.innerHTML = '<tr><td colspan="6" class="empty-state">No clips tagged yet — mark one from the Highlight / Lowlight Reel table in Stat Entry.</td></tr>';
    return;
  }
  clips.forEach(clip => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${formatDateDisplay(clip.gameDate)}</td>
      <td>${escapeHtml(clip.player.name)}</td>
      <td>${clip.type === "highlight" ? '<span class="badge badge-highlight">🔥 Highlight</span>' : '<span class="badge badge-lowlight">👎 Lowlight</span>'}</td>
      <td>${formatTime(clip.start)}–${formatTime(clip.end)}</td>
      <td>${escapeHtml(clip.note || "")}</td>
    `;
    const tdBtn = document.createElement("td");
    const goBtn = document.createElement("button");
    goBtn.type = "button";
    goBtn.className = "secondary-btn";
    goBtn.textContent = "Go to game";
    goBtn.addEventListener("click", () => openGame(clip.gameId));
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
function loadVideoSrc(video, src) {
  return new Promise((resolve, reject) => {
    function cleanup() {
      video.removeEventListener("loadedmetadata", onReady);
      video.removeEventListener("error", onError);
    }
    function onReady() { cleanup(); resolve(); }
    function onError() { cleanup(); reject(new Error("video load error")); }
    video.addEventListener("loadedmetadata", onReady, { once: true });
    video.addEventListener("error", onError, { once: true });
    video.src = src;
    video.load();
  });
}

async function exportLeagueVideo() {
  if (leagueExportState) return;
  const grouped = leagueClipsByGameChronological();
  if (grouped.length === 0) return;
  const mimeType = pickRecorderMimeType();
  const statusEl = document.getElementById("leagueExportStatus");
  if (!mimeType) {
    statusEl.textContent = "This browser doesn't support recording video — try a recent Chrome or Firefox.";
    return;
  }

  const previewWrap = document.getElementById("leagueExportPreviewWrap");
  const video = document.getElementById("leagueExportVideo");
  previewWrap.hidden = false;
  video.muted = false;

  const stream = video.captureStream ? video.captureStream() : video.mozCaptureStream();
  const recorder = new MediaRecorder(stream, { mimeType });
  const chunks = [];
  recorder.ondataavailable = e => { if (e.data.size > 0) chunks.push(e.data); };

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

  // Started paused so only actual clip playback — not the seeking/loading between clips or
  // between games — ends up in the recording. pause()/resume() (not stop-and-restart) keeps it
  // one continuous MediaRecorder session.
  recorder.start();
  recorder.pause();
  try {
    for (const { game, clip, src } of queue) {
      if (leagueExportState.cancelled) break;

      if (src !== currentSrc) {
        statusEl.textContent = `Loading video for ${formatDateDisplay(game.date)}…`;
        const loadOutcome = await raceCancel(loadVideoSrc(video, src), cancelPromise);
        if (loadOutcome === "cancelled") break;
        currentSrc = src;
      }

      done++;
      statusEl.textContent = `Recording clip ${done} of ${totalClips} (${formatDateDisplay(game.date)})…`;

      const seekOutcome = await raceCancel(waitForSeek(video, clip.start), cancelPromise);
      if (seekOutcome === "cancelled") break;

      recorder.resume();
      const playPromise = video.play().catch(() => {});
      const playOutcome = await Promise.race([
        playPromise.then(() => "played"),
        cancelPromise.then(() => "cancelled"),
        new Promise(resolve => setTimeout(() => resolve("timeout"), 8000))
      ]);
      if (playOutcome !== "played") {
        recorder.pause();
        if (playOutcome === "cancelled") break;
        stoppedEarly = `Clip ${done} of ${totalClips} didn't start playing — stopped there.`;
        break;
      }

      const waitOutcome = await raceCancel(waitUntilTime(video, clip.end), cancelPromise);
      video.pause();
      recorder.pause();
      if (waitOutcome === "cancelled") break;
    }
  } finally {
    recorder.stop();
    await new Promise(resolve => { recorder.onstop = resolve; });
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
    ? ` (${skippedClips} clip${skippedClips === 1 ? "" : "s"} across ${skippedGames} game${skippedGames === 1 ? "" : "s"} skipped — no usable video source.)`
    : "";
  if (cancelled) {
    statusEl.textContent = "Cancelled — nothing downloaded.";
  } else if (chunks.length === 0) {
    statusEl.textContent = (stoppedEarly || "Recording produced no data — try again.") + skipNote;
  } else {
    const blob = new Blob(chunks, { type: mimeType });
    download("league-highlights.webm", blob, mimeType);
    statusEl.textContent = stoppedEarly
      ? `${stoppedEarly} Downloaded what was recorded before that.${skipNote}`
      : `Done — ${done} clip${done === 1 ? "" : "s"} combined and downloaded.${skipNote}`;
  }
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
  const reviewed = rows.filter(r => r.game.scoringEvents.length > 0);
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
    tr.innerHTML = `
      <td>${formatDateDisplay(r.game.date)}</td>
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
    : scorerRows.map(r => `<tr><td>${r.defender ? escapeHtml(r.defender.name) : "No defender"}</td><td>${formatShootingSplit(r.fgm, r.fga)}</td><td>${formatPct(pct(r.fgm, r.fga))}</td></tr>`).join("");

  const defenderHeaderRow = document.getElementById("h2hDefenderHeaderRow");
  const defenderBody = document.getElementById("h2hDefenderBody");
  renderSortableHeader(defenderHeaderRow, H2H_DEFENDER_COLUMNS, h2hDefenderSort, () => renderHeadToHead(playerId));
  const defenderRows = headToHeadAsDefender(playerId).map(r => ({ ...r, scorer: state.players.find(p => p.id === r.scorerId) }));
  const defenderSortCol = H2H_DEFENDER_COLUMNS.find(c => c.key === h2hDefenderSort.key);
  defenderRows.sort((a, b) => compareForSort(defenderSortCol.accessor(a), defenderSortCol.accessor(b), h2hDefenderSort.dir));
  defenderBody.innerHTML = defenderRows.length === 0
    ? '<tr><td colspan="3" class="empty-state">No tagged shots yet.</td></tr>'
    : defenderRows.map(r => `<tr><td>${r.scorer ? escapeHtml(r.scorer.name) : "?"}</td><td>${formatShootingSplit(r.fgm, r.fga)}</td><td>${formatPct(pct(r.fgm, r.fga))}</td></tr>`).join("");
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

document.getElementById("exportAllJsonBtn").addEventListener("click", () => {
  download("pool-league-data.json", JSON.stringify(state, null, 2), "application/json");
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
    videoWrap.innerHTML = '<p class="hint" style="margin:0">No video available for this game — mark from memory, or open it directly in Stat Entry.</p>';
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
          ${scorer ? escapeHtml(scorer.name) : "?"} — ${ev.made !== false ? "Make" : "Miss"} (${ev.points}pt)
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
    wrap.innerHTML = '<p class="empty-state">No flagged shots — every marked 2PT/3PT location agrees with its point value.</p>';
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
          ${scorer ? escapeHtml(scorer.name) : "?"} — picked ${ev.points}pt, marked at 📍 ${zoneLabel}
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
            doneMsg.textContent = "No flagged shots — every marked 2PT/3PT location agrees with its point value.";
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
  const label = prompt('Name the season that\'s ending (shown on player profiles and the "Include Past Seasons" toggle) — e.g. "Summer 2026":', "");
  if (label === null) return;
  if (!confirm("This archives every current game behind today's date and clears locally-stored video files. Games, stats, the player roster, and every player's height/build/role tags are all kept — download JSON first if you want a full backup anyway. Continue?")) return;
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
  if (!confirm("This will permanently delete all players, games, and stats. Continue?")) return;
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

// ---------- Init ----------
collapseSectionHints();
renderPlayers();
document.getElementById("rsvpDateInput").value = new Date().toISOString().slice(0, 10);
loadRsvpForDate(document.getElementById("rsvpDateInput").value);
renderGames();

// Land back on whatever was in view last time, instead of always resetting to Games — a
// browser refresh (or just reopening the file) shouldn't feel like navigating to a new page.
(function restoreLastView() {
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
