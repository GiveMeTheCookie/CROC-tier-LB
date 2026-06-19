// scraper/scrape.js — plain Playwright with stealth headers
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const CLASSES = [
  { key: 'warrior', param: 0 },
  { key: 'mage',    param: 1 },
  { key: 'archer',  param: 2 },
  { key: 'shaman',  param: 3 },
];

const BASE = 'https://onex.shturmovi.cc/tierlists/';
const STABLE_ROUNDS_NEEDED = 3;
const MAX_SCROLL_ATTEMPTS = 60;

function stripTags(s) {
  return s.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
}

async function scrapeClass(page, cls) {
  const url = `${BASE}?c=${cls.param}`;
  console.log(`[${cls.key}] navigating to ${url}`);
  await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 });

  // Wait for Cloudflare challenge to clear
  try {
    await page.waitForFunction(
      () => !document.title.includes('Just a moment'),
      { timeout: 20000 }
    );
  } catch {
    console.log(`[${cls.key}] CF check timeout, proceeding anyway`);
  }

  await page.waitForSelector('table tbody tr, table tr', { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(2000);

  if (cls.key === 'warrior') {
    const html = await page.content();
    fs.writeFileSync(path.join(__dirname, '..', 'data', 'debug.html'), html);
    console.log(`[debug] dumped rendered HTML, length ${html.length}`);
  }

  let stableRounds = 0;
  let lastCount = 0;

  for (let i = 0; i < MAX_SCROLL_ATTEMPTS; i++) {
    const clicked = await page.evaluate(() => {
      const candidates = Array.from(document.querySelectorAll('button, a, div[role="button"]'));
      const match = candidates.find(el => {
        const t = (el.textContent || '').trim().toLowerCase();
        return /load more|show more|next|more results|view more/.test(t) && el.offsetParent !== null;
      });
      if (match) { match.scrollIntoView(); match.click(); return true; }
      return false;
    });

    await page.evaluate(() => {
      window.scrollTo(0, document.body.scrollHeight);
      document.querySelectorAll('div, section').forEach(el => {
        if (el.scrollHeight > el.clientHeight + 50) el.scrollTop = el.scrollHeight;
      });
    });

    await page.waitForTimeout(clicked ? 1200 : 800);

    const count = await page.evaluate(
      () => document.querySelectorAll('table tbody tr, table tr').length
    );

    if (count <= lastCount) stableRounds++;
    else stableRounds = 0;
    lastCount = count;

    if (stableRounds >= STABLE_ROUNDS_NEEDED) {
      console.log(`[${cls.key}] row count stable at ${count}, stopping (attempt ${i + 1})`);
      break;
    }
  }

  const rawRows = await page.evaluate(() => {
    const trs = Array.from(document.querySelectorAll('table tr'));
    return trs.map(tr => {
      const tds = Array.from(tr.querySelectorAll('td'));
      if (tds.length < 9) return null;
      return tds.map(td => td.innerHTML);
    }).filter(Boolean);
  });

  console.log(`[${cls.key}] extracted ${rawRows.length} raw rows`);

  const parsed = [];
  let rank = 0;
  for (const cells of rawRows) {
    rank++;
    const nameRaw = stripTags(cells[0]);
    const name = nameRaw.replace(/^\d+\s*/, '').trim();
    if (!name) continue;
    const num = s => {
      const n = parseFloat(stripTags(s).replace(/,/g, ''));
      return Number.isNaN(n) ? null : n;
    };
    parsed.push({
      name, cls: cls.key, rank,
      dps: num(cells[1]), burst: num(cells[2]), ehp: num(cells[3]),
      score: num(cells[4]),
      tank: stripTags(cells[5]), hybrid: stripTags(cells[6]),
      dpst: stripTags(cells[7]), overall: stripTags(cells[8]),
    });
  }
  return parsed;
}

(async () => {
  const browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
    ]
  });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    locale: 'en-US',
    timezoneId: 'America/New_York',
    extraHTTPHeaders: {
      'Accept-Language': 'en-US,en;q=0.9',
    },
  });

  // Hide webdriver flag
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });

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

  const out = { ok: true, fetchedAt: new Date().toISOString(), rows: allRows };
  const outDir = path.join(__dirname, '..', 'data');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'leaderboard.json'), JSON.stringify(out, null, 2));
  console.log(`Wrote ${allRows.length} total rows to data/leaderboard.json`);
})();
