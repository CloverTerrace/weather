#!/usr/bin/env python3
"""
Staleness-checked Weather Underground fallback.

Runs on the existing 15-minute GitHub Actions schedule. On every run it:

  1. Reads the obsTimeLocal already inside the committed data/weather.json.
  2. If that reading is fresh (< STALE_THRESHOLD_MINUTES old), does nothing
     at all -- no API call, no file write, no commit. This is the normal
     case on almost every run, so it never interferes with the home
     server's own minute-by-minute pushes.
  3. If it's stale (home server appears to be down), fetches current
     conditions from the WU PWS API and writes them into weather.json /
     history.json, tagged with "source": "wu_cloud_fallback".
  4. Before exiting, re-checks the freshness of weather.json one more time.
     If the home server pushed a fresh reading while this script was
     running, the fallback write is discarded and nothing is committed --
     this is the race guard against clobbering a real update.

Exit code / stdout signal what the calling workflow step should do:
  - Prints "FALLBACK_APPLIED" and exits 0 if it wrote fallback data that
    should be committed.
  - Prints "NO_ACTION" and exits 0 if nothing needed to change.

Requires WU_STATION_ID and WU_API_KEY as environment variables (same
secrets used elsewhere in the workflow).
"""

import json
import os
import sys
import urllib.request
import urllib.error
import subprocess
from datetime import datetime, timedelta

STALE_THRESHOLD_MINUTES = int(os.environ.get("STALE_THRESHOLD_MINUTES", "20"))
STATION_ID = os.environ.get("WU_STATION_ID")
API_KEY = os.environ.get("WU_API_KEY")

WEATHER_PATH = "data/weather.json"
HISTORY_PATH = "data/history.json"
MAX_HISTORY_ENTRIES = 14400


def read_weather():
    if not os.path.exists(WEATHER_PATH):
        return None
    try:
        with open(WEATHER_PATH) as f:
            return json.load(f)
    except (json.JSONDecodeError, ValueError):
        return None


def is_stale(weather):
    if not weather or not weather.get("obsTimeLocal"):
        return True
    try:
        obs_time = datetime.strptime(weather["obsTimeLocal"], "%Y-%m-%d %H:%M:%S")
    except ValueError:
        return True
    return datetime.now() - obs_time > timedelta(minutes=STALE_THRESHOLD_MINUTES)


def fetch_wu_current():
    url = (
        "https://api.weather.com/v2/pws/observations/current"
        f"?stationId={STATION_ID}&format=json&units=e&numericPrecision=decimal&apiKey={API_KEY}"
    )
    req = urllib.request.Request(url, headers={"User-Agent": "github-actions-weather-fallback"})
    with urllib.request.urlopen(req, timeout=15) as resp:
        raw = json.load(resp)
    observations = raw.get("observations")
    if not observations:
        raise RuntimeError("WU API returned no observations")
    obs = observations[0]
    imperial = obs.get("imperial", {})
    return {
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


def append_history(entry):
    history = []
    if os.path.exists(HISTORY_PATH):
        try:
            with open(HISTORY_PATH) as f:
                history = json.load(f)
        except (json.JSONDecodeError, ValueError):
            history = []
    history.append({
        "time": entry["obsTimeLocal"],
        "temp": entry["temp"],
        "humidity": entry["humidity"],
        "windSpeed": entry["windSpeed"],
        "windGust": entry["windGust"],
        "winddir": entry["winddir"],
        "pressure": entry["pressure"],
        "solarRadiation": entry["solarRadiation"],
    })
    history = history[-MAX_HISTORY_ENTRIES:]
    with open(HISTORY_PATH, "w") as f:
        json.dump(history, f, indent=2)


def git_pull_latest():
    # capture_output=True keeps git's own chatter ("From https://...",
    # "Fast-forward", etc.) out of this script's stdout -- otherwise it
    # leaks into the `result=$(...)` capture in the workflow and breaks
    # the GITHUB_OUTPUT parser, since only the final FALLBACK_APPLIED /
    # NO_ACTION line is meant to be on stdout.
    subprocess.run(["git", "pull", "origin", "main", "--rebase"], check=False, capture_output=True)


def main():
    if not STATION_ID or not API_KEY:
        print("ERROR: WU_STATION_ID and WU_API_KEY must be set.", file=sys.stderr)
        sys.exit(1)

    current = read_weather()
    if not is_stale(current):
        print("NO_ACTION")
        return

    print(f"Home server data looks stale (threshold: {STALE_THRESHOLD_MINUTES} min) "
          f"-- fetching WU fallback.", file=sys.stderr)
    fallback = fetch_wu_current()

    # Race guard: pull the latest committed state one more time and re-check
    # freshness before we write anything, in case the home server pushed a
    # fresh reading while we were making the API call above.
    git_pull_latest()
    latest = read_weather()
    if not is_stale(latest):
        print("Home server data became fresh again during fallback fetch -- "
              "discarding fallback, no changes made.", file=sys.stderr)
        print("NO_ACTION")
        return

    with open(WEATHER_PATH, "w") as f:
        json.dump(fallback, f, indent=2)
    append_history(fallback)

    print(f"Applied WU fallback for station {fallback['stationID']} "
          f"at {fallback['obsTimeLocal']}", file=sys.stderr)
    print("FALLBACK_APPLIED")


if __name__ == "__main__":
    main()
