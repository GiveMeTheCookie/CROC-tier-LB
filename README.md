# Clan Leaderboard — full-list, self-updating

## Why this exists
The previous Cloudflare Worker proxy still only ever saw the top 50 rows per
class, because it fetched the same plain HTML the site sends to a browser
that hasn't run any JavaScript — and that HTML genuinely only contains 50
rows. Getting past that requires something that actually *executes* the
page's JS (clicking "load more" / scrolling), which only a real (headless)
browser can do. That's what this does.

## Setup (one-time, ~10 minutes)

1. **Create a new GitHub repo** (public — `raw.githubusercontent.com` only
   serves public repos without a token). Push all the files in this folder
   to it (`scraper/`, `.github/workflows/scrape.yml`, `data/`,
   `clan_leaderboard.html`).

2. **Enable write permissions for Actions:**
   Repo → Settings → Actions → General → "Workflow permissions" →
   select **"Read and write permissions"** → Save.
   (Without this, the Action can scrape but can't commit the result back.)

3. **Run the scraper once manually:**
   Repo → Actions tab → "Scrape Clan Leaderboard" → "Run workflow" button.
   Don't wait for the 6-hour schedule — trigger it now so you get data
   immediately.

4. **Check the run's logs.** Each class will print something like:
   ```
   [warrior] extracted 50 raw rows
   [warrior] row count stable at 50, stopping (attempt 4)
   ```
   - If the count goes **above 50** after scrolling/clicking, it worked —
     the site does have more data behind a "load more"/infinite-scroll
     mechanism and the scraper found it.
   - If it stays at exactly 50 even after several scroll attempts, that's
     real signal the source site doesn't expose more than 50 to anyone,
     logged-out — paste me that log output and I'll dig further (e.g.
     check if logging in unlocks more rows).

5. **Once `data/leaderboard.json` has real data,** copy its raw URL:
   `https://raw.githubusercontent.com/YOURNAME/YOURREPO/main/data/leaderboard.json`
   and paste it into `DATA_URL` near the top of `clan_leaderboard.html`'s
   `<script>` block.

6. Open `clan_leaderboard.html` (or enable GitHub Pages on the repo to get
   a permanent URL for it). It re-fetches the JSON on every page load and
   the JSON itself refreshes every 6 hours automatically — no manual work.

## If the scraper needs tuning
I wrote `scrape.js` with generic heuristics (click anything that looks like
"load more", scroll any scrollable container) since I can't load the live
site myself to inspect its exact DOM/JS. If step 4's log shows it's not
finding additional rows but you can see more than 50 players by manually
scrolling on the real site in your browser, open dev tools there, watch
the Network tab while you scroll, and tell me what request fires (URL +
method) — I'll wire the scraper to call that directly instead of relying on
scroll/click heuristics, which is more reliable than the current approach.
