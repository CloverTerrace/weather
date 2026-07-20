#!/usr/bin/env python3
"""
Downloads the current SPC (Storm Prediction Center) Day 1, Day 2, and
Day 3 Convective Outlook images and saves them to:
  data/outlook-day1.png
  data/outlook-day2.png
  data/outlook-day3.png

Each outlook is fetched from SPC's permanently-current URL for that day
(e.g. day2otlk.gif), which NOAA overwrites in place at each new issuance.
No time-slot guessing needed.
"""
import io
import sys
import os
import urllib.request
import urllib.error

try:
    from PIL import Image
except ImportError:
    print("ERROR: Pillow is required. Add 'pip install pillow' to the workflow.", file=sys.stderr)
    sys.exit(1)

BASE_URL = "https://www.spc.noaa.gov/products/outlook/"
USER_AGENT = "(home-weather-station-dashboard, https://cloverterrace.github.io/Weather/)"
EXTENSIONS = ["png", "gif"]

OUTLOOKS = [
    {"key": "day1", "prefix": "day1otlk"},
    {"key": "day2", "prefix": "day2otlk"},
    {"key": "day3", "prefix": "day3otlk"},
]


def candidate_urls(prefix):
    # SPC's always-current outlook image — overwritten in place at each
    # new issuance, so there's no time slot to guess.
    for ext in EXTENSIONS:
        yield f"{BASE_URL}{prefix}.{ext}"


def try_fetch(url):
    try:
        req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = resp.read()
            if len(data) > 500:  # sanity check — a real image, not a tiny error page
                return data
    except (urllib.error.HTTPError, urllib.error.URLError):
        return None
    except Exception:
        return None
    return None


def fetch_one(key, prefix):
    for url in candidate_urls(prefix):
        print(f"[{key}] Trying {url} ...")
        image_bytes = try_fetch(url)
        if image_bytes:
            try:
                img = Image.open(io.BytesIO(image_bytes)).convert("RGB")
            except Exception as e:
                print(f"[{key}] Downloaded but couldn't decode, trying next: {e}", file=sys.stderr)
                continue
            os.makedirs("data", exist_ok=True)
            out_path = f"data/outlook-{key}.png"
            img.save(out_path)
            print(f"[{key}] Saved {out_path} (from {url})")
            return True
    print(f"[{key}] ERROR: no candidate URL loaded successfully.", file=sys.stderr)
    return False


def main():
    any_failed = False
    for outlook in OUTLOOKS:
        success = fetch_one(outlook["key"], outlook["prefix"])
        if not success:
            any_failed = True
    if any_failed:
        sys.exit(1)


if __name__ == "__main__":
    main()
