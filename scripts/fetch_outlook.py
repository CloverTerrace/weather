#!/usr/bin/env python3
"""
Download the current SPC outlook graphics used by the weather dashboard.

Outputs:
  data/outlook-day1.png
  data/outlook-day2.png
  data/outlook-day3.png
  data/outlook-day4-8.png
  data/outlook-thunderstorm.png

Day 1-3 and Day 4-8 use SPC's current product URLs.

The SPC Thunderstorm Outlook page contains several graphics, including
supporting/alternate graphics such as rfc_enh.gif.  We specifically select
the enhanced thunderstorm graphic (enh_HHMM.gif/png) corresponding to the
most recent SPC Thunderstorm Outlook issuance, rather than simply taking
the first image on the page.
"""

import io
import os
import re
import sys
import urllib.request
import urllib.error
from datetime import datetime, timezone
from html import unescape
from urllib.parse import urljoin

try:
    from PIL import Image
except ImportError:
    print(
        "ERROR: Pillow is required. Add 'pip install pillow' to the workflow.",
        file=sys.stderr,
    )
    sys.exit(1)


OUTLOOK_BASE_URL = "https://www.spc.noaa.gov/products/outlook/"
DAY48_BASE_URL = "https://www.spc.noaa.gov/products/exper/day4-8/"
TSTM_PAGE_URL = "https://www.spc.noaa.gov/products/exper/enhtstm/"
TSTM_IMAGE_BASE_URL = "https://www.spc.noaa.gov/products/exper/enhtstm/imgs/"

USER_AGENT = (
    "home-weather-station-dashboard/1.0 "
    "(https://cloverterrace.github.io/Weather/)"
)

EXTENSIONS = ("png", "gif", "jpg", "jpeg")

# SPC's Thunderstorm Outlook issuance cycle.  The graphic filenames use
# these hour labels even though one operational issuance is commonly referred
# to as 1630Z; the corresponding graphic is enh_1600.gif.
TSTM_ISSUANCE_HOURS = (1, 6, 13, 16, 20)


# ---------------------------------------------------------------------------
# Generic download helpers
# ---------------------------------------------------------------------------

def fetch_bytes(url, timeout=20):
    """Fetch a URL and return its bytes, or None on failure."""
    try:
        req = urllib.request.Request(
            url,
            headers={
                "User-Agent": USER_AGENT,
                "Accept": "*/*",
            },
        )

        with urllib.request.urlopen(req, timeout=timeout) as response:
            data = response.read()

        if len(data) > 500:
            return data

    except (urllib.error.HTTPError, urllib.error.URLError) as exc:
        print(f"  failed: {exc}", file=sys.stderr)

    except Exception as exc:
        print(f"  failed: {exc}", file=sys.stderr)

    return None


def save_as_png(image_bytes, output_path):
    """Decode an image and save it as PNG."""
    try:
        image = Image.open(io.BytesIO(image_bytes)).convert("RGB")
        os.makedirs(os.path.dirname(output_path), exist_ok=True)
        image.save(output_path, "PNG")
        return True

    except Exception as exc:
        print(
            f"ERROR: could not decode image for {output_path}: {exc}",
            file=sys.stderr,
        )
        return False


def fetch_fixed_image(key, candidates):
    """Try a list of known/current SPC image URLs."""
    for url in candidates:
        print(f"[{key}] Trying {url}")

        data = fetch_bytes(url)

        if data and save_as_png(data, f"data/outlook-{key}.png"):
            print(f"[{key}] Saved data/outlook-{key}.png")
            print(f"[{key}] Source: {url}")
            return True

    print(
        f"[{key}] ERROR: no candidate URL loaded successfully.",
        file=sys.stderr,
    )
    return False


# ---------------------------------------------------------------------------
# Thunderstorm Outlook
# ---------------------------------------------------------------------------

def get_latest_tstm_issuance_hour(now_utc=None):
    """Return the most recent Thunderstorm Outlook issuance hour in UTC."""
    if now_utc is None:
        now_utc = datetime.now(timezone.utc)

    current_hour = now_utc.hour

    # Before 01Z, the latest issuance is the previous day's 20Z product.
    eligible = [hour for hour in TSTM_ISSUANCE_HOURS if hour <= current_hour]
    if not eligible:
        return 20

    return max(eligible)


def discover_tstm_graphics():
    """Find enhanced thunderstorm graphics exposed by the SPC page."""
    print("[thunderstorm] Loading SPC product page...")

    page_bytes = fetch_bytes(TSTM_PAGE_URL)
    if not page_bytes:
        return []

    html = page_bytes.decode("utf-8", errors="replace")

    # Only accept the actual enhanced Thunderstorm Outlook graphics:
    #   enh_0100.gif
    #   enh_0600.gif
    #   enh_1300.gif
    #   enh_1600.gif
    #   enh_2000.gif
    #
    # This deliberately excludes rfc_enh.gif and other supporting graphics.
    pattern = re.compile(
        r"(?:src|href)\s*=\s*[\"']([^\"']*?/imgs/enh_(\d{4})\.(?:gif|png|jpg|jpeg))[\"']",
        flags=re.IGNORECASE,
    )

    found = {}

    for raw_url, hhmm in pattern.findall(html):
        hour = int(hhmm[:2])
        if hour not in TSTM_ISSUANCE_HOURS:
            continue

        url = unescape(urljoin(TSTM_PAGE_URL, raw_url))
        found[hour] = url

    # Some versions of the SPC page may expose the images in markup that
    # doesn't match the first pattern.  Look for the filename itself too.
    filename_pattern = re.compile(
        r"(?:^|[^A-Za-z0-9])enh_(\d{4})\.(gif|png|jpg|jpeg)",
        flags=re.IGNORECASE,
    )

    for match in filename_pattern.finditer(html):
        hhmm = match.group(1)
        hour = int(hhmm[:2])
        if hour not in TSTM_ISSUANCE_HOURS or hour in found:
            continue

        found[hour] = urljoin(
            TSTM_IMAGE_BASE_URL,
            f"enh_{hhmm}.{match.group(2)}",
        )

    print(f"[thunderstorm] Found {len(found)} enhanced outlook graphic(s).")

    return found


def fetch_thunderstorm():
    """Download the current enhanced Thunderstorm Outlook graphic."""
    discovered = discover_tstm_graphics()
    latest_hour = get_latest_tstm_issuance_hour()

    print(f"[thunderstorm] Current UTC issuance target: {latest_hour:02d}Z")

    # Prefer the most recent issuance at or before the current UTC time.
    # If the exact graphic is unavailable, fall back through older issuance
    # times rather than ever selecting rfc_enh.gif.
    ordered_hours = []
    for hour in sorted(TSTM_ISSUANCE_HOURS, reverse=True):
        if hour <= latest_hour:
            ordered_hours.append(hour)
    for hour in sorted(TSTM_ISSUANCE_HOURS, reverse=True):
        if hour not in ordered_hours:
            ordered_hours.append(hour)

    candidates = []

    for hour in ordered_hours:
        if hour in discovered:
            candidates.append(discovered[hour])

    # Direct URL fallbacks make the script resilient if SPC changes the page
    # markup while retaining the established product filenames.
    for hour in ordered_hours:
        for ext in ("gif", "png"):
            url = f"{TSTM_IMAGE_BASE_URL}enh_{hour:04d}.{ext}"
            if url not in candidates:
                candidates.append(url)

    for url in candidates:
        print(f"[thunderstorm] Trying {url}")
        data = fetch_bytes(url)

        if data and save_as_png(data, "data/outlook-thunderstorm.png"):
            print("[thunderstorm] Saved data/outlook-thunderstorm.png")
            print(f"[thunderstorm] Source: {url}")
            return True

    print(
        "[thunderstorm] ERROR: no enhanced Thunderstorm Outlook graphic "
        "could be downloaded.",
        file=sys.stderr,
    )
    return False


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    failed = False

    # Day 1-3: unchanged SPC Convective Outlook URLs.
    if not fetch_fixed_image(
        "day1",
        [
            f"{OUTLOOK_BASE_URL}day1otlk.png",
            f"{OUTLOOK_BASE_URL}day1otlk.gif",
        ],
    ):
        failed = True

    if not fetch_fixed_image(
        "day2",
        [
            f"{OUTLOOK_BASE_URL}day2otlk.png",
            f"{OUTLOOK_BASE_URL}day2otlk.gif",
        ],
    ):
        failed = True

    if not fetch_fixed_image(
        "day3",
        [
            f"{OUTLOOK_BASE_URL}day3otlk.png",
            f"{OUTLOOK_BASE_URL}day3otlk.gif",
        ],
    ):
        failed = True

    # Day 4-8: the combined extended-range severe weather graphic.
    if not fetch_fixed_image(
        "day4-8",
        [
            f"{DAY48_BASE_URL}day48prob.png",
            f"{DAY48_BASE_URL}day48prob.gif",
        ],
    ):
        failed = True

    # Thunderstorm: choose the current enhanced issuance graphic.
    if not fetch_thunderstorm():
        failed = True

    if failed:
        sys.exit(1)


if __name__ == "__main__":
    main()
