"""
fetch_lightning_glm.py

fetches recent lightning flash data from NOAA's GOES-19 Geostationary
Lightning Mapper (GLM) and writes a small filtered JSON file for
the dashboard's "Our Data (GLM)" lightning map tab.
runs on the same GitHub Actions cron as the rest of the
weather-data pipeline (update-weather.yml), writing into the same
data/ directory that gets committed to the CloverTerrace/weather-data
repo. the page reads it from:

    {DATA_REPO_BASE}/lightning_glm.json

...the same raw.githubusercontent.com host as weather.json/history.json.

data source
-----------
GOES-19 has been the operational GOES-East satellite (and therefore the
one that actually covers Pennsylvania) since April 2025. its GLM Level 2
"Lightning Detection" product (flashes/groups/events) is published
continuously to a public bucket as part of NOAA's Big Data
Program

    https://registry.opendata.aws/noaa-goes/
    s3://noaa-goes19/GLM-L2-LCFA/{year}/{day_of_year:03d}/{hour:02d}/...

each object covers a ~20-second scan window and is named like:

    OR_GLM-L2-LCFA_G19_s20221950037000_e20221950037200_c20221950037223.nc

(the "OR_GLM-L2-LCFA_G16_..." example in NOAA's own docs is identical in
shape, just G16 instead of G19 -- see
https://noaa-goes16.s3.amazonaws.com/GLM-L2-LCFA/2022/195/00/OR_GLM-L2-LCFA_G16_s20221950037000_e20221950037200_c20221950037223.nc
which is where this key format was confirmed against a real object).

this is satellite-based OPTICAL flash detection (in-cloud, cloud-to-cloud,
and cloud-to-ground activity all show up as "flashes"), not Blitzortung's
ground-based radio time-of-flight triangulation of individual strikes --
so don't expect the two map tabs to show identical dots. That's the whole
point of having both tabs to compare.

requirements
------------
    pip install boto3 netCDF4

both are pure-Python-installable via pip (netCDF4 ships prebuilt wheels
for Linux/macOS on PyPI, which is what GitHub Actions runners use, so no
system library install step should be needed).
"""

import datetime
import json
import sys

import boto3
from botocore import UNSIGNED
from botocore.config import Config
from netCDF4 import Dataset

# ---- configuration ------------------------------------------------------

BUCKET = "noaa-goes19"           # GOES-East since April 2025.
PRODUCT_PREFIX = "GLM-L2-LCFA"

# Matches RADAR_LAT / RADAR_LON in index.html (the dashboard's map center).
CENTER_LAT = 40.616
CENTER_LON = -80.274

# Rough bounding box half-width in degrees. ~1.35 deg is roughly 150km at
# this latitude -- generous enough to compare against Blitzortung's own
# regional view without pulling in flashes from well outside the area.
# This is a simple lat/lon box, not a true-distance radius -- fine for a
# dashboard map, not for anything that needs precise geodesy.
BOX_DEG = 1.35

WINDOW_MINUTES = 15               # how far back to look for flashes
OUTPUT_PATH = "data/lightning_glm.json"

s3 = boto3.client("s3", config=Config(signature_version=UNSIGNED))


def hour_prefixes(now_utc, minutes_back):
    """Yield the S3 prefixes for every UTC hour folder the requested
    window could touch (usually just the current hour, plus the previous
    hour when running near the top of an hour)."""
    start = now_utc - datetime.timedelta(minutes=minutes_back)
    seen = set()
    t = start
    while t <= now_utc:
        key = (t.year, t.timetuple().tm_yday, t.hour)
        if key not in seen:
            seen.add(key)
            yield f"{PRODUCT_PREFIX}/{t.year}/{t.timetuple().tm_yday:03d}/{t.hour:02d}/"
        t += datetime.timedelta(minutes=20)


def list_recent_keys(now_utc, minutes_back):
    """List every object under the relevant hour folder(s), then keep only
    the ones whose S3 LastModified falls inside the requested window. This
    is a fast pre-filter -- flash-level timestamps get checked again in
    parse_flashes() once each file is actually opened."""
    cutoff = now_utc - datetime.timedelta(minutes=minutes_back)
    keys = []
    for prefix in hour_prefixes(now_utc, minutes_back):
        continuation_token = None
        while True:
            kwargs = {"Bucket": BUCKET, "Prefix": prefix}
            if continuation_token:
                kwargs["ContinuationToken"] = continuation_token
            resp = s3.list_objects_v2(**kwargs)
            for obj in resp.get("Contents", []):
                if obj["LastModified"].replace(tzinfo=None) >= cutoff:
                    keys.append(obj["Key"])
            if resp.get("IsTruncated"):
                continuation_token = resp.get("NextContinuationToken")
            else:
                break
    return sorted(keys)


def parse_flashes(key, cutoff_dt):
    """Download one GLM L2 file and return the flashes inside it that fall
    within our bounding box and time cutoff."""
    obj = s3.get_object(Bucket=BUCKET, Key=key)
    body = obj["Body"].read()

    out = []
    # netCDF4 supports reading straight from an in-memory bytes object --
    # the filename argument is required by the API but ignored when
    # memory= is supplied.
    with Dataset("in-memory.nc", memory=body) as nc:
        lats = nc.variables["flash_lat"][:]
        lons = nc.variables["flash_lon"][:]
        energies = nc.variables["flash_energy"][:]
        # Per the GLM L2 product spec, flash time variables are seconds
        # since the product epoch, 2000-01-01T12:00:00Z.
        epoch = datetime.datetime(2000, 1, 1, 12, 0, 0)
        times = nc.variables["flash_time_offset_of_first_event"][:]

        for lat, lon, energy, t in zip(lats, lons, energies, times):
            if abs(float(lat) - CENTER_LAT) > BOX_DEG:
                continue
            if abs(float(lon) - CENTER_LON) > BOX_DEG:
                continue
            flash_dt = epoch + datetime.timedelta(seconds=float(t))
            if flash_dt < cutoff_dt:
                continue
            out.append({
                "lat": round(float(lat), 4),
                "lon": round(float(lon), 4),
                # GLM flash energies are on the order of 1e-15 to 1e-13
                # Joules -- femtojoules are a more readable unit here.
                "energy_fj": round(float(energy) * 1e15, 2),
                "time": flash_dt.strftime("%Y-%m-%dT%H:%M:%SZ"),
            })
    return out


def main():
    now_utc = datetime.datetime.utcnow()
    cutoff_dt = now_utc - datetime.timedelta(minutes=WINDOW_MINUTES)

    try:
        keys = list_recent_keys(now_utc, WINDOW_MINUTES)
    except Exception as exc:
        print(f"lightning GLM: could not list bucket ({exc})", file=sys.stderr)
        keys = []

    flashes = []
    for key in keys:
        try:
            flashes.extend(parse_flashes(key, cutoff_dt))
        except Exception as exc:
            print(f"lightning GLM: skipping {key} ({exc})", file=sys.stderr)

    flashes.sort(key=lambda f: f["time"])

    payload = {
        "generated_at": now_utc.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "window_minutes": WINDOW_MINUTES,
        "center": {"lat": CENTER_LAT, "lon": CENTER_LON},
        "source": "NOAA GOES-19 GLM (public S3, noaa-goes19 bucket)",
        "flash_count": len(flashes),
        "flashes": flashes,
    }

    with open(OUTPUT_PATH, "w") as f:
        json.dump(payload, f, indent=2)

    print(f"lightning GLM: wrote {len(flashes)} flashes to {OUTPUT_PATH}")


if __name__ == "__main__":
    main()
