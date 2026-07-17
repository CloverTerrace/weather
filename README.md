# Clover Terrace Weather Dashboard, created by Alyssa Rozsa 🍀

A live weather page for Clover Terrace, a higher elevation micro-climate within Aliquippa. Frequently updated throughout the day to provide current conditions from an Ecowitt station via the Weather Underground API.

## how to recreate this page for yourself 🌪️

1. `scripts/fetch_weather.py` calls the Weather Underground PWS "current
   conditions" API for your station and saves the result to
   `data/weather.json`.
2. `.github/workflows/update-weather.yml` runs that script every 10 minutes
   (and on demand) and commits the updated file back to the repo.
3. `index.html` fetches `data/weather.json` directly — since it's served
   from the same GitHub Pages domain, there's no CORS problem, and it's
   nearly instant to load.

## setup ⛈️

1. **Create the repo.** Push these files to a new GitHub repository
   (public or private both work, but Pages on a free plan requires public
   unless you have GitHub Pro/Team/Enterprise).

2. **Get a Weather Underground API key** (free) at
   https://www.wunderground.com/member/api-keys — log in with the account
   linked to your station.

3. **Find your Station ID.** This is the ID you already use when uploading
   data from your Ecowitt console/gateway to Weather Underground (looks
   like `KPAPLACE44`).

4. **Add two repository secrets:**
   Go to your repo → Settings → Secrets and variables → Actions → New
   repository secret, and add:
   - `WU_STATION_ID` — your station ID
   - `WU_API_KEY` — your API key

5. **Enable GitHub Pages:**
   Settings → Pages → Source: "Deploy from a branch" → select `main` and
   `/ (root)`.

6. **Run the workflow once manually** to generate the first
   `data/weather.json`: go to the Actions tab → "Update Weather Data" →
   "Run workflow". After that it'll run automatically every 10 minutes.

7. Visit your Pages URL (something like
   `https://yourusername.github.io/your-repo-name/`) and you should see
   your live conditions.

## historical graph 🌦️

Every time the workflow runs, `fetch_weather.py` now also appends the
current reading to `data/history.json` (temperature, humidity, wind
speed, pressure), then trims that file to the most recent
`MAX_HISTORY_ENTRIES` readings (1008 by default — 7 days' worth at a
10-minute fetch interval). `index.html` loads this file with Chart.js
(pulled from a CDN, no build step) and renders a temperature/humidity
line chart.

If you change how often the workflow runs (the cron schedule), you may
want to adjust `MAX_HISTORY_ENTRIES` in `fetch_weather.py` to keep the
same number of days of history — e.g. if you switch to fetching every 5
minutes, double it to keep 7 days' worth.

## visitor counter ⛅

The footer counter uses [CounterAPI](https://counterapi.dev)'s free v1
endpoint, which needs no signup or API key and works directly from
browser JavaScript. **Before deploying**, open `index.html` and change:

```js
const COUNTER_NAMESPACE = 'change-me-yourusername';
const COUNTER_NAME = 'weather-station-visits';
```

to something unique to you (e.g. your GitHub username and repo name).
CounterAPI's v1 counters are public — anyone who knows the
namespace/name combo can increment or read it — so a generic name risks
colliding with someone else's site.

A couple of caveats worth knowing:
- It counts **page loads**, not unique visitors — reloading the page
  increments it again.
- The counter only increments once per page load (it's deliberately not
  tied to the auto-refresh timers), so leaving the tab open won't
  inflate the number.

## camera snapshot 🌤️

If your station has a camera accessory, `scripts/fetch_camera.py` pulls
the latest snapshot from **Ecowitt's own cloud API** (this is separate
from Weather Underground/Findu — the camera image isn't part of that
data feed) and saves it as `data/camera.jpg`, which the page displays
with cache-busting so it always shows the freshest image rather than a
browser-cached one.

**setup:**
1. Log into https://www.ecowitt.net with the account tied to your
   console/camera, and create an **Application Key** and **API Key**
   under the Member Center / API section.
2. Find your station's **MAC address or IMEI** in the device list on
   ecowitt.net.
3. Add three more repository secrets (same place as the WU ones):
   - `ECOWITT_APP_KEY`
   - `ECOWITT_API_KEY`
   - `ECOWITT_MAC`

Ecowitt's response structure can vary slightly by device/firmware, so
the script searches the response for an image URL rather than assuming
one exact key path. If it can't find one on your first run, check the
"Fetch latest camera snapshot" step's log in the Actions tab — the
script prints the full raw API response there so you (or I) can see
the actual key path and adjust `find_image_url()` if needed. This step
is also set to not block the weather-data commit if it fails, so a
camera hiccup won't stop your temperature/humidity updates.

## customizing 🌈

- **Which fields show up, and their order/labels:** edit the `FIELDS`
  array near the top of the `<script>` block in `index.html`.
- **Colors/fonts:** edit the CSS variables at the top of `index.html`
  (`--bg-color`, `--accent-color`, etc.).
- **Update frequency:** change the cron schedule in
  `.github/workflows/update-weather.yml` (GitHub's minimum practical
  interval is about 5 minutes; note that scheduled workflows can be
  delayed further during periods of high GitHub Actions load).
- **Metric units:** change `units=e` to `units=m` in
  `scripts/fetch_weather.py`'s URL, and update the unit labels in
  `index.html` accordingly (°C, km/h, mm, hPa).

## compatibility with other personal weather stations ☔
I haven't tested it, but I'm sure this page template will work with just about any PWS (personal weather station) that is capable of sending data to websites like weatherunderground, Findu, CWOP, etc. You really just need to be able to generate API keys.
