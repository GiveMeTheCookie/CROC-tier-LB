// scraper/scrape.js
//
// Scrapes the One-X tierlist pages with a REAL headless browser (Playwright),
// so any client-side "load more" button or infinite-scroll content gets
// captured — not just the ~50 rows that show up in a plain HTML fetch.
//
// Run locally:  cd scraper && npm install && node scrape.js
// Run in CI:    see ../.github/workflows/scrape.yml
//
// Output: ../data/leaderboard.json  ->  { ok, fetchedAt, rows: [...] }

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const CLASSES = [
  { key: 'warrior', param: 0 },
  { key: 'mage', param: 1 },
  { key: 'archer', param: 2 },
  { key: 'shaman', param: 3 },
];

const BASE = 'https://onex.shturmovi.cc/tierlists/';
const MAX_SCROLL_ATTEMPTS = 60;
const STABLE_ROUNDS_NEEDED = 3; // stop once row count hasn't grown for this many checks in a row

function stripTags(s) {
  return s.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
}

async function scrapeClass(page, cls) {
  const url = `${BASE}?c=${cls.param}`;
  console.log(`[${cls.key}] navigating to ${url}`);
  await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 });

  // Give the SPA a moment to hydrate and render the initial table.
  await page.waitForSelector('table tbody tr, table tr', { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(1000);

  let stableRounds = 0;
  let lastCount = 0;

  for (let i = 0; i < MAX_SCROLL_ATTEMPTS; i++) {
    // Strategy 1: click any visible "load more / show more / next" style control.
    const clicked = await page.evaluate(() => {
      const candidates = Array.from(document.querySelectorAll('button, a, div[role="button"]'));
      const match = candidates.find((el) => {
        const t = (el.textContent || '').trim().toLowerCase();
        return /load more|show more|next|more results|view more/.test(t) && el.offsetParent !== null;
      });
      if (match) {
        match.scrollIntoView();
        match.click();
        return true;
      }
      return false;
    });

    // Strategy 2: scroll the window and any internally-scrollable containers,
    // in case rows load via infinite scroll instead of a button.
    await page.evaluate(() => {
      window.scrollTo(0, document.body.scrollHeight);
      document.querySelectorAll('div, section').forEach((el) => {
        if (el.scrollHeight > el.clientHeight + 50) {
          el.scrollTop = el.scrollHeight;
        }
      });
    });

    await page.waitForTimeout(clicked ? 1200 : 800);

    const count = await page.evaluate(
      () => document.querySelectorAll('table tbody tr, table tr').length
    );

    if (count <= lastCount) {
      stableRounds++;
    } else {
      stableRounds = 0;
    }
    lastCount = count;

    if (stableRounds >= STABLE_ROUNDS_NEEDED) {
      console.log(`[${cls.key}] row count stable at ${count}, stopping (attempt ${i + 1})`);
      break;
    }
  }

  // Final extraction of whatever is in the DOM now.
  const rawRows = await page.evaluate(() => {
    const trs = Array.from(document.querySelectorAll('table tr'));
    return trs
      .map((tr) => {
        const tds = Array.from(tr.querySelectorAll('td'));
        if (tds.length < 9) return null; // skip header/short rows
        return tds.map((td) => td.innerHTML);
      })
      .filter(Boolean);
  });

  console.log(`[${cls.key}] extracted ${rawRows.length} raw rows`);

  const parsed = [];
  let rank = 0;
  for (const cells of rawRows) {
    rank++;
    const nameRaw = stripTags(cells[0]);
    const name = nameRaw.replace(/^\d+\s*/, '').trim();
    if (!name) continue;
    const num = (s) => {
      const n = parseFloat(stripTags(s).replace(/,/g, ''));
      return Number.isNaN(n) ? null : n;
    };
    parsed.push({
      name,
      cls: cls.key,
      rank,
      dps: num(cells[1]),
      burst: num(cells[2]),
      ehp: num(cells[3]),
      score: num(cells[4]),
      tank: stripTags(cells[5]),
      hybrid: stripTags(cells[6]),
      dpst: stripTags(cells[7]),
      overall: stripTags(cells[8]),
    });
  }

  return parsed;
}

(async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1280, height: 2000 } });
  const page = await context.newPage();

  const allRows = [];
  for (const cls of CLASSES) {
    try {
      const rows = await scrapeClass(page, cls);
      allRows.push(...rows);
    } catch (err) {
      console.error(`[${cls.key}] failed:`, err.message);
    }
  }

  await browser.close();

  const out = {
    ok: true,
    fetchedAt: new Date().toISOString(),
    rows: allRows,
  };

  const outDir = path.join(__dirname, '..', 'data');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'leaderboard.json'), JSON.stringify(out, null, 2));
  console.log(`Wrote ${allRows.length} total rows to data/leaderboard.json`);
})();
