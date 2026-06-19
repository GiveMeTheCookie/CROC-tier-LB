// scraper/merge.js — combines data/leaderboard-<class>.json files (downloaded
// from each matrix job's artifact) into the single data/leaderboard.json
// that the site reads.
const fs = require('fs');
const path = require('path');

const CLASS_KEYS = ['warrior', 'mage', 'archer', 'shaman'];

// Where the merge job downloads artifacts to (set in workflow)
const partsDir = process.argv[2] || path.join(__dirname, '..', 'parts');
const outDir = path.join(__dirname, '..', 'data');

let allRows = [];
let anyOk = false;
const summary = [];

for (const key of CLASS_KEYS) {
  const file = path.join(partsDir, `leaderboard-${key}.json`);
  if (!fs.existsSync(file)) {
    console.log(`[merge] missing leaderboard-${key}.json — skipping (kept stale rows if any exist below)`);
    summary.push(`${key}: MISSING`);
    continue;
  }
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  console.log(`[merge] ${key}: ok=${data.ok}, rows=${data.rows.length}`);
  summary.push(`${key}: ${data.rows.length} rows (ok=${data.ok})`);
  if (data.rows.length > 0) {
    allRows.push(...data.rows);
    anyOk = true;
  }
}

if (!anyOk) {
  console.error('[merge] every class returned 0 rows — refusing to overwrite leaderboard.json with empty data');
  process.exit(1);
}

fs.mkdirSync(outDir, { recursive: true });
const out = {
  ok: true,
  fetchedAt: new Date().toISOString(),
  rows: allRows,
};
fs.writeFileSync(path.join(outDir, 'leaderboard.json'), JSON.stringify(out, null, 2));
console.log(`[merge] wrote ${allRows.length} total rows to data/leaderboard.json`);
console.log(summary.join('\n'));
