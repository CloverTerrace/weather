#!/usr/bin/env python3
"""
Pulls PM2.5 (plus PM1.0/PM10.0) readings from a set of nearby PurpleAir
sensors, drops any that are stale or unreachable, takes a weighted average
of what's left, applies the standard EPA AQI breakpoint table, and saves
the result to data/air_quality.json.

Uses each sensor's pm2.5_alt field, which PurpleAir returns with the
EPA/Barkjohn correction already applied — the same correction used by
AirNow's Fire and Smoke Map, tuned to stay accurate during wildfire smoke
rather than just clean-air conditions.

API POINT COST: UORV-066 (the closest sensor) is fetched fresh on every
run, since it's what we actually rely on. The three backup sensors are
only fetched fresh every BACKUP_POLL_INTERVAL_SECONDS while UORV-066 is
healthy -- reusing their last cached reading in between -- since they're
just there as a safety net. The moment UORV-066 goes stale or unreachable,
all three backups switch back to fetching fresh on every run, since at
that point they ARE the primary source. This state is tracked in
data/air_quality_state.json, which the pipeline commits alongside
air_quality.json so it persists between runs.
"""
import json
import os
import sys
import urllib.request
import urllib.error
from datetime import datetime, timezone

API_KEY = os.environ.get("PURPLEAIR_API_KEY")

STATE_PATH = "data/air_quality_state.json"
OUTPUT_PATH = "data/air_quality.json"

# Sensors to pull from, in order of physical proximity to the station.
# UORV-066 is the closest, is treated as primary, and gets a higher
# weight when it's healthy; the other three are supplementary/backup
# sensors from the surrounding area. All four were verified at 100%
# channel A/B confidence when this list was built -- worth re-checking on
# map.purpleair.com occasionally in case that changes.
PRIMARY_NAME = "UORV-066"
SENSORS = [
    {"index": 308482, "name": "UORV-066", "weight": 2},
    #{"index": 300707, "name": "UORV-053", "weight": 1},## commenting this out until the weird high 300aqi readings subside#
    {"index": 189215, "name": "UORV-001", "weight": 1},
    {"index": 94479,  "name": "CMP09",    "weight": 1},
]

# name was dropped from this list -- we already know each sensor's name
# from the SENSORS config above, so fetching it from the API was just
# spending points on data we already had.
FIELDS = "pm2.5_alt,pm1.0_atm,pm10.0_atm,humidity,last_seen"

# A sensor that hasn't reported in longer than this is treated as offline
# and dropped from the average, rather than dragging the result toward a
# frozen reading. PurpleAir sensors normally report every ~1-2 minutes, so
# an hour is a generous cutoff that tolerates brief network hiccups without
# masking a genuinely dead sensor like UORV-066 has been.
STALE_THRESHOLD_SECONDS = 60 * 60

# While UORV-066 is healthy, backup sensors are only fetched this often;
# in between, their last cached reading is reused. This is a reasonable
# starting point given PM2.5 doesn't swing wildly minute-to-minute except
# during active smoke/dust events -- adjust if you want them fresher (or
# even more conservative) once you see the real point-usage numbers.
BACKUP_POLL_INTERVAL_SECONDS = 30 * 60

# Standard US EPA PM2.5 AQI breakpoints: (pm_low, pm_high, aqi_low, aqi_high, category)
AQI_BREAKPOINTS = [
    (0.0, 12.0, 0, 50, "Good"),
    (12.1, 35.4, 51, 100, "Moderate"),
    (35.5, 55.4, 101, 150, "Unhealthy for Sensitive Groups"),
    (55.5, 150.4, 151, 200, "Unhealthy"),
    (150.5, 250.4, 201, 300, "Very Unhealthy"),
    (250.5, 350.4, 301, 400, "Hazardous"),
    (350.5, 500.4, 401, 500, "Hazardous"),
]


def pm25_to_aqi(pm25):
    pm25 = max(0.0, pm25)
    for pm_low, pm_high, aqi_low, aqi_high, category in AQI_BREAKPOINTS:
        if pm_low <= pm25 <= pm_high:
            aqi = ((aqi_high - aqi_low) / (pm_high - pm_low)) * (pm25 - pm_low) + aqi_low
            return round(aqi), category
    # Above the top breakpoint — cap display at 500+/Hazardous rather than erroring.
    return 500, "Hazardous"


def load_state():
    try:
        with open(STATE_PATH) as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def save_state(state):
    os.makedirs("data", exist_ok=True)
    with open(STATE_PATH, "w") as f:
        json.dump(state, f, indent=2)


def fetch_sensor(sensor):
    """Fetch one sensor's reading fresh from the API. Returns None (and
    logs why) if the sensor is unreachable, missing data, or stale."""
    url = f"https://api.purpleair.com/v1/sensors/{sensor['index']}?fields={FIELDS}"
    req = urllib.request.Request(url, headers={"X-API-Key": API_KEY})
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            payload = json.loads(resp.read())
    except (urllib.error.HTTPError, urllib.error.URLError) as e:
        print(f"WARNING: {sensor['name']} ({sensor['index']}) fetch failed: {e}", file=sys.stderr)
        return None

    fields = payload.get("sensor") or {}
    if fields.get("pm2.5_alt") is None:
        print(f"WARNING: {sensor['name']} ({sensor['index']}) returned no pm2.5_alt reading", file=sys.stderr)
        return None

    last_seen = fields.get("last_seen")
    if last_seen is None:
        print(f"WARNING: {sensor['name']} ({sensor['index']}) missing last_seen", file=sys.stderr)
        return None

    age_seconds = datetime.now(timezone.utc).timestamp() - last_seen
    if age_seconds > STALE_THRESHOLD_SECONDS:
        print(f"INFO: {sensor['name']} ({sensor['index']}) stale ({int(age_seconds / 60)} min old) — excluded", file=sys.stderr)
        return None

    return {
        "name": sensor["name"],
        "index": sensor["index"],
        "weight": sensor["weight"],
        "pm25": fields["pm2.5_alt"],
        "pm1": fields.get("pm1.0_atm"),
        "pm10": fields.get("pm10.0_atm"),
        "humidity": fields.get("humidity"),
        "lastSeen": datetime.fromtimestamp(last_seen, tz=timezone.utc).isoformat(),
    }


def weighted_average(readings, key):
    values = [(r[key], r["weight"]) for r in readings if r.get(key) is not None]
    if not values:
        return None
    total_weight = sum(w for _, w in values)
    return sum(v * w for v, w in values) / total_weight


def main():
    if not API_KEY:
        print("ERROR: PURPLEAIR_API_KEY environment variable not set.", file=sys.stderr)
        sys.exit(1)

    state = load_state()
    now = datetime.now(timezone.utc).timestamp()

    primary_sensor = next(s for s in SENSORS if s["name"] == PRIMARY_NAME)
    backup_sensors = [s for s in SENSORS if s["name"] != PRIMARY_NAME]

    healthy = []

    # Primary is always fetched fresh -- it's what everything else depends on.
    primary_reading = fetch_sensor(primary_sensor)
    primary_healthy = primary_reading is not None
    if primary_reading:
        healthy.append(primary_reading)

    for sensor in backup_sensors:
        key = str(sensor["index"])
        cached = state.get(key)
        cache_age = (now - cached["fetchedAt"]) if cached else None

        # Only allow reusing the cache while the primary is healthy AND the
        # cached reading is both within the poll interval and still under
        # the staleness threshold (the second check is a safety net in case
        # BACKUP_POLL_INTERVAL_SECONDS is ever set >= STALE_THRESHOLD_SECONDS).
        can_reuse = (
            primary_healthy
            and cached is not None
            and cache_age < BACKUP_POLL_INTERVAL_SECONDS
            and cache_age < STALE_THRESHOLD_SECONDS
        )

        if can_reuse:
            reused = dict(cached)
            reused["weight"] = sensor["weight"]  # in case weights change between runs
            healthy.append(reused)
            print(f"INFO: {sensor['name']} ({sensor['index']}) reused cached reading ({int(cache_age / 60)} min old)", file=sys.stderr)
            continue

        reading = fetch_sensor(sensor)
        if reading:
            state[key] = {**reading, "fetchedAt": now}
            healthy.append(reading)
        else:
            # Fetch failed or sensor is stale -- drop any cached copy too,
            # it's no longer trustworthy either.
            state.pop(key, None)

    save_state(state)

    if not healthy:
        print("ERROR: No healthy sensors available — all sensors are stale or unreachable.", file=sys.stderr)
        sys.exit(1)

    pm25 = weighted_average(healthy, "pm25")
    pm1 = weighted_average(healthy, "pm1")
    pm10 = weighted_average(healthy, "pm10")
    humidity = weighted_average(healthy, "humidity")
    aqi, category = pm25_to_aqi(pm25)

    result = {
        "aqi": aqi,
        "aqiCategory": category,
        "aqiDisplay": f"{aqi} ({category})",
        "pm25": round(pm25, 1),
        "pm1": round(pm1, 1) if pm1 is not None else None,
        "pm10": round(pm10, 1) if pm10 is not None else None,
        "humidity": round(humidity, 1) if humidity is not None else None,
        "sensorsUsed": [
            {"name": r["name"], "index": r["index"], "weight": r["weight"], "lastSeen": r["lastSeen"]}
            for r in healthy
        ],
        "sensorsExpected": len(SENSORS),
        "fetchedAt": datetime.now(timezone.utc).isoformat(),
    }

    os.makedirs("data", exist_ok=True)
    with open(OUTPUT_PATH, "w") as f:
        json.dump(result, f, indent=2)

    used_names = ", ".join(r["name"] for r in healthy)
    print(f"Saved data/air_quality.json — AQI {aqi} ({category}) from {len(healthy)}/{len(SENSORS)} sensors: {used_names}")


if __name__ == "__main__":
    main()
