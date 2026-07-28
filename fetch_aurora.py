#!/usr/bin/env python3
"""
Pulls the latest planetary Kp-index from NOAA's Space Weather Prediction
Center (free, keyless, public data) and saves a simplified aurora-chance
read to data/aurora.json.

Kp visibility thresholds below are tuned loosely for Clover Terrace's
latitude (~40.6N) — at this latitude, aurora is normally only visible
during genuinely strong geomagnetic storms, not routine activity.
"""
import json
import os
import sys
import urllib.request
import urllib.error

API_URL = "https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json"


def categorize(kp):
    if kp >= 8:
        return "Likely!"
    if kp >= 7:
        return "Possible!"
    if kp >= 5:
        return "Elevated"
    return "Low"


def main():
    req = urllib.request.Request(API_URL, headers={"User-Agent": "clover-terrace-weather-station"})
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            rows = json.loads(resp.read())
    except (urllib.error.HTTPError, urllib.error.URLError) as e:
        print(f"ERROR: Failed to fetch Kp-index data: {e}", file=sys.stderr)
        sys.exit(1)

    # NOAA's current format is a plain array of objects, no header row:
    # [{"time_tag": "...", "Kp": 2.00, "a_running": 7, "station_count": 8}, ...]
    if not rows:
        print("ERROR: Empty response from NOAA.", file=sys.stderr)
        sys.exit(1)

    try:
        latest = rows[-1]
        time_tag = latest["time_tag"]
        kp = float(latest["Kp"])
    except (KeyError, TypeError, ValueError) as e:
        print(f"ERROR: Unexpected response shape from NOAA: {e}", file=sys.stderr)
        sys.exit(1)

    result = {
        "kp": kp,
        "auroraChance": categorize(kp),
        "observedAt": time_tag,
    }

    os.makedirs("data", exist_ok=True)
    with open("data/aurora.json", "w") as f:
        json.dump(result, f, indent=2)

    print(f"Saved data/aurora.json — Kp {kp} ({result['auroraChance']})")


if __name__ == "__main__":
    main()
