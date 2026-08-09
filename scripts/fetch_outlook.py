#!/usr/bin/env python3
"""
Downloads the current SPC (Storm Prediction Center) outlook images and
saves them to:
  data/outlook-day1.png
  data/outlook-day2.png
  data/outlook-day3.png
  data/outlook-day4-8.png
  data/outlook-thunderstorm.png

Each outlook is fetched from SPC's permanently-current URL for that
product (e.g. day2otlk.gif), which NOAA overwrites in place at each new
issuance. No time-slot guessing needed.

Day 1-3 are the categorical Convective Outlooks. Day 4-8 is the single
combined extended-range severe weather outlook graphic. Thunderstorm is
SPC's separate, higher-time-resolution "Thunderstorm Outlook" product
(distinct from the Convective Outlook's categorical risk graphics).
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

OUTLOOK_BASE_URL = "https://www.spc.noaa.gov/products/outlook/"
DAY48_BASE_URL = "https://www.spc.noaa.gov/products/exper/day4-8/"
TSTM_BASE_URL = "https://www.spc.noaa.gov/products/exper/enhtstm/"
USER_AGENT = "(home-weather-station-dashboard, https://cloverterrace.github.io/Weather/)"
EXTENSIONS = ["png", "gif"]

# Each outlook lists its own candidate URLs, tried in order until one
# decodes as a real image -- same resilient fallback approach for all
# five products, just with different base paths/filenames.
OUTLOOKS = [
    {
        "key": "day1",
        "candidates": [f"{OUTLOOK_BASE_URL}day1otlk.{ext}" for ext in EXTENSIONS],
    },
    {
        "key": "day2",
        "candidates": [f"{OUTLOOK_BASE_URL}day2otlk.{ext}" for ext in EXTENSIONS],
    },
    {
        "key": "day3",
        "candidates": [f"{OUTLOOK_BASE_URL}day3otlk.{ext}" for ext in EXTENSIONS],
    },
    {
        # single combined graphic covering days 4-8, not a per-day image
        "key": "day4-8",
        "candidates": [f"{DAY48_BASE_URL}day48prob.{ext}" for ext in EXTENSIONS],
    },
    {
        # SPC's higher-time-resolution Thunderstorm Outlook -- a
        # separate product from the Convective Outlook categorical maps
        "key": "thunderstorm",
        "candidates": (
            [f"{TSTM_BASE_URL}enhtstm.{ext}" for ext in EXTENSIONS]
            + [f"{TSTM_BASE_URL}misc/enhtstm.{ext}" for ext in EXTENSIONS]
        ),
    },
]


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


def fetch_one(key, candidates):
    for url in candidates:
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
        success = fetch_one(outlook["key"], outlook["candidates"])
        if not success:
            any_failed = True
    if any_failed:
        sys.exit(1)


if __name__ == "__main__":
    main()
