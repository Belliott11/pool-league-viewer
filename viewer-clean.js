// The friends' viewer shows the stats, not the working behind them. Long explanatory paragraphs
// (formulas, adjustments, thresholds) sit behind the small "About this panel" toggle instead of
// opening every panel with a wall of text; short one-line notes stay visible. Runs once, after the
// page's static markup exists.
(function () {
  const LONG = 200;
  document.querySelectorAll("p.hint").forEach(p => {
    if (p.id || p.closest(".hint-details") || p.textContent.length <= LONG) return;
    const details = document.createElement("details");
    details.className = "hint-details";
    p.replaceWith(details);
    details.append(document.createElement("summary"), p);
  });
})();
