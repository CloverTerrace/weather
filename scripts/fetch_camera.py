#!/usr/bin/env python3
"""
fetches the latest camera snapshot from ecowitt HP10
saves it to data/camera.jpg.

Requires three environment variables (set as GitHub Actions secrets):
  ECOWITT_APP_KEY  - your Ecowitt Application Key
  ECOWITT_API_KEY  - your Ecowitt API Key
  ECOWITT_MAC      - your station's MAC address or IMEI (from ecowitt.net device list)


"""

import json
import os
import sys
import urllib.request
import urllib.error

APP_KEY = os.environ.get("ECOWITT_APP_KEY")
API_KEY = os.environ.get("ECOWITT_API_KEY")
MAC = os.environ.get("ECOWITT_MAC")
CLOUDRUN_URL = os.environ.get("CLOUDRUN_CAMERA_URL")
CAMERA_UPLOAD_TOKEN = os.environ.get("CAMERA_UPLOAD_TOKEN")

if not APP_KEY or not API_KEY or not MAC:
    print("ERROR: ECOWITT_APP_KEY, ECOWITT_API_KEY, and ECOWITT_MAC must be set.", file=sys.stderr)
    sys.exit(1)

REALTIME_URL = (
    "https://api.ecowitt.net/api/v3/device/real_time"
    f"?application_key={APP_KEY}&api_key={API_KEY}&mac={MAC}&call_back=all"
)


def fetch_json(url):
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "github-actions-camera-fetch"})
        with urllib.request.urlopen(req, timeout=15) as resp:
            return json.load(resp)
    except urllib.error.HTTPError as e:
        print(f"HTTP error calling Ecowitt API: {e.code} {e.reason}", file=sys.stderr)
        sys.exit(1)
    except Exception as e:
        print(f"Error calling Ecowitt API: {e}", file=sys.stderr)
        sys.exit(1)


def find_image_url(obj):
    """Recursively search the response for a string that looks like an image URL."""
    if isinstance(obj, dict):
        for value in obj.values():
            found = find_image_url(value)
            if found:
                return found
    elif isinstance(obj, list):
        for item in obj:
            found = find_image_url(item)
            if found:
                return found
    elif isinstance(obj, str):
        lower = obj.lower()
        if lower.startswith("http") and (".jpg" in lower or ".jpeg" in lower or ".png" in lower):
            return obj
    return None


def main():
    raw = fetch_json(REALTIME_URL)

    if raw.get("code") != 0:
        print(f"ERROR: Ecowitt API returned an error: {raw.get('msg')}", file=sys.stderr)
        print(f"Full response for debugging:\n{json.dumps(raw, indent=2)}", file=sys.stderr)
        sys.exit(1)

    image_url = find_image_url(raw.get("data", {}))

    if not image_url:
        print("ERROR: No camera image URL found in the response.", file=sys.stderr)
        print("Full response for debugging (check for the actual camera/photo key path):", file=sys.stderr)
        print(json.dumps(raw, indent=2), file=sys.stderr)
        sys.exit(1)

    print(f"Found camera image URL: {image_url}")

    try:
        req = urllib.request.Request(image_url, headers={"User-Agent": "github-actions-camera-fetch"})
        with urllib.request.urlopen(req, timeout=20) as resp:
            image_bytes = resp.read()
    except Exception as e:
        print(f"Error downloading camera image: {e}", file=sys.stderr)
        sys.exit(1)

    os.makedirs("data", exist_ok=True)
    with open("data/camera.jpg", "wb") as f:
        f.write(image_bytes)

    print(f"Saved data/camera.jpg ({len(image_bytes)} bytes)")

    # Upload the same camera image to Cloud Run
    if not CLOUDRUN_URL or not CAMERA_UPLOAD_TOKEN:
        print("WARNING: Cloud Run camera secrets are not configured; skipping Cloud Run upload.")
    else:
        upload_url = CLOUDRUN_URL.rstrip("/") + "/camera/upload"

        try:
            upload_req = urllib.request.Request(
                upload_url,
                data=image_bytes,
                method="PUT",
                headers={
                    "Authorization": f"Bearer {CAMERA_UPLOAD_TOKEN}",
                    "Content-Type": "image/jpeg",
                },
            )

            with urllib.request.urlopen(upload_req, timeout=20) as upload_resp:
                upload_result = upload_resp.read().decode("utf-8", errors="replace")

            print(f"Cloud Run upload successful: {upload_result}")

        except Exception as e:
            print(f"ERROR uploading camera image to Cloud Run: {e}", file=sys.stderr)
            sys.exit(1)

if __name__ == "__main__":
    main()
