#!/usr/bin/env python3
"""
download the current SPC outlook graphics.

convective outlooks in single-file products:
  data/outlook-day1.png
  data/outlook-day2.png
  data/outlook-day3.png
  data/outlook-day4-8.gif   (animated SPC product, when available)
  data/outlook-day4-8.png   (static fallback)

for SPC's Enhanced Thunderstorm Outlook one issuance can expose
multiple 4-hour-period graphics. live filenames are keyed only by the
period start time (enh_HHMM.gif), so try the six fixed UTC boundaries
and keep whichever products currently exist:
  00Z, 04Z, 08Z, 12Z, 16Z, 20Z

each successful period is saved separately as:
  data/outlook-thunderstorm-HH-HH.png

a manifest is written to:
  data/outlook-thunderstorm.json

the manifest tells the dashboard which periods are currently live and what 
label belongs above each image.  old period files and previous single-file 
data/outlook-thunderstorm.png are removed after a new set is discovered.
"""

import io
import json
import os
import sys
from datetime import datetime, timezone
import urllib.error
import urllib.request
from pathlib import Path

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
TSTM_IMAGE_BASE_URL = "https://www.spc.noaa.gov/products/exper/enhtstm/imgs/"
USER_AGENT = "(home-weather-station-dashboard, https://cloverterrace.github.io/Weather/)"
EXTENSIONS = ("gif", "png")
TSTM_BOUNDARIES = (0, 4, 8, 12, 16, 20)

TSTM_ISSUANCE_SCHEDULE = (
    (1, 0, (4,)),             # 01Z: 04Z-12Z
    (6, 0, (12, 16, 20)),     # 06Z: 12Z-16Z, 16Z-20Z, 20Z-00Z
    (13, 0, (16, 20, 0)),     # 13Z: 16Z-20Z, 20Z-00Z, 00Z-04Z
    (16, 30, (20, 0, 4)),     # 1630Z: 20Z-00Z, 00Z-04Z, 04Z-12Z
    (20, 0, (0, 4)),           # 20Z: 00Z-04Z, 04Z-12Z
)
DATA_DIR = Path("data")
MANIFEST_PATH = DATA_DIR / "outlook-thunderstorm.json"
LEGACY_TSTM_PATH = DATA_DIR / "outlook-thunderstorm.png"


def try_fetch(url):
    """Return image bytes for a URL, or None if the URL is unavailable."""
    try:
        req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = resp.read()
            if len(data) > 500:
                return data
            print(f"    rejected tiny response ({len(data)} bytes)")
    except urllib.error.HTTPError as exc:
        print(f"    HTTP {exc.code}")
    except urllib.error.URLError as exc:
        print(f"    URL error: {exc.reason}")
    except Exception as exc:
        print(f"    error: {exc}")
    return None


def save_image_as_png(image_bytes, out_path):
    """Decode an SPC image and save it as a normal PNG."""
    try:
        with Image.open(io.BytesIO(image_bytes)) as source:
            # SPC graphics are static map frames
            image = source.convert("RGB")
            image.save(out_path, format="PNG")
        return True
    except Exception as exc:
        print(f"    downloaded data could not be decoded: {exc}", file=sys.stderr)
        return False


def save_raw_bytes(data, out_path):
    """Save a downloaded source file without altering its format."""
    try:
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_bytes(data)
        return True
    except Exception as exc:
        print(f"    could not save {out_path}: {exc}", file=sys.stderr)
        return False


def fetch_day4_8():
    """
    Preserve SPC's animated Day 4-8 GIF instead of converting it to PNG.

    The previous implementation decoded the GIF with Pillow and saved only
    the first frame as PNG, which made the dashboard look like a static Day 4
    product even though SPC's day48prob.gif is an animated sequence.
    """
    gif_path = DATA_DIR / "outlook-day4-8.gif"
    png_path = DATA_DIR / "outlook-day4-8.png"

    gif_url = f"{DAY48_BASE_URL}day48prob.gif"
    png_url = f"{DAY48_BASE_URL}day48prob.png"

    print(f"[day4-8] Trying {gif_url}")
    gif_data = try_fetch(gif_url)

    if gif_data and save_raw_bytes(gif_data, gif_path):
        print(f"[day4-8] Saved {gif_path}")
        print(f"[day4-8] Source: {gif_url}")

        # also keep a PNG fallback for browsers/environments that cannot
        # display the animated source. this does not replace the GIF.
        save_image_as_png(gif_data, png_path)
        return True

    print(f"[day4-8] GIF unavailable; trying {png_url}")
    png_data = try_fetch(png_url)

    if png_data and save_raw_bytes(png_data, png_path):
        print(f"[day4-8] Saved {png_path}")
        print(f"[day4-8] Source: {png_url}")
        gif_path.unlink(missing_ok=True)
        return True

    print("[day4-8] ERROR: neither animated GIF nor PNG could be downloaded.", file=sys.stderr)
    return False


def fetch_simple_outlook(key, candidates):
    """Fetch one of the existing single-file outlook products."""
    for url in candidates:
        print(f"[{key}] Trying {url}")
        data = try_fetch(url)
        if data:
            out_path = DATA_DIR / f"outlook-{key}.png"
            if save_image_as_png(data, out_path):
                print(f"[{key}] Saved {out_path}")
                print(f"[{key}] Source: {url}")
                return True
    print(f"[{key}] ERROR: no candidate URL loaded successfully.", file=sys.stderr)
    return False


def period_end_hour(start_hour):
    return (start_hour + 4) % 24


def period_label(start_hour):
    return f"{start_hour:02d}Z–{period_end_hour(start_hour):02d}Z"


def order_periods(periods):
    """Return periods in the same order SPC presents them for the cycle."""
    order = {hour: i for i, hour in enumerate(TSTM_BOUNDARIES)}
    return sorted(periods, key=lambda item: order.get(int(item["start_hour"]), 99))


def current_tstm_schedule(now=None):
    """Return (issuance_label, expected_start_hours) for the latest SPC cycle."""
    now = now or datetime.now(timezone.utc)
    minute_of_day = now.hour * 60 + now.minute

    candidates = []
    for issue_hour, issue_minute, starts in TSTM_ISSUANCE_SCHEDULE:
        issue_minutes = issue_hour * 60 + issue_minute
        if issue_minutes <= minute_of_day:
            candidates.append((issue_minutes, issue_hour, issue_minute, starts))

    if candidates:
        _, hour, minute, starts = max(candidates)
    else:
        # Before 01Z, the latest cycle is yesterday's 20Z issuance.
        hour, minute, starts = TSTM_ISSUANCE_SCHEDULE[-1]

    label = f"{hour:02d}{minute:02d}Z"
    return label, tuple(starts)


def fetch_thunderstorm_periods():
    """Probe the six filename boundaries, but keep only the current SPC cycle."""
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    discovered = []

    issuance_label, expected_starts = current_tstm_schedule()
    expected_set = set(expected_starts)

    print(
        "[thunderstorm] Current SPC issuance cycle: "
        f"{issuance_label} (expected period starts: "
        + ", ".join(f"{h:02d}Z" for h in expected_starts)
        + ")"
    )
    print(
        "[thunderstorm] Sweeping fixed 4-hour filename boundaries: "
        + ", ".join(f"{h:02d}Z" for h in TSTM_BOUNDARIES)
    )

    for start_hour in TSTM_BOUNDARIES:
        hhmm = f"{start_hour:02d}00"
        out_path = DATA_DIR / f"outlook-thunderstorm-{start_hour:02d}-{period_end_hour(start_hour):02d}.png"
        source_url = None
        saved = False

        for ext in EXTENSIONS:
            url = f"{TSTM_IMAGE_BASE_URL}enh_{hhmm}.{ext}"
            print(f"[thunderstorm {period_label(start_hour)}] Trying {url}")
            data = try_fetch(url)
            if not data:
                continue
            if save_image_as_png(data, out_path):
                source_url = url
                saved = True
                break

        if saved:
            if start_hour in expected_set:
                print(
                    f"[thunderstorm {period_label(start_hour)}] Active for "
                    f"{issuance_label} cycle; keeping."
                )
                discovered.append(
                    {
                        "start_hour": start_hour,
                        "end_hour": period_end_hour(start_hour),
                        "label": period_label(start_hour),
                        "file": out_path.as_posix(),
                        "source": source_url,
                    }
                )
            else:
                print(
                    f"[thunderstorm {period_label(start_hour)}] Available but not "
                    f"part of current {issuance_label} cycle; will remove as stale."
                )
        else:
            print(
                f"[thunderstorm {period_label(start_hour)}] Not currently "
                "available (HTTP 404 or unreadable)."
            )

    return order_periods(discovered)


def clean_stale_thunderstorm_files(active_periods):
    """Remove old period PNGs and the deprecated single-file output."""
    active_files = {Path(item["file"]).name for item in active_periods}
    removed = []

    for path in DATA_DIR.glob("outlook-thunderstorm-*.png"):
        if path.name not in active_files:
            path.unlink(missing_ok=True)
            removed.append(path.name)

    if LEGACY_TSTM_PATH.exists():
        LEGACY_TSTM_PATH.unlink()
        removed.append(LEGACY_TSTM_PATH.name)

    if removed:
        print("[thunderstorm] Removed stale/deprecated files: " + ", ".join(sorted(removed)))
    else:
        print("[thunderstorm] No stale/deprecated thunderstorm files to remove.")


def write_manifest(periods):
    payload = {
        "product": "SPC Enhanced Thunderstorm Outlook",
        "updated_at_utc": datetime.now(timezone.utc).isoformat(),
        "period_hours": 4,
        "periods": periods,
    }
    MANIFEST_PATH.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    print(f"[thunderstorm] Wrote {MANIFEST_PATH} with {len(periods)} active period(s).")


def main():
    any_failed = False
    DATA_DIR.mkdir(parents=True, exist_ok=True)

    if not fetch_simple_outlook(
        "day1",
        [f"{OUTLOOK_BASE_URL}day1otlk.{ext}" for ext in ("png", "gif")],
    ):
        any_failed = True

    if not fetch_simple_outlook(
        "day2",
        [f"{OUTLOOK_BASE_URL}day2otlk.{ext}" for ext in ("png", "gif")],
    ):
        any_failed = True

    if not fetch_simple_outlook(
        "day3",
        [f"{OUTLOOK_BASE_URL}day3otlk.{ext}" for ext in ("png", "gif")],
    ):
        any_failed = True

    if not fetch_day4_8():
        any_failed = True

    # remove the old static/animated alternate if the current fetch mode
    # changed. The GIF is canonical when available; PNG is only its fallback.
    if (DATA_DIR / "outlook-day4-8.gif").exists():
        pass

    periods = fetch_thunderstorm_periods()
    clean_stale_thunderstorm_files(periods)
    write_manifest(periods)

    if not periods:
        print(
            "[thunderstorm] ERROR: no Enhanced Thunderstorm Outlook periods "
            "were available at any fixed boundary.",
            file=sys.stderr,
        )
        any_failed = True

    if any_failed:
        sys.exit(1)


if __name__ == "__main__":
    main()
