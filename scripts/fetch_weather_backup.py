#!/usr/bin/env python3
"""
Always-on WU backup fetch -- writes data/weather_wu.json on every run,
regardless of whether the home weewx feed is currently stale, so the
dashboard always has a fresh WU reading on hand to backfill individual
fields weewx's feed leaves blank (see index.html's mergeWithWuBackup()).

This is deliberately separate from fetch_weather.py, which remains the
staleness-gated FULL failover (it overwrites weather.json + appends to
history.json outright when weewx looks down). This script never touches
those two files -- it only ever writes weather_wu.json -- so it's safe to
run every cycle without any risk of clobbering weewx's live data or its
history while weewx is healthy.

Requires the same two secrets as fetch_weather.py:
  WU_STATION_ID  - e.g. KPASOMEW3
  WU_API_KEY     - your Weather Underground API key
"""

import json
import os
import sys
import urllib.request
import urllib.error

STATION_ID = os.environ.get("WU_STATION_ID")
API_KEY = os.environ.get("WU_API_KEY")

if not STATION_ID or not API_KEY:
    print("ERROR: WU_STATION_ID and WU_API_KEY must be set as environment variables.", file=sys.stderr)
    sys.exit(1)

# Adding &numericPrecision=decimal forces the WU API to return exact floating
# point numbers (e.g. 74.8) instead of aggressively rounding to the nearest integer.
URL = (
    "https://api.weather.com/v2/pws/observations/current"
    f"?stationId={STATION_ID}&format=json&units=e&numericPrecision=decimal&apiKey={API_KEY}"
)


def fetch():
    try:
        req = urllib.request.Request(URL, headers={"User-Agent": "github-actions-weather-fetch"})
        with urllib.request.urlopen(req, timeout=15) as resp:
            return json.load(resp)
    except urllib.error.HTTPError as e:
        print(f"HTTP error fetching WU backup data: {e.code} {e.reason}", file=sys.stderr)
        sys.exit(1)
    except Exception as e:
        print(f"Error fetching WU backup data: {e}", file=sys.stderr)
        sys.exit(1)


def main():
    raw = fetch()

    observations = raw.get("observations")
    if not observations:
        print("ERROR: No observations returned. Is the station currently online?", file=sys.stderr)
        sys.exit(1)

    obs = observations[0]
    imperial = obs.get("imperial", {})

    # Same field names/shape as weather.json (and weewx's exporter) on
    # purpose -- the dashboard merge logic matches fields by key, so this
    # has to stay in sync with that schema if either one ever changes.
    output = {
        "stationID": obs.get("stationID"),
        "obsTimeLocal": obs.get("obsTimeLocal"),
        "obsTimeUtc": obs.get("obsTimeUtc"),
        "neighborhood": obs.get("neighborhood"),
        "humidity": obs.get("humidity"),
        "winddir": obs.get("winddir"),
        "uv": obs.get("uv"),
        "solarRadiation": obs.get("solarRadiation"),
        "temp": imperial.get("temp"),
        "heatIndex": imperial.get("heatIndex"),
        "windChill": imperial.get("windChill"),
        "dewpt": imperial.get("dewpt"),
        "windSpeed": imperial.get("windSpeed"),
        "windGust": imperial.get("windGust"),
        "pressure": imperial.get("pressure"),
        "precipRate": imperial.get("precipRate"),
        "precipTotal": imperial.get("precipTotal"),
        "source": "wu_cloud_fallback",
    }

    os.makedirs("data", exist_ok=True)
    with open("data/weather_wu.json", "w") as f:
        json.dump(output, f, indent=2)

    print(f"Wrote data/weather_wu.json for station {output['stationID']} at {output['obsTimeLocal']}")


if __name__ == "__main__":
    main()
