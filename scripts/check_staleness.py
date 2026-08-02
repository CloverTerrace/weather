#!/usr/bin/env python3
"""
Checks how old data/weather.json is and writes stale=true/false to
$GITHUB_OUTPUT. Used by the Actions workflow to decide whether the home
server's local pipeline has gone quiet and the WU cloud fallback should run.

Env vars:
  STALE_THRESHOLD_MINUTES - defaults to 15
"""
import json
import os
from datetime import datetime, timezone

THRESHOLD_MIN = float(os.environ.get("STALE_THRESHOLD_MINUTES", "15"))

try:
    with open("data/weather.json") as f:
        data = json.load(f)
    obs = datetime.strptime(data["obsTimeUtc"], "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
    age_minutes = (datetime.now(timezone.utc) - obs).total_seconds() / 60
except Exception as e:
    print(f"Could not determine data age ({e}); treating as stale.")
    age_minutes = float("inf")

stale = age_minutes > THRESHOLD_MIN
print(f"data age: {age_minutes:.1f} min (threshold {THRESHOLD_MIN} min) -> stale={stale}")

gh_output = os.environ.get("GITHUB_OUTPUT")
if gh_output:
    with open(gh_output, "a") as f:
        f.write(f"stale={'true' if stale else 'false'}\n")
