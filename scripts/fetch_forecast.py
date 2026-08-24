#!/usr/bin/env python3
"""
fetches the local forecast (both the day/night periods and an hourly breakdown) 
from the National Weather Service (NWS) API for the station,
saves a simplified version to data/forecast.json

the NWS API is free and public but it does require a
descriptive User-Agent identifying the calling app/site (their usage
policy asks for this so they can reach out if something's misbehaving),
which is set below. feel free to swap in your own site URL/contact.
"""

import json
import os
import sys
import urllib.request
import urllib.error

# coordinates for zip 15001 (Aliquippa, PA). NWS forecasts are looked up
# by lat/lon, not zip code directly, but since this location doesn't move,
# hardcoding it here avoids an extra geocoding call on every run.
LATITUDE = 40.604
LONGITUDE = -80.286

# NWS asks API users to identify their application/site in the User-Agent.
USER_AGENT = "(home-weather-station-dashboard, https://cloverterrace.github.io/Weather/)"

POINTS_URL = f"https://api.weather.gov/points/{LATITUDE},{LONGITUDE}"

# how many forecast periods to keep (each period is roughly a day or
# night — e.g. "Today", "Tonight", "Tuesday", "Tuesday Night" ...).
MAX_PERIODS = 4

# How many hourly entries to keep for the hourly strip (24 = full day ahead).
MAX_HOURS = 24


def extract_pop(period):
    """NWS periods carry probabilityOfPrecipitation as {value, unitCode}
    (value is already a plain percent — unitCode is just 'wmoUnit:percent').
    Missing/None values are common overnight or far out — keep None rather
    than coercing to 0, so the frontend can omit the chip instead of
    showing a misleading "0%"."""
    pop = period.get("probabilityOfPrecipitation") or {}
    return pop.get("value")


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
    props = points.get("properties", {})
    forecast_url = props.get("forecast")
    hourly_url = props.get("forecastHourly")

    if not forecast_url:
        print("ERROR: Could not find a forecast URL in the NWS points response.", file=sys.stderr)
        print(json.dumps(points, indent=2), file=sys.stderr)
        sys.exit(1)

    forecast = fetch_json(forecast_url)
    periods = forecast.get("properties", {}).get("periods", [])

    if not periods:
        print("ERROR: No forecast periods returned.", file=sys.stderr)
        sys.exit(1)

    simplified_periods = []
    for period in periods[:MAX_PERIODS]:
        simplified_periods.append({
            "name": period.get("name"),
            "temperature": period.get("temperature"),
            "temperatureUnit": period.get("temperatureUnit"),
            "windSpeed": period.get("windSpeed"),
            "windDirection": period.get("windDirection"),
            "shortForecast": period.get("shortForecast"),
            "detailedForecast": period.get("detailedForecast"),
            "isDaytime": period.get("isDaytime"),
            "probabilityOfPrecipitation": extract_pop(period),
        })

    simplified_hourly = []
    if hourly_url:
        try:
            hourly_forecast = fetch_json(hourly_url)
            hourly_periods = hourly_forecast.get("properties", {}).get("periods", [])
            for period in hourly_periods[:MAX_HOURS]:
                simplified_hourly.append({
                    "startTime": period.get("startTime"),
                    "temperature": period.get("temperature"),
                    "temperatureUnit": period.get("temperatureUnit"),
                    "windSpeed": period.get("windSpeed"),
                    "windDirection": period.get("windDirection"),
                    "shortForecast": period.get("shortForecast"),
                    "isDaytime": period.get("isDaytime"),
                    "probabilityOfPrecipitation": extract_pop(period),
                })
        except SystemExit:
            print("WARNING: Hourly forecast fetch failed; continuing with daily periods only.", file=sys.stderr)
            simplified_hourly = []
    else:
        print("WARNING: No forecastHourly URL in the NWS points response; skipping hourly.", file=sys.stderr)

    output = {
        "periods": simplified_periods,
        "hourly": simplified_hourly,
    }

    os.makedirs("data", exist_ok=True)
    with open("data/forecast.json", "w") as f:
        json.dump(output, f, indent=2)

    print(f"Wrote data/forecast.json with {len(simplified_periods)} periods and {len(simplified_hourly)} hourly entries.")


if __name__ == "__main__":
    main()
