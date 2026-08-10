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
TSTM_IMAGE_BASE_URL = "https://www.spc.noaa.gov/products/exper/enhtstm/imgs/"

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
    """Return the current UTC hour, used to order fallback guesses.

    NOTE: previously this picked among a hardcoded issuance schedule
    (1, 6, 13, 16, 20), but that schedule turned out to be wrong --
    confirmed real filenames (e.g. enh_0400.gif) don't fit it. We no
    longer assume a fixed schedule; discover_tstm_graphics() finding the
    real filename on the page is the primary path, and the fallback
    below just sweeps all hours ordered by recency instead of guessing
    a specific set.
    """
    from datetime import datetime, timezone

    return datetime.now(timezone.utc).hour


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

    # Primary (legacy) pattern: enh_HHMM.ext
    pattern = re.compile(
        r"enh_(\d{4})\.(gif|png|jpg|jpeg)",
        flags=re.IGNORECASE,
    )

    for match in pattern.finditer(html):
        hhmm = match.group(1)
        hour = int(hhmm[:2])

        url = f"{TSTM_IMAGE_BASE_URL}enh_{hhmm}.{match.group(2)}"

        if "rfc_enh" in url.lower():
            continue

        # Don't filter by a hardcoded set of "known" issuance hours --
        # SPC's actual valid-period schedule isn't fixed to the hours we
        # previously assumed (e.g. enh_0400 is a real, current product).
        # Keep every non-rfc_enh match the page actually contains.
        found[hour] = url

    print(
        f"[thunderstorm] Found {len(found)} explicit enhanced "
        "outlook graphic(s) matching legacy enh_HHMM pattern."
    )

    for hour in sorted(found):
        print(f"[thunderstorm] Discovered {hour:02d}Z: {found[hour]}")

    # DEBUG FALLBACK: the legacy pattern above has started returning zero
    # matches (SPC likely renamed/restructured these files). Rather than
    # fail silently, scan for ANY .gif/.png/.jpg reference on the page so
    # the Actions log tells us the real current filename(s) to fix the
    # pattern above with.
    if not found:
        any_img_pattern = re.compile(
            r"""(?:src|href)\s*=\s*["']([^"']+\.(?:gif|png|jpe?g))["']""",
            flags=re.IGNORECASE,
        )
        all_imgs = sorted(set(m.group(1) for m in any_img_pattern.finditer(html)))

        print(
            f"[thunderstorm] DEBUG: legacy pattern found nothing. "
            f"Raw image references on page ({len(all_imgs)}):",
            file=sys.stderr,
        )
        for src in all_imgs:
            print(f"[thunderstorm] DEBUG:   {src}", file=sys.stderr)

        if not all_imgs:
            # Not even a broad image match -- dump a chunk of raw HTML so
            # we can see what the page actually contains (e.g. if it's
            # JS-rendered, paywalled, or restructured entirely).
            print(
                "[thunderstorm] DEBUG: no image tags found at all. "
                "First 1500 chars of page HTML:",
                file=sys.stderr,
            )
            print(html[:1500], file=sys.stderr)

    return found


def fetch_thunderstorm():
    """
    Download the actual Enhanced Thunderstorm Outlook.

    Images live under TSTM_IMAGE_BASE_URL (.../enhtstm/imgs/) as
    enh_HHMM.gif, where HHMM is the start of the graphic's valid period
    -- NOT a fixed issuance-time schedule. (Confirmed via a real URL:
    enh_0400.gif.) We no longer hardcode which hours are "valid" --
    discover_tstm_graphics() reads whatever hour(s) the live page
    actually references, and the fallback sweep below just tries every
    hour of the day if the page can't be read at all.
    """
    discovered = discover_tstm_graphics()
    current_hour = get_latest_tstm_issuance_hour()

    print(f"[thunderstorm] Current UTC hour: {current_hour:02d}Z")

    candidates = []

    # 1. Anything the page itself actually referenced -- this is the
    #    authoritative source now that discovery isn't filtered against
    #    a hardcoded (and wrong) issuance schedule. Order by how close
    #    the hour is to the current UTC hour (most recent first).
    for hour in sorted(
        discovered,
        key=lambda h: (current_hour - h) % 24,
    ):
        candidates.append(discovered[hour])

    # 2. Fallback only: if the page couldn't be read/parsed at all, sweep
    #    every hour of the day (most recent first) as a last resort guess,
    #    since we no longer have a reliable fixed issuance schedule to
    #    guess from.
    for delta in range(24):
        hour = (current_hour - delta) % 24
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
