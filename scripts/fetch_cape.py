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

Uses only the standard library (urllib) rather than `requests` -- this
repo's GitHub Actions workflow doesn't install `requests` for any of the
other fetch scripts (pillow/boto3/netCDF4 are the only pip installs),
which suggests the rest of the pipeline is written against urllib too.
Matching that avoids adding a dependency the workflow doesn't already have.

NOTE: this script was written to spec but NOT execution-tested against
the live API -- the dev environment this was written in has no outbound
network access to Open-Meteo specifically. Things worth checking on the
first real run:
  - that `hourly.cape` never comes back null for the current hour (fall
    back to '--' on the frontend if so -- the tile already handles that)
  - that CAPE values look sane for a clear day (should be near 0) vs an
    unstable summer afternoon (four digits is normal ahead of storms)
"""
import json
import sys
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

LAT = 40.616
LON = -80.274

# repo-root/data/cape.json, matching the layout of the other fetch_*.py
# scripts' outputs (data/alerts.json, data/aurora.json, etc.)
OUTPUT_PATH = Path(__file__).resolve().parent.parent / "data" / "cape.json"

REQUEST_TIMEOUT_S = 15


def fetch_cape():
    params = {
        "latitude": LAT,
        "longitude": LON,
        "hourly": "cape",
        "forecast_days": 1,
        "timezone": "UTC",
    }
    url = f"https://api.open-meteo.com/v1/forecast?{urllib.parse.urlencode(params)}"

    req = urllib.request.Request(url, headers={"User-Agent": "clover-terrace-weather-dashboard"})
    with urllib.request.urlopen(req, timeout=REQUEST_TIMEOUT_S) as resp:
        if resp.status != 200:
            raise RuntimeError(f"HTTP {resp.status}")
        payload = json.loads(resp.read().decode("utf-8"))

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
