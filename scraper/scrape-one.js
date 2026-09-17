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
const MAX_PAGES = 30; // safety cap in case "next" never disables

function stripTags(s) {
  return s.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
}

function firstRowSignature(rows) {
  return rows.length ? JSON.stringify(rows[0]) : null;
}

async function readTableRows(page) {
  return page.evaluate(() => {
    const trs = Array.from(document.querySelectorAll('table tbody tr'));
    return trs.map(tr => {
      const tds = Array.from(tr.querySelectorAll('td'));
      if (tds.length < 8) return null;
      return tds.map(td => td.innerHTML);
    }).filter(Boolean);
  });
}

// Clicks the "next page" control. Returns true if a click happened AND the
// table actually changed afterward (guards against clicking a disabled/no-op
// button, e.g. on the last page).
async function goToNextPage(page) {
  const before = firstRowSignature(await readTableRows(page));

  const clicked = await page.evaluate(() => {
    // Find a pagination-looking cluster: a row of small buttons where at
    // least one is a bare page number, plus icon-only prev/next buttons.
    const allButtons = Array.from(document.querySelectorAll('button, a[role="button"]'));
    const numeric = allButtons.filter(b => /^\d+$/.test((b.textContent || '').trim()));
    if (numeric.length === 0) return false;

    // The "next" control is usually the sibling button immediately after
    // the active/highest page-number button, before a final "last page"
    // control. Prefer explicit aria-labels when present.
    const byAria = allButtons.find(b => {
      const label = (b.getAttribute('aria-label') || b.getAttribute('title') || '').toLowerCase();
      return label.includes('next') && !label.includes('last');
    });
    if (byAria && byAria.offsetParent !== null && !byAria.disabled && byAria.getAttribute('aria-disabled') !== 'true') {
      byAria.click();
      return true;
    }

    // Fallback: assume buttons are laid out [«][‹][...numbers...][›][»]
    // and walk the full button list to find the one right after the last
    // numeric button.
    const container = numeric[0].closest('div, nav, ul') || numeric[0].parentElement;
    if (!container) return false;
    const siblings = Array.from(container.querySelectorAll('button, a[role="button"]'));
    const lastNumericIdx = siblings.reduce((acc, el, idx) => (
      /^\d+$/.test((el.textContent || '').trim()) ? idx : acc
    ), -1);
    const next = siblings[lastNumericIdx + 1];
    if (next && next.offsetParent !== null && !next.disabled && next.getAttribute('aria-disabled') !== 'true') {
      next.click();
      return true;
    }
    return false;
  });

  if (!clicked) return false;

  // Give the client-side render a moment, then confirm the table actually
  // changed (guards against a disabled-but-clickable button being a no-op).
  await page.waitForTimeout(700);
  const after = firstRowSignature(await readTableRows(page));
  return after !== null && after !== before;
}

async function scrapeClass(page, cls) {
  const url = `${BASE}?l=${cls.param}`;
  console.log(`[${cls.key}] navigating to ${url}`);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 });

  try {
    await page.waitForFunction(
      () => !document.title.includes('Just a moment'),
      { timeout: 30000 }
    );
  } catch {
    console.log(`[${cls.key}] CF check timeout, proceeding anyway`);
  }

  await page.waitForSelector('table tbody tr, table tr', { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(2000);

  if (cls.key === 'warrior') {
    const html = await page.content();
    fs.writeFileSync(path.join(__dirname, '..', 'data', 'debug.html'), html);
    console.log(`[debug] dumped rendered HTML for warrior, length ${html.length}`);
  }

  // Try the embedded JSON first (cheapest, and still works IF the site ever
  // embeds the full dataset again instead of a per-page slice).
  const embeddedData = await page.evaluate((clsParam) => {
    const scripts = Array.from(document.querySelectorAll('script[data-sveltekit-fetched]'));
    for (const s of scripts) {
      if (s.dataset.url && s.dataset.url.includes(`tierlist`) && s.dataset.url.includes(String(clsParam))) {
        try {
          const parsed = JSON.parse(s.textContent);
          return JSON.parse(parsed.body);
        } catch { return null; }
      }
    }
    return null;
  }, cls.param);

  // Heuristic: if the embedded payload is suspiciously small (<=~55 rows),
  // it's probably just the current page slice, not the full list — so we
  // fall through to manual pagination instead of trusting it blindly.
  if (embeddedData && embeddedData.length > 55) {
    console.log(`[${cls.key}] using embedded JSON data: ${embeddedData.length} rows`);
    let rank = 0;
    return embeddedData.map(row => {
      rank++;
      return {
        name: row.name, cls: cls.key, rank,
        dps: row.dps ?? null, burst: row.burst ?? null, ehp: row.ehp ?? null,
        score: row.overall ?? null,
        tank: row.tankt ?? null, hybrid: row.hybridt ?? null,
        dpst: row.dpst ?? null, overall: row.overallt ?? null,
      };
    });
  }

  // Manual pagination: read page 1, click "next", read again, repeat.
  console.log(`[${cls.key}] paginated table detected, walking pages manually`);
  const seen = new Map(); // name -> row (dedupe across pages)
  let pageNum = 1;

  for (;;) {
    const rawRows = await readTableRows(page);
    for (const cells of rawRows) {
      const nameRaw = stripTags(cells[0]);
      const name = nameRaw.replace(/^\d+\s*/, '').trim();
      if (!name || seen.has(name)) continue;
      const num = s => {
        const n = parseFloat(stripTags(s).replace(/,/g, ''));
        return Number.isNaN(n) ? null : n;
      };
      seen.set(name, {
        name, cls: cls.key, rank: seen.size + 1,
        dps: num(cells[1]), burst: num(cells[2]), ehp: num(cells[3]),
        score: num(cells[4]),
        tank: stripTags(cells[5]), hybrid: stripTags(cells[6]),
        dpst: stripTags(cells[7]), overall: stripTags(cells[8]),
      });
    }
    console.log(`[${cls.key}] page ${pageNum}: +${rawRows.length} rows read, ${seen.size} unique so far`);

    if (pageNum >= MAX_PAGES) {
      console.log(`[${cls.key}] hit MAX_PAGES safety cap, stopping`);
      break;
    }

    const advanced = await goToNextPage(page);
    if (!advanced) {
      console.log(`[${cls.key}] no further pages, stopping at page ${pageNum}`);
      break;
    }
    pageNum++;
  }

  return Array.from(seen.values());
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
    extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' },
  });

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
