# Clover Terrace Weather Dashboard **readme under construction**

A live weather page for Clover Terrace, my nickname for a small, hilltop micro-climate within Aliquippa (a historic city along the Ohio River).

Includes live data from an Ecowitt station using the Weather Underground API. Updated frequently throughout the day, especially during severe weather events. If GitHub servers are inundated, data may not be fetched automatically as scheduled. In these cases, updates are able to be pushed manually via actions > the update weather workflow. If you are using this guide to create your own version of this website, you can update your data manually as well this way.. I have included the "trigger refresh" button for now, although it seemingly isn't working at the moment. Hopefully I will be able to sort this out in future updates. 


## how it works 🌪️

1. **python scripts to pull data:**
    `scripts/fetch_weather.py` - calls the Weather Underground PWS "current conditions" API for your    station and saves the result to `data/weather.json`. this was the easiest option for ecowitt, but other weather stations may have their own API system that works just as well. worth looking into if you don't want to upload your data to WU. 
   `scripts/fetch_air_quality.py` - calls the latest PM2.5 reading from PurpleAir via their free API. a how-to on swapping out this sensor with yours or one of your choosing, see ##purpleair config
   `scripts/fetch_camera.py` - calls the latest camera snapshot from the Ecowitt camera. (or whatever camera you're using, so long as it has API/APP, a MAC address and a stable url) and saves it to `data/camera.jpg`
   `scripts/fetch_forecast.py` -  calls the local forecast directly from the National Weather Service API for the zip code of your choosing. No API key needed because the NWS is free and public. Adjust by swapping in your own coordinates.
   `scripts/fetch_outlook.py` - calls the current SPC day 1, day 2, and day 3 convective outlook images and saves them to `data/outlook-day1.png`, `data/outlook-day2.png`, `data/outlook-day3.png`
   
2. **workflow to update data on page**
  `.github/workflows/update-weather.yml` runs that script every 5 minutes, commits the updated file directly to the page. can be run manually, on demand, as often as you'd like.
*(time slots are offset to every 3rd, 8th, 13th, 18th, 23rd, etc minute for more reliable automatic updates, due to the standard 5/10/15/20 timeslots typically being inundated with the heaviest server traffic)*
   
3. **where it all comes together**
   `index.html` fetches `data/weather.json` directly — since it's served
   from the same GitHub Pages domain, there's no CORS problem, and it's
   nearly instant to load.

## how to re-create this page, using your own PWS data ⛈️

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

## camera setup 🌤️

I created this for my personal Ecowitt camera, but the same setup steps would apply to almost any other camera that has API functionality and a stable image url. Ecowitt's response structure can vary slightly by device/firmware, so the script searches the response for an image URL rather than assuming
one exact key path. If it can't find one on the first run, check the
"Fetch latest camera snapshot" step's log in the Actions tab — the
script prints the full raw API response there so you can see
the actual key path and adjust `find_image_url()` if needed. This
is also set to not block the weather-data commit if it fails, so a
camera hiccup won't stop your other updates.

1. Log into https://www.ecowitt.net with the account tied to your
   console/camera, and create an **Application Key** and **API Key**
   under the Member Center / API section.
2. Find your station's **MAC address or IMEI** in the device list on
   ecowitt.net.
3. Add three repository secrets, making sure to paste the numbers into the secret text box EXACTLY as you see them. trailing spaces before or after will cause this part to error out and not show data, but it shouldn't stop your other data from loading.
   - `ECOWITT_APP_KEY`
   - `ECOWITT_API_KEY`
   - `ECOWITT_MAC`



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

The footer counter uses [HitsCounter](https://hitscounter.dev/) to count
page visits via a unique URL — no signup, no API key needed! You will need to update
the `HITSCOUNTER_URL` constant near the bottom of the `<script>` block in
`index.html` to match your page's live URL *exactly* (including the
trailing slash) in order for this to work properly. If your Pages URL
ever changes, update this constant too, or you'll start a fresh count
under the new URL.

You can also customize the counter's appearance by editing the `label`,
`icon`, and `color` params in the fetch URL inside `initVisitorCounter()`
— see https://hitscounter.dev/ for the full icon picker and color list. 


## customizing 🌈

- **which fields show up, and their order/labels:** edit the `FIELDS`
  array near the top of the `<script>` block in `index.html`.
- **color/fonts:** edit the CSS variables at the top of `index.html`
  (`--bg-color`, `--accent-color`, etc.).
- **update frequency:** change the cron schedule in
  `.github/workflows/update-weather.yml` (GitHub's minimum practical
  interval is about 5 minutes; note that scheduled workflows can be
  delayed further during periods of high GitHub Actions load).
- **metric units:** change `units=e` to `units=m` in
  `scripts/fetch_weather.py`'s URL, and update the unit labels in
  `index.html` accordingly (°C, km/h, mm, hPa).
- **weather-based themes:** You can edit the themes yourself, choosing whatever hex color codes you'd like to create a unique theme triggered hy that weather condition being recorded by your PWS.

## note on compatibility with other personal weather stations ☔

I haven't tested it, this page template should work with just about any PWS (personal weather station) that is capable of sending data to websites like weatherunderground. as I mentioned earlier, some PWS brands may even have a more direct API functionality if you'd rather. ot upload data to WU.  
