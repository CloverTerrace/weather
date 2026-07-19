#!/usr/bin/env python3
"""
Fetches current conditions for your personal weather station from the
Weather Underground PWS API and writes them to data/weather.json.

Requires two environment variables (set as GitHub Actions secrets):
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

# How many history entries to keep. At a 10-minute fetch interval,
# 1008 entries = 7 days of history. Lower this if you want a smaller
# repo/file size, or raise it if you fetch less often and want more days.
MAX_HISTORY_ENTRIES = 1440  # 10 days' worth at a 10-minute fetch interval

if not STATION_ID or not API_KEY:
    print("ERROR: WU_STATION_ID and WU_API_KEY must be set as environment variables.", file=sys.stderr)
    sys.exit(1)

URL = (
    "https://api.weather.com/v2/pws/observations/current"
    f"?stationId={STATION_ID}&format=json&units=e&apiKey={API_KEY}"
)

def fetch():
    try:
        req = urllib.request.Request(URL, headers={"User-Agent": "github-actions-weather-fetch"})
        with urllib.request.urlopen(req, timeout=15) as resp:
            return json.load(resp)
    except urllib.error.HTTPError as e:
        print(f"HTTP error fetching weather data: {e.code} {e.reason}", file=sys.stderr)
        sys.exit(1)
    except Exception as e:
        print(f"Error fetching weather data: {e}", file=sys.stderr)
        sys.exit(1)

def main():
    raw = fetch()

    observations = raw.get("observations")
    if not observations:
        print("ERROR: No observations returned. Is the station currently online?", file=sys.stderr)
        sys.exit(1)

    obs = observations[0]
    imperial = obs.get("imperial", {})

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
    }

    os.makedirs("data", exist_ok=True)
    with open("data/weather.json", "w") as f:
        json.dump(output, f, indent=2)

    # Append this reading to the rolling history file used for the chart.
    history_path = "data/history.json"
    history = []
    if os.path.exists(history_path):
        try:
            with open(history_path, "r") as f:
                history = json.load(f)
        except (json.JSONDecodeError, ValueError):
            history = []

    history.append({
        "time": output["obsTimeLocal"],
        "temp": output["temp"],
        "humidity": output["humidity"],
        "windSpeed": output["windSpeed"],
        "windGust": output["windGust"],
        "winddir": output["winddir"],
        "pressure": output["pressure"],
        "solarRadiation": output["solarRadiation"],
    })

    # Keep only the most recent MAX_HISTORY_ENTRIES readings.
    history = history[-MAX_HISTORY_ENTRIES:]

    with open(history_path, "w") as f:
        json.dump(history, f, indent=2)

    print(f"Wrote data/weather.json and data/history.json ({len(history)} entries) "
          f"for station {output['stationID']} at {output['obsTimeLocal']}")

if __name__ == "__main__":
    main()
