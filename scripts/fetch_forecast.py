#!/usr/bin/env python3
"""
Fetches the local forecast from the National Weather Service (NWS) API
for zip code 15001 (Aliquippa, PA) and saves a simplified version to
data/forecast.json.

No API key needed — the NWS API is free and public. It does require a
descriptive User-Agent identifying the calling app/site (their usage
policy asks for this so they can reach out if something's misbehaving),
which is set below. Feel free to swap in your own site URL/contact.
"""

import json
import os
import sys
import urllib.request
import urllib.error

# Coordinates for zip 15001 (Aliquippa, PA). NWS forecasts are looked up
# by lat/lon, not zip code directly, but since this location doesn't move,
# hardcoding it here avoids an extra geocoding call on every run.
LATITUDE = 40.604
LONGITUDE = -80.286

# NWS asks API users to identify their application/site in the User-Agent.
USER_AGENT = "(home-weather-station-dashboard, https://cloverterrace.github.io/Weather/)"

POINTS_URL = f"https://api.weather.gov/points/{LATITUDE},{LONGITUDE}"

# How many forecast periods to keep (each period is roughly a day or
# night — e.g. "Today", "Tonight", "Tuesday", "Tuesday Night" ...).
MAX_PERIODS = 4


def fetch_json(url):
    try:
        req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "application/geo+json"})
        with urllib.request.urlopen(req, timeout=15) as resp:
            return json.load(resp)
    except urllib.error.HTTPError as e:
        print(f"HTTP error calling NWS API ({url}): {e.code} {e.reason}", file=sys.stderr)
        sys.exit(1)
    except Exception as e:
        print(f"Error calling NWS API ({url}): {e}", file=sys.stderr)
        sys.exit(1)


def main():
    points = fetch_json(POINTS_URL)
    forecast_url = points.get("properties", {}).get("forecast")

    if not forecast_url:
        print("ERROR: Could not find a forecast URL in the NWS points response.", file=sys.stderr)
        print(json.dumps(points, indent=2), file=sys.stderr)
        sys.exit(1)

    forecast = fetch_json(forecast_url)
    periods = forecast.get("properties", {}).get("periods", [])

    if not periods:
        print("ERROR: No forecast periods returned.", file=sys.stderr)
        sys.exit(1)

    simplified = []
    for period in periods[:MAX_PERIODS]:
        simplified.append({
            "name": period.get("name"),
            "temperature": period.get("temperature"),
            "temperatureUnit": period.get("temperatureUnit"),
            "windSpeed": period.get("windSpeed"),
            "windDirection": period.get("windDirection"),
            "shortForecast": period.get("shortForecast"),
            "detailedForecast": period.get("detailedForecast"),
            "isDaytime": period.get("isDaytime"),
        })

    os.makedirs("data", exist_ok=True)
    with open("data/forecast.json", "w") as f:
        json.dump(simplified, f, indent=2)

    print(f"Wrote data/forecast.json with {len(simplified)} periods.")


if __name__ == "__main__":
    main()
