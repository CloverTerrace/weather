#!/usr/bin/env python3
"""
Download the current SPC outlook graphics used by the weather dashboard.

Outputs:
  data/outlook-day1.png
  data/outlook-day2.png
  data/outlook-day3.png
  data/outlook-day4.png
  data/outlook-day5.png
  data/outlook-day6.png
  data/outlook-day7.png
  data/outlook-day8.png
  data/outlook-thunderstorm.png
"""

import io
import os
import re
import sys
import urllib.request
import urllib.error
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

USER_AGENT = (
    "home-weather-station-dashboard/1.0 "
    "(https://cloverterrace.github.io/Weather/)"
)


def fetch_bytes(url, timeout=20):
    try:
        req = urllib.request.Request(
            url,
            headers={"User-Agent": USER_AGENT, "Accept": "*/*"},
        )
        with urllib.request.urlopen(req, timeout=timeout) as response:
            data = response.read()
        return data if len(data) > 500 else None
    except (urllib.error.HTTPError, urllib.error.URLError) as exc:
        print(f"  failed: {exc}", file=sys.stderr)
    except Exception as exc:
        print(f"  failed: {exc}", file=sys.stderr)
    return None


def save_as_png(image_bytes, output_path):
    try:
        image = Image.open(io.BytesIO(image_bytes)).convert("RGB")
        os.makedirs(os.path.dirname(output_path), exist_ok=True)
        image.save(output_path, "PNG")
        return True
    except Exception as exc:
        print(f"ERROR: could not decode image for {output_path}: {exc}",
              file=sys.stderr)
        return False


def fetch_fixed_image(key, candidates):
    for url in candidates:
        print(f"[{key}] Trying {url}")
        data = fetch_bytes(url)
        if data and save_as_png(data, f"data/outlook-{key}.png"):
            print(f"[{key}] Saved data/outlook-{key}.png")
            print(f"[{key}] Source: {url}")
            return True
    print(f"[{key}] ERROR: no candidate URL loaded successfully.",
          file=sys.stderr)
    return False


def fetch_day4_8():
    """Download the five separate SPC D4-D8 graphics."""
    failed = False

    for day in range(4, 9):
        key = f"day{day}"
        candidates = [
            f"{DAY48_BASE_URL}day{day}prob.png",
            f"{DAY48_BASE_URL}day{day}prob.gif",
        ]

        if not fetch_fixed_image(key, candidates):
            failed = True

    return not failed


def get_latest_tstm_issuance_hour():
    """Return the latest known SPC Enhanced Thunderstorm issuance hour."""
    from datetime import datetime, timezone

    issuance_hours = (1, 6, 13, 16, 20)
    current_hour = datetime.now(timezone.utc).hour

    earlier = [h for h in issuance_hours if h <= current_hour]
    return max(earlier) if earlier else max(issuance_hours)


def discover_tstm_graphics():
    """
    Discover actual enh_HHMM product filenames from the SPC page.

    We intentionally do NOT rank arbitrary <img> tags. rfc_enh.gif is a
    supporting/base graphic and can produce the blank radar-style map seen
    on the dashboard instead of the actual Thunderstorm Outlook.
    """
    print("[thunderstorm] Loading SPC product page...")

    page_bytes = fetch_bytes(TSTM_PAGE_URL)

    if not page_bytes:
        print(
            "[thunderstorm] Could not read product page; "
            "using known filename fallbacks.",
            file=sys.stderr,
        )
        return {}

    html = page_bytes.decode("utf-8", errors="replace")
    found = {}

    pattern = re.compile(
        r"enh_(\d{4})\.(gif|png|jpg|jpeg)",
        flags=re.IGNORECASE,
    )

    for match in pattern.finditer(html):
        hhmm = match.group(1)
        hour = int(hhmm[:2])

        if hour not in (1, 6, 13, 16, 20):
            continue

        url = f"{TSTM_IMAGE_BASE_URL}enh_{hhmm}.{match.group(2)}"

        if "rfc_enh" in url.lower():
            continue

        found[hour] = url

    print(
        f"[thunderstorm] Found {len(found)} explicit enhanced "
        "outlook graphic(s)."
    )

    for hour in sorted(found):
        print(f"[thunderstorm] Discovered {hour:02d}Z: {found[hour]}")

    return found


def fetch_thunderstorm():
    """
    Download the actual Enhanced Thunderstorm Outlook.

    IMPORTANT:
      01Z -> enh_0100.gif
      06Z -> enh_0600.gif
      13Z -> enh_1300.gif
      16Z -> enh_1600.gif
      20Z -> enh_2000.gif

    The previous implementation incorrectly reversed the timestamp and
    generated names such as enh_0001.gif.
    """
    discovered = discover_tstm_graphics()
    latest_hour = get_latest_tstm_issuance_hour()

    print(
        f"[thunderstorm] Current UTC issuance target: "
        f"{latest_hour:02d}Z"
    )

    issuance_hours = (1, 6, 13, 16, 20)

    ordered_hours = [
        h for h in sorted(issuance_hours, reverse=True)
        if h <= latest_hour
    ]
    ordered_hours += [
        h for h in sorted(issuance_hours, reverse=True)
        if h not in ordered_hours
    ]

    candidates = []

    # Use anything explicitly exposed by the SPC page first.
    for hour in ordered_hours:
        if hour in discovered:
            candidates.append(discovered[hour])

    # Then use the known SPC filename pattern directly.
    for hour in ordered_hours:
        hhmm = f"{hour:02d}00"

        for ext in ("gif", "png"):
            url = f"{TSTM_IMAGE_BASE_URL}enh_{hhmm}.{ext}"

            if url not in candidates:
                candidates.append(url)

    for url in candidates:
        # Absolute guard against the supporting RFC/base graphic.
        if "rfc_enh" in url.lower():
            continue

        print(f"[thunderstorm] Trying {url}")

        data = fetch_bytes(url)

        if data and save_as_png(
            data,
            "data/outlook-thunderstorm.png",
        ):
            print("[thunderstorm] Saved data/outlook-thunderstorm.png")
            print(f"[thunderstorm] Source: {url}")
            return True

    print(
        "[thunderstorm] ERROR: no actual Enhanced Thunderstorm "
        "Outlook graphic could be downloaded.",
        file=sys.stderr,
    )
    return False

def main():
    failed = False

    # Day 1-3: unchanged.
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

    # D4-D8: five separate SPC graphics.
    if not fetch_day4_8():
        failed = True

    # Thunderstorm: discover the primary product graphic.
    if not fetch_thunderstorm():
        failed = True

    if failed:
        sys.exit(1)


if __name__ == "__main__":
    main()
