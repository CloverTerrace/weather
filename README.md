# Clover Weather Center

a live weather page for Clover Terrace, a higher-elevation micro-climate within Aliquippa, PA. conditions come from a home weather station (Ecowitt gateway → WeeWX) running on-site, with Weather Underground's cloud API connected to the same weather station as an automatic backup whenever the home server is unreachable/when just one sensor reading drops out. I built this as a personal project to practice and experiment with coding and data. If you like the look, this readme should be enough to help you build it out yourself. 

**live at:** <https://cloverterrace.github.io/weather/>

this repo (`CloverTerrace/weather`) holds the site — `index.html`, styling, and the auxiliary data (camera, forecast, air quality, alerts, aurora, SPC outlook) grabbed by a GitHub Action. weewx readings (`weather.json`, `history.json`) live in a **separate, sibling repo, `CloverTerrace/weather-data`**

### 1. the home server (main source) ☀️

a local machine (`wx-server`) runs [WeeWX](https://weewx.com/) against an Ecowitt gateway via the `interceptor` driver. a custom WeeWX service, `scripts/weewx_json_export.py` kept here as a **reference copy only** writes `data/weather.json` on every loop packet and appends to `data/history.json` on every archive record, straight into a local clone of **`CloverTerrace/weather-data`** seperate from this repo. it also:

- holds onto the last known-good pressure / solar radiation / precip rate reading for a few minutes, so one missed sensor read doesn't blank the dashboard;
- tracks the lightning sensor (strikes today, distance/time of the most recent one), if you have one mapped.

a systemd timer, `weather-data-committer.timer` → `weather-data-committer.service` (calling `scripts/commit_and_push.sh`, also a **reference copy**), commits and pushes `data/weather.json` + `data/history.json` to `weather-data`'s `main` branch every 2 minutes if something actually changed. if the push is rejected (two writers landing close together), it rebases with `-X theirs`: the home server's own live reading always takes priority.

### 1a. two repos to avoid downtime ☔ 

`weather-data` the home server pushes every 2 "$ minutes, and a Pages site rebuilds on every push to its branch by default. committing straight into this repo at that cadence will regularly outrun GitHub Pages' build queue, leaving the live site soft-broken for stretches at a time.

splitting the fast-moving readings into their own Pages-less repo fixes that at the source: `weather-data` can churn as often as it wants with zero build cost, and `index.html` (in *this* repo) fetches `weather.json`/`history.json` directly from `weather-data`'s raw content URL (`raw.githubusercontent.com/...`) client-side, with a `?t=<timestamp>` cache-busting param on every request. this repo only rebuilds Pages to commit code changes — `index.html`, CSS, JS, or the auxiliary-data Action below.

### 2. github actions 🌩️

`.github/workflows/update-weather.yml` runs on demand (see #4) and fetches everything *except* the home-server readings:

- **always-on WU backup** (`scripts/fetch_weather_backup.py`) — runs every time and writes current Weather Underground conditions to `data/weather_wu.json` in *this* repo. the dashboard uses this to backfill individual fields the home server occasionally reports as null, and — if the whole home-server feed goes stale — as a wholesale stand-in. See "the dashboard" below for exactly how that split works; it's entirely client-side now.
- **auxiliary data** (all `continue-on-error`, so a hiccup in any one of these never blocks the rest): camera snapshot, local forecast, air quality (PurpleAir), SPC outlook images, active weather alerts, aurora/Kp index.
- **commit step**: these auxiliary files are the only thing this Action ever commits. `weather.json`/`history.json` are no longer touched here at all — the home server owns those exclusively, over in `weather-data`. if a push gets rejected (two runs landing close together), it re-fetches, re-points the branch at the new tip, and retries rather than failing.

### 3. the dashboard (`index.html`) ☁️

fetches `data/weather.json` and `data/history.json` directly from `CloverTerrace/weather-data`'s raw content URL every 60 seconds (`REFRESH_INTERVAL_MS`), each request cache-busted with `?t=<timestamp>`. seperately, it fetches `data/weather_wu.json` from *this* repo (still updated by the Action above) and merges the two client-side:

- if the home server's data is fresh (< 15 min old — `PRIMARY_STALE_MS`), any individual field it left `null` gets backfilled from the WU reading, field by field.
- if the home server's data is stale (> 15 min old), the WU reading is used instead of patching a dead file one field at a time.

the split means the site survives both failure modes: "one sensor glitched for a minute" AND "the whole home server is offline" without a visitor seeing a blank tile and without any GitHub Action needing to intervene. it also falls back to the last successful load, cached in `localStorage`, if a fetch fails immediately (in cases where the home server *and* the WU API are both unreachable at once).

### 4. update triggers ⛈️

there's no cron schedule in the workflow file itself. the home-server feed updates independently — `update-weather.yml` is `workflow_dispatch` only, fired by:

- a **cloudflare worker** (`weather-refresh-trigger.cloverwx4.workers.dev`) — has both an on-demand endpoint (called by the dashboard's refresh button) *and* its own Cron Trigger, currently every 5 minutes.
- a **Deno Deploy** project (`weather-refresh-trigger.cloverwx.deno.net`) — a fallback endpoint if the Cloudflare one is unreachable. no schedule of its own; it only ever responds to POST requests.
  the dashboard's own **refresh button** POSTs to whichever endpoint answers first, gated by a 10-minute client-side cooldown so a single visitor can't spam runs. it also immediately re-fetches `weather.json`/`history.json`/`forecast.json` client-side on click, independent of whether the Action run succeeds.

## repo layout ❄️

**`CloverTerrace/weather`** (this repo — the site):

```
data/                          -- generated at runtime by the Action, not hand-edited
  weather_wu.json                 always-fresh WU reading, for client-side backfill
  camera.jpg, forecast.json, air_quality.json, alerts.json,
  aurora.json, outlook-day1/2/3.png

scripts/
  weewx_json_export.py          runs on the WeeWX box — reference copy only
  commit_and_push.sh            runs on the WeeWX box via systemd timer — reference copy only
  fetch_weather_backup.py       always-on WU backfill source (run by the Action)
  fetch_camera.py, fetch_forecast.py, fetch_air_quality.py,
  fetch_outlook.py, fetch_alerts.py, fetch_aurora.py
                                 auxiliary data (run by the Action)

.github/workflows/update-weather.yml   the Action itself
index.html                              the dashboard
sw.js                                    minimal service worker — app shell only, never caches /data/
manifest.json                          PWA manifest
```

**`CloverTerrace/weather-data`** (sibling repo — no Pages, no Actions, just data):

```
data/
  weather.json                    home-server current conditions (weewx writes this directly)
  history.json                    rolling window of readings, powers the chart
scripts/
  commit_and_push.sh              runs on the WeeWX box via systemd timer, pushes to this repo
```

> **housekeeping note:** `check_staleness.py` and `fetch_weather.py` may still be sitting in `scripts/` (in this repo) from an earlier version of this pipeline, disregard, i’m keeping them around in case i need to reuse that code if i inevitably break something and can’t get it working again.

## how to re-create this page — WU-only, no home station 🌨️

the simplest version: one scheduled script, pulling straight from Weather Underground. no second repo needed for this path — a WU-only setup updates infrequently enough that a single repo's Pages build queue keeps up fine.

1. **create the repo.** public repos get GitHub Pages free; private repos need GitHub Pro/Team/Enterprise for Pages.
2. **get a Weather Underground API key** (free) at <https://www.wunderground.com/member/api-keys> — log in with the account linked to your station.
3. **find your Station ID** — the same ID you already use to upload from your console/gateway to Weather Underground (looks like `KPAPLACE44`).
4. **add two repository secrets** (Settings → Secrets and variables → Actions → New repository secret):
   - `WU_STATION_ID`
   - `WU_API_KEY`
5. **enable GitHub Pages** — Settings → Pages → Source: "deploy from a branch" → `main`, `/ (root)`.
6. **add a schedule.** In `.github/workflows/update-weather.yml`, add a `schedule:` trigger with a cron expression — every 5–10 minutes is a reasonable starting point.
7. **run the workflow once manually** (Actions tab → "Update Weather Data" → "Run workflow") to generate the first `data/weather.json`.
8. visit your Pages URL — `https://yourusername.github.io/your-repo-name/`.

## how to re-create this page — with your own station via WeeWX 🌪️

1. do steps 1–5 above first for your **site repo** (repo, WU key/station ID, secrets, Pages).
2. **create a second, sibling repo** (e.g. `yourname/weather-data`) with **no GitHub Pages attached** — leave Pages disabled entirely in its settings. Pushes here should never trigger a build.
3. **set up WeeWX** against your station/gateway (the `interceptor` driver works well for Ecowitt gateways pushing data locally). Drop `scripts/weewx_json_export.py` into your WeeWX `user/` directory and configure a `[JsonExport]` section in `weewx.conf` pointing `data_dir` at a local clone of the **data repo's** `data/` folder (not the site repo) — see the docstring at the top of that script for the exact config block.
4. **set up the committer timer** on the WeeWX box, targeting the data repo: copy `scripts/commit_and_push.sh` there, set `WEATHER_REPO_DIR` to your local clone of the *data* repo, and create a systemd timer/service pair to run it every couple of minutes. Use a **separate SSH deploy key** scoped to the data repo — reusing the site repo's key for two remotes doesn't work.
5. **point `index.html` at the data repo.** near the top of the `<script>` block, set `DATA_URL`/`HISTORY_URL` to build off `https://raw.githubusercontent.com/yourname/weather-data/main/data/...`, each with a `?t=<timestamp>` cache-buster on every fetch (already wired in — just change the base URL constant). no custom request headers on that fetch, or you'll trigger a CORS preflight that `raw.githubusercontent.com` doesn't support.
6. **set up a trigger** for the auxiliary-data Action (site repo). something needs to periodically call the site repo's `actions/workflows/update-weather.yml/dispatches` GitHub API endpoint — a Cloudflare Worker or Deno Deploy script with a scheduled trigger both work well; keep the interval loose (5+ minutes), since this Action only handles camera/forecast/AQ/alerts/aurora now, not the fast-moving readings.
7. if you have a lightning detector and want to add a card for that data: make sure `lightning_strike_count` and `lightning_distance` are mapped in WeeWX's `[Interceptor]` → `sensor_map_extensions` and are landing in your database — the dashboard card only appears once `lightningStrikeCount` shows up as non-null in `weather.json`.

## customizing 🌈

- **which fields show up, and their order/labels:** edit the card-building logic in the `<script>` block of `index.html` (`renderCards()`).
- **colors/fonts:** the CSS variables near the top of `index.html`.
- **update frequency:** the home-server feed updates as fast as weewx and the committer timer allow (2 minutes here) — that's independent of Pages builds now, so it's safe to go tighter if you want. The dashboard's own poll rate is `REFRESH_INTERVAL_MS`, and `PRIMARY_STALE_MS` controls how long a quiet primary feed is tolerated before the dashboard switches to the WU reading wholesale — both in `index.html`'s script block. Auxiliary data (camera, forecast, etc.) is governed by whatever's calling `workflow_dispatch` (Worker/Deno cron).
- **Metric units:** change `units=e` to `units=m` in the WU fetch URL (`fetch_weather_backup.py`'s internals), and adjust WeeWX's own unit system / the dashboard's unit labels to match.
- **header identity:** `STATION_CALLSIGN` and `STATION_CITY` near the top of `index.html`'s script block — these are hardcoded rather than pulled from `data.stationID`, since that field reflects whichever backend is currently active (WU's internal PWS ID vs. your own callsign), not a fixed identity.

## historical graph ☀️

`data/history.json` (in the **data repo**) is a rolling window of past readings (temperature, humidity, wind, pressure, solar radiation — and lightning strike count/distance, when the home server is the source), trimmed to the most recent `MAX_HISTORY_ENTRIES`. `index.html` fetches it from the data repo's raw content URL and loads it with Chart.js (CDN, no build step) for the temperature/humidity chart and for computing today's highs/lows on each card.

## visitor counter 🌤️

the footer counter uses [HitsCounter](https://hitscounter.dev/) — no signup, no API key. if your Pages URL ever changes, update the `HITSCOUNTER_URL` constant near the bottom of `index.html`'s `<script>` block to match exactly (including the trailing slash), or you'll start a fresh count under the new URL. icon/color/label are also customizable there — see hitscounter.dev for the full picker.

## camera snapshot 🌥️

if your station has a camera, `scripts/fetch_camera.py` pulls the latest snapshot from Ecowitt's own cloud API (separate from the WU/Findu data feed) and saves it as `data/camera.jpg` in the **site repo**, served with cache-busting so it's always the freshest image. Ecowitt's response structure varies by device/firmware, so the script searches for an image URL rather than assuming one exact key path — check the "Fetch latest camera snapshot" step's log in the Actions tab if it can't find one; it prints the raw API response there. This step is `continue-on-error`, so a camera hiccup never blocks a weather-data update.

**setup:** create an Application Key + API Key at ecowitt.net (Member Center → API), find your station's MAC/IMEI in the device list, and add `ECOWITT_APP_KEY`, `ECOWITT_API_KEY`, `ECOWITT_MAC` as repository secrets (on the site repo — that's where the Action running this script lives).

## compatibility with other personal weather stations ☁️

the WU-only path should work with any PWS capable of uploading to Weather Underground — you just need an API key and station ID, and a single repo is fine at that update cadence. the WeeWX path is broader still (WeeWX supports a wide range of consoles/gateways beyond Ecowitt via different drivers), but `weewx_json_export.py`'s observation-type names (`outHumidity`, `windDir`, `barometer`, etc.) assume WeeWX's standard schema, so it should work with any WeeWX-supported station with little to no change — the Ecowitt-specific parts of this repo are really just the camera script and the `interceptor` driver notes above. the two-repo split is only necessary once your update cadence gets fast enough to outrun a Pages build queue — if you're happy polling every 5–10 minutes, one repo is simpler and works fine.
