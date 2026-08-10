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


def discover_thunderstorm_candidates():
    """
    Discover the primary thunderstorm graphic from SPC's product page.

    The page contains multiple supporting images. We exclude rfc_enh.gif,
    page decoration, and navigation images, then rank the remaining
    thunderstorm/enhanced candidates by filename relevance and dimensions.
    """
    print("[thunderstorm] Loading SPC product page...")

    page_bytes = fetch_bytes(TSTM_PAGE_URL)
    if not page_bytes:
        print("[thunderstorm] ERROR: could not load SPC product page.",
              file=sys.stderr)
        return []

    html = page_bytes.decode("utf-8", errors="replace")

    img_sources = re.findall(
        r"<img\b[^>]*?\bsrc\s*=\s*[\"']([^\"']+)[\"']",
        html,
        flags=re.IGNORECASE,
    )

    candidates = []
    seen = set()

    for raw_src in img_sources:
        src = unescape(raw_src).strip()
        url = urljoin(TSTM_PAGE_URL, src)

        if url in seen:
            continue
        seen.add(url)

        lower = url.lower()
        filename = lower.rsplit("/", 1)[-1]

        if "rfc_enh" in lower:
            continue

        if any(
            token in lower
            for token in (
                "logo", "banner", "button", "spacer",
                "arrow", "nav", "icon",
            )
        ):
            continue

        if not lower.endswith((".gif", ".png", ".jpg", ".jpeg")):
            continue

        # Prefer names associated with the actual enhanced thunderstorm
        # product, but do not depend on one exact filename.
        score = 0
        if "enh" in filename:
            score += 100
        if "tstm" in filename or "thunder" in filename:
            score += 80

        data = fetch_bytes(url)
        if not data:
            continue

        try:
            with Image.open(io.BytesIO(data)) as image:
                width, height = image.size
        except Exception:
            continue

        area = width * height

        if width >= 700 and height >= 400:
            score += 100
        if width >= 800 and height >= 500:
            score += 30

        candidates.append(
            (score, area, width, height, url)
        )

    candidates.sort(reverse=True)

    print(
        f"[thunderstorm] Found {len(candidates)} usable candidate image(s)."
    )

    for score, area, width, height, url in candidates:
        print(
            f"[thunderstorm] Candidate: {url} "
            f"({width}x{height}, score {score})"
        )

    return candidates


def fetch_thunderstorm():
    candidates = discover_thunderstorm_candidates()

    if not candidates:
        print(
            "[thunderstorm] ERROR: no usable Thunderstorm Outlook "
            "graphic could be discovered.",
            file=sys.stderr,
        )
        return False

    for score, area, width, height, url in candidates:
        print(f"[thunderstorm] Trying discovered graphic: {url}")

        data = fetch_bytes(url)

        if data and save_as_png(
            data,
            "data/outlook-thunderstorm.png",
        ):
            print("[thunderstorm] Saved data/outlook-thunderstorm.png")
            print(f"[thunderstorm] Source: {url}")
            return True

    print(
        "[thunderstorm] ERROR: discovered Thunderstorm graphics "
        "could not be downloaded.",
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
