#!/usr/bin/env python3
"""
Fetches CAPE (Convective Available Potential Energy) for Clover Terrace's
location from Open-Meteo's free forecast API and writes two files:

  - data/cape.json          current value only, for the Pressure tile's
                             "Storm potential" glance metric (unchanged
                             shape/contract from the original version of
                             this script).
  - data/cape_history.json  a rolling array of past hourly readings, for
                             that same tile's trend arrow + sparkline
                             (mirrors how the dashboard already tracks a
                             pressure trend off the station's own history
                             -- this gives CAPE the same kind of series).

Open-Meteo's `hourly=cape` field is well documented across their model
pages (confirmed via ECMWF, GFS GRAPES, etc. -- CAPE is listed as a native
hourly output for the models behind their default "best_match" blend,
which resolves to HRRR at 3km resolution for CONUS locations like this
one). There's no clean "just give me the single current value" shortcut,
so this pulls the hourly series and picks the entry matching (or closest
to) the current UTC hour for cape.json.

For cape_history.json: rather than accumulating a rolling window across
cron runs (read the old file, append, prune, write back -- fiddly under
a 10-min cron + git commit pipeline, and any missed/failed run leaves a
gap), this asks Open-Meteo for `past_days` alongside the forecast and
just re-derives the whole recent-history window fresh every run. Each
run's output is self-contained; a missed run doesn't leave a hole, and
there's no read-modify-write race to worry about.

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
  - that `past_days` actually returns populated (non-null) history this
    far back for the best_match/HRRR blend -- if Open-Meteo's archive for
    this field turns out to be shorter than expected, cape_history.json
    will just come back thin (frontend already treats <2 points as "not
    enough for a trend yet" and quietly omits the arrow/sparkline line)
"""
import json
import sys
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

LAT = 40.616
LON = -80.274

# how far back to ask Open-Meteo for -- the frontend's own trend window is
# 3h and its sparkline window is 6h, so 1 past day is generous headroom
# without asking for (and storing) more than the tile will ever use.
PAST_DAYS = 1

# repo-root/data/*.json, matching the layout of the other fetch_*.py
# scripts' outputs (data/alerts.json, data/aurora.json, etc.)
DATA_DIR = Path(__file__).resolve().parent.parent / "data"
OUTPUT_PATH = DATA_DIR / "cape.json"
HISTORY_OUTPUT_PATH = DATA_DIR / "cape_history.json"

REQUEST_TIMEOUT_S = 15


def fetch_cape_and_history():
    params = {
        "latitude": LAT,
        "longitude": LON,
        "hourly": "cape",
        "past_days": PAST_DAYS,
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

    def parse(t):
        return datetime.strptime(t, "%Y-%m-%dT%H:%M").replace(tzinfo=timezone.utc)

    cape_value = None
    if now_hour_str in times:
        cape_value = values[times.index(now_hour_str)]
    elif times:
        # exact-string match can miss right at an hour boundary --
        # fall back to whichever entry is closest in time rather than
        # assuming index 0 is "now".
        target = now.replace(minute=0, second=0, microsecond=0)
        closest_idx = min(
            range(len(times)),
            key=lambda i: abs((parse(times[i]) - target).total_seconds()),
        )
        cape_value = values[closest_idx]

    current = {
        "cape": cape_value,
        "unit": "J/kg",
        "source": "open-meteo (hourly, best_match model)",
        "updated": now.isoformat(),
    }

    # history: every past-or-current hourly reading (skip nulls and skip
    # forecasted hours still ahead of "now" -- this file is a look-back
    # trend, not a forecast).
    history = []
    for t, v in zip(times, values):
        if v is None:
            continue
        entry_dt = parse(t)
        if entry_dt > now:
            continue
        history.append({"time": entry_dt.isoformat(), "cape": v})

    return current, history


def main():
    try:
        current, history = fetch_cape_and_history()
    except Exception as e:
        print(f"fetch_cape.py failed: {e}", file=sys.stderr)
        sys.exit(1)

    DATA_DIR.mkdir(parents=True, exist_ok=True)
    OUTPUT_PATH.write_text(json.dumps(current, indent=2))
    HISTORY_OUTPUT_PATH.write_text(json.dumps(history, indent=2))
    print(f"Wrote {OUTPUT_PATH}: cape={current['cape']} J/kg")
    print(f"Wrote {HISTORY_OUTPUT_PATH}: {len(history)} history point(s)")


if __name__ == "__main__":
    main()
