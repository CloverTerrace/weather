#!/usr/bin/env python3
"""
Pulls active NWS alerts (watches/warnings/advisories) for Clover Terrace
and saves them to data/alerts.json. Uses the National Weather Service's
free, keyless API.
"""
import json
import os
import sys
import urllib.request
import urllib.error

LAT = 40.604
LON = -80.286
API_URL = f"https://api.weather.gov/alerts/active?point={LAT},{LON}"
# NWS requires a real identifying User-Agent on every request.
USER_AGENT = "(clover-terrace-weather-station, https://cloverterrace.github.io/weather/)"

# Rough severity ranking so the most urgent alert renders first.
SEVERITY_RANK = {"Extreme": 0, "Severe": 1, "Moderate": 2, "Minor": 3, "Unknown": 4}


def main():
    req = urllib.request.Request(API_URL, headers={"User-Agent": USER_AGENT, "Accept": "application/geo+json"})
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            payload = json.loads(resp.read())
    except (urllib.error.HTTPError, urllib.error.URLError) as e:
        print(f"ERROR: Failed to fetch NWS alerts: {e}", file=sys.stderr)
        sys.exit(1)

    alerts = []
    for feature in payload.get("features", []):
        p = feature.get("properties", {})
        area_desc = p.get("areaDesc")
        description = p.get("description") or ""
        instruction = p.get("instruction") or ""
        details = []
        if area_desc:
            details.append({"label": "Areas", "text": area_desc})
        if instruction.strip():
            details.append({"label": "Instructions", "text": instruction.strip()})
        elif description.strip():
            details.append({"label": "Alert detail", "text": description.strip()})

        alerts.append({
            "id": p.get("id"),
            "event": p.get("event"),
            "headline": p.get("headline"),
            "severity": p.get("severity", "Unknown"),
            "urgency": p.get("urgency"),
            "effective": p.get("effective"),
            "expires": p.get("expires"),
            "senderName": p.get("senderName"),
            "areaDesc": area_desc,
            "details": details,
            "url": p.get("@id") or p.get("id"),
        })

    alerts.sort(key=lambda a: SEVERITY_RANK.get(a["severity"], 4))

    os.makedirs("data", exist_ok=True)
    with open("data/alerts.json", "w") as f:
        json.dump(alerts, f, indent=2)

    print(f"Saved data/alerts.json — {len(alerts)} active alert(s)")


if __name__ == "__main__":
    main()
