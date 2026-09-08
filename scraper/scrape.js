// scraper/scrape.js — uses the onex API directly
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const CLASSES = [
  { key: 'warrior', param: 0 },
  { key: 'mage',    param: 1 },
  { key: 'archer',  param: 2 },
  { key: 'shaman',  param: 3 },
];

const BASE = 'https://onex.shturmovi.cc';

(async () => {
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    locale: 'en-US',
    extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' },
  });

  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });

  const page = await context.newPage();

  // Visit the site first to get cookies/CF clearance
  console.log('Visiting site to get cookies...');
  await page.goto(`${BASE}/tierlists/?c=0`, { waitUntil: 'domcontentloaded', timeout: 90000 });
  try {
    await page.waitForFunction(
      () => !document.title.includes('Just a moment'),
      { timeout: 30000 }
    );
  } catch {
    console.log('CF check timeout, proceeding anyway');
  }
  await page.waitForTimeout(3000);

  const allRows = [];

  for (const cls of CLASSES) {
    console.log(`[${cls.key}] fetching API...`);
    try {
      const data = await page.evaluate(async (param) => {
        const res = await fetch(`/api/tierlist/${param}`);
        return await res.json();
      }, cls.param);

      console.log(`[${cls.key}] got ${data.length} rows`);

      let rank = 0;
      for (const row of data) {
        rank++;
        allRows.push({
          name: row.name,
          cls: cls.key,
          rank,
          dps: row.dps ?? null,
          burst: row.burst ?? null,
          ehp: row.ehp ?? null,
          score: row.overall ?? null,
          tank: row.tankt ?? null,
          hybrid: row.hybridt ?? null,
          dpst: row.dpst ?? null,
          overall: row.overallt ?? null,
        });
      }
    } catch (err) {
      console.error(`[${cls.key}] failed:`, err.message);
    }
  }

  await browser.close();

  const out = { ok: true, fetchedAt: new Date().toISOString(), rows: allRows };
  const outDir = path.join(__dirname, '..', 'data');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'leaderboard.json'), JSON.stringify(out, null, 2));
  console.log(`Wrote ${allRows.length} total rows to data/leaderboard.json`);
})();
