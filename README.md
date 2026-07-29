# Clover Terrace Weather Dashboard
*readme under construction 🚧*

A live weather page for *Clover Terrace*, my nickname for my small, hilltop micro-climate within Aliquippa (a historic city along the Ohio River).

Includes live data from my personal Ecowitt weather station, using the Weather Underground API. Updates minute by minute using both Cloudflare and Deno service workers for reliable updates every 60 seconds. No downtime during severe weather.


## how it pulls data from my ecowitt station 🌪️

1. **python scripts to pull data:**
    `scripts/fetch_weather.py` - calls the Weather Underground API to pull the newest data directly from the personal weather station, and saves the result to `data/weather.json`. this was the easiest option for ecowitt, but other weather stations may have their own native API system that work just as well. worth looking into if you don't want to upload your data to WU.
   
   `scripts/fetch_air_quality.py` - calls the latest PM2.5 reading from the closest PurpleAir sensor via their free API. 
   
   `scripts/fetch_camera.py` - calls the latest camera snapshot from the Ecowitt camera. (or whatever camera you're using, so long as it has API/APP, a MAC address and a stable url) and saves it to `data/camera.jpg`
   
   `scripts/fetch_forecast.py` -  calls the local forecast directly from the National Weather Service API for this zip code.
   
   `scripts/fetch_outlook.py` - calls the current SPC day 1, day 2, and day 3 convective outlook images and saves them to `data/outlook-day1.png`, `data/outlook-day2.png`, `data/outlook-day3.png`

   
3. **workflow to update data on page**
  `.github/workflows/update-weather.yml` runs that script every 5 minutes, commits the updated file directly to the page. can be run manually, on demand, as often as you'd like.
*(time slots are offset to every 3rd, 8th, 13th, 18th, 23rd, etc minute for more reliable automatic updates, due to the standard 5/10/15/20 timeslots typically being inundated with the heaviest server traffic)*

4. for reliability, I added two service workers via Cloudflare and Deno Deploy. this ensures that the data is updated every 45-60 seconds, even if the scheduled workflow fails.

   
5. **where it all comes together**
   `index.html` fetches
     1. `data/weather.json` to populate weather station data cards
     2. `data/air_quality.json` to populate updated AQI card
     3. `data/camera.jpg` to load the latest camera image
     4. `data/forecast.json` to load the local forecast
     5. `data/history.json` to feed stored data to the historical graphs
     6. `data/outlook-day1, day2.json, day3.png` to populate outlook images
and puts it all together to create a cozy little weather dashboard for you and your family/neighborhood to use for at-a-glance weather information.

   

## do it yourself ⛈️
*under construction*

1. **create the repo**
download the files, and the add them to a new GitHub repository with pages enabled. name it whatever you want, but it's case sensitive!

2. **get a weather underground API key** (free) at
   https://www.wunderground.com/member/api-keys — log in with the account
   linked to your station.  
   *because ecowitt doesn't have a native way to do this, I used Leo Herzog's Weather   Underground Forwarder (https://github.com/leoherzog/WundergroundStationForwarder)*

3.  **get your station ID.** this is the ID you already use when uploading
   data from your Ecowitt console/gateway to Weather Underground (looks
   like `KPAPLACE44`).

6. **add two repository secrets:**
   go to your repo → Settings → Secrets and variables → Actions → New
   repository secret, and add:
   - `WU_STATION_ID` — your station ID
   - `WU_API_KEY` — your API key

7. **enable GitHub page:**
   setting → pages → source: "deploy from a branch" → select `main` and
   `/ (root)`.

8. **run the workflow once manually** to generate the first
   `data/weather.json`: go to the actions tab → "Update Weather Data" →
   "run workflow". after that it'll run automatically every 5 minutes, or as frequently as the git gods allow.

9. visit your page URL (something like
   `https://yourusername.github.io/your-repo-name/`) and you should see
   your live conditions. 

## camera setup 🌤️

 since I built this around my ecowitt camera, it should be easy for you to replicate it if you have an ecowitt camera, but with some fiddling around you could change the code to accomodate your camera of choice. you can also remove this whole section of code if you don't need it since failure to fetch any one data point won't crash the whole page. 
 
 the script searches the response for an image URL rather than assuming one exact key path. if it can't find one on the first run, check the "Fetch latest camera snapshot" step's log in the Actions tab — the script prints the full raw API response there so you can see the actual key path and adjust `find_image_url()` if needed.

**ecowitt hp10 specific insteuctions**
1. log into https://www.ecowitt.net with the account tied to your
   console/camera, and create an **Application Key** and **API Key**
   under the Member Center / API section.
2. find your station's **MAC address or IMEI** in the device list on
   ecowitt.net.
3. add three repository secrets, making sure to paste the numbers into the secret text box EXACTLY as you see them. trailing spaces before or after will cause this card to be blank.
   - `ECOWITT_APP_KEY`
   - `ECOWITT_API_KEY`
   - `ECOWITT_MAC`
  

## local forecast 

pulled directly from NWS via their free and public API



## sun & moon position tracker

pulls positions and imagery from NASA and NOAA to create a real time sky tracking system, with sunrise, solar noon, and sunset calculations.. complete with the moon phase, kp index, and stargazing conditions. 

## SPC convective outlooks

pulls the most recent outlooks issued by the SPC (Storm Prediction Center) 


## historical graph 🌦️

data from the weather station is stored, then fed to `charts.umd.min.js` to create graphs for humidity & temperature, wind speed & gusts, wind direction and solar illumination.

created using Chart.js v4.4.4
 * https://www.chartjs.org
 * https://github.com/kurkle/color#readme



##refresh button



## visitor counter ⛅



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
