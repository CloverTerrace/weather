# Clover Weather Center

a live weather page for Clover Terrace, a higher-elevation micro-climate within Aliquippa, PA. conditions come from a home weather station (Ecowitt gateway → WeeWX) running on-site, with Weather Underground's cloud API connected to the same weather station as an automatic backup whenever the home server is unreachable/when just one sensor reading drops out. I built this as a personal project to practice and experiment with coding and data. If you like the look, this readme should be enough to help you build it out yourself.

**live at:** <https://cloverterrace.github.io/weather/>

this repo (`CloverTerrace/weather`) holds the site — `index.html`, styling, and the auxiliary data (camera, forecast, air quality, alerts, storm products, aurora, SPC outlooks) grabbed by a GitHub Action. weewx readings (`weather.json`, `history.json`) live in a **separate, sibling repo, `CloverTerrace/weather-data`**. camera snapshots and time-lapse video are served by a **third, standalone piece** — a Cloud Run service, not either repo (see "camera & time-lapse" below).

### 1. the home server (main source) ☀️

a local machine (`wx-server`) runs [WeeWX](https://weewx.com/) against an Ecowitt gateway (GW7673) using the **`gw1000` driver** (`driver = user.gw1000` in `weewx.conf`), which polls the gateway's local API directly over the LAN every `poll_interval` seconds — **not** the `interceptor` (push-based) driver an earlier version of this doc described. `poll_interval` is currently set to **4 seconds**.

that interval matters more than it looks like it should: Ecowitt/Fine Offset gateways track **gust** as a running max *internally*, between queries — so even a slower poll interval still catches the true peak gust, since the gateway already did the max-tracking for us. **sustained wind speed has no such internal tracking** — it's a plain instantaneous reading at the moment of the query. that means our own `windSpeed` peak can only ever be as good as our sampling rate: a brief spike that rises and falls faster than `poll_interval` is invisible to WeeWX no matter how good the downstream max-tracking logic is. if `windSpeed` peaks ever look suspiciously low next to the Ecowitt app's own "today's high," check this value before anything else.

a custom WeeWX service, `scripts/weewx_json_export.py` (kept here as a **reference copy only**) writes `data/weather.json` on every loop packet and appends to `data/history.json` on every archive record, straight into a local clone of **`CloverTerrace/weather-data`**, separate from this repo. it also:

- holds onto the last known-good pressure / solar radiation / precip rate reading for a few minutes, so one missed sensor read doesn't blank the dashboard;
- tracks `_interval_windspeed_max` — the true max `windSpeed` seen across all loop packets in the current archive interval — so `history.json`'s wind speed reflects a real peak rather than WeeWX's default interval *average*, which would otherwise almost always undercount;
- tracks the lightning sensor (strikes today, distance/time of the most recent one), if you have one mapped;
- runs the raw values through a de-glitch check for wind (near-zero sustained speed alongside a real gust reading is treated as a sensor glitch and held over, rather than shown as-is).

a systemd timer, **`weather-data-committer.timer`** → `weather-data-committer.service` (calling `scripts/commit_and_push.sh`, also a **reference copy**), commits and pushes `data/weather.json` + `data/history.json` to `weather-data`'s `main` branch **every 30 seconds** if something actually changed. if the push is rejected (two writers landing close together), it rebases with `-X theirs`: the home server's own live reading always takes priority.

### 1a. two repos to avoid downtime ☔

`weather-data` gets pushed to every 30 seconds, and a Pages site rebuilds on every push to its branch by default. committing straight into this repo at that cadence will regularly outrun GitHub Pages' build queue, leaving the live site soft-broken for stretches at a time.

splitting the fast-moving readings into their own Pages-less repo fixes that at the source: `weather-data` can churn as often as it wants with zero build cost, and `index.html` (in *this* repo) fetches `weather.json`/`history.json` directly from `weather-data`'s raw content URL (`raw.githubusercontent.com/...`) client-side, with a `?t=<timestamp>` cache-busting param on every request. this repo only rebuilds Pages to commit code changes — `index.html`, CSS, JS, or the auxiliary-data Action below.

### 2. github actions 🌩️

`.github/workflows/update-weather.yml` runs on demand (see "update triggers" below) and fetches everything *except* the home-server readings:

- **always-on WU backup** (`scripts/fetch_weather_backup.py`) — runs every time and writes current Weather Underground conditions to `data/weather_wu.json` in *this* repo. the dashboard uses this to backfill individual fields the home server occasionally reports as null, and — if the whole home-server feed goes stale — as a wholesale stand-in.
- **auxiliary data** (all `continue-on-error`, so a hiccup in any one of these never blocks the rest):
  - camera snapshot
  - local forecast
  - air quality (PurpleAir)
  - current SPC convective outlook images (day 1–3, plus day 4–8)
  - active weather alerts (`fetch_alerts.py` → `data/alerts.json`)
  - **SPC/NWS storm desk products** (`fetch_nws_products.py` → `data/nws_products.json`) — Mesoscale Discussions and Watches, surfaced in the dashboard's "Storm Center" card
  - **CAPE / storm instability** (`fetch_cape.py` → `data/cape.json` + `data/cape_history.json`) — powers the "Storm Potential" card's CAPE trend spark chart
  - aurora/Kp index
  - **satellite lightning (GOES GLM)** (`fetch_lightning_glm.py` → `data/lightning_glm.json`) — this is a *separate* lightning source from the home station's own local sensor; see "two lightning sources" below
- **commit step**: these auxiliary files are the only thing this Action ever commits. `weather.json`/`history.json` are no longer touched here at all — the home server owns those exclusively, over in `weather-data`. if a push gets rejected (two runs landing close together), it re-fetches, re-points the branch at the new tip, and retries rather than failing.

### two lightning sources ⚡️

there are two independent lightning feeds on this dashboard, and they answer different questions:

- **the home station's own sensor** (`lightningStrikeCount`/`lightningDistance` in `weather.json`, from WeeWX) — used for the "strikes today / nearest" tile, and to flag "lightning nearby" in the automatic theme logic (a strike within ~15 mi in the last ~15 min).
- **GLM satellite data** (`data/lightning_glm.json`, fetched by the Action) — used purely as a **radar overlay layer**, so you can see strikes across a wider area than your one sensor can detect, refreshed every 5 minutes.

if lightning counts look wrong somewhere, check which of the two you're actually looking at first.

### 3. the dashboard (`index.html`) ☁️

fetches `data/weather.json` and `data/history.json` directly from `CloverTerrace/weather-data`'s raw content URL every 15 seconds (`REFRESH_INTERVAL_MS`), each request cache-busted with `?t=<timestamp>`. separately, it fetches `data/weather_wu.json` from *this* repo (still updated by the Action above) and merges the two client-side:

- if the home server's data is fresh (< 15 min old — `PRIMARY_STALE_MS`), any individual field it left `null` gets backfilled from the WU reading, field by field.
- if the home server's data is stale (> 15 min old), the WU reading is used instead of patching a dead file one field at a time.

the split means the site survives both failure modes: "one sensor glitched for a minute" AND "the whole home server is offline" without a visitor seeing a blank tile and without any GitHub Action needing to intervene. it also falls back to the last successful load, cached in `localStorage`, if a fetch fails immediately (in cases where the home server *and* the WU API are both unreachable at once).

**today's highs/lows (`getExtremesSafe`).** every card's daily peak/low (temp, humidity, wind speed, wind gust, pressure, precip rate, solar radiation, UV) is computed by one shared function. it starts from the true max/min across today's `history.json` entries, then folds in the live reading if it beats that (since `history.json` only gains a new entry once per archive interval, and is only re-fetched every 5 minutes — a fresh spike shouldn't have to wait that long to show up as "today's high"). that merged extreme is written back into a running store (`cachedTodaysExtremes`) and persisted to `localStorage` on every tick, so a backgrounded mobile tab getting reclaimed/reloaded by the OS doesn't quietly reset an already-recorded peak back down to a stale, weaker value. the store resets itself at local midnight.

### 4. update triggers ⛈️

there's no cron schedule in the workflow file itself. the home-server feed updates independently — `update-weather.yml` is `workflow_dispatch` only, fired by:

- a **cloudflare worker** (`weather-refresh-trigger.cloverwx4.workers.dev`) — has both an on-demand endpoint (called by the dashboard's refresh button) *and* its own Cron Trigger, currently every 5 minutes. its only job is dispatching this one workflow — it never touches `weather-data`.
- a **Deno Deploy** project (`weather-refresh-trigger.cloverwx.deno.net`) — a fallback endpoint if the Cloudflare one is unreachable. no schedule of its own; it only ever responds to POST requests.

the dashboard's own **refresh button** POSTs to whichever endpoint answers first, gated by a 10-minute client-side cooldown so a single visitor can't spam runs. it also immediately re-fetches `weather.json`/`history.json`/`forecast.json` client-side on click, independent of whether the Action run succeeds.

### 5. other live features on the dashboard 🌈

a handful of cards/widgets don't map to any of the pipelines above — they either call a public API directly from the browser, or are self-contained client-side logic:

- **river gauge** — USGS site `03086000` (Dashields), fetched client-side every 15 minutes; stage is compared against `DASHIELDS_STAGES` for a plain-language flood-stage readout.
- **live radar** — RainViewer-based reflectivity and velocity layers, centered on the station's coordinates, refreshed every 10 minutes (velocity looks back 90 minutes of frames). includes an NWS active-warnings overlay for PA/OH/WV/MD/NY, and the GLM lightning overlay mentioned above.
- **earthquakes** — USGS's public GeoJSON feed, refreshed every 5 minutes.
- **skytracker** — sunrise/sunset/solar noon, moonrise/moonset and moon phase (rendered from a small set of phase images), plus a rough stargazing/aurora-visibility read derived from cloud cover and the aurora Kp index.
- **automatic theme switching** — the dashboard classifies current conditions (windy, thunderstorm-prone, raining, extreme heat, smoky air, lightning nearby) against a set of thresholds and can auto-switch its color theme accordingly; active alerts and a high aurora Kp both override this. visitors can also just pick a theme manually ("psst, try a theme").
- **push notifications** — web push infrastructure (a VAPID key pair + a separate worker endpoint, `PUSH_WORKER_URL`) is wired into the dashboard for watch/warning/Mesoscale Discussion alerts, but **isn't turned on yet** — both `PUSH_WORKER_URL` and `VAPID_PUBLIC_KEY` are still placeholder values in `index.html`. the button that would enable it stays hidden until both are set.

### camera & time-lapse 📷

live camera snapshots and "yesterday's time lapse" video are served by a **standalone Cloud Run service**, not by either GitHub repo. on `wx-server`, a set of systemd timers push into this pipeline independently of the weather-data commits:

- `clover-camera-upload.timer` — uploads fresh snapshots
- `daily-timelapse-video.timer` — builds/uploads the daily time-lapse
- `yearly-timelapse-collector.timer` / `yearly-timelapse-video.timer` — the same, for a yearly cut

the dashboard requests the day's time-lapse directly from the Cloud Run URL (built from the requested date). this is separate infrastructure from everything else in this doc — worth remembering if a camera/time-lapse issue ever comes up, since neither repo's Action or commit history will show anything related.

## repo layout ❄️

**`CloverTerrace/weather`** (this repo — the site):

```
data/                          -- generated at runtime by the Action, not hand-edited
  weather_wu.json                 always-fresh WU reading, for client-side backfill
  camera.jpg, forecast.json, air_quality.json, alerts.json,
  nws_products.json               Mesoscale Discussions / Watches ("Storm Center")
  cape.json, cape_history.json    storm instability, for the CAPE trend chart
  lightning_glm.json              satellite lightning, radar overlay only
  aurora.json, outlook-day1/2/3.png, outlook-day4-8.gif

scripts/
  weewx_json_export.py          runs on the WeeWX box — reference copy only
  commit_and_push.sh            runs on the WeeWX box via systemd timer — reference copy only
  fetch_weather_backup.py       always-on WU backfill source (run by the Action)
  fetch_camera.py, fetch_forecast.py, fetch_air_quality.py,
  fetch_outlook.py, fetch_alerts.py, fetch_aurora.py,
  fetch_cape.py, fetch_nws_products.py, fetch_lightning_glm.py
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

> **housekeeping note:** `check_staleness.py` and `fetch_weather.py` may still be sitting in `scripts/` (in this repo) from an earlier version of this pipeline, disregard, i'm keeping them around in case i need to reuse that code if i inevitably break something and can't get it working again.

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
3. **set up WeeWX** against your station/gateway. for Ecowitt gateways, the **`gw1000` driver** (polling the gateway's local API directly) is what this project actually uses — set `poll_interval` as low as your gateway/network comfortably tolerates (this project runs at 4 seconds) if you care about catching brief sustained-wind spikes; gust peaks are far more forgiving of a slower interval, for the reasons explained above. drop `scripts/weewx_json_export.py` into your WeeWX `user/` directory and configure a `[JsonExport]` section in `weewx.conf` pointing `data_dir` at a local clone of the **data repo's** `data/` folder (not the site repo) — see the docstring at the top of that script for the exact config block.
4. **set up the committer timer** on the WeeWX box, targeting the data repo: copy `scripts/commit_and_push.sh` there, set `WEATHER_REPO_DIR` to your local clone of the *data* repo, and create a systemd timer/service pair to run it every 30 seconds to a couple of minutes, depending how fast you want the live feed to be. Use a **separate SSH deploy key** scoped to the data repo — reusing the site repo's key for two remotes doesn't work.
5. **point `index.html` at the data repo.** near the top of the `<script>` block, set `DATA_URL`/`HISTORY_URL` to build off `https://raw.githubusercontent.com/yourname/weather-data/main/data/...`, each with a `?t=<timestamp>` cache-buster on every fetch (already wired in — just change the base URL constant). no custom request headers on that fetch, or you'll trigger a CORS preflight that `raw.githubusercontent.com` doesn't support.
6. **set up a trigger** for the auxiliary-data Action (site repo). something needs to periodically call the site repo's `actions/workflows/update-weather.yml/dispatches` GitHub API endpoint — a Cloudflare Worker or Deno Deploy script with a scheduled trigger both work well; keep the interval loose (5+ minutes), since this Action only handles camera/forecast/AQ/alerts/storm-products/CAPE/aurora/lightning-GLM now, not the fast-moving readings.
7. if you have a lightning detector and want to add a card for that data: make sure `lightning_strike_count` and `lightning_distance` are mapped in your WeeWX driver's own sensor-mapping options (`[[field_map_extensions]]` under `[GW1000]`, for this driver) and are landing in your database — the dashboard card only appears once `lightningStrikeCount` shows up as non-null in `weather.json`. this is separate from the GLM satellite overlay, which needs no sensor at all.
8. **camera + time-lapse (optional)** — this project's camera snapshots and time-lapse video are served by a standalone Cloud Run service fed by systemd timers on the WeeWX box, entirely outside both repos. you don't need this for a working dashboard — `fetch_camera.py` (Action-run, pulling from Ecowitt's own cloud API) already covers a simple live snapshot into the site repo. only build out something equivalent to the Cloud Run piece if you specifically want time-lapse video, too.
9. **push notifications (optional)** — the dashboard has web-push plumbing already in place for watch/warning/Mesoscale Discussion alerts; it just needs a deployed push worker and a VAPID key pair. Set `PUSH_WORKER_URL` and `VAPID_PUBLIC_KEY` near the top of `index.html`'s script block — the enable button stays hidden until both are filled in.

## customizing 🌈

- **which fields show up, and their order/labels:** edit the card-building logic in the `<script>` block of `index.html` (`renderCards()`).
- **colors/fonts:** the CSS variables near the top of `index.html`.
- **update frequency:** the home-server feed updates as fast as weewx and the committer timer allow (30 seconds here) — that's independent of Pages builds now, so it's safe to go tighter if you want. The dashboard's own poll rate is `REFRESH_INTERVAL_MS` (15 seconds), and `PRIMARY_STALE_MS` controls how long a quiet primary feed is tolerated before the dashboard switches to the WU reading wholesale — both in `index.html`'s script block. Auxiliary data (camera, forecast, etc.) is governed by whatever's calling `workflow_dispatch` (Worker/Deno cron).
- **Metric units:** change `units=e` to `units=m` in the WU fetch URL (`fetch_weather_backup.py`'s internals), and adjust WeeWX's own unit system / the dashboard's unit labels to match.
- **header identity:** `STATION_CALLSIGN` and `STATION_CITY` near the top of `index.html`'s script block — these are hardcoded rather than pulled from `data.stationID`, since that field reflects whichever backend is currently active (WU's internal PWS ID vs. your own callsign), not a fixed identity.
- **automatic theme thresholds:** the windy/thunderstorm/rain/extreme-heat/smoke/lightning-nearby constants near `classifyWeather()` in `index.html`'s script block.
- **radar/quake/river locations:** `RADAR_LAT`/`RADAR_LON`, `RADAR_SITE_ID` (IEM/RIDGE radar site, no leading "K"), `USGS_SITE_ID` (river gauge), and `SUNMOON_LAT`/`SUNMOON_LON` all live near the top of the relevant sections in `index.html`'s script block.

## historical graph ☀️

`data/history.json` (in the **data repo**) is a rolling window of past readings (temperature, humidity, wind, pressure, solar radiation — and lightning strike count/distance, when the home server is the source), trimmed to the most recent `MAX_HISTORY_ENTRIES`. `index.html` fetches it from the data repo's raw content URL and loads it with Chart.js (CDN, no build step) for the temperature/humidity chart and for computing today's highs/lows on each card (see `getExtremesSafe` above).

## visitor counter 🌤️

the footer counter uses [HitsCounter](https://hitscounter.dev/) — no signup, no API key. if your Pages URL ever changes, update the `HITSCOUNTER_URL` constant near the bottom of `index.html`'s `<script>` block to match exactly (including the trailing slash), or you'll start a fresh count under the new URL. icon/color/label are also customizable there — see hitscounter.dev for the full picker.

## camera snapshot 🌥️

if your station has a camera, `scripts/fetch_camera.py` pulls the latest snapshot from Ecowitt's own cloud API (separate from the WU/Findu data feed) and saves it as `data/camera.jpg` in the **site repo**, served with cache-busting so it's always the freshest image. Ecowitt's response structure varies by device/firmware, so the script searches for an image URL rather than assuming one exact key path — check the "Fetch latest camera snapshot" step's log in the Actions tab if it can't find one; it prints the raw API response there. This step is `continue-on-error`, so a camera hiccup never blocks a weather-data update. (Time-lapse video is a separate, standalone piece — see "camera & time-lapse" above.)

**setup:** create an Application Key + API Key at ecowitt.net (Member Center → API), find your station's MAC/IMEI in the device list, and add `ECOWITT_APP_KEY`, `ECOWITT_API_KEY`, `ECOWITT_MAC` as repository secrets (on the site repo — that's where the Action running this script lives).

## compatibility with other personal weather stations ☁️

the WU-only path should work with any PWS capable of uploading to Weather Underground — you just need an API key and station ID, and a single repo is fine at that update cadence. the WeeWX path is broader still (WeeWX supports a wide range of consoles/gateways beyond Ecowitt via different drivers), but `weewx_json_export.py`'s observation-type names (`outHumidity`, `windDir`, `barometer`, etc.) assume WeeWX's standard schema, so it should work with any WeeWX-supported station with little to no change — the Ecowitt-specific parts of this repo are really just the camera script and the `gw1000` driver notes above. the two-repo split is only necessary once your update cadence gets fast enough to outrun a Pages build queue — if you're happy polling every 5–10 minutes, one repo is simpler and works fine.
