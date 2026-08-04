# Clover Terrace Weather Dashboard, created by Alyssa Rozsa 🍀

A live weather page for Clover Terrace, a higher-elevation micro-climate within Aliquippa, PA. Conditions come primarily from a home weather station (Ecowitt gateway → WeeWX) running on-site, with Weather Underground's cloud API as an automatic backup whenever the home server is unreachable — or when just one sensor reading drops out.

**Live at:** <https://cloverterrace.github.io/weather/>


### 1. the home server (primary source) 🍀

a local machine (`wx-server`) runs [WeeWX](https://weewx.com/) against an Ecowitt gateway via the `interceptor` driver. A custom WeeWX service, `scripts/weewx_json_export.py` — kept here as a **reference copy only**; it actually runs on the WeeWX box, not in CI — writes `data/weather.json` on every loop packet and appends to `data/history.json` on every archive record, straight into a local clone of this repo. It also:

- holds onto the last known-good pressure / solar radiation / precip rate reading for a few minutes, so one missed sensor read doesn't blank the dashboard;
- tracks the lightning sensor (strikes today, distance/time of the most recent one), if you have one mapped.

a systemd timer, `weather-committer.timer` → `weather-committer.service` (calling `scripts/commit_and_push.sh`, also a **reference copy**), commits and pushes `data/weather.json` + `data/history.json` to `main` every 2 minutes — but only if something actually changed. If the push is rejected (e.g. the GitHub Actions fallback below pushed while the server was catching back up), it rebases with `-X theirs`: the home server's own live reading always wins, since it's the freshest source once it's back online.

### 2. GitHub Actions (fallback + everything else) 🌩️

`.github/workflows/update-weather.yml` runs on demand (see #3) and does two separate jobs, plus a handful of auxiliary fetches:

- **Staleness check / fallback** (`scripts/check_and_fallback.py`) — if `data/weather.json` hasn't been updated by the home server in the last 20 minutes, this pulls current conditions from the Weather Underground PWS API instead and overwrites `data/weather.json` + `data/history.json` directly. This is what keeps the site alive if the home server goes offline.
- **Always-on WU backup** (`scripts/fetch_weather_backup.py`) — runs every time, regardless of staleness, and writes current WU conditions to a *separate* file, `data/weather_wu.json`. It never touches `weather.json`/`history.json`, so it can't conflict with the home server's own commits. The dashboard uses this file to backfill individual fields the home server occasionally reports as null — see "the dashboard" below.
- **Auxiliary data** (all `continue-on-error`, so a hiccup in any one of these never blocks a weather update): camera snapshot, local forecast, air quality (PurpleAir), SPC outlook images, active weather alerts, aurora/Kp index.
- **Commit step**: auxiliary files are always eligible to commit; `weather.json`/`history.json` are only committed here when the fallback actually fired (the home server owns those files the rest of the time). If a push gets rejected — two runs landing close together — it re-fetches, re-points the branch at the new tip, and retries (up to 5 times) rather than failing the whole job.

### 3. What actually triggers a run

There's no cron schedule left in the workflow file itself — it's `workflow_dispatch` only, fired by:

- A **Cloudflare Worker** (`weather-refresh-trigger.cloverwx4.workers.dev`) — has both an on-demand endpoint (called by the dashboard's refresh button) *and* its own Cron Trigger, currently every 5 minutes.
- A **Deno Deploy** project (`weather-refresh-trigger.cloverwx.deno.net`) — a fallback endpoint if the Cloudflare one is unreachable. No schedule of its own; it only ever responds to POST requests.
- The dashboard's own **refresh button** — POSTs to whichever endpoint answers first, gated by a 10-minute client-side cooldown so a single visitor can't spam runs.

### 4. The dashboard (`index.html`)

Polls `data/weather.json` every 60 seconds. On every load, it also fetches `data/weather_wu.json` and merges the two client-side:

- If the home server's data is fresh (< 15 min old), any individual field it left `null` gets backfilled from the WU reading, field by field.
- If the home server's data is stale (> 15 min old), the WU reading is used wholesale instead of patching a dead file one field at a time.

That split means the site survives both failure modes — "one sensor glitched for a minute" and "the whole home server is offline" — without a visitor ever seeing a blank tile, using whichever mechanism actually fits the situation.

## repo layout 🗂️

```
data/                          -- generated at runtime, not meant to be hand-edited
  weather.json                    home-server (or WU fallback) current conditions
  weather_wu.json                 always-fresh WU reading, for client-side backfill
  history.json                    rolling window of readings, powers the chart
  camera.jpg, forecast.json, air_quality.json, alerts.json,
  aurora.json, outlook-day1/2/3.png

scripts/
  weewx_json_export.py          runs on the WeeWX box — reference copy only
  commit_and_push.sh            runs on the WeeWX box via systemd timer — reference copy only
  check_and_fallback.py         staleness check + WU fallback (run by the Action)
  fetch_weather_backup.py       always-on WU backfill source (run by the Action)
  fetch_camera.py, fetch_forecast.py, fetch_air_quality.py,
  fetch_outlook.py, fetch_alerts.py, fetch_aurora.py
                                 auxiliary data (run by the Action)

.github/workflows/update-weather.yml   the Action itself
index.html                              the dashboard
sw.js                                    minimal service worker — app shell only, never caches /data/
manifest.json                          PWA manifest
```

> **housekeeping note:** `check_staleness.py` and `fetch_weather.py` may still be sitting in `scripts/` from an earlier version of this pipeline. Confirm whether `check_and_fallback.py` still calls into `fetch_weather.py` internally before deleting either — if not, they're safe to remove.

## how to re-create this page — WU-only, no home station ⛈️

The simplest version: one scheduled script, pulling straight from Weather Underground.

1. **Create the repo.** Public repos get GitHub Pages free; private repos need GitHub Pro/Team/Enterprise for Pages.
2. **Get a Weather Underground API key** (free) at <https://www.wunderground.com/member/api-keys> — log in with the account linked to your station.
3. **Find your Station ID** — the same ID you already use to upload from your console/gateway to Weather Underground (looks like `KPAPLACE44`).
4. **Add two repository secrets** (Settings → Secrets and variables → Actions → New repository secret):
   - `WU_STATION_ID`
   - `WU_API_KEY`
5. **Enable GitHub Pages** — Settings → Pages → Source: "Deploy from a branch" → `main`, `/ (root)`.
6. **Add a schedule.** In `.github/workflows/update-weather.yml`, add a `schedule:` trigger with a cron expression — every 5–10 minutes is a reasonable starting point (see the note above on why not to go tighter than that without a good reason).
7. **Run the workflow once manually** (Actions tab → "Update Weather Data" → "Run workflow") to generate the first `data/weather.json`.
8. Visit your Pages URL — `https://yourusername.github.io/your-repo-name/`.

## how to re-create this page — with your own station via WeeWX 🌦️

The fuller setup this repo actually runs now:

1. Do steps 1–5 above first (repo, WU key/station ID, secrets, Pages).
2. **Set up WeeWX** against your station/gateway (the `interceptor` driver works well for Ecowitt gateways pushing data locally). Drop `scripts/weewx_json_export.py` into your WeeWX `user/` directory and configure a `[JsonExport]` section in `weewx.conf` pointing `data_dir` at a local clone of this repo's `data/` folder — see the docstring at the top of that script for the exact config block.
3. **Set up the committer timer.** Copy `scripts/commit_and_push.sh` onto the WeeWX box, set `WEATHER_REPO_DIR` to your local clone path, and create a systemd timer/service pair to run it every couple of minutes (a tighter interval buys you nothing — the dashboard only polls once a minute).
4. **Set `STALE_THRESHOLD_MINUTES`** in the workflow's fallback step to however long you're comfortable letting the site go stale before it switches to WU — 20 minutes is a reasonable default.
5. **Set up a trigger.** Something needs to periodically call this repo's `actions/workflows/update-weather.yml/dispatches` GitHub API endpoint — a Cloudflare Worker or Deno Deploy script with a scheduled trigger both work well; keep the interval loose (5+ minutes) per the note above.
6. If you want a lightning card: make sure `lightning_strike_count` and `lightning_distance` are mapped in WeeWX's `[Interceptor]` → `sensor_map_extensions` and are landing in your database — the dashboard card only appears once `lightningStrikeCount` shows up as non-null in `weather.json`.

## customizing 🌈

- **Which fields show up, and their order/labels:** edit the card-building logic in the `<script>` block of `index.html` (`renderCards()`).
- **Colors/fonts:** the CSS variables near the top of `index.html`.
- **Update frequency:** governed by whatever's calling `workflow_dispatch` (Worker/Deno cron), plus `REFRESH_INTERVAL_MS` and `PRIMARY_STALE_MS` in `index.html`'s script block for how the dashboard itself polls and decides staleness.
- **Metric units:** change `units=e` to `units=m` in the WU fetch URL (both `check_and_fallback.py`'s internals and `fetch_weather_backup.py`), and adjust WeeWX's own unit system / the dashboard's unit labels to match.
- **Header identity:** `STATION_CALLSIGN` and `STATION_CITY` near the top of `index.html`'s script block — these are hardcoded rather than pulled from `data.stationID`, since that field reflects whichever backend is currently active (WU's internal PWS ID vs. your own callsign), not a fixed identity.

## historical graph 🌦️

`data/history.json` is a rolling window of past readings (temperature, humidity, wind, pressure, solar radiation — and lightning strike count/distance, when the home server is the source), trimmed to the most recent `MAX_HISTORY_ENTRIES`. `index.html` loads it with Chart.js (CDN, no build step) for the temperature/humidity chart and for computing today's highs/lows on each card.

## visitor counter ⛅

The footer counter uses [HitsCounter](https://hitscounter.dev/) — no signup, no API key. If your Pages URL ever changes, update the `HITSCOUNTER_URL` constant near the bottom of `index.html`'s `<script>` block to match exactly (including the trailing slash), or you'll start a fresh count under the new URL. Icon/color/label are also customizable there — see hitscounter.dev for the full picker.

## camera snapshot 🌤️

If your station has a camera accessory, `scripts/fetch_camera.py` pulls the latest snapshot from Ecowitt's own cloud API (separate from the WU/Findu data feed) and saves it as `data/camera.jpg`, served with cache-busting so it's always the freshest image. Ecowitt's response structure varies by device/firmware, so the script searches for an image URL rather than assuming one exact key path — check the "Fetch latest camera snapshot" step's log in the Actions tab if it can't find one; it prints the raw API response there. This step is `continue-on-error`, so a camera hiccup never blocks a weather-data update.

**Setup:** create an Application Key + API Key at ecowitt.net (Member Center → API), find your station's MAC/IMEI in the device list, and add `ECOWITT_APP_KEY`, `ECOWITT_API_KEY`, `ECOWITT_MAC` as repository secrets.

## compatibility with other personal weather stations ☔

The WU-only path should work with any PWS capable of uploading to Weather Underground — you just need an API key and station ID. The WeeWX path is broader still (WeeWX supports a wide range of consoles/gateways beyond Ecowitt via different drivers), but `weewx_json_export.py`'s observation-type names (`outHumidity`, `windDir`, `barometer`, etc.) assume WeeWX's standard schema, so it should work with any WeeWX-supported station with little to no change — the Ecowitt-specific parts of this repo are really just the camera script and the `interceptor` driver notes above.
