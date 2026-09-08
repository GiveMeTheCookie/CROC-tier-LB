// scraper/scrape-one.js — scrapes one class, called by workflow with class index arg
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const CLASSES = [
  { key: 'warrior', param: 0 },
  { key: 'mage',    param: 1 },
  { key: 'archer',  param: 2 },
  { key: 'shaman',  param: 3 },
];

const clsIndex = parseInt(process.argv[2] ?? '0', 10);
const cls = CLASSES[clsIndex];
if (!cls) { console.error('Invalid class index'); process.exit(1); }

const BASE = 'https://onex.shturmovi.cc/tierlists/';

function stripTags(s) {
  return s.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
}

(async () => {
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled'],
  });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    locale: 'en-US',
    timezoneId: 'America/New_York',
    extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' },
  });

  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });

  const page = await context.newPage();
  const url = `${BASE}?c=${cls.param}`;
  console.log(`[${cls.key}] navigating to ${url}`);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 });

  try {
    await page.waitForFunction(() => !document.title.includes('Just a moment'), { timeout: 30000 });
  } catch {
    console.log(`[${cls.key}] CF check timeout, proceeding anyway`);
  }

  await page.waitForSelector('table tbody tr, table tr', { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(3000);

  // Dump debug HTML for first class
  if (clsIndex === 0) {
    const html = await page.content();
    fs.writeFileSync(path.join(__dirname, '..', 'data', 'debug.html'), html);
    console.log(`[debug] dumped rendered HTML for ${cls.key}, length ${html.length}`);
  }

  // Try embedded JSON first
  const embeddedData = await page.evaluate((clsParam) => {
    const scripts = Array.from(document.querySelectorAll('script[data-sveltekit-fetched]'));
    for (const s of scripts) {
      if (s.dataset.url === `/api/tierlist/${clsParam}`) {
        try {
          const parsed = JSON.parse(s.textContent);
          return JSON.parse(parsed.body);
        } catch { return null; }
      }
    }
    return null;
  }, cls.param);

  let rows = [];

  if (embeddedData && embeddedData.length > 0) {
    console.log(`[${cls.key}] using embedded JSON data: ${embeddedData.length} rows`);
    let rank = 0;
    rows = embeddedData.map(row => ({
      name: row.name,
      cls: cls.key,
      rank: ++rank,
      dps: row.dps ?? null,
      burst: row.burst ?? null,
      ehp: row.ehp ?? null,
      score: row.overall ?? null,
      tank: row.tankt ?? null,
      hybrid: row.hybridt ?? null,
      dpst: row.dpst ?? null,
      overall: row.overallt ?? null,
    }));
  } else {
    // Fallback: scroll and parse HTML
    console.log(`[${cls.key}] falling back to HTML scraping`);
    let stableRounds = 0, lastCount = 0;
    for (let i = 0; i < 60; i++) {
      const clicked = await page.evaluate(() => {
        const match = Array.from(document.querySelectorAll('button, a, div[role="button"]'))
          .find(el => /load more|show more|next|more results|view more/.test((el.textContent||'').trim().toLowerCase()) && el.offsetParent !== null);
        if (match) { match.scrollIntoView(); match.click(); return true; }
        return false;
      });
      await page.evaluate(() => {
        window.scrollTo(0, document.body.scrollHeight);
        document.querySelectorAll('div, section').forEach(el => { if (el.scrollHeight > el.clientHeight + 50) el.scrollTop = el.scrollHeight; });
      });
      await page.waitForTimeout(clicked ? 1200 : 800);
      const count = await page.evaluate(() => document.querySelectorAll('table tbody tr').length);
      if (count <= lastCount) stableRounds++; else stableRounds = 0;
      lastCount = count;
      if (stableRounds >= 3) { console.log(`[${cls.key}] row count stable at ${count}, stopping (attempt ${i+1})`); break; }
    }

    const rawRows = await page.evaluate(() =>
      Array.from(document.querySelectorAll('table tbody tr')).map(tr => {
        const tds = Array.from(tr.querySelectorAll('td'));
        return tds.length >= 8 ? tds.map(td => td.innerHTML) : null;
      }).filter(Boolean)
    );
    console.log(`[${cls.key}] extracted ${rawRows.length} raw rows`);

    let rank = 0;
    for (const cells of rawRows) {
      const nameRaw = stripTags(cells[0]).replace(/^\d+\s*/, '').trim();
      if (!nameRaw) continue;
      const num = s => { const n = parseFloat(stripTags(s).replace(/,/g,'')); return isNaN(n) ? null : n; };
      rows.push({
        name: nameRaw, cls: cls.key, rank: ++rank,
        dps: num(cells[1]), burst: num(cells[2]), ehp: num(cells[3]),
        score: num(cells[4]),
        tank: stripTags(cells[5]), hybrid: stripTags(cells[6]),
        dpst: stripTags(cells[7]), overall: stripTags(cells[8]),
      });
    }
  }

  await browser.close();

  const outDir = path.join(__dirname, '..', 'data');
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `leaderboard-${cls.key}.json`);
  fs.writeFileSync(outFile, JSON.stringify(rows, null, 2));
  console.log(`Wrote ${rows.length} rows for ${cls.key} to data/leaderboard-${cls.key}.json`);
})();
