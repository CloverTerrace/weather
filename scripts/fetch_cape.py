#!/usr/bin/env python3
"""
Fetches current CAPE (Convective Available Potential Energy) for Clover
Terrace's location from Open-Meteo's free forecast API and writes
data/cape.json for the Pressure tile's new "Storm potential" glance metric.

Open-Meteo's `hourly=cape` field is well documented across their model
pages (confirmed via ECMWF, GFS GRAPES, etc. -- CAPE is listed as a native
hourly output for the models behind their default "best_match" blend,
which resolves to HRRR at 3km resolution for CONUS locations like this
one). There's no clean "just give me the single current value" shortcut,
so this pulls the hourly series for today and picks the entry matching
(or closest to) the current UTC hour.

NOTE: this script was written to spec but NOT execution-tested against
the live API -- this dev environment has no outbound network access.
Things worth checking on the first real run:
  - that `hourly.cape` never comes back null for the current hour (fall
    back to '--' on the frontend if so -- the tile already handles that)
  - that CAPE values look sane for a clear day (should be near 0) vs an
    unstable summer afternoon (four digits is normal ahead of storms)
  - add `requests` to whatever this repo's Python dependency list is if
    it isn't already there (fetch_lightning_glm.py likely already needs
    an HTTP client, so this may already be covered)
"""
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

import requests

LAT = 40.616
LON = -80.274

# repo-root/data/cape.json, matching the layout of the other fetch_*.py
# scripts' outputs (data/alerts.json, data/aurora.json, etc.)
OUTPUT_PATH = Path(__file__).resolve().parent.parent / "data" / "cape.json"


def fetch_cape():
    url = "https://api.open-meteo.com/v1/forecast"
    params = {
        "latitude": LAT,
        "longitude": LON,
        "hourly": "cape",
        "forecast_days": 1,
        "timezone": "UTC",
    }
    resp = requests.get(url, params=params, timeout=15)
    resp.raise_for_status()
    payload = resp.json()

    times = payload["hourly"]["time"]
    values = payload["hourly"]["cape"]

    now = datetime.now(timezone.utc)
    now_hour_str = now.strftime("%Y-%m-%dT%H:00")

    cape_value = None
    if now_hour_str in times:
        cape_value = values[times.index(now_hour_str)]
    elif times:
        # exact-string match can miss right at an hour boundary --
        # fall back to whichever entry is closest in time rather than
        # assuming index 0 is "now".
        target = now.replace(minute=0, second=0, microsecond=0)

        def parse(t):
            return datetime.strptime(t, "%Y-%m-%dT%H:%M").replace(tzinfo=timezone.utc)

        closest_idx = min(
            range(len(times)),
            key=lambda i: abs((parse(times[i]) - target).total_seconds()),
        )
        cape_value = values[closest_idx]

    return {
        "cape": cape_value,
        "unit": "J/kg",
        "source": "open-meteo (hourly, best_match model)",
        "updated": now.isoformat(),
    }


def main():
    try:
        output = fetch_cape()
    except Exception as e:
        print(f"fetch_cape.py failed: {e}", file=sys.stderr)
        sys.exit(1)

    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT_PATH.write_text(json.dumps(output, indent=2))
    print(f"Wrote {OUTPUT_PATH}: cape={output['cape']} J/kg")


if __name__ == "__main__":
    main()
