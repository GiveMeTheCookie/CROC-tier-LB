// scraper/scrape-one.js — scrapes one class with pagination
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

  await page.waitForSelector('table tbody tr', { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(2000);

  if (clsIndex === 0) {
    const html = await page.content();
    fs.writeFileSync(path.join(__dirname, '..', 'data', 'debug.html'), html);
    console.log(`[debug] dumped rendered HTML for ${cls.key}, length ${html.length}`);
  }

  const allRows = [];
  let pageNum = 1;

  while (true) {
    console.log(`[${cls.key}] scraping page ${pageNum}...`);

    // Extract embedded JSON for this page
    const embeddedData = await page.evaluate((clsParam) => {
      const scripts = Array.from(document.querySelectorAll('script[data-sveltekit-fetched]'));
      for (const s of scripts) {
        if (s.dataset.url && s.dataset.url.includes(`/api/tierlist/${clsParam}`)) {
          try {
            const parsed = JSON.parse(s.textContent);
            return JSON.parse(parsed.body);
          } catch { return null; }
        }
      }
      return null;
    }, cls.param);

    if (embeddedData && embeddedData.length > 0) {
      console.log(`[${cls.key}] page ${pageNum}: ${embeddedData.length} rows from embedded JSON`);
      for (const row of embeddedData) {
        allRows.push({
          name: row.name,
          cls: cls.key,
          rank: allRows.length + 1,
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
    } else {
      // Fallback: parse HTML table rows
      const rows = await page.evaluate(() => {
        return Array.from(document.querySelectorAll('table tbody tr')).map(tr => {
          const tds = Array.from(tr.querySelectorAll('td'));
          const name = tr.querySelector('td span:last-child')?.textContent?.trim() || '';
          if (!name || tds.length < 8) return null;
          const t = td => td?.textContent?.trim() || '';
          return {
            name,
            dps: parseFloat(t(tds[1])) || null,
            burst: parseFloat(t(tds[2])) || null,
            ehp: parseFloat(t(tds[3]).replace(/,/g,'')) || null,
            score: parseFloat(t(tds[4])) || null,
            tank: t(tds[5]),
            hybrid: t(tds[6]),
            dpst: t(tds[7]),
            overall: t(tds[8]),
          };
        }).filter(Boolean);
      });
      console.log(`[${cls.key}] page ${pageNum}: ${rows.length} rows from HTML`);
      for (const row of rows) {
        allRows.push({ ...row, cls: cls.key, rank: allRows.length + 1 });
      }
    }

    // Check for next page button
    const hasNext = await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('button, a'));
      const next = buttons.find(b => {
        const t = b.textContent?.trim();
        return (t === '>' || t === '›' || t === '→') && !b.disabled && !b.classList.contains('disabled');
      });
      if (next) { next.click(); return true; }
      // Also try SVG arrow buttons
      const allBtns = Array.from(document.querySelectorAll('button'));
      // Find the "next" pagination button - usually second to last or last
      const paginationBtns = allBtns.filter(b => b.closest('nav, [class*="pagination"], [class*="pager"]') || b.closest('div') && b.parentElement?.children.length > 2);
      return false;
    });

    if (!hasNext) {
      // Try clicking next page via pagination nav
      const clicked = await page.evaluate(() => {
        // Look for pagination area - buttons with single char or arrow
        const allBtns = Array.from(document.querySelectorAll('button'));
        // The ">" next button is usually near page numbers
        for (const btn of allBtns) {
          const txt = btn.textContent?.trim();
          if ((txt === '>' || txt === '›' || txt === '»' || txt === '→') && !btn.disabled) {
            btn.click();
            return true;
          }
        }
        // Try finding by aria-label
        const nextBtn = document.querySelector('[aria-label="Next"], [aria-label="next page"], button:last-child');
        if (nextBtn && !nextBtn.disabled) { nextBtn.click(); return true; }
        return false;
      });

      if (!clicked) {
        console.log(`[${cls.key}] no next page found, done at page ${pageNum}`);
        break;
      }
    }

    pageNum++;
    if (pageNum > 50) { console.log(`[${cls.key}] safety limit hit`); break; }

    // Wait for new page to load
    await page.waitForTimeout(2000);
    await page.waitForSelector('table tbody tr', { timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(1000);
  }

  await browser.close();

  console.log(`[${cls.key}] total: ${allRows.length} rows across ${pageNum} page(s)`);

  const outDir = path.join(__dirname, '..', 'data');
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `leaderboard-${cls.key}.json`);
  const out = { ok: true, rows: allRows };
  fs.writeFileSync(outFile, JSON.stringify(out, null, 2));
  console.log(`Wrote ${allRows.length} rows for ${cls.key} to data/leaderboard-${cls.key}.json`);
})();
