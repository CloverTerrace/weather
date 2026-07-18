#!/usr/bin/env python3
"""
Downloads the current SPC (Storm Prediction Center) Day 1 Convective
Outlook image and saves it to data/outlook.png.

SPC issues Day 1 outlooks at four known times daily: 0600, 1300, 1630,
and 2000 UTC. Each issuance's image lives at a filename tied to that
time slot (e.g. day1otlk_1630.png), and gets overwritten in place at
the same time the next day — there's no single permanently-current URL.

Rather than scraping SPC's outlook page to find the current filename
(fragile, since it depends on exact page markup this script can't
verify ahead of time), this instead tries the known candidate URLs
directly — starting with the most recent issuance time that has
already passed — and uses whichever one actually loads successfully.
"""

import io
import os
import sys
import urllib.request
import urllib.error
from datetime import datetime, timezone

try:
    from PIL import Image
except ImportError:
    print("ERROR: Pillow is required. Add 'pip install pillow' to the workflow.", file=sys.stderr)
    sys.exit(1)

BASE_URL = "https://www.spc.noaa.gov/products/outlook/"
USER_AGENT = "(home-weather-station-dashboard, https://cloverterrace.github.io/Weather/)"

# SPC's four daily Day 1 issuance times, in UTC, descending.
ISSUANCE_TIMES = [2000, 1630, 1300, 600]
# Try both extensions, since SPC has used both historically.
EXTENSIONS = ["png", "gif"]


def candidate_urls():
    utc_now = datetime.now(timezone.utc)
    current_hhmm = utc_now.hour * 100 + utc_now.minute

    ordered_times = []
    # Today's issuance times that have already happened, most recent first.
    for t in ISSUANCE_TIMES:
        if current_hhmm >= t:
            ordered_times.append(t)
    # Fallback to yesterday's times too (covers early-morning hours before
    # today's first issuance, or if today's hasn't posted yet).
    for t in ISSUANCE_TIMES:
        ordered_times.append(t)

    for t in ordered_times:
        for ext in EXTENSIONS:
            yield f"{BASE_URL}day1otlk_{t:04d}.{ext}"


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


def main():
    for url in candidate_urls():
        print(f"Trying {url} ...")
        image_bytes = try_fetch(url)
        if image_bytes:
            print(f"Success: {url}")
            try:
                img = Image.open(io.BytesIO(image_bytes)).convert("RGB")
            except Exception as e:
                print(f"Downloaded but couldn't decode as an image, trying next candidate: {e}", file=sys.stderr)
                continue

            os.makedirs("data", exist_ok=True)
            img.save("data/outlook.png")
            print(f"Saved data/outlook.png (from {url})")
            return

    print("ERROR: None of the candidate outlook URLs loaded successfully.", file=sys.stderr)
    sys.exit(1)


if __name__ == "__main__":
    main()
