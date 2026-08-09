#!/usr/bin/env python3

"""
Downloads the current SPC outlook images and saves them as PNG files.

Day 1-3:
    SPC Convective Outlooks

Day 4-8:
    SPC extended-range severe weather outlook

Thunderstorm:
    SPC Thunderstorm Outlook. The image URL is discovered from
    the current SPC product page rather than guessed.
"""

import io
import os
import re
import sys
import urllib.request
import urllib.error
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


def fetch_bytes(url):
    """Fetch a URL and return its bytes, or None on failure."""
    try:
        req = urllib.request.Request(
            url,
            headers={
                "User-Agent": USER_AGENT,
                "Accept": "*/*",
            },
        )

        with urllib.request.urlopen(req, timeout=20) as response:
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

        if data and save_as_png(
            data,
            f"data/outlook-{key}.png",
        ):
            print(f"[{key}] Saved data/outlook-{key}.png")
            print(f"[{key}] Source: {url}")
            return True

    print(
        f"[{key}] ERROR: no candidate URL loaded successfully.",
        file=sys.stderr,
    )
    return False


def find_thunderstorm_image():
    """
    Fetch the SPC Thunderstorm Outlook product page and discover
    the actual current image URL from its HTML.
    """

    print("[thunderstorm] Loading SPC product page...")

    html_bytes = fetch_bytes(TSTM_PAGE_URL)

    if not html_bytes:
        print(
            "[thunderstorm] ERROR: could not load SPC product page.",
            file=sys.stderr,
        )
        return False

    try:
        html = html_bytes.decode("utf-8", errors="replace")
    except Exception as exc:
        print(
            f"[thunderstorm] ERROR: could not decode page: {exc}",
            file=sys.stderr,
        )
        return False

    # Find image sources from <img ... src="..."> tags.
    img_sources = re.findall(
        r'<img\b[^>]*?\bsrc\s*=\s*["\']([^"\']+)["\']',
        html,
        flags=re.IGNORECASE,
    )

    candidates = []

    for src in img_sources:
        absolute = urljoin(TSTM_PAGE_URL, src)

        # Ignore page decorations and obvious non-product images.
        lower = absolute.lower()

        if any(
            excluded in lower
            for excluded in (
                "logo",
                "banner",
                "button",
                "icon",
                "spacer",
                "arrow",
            )
        ):
            continue

        # Prefer files that look like SPC forecast graphics.
        score = 0

        if "tstm" in lower:
            score += 10

        if "enhtstm" in lower:
            score += 20

        if lower.endswith((".gif", ".png", ".jpg", ".jpeg")):
            score += 5

        candidates.append((score, absolute))

    # Highest-scoring candidates first.
    candidates.sort(reverse=True)

    print(
        f"[thunderstorm] Found {len(candidates)} candidate image(s)."
    )

    for score, url in candidates:
        print(
            f"[thunderstorm] Trying discovered image "
            f"(score {score}): {url}"
        )

        data = fetch_bytes(url)

        if data and save_as_png(
            data,
            "data/outlook-thunderstorm.png",
        ):
            print(
                "[thunderstorm] Saved "
                "data/outlook-thunderstorm.png"
            )
            print(f"[thunderstorm] Source: {url}")
            return True

    print(
        "[thunderstorm] ERROR: could not find a usable "
        "Thunderstorm Outlook image.",
        file=sys.stderr,
    )
    return False


def main():
    failed = False

    # ---------------------------------------------------------
    # DAY 1 — unchanged
    # ---------------------------------------------------------
    if not fetch_fixed_image(
        "day1",
        [
            f"{OUTLOOK_BASE_URL}day1otlk.png",
            f"{OUTLOOK_BASE_URL}day1otlk.gif",
        ],
    ):
        failed = True

    # ---------------------------------------------------------
    # DAY 2 — unchanged
    # ---------------------------------------------------------
    if not fetch_fixed_image(
        "day2",
        [
            f"{OUTLOOK_BASE_URL}day2otlk.png",
            f"{OUTLOOK_BASE_URL}day2otlk.gif",
        ],
    ):
        failed = True

    # ---------------------------------------------------------
    # DAY 3 — unchanged
    # ---------------------------------------------------------
    if not fetch_fixed_image(
        "day3",
        [
            f"{OUTLOOK_BASE_URL}day3otlk.png",
            f"{OUTLOOK_BASE_URL}day3otlk.gif",
        ],
    ):
        failed = True

    # ---------------------------------------------------------
    # DAY 4-8 — keep the current SPC product URL
    # ---------------------------------------------------------
    if not fetch_fixed_image(
        "day4-8",
        [
            f"{DAY48_BASE_URL}day48prob.png",
            f"{DAY48_BASE_URL}day48prob.gif",
        ],
    ):
        failed = True

    # ---------------------------------------------------------
    # THUNDERSTORM — discover the current image from SPC page
    # ---------------------------------------------------------
    if not find_thunderstorm_image():
        failed = True

    if failed:
        sys.exit(1)


if __name__ == "__main__":
    main()
