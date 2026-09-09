#!/usr/bin/env node
// Regenerates viewer-seed-data.js from a fresh "Download JSON" export (main dashboard's Export
// tab), so refreshing the friends site's baked-in snapshot is a one-line command instead of a
// hand-written Node -e each time. Preserves the same structure/format the file has always had:
// one localStorage.setItem for the exported state, plus the two viewer-only defaults (sidebar
// starts collapsed, advanced % columns start shown) appended after it.
//
// Usage:
//   node scripts/regenerate-seed-data.js "<path to pool-league-data (N).json>"

const fs = require("fs");
const path = require("path");

const exportPath = process.argv[2];
if (!exportPath) {
  console.error("Usage: node scripts/regenerate-seed-data.js \"<path to exported JSON>\"");
  process.exit(1);
}
if (!fs.existsSync(exportPath)) {
  console.error(`File not found: ${exportPath}`);
  process.exit(1);
}

const data = JSON.parse(fs.readFileSync(exportPath, "utf8"));
const sourceName = path.basename(exportPath);
const outPath = path.join(__dirname, "..", "viewer-seed-data.js");

const header = `// Baked-in season snapshot for the friends viewer build — generated from ${sourceName}. Overwrites localStorage on every load, so this is always the source of truth here regardless of anything a viewer might poke at in devtools. Regenerate this file (ask Claude, or re-run scripts/regenerate-seed-data.js) whenever you want to refresh it with newer games.\n`;
const dataLine = `localStorage.setItem("poolLeagueStatTracker", JSON.stringify(${JSON.stringify(data)}));\n`;
const defaults =
  `// Sidebar starts collapsed on both tabs, and the Leaderboard's advanced % columns start shown — nicer defaults for a first-time friend than the ones Ben's own live app happens to be set to right now.\n` +
  `localStorage.setItem("poolLeagueSidebarCollapsed", JSON.stringify({ gamesSidebarWrap: true, leaderboardSidebarWrap: true }));\n` +
  `localStorage.setItem("poolLeagueShowAdvancedCols", "true");\n`;

fs.writeFileSync(outPath, header + dataLine + defaults);
console.log(`Wrote ${outPath} (${data.players?.length ?? 0} players, ${data.games?.length ?? 0} games) from ${sourceName}.`);
console.log("Next: git add/commit/push in dashboard-viewer to publish it.");
